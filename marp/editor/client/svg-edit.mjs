// 図（SVG）を直接編集するダイアログ。
//   クリックで選択 / Shift・⌘クリックで追加・解除 / 余白からドラッグで範囲選択 / ⌘A で全選択
//   ドラッグ・矢印キーで移動（Shift+ドラッグで縦横に固定、Shift+矢印で10px）
//   右側で文字（内容・太字・サイズ・色）、見た目（塗り・線）、位置の微調整
//   ⌘Z / ⇧⌘Z、元に戻す・やり直す・最初に戻す、⌘S で保存、Esc で選択解除→閉じる
// 保存は、元のファイルを XML として読んだ文書へ「変わった属性と文字だけ」を写してから書き出す。
// 触っていない要素の書式・属性の順番・コメントは元のまま残る。保存後にこのページの見切れを確かめる。
// 形の追加・削除や拡大縮小が要るときは「SVG-Edit で開く」（shape-edit.mjs）へ切り替える。
import { openShapeEditor } from './shape-edit.mjs';
import { readDeckFile, writeDeckFile, openInDrawio } from './backend.mjs';
import { confirmDialog } from '../../shared/dialog.mjs';
import { MARK_RE } from './shape-serialize.mjs';
import { icon } from './icons.mjs';

const SELECTABLE = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'image', 'use']);
const MOVABLE = new Set([...SELECTABLE, 'svg']);
const P = 'data-mj-svged-';
// 元の要素の番号（xdoc の文書順）。追加した要素には付かない。元に戻す・やり直すの間も保つ
const IDX = `${P}i`;
const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (el) => el.tagName.toLowerCase();

function label(el) {
  const t = tag(el), id = el.getAttribute('id');
  if (id) return `${t} #${id}`;
  if (t === 'text' || t === 'tspan') {
    const s = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return s ? `${t}「${s.slice(0, 24)}${s.length > 24 ? '…' : ''}」` : t;
  }
  return t;
}
function hex(v) {
  const t = String(v || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${t.slice(1).split('').map((c) => c + c).join('')}`;
  const m = t.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
  return m ? `#${m.slice(1, 4).map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('')}` : '#434343';
}
const isNone = (v) => !v || v === 'none' || /^rgba\(.*,\s*0\)$/.test(v);
const nestedSvg = (el) => tag(el) === 'svg' && !!el.parentElement?.closest('svg');
const textOf = (el) => (tag(el) === 'tspan' && el.closest('text')) || el;
const isLeafText = (el) => (tag(el) === 'text' || tag(el) === 'tspan') && el.children.length === 0;
// 行（中身が文字だけの tspan）が並んだ文字なら、その行の並び
const linesOf = (el) => (tag(el) === 'text' && el.children.length && [...el.children].every((c) => tag(c) === 'tspan' && c.children.length === 0) ? [...el.children].map((c) => c.textContent) : null);
// 全面の背景の四角は選ばせない（余白のドラッグで範囲選択できるように）
function isBackdrop(el, svg) {
  if (el.parentNode !== svg || tag(el) !== 'rect') return false;
  const a = el.getBoundingClientRect(), b = svg.getBoundingClientRect();
  return a.width >= b.width * 0.98 && a.height >= b.height * 0.98;
}
// 入れ子の要素が両方選ばれていたら、外側だけ動かす
function roots(list) {
  const u = [...new Set(list.map(textOf))];
  return u.filter((e) => !u.some((o) => o !== e && o.contains(e)));
}
function inRect(svg, r) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children) {
      if (!(c instanceof SVGGraphicsElement) || !MOVABLE.has(tag(c)) || tag(c) === 'tspan' || isBackdrop(c, svg)) continue;
      const b = c.getBoundingClientRect();
      if (!b.width && !b.height) continue;
      const inside = b.left >= r.left - 2 && b.right <= r.right + 2 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
      const cross = b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      if (inside) out.push(c); else if (cross && tag(c) === 'g') walk(c);
    }
  };
  walk(svg);
  return out;
}

