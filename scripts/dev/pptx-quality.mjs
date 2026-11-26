// PowerPoint（PPTX）の品質を数える（SPEC §1 の「アプリの PowerPoint の品質」）。
//
// 使い方:
//   node scripts/dev/pptx-quality.mjs <PPTX> [<PPTX> ...]
//   node scripts/dev/pptx-quality.mjs --json out.json <PPTX> ...
//   node scripts/dev/pptx-quality.mjs --compare <CLI の PPTX> <アプリの PPTX>
//
// 数えるもの: スライド数・図形・文字・表・画像・画像だけのページ・XML の正しさ・
// 関係（rels）の参照先・図形 ID の重複。PowerPoint の修復ダイアログの原因になる
// 「壊れた XML」「無い画像への参照」「ID の重複」を先に見つける。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';

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

const slideName = (n) => {
  const m = n.match(/^ppt\/slides\/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
};

function xmlOk(xml) {
  const r = spawnSync('xmllint', ['--noout', '-'], { input: xml, encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || '').trim().split('\n').slice(0, 3).join(' / ');
}

async function inspect(file) {
  if (!fs.existsSync(file)) throw new Error(`PPTX がありません: ${file}`);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files);
  const slideNames = names.filter((n) => slideName(n)).sort((a, b) => slideName(a) - slideName(b));
  const slides = [];
  const errors = [];
  for (const n of slideNames) {
    const xml = await zip.file(n).async('string');
    const bad = xmlOk(xml);
    if (bad) errors.push(`${n}: XML が壊れている（${bad}）`);
    const count = (re) => (xml.match(re) || []).length;
    const shapes = count(/<p:sp[\s>]/g);
    const texts = count(/<a:t[\s>]/g);
    const tables = count(/<a:tbl[\s>]/g);
    const pics = count(/<p:pic[\s>]/g);
    const text = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('');
    // 図形の id が重複していないか（修復の原因になる）
    const ids = [...xml.matchAll(/<p:cNvPr[^>]*\bid="(\d+)"/g)].map((m) => m[1]);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) errors.push(`${n}: 図形 ID が重複（${[...new Set(dup)].join(', ')}）`);
    // 画像の参照先が zip にあるか
    const relName = n.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    let rels = '';
    if (zip.file(relName)) rels = await zip.file(relName).async('string');
    for (const m of xml.matchAll(/r:(?:embed|id)="([^"]+)"/g)) {
      const id = m[1];
      const rel = rels.match(new RegExp(`<Relationship[^>]*Id="${id}"[^>]*>`));
      if (!rel) { errors.push(`${n}: 関係 ${id} が rels にない`); continue; }
      if (/TargetMode="External"/.test(rel[0])) continue;
      const target = (rel[0].match(/Target="([^"]+)"/) || [])[1];
      if (!target || /^(?:https?|mailto):/.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(n), target));
      if (!zip.file(resolved)) errors.push(`${n}: 参照先がない（${resolved}）`);
    }
    slides.push({ name: n, shapes, texts, tables, pics, textLength: [...text].length, text: text.slice(0, 80), imageOnly: pics > 0 && texts === 0 && shapes === 0 && tables === 0 });
  }
  // すべての XML が well-formed か（スライド以外も見る）
  for (const n of names.filter((x) => x.endsWith('.xml') || x.endsWith('.rels'))) {
    const data = await zip.file(n).async('string');
    const bad = xmlOk(data);
    if (bad) errors.push(`${n}: XML が壊れている（${bad}）`);
  }
  const totals = slides.reduce((a, s) => ({
    shapes: a.shapes + s.shapes, texts: a.texts + s.texts, tables: a.tables + s.tables, pics: a.pics + s.pics,
  }), { shapes: 0, texts: 0, tables: 0, pics: 0 });
  return {
    file,
    bytes: fs.statSync(file).size,
    slides: slides.length,
    ...totals,
    imageOnly: slides.filter((s) => s.imageOnly).map((s) => slideName(s.name)),
    errors,
    perSlide: slides.map(({ text, ...s }) => s),
  };
}

function summary(r) {
  return [
    `${r.slides}枚`,
    `${(r.bytes / 1024 / 1024).toFixed(1)}MB`,
    `図形 ${r.shapes}`,
    `文字 ${r.texts}`,
    `表 ${r.tables}`,
    `画像 ${r.pics}`,
    `画像だけのページ ${r.imageOnly.length}${r.imageOnly.length ? `（${r.imageOnly.join(', ')}）` : ''}`,
    r.errors.length ? `問題 ${r.errors.length}` : '構造 OK',
  ].join(' ｜ ');
}

function diff(a, b) {
  const out = [];
  for (const k of ['slides', 'shapes', 'texts', 'tables', 'pics']) {
    if (a[k] !== b[k]) out.push(`${k} ${a[k]} / ${b[k]}`);
  }
  if (a.imageOnly.length !== b.imageOnly.length) out.push(`画像だけのページ ${a.imageOnly.length} / ${b.imageOnly.length}`);
  const ai = a.perSlide.map((s) => `${s.name}:${s.shapes},${s.texts},${s.tables},${s.pics}`).join('|');
  const bi = b.perSlide.map((s) => `${s.name}:${s.shapes},${s.texts},${s.tables},${s.pics}`).join('|');
  if (ai !== bi) out.push('ページごとの数が違う');
  if (b.errors.length) out.push(`比べる側に問題 ${b.errors.length}`);
  return out;
}

const results = [];
for (const f of files) results.push(await inspect(f));
if (compare) {
  const [a, b] = [await inspect(compare[0]), await inspect(compare[1])];
  const d = diff(a, b);
  console.log(`基準: ${summary(a)}`);
  console.log(`比べる: ${summary(b)}`);
  console.log(d.length ? `✗ 違う: ${d.join(' / ')}` : '✓ スライド数・図形・文字・表・画像・ページごとの数が一致');
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify({ base: a, target: b, diffs: d }, null, 1));
  process.exitCode = d.length ? 1 : 0;
} else {
  for (const r of results) {
    console.log(`\n=== ${r.file}`);
    console.log(summary(r));
    for (const e of r.errors.slice(0, 20)) console.log(`  ✗ ${e}`);
    if (r.errors.length > 20) console.log(`  …ほか ${r.errors.length - 20} 件`);
  }
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 1));
    console.log(`\n→ ${jsonPath}`);
  }
}
