// AWS の公式アイコン集（Architecture Icons）を配布元から取得して、手元のキャッシュに展開する。
// キットにはアイコンを同梱しない（docs/aws-icons.md）。図には skills/marp-jinno/scripts/jfig.py の aws() で埋め込む。
//
// usage: node marp/scripts/aws-icons.mjs fetch [--zip <ダウンロード済みのzip>] [--url <zipのURL>] [--force]
//        node marp/scripts/aws-icons.mjs find <語> [<語>...] [--all]
//        node marp/scripts/aws-icons.mjs dir
//
// 展開先は ~/.cache/jinno-marp/aws-icons/<パッケージ名>/（JINNO_MARP_AWS_ICONS_HOME か XDG_CACHE_HOME で変えられる）。
// 取得したパッケージは current.json に記録し、jfig.py はそこから探す。SVG だけを展開する（PNG は使わない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

export const PAGE = 'https://aws.amazon.com/architecture/icons/';
export const HOME = process.env.JINNO_MARP_AWS_ICONS_HOME
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'jinno-marp', 'aws-icons');
const CURRENT = path.join(HOME, 'current.json');

const args = process.argv.slice(2);
const [cmd, ...rest] = args;
const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const say = (s) => console.log(s);
const fail = (s, code = 1) => { console.error(s); process.exit(code); };

// 公式ページから最新のアイコン集（Icon-package_<日付>.<hash>.zip）のリンクを読む。リリースごとに URL が変わる
async function latestUrl() {
  const res = await fetch(PAGE, { headers: { 'user-agent': 'jinno-slide-kit (+https://github.com/yuu551/jinno-slide-kit)' } });
  if (!res.ok) throw new Error(`${PAGE} を読めませんでした（HTTP ${res.status}）`);
  const html = await res.text();
  const links = [...new Set(html.match(/https:\/\/[a-z0-9.-]+\.awsstatic\.com\/[^"'\s<>]*\/Icon-package_[^"'\s<>]+\.zip/gi) || [])];
  if (!links.length) throw new Error(`${PAGE} にアイコン集（Icon-package_*.zip）のリンクが見つかりません。docs/aws-icons.md の手動の手順で取得してください`);
  return links[0];
}

const keyOf = (file) => path.basename(file, '.svg');
const kindOf = (rel) => (/^Architecture-Service-Icons/.test(rel) ? 'service' : /^Resource-Icons/.test(rel) ? 'resource'
  : /^Architecture-Group-Icons/.test(rel) ? 'group' : /^Category-Icons/.test(rel) ? 'category' : 'other');
// 探すときの優先順。サービスは64、リソースは48の淡色（白地用）を先に出す
const rank = (e) => ({ service: 0, resource: 1, group: 2, category: 3, other: 4 }[e.kind] * 10
  + (/_64$|_48(_Light)?$|_32$/.test(e.key) ? 0 : 1) + (/_Dark$/.test(e.key) ? 2 : 0));
export const norm = (s) => s.toLowerCase().replace(/^(arch|res|arch-category)_/, '').replace(/_(16|20|24|32|48|64)(@5x)?(_light|_dark)?$/, '$3')
  .replace(/\b(amazon|aws)\b/g, '').replace(/[^a-z0-9]/g, '');

async function extract(buf, name, source) {
  const dest = path.join(HOME, name);
  const zip = await JSZip.loadAsync(buf);
  const entries = [];
  for (const [rel, file] of Object.entries(zip.files)) {
    if (file.dir || rel.startsWith('__MACOSX/') || path.basename(rel).startsWith('.') || !rel.toLowerCase().endsWith('.svg')) continue;
    const out = path.resolve(dest, rel);
    if (!out.startsWith(dest + path.sep)) continue; // zip の中の ../ を展開先の外に書かない
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await file.async('nodebuffer'));
    entries.push({ key: keyOf(rel), file: rel, kind: kindOf(rel) });
  }
  if (!entries.length) throw new Error('zip に SVG が入っていません。公式の Icon package（Asset Package）か確かめてください');
  entries.sort((a, b) => a.key.localeCompare(b.key));
  fs.writeFileSync(path.join(dest, 'index.json'), JSON.stringify(entries, null, 0));
  fs.writeFileSync(CURRENT, JSON.stringify({ dir: dest, package: name, source, fetchedAt: new Date().toISOString() }, null, 2));
  return { dest, count: entries.length };
}

function current() {
  if (!fs.existsSync(CURRENT)) fail('AWS の公式アイコンがまだありません。先に `slides icons fetch` を実行してください（手順は docs/aws-icons.md）', 2);
  const c = JSON.parse(fs.readFileSync(CURRENT, 'utf8'));
  return { ...c, index: JSON.parse(fs.readFileSync(path.join(c.dir, 'index.json'), 'utf8')) };
}

switch (cmd) {
  case 'fetch': {
    fs.mkdirSync(HOME, { recursive: true });
    let buf, source;
    if (opt('--zip')) {
      source = path.resolve(opt('--zip'));
      buf = fs.readFileSync(source);
    } else {
      source = opt('--url') || await latestUrl().catch((e) => fail(e.message));
      if (!/^https:\/\//.test(source)) fail('URL は https で指定してください');
      say(`取得します: ${source}`);
      const res = await fetch(source);
      if (!res.ok) fail(`ダウンロードできませんでした（HTTP ${res.status}）。docs/aws-icons.md の手動の手順も使えます`);
      buf = Buffer.from(await res.arrayBuffer());
    }
    const name = path.basename(source).replace(/\.zip$/i, '').replace(/\.[0-9a-f]{20,}$/i, '');
    if (fs.existsSync(path.join(HOME, name, 'index.json')) && !rest.includes('--force')) {
      const c = fs.existsSync(CURRENT) ? JSON.parse(fs.readFileSync(CURRENT, 'utf8')) : {};
      fs.writeFileSync(CURRENT, JSON.stringify({ ...c, dir: path.join(HOME, name), package: name, source }, null, 2));
      say(`取得済みです: ${path.join(HOME, name)}（取り直すときは --force）`);
      break;
    }
    const { dest, count } = await extract(buf, name, source);
    say(`SVG ${count}点を展開しました: ${dest}`);
    say('探すとき: slides icons find api gateway');
    break;
  }
  case 'find': {
    const words = rest.filter((a) => !a.startsWith('--')).map(norm).filter(Boolean);
    if (!words.length) fail('探す語を指定してください（例: slides icons find api gateway）', 2);
    const { dir, index } = current();
    const hits = index.filter((e) => words.every((w) => norm(e.key).includes(w))).sort((a, b) => rank(a) - rank(b) || a.key.length - b.key.length);
    if (!hits.length) fail(`見つかりません: ${words.join(' ')}（語を短くするか英語の正式名で探す。例: "api gateway"・"elastic load balancing"）`, 3);
    const shown = rest.includes('--all') ? hits : hits.filter((e) => !(['service', 'category'].includes(e.kind) && /_(16|32|48)$/.test(e.key))).slice(0, 12);
    for (const e of shown) say(`${e.key.padEnd(48)} ${e.kind.padEnd(8)} ${path.join(dir, e.file)}`);
    if (hits.length > shown.length) say(`ほか${hits.length - shown.length}件（--all で全部）`);
    break;
  }
  case 'dir': {
    const { dir, package: name, source } = current();
    say(`${dir}\n${name}\n${source}`);
    break;
  }
  default:
    fail('usage: slides icons fetch [--zip FILE] [--url URL] [--force] | slides icons find <語...> [--all] | slides icons dir', 2);
}
