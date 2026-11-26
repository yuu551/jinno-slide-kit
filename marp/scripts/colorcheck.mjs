// 描画したデッキで、真っ黒に近い太字と線（上の線・罫線）を洗い出す。
// usage: node marp/scripts/colorcheck.mjs <slides.md>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { renderDeck, CHROME } from './render-lib.mjs';

const input = path.resolve(process.argv[2]);
const out = path.join(path.dirname(input), '.check');
const { htmlPath } = await renderDeck(input, out);
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(pathToFileURL(htmlPath).href);
await page.evaluate(() => document.fonts.ready);
const rows = await page.evaluate(() => {
  const dark = (c) => {
    const m = c.match(/rgba?\((\d+), (\d+), (\d+)/);
    return m && Math.max(+m[1], +m[2], +m[3]) < 0x34;  // #3a3f44 より暗いもの
  };
  const res = [];
  document.querySelectorAll('section').forEach((sec, i) => {
    const seen = new Set();
    sec.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const label = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''}`;
      if (own && +cs.fontWeight >= 600 && dark(cs.color)) {
        const k = `text ${label}`;
        if (!seen.has(k)) { seen.add(k); res.push(`P.${i + 1}  太字  ${label}  「${el.textContent.trim().slice(0, 16)}」 ${cs.color}`); }
      }
      for (const side of ['Top', 'Bottom', 'Left']) {
        const w = parseFloat(cs[`border${side}Width`]);
        if (w >= 1 && cs[`border${side}Style`] !== 'none' && dark(cs[`border${side}Color`])) {
          const k = `line ${side} ${label}`;
          if (!seen.has(k)) { seen.add(k); res.push(`P.${i + 1}  線(${side} ${w}px)  ${label}  ${cs[`border${side}Color`]}`); }
        }
      }
    });
  });
  return res;
});
console.log(rows.join('\n') || '真っ黒の太字・線はありません');
await browser.close();
