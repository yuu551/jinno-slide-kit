// PDF の品質を数える（SPEC §1 の「アプリの PDF の品質」）。
//
// 使い方:
//   node scripts/dev/pdf-quality.mjs <PDF> [<PDF> ...]
//   node scripts/dev/pdf-quality.mjs --json out.json <PDF> ...
//   node scripts/dev/pdf-quality.mjs --compare <CLI の PDF> <アプリの PDF>
//
// 数えるもの: ページ数・目次の題と行き先・付箋（注釈）の数と中身・リンク・
// 文字（pdftotext の文字数と康煕部首 U+2F00〜U+2FDF の数）・フォント・画像。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const swiftFile = path.join(here, 'pdf-quality.swift');
const args = process.argv.slice(2);
const opt = (k, fallback = undefined) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const jsonPath = opt('--json');
const compareIdx = args.indexOf('--compare');
const compare = compareIdx >= 0 ? args.slice(compareIdx + 1, compareIdx + 3) : null;
const files = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  if (jsonPath && args[i - 1] === '--json') return false;
  if (compareIdx >= 0 && i >= compareIdx && i < compareIdx + 3) return false;
  return true;
});

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}
function must(cmd, argv, opts = {}) {
  const r = run(cmd, argv, opts);
  if (r.status !== 0) throw new Error(`${cmd} が失敗しました（${r.status}）\n${r.stderr || r.stdout}`);
  return r.stdout;
}

// Swift の道具は初回だけコンパイルする（毎回の起動を速くする）
const bin = path.join('/tmp', `marpkit-pdf-quality-${process.getuid?.() ?? 0}`);
function swiftTool() {
  const srcMtime = fs.statSync(swiftFile).mtimeMs;
  if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= srcMtime) return bin;
  const r = run('swiftc', ['-O', swiftFile, '-o', bin]);
  if (r.status !== 0) throw new Error(`pdf-quality.swift をコンパイルできません\n${r.stderr}`);
  return bin;
}

function meta(file) {
  const text = must('pdftotext', ['-layout', file, '-']);
  const kangxi = [...text].filter((ch) => {
    const n = ch.codePointAt(0);
    return n >= 0x2f00 && n <= 0x2fdf;
  }).length;
  const fonts = must('pdffonts', [file]);
  const fontRows = fonts.split('\n').slice(2).filter((l) => l.trim());
  const images = must('pdfimages', ['-list', file]);
  const imageRows = images.split('\n').slice(2).filter((l) => l.trim());
  return { textChars: [...text].length, kangxi, fonts: fontRows.length, images: imageRows.length, text };
}

function one(file) {
  if (!fs.existsSync(file)) throw new Error(`PDF がありません: ${file}`);
  const swift = JSON.parse(must(swiftTool(), [file]))[0];
  if (!swift) throw new Error(`PDF を開けません: ${file}`);
  const m = meta(file);
  const noteText = swift.notes.map((n) => n.contents);
  return {
    file,
    pages: swift.pages,
    title: swift.title,
    width: swift.width,
    height: swift.height,
    outline: swift.outline,
    notes: swift.notes,
    links: swift.links,
    textChars: m.textChars,
    kangxi: m.kangxi,
    fonts: m.fonts,
    images: m.images,
    text: m.text,
  };
}

function summary(r) {
  const outline = r.outline.map((o) => `${o.title}→${o.page}`).join(' / ');
  return [
    `ページ ${r.pages}`,
    `目次 ${r.outline.length}`,
    `付箋 ${r.notes.length}`,
    `リンク ${r.links.length}`,
    `文字 ${r.textChars}`,
    `康煕部首 ${r.kangxi}`,
    `フォント ${r.fonts}`,
    `画像 ${r.images}`,
    outline ? `目次: ${outline.slice(0, 240)}${outline.length > 240 ? '…' : ''}` : '目次なし',
    r.notes.length ? `付箋: ${r.notes.slice(0, 4).map((n) => `p.${n.page}「${n.contents.slice(0, 60)}」`).join(' / ')}` : '付箋なし',
  ].join(' ｜ ');
}

function diff(a, b) {
  const out = [];
  if (a.pages !== b.pages) out.push(`ページ数 ${a.pages} / ${b.pages}`);
  const oj = (r) => JSON.stringify(r.outline);
  if (oj(a) !== oj(b)) out.push(`目次が違う（${a.outline.length} / ${b.outline.length}）`);
  const nj = (r) => JSON.stringify(r.notes.map((n) => [n.page, n.contents]));
  if (nj(a) !== nj(b)) out.push(`付箋が違う（${a.notes.length} / ${b.notes.length}）`);
  const lj = (r) => JSON.stringify(r.links.map((l) => [l.page, l.url, l.target]).sort());
  if (lj(a) !== lj(b)) out.push(`リンクが違う（${a.links.length} / ${b.links.length}）`);
  if (a.kangxi !== b.kangxi) out.push(`康煕部首 ${a.kangxi} / ${b.kangxi}`);
  if (a.textChars !== b.textChars) out.push(`文字数 ${a.textChars} / ${b.textChars}`);
  return out;
}

const results = files.map(one);
if (compare) {
  const [a, b] = compare.map(one);
  const d = diff(a, b);
  console.log(`基準: ${summary(a)}`);
  console.log(`比べる: ${summary(b)}`);
  console.log(d.length ? `✗ 違う: ${d.join(' / ')}` : '✓ ページ数・目次・付箋・リンク・文字が一致');
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify({ base: a, target: b, diffs: d }, null, 1));
  process.exitCode = d.length ? 1 : 0;
} else {
  for (const r of results) {
    console.log(`\n=== ${r.file}`);
    console.log(summary(r));
    console.log(`サイズ ${r.width ?? '?'}×${r.height ?? '?'}pt、題名 ${JSON.stringify(r.title)}`);
    const pagesWithoutOutline = r.pages - new Set(r.outline.map((o) => o.page)).size;
    console.log(`目次のないページ ${pagesWithoutOutline}、文字のないページ ${r.pages - new Set(r.text.split('\f').map((t, i) => (t.trim() ? i + 1 : 0)).filter(Boolean)).size}`);
  }
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(results.map(({ text, ...r }) => r), null, 1));
    console.log(`\n→ ${jsonPath}`);
  }
}
