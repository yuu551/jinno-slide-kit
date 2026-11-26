// SVG-Edit で形を直した図を、元のSVGになるべく近い形で書き出すための下ごしらえと後処理。
//
// SVG-Edit は読み込みの時点で図を書き換える（許可リスト外の属性を消す・style を属性に展開する・
// path の d を絶対座標に直す・入れ子の svg の id を振り直す・文字の前後の空白を削る・レイヤーの g で包む…）。
// そのため SVG-Edit の書き出し（getSvgString）は使わず、次の手順で自前に書き出す。
//
//   1. prepare()  : 元のSVGの各要素に番号（data-mj）を振ってから SVG-Edit に渡す
//   2. snapshot() : 読み込み直後のキャンバス（ライブDOM）の属性・文字を控える
//   3. serialize(): 保存時のライブDOMと控えを比べ、
//                   ・変わっていない属性/文字 → 元のSVGの値をそのまま書く
//                   ・変わった/増えた属性     → SVG-Edit の値を書く（SVG-Edit固有のものは落とす）
//                   ・子の並びが変わっていない → 元の並び（空白・コメント込み）のまま書く
//                   ・ルートの <svg> の属性（viewBox・width・height・role…）は常に元のまま
//
// こうすると、何も変えずに保存した図は元とほぼ同じ文字列になり、動かした要素だけが差分になる。

const SVGNS = 'http://www.w3.org/2000/svg';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const SENS = 'http://svg-edit.googlecode.com';
export const MARK_RE = /^\s*edited-in-editor:/;

// 入れ子の <svg> に付いていると SVG-Edit の許可リストで消されるが、描画に効く（子へ継承される）属性。
// 読み込み前に外側の <g> へ移しておき、キャンバス上の見た目を保つ（保存時は元の <svg> に戻す）
const INHERITED_ON_SVG = ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'opacity', 'fill-opacity', 'stroke-opacity'];

const elements = (root) => [root, ...root.querySelectorAll('*')];
const attrsOf = (el) => { const o = {}; for (const a of el.attributes) o[a.name] = a.value; return o; };
const isWs = (n) => n.nodeType === 3 && !n.nodeValue.trim();
const isMarkComment = (n) => n.nodeType === 8 && MARK_RE.test(n.data);

/** 元のSVG文字列から、SVG-Edit に渡す文字列と、元の要素の一覧を作る */
export function prepare(text) {
  const parse = () => new DOMParser().parseFromString(text, 'image/svg+xml');
  const orig = parse();
  if (orig.querySelector('parsererror') || orig.documentElement.namespaceURI !== SVGNS) throw new Error('SVGとして読めませんでした');
  const work = parse();
  const origEls = elements(orig.documentElement);
  elements(work.documentElement).forEach((el, k) => el.setAttribute('data-mj', String(k)));
  for (const svg of work.documentElement.querySelectorAll('svg')) {
    const keep = INHERITED_ON_SVG.filter((a) => svg.hasAttribute(a));
    if (!keep.length || svg.closest('defs')) continue;
    const g = work.createElementNS(SVGNS, 'g');
    g.setAttribute('data-mj-wrap', '1');
    for (const a of keep) g.setAttribute(a, svg.getAttribute(a));
    svg.replaceWith(g);
    g.appendChild(svg);
  }
  const indexOf = new Map(origEls.map((el, k) => [el, k]));
  return { text, orig, origEls, indexOf, loadText: new XMLSerializer().serializeToString(work) };
}

