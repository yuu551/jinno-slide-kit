// Marpのスライドを、図形・文字・表・画像がそのまま直せる PowerPoint にする（Googleスライドにもそのまま取り込める）。
//   1. marp-core で描いたHTMLをブラウザで開き、extract.js でページを部品の列にする
//   2. 置き換えられない背景（繰り返しのグラデーションなど）だけ、その部分を撮って画像にする
//   3. pptxgenjs で骨組み（スライド・ノート）を作り、各スライドの中身を ooxml.mjs の XML に差し替える
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { renderDeck, CHROME } from '../scripts/render-lib.mjs';
import { assemblePptx, walkItems, summarize } from './assemble.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function exportPptx(input, output, { pages = null, log = console.log, keepHtml = false } = {}) {
  const md = await fs.readFile(input, 'utf8');
  const { htmlPath, comments } = await renderDeck(input);
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    // file:// の図（SVG）の中身を読むため、node 側の読み込みを渡す
    await page.exposeFunction('pptxReadText', async (url) => {
      try { return await fs.readFile(fileURLToPath(url), 'utf8'); } catch { return ''; }
    });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    });
    await page.addScriptTag({ path: path.join(here, 'extract.js') });
    const count = await page.evaluate(() => document.querySelectorAll('section[id]').length);
    const indexes = [...Array(count).keys()].filter((i) => !pages || (i + 1 >= pages[0] && i + 1 <= pages[1]));
    const scenes = await page.evaluate((ix) => window.__pptxExtract(ix), indexes);

    // 置き換えられない背景を撮る
    const rasters = new Map();
    for (const sc of scenes) for (const it of walkItems(sc.items)) if (it.k === 'raster') rasters.set(it.id, { it, index: sc.index });
    for (const [id, { it, index }] of rasters) {
      const buf = await shootRaster(page, index, id, it);
      if (buf) Object.assign(it, { k: 'image', data: buf, crop: null, rot: 0 });
      else it.k = 'skip';
    }

    const buf = await assemblePptx(md, comments, scenes, async it => {
      const img = await imageBytes(page, it, path.dirname(input));
      return img ? { ...img, hash: crypto.createHash('sha1').update(img.buf).digest('hex') } : null;
    }, 'nodebuffer');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, buf);
    const stat = summarize(scenes);
    log(`→ ${path.relative(process.cwd(), output)}（${scenes.length}枚・${(buf.length / 1024 / 1024).toFixed(1)}MB｜図形 ${stat.shape}・文字 ${stat.text}・表 ${stat.table}・画像 ${stat.image}${stat.raster ? `（うち撮った背景 ${stat.raster}）` : ''}）`);
    return { output, scenes };
  } finally {
    await browser.close();
    if (!keepHtml) await fs.rm(htmlPath, { force: true });
  }
}

// 画像の中身。PNG・JPEG・GIF はそのまま、それ以外（WebP など）はブラウザで PNG にする
async function imageBytes(page, it, baseDir) {
  if (it.data) return { buf: it.data, ext: 'png' };
  let buf = null;
  const src = it.src;
  try {
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',');
      const meta = src.slice(5, comma);
      buf = /;base64/.test(meta) ? Buffer.from(src.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(src.slice(comma + 1)));
    } else if (src.startsWith('file:')) buf = await fs.readFile(fileURLToPath(src));
    else if (/^https?:/.test(src)) buf = Buffer.from(await (await fetch(src)).arrayBuffer());
    else buf = await fs.readFile(path.resolve(baseDir, src));
  } catch { return null; }
  const ext = buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpeg' : buf.slice(0, 3).toString() === 'GIF' ? 'gif' : null;
  if (ext) return { buf, ext };
  const b64 = await page.evaluate(async (s) => {
    const im = new Image(); im.src = s; await im.decode().catch(() => {});
    const c = document.createElement('canvas'); c.width = im.naturalWidth || 1; c.height = im.naturalHeight || 1;
    c.getContext('2d').drawImage(im, 0, 0); return c.toDataURL('image/png').split(',')[1];
  }, src.startsWith('data:') ? src : `data:image/*;base64,${buf.toString('base64')}`);
  return { buf: Buffer.from(b64, 'base64'), ext: 'png' };
}

// その要素の背景だけを、ほかを消して撮る
async function shootRaster(page, index, id, it) {
  const box = await page.evaluate(({ index, id }) => {
    const sec = document.querySelectorAll('section[id]')[index];
    const el = sec.querySelector(`[data-pptx-raster~="${id}"]`) || (sec.dataset.pptxRaster?.split(' ').includes(id) ? sec : null);
    if (!el) return null;
    const what = el.dataset[`pptxRaster${id}`];
    el.classList.add('pptx-target');
    document.body.classList.add('pptx-iso', what === 'mask' ? 'pptx-iso-mask' : 'pptx-iso-bg');
    sec.classList.add('pptx-iso-sec');
    sec.scrollIntoView();
    const b = sec.getBoundingClientRect();
    return { x: b.left, y: b.top };
  }, { index, id });
  if (!box) return null;
  await page.addStyleTag({ content: `
    body.pptx-iso, html:has(body.pptx-iso) { background: transparent !important; }
    body.pptx-iso section.pptx-iso-sec { background: transparent !important; }
    body.pptx-iso section.pptx-iso-sec * { visibility: hidden !important; }
    body.pptx-iso section.pptx-iso-sec .pptx-target { visibility: visible !important; color: transparent !important; -webkit-text-fill-color: transparent !important; border-color: transparent !important; box-shadow: none !important; outline: none !important; }
    body.pptx-iso section.pptx-iso-sec .pptx-target * { visibility: hidden !important; }
    body.pptx-iso section.pptx-iso-sec.pptx-target { visibility: visible !important; }
  ` });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const clip = { x: box.x + it.x, y: box.y + it.y, width: Math.max(1, it.w), height: Math.max(1, it.h) };
  const buf = await page.screenshot({ type: 'png', omitBackground: true, clip });
  await page.evaluate(() => {
    document.querySelector('.pptx-target')?.classList.remove('pptx-target');
    document.body.classList.remove('pptx-iso', 'pptx-iso-mask', 'pptx-iso-bg');
    document.querySelector('.pptx-iso-sec')?.classList.remove('pptx-iso-sec');
    window.scrollTo(0, 0);
  });
  return buf;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const input = path.resolve(args.find((a, i) => !a.startsWith('-') && !['-o', '--pages'].includes(args[i - 1])) || 'slides.md');
  const output = path.resolve(opt('-o') || path.join(path.dirname(input), 'dist', `${path.basename(input, '.md')}.pptx`));
  let pages = null;
  if (opt('--pages')) { const [a, b] = opt('--pages').split('-').map(Number); pages = [a, b || a]; }
  await exportPptx(input, output, { pages, keepHtml: args.includes('--keep-html') });
}
