// 描画したデッキで、実際に使われているフォントを確かめる。
// usage: node marp/scripts/fontcheck.mjs <slides.md>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { renderDeck, CHROME } from './render-lib.mjs';

const input = path.resolve(process.argv[2]);
const out = path.join(path.dirname(input), '.check');
const { htmlPath } = await renderDeck(input, out);
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await page.goto(pathToFileURL(htmlPath).href);
await page.evaluate(() => document.fonts.ready);
const faces = await page.evaluate(() => [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`));
console.log('@font-face:', faces.join(' / '));
await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
for (const sel of ['section > h1', 'section > p.lead', 'section li', 'section td', 'section th']) {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel }).catch(() => ({ nodeId: 0 }));
  if (!nodeId) continue;
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  console.log(sel.padEnd(18), fonts.map((f) => `${f.familyName}${f.isCustomFont ? '（Webフォント）' : '（端末のフォント）'} ×${f.glyphCount}`).join(', '));
}
await browser.close();
