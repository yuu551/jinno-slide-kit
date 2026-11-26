import { rejectForeignRequest } from '../shared/http-security.mjs';
import { inside } from '../shared/paths.mjs';
// 資料のライブラリー（ハブ）。ギャラリー・資料の作成と取り込み・Git（資料単位のコミットと履歴、リポジトリ単位のpush/pull）。
// usage: node marp/hub/server.mjs [--library ~/Slides] [--port 4860] [--no-open]
//
// 資料を開くと、その資料のエディター（marp/editor/server.mjs）を子プロセスで起動し、そのURLへ移る（資料ごとに別のポート）。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as L from '../lib/library.mjs';
import * as G from '../lib/git.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const themesDir = path.join(here, '..', 'themes');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

// --- 設定：--library を指定したら、そのライブラリーを登録して最初に出す ----------------------------
if (opt('--library')) await L.addLibrary(opt('--library'));
async function libraries() {
  const c = await L.loadConfig();
  if (opt('--library')) {
    const want = path.resolve(opt('--library').replace(/^~(?=\/|$)/, process.env.HOME));
    c.libraries.sort((a, b) => (b.path === want) - (a.path === want));
  }
  return c.libraries;
}
async function lib(id) {
  const l = (await libraries()).find((x) => x.id === id) || (await libraries())[0];
  await fsp.mkdir(l.path, { recursive: true });
  return l;
}
const deckDir = (l, slug) => {
  const p = path.resolve(l.path, slug);
  if (!p.startsWith(l.path + path.sep)) throw new Error('ライブラリーの外は扱えません');
  return p;
};

// --- フロントのバンドル ----------------------------------------------------------------
let bundle = '';
async function build() {
  const r = await esbuild.build({ entryPoints: [path.join(here, 'client', 'hub.mjs')], bundle: true, format: 'esm', platform: 'browser', minify: true, write: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = r.outputFiles[0].text;
}
const themes = () => fs.readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort()
  .map((f) => fs.readFileSync(path.join(themesDir, f), 'utf8').replace(/url\("assets\/([^"]+)"\)/g, 'url("/theme-assets/$1")'))
  .sort((a, b) => (a.includes('@import') ? 1 : 0) - (b.includes('@import') ? 1 : 0));

// --- 資料ごとのエディター（子プロセス） ------------------------------------------------------
const editors = new Map(); // key: lib/slug → { proc, url, dir }
async function freePort(start) {
  for (let port = start; port < start + 400; port++) {
    const ok = await new Promise((resolve) => { const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))); s.listen(port, '127.0.0.1'); });
    if (ok && ![...editors.values()].some((e) => e.port === port)) return port;
  }
  throw new Error('空きポートがありません');
}
async function ensureEditor(l, slug) {
  const key = `${l.id}/${slug}`;
  const cur = editors.get(key);
  if (cur && cur.proc.exitCode === null) return cur;
  const dir = deckDir(l, slug);
  const port = await freePort(4871);
  const proc = spawn(process.execPath, [path.join(root, 'marp', 'editor', 'server.mjs'), path.join(dir, 'slides.md'), '--no-open', '--port', String(port), '--hub', hubUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) resolve(m[0]); });
    proc.on('exit', () => reject(new Error('エディターを起動できませんでした')));
    setTimeout(() => reject(new Error('エディターの起動に時間がかかっています')), 30000);
  });
  const e = { proc, url, port, dir };
  editors.set(key, e);
  proc.on('exit', () => { if (editors.get(key) === e) editors.delete(key); });
  return e;
}
function stopEditor(l, slug) {
  const key = `${l.id}/${slug}`;
  const e = editors.get(key);
  if (e) { e.proc.kill(); editors.delete(key); }
}
const stopAll = () => { for (const e of editors.values()) e.proc.kill(); };
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); process.exit(0); });

// --- PDF の書き出し（slides build と同じ） -----------------------------------------------------
function buildPdf(dir) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, 'marp', 'bin', 'slides.mjs'), 'build', path.join(dir, 'slides.md'), '--pdf'], { cwd: root, timeout: 300000 }, (err, so, se) => (err ? reject(new Error(String(se).trim().split('\n').pop() || err.message)) : resolve()));
  });
}