/** 読み込み直後のキャンバス（SVG-Edit の #svgcontent）を控える */
export function snapshot(content, prep) {
  const map = new Map(); // live element -> { k, attrs, texts, kids }
  const wrappers = new Map(); // live element -> { kind, attrs }
  for (const el of elements(content)) {
    if (el === content) continue;
    const k = el.getAttribute('data-mj');
    if (k != null) {
      el.removeAttribute('data-mj');
      map.set(el, { k: Number(k) });
    } else if (el.hasAttribute('data-mj-wrap')) {
      el.removeAttribute('data-mj-wrap');
      wrappers.set(el, { kind: 'wrap' });
    } else if (el.localName === 'g' && el.classList.contains('layer')) {
      wrappers.set(el, { kind: 'layer' });
    } else if (el.localName === 'title' && el.parentNode?.classList?.contains('layer')) {
      wrappers.set(el, { kind: 'layer-title' });
    } else if (el.localName === 'g' && el.children.length === 1 && el.firstElementChild.localName === 'svg') {
      wrappers.set(el, { kind: 'gsvg' }); // SVG-Edit が入れ子の svg を包んだ g
    }
  }
  for (const [el, info] of [...map, ...wrappers]) {
    info.attrs = attrsOf(el);
    info.texts = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue);
  }
  const state = { prep, map, wrappers, root: content };
  for (const [el, info] of map) info.kids = effectiveKids(el, state);
  state.rootKids = effectiveKids(content, state);
  return state;
}

// SVG-Edit が足した包み（レイヤー・入れ子svgの g）のうち、変わっていないものを開いた子の並び
function effectiveKids(el, state) {
  const out = [];
  for (const n of el.childNodes) {
    const w = n.nodeType === 1 && state.wrappers.get(n);
    if (w) {
      if (w.kind === 'layer-title') continue;
      if (w.kind === 'layer' || pristine(n, w)) { out.push(...effectiveKids(n, state)); continue; }
    }
    if (n.nodeType === 3 && !n.nodeValue.trim()) continue;
    out.push(n);
  }
  return out;
}

// id 以外の属性が読み込み直後から変わっていないか
function pristine(el, info) {
  if (!info.attrs) return true;
  const now = attrsOf(el);
  const keys = new Set([...Object.keys(now), ...Object.keys(info.attrs)]);
  keys.delete('id');
  for (const key of keys) if (now[key] !== info.attrs[key]) return false;
  return true;
}

// SVG-Edit が内部用に付ける属性
const seAttr = (a) => a.namespaceURI === SENS || a.name.startsWith('se:') || a.name === 'se_type' || a.name.startsWith('data-mj')
  || a.name.startsWith('xmlns:se') || (a.name === 'class' && /^se_/.test(a.value)) || (a.name === 'style' && /^\s*pointer-events\s*:[^;]*;?\s*$/.test(a.value));

const parseStyle = (s) => s.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const i = d.indexOf(':');
  return [d.slice(0, i).trim(), d.slice(i + 1).trim(), d];
});

