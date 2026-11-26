// Marpのスライドを1280×720で描画し、見切れ・崩れを検査して、各ページのPNGとコンタクトシートを出す。
// usage: node marp/scripts/check.mjs <slides.md> [--out DIR] [--pages 1-20] [--no-shots] [--contact] [--json]
//
// 検査項目（error は直すべきもの、warn は目視で確かめるもの）
//   overflow-footer  本文がフッター（パンくず・ページ番号）の領域へはみ出している     error
//   overflow-slide   文字や要素がスライドの外へはみ出している                         error
//   overflow-box     コード・表のセルなど、枠の中で文字が切れている                  error
//   image-missing    画像が読み込めない                                              error
//   image-shrunk     指定した高さより図が縮んで表示されている（文字が小さくなる）      warn
//   title-wrap       タイトルが2行になり、タイトル帯が太っている                      warn
//   lead-lines       リード文が4行以上                                               warn
//   footer-wrap      パンくずが2行になっている                                       warn
//   svg-text-outside SVG内の文字がviewBoxの外に出ている                              error
//   svg-text-overlap SVG内で文字同士が重なっている                                   warn
//   svg-text-box     SVG内の文字が、囲んでいる枠（rect）からはみ出している             warn
//   svg-text-line    SVG内の文字の上を直線が横切っている                              warn
//   svg-text-small   SVG内に16px未満の文字がある（表示すると15px前後で読みにくい）     warn
//   figure-small     図の描いた範囲が幅720px未満、または高さ200px未満で下が170px以上空く  warn
//   ai-comma         タイトルの読点・主語や目的語の直後の読点・1文に読点2つ以上（リード・箇条書き・表）  warn
//                    長い主語や目的語のあとの読点がリードの1割以上（資料に1件）       warn
//   placeholder      表紙・裏表紙の名前が「Your Name」のまま                          warn
//   ai-phrase        日本語の言い換え候補（打ち手・筋がいい など。phrases.json）        warn
//   ai-three-numbers 1枚の図に大きな数字を3つ以上並べている                           warn
//   ai-serial        01・02 の通し番号                                                warn
//   ai-monotone      2文のリード＋図のページが4枚以上続く                              info
//   title-duplicate  同じタイトルのページが複数ある                                  info
//   figure-no-lead   図が主役なのにリード文がない（図を読む理由がない）               info
//   figure-orphan    figs/ にあるが、どのページからも使われていない図                  info
import { checkLayout, measureSvg, checkWriting, svgFindings, inkBox } from '../shared/deck-check.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { renderDeck, CHROME } from './render-lib.mjs';

const args = process.argv.slice(2);
const input = path.resolve(args.find((a) => !a.startsWith('--') && !/^\d/.test(a)) || 'slides.md');
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const out = path.resolve(opt('--out') || path.join(path.dirname(input), '.check'));
const shots = !args.includes('--no-shots');
const contact = args.includes('--contact');
let range = null;
if (opt('--pages')) { const [a, b] = opt('--pages').split('-').map(Number); range = [a, b || a]; }

await fs.mkdir(out, { recursive: true });
const { htmlPath, count } = await renderDeck(input, out);

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(htmlPath).href);
await page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
});

const issues = await page.evaluate(checkLayout, { range });

// SVG内の文字
const svgIssues = [];
const figs = [...new Set(await page.evaluate(() => [...document.querySelectorAll('section img')].map((i) => i.getAttribute('src')).filter((s) => s.endsWith('.svg'))))];
const svgPage = await browser.newPage();
const inks = new Map();   // 図の中で実際に描いた範囲（背景の矩形を除く）
for (const src of figs) {
  const file = path.resolve(path.dirname(input), src);
  let svg;
  try { svg = await fs.readFile(file, 'utf8'); } catch { continue; }
  const vb = svg.match(/viewBox="([^"]+)"/)?.[1].split(/[ ,]+/).map(Number);
  if (!vb) continue;
  await svgPage.setViewportSize({ width: Math.ceil(vb[2]), height: Math.ceil(vb[3]) });
  await svgPage.setContent(`<style>body{margin:0}body>svg{display:block;width:100vw;height:100vh}</style>${svg}`);
  const r = await svgPage.evaluate(measureSvg);
  const pages = await page.evaluate((src) => [...document.querySelectorAll('section[id]')].map((s, i) => (s.querySelector(`img[src="${src}"]`) ? i + 1 : 0)).filter(Boolean), src);
  svgIssues.push(...svgFindings(r, src, pages));
  inks.set(src, { vb, box: await svgPage.evaluate(inkBox) });
}
await svgPage.close();

