// Compare every slide and its CSS with the unmodified renderer after edits that cross page boundaries.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Marp } from '@marp-team/marp-core';
import plugin, { sourceMapPlugin } from '../../marp/plugin.mjs';
import { installSlideCache } from '../../marp/editor/client/render-cache.mjs';
const root = process.cwd(), work = await fs.mkdtemp(path.join(os.tmpdir(), 'marp-render-cache-'));
const themes = await Promise.all((await fs.readdir('marp/themes')).filter(n => n.endsWith('.css')).map(n => fs.readFile('marp/themes/' + n, 'utf8')));
function make() {
  const marp = new Marp({ html: true, inlineSVG: false, emoji: { shortcode: false, unicode: false }, math: false, minifyCSS: false, script: false });
  themes.forEach(css => marp.themeSet.add(css));
  return marp.use(plugin).use(sourceMapPlugin);
}
function normalized(result) {
  const raw = JSON.stringify({ html: result.html, css: result.css });
  const ids = [...new Set([...raw.matchAll(/data-marpit-scope-([\w-]+)/g)].map(m => m[1]))];
  if (!ids.length) return raw;
  // Preserve the one-to-one mapping between each HTML scope and CSS/keyframe references.
  return raw.replace(/data-marpit-scope-([\w-]+)/g, (_, id) => 'data-marpit-scope-' + ids.indexOf(id))
    .replace(new RegExp('-(' + ids.join('|') + ')(?![\\w-])', 'g'), (_, id) => '-' + ids.indexOf(id));
}
const mutations = [
  ['元の資料', s => s],
  ['見出し', s => s.replace(/\n# /, '\n# 追記 ')],
  ['テーマ', s => s.replace(/theme: .+/, 'theme: default')],
  ['行の追加', s => s.replace(/\n# /, '\n\n\n# ')],
  ['人物の写真', s => s + '\n\n<!-- photos: [私=figs/changed.png] -->\n'],
  ['資料全体の参照', s => s + '\n\n---\n\n[リンク][ref]\n\n[ref]: https://example.com/changed\n'],
  ['アニメーション', s => s + '\n\n<style scoped>\n@keyframes move { to { transform: translateX(1px) } }\nh1 { animation: move 1s; }\n</style>\n'],
  ['空のページ', s => s + '\n\n---\n'],
  ['章', s => s + '\n\n<!-- chapters: [A,B,C] -->\n<!-- chapter: B -->\n'],
  ['改ページを含むコード', s => s + '\n\n```markdown\n---\n# コード内の見出し\n```\n'],
  ['発表者ノート', s => s + '\n\n<!-- 発表者ノートを追記 -->\n'],
  ['ページ番号', s => s.replace(/paginate: true/, 'paginate: false')],
];
const inputs = ['marp/templates/talk', 'marp/templates/update'];
let passed = 0, total = 0;
try {
  for (const [index, rel] of inputs.entries()) {
    const file = path.join(work, index + '.md');
    await fs.copyFile(path.join(root, rel, 'slides.md'), file);
    const text = await fs.readFile(file, 'utf8'), cached = make(), full = make(), cache = installSlideCache(cached);
    for (const [label, edit] of mutations) {
      total++;
      const input = edit(text), result = cached.render(input, { htmlAsArray: true });
      const expected = full.render(input);
      if (!expected.html.startsWith('<div class="marpit">')) throw Error('元の描画の外枠が変わりました');
      expected.html = expected.html.replace(/^<div class="marpit">\n?/, '').replace(/<\/div>\n?$/, '');
      if (normalized({ ...result, html: result.html.join('') }) !== normalized(expected)) throw Error(`${rel}: ${label}で HTML / CSS が変わりました`);
      if (label === '見出し' && (cache.stats.rendered !== 1 || cache.stats.reused !== result.html.length - 1)) throw Error(`${rel}: 変更していないページを描き直しました ${JSON.stringify(cache.stats)}`);
      passed++;
    }
    console.log(`✓ ${rel}: ${mutations.length}通り、すべてのページの HTML と CSS が一致`);
  }
} finally { await fs.rm(work, { recursive: true, force: true }); }
console.log(`${passed}/${total} 通過`);