// --- ユーティリティ ------------------------------------------------------------------
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString('utf8'); };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function serveFile(res, file, type) {
  try { const data = await fsp.readFile(file); res.writeHead(200, { 'content-type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data); }
  catch { res.writeHead(404); res.end('not found'); }
}


async function libInfo(l) {
  const repo = await G.repoRoot(l.path);
  const git = repo ? { repo, ...(await G.branchInfo(repo)), inside: path.relative(repo, l.path) || '.' } : null;
  let changes = 0;
  if (repo) changes = (await G.status(repo, path.relative(repo, l.path) || '.').catch(() => ({ count: 0 }))).count;
  return { id: l.id, name: l.name, path: l.path.replace(process.env.HOME, '~'), git, changes };
}
// 資料ごとの未コミットの変更（リポジトリ全体の status を1回で取り、資料のフォルダに振り分ける）
async function deckChanges(l) {
  const repo = await G.repoRoot(l.path);
  if (!repo) return {};
  const rel = path.relative(repo, l.path);
  const st = await G.status(repo, rel || '.').catch(() => ({ files: [] }));
  const out = {};
  for (const f of st.files) {
    const inLib = rel ? f.file.slice(rel.length + 1) : f.file;
    const parts = inLib.split('/');
    const slug = parts[0] === '_archive' ? `${parts[0]}/${parts[1]}` : parts[0];
    (out[slug] ||= []).push({ ...f, file: inLib.slice(slug.length + 1) || inLib });
  }
  return out;
}
const relToRepo = async (l, slug) => {
  const repo = await G.repoRoot(l.path);
  if (!repo) throw new G.GitError('このライブラリーはGitのリポジトリではありません。「Gitを始める」で作成できます');
  return { repo, rel: path.relative(repo, slug ? deckDir(l, slug) : l.path) || '.' };
};

// --- ルーティング -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (rejectForeignRequest(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const q = (k) => url.searchParams.get(k);
  try {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(here, 'client', 'index.html'));
    if (p === '/hub.css') return serveFile(res, path.join(here, 'client', 'hub.css'));
    // Chrome の「アプリとしてインストール」用（アイコンとマニフェスト）
    if (/^\/app\/(icon(-\d+)?\.(png|svg)|manifest\.webmanifest)$/.test(p)) {
      if (p.endsWith('.webmanifest')) { res.writeHead(200, { 'content-type': 'application/manifest+json' }); return res.end(fs.readFileSync(path.join(here, 'client', p.slice(1)))); }
      return serveFile(res, path.join(here, 'client', p.slice(1)));
    }
    if (p === '/hub.js') { if (args.includes('--dev')) await build(); res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' }); return res.end(bundle); }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p.startsWith('/theme-assets/')) { const f = inside(path.join(themesDir, 'assets'), p.slice(14)); return f ? serveFile(res, f) : (res.writeHead(403), res.end()); }
    if (p.startsWith('/template-files/')) { const f=inside(path.join(root,'marp/templates'),p.slice(16)); return f?serveFile(res,f):(res.writeHead(403),res.end()); }
    // 資料のファイル（表紙の図など）: /files/<lib>/<slug>/<path>
    if (p.startsWith('/files/')) {
      const [, , id, ...rest] = p.split('/');
      const l = await lib(id);
      const f = inside(l.path, rest.join('/'));
      return f ? serveFile(res, f) : (res.writeHead(403), res.end());
    }
    // 過去の版のファイル: /git-file/<lib>?rev=&path=（path はライブラリーからの相対）
    if (p.startsWith('/git-file/')) {
      const l = await lib(p.split('/')[2]);
      const { repo, rel } = await relToRepo(l, null);
      const file = path.posix.join(rel === '.' ? '' : rel, q('path'));
      const buf = await G.show(repo, q('rev'), file);
      if (!buf) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'max-age=3600' });
      return res.end(buf);
    }

    if (p === '/api/info') return json(res, 200, { themes: themes(), templates: await L.templateCatalog() });
    if (p === '/api/folder-info') { const folder=await L.existingFolder(q('path')); return json(res,200,{path:folder,deck:fs.existsSync(path.join(folder,'slides.md')),name:path.basename(folder)}); }
    if (p === '/api/libraries' && req.method === 'GET') return json(res, 200, { libraries: await Promise.all((await libraries()).map(libInfo)) });
    if (p === '/api/libraries' && req.method === 'POST') {
      const { path: lp, name } = JSON.parse(await readBody(req));
      await L.addLibrary(lp, name);
      return json(res, 200, { libraries: await Promise.all((await libraries()).map(libInfo)) });
    }
    if (p === '/api/decks' && req.method === 'GET') {
      const l = await lib(q('lib'));
      const [decks, changes] = await Promise.all([L.listDecks(l, { archived: q('archived') === '1' }), deckChanges(l)]);
      for (const d of decks) { d.changes = (changes[d.slug] || []).length; delete d.dir; }
      return json(res, 200, { decks });
    }
    if (p === '/api/deck-text') {
      const l = await lib(q('lib'));
      return json(res, 200, { text: await fsp.readFile(path.join(deckDir(l, q('slug')), 'slides.md'), 'utf8') });
    }
    if (p === '/api/decks' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const l = await lib(b.lib);
      let slug;
      if (b.from === 'folder') slug = await L.importFolder(l, b.path, b.slug);
      else if (!b.from || b.from === 'template') slug = await L.createDeck(l, { slug: b.slug, title: b.title, theme: b.theme, template: b.template });
      else return json(res, 400, { error: '不明な資料の作成方法です' });
      return json(res, 200, { slug });
    }
    if (p === '/api/decks/op' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const l = await lib(b.lib);
      const dir=deckDir(l,b.slug), base=await fsp.realpath(l.path), real=await fsp.realpath(dir);
      if (!real.startsWith(base+path.sep) || !fs.existsSync(path.join(real,'slides.md'))) throw new Error('ライブラリー内の資料を選んでください');
      if (['rename', 'archive', 'unarchive', 'trash'].includes(b.op)) stopEditor(l, b.slug);
      if (b.op === 'duplicate') return json(res, 200, { slug: await L.duplicateDeck(l, b.slug) });
      if (b.op === 'rename') return json(res, 200, { slug: await L.renameDeck(l, b.slug, b.to, b.title) });
      if (b.op === 'reveal') { await L.revealDeck(l,b.slug); return json(res,200,{ok:true}); }
      if (b.op === 'trash') { await L.trashDeck(l, b.slug); return json(res, 200, {ok:true}); }
      if (b.op === 'archive') return json(res, 200, { slug: await L.archiveDeck(l, b.slug) });
      if (b.op === 'unarchive') return json(res, 200, { slug: await L.archiveDeck(l, b.slug, true) });
      return json(res, 400, { error: '不明な操作です' });
    }
    if (p === '/api/open' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const l = await lib(b.lib);
      const e = await ensureEditor(l, b.slug);
      // 編集はエディター、分割はエディターの分割表示、発表は発表画面
      const target = `${e.url}${b.view === 'split' ? '?view=split' : b.view === 'present' ? 'present' : '?view=slide'}${b.page ? `#${b.page}` : ''}`;
      return json(res, 200, { url: target });
    }
    if (p === '/api/pdf' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const l = await lib(b.lib);
      const dir = deckDir(l, b.slug);
      await buildPdf(dir);
      return json(res, 200, { url: `/files/${l.id}/${b.slug}/dist/slides.pdf` });
    }

    // --- Git ---------------------------------------------------------------------------
    if (p.startsWith('/api/git/')) {
      const b = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : Object.fromEntries(url.searchParams);
      const l = await lib(b.lib);
      const op = p.slice(9);
      if (op === 'init') {
        const repo = await G.repoRoot(l.path);
        if (!repo) await G.init(l.path);
        return json(res, 200, await libInfo(l));
      }
      const { repo, rel } = await relToRepo(l, b.slug);
      if (op === 'status') return json(res, 200, await G.status(repo, rel));
      if (op === 'commit') return json(res, 200, { hash: await G.commit(repo, rel, b.message), lib: await libInfo(l) });
      if (op === 'log') return json(res, 200, { log: await G.log(repo, rel, Number(b.limit || 200)) });
      if (op === 'file') {
        // 資料の slides.md を版ごとに取り出す（rev=WORKTREE は今のファイル）
        const file = path.posix.join(rel === '.' ? '' : rel, 'slides.md');
        const text = b.rev === 'WORKTREE' ? await fsp.readFile(path.join(repo, file), 'utf8').catch(() => null) : (await G.show(repo, b.rev, file))?.toString('utf8') ?? null;
        const parent = b.rev === 'WORKTREE' ? 'HEAD' : await G.parentOf(repo, b.rev);
        return json(res, 200, { text, parent });
      }
      if (op === 'restore') { stopEditor(l, b.slug); await G.restore(repo, rel, b.rev); return json(res, 200, { ok: true }); }
      if (op === 'fetch') return json(res, 200, await G.fetchRemote(repo));
      if (op === 'pull') { const r = await G.pull(repo); for (const e of editors.values()) void e; return json(res, 200, r); }
      if (op === 'push') return json(res, 200, await G.push(repo));
      if (op === 'remote') return json(res, 200, await G.setRemote(repo, b.url));
      return json(res, 404, { error: '不明な操作です' });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, e instanceof G.GitError ? 409 : 500, { error: String(e?.message || e) });
  }
});

let hubUrl = '';
await build();
const port = await (async () => { for (let x = Number(opt('--port') || 4860); x < 4870; x++) { const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))); s.listen(x, '127.0.0.1'); }); if (ok) return x; } throw new Error('空きポートがありません'); })();
server.listen(port, '127.0.0.1', async () => {
  hubUrl = `http://127.0.0.1:${port}/`;
  const libs = await libraries();
  console.log(`ライブラリー: ${hubUrl}  （${libs.map((l) => l.path.replace(process.env.HOME, '~')).join('、')}）`);
  if (args.includes('--no-open')) return;
  spawn('open', [hubUrl], { detached: true, stdio: 'ignore' }).unref();
});
