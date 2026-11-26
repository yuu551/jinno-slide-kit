// 固定した marp-cli の HTML テンプレートとブラウザで動くプラグインだけを取り出す。
// CLI 本体や node_modules は変更しない。内部名が変わる更新はここで止め、比較してから対応する。
import fs from 'node:fs/promises';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function prepareExportTemplates() {
  const dir = await fs.realpath(path.join(root, 'node_modules/@marp-team/marp-cli'));
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.version !== '4.5.1') throw Error('marp-cli の版が変わりました。HTML の出力を比較してテンプレートの取り出しを更新してください。');
  const file = path.join(dir, 'lib', (await fs.readdir(path.join(dir, 'lib'))).find(n => /^marp-cli-.*\.js$/.test(n)));
  const source = await fs.readFile(file, 'utf8');
  const mod = new Module(file); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(source + `\nexports.nativeParts={templates:Qs,pugBespoke:Vs,pugBare:qs,runtime:Zs,meta:hi,info:li,transition:wi,keywords:pi,validTransition:bi,transitions:Fi,transitionPattern:vi,outline:Di,positions:mi};
    const originalBespoke=Vs, originalBare=qs;
    Vs=e=>{exports.bespokeLocals=e;return originalBespoke(e)};
    qs=e=>{exports.bareLocals=e;return originalBare(e)};`, file);
  const p = mod.exports.nativeParts;
  const empty = {html:'',css:'',comments:[],length:0,size:{width:1280,height:720}};
  await p.templates.bespoke({renderer:()=>empty});
  await p.templates.bare({renderer:()=>empty});
  const content = `// Generated from @marp-team/marp-cli ${pkg.version} (MIT). Do not edit.\n
const i=/["&<>]/;
const o=${p.runtime.escape.toString()};
const Zs={escape:o,attr:${p.runtime.attr.toString()}};
const ci=Symbol('metadata'), yi=Symbol('transition'), di=Symbol('outline'), fi='data-marp-cli-pdf-outline';
const h={URL}, tn=()=>{}, Yr=()=>{};
const pi=${p.keywords.toString()}, bi=${p.validTransition.toString()};
const Fi=${JSON.stringify(p.transitions)}, vi=${p.transitionPattern};
${p.meta.toString()}
${p.info.toString()}
${p.transition.toString()}
${p.outline.toString()}
export const outlinePositions=${p.positions.toString()};
${p.pugBespoke.toString()}
${p.pugBare.toString()}
const bespokeParts=${JSON.stringify(mod.exports.bespokeLocals.bespoke)};
const bareParts=${JSON.stringify(mod.exports.bareLocals.bare)};
export function configureCli(marp, template) { marp.use(hi).use(li); if(template==='bespoke')marp.use(wi); if(template==='measure')marp.use(Di); return marp; }
export function renderedMeta(marp) { return {...marp[ci],transition:marp[yi],outline:marp[di]}; }
export function wrapHtml(rendered,template='bespoke') {
 const data={author:undefined,base:undefined,description:undefined,image:undefined,keywords:undefined,title:undefined,url:undefined,watchJs:undefined,...rendered};
 return template==='bare' ? qs({...data,bare:bareParts}) : Vs({...data,bespoke:{...bespokeParts,transitionStyle:rendered.transition?.builtinTransitionStyle}});
}
`;
  await fs.mkdir(path.join(root, '.check'), {recursive:true});
  await fs.writeFile(path.join(root, '.check/native-templates.mjs'),content);
  return path.join(root, '.check/native-templates.mjs');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareExportTemplates();