// 図が小さい：描いた範囲が本文の幅に対して狭い、または1段で低いのにページの下が大きく空いている
const placed = await page.evaluate(() => [...document.querySelectorAll('section[id]')].flatMap((sec, i) => {
  if (/\b(cover|closing|divider)\b/.test(sec.className)) return [];
  const s = sec.getBoundingClientRect();
  const k = 1280 / s.width;
  return [...sec.querySelectorAll('img')].filter((im) => /\.svg$/.test(im.getAttribute('src') || ''))
    .map((im) => { const b = im.getBoundingClientRect(); return { page: i + 1, src: im.getAttribute('src'), y: (b.top - s.top) * k, w: b.width * k }; });
}));
for (const p of placed) {
  const ink = inks.get(p.src);
  if (!ink?.box) continue;
  const scale = p.w / ink.vb[2];
  const w = (ink.box.x1 - ink.box.x0) * scale, h = (ink.box.y1 - ink.box.y0) * scale;
  const gap = 720 - 52 - (p.y + (ink.box.y1 - ink.vb[1]) * scale);
  if (w < 720 || (h < 200 && gap > 170)) svgIssues.push({ page: p.page, type: 'figure-small', level: 'warn', msg: `${p.src}: 図が小さい（描いた範囲 ${Math.round(w)}×${Math.round(h)}px、下の空き ${Math.round(gap)}px）。本文の幅いっぱいに描き、低い図は値の例や条件を足して縦を使う` });
}

// 資料全体の整合
const phrases = JSON.parse(await fs.readFile(new URL('./phrases.json', import.meta.url), 'utf8'));
const deckIssues = await page.evaluate(checkWriting, phrases);
const allImages = await page.evaluate(() => [...document.querySelectorAll('section img')].map((i) => i.getAttribute('src')));
const used = new Set(allImages.map((f) => path.resolve(path.dirname(input), f)));
const figDir = path.join(path.dirname(input), 'figs');
const orphan = [];
try { for (const f of await fs.readdir(figDir)) if (/\.(svg|png|jpe?g|webp)$/i.test(f) && !used.has(path.join(figDir, f))) orphan.push({ page: 0, type: 'figure-orphan', level: 'info', msg: `使われていない図: figs/${f}` }); } catch {}

const all = [...issues, ...svgIssues, ...deckIssues, ...orphan].sort((a, b) => a.page - b.page);

// 撮影
let shotDir;
if (shots || contact) {
  shotDir = path.join(out, 'pages');
  await fs.mkdir(shotDir, { recursive: true });
  const els = await page.$$('svg[data-marpit-svg]');
  for (let i = 0; i < els.length; i++) {
    if (range && (i + 1 < range[0] || i + 1 > range[1])) continue;
    if (shots) await els[i].screenshot({ path: path.join(shotDir, `p${String(i + 1).padStart(3, '0')}.png`) });
  }
  if (contact) {
    // 撮影済みのPNGを並べる（スライドを複製するとMarpのセレクタが外れるため）
    const per = 30, cols = 5, w = 320, h = 180, gap = 8;
    const targets = [...Array(count).keys()].filter((i) => !range || (i + 1 >= range[0] && i + 1 <= range[1]));
    const flagged = new Set(all.filter((x) => x.level === 'error').map((x) => x.page));
    const cp = await browser.newPage();
    for (let c = 0; c * per < targets.length; c++) {
      const chunk = targets.slice(c * per, (c + 1) * per);
      const W = cols * (w + gap) + gap, H = Math.ceil(chunk.length / cols) * (h + 22 + gap) + gap;
      await cp.setViewportSize({ width: W, height: H });
      const cells = chunk.map((i, k) => {
        const x = gap + (k % cols) * (w + gap), y = gap + Math.floor(k / cols) * (h + 22 + gap);
        const bad = flagged.has(i + 1);
        const src = pathToFileURL(path.join(shotDir, `p${String(i + 1).padStart(3, '0')}.png`)).href;
        return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;background:#fff"><div style="font:bold 14px sans-serif;height:22px;line-height:22px;padding-left:4px;color:#fff;background:${bad ? '#c0392b' : '#333'}">P.${i + 1}${bad ? '  ⚠' : ''}</div><img src="${src}" style="display:block;width:${w}px;height:${h}px"></div>`;
      }).join('');
      const sheet = path.join(out, '.contact.html');
      await fs.writeFile(sheet, `<body style="margin:0;background:#ddd">${cells}</body>`);
      await cp.goto(pathToFileURL(sheet).href);
      await cp.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
      await cp.screenshot({ path: path.join(out, `contact-${String(c + 1).padStart(2, '0')}.png`) });
    }
    await cp.close();
  }
}
await browser.close();

const errors = all.filter((x) => x.level === 'error');
const warns = all.filter((x) => x.level === 'warn');
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ input, count, errors: errors.length, warnings: warns.length, issues: all }, null, 2));
if (args.includes('--json')) console.log(JSON.stringify({ count, errors: errors.length, warnings: warns.length, issues: all }));
else {
  const verbose = args.includes('--verbose');
  for (const x of all) if (x.level !== 'info' || verbose) console.log(`${{ error: '✗', warn: '△', info: '・' }[x.level]} ${x.page ? `P.${x.page} ` : ''}[${x.type}] ${x.msg}`);
  const infos = all.filter((x) => x.level === 'info').length;
  console.log(`\n${count}枚  error ${errors.length}  warn ${warns.length}  info ${infos}${infos && !verbose ? '（--verbose で表示）' : ''}  →  ${path.relative(process.cwd(), out)}/`);
}
process.exitCode = errors.length ? 1 : 0;