// 移動は「元の transform の前に translate を足す」（入れ子の <svg> は x / y を動かす）
function moveState(el) {
  if (!el.hasAttribute(`${P}base`)) {
    let base = nestedSvg(el) ? `${el.getAttribute('x') || 0} ${el.getAttribute('y') || 0}` : el.getAttribute('transform') || '';
    let x = 0, y = 0;
    // 先頭の translate は「前に動かした分」として引き継ぐ（元に戻した後に translate が重ならないように）
    const m = !nestedSvg(el) && base.match(/^\s*translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)\s*/);
    if (m) { x = Number(m[1]); y = Number(m[2] || 0); base = base.slice(m[0].length); }
    el.setAttribute(`${P}base`, base);
    el.setAttribute(`${P}x`, String(x)); el.setAttribute(`${P}y`, String(y));
  }
  return { base: el.getAttribute(`${P}base`), x: Number(el.getAttribute(`${P}x`)), y: Number(el.getAttribute(`${P}y`)) };
}
function setOffset(el, x, y) {
  const st = moveState(el);
  el.setAttribute(`${P}x`, String(x)); el.setAttribute(`${P}y`, String(y));
  const r = (n) => String(Number(n.toFixed(2)));
  if (nestedSvg(el)) {
    const [bx, by] = st.base.split(' ').map((n) => parseFloat(n) || 0);
    el.setAttribute('x', r(bx + x)); el.setAttribute('y', r(by + y));
    return;
  }
  if (!x && !y) { if (st.base) el.setAttribute('transform', st.base); else el.removeAttribute('transform'); return; }
  const t = `translate(${r(x)} ${r(y)})`;
  el.setAttribute('transform', st.base ? `${t} ${st.base}` : t);
}
// 画面上のずれ（px）を、要素の親の座標系のずれへ
function toLocal(el, dx, dy) {
  const m = el.parentNode instanceof SVGGraphicsElement ? el.parentNode.getScreenCTM() : null;
  if (!m) return { x: dx, y: dy };
  const i = m.inverse();
  return { x: i.a * dx + i.c * dy, y: i.b * dx + i.d * dy };
}
function nudge(el, dx, dy) {
  const d = toLocal(el, dx, dy), st = moveState(el);
  setOffset(el, st.x + d.x, st.y + d.y);
}
// 文字を入れる。改行があれば、1行ずつ tspan にして縦に並べる（1行なら文字だけ）
function setText(el, value) {
  if (tag(el) !== 'text' || (!value.includes('\n') && !el.children.length)) { el.textContent = value; return; }
  const lines = value.split('\n');
  const olds = [...el.children].filter((c) => tag(c) === 'tspan');
  // 行の数が同じなら、各行の文字だけを書き換える（行ごとの色・太さ・位置を保つ）
  if (olds.length === lines.length) { olds.forEach((t, i) => { t.textContent = lines[i]; }); return; }
  // 行を足す・減らすときは作り直す。元の行の書式を引き継ぎ、足した行は直前の行の書式と行間にする
  const x = olds[0]?.getAttribute('x') || el.getAttribute('x') || '0';
  const dy = olds[1]?.getAttribute('dy') || '1.3em';
  el.textContent = '';
  lines.forEach((line, i) => {
    const base = olds[Math.min(i, olds.length - 1)];
    const sp = base ? base.cloneNode(false) : document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    for (const a of [...sp.attributes]) if (a.name.startsWith(P)) sp.removeAttribute(a.name); // 足した行として扱う
    if (!base) sp.setAttribute('x', x);
    sp.setAttribute('dy', i ? (olds[i]?.getAttribute('dy') || dy) : (olds[0]?.getAttribute('dy') || '0'));
    sp.textContent = line;
    el.appendChild(sp);
  });
}
// 属性と style の両方に書く（style に同じ指定があると属性が負けるため）
function setPaint(el, name, value) {
  el.setAttribute(name, value);
  if (el.style.getPropertyValue(name)) el.style.setProperty(name, value);
}

