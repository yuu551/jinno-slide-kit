// marp-cli 用のエンジン。テーマを読み込み、画像・フォントをdata URIへ埋め込んでから登録する。
// これで出力したHTML/PDFは、置き場所に関係なく単体で表示できる。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jinnoPlugin from './plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export function loadThemes(dir = path.join(here, 'themes')) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.css')).sort().map((f) =>
    fs.readFileSync(path.join(dir, f), 'utf8').replace(/url\("assets\/([^"]+)"\)/g, (_, name) => {
      const file = path.join(dir, 'assets', name);
      return `url("data:${MIME[path.extname(name)]};base64,${fs.readFileSync(file).toString('base64')}")`;
    }));
}

const themes = loadThemes();

export default ({ marp }) => {
  // 他のテーマを参照する CSS は最後に登録する
  for (const css of themes.sort((a, b) => (a.includes('@import') ? 1 : 0) - (b.includes('@import') ? 1 : 0))) marp.themeSet.add(css);
  return marp.use(jinnoPlugin);
};
