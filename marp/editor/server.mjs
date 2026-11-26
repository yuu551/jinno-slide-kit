import { rejectForeignRequest } from '../shared/http-security.mjs';
import { inside } from '../shared/paths.mjs';
// Typora風のMarpエディター（ローカル専用）。
// usage: node marp/editor/server.mjs <slides.md> [--port 4870] [--no-open] [--split] [--preview]
//
// 配信するもの
//   /                 エディター本体（index.html・app.js・app.css）
//   /deck/...         デッキのフォルダ（figs/ などの画像）
//   /theme-assets/... テーマの画像・フォント
//   /api/...          読み書き・検査・外部変更の通知（SSE）
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { openHistory } from '../lib/history.mjs';
import * as G from '../lib/git.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const themesDir = path.join(here, '..', 'themes');

const args = process.argv.slice(2);
const deckPath = path.resolve(args.find((a) => !a.startsWith('--')) || 'slides.md');
const deckDir = path.dirname(deckPath);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (!fs.existsSync(deckPath)) { console.error(`見つかりません: ${deckPath}`); process.exit(1); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.woff2': 'font/woff2', '.json': 'application/json',
};
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

// --- フロントのバンドル（起動時に1回。--dev なら変更のたびに作り直す） -----------------
let bundle = '';
async function build() {
  const r = await esbuild.build({
    entryPoints: [path.join(here, 'client', 'main.mjs')], bundle: true, format: 'esm', platform: 'browser',
    minify: true, write: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = r.outputFiles[0].text;
}

// 発表モード（/present・/presenter）のバンドル。両画面で1つ（client/present-app.mjs）
let presentBundle = '';
async function buildPresent() {
  const r = await esbuild.build({
    entryPoints: [path.join(here, 'client', 'present-app.mjs')], bundle: true, format: 'esm', platform: 'browser',
    minify: true, write: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
  });
  presentBundle = r.outputFiles[0].text;
}
const presentReady = buildPresent();

let workerBundle = '';
async function buildWorker() {
  const result = await esbuild.build({
    entryPoints: [path.join(here, 'client', 'render-worker.mjs')], bundle: true, format: 'iife', platform: 'browser',
    minify: true, write: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
  });
  workerBundle = result.outputFiles[0].text;
}
const workerReady = buildWorker();

async function servePresent(req, res, p) {
  // 以前の分割編集の URL は、エディターの分割表示へ
  if (p === '/split') { res.writeHead(302, { location: '/?view=split' }); res.end(); return true; }
  if (p === '/present' || p === '/presenter' || p === '/preview') { await serveFile(res, path.join(here, 'client', `${p.slice(1)}.html`)); return true; }
  if (p === '/present.css' || p === '/preview.css') { await serveFile(res, path.join(here, 'client', p.slice(1))); return true; }
  if (p === '/present.js') {
    await presentReady;
    if (args.includes('--dev')) await buildPresent();
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(presentBundle);
    return true;
  }
  if (p === '/present-launch.js') {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(await fsp.readFile(path.join(here, 'client', 'present-launch.mjs')));
    return true;
  }
  // エディターの保存（PUT /api/deck）は自分宛ての 'deck' を出さないので、発表画面向けに 'saved' を送る
  if (p === '/api/deck' && req.method === 'PUT') {
    res.on('finish', async () => { if (res.statusCode === 200) send('saved', { text: await fsp.readFile(deckPath, 'utf8').catch(() => '') }); });
  }
  return false;
}

function themes() {
  // 画像・フォントは data URI にせず URL で配る（6MBを毎回読まないため）
  return fs.readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort()
    .map((f) => fs.readFileSync(path.join(themesDir, f), 'utf8').replace(/url\("assets\/([^"]+)"\)/g, 'url("/theme-assets/$1")'))
    .sort((a, b) => (a.includes('@import') ? 1 : 0) - (b.includes('@import') ? 1 : 0));
}

// --- 保存と外部変更の監視 ---------------------------------------------------------
let lastWritten = hash(fs.readFileSync(deckPath, 'utf8'));
const clients = new Set();
const send = (event, data) => { for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

// ローカルの履歴（Git がなくても版を残す）。開いたとき・保存・外部の変更・図の変更を記録する
const history = openHistory(deckDir, path.basename(deckPath));
history.record(fs.readFileSync(deckPath, 'utf8'), { kind: 'open', label: 'エディターで開いたとき' }).catch(() => {});
// 図の「前の中身」を覚えておく（外部で作り直されたときに前後を残すため）
const figMemo = new Map();
for (const f of (fs.existsSync(path.join(deckDir, 'figs')) ? fs.readdirSync(path.join(deckDir, 'figs')) : [])) {
  if (/\.(svg|png|jpe?g|webp|gif)$/i.test(f)) try { figMemo.set(`figs/${f}`, fs.readFileSync(path.join(deckDir, 'figs', f))); } catch {}
}
let figTimer, figPending = new Set();
function noteFigureChange(rel) {
  figPending.add(rel);
  clearTimeout(figTimer);
  // 生成スクリプトで何枚も作り直すときは、まとめて1つの版にする
  figTimer = setTimeout(async () => {
    const changes = [];
    for (const r of figPending) {
      const f = path.join(deckDir, r);
      const after = fs.existsSync(f) ? await fsp.readFile(f) : null;
      changes.push({ path: r, before: figMemo.get(r) || null, after });
      if (after) figMemo.set(r, after); else figMemo.delete(r);
    }
    figPending = new Set();
    await history.recordFigures(changes, { label: figLabel });
    figLabel = '';
  }, 1500);
}
let figLabel = '';

async function atomicWrite(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

// 原子的な保存（rename）でファイルが差し替わっても追えるよう、フォルダごと監視する
let debounce;
fs.watch(deckDir, { recursive: true }, (_, name) => {
  if (!name) return;
  const rel = name.split(path.sep).join('/');
  if (rel.startsWith('.') || rel.includes('/.')) return;
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    if (path.resolve(deckDir, rel) === deckPath) {
      let text;
      try { text = await fsp.readFile(deckPath, 'utf8'); } catch { return; }
      const h = hash(text);
      if (h === lastWritten) return;
      lastWritten = h;
      send('deck', { text, hash: h });
      history.record(text, { kind: 'external', label: 'エディター以外での変更' }).catch(() => {});
    } else if (/\.(svg|png|jpe?g|webp|gif)$/i.test(rel)) {
      send('asset', { path: rel, t: Date.now() });
      if (rel.startsWith('figs/')) noteFigureChange(rel);
    }
  }, 120);
});

// --- 検査（check.mjs を編集中の内容で実行） -----------------------------------------
async function runCheck(text) {
  const tmp = path.join(deckDir, `.editor-check-${process.pid}.md`);
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'marp-check-'));
  await fsp.writeFile(tmp, text);
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(here, '..', 'scripts', 'check.mjs'), tmp, '--no-shots', '--json', '--out', out],
        { cwd: root, maxBuffer: 64 << 20 }, (err, so, se) => (so.trim() ? resolve(so) : reject(err || new Error(se))));
    });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    await fsp.rm(tmp, { force: true });
    await fsp.rm(path.join(deckDir, `.render-${path.basename(tmp, '.md')}.html`), { force: true });
    await fsp.rm(out, { recursive: true, force: true });
  }
}

