// 環境に依らない PowerPoint の組み立て。測定と画像読み込みは呼び出し元が渡す。
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { slideXml } from './ooxml.mjs';

export async function assemblePptx(md, comments, scenes, imageBytes, outputType = 'uint8array') {
    // 骨組み
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    const title = md.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1]?.replace(/<br\s*\/?>/g, ' ');
    const author = md.match(/^author:\s*"?(.+?)"?\s*$/m)?.[1];
    if (title) pptx.title = title;
    if (author) pptx.author = author;
    pptx.theme = { headFontFace: 'Noto Sans JP', bodyFontFace: 'Noto Sans JP' };
    for (const sc of scenes) {
      const s = pptx.addSlide();
      const note = (comments[sc.index] || []).filter((c) => !/^\s*(型:|edited-in-editor)/.test(c)).join('\n\n').trim();
      if (note) s.addNotes(note);
    }
    const zip = await JSZip.loadAsync(await pptx.write({ outputType, compression: 'DEFLATE' }));

    // 中身を差し替える
    const media = new Map(); // hash → name
    let mediaSeq = 0;
    const types = await zip.file('[Content_Types].xml').async('string');
    const needExt = new Set();
    for (const [k, sc] of scenes.entries()) {
      const no = k + 1;
      const relsPath = `ppt/slides/_rels/slide${no}.xml.rels`;
      let rels = await zip.file(relsPath).async('string');
      let rid = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
      const add = [];
      const relFor = new Map();
      let shapeId = 1;
      const ctx = {
        id: () => ++shapeId,
        link: (url) => {
          const key = `L${url}`;
          if (!relFor.has(key)) { const r = `rId${++rid}`; relFor.set(key, r); add.push(`<Relationship Id="${r}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" TargetMode="External"/>`); }
          return relFor.get(key);
        },
        media: (it) => {
          const img = it._bytes;
          if (!img) return null;
          const hash = img.hash;
          if (!media.has(hash)) { const name = `image-x${++mediaSeq}.${img.ext}`; media.set(hash, name); zip.file(`ppt/media/${name}`, img.buf); needExt.add(img.ext); }
          const key = `M${hash}`;
          if (!relFor.has(key)) { const r = `rId${++rid}`; relFor.set(key, r); add.push(`<Relationship Id="${r}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${media.get(hash)}"/>`); }
          return relFor.get(key);
        },
      };
      for (const it of walkItems(sc.items)) if (it.k === 'image') it._bytes = await imageBytes(it);
      const xml = slideXml(sc, ctx);
      // 壊れた数値が残っていれば、PowerPoint が修復を求める前にここで止める
      const bad = xml.match(/="[^"]*(NaN|Infinity|undefined)[^"]*"/);
      if (bad) throw new Error(`スライド ${no} に不正な値があります: ${bad[0]}`);
      zip.file(`ppt/slides/slide${no}.xml`, xml);
      if (add.length) rels = rels.replace('</Relationships>', `${add.join('')}</Relationships>`);
      zip.file(relsPath, rels);
    }
    // PowerPoint はリンクの文字をテーマのリンク色で塗るので、テーマのリンク色を資料のリンクの色にする
    const linkColors = new Map();
    for (const sc of scenes) for (const it of walkItems(sc.items)) for (const p of [...(it.paras || []), ...(it.text?.paras || []), ...(it.grid || []).flat().flatMap((c) => c?.paras || [])]) for (const l of p.lines) for (const r of l.runs) if (r.style.href) linkColors.set(r.style.color, (linkColors.get(r.style.color) || 0) + r.text.length);
    if (linkColors.size) {
      const col = [...linkColors].sort((a, b) => b[1] - a[1])[0][0].toUpperCase();
      for (const f of Object.keys(zip.files).filter((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n))) {
        const x = await zip.file(f).async('string');
        zip.file(f, x.replace(/<a:hlink>.*?<\/a:hlink>/s, `<a:hlink><a:srgbClr val="${col}"/></a:hlink>`).replace(/<a:folHlink>.*?<\/a:folHlink>/s, `<a:folHlink><a:srgbClr val="${col}"/></a:folHlink>`));
      }
    }
    let ct = types;
    const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };
    for (const ext of needExt) if (!new RegExp(`Extension="${ext}"`, 'i').test(ct)) ct = ct.replace('<Default ', `<Default Extension="${ext}" ContentType="${MIME[ext]}"/><Default `);
    zip.file('[Content_Types].xml', ct);
    const buf = await zip.generateAsync({ type: outputType, compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return buf;
}

export function* walkItems(list) {
  for (const it of list) { yield it; if (it.k === 'group') yield* walkItems(it.items); }
}
export function summarize(scenes) {
  const s = { shape: 0, text: 0, table: 0, image: 0, raster: 0 };
  for (const sc of scenes) for (const it of walkItems(sc.items)) {
    if (it.k === 'shape') { s.shape++; if (it.text) s.text++; }
    else if (it.k === 'text') s.text++;
    else if (it.k === 'table') s.table++;
    else if (it.k === 'image') { s.image++; if (it.data) s.raster++; }
  }
  return s;
}
