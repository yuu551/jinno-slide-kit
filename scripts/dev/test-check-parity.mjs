// エディターの見切れ検査（marp/editor/client/check.mjs）と CLI の検査（marp/shared/deck-check.mjs）が
// 同じページに同じ指摘を出すかを確かめる。
//   1. CLI と同じ描画に両方の検査を当てて比べる（等倍と、エディターの縮小表示を模した 0.5 倍）
//   2. エディターを開き、サムネイルの印（全ページの検査結果）を CLI の結果と比べる
// 作例・雛形に加え、見出しの2行・長いリード・フッターへのはみ出しをわざと起こす資料でも比べる。
// usage: node scripts/dev/test-check-parity.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { renderDeck, CHROME } from '../../marp/scripts/render-lib.mjs';
import { checkLayout } from '../../marp/shared/deck-check.mjs';
import { startServer } from '../../marp/editor/test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const editorCheck = await fs.readFile(path.join(root, 'marp/editor/client/check.mjs'), 'utf8');
// 両方が見る項目。CLI だけの項目（泣き別れ・SVG の中・文章）は比べない
const SHARED = new Set(['overflow-footer', 'overflow-slide', 'overflow-box', 'image-missing', 'image-shrunk', 'title-wrap', 'lead-lines', 'footer-wrap']);
const TYPE_OF_MSG = [
  [/^タイトルが2行/, 'title-wrap'], [/^リード文が/, 'lead-lines'], [/^パンくずが2行/, 'footer-wrap'],
  [/フッター領域へ/, 'overflow-footer'], [/スライドの外へ/, 'overflow-slide'], [/枠内で切れている|枠の外へはみ出している/, 'overflow-box'],
  [/^画像が読めない/, 'image-missing'], [/縮小/, 'image-shrunk'],
];

const lead = '検査がそろっているかを確かめるために、少し長めのリード文を置いています。'.repeat(7);
const bullets = Array.from({ length: 11 }, (_, i) => `- 本文がフッターまで届くかを確かめる項目 ${i + 1}`).join('\n');
const fixture = (front) => `---
marp: true
${front}
paginate: true
title: "検査のそろい方"
chapters: [はじめに, 本題]
---

<!-- _class: cover cover-talk -->

# 検査のそろい方

---

# 1行に収まる見出し

短いリードです。

---

# とても長い見出しを書いて二行に折り返させ、タイトルの帯が太るかを見るページ

短いリードです。

---

# リードが長いページ

${lead}

---

# 本文がフッターまで届くページ

短いリードです。

${bullets}
`;
// ページ番号と、CLI が出すはずの指摘
const EXPECT = { 3: 'title-wrap', 4: 'lead-lines', 5: 'overflow-footer' };
const FIXTURES = {
  'fixture-talk': fixture('theme: petrol'),
  'fixture-classic': fixture('theme: petrol\nlayout: classic'),
  'fixture-paper': fixture('theme: paper'),
};

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([name, 'ok']); console.log(`✓ ${name}`); }
  catch (e) { results.push([name, 'NG']); console.log(`✗ ${name}\n    ${String(e.message).split('\n').join('\n    ')}`); }
};
const keys = (list) => [...new Set(list.filter((x) => SHARED.has(x.type)).map((x) => `${x.page}:${x.type}`))].sort();
const diff = (a, b) => ({ onlyA: a.filter((k) => !b.includes(k)), onlyB: b.filter((k) => !a.includes(k)) });
const same = (label, a, b) => {
  const d = diff(a, b);
  if (d.onlyA.length || d.onlyB.length) throw new Error(`${label}: CLI だけ ${JSON.stringify(d.onlyA)} / エディターだけ ${JSON.stringify(d.onlyB)}`);
};

// 資料を一時フォルダへ写す（作例・雛形のフォルダに .render-*.html を残さない）
async function prepare(name, src) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `check-parity-${name}-`));
  if (FIXTURES[name]) await fs.writeFile(path.join(dir, 'slides.md'), FIXTURES[name]);
  else await fs.cp(src, dir, { recursive: true, filter: (f) => !/\.(pdf|pptx)$|[\\/]\.check$/.test(f) });
  return path.join(dir, 'slides.md');
}

const browser = await chromium.launch({ executablePath: CHROME });

