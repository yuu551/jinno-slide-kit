// CLI と同じテーマ・部品を、Node の機能を使わずに描く。
import { Marp } from '@marp-team/marp-core';
import jinnoPlugin from '../plugin.mjs';
import { configureCli, renderedMeta, wrapHtml } from '../../.check/native-templates.mjs';
export function renderDocument(text, themes, template = 'measure') {
  const marp = new Marp({html:true,lang:'ja-JP',emoji:{shortcode:false,unicode:false},math:false,minifyCSS:false,
    ...(template === 'measure' ? {script:false} : {}),
    container: template === 'bespoke' ? {tag:'div',id:':$p'} : [], inlineSVG:true,slideContainer:[]});
  for (const css of [...themes].sort((a,b)=>Number(a.includes('@import'))-Number(b.includes('@import'))))marp.themeSet.add(css);
  marp.use(jinnoPlugin);
  configureCli(marp,template);
  const result=marp.render(text.replace(/^\uFEFF/,''));
  const rendered={...result,...renderedMeta(marp)};
  return {...rendered, document: template==='measure' ? `<!doctype html><html><head><meta charset="utf-8"><style>${result.css}
html,body{margin:0;padding:0;background:#888}
svg[data-marpit-svg]{display:block;width:1280px;height:720px;margin:0 0 8px}
</style></head><body>${result.html}</body></html>` : wrapHtml(rendered,template)};
}
