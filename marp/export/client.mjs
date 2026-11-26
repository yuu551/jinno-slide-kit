import { invoke } from '@tauri-apps/api/core';
import { renderDocument } from './render.mjs';
import { outlinePositions, wrapHtml } from '../../.check/native-templates.mjs';
import { checkLayout, measureSvg, checkWriting, svgFindings } from '../shared/deck-check.mjs';
import phrases from '../scripts/phrases.json';
import { assemblePptx, walkItems } from '../pptx/assemble.mjs';
import '../pptx/extract.js';
const call = (name,args={}) => invoke('native_job',{name,args});
const progress = (page,total) => call('progress',{page,total});
const assetCache = new Map();
async function readAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`素材の読み込みに失敗しました (${response.status}): ${url}`);
  const blob = await response.blob();
  const reader = new FileReader();
  return new Promise((done, fail) => {
    reader.addEventListener('load', () => done(reader.result), { once: true });
    reader.addEventListener('error', () => fail(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

function dataUrl(url) {
  if (!assetCache.has(url)) {
    const pending = readAsset(url).catch(error => {
      assetCache.delete(url);
      throw error;
    });
    assetCache.set(url, pending);
  }
  return assetCache.get(url);
}

async function embeddedThemes(themes) {
  return Promise.all(themes.map(async css=>{
    const matches=[...css.matchAll(/url\("(\/theme-assets\/[^"\n]+)"\)/g)];
    for(const m of matches)css=css.replaceAll(m[0],`url("${await dataUrl(m[1])}")`);return css;
  }));
}
async function settle() {
  await document.fonts.ready;
  await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
  // 非表示のWKWebViewではrequestAnimationFrameを待たない。
  await new Promise(r=>setTimeout(r,0));
}
function mount(rendered) {
  const style=document.createElement('style');style.id='render-style';style.textContent=rendered.css+'\nhtml,body{margin:0;padding:0;background:#888}svg[data-marpit-svg]{display:block;width:1280px;height:720px;margin:0 0 8px}';document.head.append(style);
  document.body.innerHTML=rendered.html;
}
async function checkAll(input) {
  const issues=checkLayout({range:null}), writing=checkWriting(phrases);
  const images=[...document.querySelectorAll('section img')].map(i=>i.getAttribute('src'));
  const svgs=[...new Set(images.filter(s=>s.endsWith('.svg')))];
  const pages=new Map(svgs.map(src=>[src,[...document.querySelectorAll('section[id]')].map((s,i)=>s.querySelector(`img[src="${CSS.escape(src)}"]`)?i+1:0).filter(Boolean)]));
  const count=document.querySelectorAll('section[id]').length;
  const svgIssues=[];
  document.querySelector('#render-style').textContent='body{margin:0}body>svg{display:block}';
  for(const [i,src] of svgs.entries()) {
    const r=await fetch(src);if(!r.ok)continue;
    const svg=await r.text(); const vb=svg.match(/viewBox="([^"]+)"/)?.[1].split(/[ ,]+/).map(Number);if(!vb)continue;
    document.body.innerHTML=svg;
    const root=document.querySelector('body>svg');root.style.width=`${Math.ceil(vb[2])}px`;root.style.height=`${Math.ceil(vb[3])}px`;
    svgIssues.push(...svgFindings(measureSvg(),src,pages.get(src)));
    await progress(i+1,svgs.length);
  }
  const used=new Set(images.map(src=>new URL(src,document.baseURI).href));
  const orphan=input.figures.filter(f=>/\.(svg|png|jpe?g|webp)$/i.test(f)&&!used.has(new URL(f,document.baseURI).href))
    .map(f=>({page:0,type:'figure-orphan',level:'info',msg:`使われていない図: ${f}`}));
  const all=[...issues,...svgIssues,...writing,...orphan].sort((a,b)=>a.page-b.page);
  return {count,errors:all.filter(x=>x.level==='error').length,warnings:all.filter(x=>x.level==='warn').length,issues:all};
}
async function imageBytes(it) {
  let buf;
  if(it.data)buf=it.data;
  else if(it.src?.startsWith('data:')){
    const comma=it.src.indexOf(','),meta=it.src.slice(5,comma),body=it.src.slice(comma+1);
    buf=/;base64/i.test(meta)?Uint8Array.from(atob(body),c=>c.charCodeAt(0)):new TextEncoder().encode(decodeURIComponent(body));
  }
  else {
    try {const response=await fetch(it.src);if(!response.ok)return null;buf=new Uint8Array(await response.arrayBuffer());}
    catch{return null;}
  }
  let ext=buf[0]===0x89&&buf[1]===0x50?'png':buf[0]===0xff&&buf[1]===0xd8?'jpeg':String.fromCharCode(...buf.subarray(0,3))==='GIF'?'gif':null;
  if(!ext){
    const url=URL.createObjectURL(new Blob([buf]));
    try{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth||1;canvas.height=image.naturalHeight||1;canvas.getContext('2d').drawImage(image,0,0);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));buf=new Uint8Array(await blob.arrayBuffer());ext='png';}
    finally{URL.revokeObjectURL(url);}
  }
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-1',buf))].map(v=>v.toString(16).padStart(2,'0')).join('');
  return {buf,ext,hash};
}
async function pptx(input,rendered) {
  window.__pptxWaitFrame=()=>new Promise(r=>setTimeout(r,0));
  // WebKit の Range は SVG text の y / dy を落とす。SVG の文字座標を画面座標へ直す。
  window.__pptxCharacterRect=(node,offset)=>{
    if(!(node.parentElement instanceof SVGElement))return null;
    const host=node.parentElement.closest('text');if(!host||!(host instanceof SVGTextElement))return null;
    const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);let index=0;
    while(walker.nextNode()&&walker.currentNode!==node)index+=[...walker.currentNode.textContent].length;
    index+=[...node.textContent.slice(0,offset)].length;
    if(index>=host.getNumberOfChars())return null;
    const r=host.getExtentOfChar(index),m=host.getScreenCTM();if(!m)return null;
    const points=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(m));
    const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));
    const start=host.getStartPositionOfChar(index),baseline=new DOMPoint(start.x,start.y).matrixTransform(m).y;
    return Object.assign(new DOMRect(x,y,Math.max(...points.map(p=>p.x))-x,Math.max(...points.map(p=>p.y))-y),{baseline});
  };
  window.pptxReadText=async url=>{try{const r=await fetch(url);return r.ok?await r.text():'';}catch{return '';}};
  const count=document.querySelectorAll('section[id]').length;
  const scenes=await window.__pptxExtract([...Array(count).keys()]);
  if(input.debug)await call('trace',{scenes});
  const style=document.createElement('style');style.textContent=`
body.pptx-iso,html:has(body.pptx-iso){background:transparent!important}
body.pptx-iso section.pptx-iso-sec{background:transparent!important}
body.pptx-iso section.pptx-iso-sec *{visibility:hidden!important}
body.pptx-iso section.pptx-iso-sec .pptx-target{visibility:visible!important;color:transparent!important;-webkit-text-fill-color:transparent!important;border-color:transparent!important;box-shadow:none!important;outline:none!important}
body.pptx-iso section.pptx-iso-sec .pptx-target *{visibility:hidden!important}
body.pptx-iso section.pptx-iso-sec.pptx-target{visibility:visible!important}`;document.head.append(style);
  for(const sc of scenes) {
    for(const it of walkItems(sc.items))if(it.k==='raster'){
      const sec=document.querySelectorAll('section[id]')[sc.index];
      const el=sec.querySelector(`[data-pptx-raster~="${it.id}"]`)||(sec.dataset.pptxRaster?.split(' ').includes(it.id)?sec:null);
      if(!el){it.k='skip';continue;}
      el.classList.add('pptx-target');sec.classList.add('pptx-iso-sec');document.body.classList.add('pptx-iso',el.dataset[`pptxRaster${it.id}`]==='mask'?'pptx-iso-mask':'pptx-iso-bg');sec.scrollIntoView();
      await new Promise(r=>setTimeout(r,0));
      const r=sec.getBoundingClientRect();
      const data=new Uint8Array(await invoke('native_snapshot',{rect:[r.x+it.x,r.y+it.y,Math.max(1,it.w),Math.max(1,it.h)]}));
      Object.assign(it,{k:'image',data,crop:null,rot:0});
      el.classList.remove('pptx-target');sec.classList.remove('pptx-iso-sec');document.body.classList.remove('pptx-iso','pptx-iso-mask','pptx-iso-bg');window.scrollTo(0,0);
    }
    await progress(sc.index+1,count);
  }
  return assemblePptx(input.text,rendered.comments,scenes,imageBytes);
}
try {
  const input=await call('input');
  const themes=await embeddedThemes(input.themes);
  const rendered=renderDocument(input.text,themes,input.format==='html'?'bespoke':'measure');
  if(input.format==='html')await invoke('native_job_bytes',new TextEncoder().encode(rendered.document));
  else {
    mount(rendered);await settle();
    if(input.format==='check') await call('finish',await checkAll(input));
    else if(input.format==='pptx') await invoke('native_job_bytes',await pptx(input,rendered));
    else {
      const pages=[...document.querySelectorAll('svg[data-marpit-svg]')];
      const positions=outlinePositions(rendered.outline.flatMap(p=>p.headings),'data-marp-cli-pdf-outline');
      const metadata={title:rendered.title,author:rendered.author,comments:rendered.comments,outline:rendered.outline.map(p=>({...p,headings:p.headings.map(h=>({...h,title:positions[h.key]?.[2]||'',point:positions[h.key]?.slice(0,2)}))}))};
      if(input.format!=='pdf-chrome')metadata.links=pages.flatMap((page,i)=>{
        const origin=page.getBoundingClientRect();
        return [...page.querySelectorAll('a[href]')].flatMap(a=>{
          const raw=a.getAttribute('href');if(!/^(https?:|mailto:)/i.test(raw))return [];
          const url=new URL(raw,document.baseURI).href;
          return [...a.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({page:i+1,url,rect:[(r.left-origin.left)*.75,(origin.bottom-r.bottom)*.75,(r.right-origin.left)*.75,(origin.bottom-r.top)*.75]}));
        });
      });
      if(input.format==='pdf-chrome')await call('finish',{metadata,html:wrapHtml(rendered,'bare')});
      else {
      for(const [i,page]of pages.entries()){
        const r=page.getBoundingClientRect();
        await call('pdfPage',{rect:[r.left+scrollX,r.top+scrollY,r.width,r.height]});await progress(i+1,pages.length);
      }
      await call('finish',metadata);
      }
    }
  }
} catch(e) { await call('error',{message:String(e?.stack||e)}); }