/** ライブDOMから保存用のSVG文字列を作る */
export function serialize(state, { mark } = {}) {
  const { prep, map, wrappers, root } = state;
  const { orig, origEls } = prep;
  const out = document.implementation.createDocument(SVGNS, 'svg', null);
  const idMap = new Map(); // SVG-Edit が振り直した id -> 元の id
  const used = new Set(); // 1つの元要素を2回以上「元のまま」扱いしない（複製した要素のため）
  const origOf = (el) => { const info = map.get(el); return info && !used.has(info.k) ? info : null; };

  // 元の <svg> をそのまま使う（属性の並びも元のまま）
  const oroot = orig.documentElement;
  const svg = out.documentElement;
  for (const a of oroot.attributes) svg.setAttributeNS(a.namespaceURI, a.name, a.value);

  const copyText = (value) => out.createTextNode(value);

  function attrsFor(el, info, target) {
    const o = origEls[info.k];
    const snap = info.attrs;
    const live = attrsOf(el);
    const changedFromSnap = (name) => name in snap && live[name] !== snap[name];
    for (const a of o.attributes) {
      const name = a.name;
      if (name === 'style') {
        // 読み込みで属性に展開された宣言のうち、編集で変わったものだけ style から外す
        const all = parseStyle(a.value);
        const kept = all.filter(([prop]) => !(prop in snap && (live[prop] === undefined || changedFromSnap(prop))));
        const liveStyleChanged = live.style !== undefined && live.style !== snap.style && !/^\s*pointer-events\s*:[^;]*;?\s*$/.test(live.style);
        if (kept.length === all.length && !liveStyleChanged) { target.push(['style', a.value, null]); continue; }
        if (live.style !== undefined && live.style !== snap.style && !/^\s*pointer-events\s*:[^;]*;?\s*$/.test(live.style)) {
          const props = new Set(parseStyle(live.style).map((d) => d[0]));
          kept.splice(0, kept.length, ...kept.filter(([prop]) => !props.has(prop)), ...parseStyle(live.style));
        }
        if (kept.length) target.push(['style', kept.map((d) => d[2]).join('; '), null]);
        continue;
      }
      if (!(name in snap)) {
        // 読み込みで消された属性（role・pointer-events・xlink:href など）は戻す
        const liveVal = el.getAttributeNS(a.namespaceURI, a.localName);
        target.push([name, liveVal == null ? a.value : liveVal, a.namespaceURI]);
        continue;
      }
      if (live[name] === undefined) continue; // 編集で消えた（例: 移動で transform が座標に畳まれた）
      if (live[name] === snap[name]) {
        if (name === 'id' && live.id !== a.value) idMap.set(live.id, a.value);
        target.push([name, a.value, a.namespaceURI]);
      } else target.push([name, live[name], a.namespaceURI]);
    }
    for (const b of el.attributes) {
      if (o.hasAttribute(b.name) || seAttr(b)) continue;
      if (b.name === 'style' && o.hasAttribute('style')) continue;
      if (b.name in snap && b.value === snap[b.name]) continue; // 読み込みで足されたもの（style の展開・自動の id）
      target.push([b.name, b.value, b.namespaceURI]);
    }
  }

  function newAttrs(el, target) {
    for (const b of el.attributes) if (!seAttr(b)) target.push([b.name, b.value, b.namespaceURI]);
  }

  // 要素を1つ書く（戻り値は出力側のノードの配列。開いた包みは複数になる）
  function emit(n) {
    if (n.nodeType === 3) return [copyText(n.nodeValue)];
    if (n.nodeType === 8) return isMarkComment(n) ? [] : [out.createComment(n.data)];
    if (n.nodeType !== 1) return [];
    const w = wrappers.get(n);
    if (w && (w.kind === 'layer-title')) return [];
    if (w && (w.kind === 'layer' || pristine(n, w))) return emitKids(effectiveKids(n, state));
    const info = origOf(n);
    const attrs = [];
    let el;
    if (info) {
      used.add(info.k);
      const o = origEls[info.k];
      el = out.createElementNS(o.namespaceURI, o.tagName);
      attrsFor(n, info, attrs);
    } else {
      el = out.createElementNS(n.namespaceURI, n.tagName);
      if (w) { // 動かした入れ子svgの包み: SVG-Edit が付けた id と、自分で移した継承属性は落とす
        for (const b of n.attributes) {
          if (seAttr(b) || b.name === 'id') continue;
          if (w.attrs && b.name in w.attrs && w.attrs[b.name] === b.value && b.name !== 'transform') continue;
          attrs.push([b.name, b.value, b.namespaceURI]);
        }
      } else newAttrs(n, attrs);
    }
    for (const [name, value, ns] of attrs) el.setAttributeNS(ns || null, name, value);
    for (const c of info ? kidsFor(n, info) : emitKids(effectiveKids(n, state))) el.appendChild(c);
    return [el];
  }

  const emitKids = (kids) => kids.flatMap((c) => emit(c));

  // 子の並びが読み込み直後と同じなら、元の並び（空白・コメント・文字）で書く
  function kidsFor(el, info) {
    const o = origEls[info.k];
    const now = effectiveKids(el, state);
    return sameStructure(now, info.kids, info, el) ? origOrder(o, now, info, el) : emitKids(now);
  }

  function sameStructure(now, then, info, el) {
    const liveEls = now.filter((n) => n.nodeType === 1), thenEls = then.filter((n) => n.nodeType === 1);
    if (liveEls.length !== thenEls.length) return false;
    // <defs> の位置は SVG-Edit が動かすことがあるので、defs 以外の並びと顔ぶれで比べる
    const key = (arr) => arr.filter((n) => n.localName !== 'defs');
    const a = key(liveEls), b = key(thenEls);
    if (a.length !== b.length || a.some((n, i) => n !== b[i])) return false;
    if (!liveEls.every((n) => thenEls.includes(n) && map.has(n))) return false;
    const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim()).length;
    const thenTexts = (info.texts || []).filter((t) => t.trim()).length;
    return texts === thenTexts;
  }

  function origOrder(o, now, info, el) {
    const byK = new Map(now.filter((n) => n.nodeType === 1).map((n) => [map.get(n).k, n]));
    const liveTexts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim());
    const snapTexts = (info.texts || []).filter((t) => t.trim());
    const res = [];
    let ti = 0;
    for (const c of o.childNodes) {
      if (c.nodeType === 1) {
        const k = prep.indexOf.get(c);
        const live = byK.get(k);
        if (live) res.push(...emit(live));
      } else if (c.nodeType === 3) {
        if (isWs(c)) { res.push(copyText(c.nodeValue)); continue; }
        const lt = liveTexts[ti], st = snapTexts[ti];
        ti++;
        res.push(copyText(lt && lt.nodeValue !== st ? lt.nodeValue : c.nodeValue));
      } else if (c.nodeType === 8) {
        if (!isMarkComment(c)) res.push(out.createComment(c.data));
      } else if (c.nodeType === 4) res.push(out.createCDATASection(c.data));
    }
    return res;
  }

  // ルートの子
  const rootInfo = { k: 0, kids: state.rootKids, texts: [] };
  const now = effectiveKids(root, state);
  const kids = sameStructure(now, state.rootKids, rootInfo, root) ? origOrder(oroot, now, rootInfo, root) : emitKids(now);
  if (mark) svg.appendChild(out.createComment(` edited-in-editor: ${mark} `));
  for (const c of kids) svg.appendChild(c);

  // SVG-Edit が振り直した id を参照している箇所（複製・新規の要素）を元の id へ
  const allIds = new Set([...svg.querySelectorAll('[id]')].map((e) => e.id));
  if (idMap.size) {
    for (const e of svg.querySelectorAll('*')) {
      for (const a of [...e.attributes]) {
        let v = a.value;
        for (const [from, to] of idMap) {
          if (allIds.has(from)) continue;
          v = v.split(`url(#${from})`).join(`url(#${to})`).split(`url("#${from}")`).join(`url(#${to})`);
          if ((a.localName === 'href') && v === `#${from}`) v = `#${to}`;
        }
        if (v !== a.value) e.setAttributeNS(a.namespaceURI, a.name, v);
      }
    }
  }
  // 新しく足した要素に SVG-Edit が振った id（svg_12 など）は、どこからも参照されていなければ落とす
  const refs = new Set();
  for (const e of svg.querySelectorAll('*')) for (const a of e.attributes) {
    for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) refs.add(m[1]);
    if (a.localName === 'href' && a.value.startsWith('#')) refs.add(a.value.slice(1));
  }
  const origIds = new Set(origEls.map((e) => e.id).filter(Boolean));
  for (const e of svg.querySelectorAll('[id]')) if (/^svg_\d+$/.test(e.id) && !origIds.has(e.id) && !refs.has(e.id)) e.removeAttribute('id');
  // 宣言の重複や SVG-Edit の名前空間の宣言を落とす
  for (const a of [...svg.attributes]) if (a.namespaceURI === XMLNS && a.value === SENS) svg.removeAttributeNS(XMLNS, a.localName);

  let s = new XMLSerializer().serializeToString(svg);
  // 元のファイル末尾の改行を保つ
  if (/\n$/.test(prep.text || '')) s += '\n';
  return s;
}

/** 「形の編集で保存した」印の日付（YYYY-MM-DD、ローカル時刻） */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
