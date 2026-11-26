// 検査・撮影用に、全スライドを縦に並べた1枚のHTMLを作る（marp-coreを直接使うので速い）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { Marp } from '@marp-team/marp-core';
import engine from '../engine.mjs';

export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function createMarp() {
  const marp = new Marp({ html: true, emoji: { shortcode: false, unicode: false }, math: false, minifyCSS: false, script: false });
  return engine({ marp });
}

export async function renderDeck(input, outDir) {
  const md = await fs.readFile(input, 'utf8');
  const { html, css, comments } = createMarp().render(md);
  // 画像の相対パスをMarkdownの場所から解決できるよう、HTMLはMarkdownと同じフォルダに置く
  const htmlPath = path.join(path.dirname(input), `.render-${path.basename(input, '.md')}.html`);
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;padding:0;background:#888}
svg[data-marpit-svg]{display:block;width:1280px;height:720px;margin:0 0 8px}
</style></head><body>${html}</body></html>`;
  await fs.writeFile(htmlPath, page);
  const count = (html.match(/<svg data-marpit-svg/g) || []).length;
  return { htmlPath, count, comments };
}