const displayPath = (f) => { const r = path.relative(root, f); return r.startsWith('..') ? f.replace(os.homedir(), '~') : r; };

// --- ユーティリティ ---------------------------------------------------------------

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject);
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function serveFile(res, file) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

const PLACEHOLDER = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="6" fill="#fafafa" stroke="#b9bec2" stroke-width="2" stroke-dasharray="10 8"/>
  <text x="${w / 2}" y="${h / 2 + 10}" text-anchor="middle" font-family="Hiragino Sans, sans-serif" font-size="28" fill="#8a9196">図をここに描く</text>
</svg>
`;

// --- ルーティング -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (rejectForeignRequest(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(here, 'client', 'index.html'));
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (await servePresent(req, res, p)) return;
    if (p === '/app.css') return serveFile(res, path.join(here, 'client', 'app.css'));
    // 書き方の見本に使うダミーの図と顔写真
    if (/^\/cheat\/[a-z-]+\.svg$/.test(p)) return serveFile(res, path.join(here, 'client', p.slice(1)));
    if (p === '/render-worker.js') {
      await workerReady;
      if (args.includes('--dev')) await buildWorker();
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      res.end(workerBundle);
      return;
    }
    if (p === '/app.js') {
      if (args.includes('--dev')) await build();
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return res.end(bundle);
    }
    if (p.startsWith('/theme-assets/')) {
      const f = inside(path.join(themesDir, 'assets'), p.slice('/theme-assets/'.length));
      return f ? serveFile(res, f) : (res.writeHead(403), res.end());
    }
    if (p.startsWith('/deck/')) {
      const f = inside(deckDir, p.slice('/deck/'.length));
      return f ? serveFile(res, f) : (res.writeHead(403), res.end());
    }
    // 図の形を編集する SVG-Edit（npm の svgedit の dist をそのまま配る。ホストページだけ差し替える）
    if (p === '/svgedit/marpkit-host.js') { await serveFile(res, path.join(here, 'client', 'shape-host.mjs')); return; }
    if (p === '/svgedit/marpkit-host.html') return serveFile(res, path.join(here, 'client', 'shape-host.html'));
    if (p.startsWith('/svgedit/')) {
      const f = inside(path.join(root, 'node_modules', 'svgedit', 'dist', 'editor'), p.slice('/svgedit/'.length));
      return f ? serveFile(res, f) : (res.writeHead(403), res.end());
    }
    if (p === '/api/info') return json(res, 200, { file: displayPath(deckPath), abs: deckPath, name: path.basename(deckDir), slides: path.join(here, '..', 'bin', 'slides.mjs'), themes: themes(), exports: Object.keys(EXPORTS).filter((fmt) => fs.existsSync(exportPath(fmt))), hub: await hubUrl() });
    // エージェント用メモ（直したい点をためて、プロンプトとしてコピーする）。デッキのフォルダに置き、Gitには入れない
    if (p === '/api/notes' && req.method === 'GET') {
      const f = path.join(deckDir, '.agent-notes.json');
      const data = await fsp.readFile(f, 'utf8').then(JSON.parse).catch(() => ({ notes: [], draft: '', scope: 'slide' }));
      return json(res, 200, data);
    }
    if (p === '/api/notes' && req.method === 'PUT') {
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'JSONとして読めません' }); }
      const notes = Array.isArray(data.notes) ? data.notes.slice(0, 100) : [];
      const f = path.join(deckDir, '.agent-notes.json');
      if (!notes.length && !data.draft) await fsp.rm(f, { force: true });
      else await atomicWrite(f, JSON.stringify({ notes, draft: String(data.draft || '').slice(0, 5000), scope: data.scope || 'slide' }, null, 2) + '\n');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/deck' && req.method === 'GET') {
      const text = await fsp.readFile(deckPath, 'utf8');
      lastWritten = hash(text);
      return json(res, 200, { text, hash: lastWritten });
    }
    if (p === '/api/deck' && req.method === 'PUT') {
      const { text, base, force } = JSON.parse(await readBody(req));
      if (typeof text !== 'string') return json(res, 400, { error: 'text が必要です' });
      // 読み込んだ版（base）のあとに別の場所で書き換わっていたら、上書きせずに知らせる
      const current = await fsp.readFile(deckPath, 'utf8').catch(() => '');
      const curHash = hash(current);
      if (base && !force && curHash !== base && current !== text) return json(res, 409, { error: 'conflict', text: current, hash: curHash });
      lastWritten = hash(text);
      await atomicWrite(deckPath, text);
      history.record(text, { kind: restoring ? 'restore' : 'save', label: restoring || '' }).catch(() => {});
      restoring = '';
      return json(res, 200, { ok: true, savedAt: Date.now(), hash: lastWritten });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      // 貼り付け・ドロップした画像を figs/ に保存する（同名があれば番号を付ける）
      const raw = (url.searchParams.get('name') || 'image.png').replace(/[/\\]/g, '-');
      if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(raw)) return json(res, 400, { error: '画像だけ保存できます' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (!buf.length || buf.length > 30 << 20) return json(res, 400, { error: '画像が空か、大きすぎます（30MBまで）' });
      await fsp.mkdir(path.join(deckDir, 'figs'), { recursive: true });
      const stem = raw.replace(/\.[^.]+$/, ''), ext = raw.slice(stem.length);
      let rel = `figs/${stem}${ext}`, n = 2;
      while (fs.existsSync(path.join(deckDir, rel))) rel = `figs/${stem}-${n++}${ext}`;
      await fsp.writeFile(path.join(deckDir, rel), buf);
      return json(res, 200, { path: rel });
    }
    // --- 履歴 ---------------------------------------------------------------------------
    if (p === '/api/history' && req.method === 'GET') {
      const items = await history.list();
      const git = await gitLog().catch(() => null);
      return json(res, 200, { items, git });
    }
    if (p === '/api/history/text' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '', rev = url.searchParams.get('rev');
      if (rev) {
        if (!G.validRev(rev)) return json(res, 400, { error: '版の指定が正しくありません' });
        const text = await gitText(rev);
        return text == null ? json(res, 404, { error: '版が見つかりません' }) : json(res, 200, { text });
      }
      const text = await history.text(id);
      return text == null ? json(res, 404, { error: '版が見つかりません' }) : json(res, 200, { text, entry: await history.get(id) });
    }
    if (p.startsWith('/api/history/object/') && req.method === 'GET') {
      const h = p.split('/').pop();
      try {
        const buf = await history.object(h);
        const type = url.searchParams.get('type') || (buf.subarray(0, 200).toString().includes('<svg') ? 'image/svg+xml' : 'application/octet-stream');
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' });
        return res.end(buf);
      } catch { return json(res, 404, { error: '見つかりません' }); }
    }
    if (p === '/api/history/named' && req.method === 'POST') {
      // 今のファイルの版に名前を付けて残す（間引かない）
      const { label } = JSON.parse(await readBody(req));
      const e = await history.record(await fsp.readFile(deckPath, 'utf8'), { kind: 'named', label: String(label || '').slice(0, 80) || '名前なし' });
      return json(res, 200, { entry: e });
    }
    if (p === '/api/history/rename' && req.method === 'POST') {
      const { id, label } = JSON.parse(await readBody(req));
      return json(res, 200, { entry: await history.rename(id, String(label || '').slice(0, 80)) });
    }
    if (p === '/api/history/restoring' && req.method === 'POST') {
      // 次の保存を「版を戻した」として記録する
      restoring = String(JSON.parse(await readBody(req)).label || '版を戻した').slice(0, 120);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/history/restore-figure' && req.method === 'POST') {
      const { path: rel, hash: h, label } = JSON.parse(await readBody(req));
      const figRel = String(rel || '');
      if (!/^figs\//.test(figRel) || figRel.includes('\\') || figRel.split('/').some((p) => !p || p === '.' || p === '..')) {
        return json(res, 403, { error: 'figs/ の中だけ戻せます' });
      }
      const f = inside(deckDir, figRel);
      if (!f) return json(res, 403, { error: 'figs/ の中だけ戻せます' });
      figLabel = label || `${rel} を戻した`;
      if (h) await atomicWrite(f, await history.object(h)); else await fsp.rm(f, { force: true });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/git/commit' && req.method === 'POST') {
      const { message } = JSON.parse(await readBody(req));
      const root = await G.repoRoot(deckDir).catch(() => null);
      if (!root) return json(res, 400, { error: 'この資料は Git で管理されていません' });
      try { return json(res, 200, { result: await G.commit(root, path.relative(root, deckDir) || '.', String(message || '').trim() || '資料を更新') }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/file' && req.method === 'GET') {
      const f = inside(deckDir, url.searchParams.get('path') || '');
      if (!f) return json(res, 403, { error: 'デッキの外は読めません' });
      return json(res, 200, { text: await fsp.readFile(f, 'utf8'), drawio: fs.existsSync(f.replace(/\.svg$/i, '.drawio')) });
    }
    if (p === '/api/file' && req.method === 'PUT') {
      const rel = url.searchParams.get('path') || '';
      const f = inside(deckDir, rel);
      if (!f || !/\.svg$/i.test(f)) return json(res, 403, { error: 'デッキ内のSVGだけ保存できます' });
      await atomicWrite(f, await readBody(req));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/new-figure' && req.method === 'POST') {
      await fsp.mkdir(path.join(deckDir, 'figs'), { recursive: true });
      let n = 1, rel;
      do { rel = `figs/new-figure-${n++}.svg`; } while (fs.existsSync(path.join(deckDir, rel)));
      await fsp.writeFile(path.join(deckDir, rel), PLACEHOLDER(1160, 380));
      return json(res, 200, { path: rel });
    }
    if (p === '/api/open-drawio' && req.method === 'POST') {
      const f = inside(deckDir, url.searchParams.get('path') || '');
      const drawio = f && f.replace(/\.svg$/i, '.drawio');
      if (!drawio || !fs.existsSync(drawio)) return json(res, 404, { error: '.drawio がありません' });
      spawn('open', ['-a', 'draw.io', drawio], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    // 書き出し（PDF・PowerPoint・HTML）。保存済みのファイルを marp-cli で dist/ へ出し、ダウンロードさせる
    if (p === '/api/export' && req.method === 'POST') {
      const fmt = url.searchParams.get('format');
      if (!EXPORTS[fmt]) return json(res, 400, { error: '書き出せない形式です' });
      const t0 = Date.now();
      try { await runExport(fmt); } catch (e) { return json(res, 500, { error: e.message }); }
      const file = exportPath(fmt);
      return json(res, 200, { file: displayPath(file), ms: Date.now() - t0, size: (await fsp.stat(file)).size, download: `/api/export-file?format=${fmt}` });
    }
    if (p === '/api/export-file' && req.method === 'GET') {
      const fmt = url.searchParams.get('format');
      const file = EXPORTS[fmt] && exportPath(fmt);
      if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'まだ書き出していません' });
      const name = `${deckTitle() || path.basename(deckDir)}${fmt === 'pdf-notes' ? '（発表者用）' : ''}.${EXPORTS[fmt].ext}`.replace(/[\\/:*?"<>|]/g, '_');
      res.writeHead(200, { 'content-type': EXPORTS[fmt].mime, 'content-disposition': `attachment; filename="export.${EXPORTS[fmt].ext}"; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (p === '/api/reveal' && req.method === 'POST') {
      const fmt = url.searchParams.get('format');
      const file = EXPORTS[fmt] && exportPath(fmt);
      if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'まだ書き出していません' });
      spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    // --- ページのコピー ----------------------------------------------------------------------
    // 別の資料からコピーしたページを貼るとき、参照している図（figs/…）もこの資料へ写す
    if (p === '/api/import-pages' && req.method === 'POST') {
      const { text, from } = JSON.parse(await readBody(req));
      return json(res, 200, await bringFigures(String(text || ''), from, deckDir));
    }
    // 貼り付け先に選べる資料（ライブラリーの一覧から）
    if (p === '/api/copy-targets' && req.method === 'GET') {
      const hub = await hubUrl();
      if (!hub) return json(res, 200, { targets: [], error: 'ライブラリーが動いていません' });
      try {
        const { libraries } = await (await fetch(`${hub}api/libraries`)).json();
        const targets = [];
        for (const l of libraries) {
          const r = await (await fetch(`${hub}api/decks?lib=${encodeURIComponent(l.id)}`)).json();
          for (const d of r.decks || r) {
            const file = path.join(l.path, d.slug, 'slides.md');
            if (path.resolve(file) === path.resolve(deckPath) || d.archived) continue;
            targets.push({ lib: l.name, slug: d.slug, title: d.title, pages: d.pages, updated: d.updated, file });
          }
        }
        targets.sort((a, b) => b.updated - a.updated);
        return json(res, 200, { targets });
      } catch (e) { return json(res, 200, { targets: [], error: e.message }); }
    }
    // 別の資料の最後（裏表紙があればその前）へページを足す。図も写す
    if (p === '/api/send-pages' && req.method === 'POST') {
      const { text, target } = JSON.parse(await readBody(req));
      const file = path.resolve(String(target || ''));
      if (!/slides\.md$/.test(file) || !fs.existsSync(file) || file === path.resolve(deckPath)) return json(res, 400, { error: '送り先の資料が見つかりません' });
      const dest = path.dirname(file);
      const { text: body, copied, renamed } = await bringFigures(String(text || ''), deckPath, dest);
      const cur = await fsp.readFile(file, 'utf8');
      const seps = [...cur.matchAll(/\n---\n/g)].map((m) => m.index);
      const lastStart = seps.length ? seps[seps.length - 1] : -1;
      const lastPage = lastStart >= 0 ? cur.slice(lastStart + 5) : '';
      let next;
      if (lastStart > 0 && /_class:\s*[^>]*\bclosing\b/.test(lastPage)) next = `${cur.slice(0, lastStart).replace(/\s*$/, '')}\n\n---\n\n${body.trim()}\n\n---\n${lastPage}`;
      else next = `${cur.replace(/\s*$/, '')}\n\n---\n\n${body.trim()}\n`;
      await openHistory(dest).record(cur, { kind: 'save', label: '別の資料からページを受け取る前' }).catch(() => {});
      await atomicWrite(file, next);
      await openHistory(dest).record(next, { kind: 'external', label: `「${path.basename(deckDir)}」からページを受け取った` }).catch(() => {});
      return json(res, 200, { ok: true, copied, renamed });
    }
    if (p === '/api/check' && req.method === 'POST') {
      const { text } = JSON.parse(await readBody(req));
      return json(res, 200, await runCheck(text));
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

async function freePort(start) {
  for (let port = start; port < start + 200; port++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error('空きポートがありません');
}

let serverUrl = '';
// text の中の図（figs/…）を、from の資料のフォルダから dest の figs/ へ写す。
// 同じ名前で中身が違う図があれば名前を変えて写し、text の参照も書き換える
async function bringFigures(text, from, dest) {
  const copied = [], renamed = [];
  const src = from ? path.dirname(path.resolve(String(from))) : null;
  if (!src || src === path.resolve(dest)) return { text, copied, renamed };
  const refs = [...new Set([...text.matchAll(/figs\/[^\s)"'<>\]]+/g)].map((m) => m[0].replace(/[?#].*$/, '')))];
  let out = text;
  for (const rel of refs) {
    const from1 = path.join(src, rel);
    if (!from1.startsWith(path.join(src, 'figs') + path.sep) || !fs.existsSync(from1)) continue;
    const buf = await fsp.readFile(from1);
    let target = rel;
    let to = path.join(dest, target);
    if (fs.existsSync(to) && !buf.equals(await fsp.readFile(to))) {
      const ext = path.extname(rel), stem = rel.slice(0, -ext.length);
      let n = 2;
      while (fs.existsSync(path.join(dest, `${stem}-${n}${ext}`)) && !buf.equals(await fsp.readFile(path.join(dest, `${stem}-${n}${ext}`)))) n++;
      target = `${stem}-${n}${ext}`;
      to = path.join(dest, target);
      out = out.split(rel).join(target);
      renamed.push({ from: rel, to: target });
    }
    if (!fs.existsSync(to)) {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.writeFile(to, buf);
      copied.push(target);
    }
  }
  return { text: out, copied, renamed };
}
let restoring = '';
// Git で管理されていれば、この資料のフォルダのコミットも履歴に並べる
async function gitLog() {
  const root = await G.repoRoot(deckDir).catch(() => null);
  if (!root) return null;
  const dir = path.relative(root, deckDir) || '.';
  const [log, st] = await Promise.all([G.log(root, dir, 100), G.status(root, dir)]);
  return { log, changes: st.files?.length ?? st.count ?? 0 };
}
async function gitText(rev) {
  const root = await G.repoRoot(deckDir);
  if (!root) return null;
  const buf = await G.show(root, rev, path.relative(root, deckPath).split(path.sep).join('/'));
  return buf == null ? null : String(buf);
}
// --- 書き出し -------------------------------------------------------------------------
const EXPORTS = {
  pdf: { ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
  'pdf-notes': { ext: 'pdf', mime: 'application/pdf', label: '発表者用PDF', args: ['--pdf', '--notes'], suffix: '-notes' },
  pptx: { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint' },
  html: { ext: 'html', mime: 'text/html; charset=utf-8', label: 'HTML' },
};
const exportPath = (fmt) => path.join(deckDir, 'dist', `${path.basename(deckPath, '.md')}${EXPORTS[fmt].suffix || ''}.${EXPORTS[fmt].ext}`);
function deckTitle() {
  const m = fs.readFileSync(deckPath, 'utf8').match(/^---\n[\s\S]*?^title:\s*"?(.+?)"?\s*$/m);
  return m?.[1].replace(/<br\s*\/?>/g, ' ').trim();
}
// 同じ形式を同時に2回走らせない
const exporting = new Map();
function runExport(fmt) {
  if (exporting.has(fmt)) return exporting.get(fmt);
  const job = new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(here, '..', 'bin', 'slides.mjs'), 'build', deckPath, ...(EXPORTS[fmt].args || [`--${fmt}`])], { cwd: path.resolve(here, '..', '..'), timeout: 600000, maxBuffer: 16 * 1024 * 1024 },
      (err, so, se) => (err ? reject(new Error(String(se).trim().split('\n').filter(Boolean).pop() || err.message)) : resolve()));
  }).finally(() => exporting.delete(fmt));
  exporting.set(fmt, job);
  return job;
}
// 一覧（ライブラリー）へ戻る先。ハブから開いたときは --hub、単独で開いたときは既定のポートで動いていれば使う
let hubCache;
async function hubUrl() {
  if (opt('--hub')) return opt('--hub');
  if (process.env.MARP_NO_HUB) return null;
  if (hubCache !== undefined) return hubCache;
  try {
    const r = await fetch('http://127.0.0.1:4860/api/info', { signal: AbortSignal.timeout(400) });
    hubCache = r.ok ? 'http://127.0.0.1:4860/' : null;
  } catch { hubCache = null; }
  setTimeout(() => { hubCache = undefined; }, 30000); // ハブを後から起動しても拾えるように
  return hubCache;
}
await build();
const port = await freePort(Number(opt('--port') || 4870));
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  serverUrl = url;
  console.log(`エディター: ${url}  （${path.relative(process.cwd(), deckPath)}）`);
  // --split で分割表示から、--preview で読むだけのプレビュー画面を既定のブラウザで開く
  const target = args.includes('--split') ? `${url}?view=split` : args.includes('--preview') ? `${url}preview` : url;
  if (args.includes('--no-open')) return;
  spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
});
