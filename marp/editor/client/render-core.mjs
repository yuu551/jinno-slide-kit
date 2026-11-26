import { Marp } from '@marp-team/marp-core';
import jinnoPlugin, { sourceMapPlugin } from '../../plugin.mjs';
import { installSlideCache } from './render-cache.mjs';
export function createEditorRenderer(themes) {
  const marp = new Marp({ html: true, inlineSVG: false, emoji: { shortcode: false, unicode: false }, math: false, minifyCSS: false, script: false });
  for (const css of themes) marp.themeSet.add(css);
  marp.use(jinnoPlugin).use(sourceMapPlugin);
  return { marp, cache: installSlideCache(marp) };
}