export async function openSvgEditor({ src, modal, toast, onSaved, checkPage }) {
  const path = src.replace(/^\/deck\//, '').replace(/[?#].*$/, '');
  const r = await readDeckFile(path);
  if (!r.ok) { toast('SVGを読めませんでした', 'error'); return; }
  const { text, drawio } = r;
  const xdoc = new DOMParser().parseFromString(text, 'image/svg+xml');
  // 表示中の要素を、編集用の属性を除いて元の文書へ持ち込む
  const importClean = (el) => {
    const n = xdoc.importNode(el, true);
    for (const e of [n, ...n.querySelectorAll('*')]) for (const a of [...e.attributes]) if (a.name.startsWith(P)) e.removeAttribute(a.name);
    return n;
  };
  if (xdoc.querySelector('parsererror')) { toast('SVGとして読めませんでした', 'error'); return; }

  modal.hidden = false;
  modal.innerHTML = `
    <section class="svg-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="svg-editor-title">
      <header>
        <div>
          <span class="svg-editor-kicker">SVG画像 · ${esc(path)}</span>
          <h2 id="svg-editor-title">図を直接編集</h2>
          <p>図の中をクリックして選択します。ドラッグで移動し、文字や見た目は右側で変更できます。余白からドラッグすると範囲内をまとめて選択できます。</p>
        </div>
        <div class="svg-editor-header-actions">
          <button type="button" data-act="add-text" title="図に文字を足す（余白のダブルクリックでも足せる）">${icon('plus', 14)} 文字</button>
          <button type="button" data-act="undo" disabled>${icon('undo', 14)} 元に戻す</button>
          <button type="button" data-act="redo" disabled>${icon('redo', 14)} やり直す</button>
          <button type="button" data-act="reset" disabled>${icon('reset', 14)} 最初に戻す</button>
          <span class="svg-editor-more">
            <button type="button" data-act="more" aria-label="ほかの編集方法">${icon('more', 16)}</button>
            <span class="svg-editor-menu" hidden>
              <button type="button" data-act="shape">SVG-Edit で開く（形の追加・削除・拡大縮小）</button>
              ${drawio ? '<button type="button" data-act="drawio">draw.io で開く</button>' : ''}
            </span>
          </span>
          <button type="button" class="svg-editor-icon" data-act="close" aria-label="閉じる">${icon('close', 17)}</button>
        </div>
      </header>
      <div class="svg-editor-workspace">
        <div class="svg-editor-stage">
          <div class="svg-editor-canvas" tabindex="0" aria-label="SVG編集キャンバス"></div>
          <span class="svg-editor-marquee" hidden></span>
          <span class="svg-editor-stage-hint">ドラッグ・矢印キーで移動（Shift+ドラッグで縦横に固定、Shift+矢印で10px） · 余白からドラッグで範囲選択 · 余白をダブルクリックで文字を追加 · ⌫で削除 · Shift+クリックで追加・解除 · ⌘Aで全選択 · ⌘Sで保存</span>
        </div>
        <aside class="svg-editor-inspector"></aside>
      </div>
      <footer class="svg-editor-footer">
        <span data-role="status"></span>
        <div>
          <button type="button" data-act="close">閉じる</button>
          <button type="button" data-act="save" class="mj-primary" disabled>${icon('save', 15)} 変更を保存</button>
        </div>
      </footer>
    </section>`;
  const $ = (s) => modal.querySelector(s);
  const canvas = $('.svg-editor-canvas'), stage = $('.svg-editor-stage'), inspector = $('.svg-editor-inspector');
  const marqueeEl = $('.svg-editor-marquee');

  // 表示用の SVG。xdoc の複製なので、要素は文書順で xdoc と1対1に対応する
  const mount = (source) => {
    const d = new DOMParser().parseFromString(source, 'image/svg+xml');
    d.querySelectorAll('script').forEach((s) => s.remove());
    const svg = document.importNode(d.documentElement, true);
    canvas.replaceChildren(svg);
    return svg;
  };
  const liveSvg = () => canvas.querySelector('svg');
  // 編集用の属性（選択・移動の記録）を除いて書き出す
  const snapshot = () => {
    const c = liveSvg().cloneNode(true);
    for (const e of [c, ...c.querySelectorAll('*')]) for (const a of [...e.attributes]) if (a.name.startsWith(P) && a.name !== IDX) e.removeAttribute(a.name);
    return new XMLSerializer().serializeToString(c);
  };
  mount(text);
  [liveSvg(), ...liveSvg().querySelectorAll('*')].forEach((e, i) => e.setAttribute(IDX, String(i)));
  const original = snapshot();

  let selected = [];
  const undo = [], redo = [];
  let pending = null; // 入力欄の編集をまとめて1回の履歴にする
  let drag = null, marquee = null;
  const dirty = () => snapshot() !== original;
  window.__figureDirty = dirty;

  const push = (s) => { if (undo.at(-1) !== s) undo.push(s); };
  const checkpoint = () => push(snapshot());
  const beginInput = () => { pending = { source: snapshot(), recorded: false }; };
  const endInput = () => { pending = null; };
  const recordInput = () => { if (!pending) return checkpoint(); if (!pending.recorded) { push(pending.source); pending.recorded = true; } };
  const changed = (clearRedo = true) => { window.dispatchEvent(new Event('figure-dirty-changed')); if (clearRedo) redo.length = 0; paint(); };

  const select = (list) => {
    canvas.querySelectorAll(`[${P}selected]`).forEach((e) => e.removeAttribute(`${P}selected`));
    selected = [...new Set(list)];
    selected.forEach((e) => e.setAttribute(`${P}selected`, 'true'));
    paint();
  };
  const restore = (source) => {
    const idx = selected.map((e) => [...liveSvg().querySelectorAll('*')].indexOf(e));
    mount(source);
    const all = [...liveSvg().querySelectorAll('*')];
    select(idx.map((i) => all[i]).filter(Boolean));
  };
  const doUndo = () => { pending = null; const s = undo.pop(); if (!s) return; redo.push(snapshot()); restore(s); };
  const doRedo = () => { pending = null; const s = redo.pop(); if (!s) return; push(snapshot()); restore(s); };
  const doReset = () => { pending = null; if (!dirty()) return; checkpoint(); redo.length = 0; restore(original); };
  const move = (dx, dy) => {
    if (!selected.length) return;
    pending = null; checkpoint();
    const m = liveSvg().getScreenCTM();
    // 矢印キーの 1px は図の座標で 1 にする（画面の倍率に左右されない）
    const sx = m ? m.a * dx + m.c * dy : dx, sy = m ? m.b * dx + m.d * dy : dy;
    for (const e of roots(selected)) nudge(e, sx, sy);
    changed();
  };
  const edit = (fn, immediate = true) => {
    const el = selected.length === 1 ? selected[0] : null;
    if (!el) return;
    if (immediate) { pending = null; checkpoint(); } else recordInput();
    fn(el);
    changed();
  };

  // --- 文字の追加・要素の削除 -------------------------------------------------------
  // 書体・色・大きさは、図の中にある文字に合わせる（いちばん多い書体と色、真ん中の大きさ）
  function textStyle() {
    const texts = [...liveSvg().querySelectorAll('text')];
    const most = (arr) => { const c = new Map(); for (const v of arr) if (v) c.set(v, (c.get(v) || 0) + 1); return [...c.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]; };
    const sizes = texts.map((t) => parseFloat(t.getAttribute('font-size') || getComputedStyle(t).fontSize)).filter(Boolean).sort((x, y) => x - y);
    return {
      family: most(texts.map((t) => t.getAttribute('font-family'))) || 'Noto Sans JP, Hiragino Sans, sans-serif',
      fill: most(texts.map((t) => t.getAttribute('fill'))) || '#232F3E',
      size: sizes.length ? Math.round(sizes[Math.floor(sizes.length / 2)]) : 24,
    };
  }
  function toSvgPoint(clientX, clientY) {
    const svg = liveSvg();
    const m = svg.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    return pt.matrixTransform(m.inverse());
  }
  function addText(at) {
    const svg = liveSvg();
    let x, y;
    if (at) ({ x, y } = at);
    else {
      const vb = svg.viewBox.baseVal;
      const w = vb?.width || parseFloat(svg.getAttribute('width')) || 1160, h = vb?.height || parseFloat(svg.getAttribute('height')) || 400;
      x = (vb?.x || 0) + w / 2; y = (vb?.y || 0) + h / 2;
    }
    const st = textStyle();
    pending = null; checkpoint();
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', String(Math.round(x)));
    t.setAttribute('y', String(Math.round(y)));
    t.setAttribute('fill', st.fill);
    t.setAttribute('font-family', st.family);
    t.setAttribute('font-size', String(st.size));
    t.setAttribute('font-weight', '400');
    t.setAttribute('text-anchor', at ? 'start' : 'middle');
    t.textContent = 'テキスト';
    svg.appendChild(t);
    changed();
    select([t]);
    // すぐ打てるように、右の「内容」を選んだ状態にする
    const ta = inspector.querySelector('[data-text]');
    if (ta) { ta.focus(); ta.select(); }
  }
  function removeSelected() {
    const targets = roots(selected).filter((e) => e !== liveSvg());
    if (!targets.length) return;
    pending = null; checkpoint();
    for (const e of targets) e.remove();
    selected = [];
    changed();
  }

  // --- 右側 -----------------------------------------------------------------
  function paint() {
    $('[data-act="undo"]').disabled = !undo.length;
    $('[data-act="redo"]').disabled = !redo.length;
    const d = dirty();
    $('[data-act="reset"]').disabled = !d;
    $('[data-act="save"]').disabled = !d;
    $('[data-role="status"]').textContent = `${d ? '未保存の変更があります' : '変更はありません'} · 保存時にこのページの見切れを確認します`;
    if (inspector.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return; // 入力中は組み直さない
    inspector.innerHTML = inspectorHtml();
  }
  const nudgePad = `<fieldset><legend>位置</legend><div class="svg-editor-nudge" aria-label="位置を微調整">
      <button type="button" data-nudge="0,-1" aria-label="上へ1px">${icon('arrowUp', 16)}</button>
      <button type="button" data-nudge="-1,0" aria-label="左へ1px">${icon('arrowLeft', 16)}</button>
      <button type="button" data-nudge="1,0" aria-label="右へ1px">${icon('arrowRight', 16)}</button>
      <button type="button" data-nudge="0,1" aria-label="下へ1px">${icon('arrowDown', 16)}</button>
    </div></fieldset>`;
  const color = (name, labelText, value) => `<label class="svg-editor-color"><span>${labelText}</span><input type="color" data-paint="${name}" value="${hex(value)}"><code>${hex(value)}</code></label>`;
  function inspectorHtml() {
    if (selected.length > 1) {
      return `<div class="svg-editor-selection"><span>選択中</span><strong>${selected.length}個の要素</strong></div>
        <p class="svg-editor-inspector-note">ドラッグや矢印キーで、まとめて移動します。Shift+クリックで追加・解除できます。文字や色は1つだけ選んで変更してください。</p>
        ${nudgePad}<button type="button" class="svg-editor-full" data-act="deselect">選択を解除</button>
        <button type="button" class="svg-editor-full svg-editor-danger" data-act="remove">${selected.length}個を削除（⌫）</button>`;
    }
    const el = selected[0];
    if (!el) {
      return `<div class="svg-editor-empty"><strong>図の中を選択</strong><p>文字、箱、線、アイコンをクリックすると編集項目が表示されます。余白からドラッグすると、範囲内の要素をまとめて選択して一緒に動かせます。</p></div>`;
    }
    const cs = getComputedStyle(el);
    const isText = tag(el) === 'text' || tag(el) === 'tspan';
    const lines = linesOf(el);
    const leaf = isLeafText(el) || !!lines;
    const size = Math.round(parseFloat(el.getAttribute('font-size') || cs.fontSize || '16'));
    const bold = parseInt(el.getAttribute('font-weight') || cs.fontWeight || '400', 10) >= 600;
    const fill = cs.fill || el.getAttribute('fill') || 'none';
    const stroke = cs.stroke || el.getAttribute('stroke') || 'none';
    const parentG = el.parentElement?.closest('g');
    let h = `<div class="svg-editor-selection"><span>選択中</span><strong>${esc(label(el))}</strong></div>`;
    if (parentG && liveSvg().contains(parentG)) h += `<button type="button" class="svg-editor-full" data-act="group">${icon('group', 15)} まとまり全体を選択</button>`;
    if (isText) {
      h += `<fieldset><legend>文字</legend>
        <label class="svg-editor-field"><span>内容</span>
          <textarea rows="4" maxlength="5000" data-text ${leaf ? '' : 'disabled'} placeholder="${leaf ? '文字を入力（改行すると複数行になります）' : '子の文字をキャンバスで選択してください'}">${leaf ? esc(lines ? lines.join('\n') : el.textContent) : ''}</textarea>
          ${leaf ? (lines ? '<small>行ごとに改行で区切っています。</small>' : '') : '<small>中に書式の違う文字があります。直したい部分を直接クリックしてください。</small>'}
        </label>
        <div class="svg-editor-format-row">
          <button type="button" role="switch" aria-checked="${bold}" class="svg-editor-format-button${bold ? ' is-active' : ''}" data-act="bold">${icon('bold', 15)} 太字</button>
          <label><span>文字サイズ</span><input type="number" min="6" max="160" value="${size}" data-size></label>
        </div>
        ${color('fill', '文字色', fill)}
      </fieldset>`;
    } else {
      h += '<fieldset><legend>見た目</legend>';
      if (!isNone(fill)) h += color('fill', '塗り', fill);
      if (!isNone(stroke)) h += color('stroke', '線', stroke);
      if (isNone(fill) && isNone(stroke)) h += '<p class="svg-editor-inspector-note">この要素には変更できる色が設定されていません。</p>';
      h += '</fieldset>';
    }
    return h + nudgePad + '<button type="button" class="svg-editor-full svg-editor-danger" data-act="remove">この要素を削除（⌫）</button>';
  }
  inspector.addEventListener('focusin', (e) => { if (e.target.matches('textarea, input')) beginInput(); });
  inspector.addEventListener('focusout', (e) => { if (e.target.matches('textarea, input')) { endInput(); paint(); } });
  inspector.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-text]')) edit((el) => setText(el, t.value), false);
    else if (t.matches('[data-size]')) edit((el) => setPaint(el, 'font-size', String(Math.max(6, Math.min(160, Number(t.value) || 6)))), false);
    else if (t.matches('[data-paint]')) { edit((el) => setPaint(el, t.dataset.paint, t.value), false); t.nextElementSibling.textContent = t.value; }
  });
  const toggleBold = () => {
    const el = selected[0];
    if (selected.length !== 1 || !(tag(el) === 'text' || tag(el) === 'tspan')) return;
    const bold = parseInt(el.getAttribute('font-weight') || getComputedStyle(el).fontWeight || '400', 10) >= 600;
    edit((x) => setPaint(x, 'font-weight', bold ? '400' : '700'));
  };

  // --- キャンバス -----------------------------------------------------------
  const local = (e) => { const b = stage.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.svg-editor-stage-hint')) return;
    const svg = liveSvg();
    const hit = (e.target instanceof Element ? e.target : null)?.closest([...SELECTABLE].join(','));
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    if (!svg || !hit || !svg.contains(hit) || hit.closest('defs') || isBackdrop(hit, svg)) {
      const p = local(e);
      marquee = { id: e.pointerId, sx: p.x, sy: p.y, ex: p.x, ey: p.y, base: additive ? selected : [] };
      if (!additive) select([]);
      return;
    }
    const was = selected.some((s) => s === hit || textOf(s).contains(hit));
    const next = additive ? (was ? selected : [...selected, hit]) : (was && selected.length > 1 ? selected : [hit]);
    if (next !== selected) select(next);
    // クリックだけで離したとき（動かさなかったとき）の選択
    const onClick = additive ? (was ? selected.filter((s) => s !== hit && !textOf(s).contains(hit)) : undefined) : (was && selected.length > 1 ? [hit] : undefined);
    pending = null;
    const before = snapshot();
    drag = { id: e.pointerId, els: roots(next), ox: e.clientX, oy: e.clientY, ax: 0, ay: 0, moved: false, before, onClick };
  });
  stage.addEventListener('pointermove', (e) => {
    if (marquee && marquee.id === e.pointerId) {
      const p = local(e); marquee.ex = p.x; marquee.ey = p.y;
      Object.assign(marqueeEl.style, { left: `${Math.min(marquee.sx, p.x)}px`, top: `${Math.min(marquee.sy, p.y)}px`, width: `${Math.abs(p.x - marquee.sx)}px`, height: `${Math.abs(p.y - marquee.sy)}px` });
      marqueeEl.hidden = false;
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    let dx = e.clientX - drag.ox, dy = e.clientY - drag.oy;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    if (!drag.moved) push(drag.before);
    if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    const ix = dx - drag.ax, iy = dy - drag.ay;
    if (ix || iy) for (const el of drag.els) nudge(el, ix, iy);
    drag.ax = dx; drag.ay = dy; drag.moved = true;
  });
  const up = (e) => {
    if (marquee && marquee.id === e.pointerId) {
      const m = marquee; marquee = null; marqueeEl.hidden = true;
      if (Math.hypot(m.ex - m.sx, m.ey - m.sy) < 3) return;
      const b = stage.getBoundingClientRect();
      select([...m.base, ...inRect(liveSvg(), { left: b.left + Math.min(m.sx, m.ex), right: b.left + Math.max(m.sx, m.ex), top: b.top + Math.min(m.sy, m.ey), bottom: b.top + Math.max(m.sy, m.ey) })]);
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag; drag = null;
    if (d.moved) changed(); else if (d.onClick) select(d.onClick); else paint();
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('dblclick', (e) => {
    const hit = (e.target instanceof Element ? e.target : null)?.closest([...SELECTABLE].join(','));
    const svg = liveSvg();
    if (hit && svg.contains(hit) && !isBackdrop(hit, svg)) return; // 要素の上は選ぶだけ
    const pt = toSvgPoint(e.clientX, e.clientY);
    if (pt) addText(pt);
  });
  stage.addEventListener('pointercancel', up);

  // --- 保存・閉じる ---------------------------------------------------------
  // 表示中の SVG の変更を、元の文書（xdoc）へ要素ごとに写す
  function toXml() {
    const orig = [xdoc.documentElement, ...xdoc.documentElement.querySelectorAll('*')].filter((e) => tag(e) !== 'script');
    const live = [liveSvg(), ...liveSvg().querySelectorAll('*')];
    const seen = new Set();
    // 元からある要素：変わった属性と文字だけを写す
    for (const l of live) {
      if (!l.hasAttribute(IDX)) continue;
      const i = Number(l.getAttribute(IDX));
      const o = orig[i];
      if (!o) throw new Error('要素の対応が取れません');
      seen.add(i);
      for (const a of [...l.attributes]) {
        if (a.name.startsWith(P)) continue;
        if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
      }
      for (const a of [...o.attributes]) if (!l.hasAttribute(a.name)) o.removeAttribute(a.name);
      if (isLeafText(l) && o.children.length === 0 && o.textContent !== l.textContent) o.textContent = l.textContent;
      // 1行の文字を複数行（tspan）にしたとき：元の文字を消す（行は下の「足した要素」で入る）
      if (tag(l) === 'text' && l.children.length && o.children.length === 0) o.textContent = '';
    }
    // 消した要素
    orig.forEach((o, i) => { if (i && !seen.has(i) && o.parentNode) o.remove(); });
    // 足した要素：直前の元からある兄弟の後ろ（なければ親の先頭）へ
    const added = new Map();
    for (const l of live) {
      if (l.hasAttribute(IDX) || !l.parentElement?.hasAttribute(IDX)) continue;
      const parent = orig[Number(l.parentElement.getAttribute(IDX))];
      // 直前の兄弟（元からある要素か、先に足した要素）の後ろへ。並びが入れ替わらないように
      let prev = l.previousElementSibling, anchor = null;
      while (prev && !anchor) { anchor = prev.hasAttribute(IDX) ? orig[Number(prev.getAttribute(IDX))] : added.get(prev) || null; prev = prev.previousElementSibling; }
      const node = importClean(l);
      added.set(l, node);
      if (anchor) anchor.after(node);
      else parent.insertBefore(node, parent.firstChild);
    }
    // 生成スクリプトで上書きしないための印（このキットの約束）
    const root = xdoc.documentElement;
    const today = new Date().toISOString().slice(0, 10);
    const mark = [...root.childNodes].find((n) => n.nodeType === 8 && MARK_RE.test(n.data));
    if (mark) mark.data = ` edited-in-editor: ${today} `;
    else root.insertBefore(xdoc.createComment(` edited-in-editor: ${today} `), root.firstChild);
    let out = new XMLSerializer().serializeToString(xdoc);
    if (/^<\?xml/.test(text) && !/^<\?xml/.test(out)) out = text.match(/^<\?xml[^>]*>\s*/)[0] + out;
    return out;
  }
  let saving = false;
  async function save() {
    if (saving || !dirty()) return false;
    let out;
    try { out = toXml(); } catch (err) { toast(`保存できませんでした（${err.message}）`, 'error'); return false; }
    saving = true; $('[data-act="save"]').disabled = true;
    const res = await writeDeckFile(path, out);
    saving = false;
    if (!res.ok) { toast('SVGを保存できませんでした', 'error'); paint(); return false; }
    close(true);
    onSaved?.(path);
    // 見切れの検査は待たない（待つと、監視の render で Promise が置き換わり、閉じる処理が止まる）
    Promise.resolve(checkPage?.() ?? null).then((issues) => {
      if (!issues) return toast('図を保存しました');
      const bad = issues.filter((x) => x.level === 'error');
      if (bad.length) toast(`図を保存しました。このページに見切れが${bad.length}件あります`, 'error');
      else toast(issues.length ? `図を保存しました（注意 ${issues.length}件）` : '図を保存しました。このページは見切れなし');
    }).catch(() => {});
    return true;
  }
  window.__figureSave = () => (dirty() ? save() : true);
  async function close(force = false) {
    if (document.querySelector('#mj-dialog-host:not([hidden])')) return;
    if (!force && dirty() && !(await confirmDialog({ title: '変更を破棄', message: '保存していない変更があります。破棄して閉じますか？', ok: '破棄する', danger: true }))) return;
    window.removeEventListener('keydown', onKey, true);
    delete window.__figureDirty;
    window.dispatchEvent(new Event('figure-dirty-changed'));
    delete window.__figureSave;
    modal.hidden = true; modal.innerHTML = ''; modal.onclick = null; modal.onmousedown = null;
  }
  const onKey = (e) => {
    if (document.querySelector('#mj-dialog-host:not([hidden])')) return;
    if (!modal.contains(canvas)) return window.removeEventListener('keydown', onKey, true);
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    let done = true;
    if (mod && k === 's') save();
    else if (mod && k === 'z' && !typing) (e.shiftKey ? doRedo : doUndo)();
    else if (mod && k === 'b') toggleBold();
    else if (mod && k === 'a' && !typing) select(inRect(liveSvg(), { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }));
    else if (!typing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const s = e.shiftKey ? 10 : 1;
      move(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
    } else if (!typing && (e.key === 'Backspace' || e.key === 'Delete') && selected.length) removeSelected();
    else if (e.key === 'Escape') { if (selected.length) select([]); else close(); }
    else done = false;
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  window.addEventListener('keydown', onKey, true);

  modal.onmousedown = (e) => { if (e.target === modal) close(); };
  modal.onclick = async (e) => {
    const nb = e.target.closest('[data-nudge]');
    if (nb) { const [x, y] = nb.dataset.nudge.split(',').map(Number); return move(x, y); }
    const act = e.target.closest('[data-act]')?.dataset.act;
    const menu = $('.svg-editor-menu');
    if (act !== 'more' && menu) menu.hidden = true;
    if (act === 'more') menu.hidden = !menu.hidden;
    if (act === 'undo') doUndo();
    if (act === 'redo') doRedo();
    if (act === 'reset') doReset();
    if (act === 'deselect') select([]);
    if (act === 'group') { const g = selected[0]?.parentElement?.closest('g'); if (g) select([g]); }
    if (act === 'bold') toggleBold();
    if (act === 'add-text') addText();
    if (act === 'remove') removeSelected();
    if (act === 'close') await close();
    if (act === 'save') save();
    if (act === 'drawio') await openInDrawio(path);
    if (act === 'shape') {
      if (dirty() && !(await confirmDialog({ title: '変更を破棄', message: '保存していない変更があります。破棄して SVG-Edit へ進みますか？', ok: '進む', danger: true }))) return;
      await close(true);
      await openShapeEditor({ path, modal, toast, onSaved });
    }
  };
  paint();
  canvas.focus({ preventScroll: true });
}
