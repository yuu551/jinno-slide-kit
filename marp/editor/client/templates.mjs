import { readSlideMeta } from './markdown.mjs';
import { CHEATSHEET, pageOf } from '../../cheatsheet.mjs';

// エディターで表紙・裏表紙の見本を開くときは、今の資料の挿絵と署名を使う。
export function jacketForDeck(example, firstPage = '') {
  const { classes } = readSlideMeta(firstPage.split('\n'));
  const mode = classes.find(c => c === 'stage' || c === 'classic');
  const content = firstPage.replace(/<!--[\s\S]*?-->/g, '');
  const image = classes.includes('cover-talk') && content.match(/^!\[[^\n]*?\]\(.+\)\s*$/m)?.[0].trim();
  const kicker = content.match(/<p class="kicker">[\s\S]*?<\/p>/)?.[0];
  const author = content.match(/<p class="who">[\s\S]*?<\/p>/)?.[0];
  return example
    .replace(/(<!-- _class: [^>]*?) -->/, (_, directive) => directive + (mode ? ' ' + mode : '') + ' -->')
    .replace(/<p class="kicker">.*?<\/p>/, original => kicker || original)
    .replace(/<p class="who">.*?<\/p>/, original => author || original)
    .replace('![](figs/cover-art.svg)', () => image || '').trimEnd();
}

const ids = ['figure', 'dialogue', 'speech', 'band', 'table', 'code', 'purpose', 'agenda',
  'divider', 'closing', 'scene', 'flow', 'compare', 'profile', 'links', 'prose'];
export const TEMPLATES = ids.map(id => {
  const item = CHEATSHEET.find(entry => entry.id === id);
  const needsFigure = id === 'figure';
  return {
    id, label: item.name, needsFigure,
    body(figure, firstPage) {
      if (needsFigure) return '# 図のタイトル\n\n図の読み方を書きます。\n\n![h:360](' + figure + ')';
      return id === 'closing' ? jacketForDeck(pageOf(item), firstPage) : pageOf(item);
    },
  };
});