async function cliAndEditor(md) {
  const { htmlPath } = await renderDeck(md, path.dirname(md));
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  });
  await page.addScriptTag({ type: 'module', content: `${editorCheck}\nwindow.__checkSection = checkSection;` });
  await page.waitForFunction(() => typeof window.__checkSection === 'function');
  const cli = await page.evaluate(checkLayout, { range: null });
  const editorAt = (scale) => page.evaluate((scale) => {
    for (const svg of document.querySelectorAll('svg[data-marpit-svg]')) { svg.style.transformOrigin = '0 0'; svg.style.transform = scale === 1 ? '' : `scale(${scale})`; }
    return [...document.querySelectorAll('section[id]')].flatMap((s, i) => window.__checkSection(s, scale).map(({ el, ...r }) => ({ page: i + 1, ...r })));
  }, scale);
  const editor1 = await editorAt(1);
  const editorHalf = await editorAt(0.5);
  await page.close();
  return { cli, editor1, editorHalf };
}

// エディターで全ページの検査が終わるのを待ち、サムネイルの印から指摘を読む
async function editorThumbs(md, port) {
  const { server, url } = await startServer(md, port);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelectorAll('#thumbs > *').length > 0, null, { timeout: 30000 });
    const read = () => page.evaluate(() => ({
      pending: document.querySelector('[data-more="summary"]')?.textContent.includes('確認中'),
      thumbs: [...document.querySelectorAll('#thumbs > *')].map((t) => { const b = t.querySelector('.mj-thumb-badge'); return b && !b.hidden ? b.title : ''; }),
    }));
    let last = '', stableSince = Date.now();
    const t0 = Date.now();
    for (;;) {
      const r = await read();
      const now = JSON.stringify(r.thumbs);
      if (now !== last) { last = now; stableSince = Date.now(); }
      if (!r.pending && Date.now() - stableSince > 2000) {
        return r.thumbs.flatMap((title, i) => title.split('\n').filter(Boolean).map((msg) => ({ page: i + 1, type: (TYPE_OF_MSG.find(([re]) => re.test(msg)) || [, 'unknown'])[1], msg })));
      }
      if (Date.now() - t0 > 90000) throw new Error('エディターの検査が終わりません');
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    await page.close();
    server.kill();
  }
}

const decks = [
  ...['jev-guardrail', 'rag-webinar', 'cognito-cimd'].map((n) => [n, path.join(root, 'examples/gallery', n)]),
  ...(await fs.readdir(path.join(root, 'marp/templates'))).sort().map((n) => [n, path.join(root, 'marp/templates', n)]),
  ...Object.keys(FIXTURES).map((n) => [n, null]),
];
const cliByDeck = {};
for (const [name, src] of decks) {
  const md = await prepare(name, src);
  const { cli, editor1, editorHalf } = await cliAndEditor(md);
  cliByDeck[name] = { md, cli };
  await test(`[${name}] 同じ描画で CLI とエディターの指摘が同じ（等倍・0.5倍）`, async () => {
    same('等倍', keys(cli), keys(editor1));
    same('0.5倍', keys(cli), keys(editorHalf));
  });
  if (FIXTURES[name]) {
    await test(`[${name}] わざと起こした見出しの2行・長いリード・はみ出しを CLI が見つける`, async () => {
      const got = keys(cli);
      for (const [p, type] of Object.entries(EXPECT)) if (!got.includes(`${p}:${type}`)) throw new Error(`${p}ページ目に ${type} がありません（${JSON.stringify(got)}）`);
      if (got.some((k) => k.startsWith('2:'))) throw new Error(`1行の見出しのページに指摘があります（${JSON.stringify(got)}）`);
    });
  }
}

// エディターの画面でも同じになるか（表示中のページは縮小表示、ほかは裏で等倍の検査）
let port = 4930;
for (const name of ['rag-webinar', 'fixture-talk', 'fixture-classic']) {
  const { md, cli } = cliByDeck[name];
  await test(`[${name}] エディターのサムネイルの印が CLI の結果と同じ`, async () => {
    same('エディター', keys(cli), keys(await editorThumbs(md, port)));
  });
  port += 10;
}

await browser.close();
const ng = results.filter(([, r]) => r !== 'ok').length;
console.log(`${results.length - ng}/${results.length} 通過`);
process.exit(ng ? 1 : 0);
