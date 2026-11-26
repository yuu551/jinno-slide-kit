import { openSettings } from '../../shared/app-settings.mjs';
import { settings } from '../../shared/settings.mjs';
// Typora風のMarpエディター（ブラウザ側）。
// 画面のスライドをそのまま直し、元のMarkdownの行へ書き戻す。描画は marp-core + plugin.mjs（marp-cli と同じ）。
//
// 編集の考え方
//   - 文字をクリックすると、その要素だけ元のMarkdown（** や ` を含む）を見せて直す。確定するとその区間だけを書き換える（Typoraと同じ）
//   - ページ・部品・表・リストの操作も、すべて Markdown の文字列に対する操作として行い、共通の履歴（⌘Z）に積む
//   - 保存は読み込んだ版と比べて競合を検出し、未保存の編集はブラウザに下書きとして退避する
import { createEditorRenderer } from './render-core.mjs';
import { EditorView, basicSetup } from 'codemirror';
import { EditorSelection, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import {
  applyElementEdit, editTarget, rangesFromText, readSlideMeta, setSlideClasses, setSlideNote, setScale, setImageHeight,
  insertListItemAfter, removeListItem, indentListItem, tableOp, slideOp, slidesOpMulti, appendToSlide, slideTitles, splitSlides, joinSlides,
} from './markdown.mjs';
import { checkSection } from './check.mjs';
import { openSvgEditor } from './svg-edit.mjs';
import { createNotes } from './notes.mjs';
import { createCheatsheet } from './cheatsheet-ui.mjs';
import { createHistory } from './history-ui.mjs';
import { TEMPLATES } from './templates.mjs';
import { icon } from './icons.mjs';
import { guardIME } from './ime.mjs';
import { closeConfirmDialog, confirmDialog, promptDialog } from '../../shared/dialog.mjs';
import {
  deckInfo, loadDeck, saveDeck, checkAll as runDeckCheck, exportDeck as exportDeckFile, exportFileUrl, revealExport, openExport,
  newFigure, uploadImage, copyTargets, importPages, sendPages, subscribeEvents, inTauri, runtimeStatus, showLibrary, cancelExport, cancelCheck, revealPath,
  onCloseRequested, closeWindowNow, cancelCloseWindow, draftGet, draftSet, draftClear,
  renameDeck, openDeckWindow, deckLocation,
} from './backend.mjs';
window.addEventListener('settings-error', () => toast('設定を読み書きできませんでした。フォルダの権限と空き容量を確かめてください', 'error'));
guardIME(); // 日本語の変換を確定する Enter を、アプリの操作として受け取らない

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);

const state = {
  text: '', saved: '', baseHash: '', current: 0,
  sections: [],      // 各スライドの section の outerHTML
  ranges: [],        // 各スライドの本文の行範囲 {start, end}
  titles: [],
  issues: [],        // 各スライドの検査結果（要素参照なし）
  css: '', figVersion: 0, editing: null, sourceOpen: false,
  autosave: settings.getItem('mj-autosave') !== '0', // 既定でオン（D03）
  leftMode: settings.getItem('mj-left') || 'thumbs',
  file: '',
  selected: new Set(), // 一覧で複数選んだページ（現在のページは含めない）
  anchor: null,
};

// --- 履歴（元に戻す／やり直す） ------------------------------------------------------------
// 発表者ノートの入力は 300ms まとめる。ページを移る前に、入力したページへ確定する（D05）
let pendingNote = null;
function flushPendingNote() {
  const p = pendingNote;
  pendingNote = null;
  if (!p) return;
  const r = state.ranges[p.page];
  if (!r) return;
  const lines = state.text.split('\n');
  const slide = lines.slice(r.start, r.end);
  const next = setSlideNote(slide, p.value);
  if (next.join('\n') === slide.join('\n')) return;
  pushHistory(`note:${p.page}`);
  state.text = [...lines.slice(0, r.start), ...next, ...lines.slice(r.end)].join('\n');
  state.ranges = rangesFromText(state.text);
  syncSourceEditor();
  afterChange();
}

const hist = { past: [], future: [], lastKey: null, lastAt: 0 };
const HIST_MAX = 300;
function pushHistory(key) {
  const now = Date.now();
  // 同じ種類の連続した操作（スライダー・ソース入力・ノート）は1つにまとめる
  if (key && key === hist.lastKey && now - hist.lastAt < 900) { hist.lastAt = now; return; }
  hist.past.push({ text: state.text, current: state.current });
  if (hist.past.length > HIST_MAX) hist.past.shift();
  hist.future = [];
  hist.lastKey = key; hist.lastAt = now;
}
function undo() {
  finishEdit(true);
  flushPendingNote();
  const h = hist.past.pop();
  if (!h) return toast('これ以上は戻せません');
  hist.future.push({ text: state.text, current: state.current });
  hist.lastKey = null;
  applyText(h.text, h.current);
}
function redo() {
  finishEdit(true);
  flushPendingNote();
  const h = hist.future.pop();
  if (!h) return;
  hist.past.push({ text: state.text, current: state.current });
  hist.lastKey = null;
  applyText(h.text, h.current);
}
function applyText(text, current) {
  state.text = text;
  state.current = current;
  render();
  go(state.current, { keepEdit: true });
  syncSourceEditor();
  afterChange();
}
function updateHistoryButtons() {
  $('#btn-undo').disabled = !hist.past.length;
  $('#btn-redo').disabled = !hist.future.length;
}

// --- Marp ------------------------------------------------------------------------
let marp;
async function setupMarp() {
  const info = await deckInfo();
  state.debug = info.debug;
  lastExport = info.exports?.[0] || null;
  $('#export-menu [data-x="reveal"]').disabled = !lastExport;
  state.abs = info.abs;
  state.file = info.file;
  state.name = info.name;
  document.title = `${info.name} — Marpエディター`;
  $('#file-name').textContent = info.name || info.file.replace(/\/slides\.md$/, '');
  $('#file-name').title = info.file;
  // 一覧（ライブラリー）へ戻る。未保存の変更は移動の前に確認が出る
  if (info.hub) { $('#btn-hub').href = info.hub; $('#btn-hub').hidden = false; }
  renderThemes = info.themes;
  const renderer = createEditorRenderer(renderThemes);
  marp = renderer.marp;
  renderCache = renderer.cache;
}

let renderCache, renderThemes;
let normalizedPages = new Map(), normalizedVersion = 0;
async function initialRender() {
  let worker;
  try {
    worker = new Worker(new URL('render-worker.js', location.href));
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('描画の準備が時間内に終わりませんでした')), 8000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); data.error ? reject(new Error(data.error)) : resolve(data); };
      worker.onerror = event => { clearTimeout(timer); event.preventDefault(); reject(new Error(event.message || 'Worker を起動できませんでした')); };
      worker.postMessage({ text: state.text, themes: renderThemes });
    });
    renderCache.seed(data.cache);
    state.initialRenderer = 'worker';
    return data.result;
  } catch (error) {
    state.initialRenderer = 'main';
    state.renderWorkerError = error.message;
    return null;
  } finally { worker?.terminate(); }
}
function render({ keepInspector = false, prepared = null } = {}) {
  const { html, css } = prepared || marp.render(state.text, { htmlAsArray: true });
  state.renderStats = { ...renderCache.stats };
  if (css !== state.css) { $('#marp-css').textContent = css; state.css = css; checkCache.clear(); }
  if (normalizedVersion !== state.figVersion) { normalizedPages.clear(); normalizedVersion = state.figVersion; }
  const nextPages = new Map();
  state.sections = html.map(raw => {
    let value = normalizedPages.get(raw);
    if (!value) {
      const tpl = document.createElement('template');
      tpl.innerHTML = raw;
      for (const img of state.figVersion ? tpl.content.querySelectorAll('img[src]') : []) {
        const src = img.getAttribute('src');
        if (!/^(data:|https?:)/.test(src)) img.setAttribute('src', `${src}${src.includes('?') ? '&' : '?'}v=${state.figVersion}`);
      }
      value = tpl.content.firstElementChild.outerHTML;
    }
    nextPages.set(raw, value);
    return value;
  });
  normalizedPages = nextPages;
  state.ranges = rangesFromText(state.text);
  state.titles = slideTitles(state.text);
  if (state.ranges.length !== state.sections.length) console.warn('スライド数が一致しません', state.ranges.length, state.sections.length);
  state.current = Math.max(0, Math.min(state.current, state.sections.length - 1));
  renderStage();
  renderLeft();
  if (!keepInspector) renderInspector();
  scheduleCheckAll();
  updateStatus();
}

// --- ステージ（中央の大きなスライド） -------------------------------------------------
const EDITABLE = 'h1[data-line], p[data-line]:not(.image-block), li[data-line], figcaption[data-line], span.purpose-label[data-line], th, td, [data-span]';
const SINGLE_LINE = 'h1, th, td, .scene-label, .scene-caption > span, .scene-caption small, .flow strong, .compare h3, .profile-label, .link-copy strong, .scene-arrow span, figcaption';
const isEditable = (el) => el && el.closest('section') && !(el.matches('li') && el.querySelector('ul, ol, p, div, table'));

let zoom = 'fit';
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2];
function setZoom(dir) {
  const cur = zoom === 'fit' ? stageScale() : zoom;
  const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
  if (next) { zoom = next; renderStage(); renderZoom(); }
}
function renderZoom() {
  const s = stageScale();
  $('#zoom').innerHTML = `<button type="button" data-z="-" title="縮小（⌘-）">−</button><button type="button" data-z="fit" title="画面に合わせる（⌘0）" class="${zoom === 'fit' ? 'is-on' : ''}">${zoom === 'fit' ? '合わせる' : Math.round(s * 100) + '%'}</button><button type="button" data-z="100" title="100%" class="${zoom === 1 ? 'is-on' : ''}">100%</button><button type="button" data-z="+" title="拡大（⌘+）">＋</button>`;
}
function stageScale() {
  if (zoom !== 'fit') return zoom;
  const box = $('#stage-wrap').getBoundingClientRect();
  return Math.max(0.2, Math.min((box.width - 48) / 1280, (box.height - 48) / 720));
}

function renderStage() {
  if (state.editing) finishEdit(true);
  const s = stageScale();
  const stage = $('#stage');
  stage.style.width = `${1280 * s}px`; stage.style.height = `${720 * s}px`;
  stage.innerHTML = `<div class="mj-scale" style="transform: scale(${s})"><div class="marpit">${state.sections[state.current] || ''}</div></div>`;
  const sec = stage.querySelector('section');
  hideBars();
  // 描き終えたページの検査結果（図の保存後に「このページの見切れ」を知らせるのに使う）
  state.stageCheck = new Promise((res) => { state.resolveStageCheck = res; });
  if (!sec) return state.resolveStageCheck([]);
  for (const el of sec.querySelectorAll(EDITABLE)) if (isEditable(el)) el.classList.add('mj-editable');
  if (state.picked) paintPick();
  $('#page-no').textContent = `${state.current + 1} / ${state.sections.length}`;
  const imgs = [...sec.querySelectorAll('img')];
  Promise.all(imgs.map((i) => i.decode().catch(() => {}))).then(() => { if (stage.querySelector('section') === sec) markStageIssues(sec, s); });
  if (!imgs.length) markStageIssues(sec, s);
}

function markStageIssues(sec, s) {
  const issues = checkSection(sec, s);
  for (const x of issues) x.el?.classList.add(x.level === 'error' ? 'mj-issue' : 'mj-issue-warn');
  state.issues[state.current] = issues.map(({ el, ...rest }) => rest);
  checkCache.set(cacheKey(state.current), state.issues[state.current]);
  state.resolveStageCheck?.(state.issues[state.current]);
  renderIssueList();
  updateBadge(state.current);
  updateSummary();
}

// 再描画のあとで、同じ場所の要素を探し直す
function findEditable({ line, row, col, span }) {
  const sec = $('#stage section');
  if (!sec) return null;
  if (row != null) {
    const tr = [...sec.querySelectorAll('tr[data-line]')].find((t) => Number(t.dataset.line.split('-')[0]) === row);
    return tr?.cells[Math.min(col, tr.cells.length - 1)] || null;
  }
  if (span) return [...sec.querySelectorAll('[data-span]')].find((e) => e.dataset.span.startsWith(span)) || null;
  return [...sec.querySelectorAll('.mj-editable[data-line]')].find((e) => Number(e.dataset.line.split('-')[0]) === line) || null;
}

// --- 直接編集（編集中だけMarkdownを見せる） -----------------------------------------------------
// 描画された文字のk文字目が、Markdownの何文字目にあたるか（記号・エスケープ・実体参照を読み飛ばす）
function rawOffset(raw, k) {
  let i = 0, vis = 0;
  while (i < raw.length && vis < k) {
    if (raw.startsWith('**', i) || raw.startsWith('__', i)) { i += 2; continue; }
    if (raw[i] === '*' || raw[i] === '`' || raw[i] === '\n') { i++; continue; }
    if (/^<br\s*\/?>/i.test(raw.slice(i, i + 6))) { i += raw.slice(i).match(/^<br\s*\/?>/i)[0].length; continue; }
    const ent = raw.slice(i).match(/^&[a-z]+;|^&#\d+;/i);
    if (ent) { i += ent[0].length; vis++; continue; }
    if (raw[i] === '\\' && i + 1 < raw.length) { i += 2; vis++; continue; }
    i++; vis++;
  }
  return i;
}
function renderedOffsetAt(el, x, y) {
  const r = document.caretRangeFromPoint?.(x, y);
  if (!r || !el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaret(el, offset) {
  const sel = getSelection();
  const r = document.createRange();
  const node = el.firstChild;
  if (!node || node.nodeType !== 3) { r.selectNodeContents(el); r.collapse(false); }
  else if (offset === 'all') r.selectNodeContents(el);
  else { const o = offset === 'end' || offset == null ? node.length : Math.min(offset, node.length); r.setStart(node, o); r.collapse(true); }
  sel.removeAllRanges(); sel.addRange(r);
}
// 編集中の値（テキストノード・改行・<br>・ブロック要素を改行として読む）
function plainValue(el) {
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.textContent;
      else if (c.nodeName === 'BR') out += '\n';
      else { if (/^(DIV|P)$/.test(c.nodeName) && out && !out.endsWith('\n')) out += '\n'; walk(c); }
    }
  };
  walk(el);
  return out.replace(/ /g, ' ').replace(/\n$/, '');
}

// 要素の場所（再描画のあとで探し直すための手がかり）
function locatorOf(el) {
  const cell = el.closest('td, th');
  if (cell) return { row: Number(cell.closest('tr').dataset.line?.split('-')[0]), col: cell.cellIndex };
  if (el.dataset.span) return { span: el.dataset.span, line: Number(el.dataset.span.split(':')[0]) };
  return { line: Number(el.dataset.line?.split('-')[0]) };
}
// 編集中は <br> をタグのまま見せず、改行として見せる。確定のときに元の書き方（<br> か改行か）へ戻す。
// 新しく入れた改行は、1行で書く要素（見出し・表のセル）では <br>、本文では改行にする
function showBreaks(raw) {
  const kinds = [];
  const text = raw.replace(/<br\s*\/?>|\n/gi, (m) => { kinds.push(m === '\n' ? 'nl' : m); return '\n'; });
  return { text, kinds };
}
function restoreBreaks(text, kinds, single) {
  let i = 0;
  return text.replace(/\n/g, () => {
    const k = kinds[i++];
    if (single) return k && k !== 'nl' ? k : '<br>';
    return k === undefined || k === 'nl' ? '\n' : k;
  });
}
function startEdit(el, { offset = 'end', rendered = null } = {}) {
  if (state.editing?.el === el) return;
  if (state.picked) { state.picked = null; el.classList.remove('mj-picked'); $('#stage').querySelectorAll('.mj-picked').forEach((x) => x.classList.remove('mj-picked')); }
  if (state.editing) {
    // 直前の編集を確定すると描き直されるので、同じ場所の要素を探し直す（行の増減も補正）
    const loc = locatorOf(el);
    const prevLine = state.editing.target.start ?? state.editing.target.row ?? Number(state.editing.el.dataset.span?.split(':')[0]);
    const before = state.text.split('\n').length;
    const next = finishEdit(true);
    if (next != null && !el.isConnected) {
      const delta = next.split('\n').length - before;
      if (delta && loc.line > prevLine) loc.line += delta;
      if (delta && loc.row > prevLine) loc.row += delta;
      if (loc.span && delta && loc.line > prevLine) loc.span = null;
      el = findEditable(loc);
      if (!el) return;
    }
  }
  const target = editTarget(state.text, el);
  if (!target) return;
  const originalHTML = el.innerHTML;
  const shown = showBreaks(target.content);
  el.textContent = shown.text;
  el.contentEditable = 'plaintext-only';
  el.spellcheck = false;
  el.classList.add('mj-editing');
  state.editing = { el, target, originalHTML, breaks: shown.kinds, single: el.matches(SINGLE_LINE) || target.prefix?.heading || target.kind === 'cell', isItem: el.matches('li') && /^(\s*)([-*+]|\d+[.)])\s/.test(state.text.split('\n')[target.start] || '') };
  el.focus({ preventScroll: true });
  setCaret(el, rendered != null ? rawOffset(shown.text, rendered) : offset);
  el.addEventListener('blur', onEditBlur);
  showBars(el);
}
function onEditBlur(e) {
  // ツールバーを押したときは編集を続ける
  if (e.relatedTarget?.closest?.('#format-bar, #table-bar')) return;
  setTimeout(() => { if (state.editing && document.activeElement !== state.editing.el) finishEdit(true); }, 0);
}
function finishEdit(commit) {
  const ed = state.editing;
  if (!ed) return null;
  state.editing = null;
  const { el, target, originalHTML } = ed;
  el.removeEventListener('blur', onEditBlur);
  el.contentEditable = 'false';
  el.classList.remove('mj-editing');
  hideBars();
  const value = restoreBreaks(plainValue(el), ed.breaks || [], ed.single);
  const next = commit ? target.apply(value) : null;
  if (next == null) { el.innerHTML = originalHTML; return null; }
  setText(next, { key: null, label: '文字の編集' });
  return next;
}

// Enter・Esc で編集を終えたあとも、その要素を「選んだまま」にする（Keynote と同じ）。
// 選んでいる間は Enter でもう一度編集、Esc で選択を外す、↑↓・Tab で前後の要素へ
function commitAndPick(commit = true) {
  const ed = state.editing;
  if (!ed) return null;
  const loc = { ...locatorOf(ed.el), page: state.current };
  const r = finishEdit(commit);
  state.picked = loc;
  paintPick();
  return r;
}
function pickedEl() {
  if (!state.picked || state.picked.page !== state.current) return null;
  return findEditable(state.picked);
}
function paintPick() {
  $('#stage').querySelectorAll('.mj-picked').forEach((e) => e.classList.remove('mj-picked'));
  const el = pickedEl();
  if (el) el.classList.add('mj-picked'); else state.picked = null;
}
function clearPick() { state.picked = null; paintPick(); }
function movePick(dir) {
  const sec = $('#stage section');
  const list = sec ? [...sec.querySelectorAll('.mj-editable')].filter((e) => e.getClientRects().length) : [];
  if (!list.length) return;
  const cur = pickedEl();
  const i = cur ? list.indexOf(cur) : -1;
  const next = list[Math.max(0, Math.min(list.length - 1, i + dir))];
  state.picked = { ...locatorOf(next), page: state.current };
  paintPick();
  next.scrollIntoView({ block: 'nearest' });
}

// 編集中の要素の外を押したら確定する（blur が来ない場合もあるので、押した時点で判断する）
document.addEventListener('mousedown', (e) => {
  if (state.picked && !e.target.closest?.('#stage .mj-picked')) clearPick();
  const ed = state.editing;
  if (!ed || ed.el.contains(e.target) || e.target.closest?.('#format-bar, #table-bar')) return;
  if (e.target.closest?.('#stage .mj-editable')) return; // 別の文字へ移るときは startEdit が確定する
  finishEdit(true);
}, true);

const stage = $('#stage');
// メモの「選択した要素」：ステージで最後に押した要素（元の行と先頭の文字）
const PICK_KIND = { IMG: '図', TABLE: '表', UL: '箇条書き', OL: '番号付きリスト', P: '段落', H1: 'タイトル', PRE: 'コード', BLOCKQUOTE: '補足', LI: '項目', FIGURE: '図' };
stage.addEventListener('mousedown', (e) => {
  const el = e.target.closest('[data-line]');
  if (!el || !stage.contains(el)) return;
  const img = e.target.closest('img');
  const text = img ? (img.getAttribute('src') || '').replace(/[?#].*$/, '') : el.textContent.replace(/\s+/g, ' ').trim();
  const kind = img ? '図' : PICK_KIND[el.tagName] || [...el.classList].find((c) => !c.startsWith('mj-')) || '要素';
  state.lastPick = { slide: state.current, line: Number(el.dataset.line.split('-')[0]), kind, text: text.slice(0, 80) };
  if (state.sourceOpen) revealLine(state.lastPick.line, 'center', true); // 分割のとき、左をその行へ
  if (state.inspTab === 'notes' && document.activeElement?.id !== 'note-draft') renderInspector();
}, true);
stage.addEventListener('mousedown', (e) => {
  if (state.editing?.el.contains(e.target)) return; // 編集中の要素の中はふつうにカーソル移動
  const el = e.target.closest(EDITABLE);
  if (!el || !el.classList.contains('mj-editable')) return;
  const k = renderedOffsetAt(el, e.clientX, e.clientY);
  e.preventDefault();
  startEdit(el, { rendered: k });
});
stage.addEventListener('dblclick', (e) => {
  const img = e.target.closest('img');
  if (!img || !/\.svg(\?|$)/i.test(img.getAttribute('src') || '')) return;
  finishEdit(true);
  openSvgEditor({ src: img.getAttribute('src'), modal: $('#modal'), toast, onSaved: () => { state.figVersion = Date.now(); checkCache.clear(); render(); }, checkPage: () => state.stageCheck });
});

function wrapSelection(before, after = before, placeholder = '') {
  const sel = getSelection();
  const text = sel.toString() || placeholder;
  document.execCommand('insertText', false, `${before}${text}${after}`);
  // 挿入した文字（プレースホルダー）を選び直す
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const node = r.startContainer;
  if (node.nodeType === 3 && text) {
    const end = r.startOffset - after.length;
    const nr = document.createRange();
    nr.setStart(node, Math.max(0, end - text.length)); nr.setEnd(node, Math.max(0, end));
    sel.removeAllRanges(); sel.addRange(nr);
  }
}
function formatCmd(cmd) {
  if (!state.editing) return;
  if (cmd === 'bold') wrapSelection('**', '**', '太字');
  if (cmd === 'italic') wrapSelection('*', '*', '斜体');
  if (cmd === 'code') wrapSelection('`', '`', 'code');
  if (cmd === 'link') {
    const t = getSelection().toString() || 'リンク';
    document.execCommand('insertText', false, `[${t}](https://)`);
  }
}

stage.addEventListener('keydown', (e) => {
  const ed = state.editing;
  if (!ed) return;
  // 編集で使うキーは、画面全体のショートカット（Enterでタイトル編集・⌫でページ削除など）へ渡さない
  if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'].includes(e.key) || (mod(e) && /^[bikc]$/i.test(e.key))) e.stopPropagation();
  const { el, target } = ed;
  if (e.key === 'Escape') { e.preventDefault(); commitAndPick(false); return; }
  if (mod(e) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitAndPick(true); return; }
  if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); formatCmd('bold'); return; }
  if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); formatCmd('italic'); return; }
  if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); formatCmd('link'); return; }
  if (mod(e) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); formatCmd('code'); return; }

  // 表：Enterで確定、Tab / ⇧Tabで隣のセルへ
  if (target.kind === 'cell') {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitAndPick(true); return; }
    if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); return; } // セルの中の改行（<br> になる）
    if (e.key === 'Tab') { e.preventDefault(); moveCell(e.shiftKey ? -1 : 1); return; }
    return;
  }
  // リスト：Enterで確定、⇧Enterで次の項目（空の項目で⇧Enterなら終わり）、Tabで字下げ、空でBackspaceなら項目を消す
  // 押しっぱなしだけを抑止する。描画は同期で終わるので、次の入力を時間で捨てない。
  if (el.matches('li') && e.key === 'Enter' && e.shiftKey && e.repeat) {
    e.preventDefault();
    return;
  }
  if (ed.isItem) {
    const value = restoreBreaks(plainValue(el), ed.breaks || [], false);
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitAndPick(true); return; }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      if (!value.trim()) { finishEdit(false); const next = removeListItem(state.text, target.start, target.end); setText(next, { label: 'リスト項目の削除' }); return; }
      const committed = finishEdit(true) ?? state.text;
      const r = insertListItemAfter(committed, target.start, target.start + value.split('\n').length);
      if (!r) return;
      setText(r.text, { label: 'リスト項目の追加' });
      const n = findEditable({ line: r.line }); if (n) startEdit(n, { offset: 'end' });
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const committed = finishEdit(true) ?? state.text;
      const next = indentListItem(committed, target.start, target.start + value.split('\n').length, e.shiftKey ? -1 : 1);
      if (!next) return;
      setText(next, { label: e.shiftKey ? '字下げの解除' : '字下げ' });
      const n = findEditable({ line: target.start }); if (n) startEdit(n, { offset: 'end' });
      return;
    }
    if (e.key === 'Backspace' && !value) {
      e.preventDefault();
      finishEdit(false);
      setText(removeListItem(state.text, target.start, target.end), { label: 'リスト項目の削除' });
      return;
    }
  }
  // Enterは確定だけ。改行は⇧Enter（見出しなど1行で書く要素では <br> として入る）
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitAndPick(true); return; }
  if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
  if (e.key === 'Tab') { e.preventDefault(); }
});
// 貼り付けは書式を落として文字だけ（画像は別の処理）
stage.addEventListener('paste', (e) => {
  if (!state.editing) return;
  if ([...e.clipboardData.items].some((i) => i.kind === 'file')) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});

function moveCell(delta) {
  const ed = state.editing;
  const { row, col } = ed.target;
  const tr = ed.el.closest('tr');
  const table = tr.closest('table');
  const rows = [...table.rows];
  let r = rows.indexOf(tr), c = col + delta;
  if (c >= tr.cells.length) { r++; c = 0; }
  if (c < 0) { r--; c = (rows[r]?.cells.length || 1) - 1; }
  const targetRow = rows[r] ? Number(rows[r].dataset.line?.split('-')[0]) : null;
  finishEdit(true);
  if (targetRow == null || Number.isNaN(targetRow)) return;
  requestAnimationFrame(() => { const n = findEditable({ row: targetRow, col: c }); if (n) startEdit(n, { offset: 'all' }); });
}

// --- 編集中に出す小さなツールバー（書式・表） -----------------------------------------------
function showBars(el) {
  // スライドの文字に重ならないよう、ステージの上の余白にまとめて出す
  const fb = $('#format-bar');
  const st = $('#stage').getBoundingClientRect();
  fb.innerHTML = [['bold', '太字（⌘B）', '<b>B</b>'], ['italic', '斜体（⌘I）', '<i>I</i>'], ['code', 'コード（⌘⇧C）', icon('code', 14)], ['link', 'リンク（⌘K）', icon('link', 14)]]
    .map(([c, t, h]) => `<button type="button" data-f="${c}" title="${t}" tabindex="-1">${h}</button>`).join('')
    + '<span class="mj-bar-hint">Markdownで直しています　Enter・⌘⏎で確定　Escで取り消し</span>';
  fb.hidden = false;
  fb.style.left = `${st.left}px`;
  fb.style.top = `${Math.max(50, st.top - 40)}px`;
  const tb = $('#table-bar');
  if (!el.closest('td, th')) { tb.hidden = true; return; }
  tb.innerHTML = [['row-above', '上に行', 'rowAbove'], ['row-below', '下に行', 'rowBelow'], ['col-left', '左に列', 'colLeft'], ['col-right', '右に列', 'colRight']]
    .map(([op, t, ic]) => `<button type="button" data-op="${op}" tabindex="-1">${icon(ic, 14)}<span>${t}</span></button>`).join('')
    + '<span class="mj-bar-sep"></span>'
    + [['row-delete', '行を削除'], ['col-delete', '列を削除']].map(([op, t]) => `<button type="button" data-op="${op}" class="is-danger" tabindex="-1">${icon('trash', 14)}<span>${t}</span></button>`).join('');
  tb.hidden = false;
  tb.style.left = '0px';
  tb.style.top = `${Math.max(50, st.top - 40)}px`;
  requestAnimationFrame(() => { tb.style.left = `${st.right - tb.offsetWidth}px`; });
}
function hideBars() { $('#format-bar').hidden = true; $('#table-bar').hidden = true; }
$('#format-bar').addEventListener('mousedown', (e) => { e.preventDefault(); const f = e.target.closest('[data-f]')?.dataset.f; if (f) formatCmd(f); });
$('#table-bar').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const op = e.target.closest('[data-op]')?.dataset.op;
  const ed = state.editing;
  if (!op || !ed || ed.target.kind !== 'cell') return;
  const { row, col } = ed.target;
  const base = finishEdit(true) ?? state.text;
  const r = tableOp(base, row, col, op);
  if (!r) return toast(op === 'row-delete' ? '見出しの行と最後の1行は消せません' : 'この操作はできません');
  setText(r.text, { label: '表の編集' });
  requestAnimationFrame(() => { const n = findEditable({ row: r.row, col: r.col }); if (n) startEdit(n, { offset: 'all' }); });
});

// --- 変更・保存 --------------------------------------------------------------------
let autosaveTimer, draftTimer, closePending = false, composing = false;
window.addEventListener('compositionstart', () => { composing = true; }, true);
window.addEventListener('compositionend', () => { composing = false; if (state.autosave) { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => save({ auto: true }), 1200); } }, true);
function setText(next, { fromSource = false, key = null, label = '', keepInspector = false } = {}) {
  flushPendingNote();
  if (next === state.text) return;
  pushHistory(key);
  state.text = next;
  render({ keepInspector });
  if (!fromSource) syncSourceEditor();
  afterChange(label);
}
function afterChange() {
  updateHistoryButtons();
  updateStatus();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 600);
  if (state.autosave && !closePending) { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => save({ auto: true }), 1200); }
}
function draftText() {
  let text = state.text;
  if (state.editing) {
    const ed = state.editing;
    const next = ed.target.apply(restoreBreaks(plainValue(ed.el), ed.breaks || [], ed.single));
    if (next != null) text = next;
  } else if (cm && state.sourceOpen) {
    text = cm.state.doc.toString();
  }
  if (pendingNote) {
    const r = state.ranges[pendingNote.page];
    if (r) {
      const lines = text.split('\n');
      const slide = lines.slice(r.start, r.end);
      const next = setSlideNote(slide, pendingNote.value);
      text = [...lines.slice(0, r.start), ...next, ...lines.slice(r.end)].join('\n');
    }
  }
  return text;
}
const dirty = () => draftText() !== state.saved;
function updateStatus() {
  $('#status').textContent = !online ? 'オフライン（下書きに退避中）' : dirty() ? '編集済み' : '保存済み';
  $('#status').classList.toggle('is-dirty', dirty());
  const source=draftText();
  const front=source.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let title=front?.[1].match(/^title:\s*(.+)$/m)?.[1]?.trim();
  if(title?.startsWith('"')) {try{title=JSON.parse(title);}catch{}}
  else if(title?.startsWith("'") && title.endsWith("'")) title=title.slice(1,-1).replaceAll("''", "'");
  title ||= source.slice(front?.[0].length||0).match(/^# +(.+)$/m)?.[1]?.trim() || state.name || 'MarpKit';
  document.title = `${dirty() || (typeof window.__figureDirty==='function' && window.__figureDirty()) ? '● ' : ''}${title} — MarpKit`;
  $('#file-name').textContent=title;
}
window.addEventListener('figure-dirty-changed', updateStatus);
async function sha1(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
let saving = null;
async function saveEverything() {
  if (typeof window.__figureSave === 'function') {
    const ok = await Promise.race([
      window.__figureSave(),
      new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
    ]);
    if (ok === false) return false;
  }
  return save();
}

async function save({ force = false, auto = false } = {}) {
  if (auto && closePending) return false;
  if (auto && (composing || cm?.composing || state.editing)) {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => save({ auto: true }), 1200);
    return false;
  }
  // 分割の左・発表者ノートの未確定を先に確定する（D05・D11）
  flushSource();
  flushPendingNote();
  // 自動保存は、未保存の変更があるときだけ動かす（外部の変更をそのまま書き戻さない）
  if (auto && !dirty()) return true;
  // 自動保存は編集中の要素を確定しない。確定すると入力が途切れる（D03）
  if (auto && state.editing) {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => save({ auto: true }), 1200);
    return false;
  }
  if (!auto) finishEdit(true);
  if (saving) {
    if (!(await saving)) return false;
    return dirty() ? save({ force, auto }) : true;
  }
  const text = state.text;
  saving = (async () => {
    let r;
    try { r = await saveDeck({ text, base: state.baseHash, force }); }
    catch { saveDraft(); toast('接続できないため保存できませんでした。編集は下書きに残っています', 'error'); return false; }
    if (r.status === 409) {
      showConflict(r.conflict.text, r.conflict.hash);
      return false;
    }
    if (!r.ok) { toast('保存できませんでした', 'error'); return false; }
    state.saved = text;
    state.baseHash = r.hash;
    refreshHistory();
    if (dirty()) saveDraft(); else clearDraft();
    if (!draftOffer) hideBanner();
    updateStatus();
    if (!auto) toast('保存しました');
    return true;
  })();
  try { return await saving; } finally { saving = null; }
}

// 下書き（ブラウザが落ちても未保存の編集を失わない）
const draftKey = () => `mj-draft:${state.file}`;
function flushSource() {
  if (cmTimer) { clearTimeout(cmTimer); cmTimer = null; }
  if (cm && state.sourceOpen) {
    const text = cm.state.doc.toString();
    if (text !== state.text) setText(text, { fromSource: true, key: 'source' });
  }
}

let lastDraft, discardOnClose = false, draftQueue = Promise.resolve();
function enqueueDraft(signature, write) {
  if (lastDraft === signature) return draftQueue;
  lastDraft = signature;
  draftQueue = draftQueue.catch(() => {}).then(write).catch((error) => {
    lastDraft = undefined;
    toast('下書きを保存できませんでした。フォルダの権限と空き容量を確かめてください', 'error');
    console.error(error);
  });
  return draftQueue;
}
async function saveDraft() {
  if (discardOnClose) return draftQueue;
  const text = draftText();
  // 復元の案内を出している間は、まだ答えていない下書きを消さない
  if (draftOffer && text === state.saved) return draftQueue;
  if (text === state.saved) return clearDraft();
  const data = { text, base: state.baseHash, at: Date.now(), pendingRecovery: !!draftOffer };
  return enqueueDraft(JSON.stringify([text, data.base, data.pendingRecovery]), async () => {
    if (inTauri) {
      const result = await draftSet(data);
      if (result?.ok === false) throw new Error(result.data?.error);
    } else localStorage.setItem(draftKey() + (data.pendingRecovery ? ":pending" : ""), JSON.stringify(data));
  });
}
async function clearDraft() {
  const pendingRecovery = !!draftOffer;
  return enqueueDraft(pendingRecovery ? "clear-pending" : null, async () => {
    if (inTauri) {
      const result = await draftClear({ pendingRecovery });
      if (result?.ok === false) throw new Error(result.data?.error);
    } else {
      if (!pendingRecovery) localStorage.removeItem(draftKey());
      localStorage.removeItem(draftKey() + ":pending");
    }
  });
}
let draftOffer = null;
async function offerDraft() {
  let d = null;
  if (inTauri) d = await draftGet();
  else { try {
    const pending = localStorage.getItem(draftKey() + ':pending');
    if (!localStorage.getItem(draftKey()) && pending) { localStorage.setItem(draftKey(), pending); localStorage.removeItem(draftKey() + ':pending'); }
    d = JSON.parse(localStorage.getItem(draftKey()) || 'null');
  } catch { d = null; } }
  if (!d || d.text === state.text) return clearDraft();
  draftOffer = d;
  const when = new Date(d.at).toLocaleString('ja-JP');
  const changed = d.base && d.base !== state.baseHash;
  showBannerHtml(`<span>前回（${esc(when)}）の未保存の編集が残っています。${changed ? 'ファイルはその後変更されています。' : ''}</span>
    <button type="button" data-b="restore" class="mj-primary">復元する</button><button type="button" data-b="discard">破棄する</button>`, (act) => {
    if (act === 'restore') { draftOffer = null; setText(d.text, { label: '下書きの復元' }); toast('下書きを復元しました（未保存）'); }
    if (act === 'discard') { draftOffer = null; clearDraft(); }
    hideBanner();
  });
}

// --- 分割編集（左にファイル全体のMarkdown、右に今のページ） ------------------------------
// 左で打つとすぐ右が描き直り、カーソルのあるページへ右が切り替わる。右で直した内容や、一覧・ページ操作も左へ返す。
// 右のスライドで要素を押すと、左はその行へ移る。今のページの行は左で薄く塗る。
let cm, cmSilent = false, cmTimer;
function slideLines(i = state.current) {
  const r = state.ranges[i];
  return state.text.split('\n').slice(r.start, r.end);
}
function replaceSlideLines(newLines, i = state.current) {
  const lines = state.text.split('\n');
  const r = state.ranges[i];
  lines.splice(r.start, r.end - r.start, ...newLines);
  return lines.join('\n');
}
const setPageRange = StateEffect.define();
const pageField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setPageRange)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
function pageDeco(doc, r) {
  const b = new RangeSetBuilder();
  if (r) for (let l = r.start + 1; l <= Math.min(r.end, doc.lines); l++) { const line = doc.line(l); b.add(line.from, line.from, Decoration.line({ class: 'mj-source-page' })); }
  return b.finish();
}
// 先頭のフロントマター（--- で囲んだ設定）を1つの塊として読む。これがないと、閉じの --- で上の行が見出し扱いになる
const frontMatter = {
  defineNodes: [{ name: 'FrontMatter', block: true }],
  parseBlock: [{
    name: 'FrontMatter', before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || line.text !== '---') return false;
      const from = cx.lineStart;
      while (cx.nextLine()) if (line.text === '---') { cx.nextLine(); break; }
      cx.addElement(cx.elt('FrontMatter', from, cx.prevLineEnd()));
      return true;
    },
  }],
};
const pageOfLine = (line) => {
  const r = state.ranges;
  for (let i = r.length - 1; i >= 0; i--) if (line >= r[i].start) return i;
  return 0;
};
function ensureSource() {
  if (cm) return;
  cm = new EditorView({
    parent: $('#source'),
    extensions: [basicSetup, cmMarkdown({ extensions: [frontMatter] }), EditorView.lineWrapping, pageField, EditorView.updateListener.of((u) => {
      if (cmSilent) return;
      if (u.docChanged) {
        clearTimeout(cmTimer);
        cmTimer = setTimeout(() => {
          cmTimer = null;
          setText(cm.state.doc.toString(), { fromSource: true, key: 'source', label: 'Markdownの編集' });
          followCursor();
        }, 16);
      } else if (u.selectionSet) followCursor();
    })],
  });
}
// 左のカーソルがあるページを右に出す
function followCursor() {
  if (!cm || state.text !== cm.state.doc.toString()) return;
  const line = cm.state.doc.lineAt(cm.state.selection.main.head).number - 1;
  const i = pageOfLine(line);
  if (i !== state.current) go(i, { fromSource: true });
  else paintPageRange();
}
function paintPageRange() {
  if (!cm) return;
  cmSilent = true;
  cm.dispatch({ effects: setPageRange.of(pageDeco(cm.state.doc, state.ranges[state.current])) });
  cmSilent = false;
}
// 右の変更を左へ返す。変わった区間だけ差し替えるので、左のカーソルと表示位置は動かない
function syncSourceEditor({ scroll = false } = {}) {
  if (!cm || !state.sourceOpen) return;
  const cur = cm.state.doc.toString(), next = state.text;
  if (cur !== next) {
    let a = 0;
    const max = Math.min(cur.length, next.length);
    while (a < max && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
    cmSilent = true;
    cm.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) } });
    cmSilent = false;
  }
  paintPageRange();
  // 左以外（ページ検索・要確認・メモ・ページ操作など）でページが変わったら、左もそのページの先頭へ。
  // カーソルも移すので、左がもとのページへ引き戻すことはない
  if (scroll) {
    const r = state.ranges[state.current];
    const head = cm.state.doc.lineAt(cm.state.selection.main.head).number - 1;
    if (r && (head < r.start || head >= r.end)) revealLine(r.start, 'start', true);
  }
}
function revealLine(line, y = 'center', select = false) {
  if (!cm) return;
  const l = cm.state.doc.line(Math.min(Math.max(line + 1, 1), cm.state.doc.lines));
  cmSilent = true;
  cm.dispatch({ ...(select ? { selection: EditorSelection.cursor(l.from) } : {}), effects: EditorView.scrollIntoView(l.from, { y, yMargin: 48 }) });
  cmSilent = false;
}
function toggleSource(open = !state.sourceOpen) {
  finishEdit(true);
  state.sourceOpen = open;
  settings.setItem('mj-view', open ? 'split' : 'slide');
  $('#source').hidden = !open;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('is-on', (b.dataset.view === 'split') === open));
  document.body.classList.toggle('is-split', open);
  if (open) { ensureSource(); syncSourceEditor(); revealLine(state.ranges[state.current]?.start ?? 0, 'start', true); requestAnimationFrame(() => cm.focus()); }
  requestAnimationFrame(renderStage);
}
// 左右の幅をドラッグで変える
{
  const bar = $('#split-bar');
  const saved = settings.getItem('mj-split-left');
  if (saved) document.body.style.setProperty('--split-left', `${saved}px`);
  bar.addEventListener('pointerdown', (e) => {
    bar.setPointerCapture(e.pointerId);
    let raf = 0;
    const move = (ev) => {
      const x = Math.min(Math.max(ev.clientX, 280), innerWidth - 560);
      document.body.style.setProperty('--split-left', `${x}px`);
      settings.setItem('mj-split-left', x);
      cancelAnimationFrame(raf); raf = requestAnimationFrame(renderStage);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', () => { bar.removeEventListener('pointermove', move); renderStage(); }, { once: true });
  });
}

// --- 左の一覧（サムネイル／見出し） ------------------------------------------------------------
let observer;
function renderLeft() {
  document.body.classList.toggle('left-outline', state.leftMode === 'outline');
  $('#btn-left').innerHTML = icon(state.leftMode === 'outline' ? 'outline' : 'thumbs', 17);
  renderThumbs();
}
function renderThumbs() {
  const list = $('#thumbs');
  const n = state.sections.length;
  while (list.children.length > n) list.lastElementChild.remove();
  while (list.children.length < n) {
    const i = list.children.length;
    const el = document.createElement('div');
    el.className = 'mj-thumb';
    el.tabIndex = 0;
    el.draggable = true;
    el.dataset.i = i;
    el.innerHTML = `<span class="mj-thumb-no"></span><span class="mj-thumb-badge" hidden>⚠</span><span class="mj-thumb-canvas"></span><span class="mj-thumb-title"></span><button type="button" class="mj-thumb-more" title="ページの操作" tabindex="-1">${icon('more', 14)}</button>`;
    list.appendChild(el);
    observer.observe(el);
  }
  for (const el of list.children) {
    const i = Number(el.dataset.i);
    el.classList.toggle('is-current', i === state.current);
    const number = el.querySelector('.mj-thumb-no'), title = el.querySelector('.mj-thumb-title');
    if (number.textContent !== String(i + 1)) number.textContent = i + 1;
    const text = state.titles[i] || '（タイトルなし）';
    if (title.textContent !== text) title.textContent = text;
    if (el.title !== (state.titles[i] || '')) el.title = state.titles[i] || '';
    if (state.leftMode === 'thumbs' && el.dataset.visible === '1') fillThumb(el);
    updateBadge(i);
  }
}
function fillThumb(el) {
  const i = Number(el.dataset.i);
  const html = state.sections[i];
  if (el._html === html && el._width === el.clientWidth) return;
  el._html = html;
  el._width = el.clientWidth;
  const w = el.clientWidth;
  if (!w) return; // 分割・集中モードで幅が 0 のときは描かない（L02）
  const s = w / 1280;
  el.querySelector('.mj-thumb-canvas').innerHTML = `<span class="mj-scale" style="transform: scale(${s})"><div class="marpit">${html}</div></span>`;
}
function updateBadge(i) {
  const el = $('#thumbs').children[i];
  if (!el) return;
  const list = state.issues[i] || [];
  const bad = list.some((x) => x.level === 'error');
  const warn = !bad && list.length > 0;
  const b = el.querySelector('.mj-thumb-badge');
  b.hidden = !bad && !warn;
  b.classList.toggle('is-warn', warn);
  b.title = list.map((x) => x.msg).join('\n');
  el.classList.toggle('has-error', bad);
}

const thumbs = $('#thumbs');
thumbs.addEventListener('click', (e) => {
  const t = e.target.closest('.mj-thumb');
  if (!t) return;
  const i = Number(t.dataset.i);
  if (e.target.closest('.mj-thumb-more')) { e.stopPropagation(); if (!isSelected(i)) { clearSelection(); go(i); } openCtxMenu(i, e.clientX, e.clientY); return; }
  // ⇧クリックで範囲、⌘クリックで1枚ずつ選ぶ（Keynote・PowerPointと同じ）
  if (e.shiftKey) {
    const a = state.anchor ?? state.current;
    state.selected = new Set(Array.from({ length: Math.abs(i - a) + 1 }, (_, k) => Math.min(a, i) + k));
    state.selected.delete(i);
    go(i, { keepSelection: true });
    return;
  }
  if (mod(e)) {
    if (i === state.current && state.selected.size) { const [j] = state.selected; state.selected.delete(j); go(j, { keepSelection: true }); }
    else if (state.selected.has(i)) state.selected.delete(i);
    else { state.selected.add(state.current); state.selected.delete(i); go(i, { keepSelection: true }); }
    paintSelection();
    return;
  }
  clearSelection();
  state.anchor = i;
  go(i);
});
const selectedPages = () => [...new Set([state.current, ...state.selected])].sort((a, b) => a - b);
const isSelected = (i) => i === state.current || state.selected.has(i);
function clearSelection() { state.selected = new Set(); paintSelection(); }
function paintSelection() {
  for (const el of thumbs.children) el.classList.toggle('is-selected', state.selected.has(Number(el.dataset.i)));
  const n = selectedPages().length;
  $('#page-no').textContent = n > 1 ? `${n}ページを選択中` : `${state.current + 1} / ${state.sections.length}`;
}
thumbs.addEventListener('contextmenu', (e) => {
  const t = e.target.closest('.mj-thumb');
  if (!t) return;
  e.preventDefault();
  const i = Number(t.dataset.i);
  // 選択済みのページを右クリックしても、ほかの選択を外さない（D16）。「…」ボタンと同じ動きにする
  if (!isSelected(i)) { clearSelection(); go(i); }
  openCtxMenu(i, e.clientX, e.clientY);
});
// 余白からドラッグで範囲選択（Keynote・PowerPoint と同じ）。囲みにかかったページを選ぶ。⇧・⌘ を押していれば今の選択に足す
let band = null;
thumbs.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.leftMode !== 'thumbs' || e.target.closest('.mj-thumb')) return;
  // スクロールバーの上は除く
  if (e.offsetX > thumbs.clientWidth) return;
  e.preventDefault();
  finishEdit(true);
  const top0 = thumbs.getBoundingClientRect().top;
  band = {
    x: e.clientX, y: e.clientY + thumbs.scrollTop - top0, cx: e.clientX, cy: e.clientY,
    base: e.shiftKey || mod(e) ? new Set(selectedPages()) : new Set(),
    el: Object.assign(document.createElement('div'), { className: 'mj-band' }),
    moved: false,
  };
  document.body.appendChild(band.el);
  thumbs.setPointerCapture(e.pointerId);
});
function paintBand() {
  const r0 = thumbs.getBoundingClientRect();
  const y0 = band.y - thumbs.scrollTop + r0.top;
  const x1 = Math.min(band.x, band.cx), x2 = Math.max(band.x, band.cx), y1 = Math.min(y0, band.cy), y2 = Math.max(y0, band.cy);
  Object.assign(band.el.style, { left: `${x1}px`, top: `${Math.max(r0.top, y1)}px`, width: `${x2 - x1}px`, height: `${Math.max(0, Math.min(r0.bottom, y2) - Math.max(r0.top, y1))}px` });
  const hit = new Set(band.base);
  for (const el of thumbs.children) {
    const r = el.getBoundingClientRect();
    if (r.bottom >= y1 && r.top <= y2 && r.right >= x1 && r.left - 24 <= x2) hit.add(Number(el.dataset.i));
  }
  const list = [...hit].sort((a, b) => a - b);
  if (!list.length) return;
  // 今のページが囲みに入っていればそのまま、外れたら選んだ最初のページを今のページにする
  const cur = list.includes(state.current) ? state.current : list[0];
  if (cur !== state.current) go(cur, { keepSelection: true, scroll: false });
  state.selected = new Set(list.filter((i) => i !== cur));
  paintSelection();
}
thumbs.addEventListener('pointermove', (e) => {
  if (!band) return;
  band.cx = e.clientX; band.cy = e.clientY;
  if (!band.moved && Math.hypot(e.clientX - band.x, e.clientY - (band.y - thumbs.scrollTop + thumbs.getBoundingClientRect().top)) < 4) return;
  band.moved = true;
  paintBand();
  // 上下の端では一覧を送る
  const r = thumbs.getBoundingClientRect();
  clearInterval(band.timer);
  const dir = e.clientY < r.top + 24 ? -1 : e.clientY > r.bottom - 24 ? 1 : 0;
  if (dir) band.timer = setInterval(() => { thumbs.scrollTop += dir * 14; paintBand(); }, 30);
});
function endBand(e) {
  if (!band) return;
  clearInterval(band.timer);
  band.el.remove();
  // 動かさずに余白を押しただけなら、選択を外す
  if (!band.moved && !band.base.size) clearSelection();
  band = null;
  try { thumbs.releasePointerCapture(e.pointerId); } catch {}
}
thumbs.addEventListener('pointerup', endBand);
thumbs.addEventListener('pointercancel', endBand);
// ドラッグで並べ替え
let dragFrom = null;
thumbs.addEventListener('dragstart', (e) => {
  const t = e.target.closest('.mj-thumb');
  if (!t) return;
  dragFrom = Number(t.dataset.i);
  if (!isSelected(dragFrom)) { clearSelection(); go(dragFrom); }
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
  t.classList.add('is-dragging');
});
thumbs.addEventListener('dragover', (e) => {
  if (dragFrom == null) return;
  const t = e.target.closest('.mj-thumb');
  if (!t) return;
  e.preventDefault();
  const r = t.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  $$('.mj-thumb.drop-before, .mj-thumb.drop-after', thumbs).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  t.classList.add(after ? 'drop-after' : 'drop-before');
});
thumbs.addEventListener('drop', (e) => {
  if (dragFrom == null) return;
  e.preventDefault();
  const t = e.target.closest('.mj-thumb');
  const after = t?.classList.contains('drop-after');
  const to = t ? Number(t.dataset.i) + (after ? 1 : 0) : state.sections.length;
  endDrag();
  multiOp('move', to);
});
thumbs.addEventListener('dragend', endDrag);
function endDrag() { dragFrom = null; $$('.mj-thumb', thumbs).forEach((x) => x.classList.remove('drop-before', 'drop-after', 'is-dragging')); }

function go(i, { scroll = true, keepEdit = false, keepSelection = false, fromSource = false } = {}) {
  flushPendingNote();
  if (!keepEdit) finishEdit(true);
  if (i < 0 || i >= state.sections.length) return;
  if (!keepSelection && state.selected.size) state.selected = new Set();
  state.current = i;
  history.replaceState(null, '', `${location.pathname}#${i + 1}`);
  renderStage();
  for (const el of thumbs.children) el.classList.toggle('is-current', Number(el.dataset.i) === i);
  if (scroll) thumbs.children[i]?.scrollIntoView({ block: 'nearest' });
  paintSelection();
  renderInspector();
  syncSourceEditor({ scroll: !fromSource });
}

// --- ページの操作 -------------------------------------------------------------------
function multiOp(op, to) {
  flushPendingNote();
  finishEdit(true);
  const pages = selectedPages();
  const r = slidesOpMulti(state.text, op, pages, to);
  if (!r) return op === 'delete' ? toast('すべてのページは消せません') : null;
  state.current = r.current;
  setText(r.text, { label: `ページの${{ delete: '削除', duplicate: '複製', move: '移動' }[op]}` });
  state.selected = new Set(r.selected.filter((x) => x !== r.current));
  go(r.current, { keepSelection: true });
  if (op === 'delete') {
    const mark = hist.past.length;
    toast(`${pages.length}ページを削除しました`, 'info', [{ label: '元に戻す', run: () => { if (hist.past.length !== mark) return toast('ほかの編集のあとなので ⌘Z で戻してください', 'error'); undo(); } }]);
  }
}
function pageOp(op, i = state.current, j) {
  flushPendingNote();
  if ((op === 'delete' || op === 'duplicate') && selectedPages().length > 1) return multiOp(op);
  finishEdit(true);
  const next = slideOp(state.text, op, i, j);
  if (next == null) return toast(op === 'delete' ? '最後の1ページは消せません' : 'この操作はできません');
  const labels = { duplicate: 'ページの複製', delete: 'ページの削除', move: 'ページの移動', blank: 'ページの追加' };
  state.current = op === 'delete' ? Math.min(i, state.sections.length - 2) : op === 'move' ? j : i + 1;
  setText(next, { label: labels[op] });
  go(state.current);
  if (op === 'delete') {
    const mark = hist.past.length;
    toast('ページを削除しました', 'info', [{ label: '元に戻す', run: () => { if (hist.past.length !== mark) return toast('ほかの編集のあとなので ⌘Z で戻してください', 'error'); undo(); } }]);
  }
  clearSelection();
}
function openCtxMenu(i, x, y) {
  const m = $('#ctx-menu');
  const n = state.sections.length;
  m.innerHTML = `
    <button type="button" data-c="blank">${icon('plus', 14)} 後ろに新しいページ<kbd>⌥N</kbd></button>
    <button type="button" data-c="insert">${icon('plus', 14)} 後ろに部品のページ…</button>
    <button type="button" data-c="duplicate">${icon('copy', 14)} 複製<kbd>${isMac ? '⌘' : 'Ctrl+'}D</kbd></button>
    <hr>
    <button type="button" data-c="cut">${icon('copy', 14)} 切り取り<kbd>${isMac ? '⌘' : 'Ctrl+'}X</kbd></button>
    <button type="button" data-c="copy">${icon('copy', 14)} コピー<kbd>${isMac ? '⌘' : 'Ctrl+'}C</kbd></button>
    <button type="button" data-c="paste">${icon('plus', 14)} 後ろに貼り付け<kbd>${isMac ? '⌘' : 'Ctrl+'}V</kbd></button>
    <button type="button" data-c="send">${icon('copy', 14)} 別の資料へコピー…</button>
    <hr>
    <button type="button" data-c="up" ${i === 0 ? 'disabled' : ''}>${icon('up', 14)} 上へ移動<kbd>⌥↑</kbd></button>
    <button type="button" data-c="down" ${i === n - 1 ? 'disabled' : ''}>${icon('down', 14)} 下へ移動<kbd>⌥↓</kbd></button>
    <hr>
    <button type="button" data-c="delete" class="is-danger" ${n <= 1 ? 'disabled' : ''}>${icon('trash', 14)} 削除<kbd>⌫</kbd></button>`;
  const sel = state.selected.size ? selectedPages() : [i];
  m.hidden = false;
  const w = 230, h = m.offsetHeight;
  m.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
  m.onclick = (e) => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (!c) return;
    m.hidden = true;
    if (c === 'up') pageOp('move', i, i - 1);
    else if (c === 'down') pageOp('move', i, i + 1);
    else if (c === 'insert') { e.stopPropagation(); openInsertMenu(); }
    else if (c === 'copy') copyPages(sel);
    else if (c === 'cut') { if (i !== state.current && !state.selected.size) go(i); cutPages(sel, (t) => navigator.clipboard.writeText(t).catch(() => {})); }
    else if (c === 'send') { e.stopPropagation(); openSendDialog(sel); }
    else if (c === 'paste') { navigator.clipboard.readText().then((t) => { if (i !== state.current) go(i); return pastePages(t); }).catch(() => toast('クリップボードを読めませんでした（⌘V で貼ってください）', 'error')); }
    else pageOp(c, i);
  };
}
document.addEventListener('click', (e) => { if (!e.target.closest('#ctx-menu')) $('#ctx-menu').hidden = true; });

// --- 全スライドの検査（画面外で等倍描画。変わったページだけ） ---------------------------------------
const checkCache = new Map();
const cacheKey = (i) => state.sections[i];
let checkTimer, checkToken = 0;
const idle = () => new Promise(resolve => {
  // WKWebView may postpone idle callbacks even with a timeout. Always yield, but
  // bound the wait so a long document's queue still makes progress in the background.
  let request;
  const done = deadline => { clearTimeout(timer); if (request != null) window.cancelIdleCallback(request); resolve(deadline); };
  const timer = setTimeout(done, window.requestIdleCallback ? 48 : 16);
  if (window.requestIdleCallback) request = window.requestIdleCallback(done, { timeout: 32 });
});
function scheduleCheckAll() {
  clearTimeout(checkTimer);
  const token = ++checkToken;
  $('#measure').replaceChildren();
  state.issues.length = state.sections.length;
  state.checkPending = 0;
  state.sections.forEach((html, i) => {
    const hit = checkCache.get(html);
    state.issues[i] = hit;
    if (!hit && i !== state.current) state.checkPending++;
    updateBadge(i);
  });
  updateSummary();
  checkTimer = setTimeout(() => checkAll(token), 350);
}
async function checkAll(token) {
  const todo = state.sections.map((_, i) => i).filter(i => i !== state.current && !checkCache.has(state.sections[i]));
  const host = $('#measure');
  // Keep the previous whole-document image wait budget. Applying four seconds
  // to every offscreen page can make a long deck take minutes in WKWebView.
  const imageDeadline = performance.now() + 4000;
  let sliceEnd = 0, slicePages = 0;
  while (todo.length && token === checkToken) {
    if (slicePages >= 4 || performance.now() >= sliceEnd) {
      const deadline = await idle();
      sliceEnd = performance.now() + Math.min(8, deadline?.timeRemaining() || 8);
      slicePages = 0;
    }
    if (token !== checkToken) return;
    slicePages++;
    // Scrolling or switching slides can change priority while this queue is running.
    const visible = todo.findIndex(i => i === state.current || $('#thumbs').children[i]?.dataset.visible === '1');
    const i = todo.splice(visible < 0 ? 0 : visible, 1)[0], html = state.sections[i];
    state.checkPending = todo.length + 1;
    if (!html) continue;
    const hit = checkCache.get(html);
    if (hit) { state.issues[i] = hit; updateBadge(i); state.checkPending = todo.length; continue; }
    host.innerHTML = `<div class="marpit">${html}</div>`;
    const images = [...host.querySelectorAll('img')].filter(img => !img.complete);
    const remaining = imageDeadline - performance.now();
    if (images.length && remaining > 0) {
      let timeout;
      await Promise.race([
        Promise.all(images.map(img => img.decode().catch(() => {}))),
        new Promise(resolve => { timeout = setTimeout(resolve, remaining); }),
      ]);
      clearTimeout(timeout);
      if (token !== checkToken) return;
      // Decoding may finish during a key event. Yield before forcing layout.
      await idle();
      if (token !== checkToken) return;
      sliceEnd = performance.now() + 8;
      slicePages = 0;
    }
    const section = host.querySelector('section');
    if (section && state.sections[i] === html) {
      const issues = checkSection(section, 1).map(({ el, ...rest }) => rest);
      state.issues[i] = issues;
      checkCache.set(html, issues);
      updateBadge(i);
    }
    host.replaceChildren();
    state.checkPending = todo.length;
    updateSummary();
  }
  if (token !== checkToken) return;
  state.checkPending = 0;
  if (checkCache.size > 2000) checkCache.clear();
  updateSummary();
}
function updateSummary() {
  const errs = state.issues.filter((l) => l?.some((x) => x.level === 'error')).length;
  const warns = state.issues.filter((l) => l?.length && !l.some((x) => x.level === 'error')).length;
  const s = $('#summary');
  s.hidden = !(errs || warns);
  s.textContent = errs || warns ? `⚠ 見切れ ${errs + warns}ページ` : '';
  const more = document.querySelector('[data-more="summary"]');
  more.textContent = s.textContent || (state.checkPending ? '見切れを確認中…' : '見切れはありません');
  more.disabled = !(errs || warns);
  s.title = errs || warns ? `要修正 ${errs}・注意 ${warns}。メニューからページへ移動` : '';
  s.classList.toggle('is-bad', errs > 0);
  s.classList.toggle('is-warn', !errs && warns > 0);
}
// 要確認のページを順に回る
$('#btn-next-issue').addEventListener('click', () => {
  $('#issues-menu').hidden = true;
  const n = state.sections.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.current + k) % n;
    if (state.issues[i]?.length) return go(i);
  }
  toast('要確認のページはありません');
});

// --- インスペクタ -------------------------------------------------------------------
const KINDS = [['', '本文'], ['cover', '表紙'], ['divider', '章扉'], ['closing', '裏表紙']];
const LEADS = [['', '既定'], ['lead-s', '小さめ'], ['lead-m', '標準'], ['lead-l', '大きめ'], ['lead-11', 'さらに小さめ'], ['lead-1', '最小']];
const SCALE_LABEL = { scale: '部品の倍率', dialogue: '掛け合い', purpose: '対象と目的', agenda: 'アジェンダ', band: '帯', speech: '語りかけ', scene: '場面図', flow: '流れ', compare: '比較', profile: '自己紹介', links: 'リンク', prose: '語り', bullets: '箇条書き' };

const notes = createNotes({ state, go: (i) => go(i), toast });
notes.onChange = (force) => {
  // Loading repair notes must not replace a speaker-note field while it is being typed into.
  if (document.activeElement?.id === 'note') return;
  // 入力中は組み直さず、保存状態の表示だけ変える（メモの追加・削除では組み直してフォーカスを戻す）
  if (force && document.activeElement?.id === 'note-draft') { renderInspector(); $('#note-draft')?.focus(); return; }
  if (document.activeElement?.id === 'note-draft') {
    const st = $('#inspector .mj-notes-status');
    if (st) { st.className = `mj-notes-status is-${notes.data.status}`; st.textContent = { saving: 'ローカルへ保存中…', saved: 'ローカルに保存済み', error: 'ローカル保存に失敗しました。次の編集時に再試行します。', loading: 'メモを読み込み中…' }[notes.data.status]; }
    return;
  }
  renderInspector();
};
const historyPanel = createHistory({ state, render: (md) => marp.render(md), setText: (t, o) => setText(t, o), save: () => save(), dirty: () => dirty(), go: (i) => go(i), toast, modal: $('#modal') });
historyPanel.onChange = () => { if (state.inspTab === 'history' && !document.activeElement?.closest?.('#inspector input')) renderInspector(); };
// 履歴は保存や外部の変更のあとに少し待ってから読み直す（サーバーが記録し終えてから）
let histTimer;
function refreshHistory() { if (state.inspTab !== 'history') return; clearTimeout(histTimer); histTimer = setTimeout(() => historyPanel.load(), 700); }
state.inspTab = settings.getItem('mj-insp-tab') || 'page';
function inspectorTabs() {
  return `<div class="mj-insp-tabs" role="tablist">
    <button type="button" role="tab" data-tab="page" class="${state.inspTab === 'page' ? 'is-active' : ''}">編集</button>
    <button type="button" role="tab" data-tab="notes" class="${state.inspTab === 'notes' ? 'is-active' : ''}">メモ${notes.count ? `<span class="mj-badge">${notes.count}</span>` : ''}</button>
    <button type="button" role="tab" data-tab="history" class="${state.inspTab === 'history' ? 'is-active' : ''}">履歴</button>
  </div>`;
}
function bindTabs() {
  $('#inspector').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.inspTab = b.dataset.tab; settings.setItem('mj-insp-tab', state.inspTab); renderInspector();
    if (state.inspTab === 'history') historyPanel.load();
  }));
}


// 読み込み完了とクリックが重なっても、タブの要素とフォーカスを保つ。
function renderInspectorContent(html) {
  const insp = $('#inspector');
  let tabs = insp.querySelector('.mj-insp-tabs');
  if (!tabs) {
    insp.innerHTML = inspectorTabs();
    tabs = insp.querySelector('.mj-insp-tabs');
    bindTabs();
  }
  for (const child of [...insp.childNodes]) if (child !== tabs) child.remove();
  for (const button of tabs.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === state.inspTab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  }
  const notesButton = tabs.querySelector('[data-tab="notes"]');
  let badge = notesButton.querySelector('.mj-badge');
  if (notes.count) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'mj-badge'; notesButton.append(badge); }
    badge.textContent = String(notes.count);
  } else badge?.remove();
  insp.insertAdjacentHTML('beforeend', html);
}

function renderInspector() {
  if (!state.ranges[state.current]) return;
  if (state.inspTab === 'history') {
    renderInspectorContent(historyPanel.html());
    historyPanel.bind($('#inspector'));
    return;
  }
  if (state.inspTab === 'notes') {
    renderInspectorContent(notes.html());
    notes.bind($('#inspector'));
    return;
  }
  const meta = readSlideMeta(slideLines());
  const cls = meta.classes;
  const kind = KINDS.find(([k]) => k && cls.includes(k))?.[0] || '';
  const lead = LEADS.find(([k]) => k && cls.includes(k))?.[0] || '';
  const others = cls.filter((c) => !['cover', 'divider', 'closing', 'back-cover', 'centered', 'full', ...LEADS.map(([k]) => k)].includes(c));
  const title = state.titles[state.current];
  renderInspectorContent(`
    <section class="mj-panel">
      <h2>このページ <span class="mj-muted">P.${state.current + 1}</span></h2>
      ${title ? `<p class="mj-page-title">${esc(title)}</p>` : ''}
      <label class="mj-row">種類 <select data-k="kind">${KINDS.map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="mj-row">リード文の大きさ <select data-k="lead">${LEADS.map(([k, v]) => `<option value="${k}" ${k === lead ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="mj-check"><input type="checkbox" data-k="centered" ${cls.includes('centered') ? 'checked' : ''}> 本文を縦中央に</label>
      <label class="mj-check"><input type="checkbox" data-k="full" ${cls.includes('full') ? 'checked' : ''}> 画像を全面に（フッターなし）</label>
      ${others.length ? `<details><summary>詳しい設定</summary><p class="mj-muted">Markdown での指定：${esc(others.join(' '))}</p></details>` : ''}
      <div class="mj-page-ops">
        <button type="button" data-p="duplicate" title="複製（⌘D）">${icon('copy', 14)} 複製</button>
        <button type="button" data-p="up" title="上へ（⌥↑）" ${state.current === 0 ? 'disabled' : ''}>${icon('up', 14)}</button>
        <button type="button" data-p="down" title="下へ（⌥↓）" ${state.current === state.sections.length - 1 ? 'disabled' : ''}>${icon('down', 14)}</button>
        <button type="button" data-p="delete" class="is-danger" title="削除（⌫）">${icon('trash', 14)}</button>
      </div>
    </section>
    ${meta.scales.length || meta.images.length ? `<section class="mj-panel"><h2>大きさ</h2>
      ${meta.scales.map((x, k) => `<label class="mj-slider">${SCALE_LABEL[x.name] || x.name}<input type="range" min="0.6" max="1.8" step="0.01" value="${x.value}" data-scale="${k}"><output>${x.value.toFixed(2)}</output></label>`).join('')}
      ${meta.images.map((x, k) => `<label class="mj-slider" title="${esc(x.src)}">図の高さ<input type="range" min="120" max="560" step="1" value="${x.height ?? 380}" data-img="${k}"><output>${x.height ?? '—'}px</output></label>`).join('')}
    </section>` : ''}
    <section class="mj-panel">
      <h2>発表者ノート</h2>
      <textarea id="note" rows="7" placeholder="話すこと・出典など">${esc(meta.notes[0] || '')}</textarea>
    </section>
    <section class="mj-panel">
      <h2>見切れ</h2>
      <div id="issue-list"></div>
      <button type="button" id="btn-check-all" class="mj-wide">全ページの見切れと文章を確かめる</button>
      ${inTauri?'<small>アプリの表示・書き出しに合わせて検査します。Chrome では文字の折り返しが変わることがあります。</small>':''}
      <div id="full-check"></div>
    </section>`);
  const insp = $('#inspector');
  const applyClasses = () => {
    const k = insp.querySelector('[data-k="kind"]').value;
    const l = insp.querySelector('[data-k="lead"]').value;
    const coverStyle = k === 'cover' && kind !== 'cover' ? 'cover-talk' : '';
    const retained = others.filter(c => c !== 'cover-talk' || k === 'cover');
    const next = [k, coverStyle, k === 'closing' ? 'back-cover' : '', insp.querySelector('[data-k="centered"]').checked ? 'centered' : '', insp.querySelector('[data-k="full"]').checked ? 'full' : '', l, ...retained].filter(Boolean);
    setText(replaceSlideLines(setSlideClasses(slideLines(), next)), { label: 'ページの設定', keepInspector: true });
  };
  insp.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', applyClasses));
  insp.querySelectorAll('[data-p]').forEach((el) => el.addEventListener('click', () => {
    const p = el.dataset.p;
    if (p === 'up') pageOp('move', state.current, state.current - 1);
    else if (p === 'down') pageOp('move', state.current, state.current + 1);
    else pageOp(p);
  }));
  insp.querySelectorAll('[data-scale]').forEach((el) => el.addEventListener('input', () => {
    el.nextElementSibling.textContent = Number(el.value).toFixed(2);
    const item = readSlideMeta(slideLines()).scales[Number(el.dataset.scale)];
    setText(replaceSlideLines(setScale(slideLines(), item, Number(el.value))), { key: `scale:${state.current}:${el.dataset.scale}`, label: '倍率', keepInspector: true });
  }));
  insp.querySelectorAll('[data-img]').forEach((el) => el.addEventListener('input', () => {
    el.nextElementSibling.textContent = `${el.value}px`;
    const img = readSlideMeta(slideLines()).images[Number(el.dataset.img)];
    setText(replaceSlideLines(setImageHeight(slideLines(), img, Number(el.value))), { key: `img:${state.current}:${el.dataset.img}`, label: '図の高さ', keepInspector: true });
  }));
  let noteTimer;
  $('#note').addEventListener('blur', () => flushPendingNote());
  $('#note').addEventListener('input', (e) => {
    // 入力したときのページを覚える（時間が来たときの state.current ではない。D05）
    pendingNote = { page: state.current, value: e.target.value };
    saveDraft();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { flushPendingNote(); noteTimer = null; }, 300);
  });
  $('#btn-check-all').addEventListener('click', runFullCheck);
  renderIssueList();
  renderFullCheck();
}

function renderIssueList() {
  const box = $('#issue-list');
  if (!box) return;
  const list = state.issues[state.current] || [];
  box.innerHTML = list.length
    ? `<ul class="mj-issues">${list.map((x) => `<li class="is-${x.level}">${x.level === 'error' ? '✗' : '△'} ${esc(x.msg)}</li>`).join('')}</ul>`
    : '<p class="mj-ok">このページは見切れなし</p>';
}

let fullResult = null;
async function runFullCheck() {
  const st = await runtimeStatus();
  if (!st.native && (!st.node || !st.chrome)) return toast(st.message, 'error');
  const btn = $('#btn-check-all');
  btn.disabled = true; btn.textContent = '検査中…';
  toast('全ページを検査しています…', 'info', inTauri ? [{ label: 'やめる', run: () => cancelCheck() }] : [], true);
  try {
    const r = await runDeckCheck(state.text);
    fullResult = r && r.ok === false ? { error: r.data?.error || '検査に失敗しました', detail: r.data?.detail || null } : r;
  } catch (e) { fullResult = { error: String(e) }; }
  const b = $('#btn-check-all');
  if (b) { b.disabled = false; b.textContent = '全ページの見切れと文章を確かめる'; }
  renderFullCheck();
  if (fullResult?.error) toast(fullResult.error, 'error', [{ label: '詳しい内容をコピー', run: () => navigator.clipboard?.writeText(String(fullResult.detail || fullResult.error)) }]);
  else toast(`検査が終わりました（要修正 ${fullResult?.errors ?? 0}・注意 ${fullResult?.warnings ?? 0}）`);
}
function renderFullCheck() {
  const box = $('#full-check');
  if (!box || !fullResult) return;
  if (fullResult.error) { box.innerHTML = `<p class="mj-bad">${esc(fullResult.error)}</p>`; return; }
  const { count, errors, warnings, issues } = fullResult;
  box.innerHTML = `<p class="${errors ? 'mj-bad' : 'mj-ok'}">${count}ページ中 要修正 ${errors}・注意 ${warnings}</p>
    <ul class="mj-issues mj-full">${issues.map((x) => `<li class="is-${x.level}" data-page="${x.page}"><b>P.${x.page}</b> ${esc(x.msg)}</li>`).join('')}</ul>`;
  box.querySelectorAll('[data-page]').forEach((li) => li.addEventListener('click', () => go(Number(li.dataset.page) - 1)));
}

// --- ページ・部品の追加 --------------------------------------------------------------
function renderInsertMenu() {
  $('#insert-menu').innerHTML = `<button type="button" data-t="__blank" class="mj-menu-wide">${icon('plus', 14)} 空のページ<kbd>⌥N</kbd></button>`
    + `<button type="button" data-t="__cheat" class="mj-menu-wide mj-menu-cheat">${icon('book', 14)} 書き方の一覧から選ぶ<kbd>⌘⇧K</kbd></button>`
    + TEMPLATES.map((t) => `<button type="button" data-t="${t.id}">${esc(t.label)}</button>`).join('');
}
function openInsertMenu() { $('#insert-menu').hidden = false; }
$('#btn-insert').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#insert-menu').hidden = !$('#insert-menu').hidden;
});
document.addEventListener('click', (e) => { if (!e.target.closest('.mj-insert')) $('#insert-menu').hidden = true; });
$('#insert-menu').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-t]')?.dataset.t;
  if (!id) return;
  $('#insert-menu').hidden = true;
  if (id === '__blank') return pageOp('blank');
  if (id === '__cheat') return openCheatsheet();
  const t = TEMPLATES.find((x) => x.id === id);
  let fig = '';
  if (t.needsFigure) fig = (await newFigure()).path;
  finishEdit(true);
  const lines = state.text.split('\n');
  const r = state.ranges[state.current];
  let end = r.end;
  while (end > r.start && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, '', '---', '', ...t.body(fig, slideLines(0).join('\n')).split('\n'));
  state.current += 1;
  setText(lines.join('\n'), { label: `「${t.label}」の追加` });
  go(state.current);
  toast(`「${t.label}」を追加しました`);
});

// --- 書き方（早見表） ----------------------------------------------------------------
const KIND_CLASSES = ['cover', 'cover-talk', 'divider', 'closing', 'back-cover', 'statement'];
function insertSnippet({ mode, text, label }) {
  finishEdit(true);
  const lines = state.text.split('\n');
  const r = state.ranges[state.current];
  if (mode === 'front') {
    // フロントマターの同じ設定を置き換える（なければ閉じの --- の前へ）
    const key = text.split(':')[0];
    const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
    if (end < 0) return toast('フロントマターがありません', 'error');
    const at = lines.slice(1, end).findIndex((l) => l.startsWith(`${key}:`));
    if (at >= 0) lines[at + 1] = text; else lines.splice(end, 0, text);
    setText(lines.join('\n'), { label: `「${label}」の設定` });
    return toast(`フロントマターに「${text}」を書きました。パスを実際の画像に直してください`);
  }
  if (mode === 'page') {
    let end = r.end;
    while (end > r.start && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, '', '---', '', ...text.split('\n'));
    state.current += 1;
    setText(lines.join('\n'), { label: `「${label}」の追加` });
    go(state.current);
    return toast(`「${label}」のページを追加しました`);
  }
  if (mode === 'top') {
    const m = text.match(/^<!-- _class: (.+) -->$/);
    if (m) {
      // クラスは今のページのクラスに足す（種類・リードの大きさは入れ替える）
      const add = m[1].split(/\s+/);
      const cur = readSlideMeta(slideLines()).classes.filter((c) => !(add.some((a) => KIND_CLASSES.includes(a)) && KIND_CLASSES.includes(c)) && !(add.some((a) => a.startsWith('lead-')) && c.startsWith('lead-')));
      setText(replaceSlideLines(setSlideClasses(slideLines(), [...new Set([...cur, ...add])])), { label: `「${label}」` });
    } else {
      const ls = slideLines();
      let at = 0;
      while (at < ls.length && !ls[at].trim()) at++;
      ls.splice(at, 0, text, '');
      setText(replaceSlideLines(ls), { label: `「${label}」` });
    }
    return toast(`このページを「${label}」にしました`);
  }
  // here：分割表示なら左のカーソルの位置、そうでなければページの末尾へ
  if (state.sourceOpen && cm) {
    const pos = cm.state.selection.main.head;
    const line = cm.state.doc.lineAt(pos);
    const insertAt = line.text.trim() ? line.to : line.from;
    const block = `${line.text.trim() ? '\n\n' : ''}${text}\n`;
    cm.dispatch({ changes: { from: insertAt, insert: block }, selection: { anchor: insertAt + block.length } });
    cm.focus();
    return toast(`「${label}」をカーソルの位置に入れました`);
  }
  let end = r.end;
  while (end > r.start && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, '', ...text.split('\n'));
  setText(lines.join('\n'), { label: `「${label}」の追加` });
  toast(`「${label}」をこのページに入れました`);
}
const cheatsheet = createCheatsheet({ modal: $('#modal'), render: (md) => marp.render(md), deckText: () => state.text, firstPage: () => slideLines(0).join('\n'), insert: insertSnippet, toast });
const openCheatsheet = () => { finishEdit(true); cheatsheet.open(); };

// --- ページのコピー・貼り付け（別の資料へも） -------------------------------------------------
// コピーしたページには、どの資料から来たかの印を付ける。別の資料に貼るとき、図（figs/）も一緒に写すため
const COPY_MARK = /^<!-- marp-pages: (\{.*?\}) -->\n?/;
function pagesText(pages) {
  const d = splitSlides(state.text);
  return pages.map((i) => d.chunks[i].join('\n')).join('\n\n---\n\n');
}
function copyText(pages) {
  return `<!-- marp-pages: ${JSON.stringify({ from: state.abs, count: pages.length })} -->\n${pagesText(pages)}\n`;
}
async function copyPages(pages = selectedPages()) {
  try { await navigator.clipboard.writeText(copyText(pages)); toast(`${pages.length}ページをコピーしました（⌘V で貼り付け。別の資料にも貼れます）`); }
  catch { toast('コピーできませんでした', 'error'); }
}
async function pastePages(text) {
  const m = text.match(COPY_MARK);
  const meta = m ? JSON.parse(m[1]) : null;
  let body = text.replace(COPY_MARK, '').trim();
  let note = '';
  if (meta?.from && meta.from !== state.abs) {
    const r = await importPages({ text: body, from: meta.from });
    body = r.text;
    if (r.copied?.length) note = `・図 ${r.copied.length}枚も写しました`;
    if (r.renamed?.length) note += `（同じ名前の図は ${r.renamed.map((x) => x.to.replace(/^figs\//, '')).join('、')} として）`;
  }
  const add = splitSlides(`---\nmarp: true\n---\n\n${body}\n`).chunks.filter((c) => c.some((l) => l.trim()));
  if (!add.length) return;
  finishEdit(true);
  const d = splitSlides(state.text);
  const at = Math.max(state.current, ...selectedPages()) + 1;
  d.chunks.splice(at, 0, ...add);
  state.current = at;
  clearSelection();
  setText(joinSlides(d), { label: 'ページの貼り付け' });
  go(at);
  toast(`${add.length}ページを貼り付けました${note}`);
}
const editingText = () => state.editing || document.activeElement?.closest?.('input, textarea, .cm-editor, [contenteditable="true"], [contenteditable="plaintext-only"]');
document.addEventListener('copy', (e) => {
  if (editingText() || getSelection().toString() || !$('#modal').hidden) return;
  e.preventDefault();
  const pages = selectedPages();
  e.clipboardData.setData('text/plain', copyText(pages));
  toast(`${pages.length}ページをコピーしました（⌘V で貼り付け。別の資料にも貼れます）`);
});
// 切り取り：コピーしてから消す（⌘Z で戻せる）
function cutPages(pages, writer) {
  if (pages.length >= state.sections.length) return toast('すべてのページは切り取れません', 'error');
  writer(copyText(pages));
  state.selected = new Set(pages.filter((i) => i !== state.current));
  if (pages.length > 1) multiOp('delete'); else pageOp('delete', pages[0]);
  toast(`${pages.length}ページを切り取りました（⌘V で貼り付け。⌘Z で元に戻す）`);
}
document.addEventListener('cut', (e) => {
  if (editingText() || getSelection().toString() || !$('#modal').hidden) return;
  e.preventDefault();
  cutPages(selectedPages(), (t) => e.clipboardData.setData('text/plain', t));
});
// 別の資料の最後（裏表紙の前）へ送る
async function openSendDialog(pages = selectedPages()) {
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = '<section class="cp-dialog"><p class="mj-muted" style="padding:20px">資料の一覧を読み込み中…</p></section>';
  const { targets, error } = await copyTargets();
  const render = (q = '') => {
    const hit = targets.filter((t) => !q || `${t.title} ${t.slug} ${t.lib}`.toLowerCase().includes(q.toLowerCase()));
    m.querySelector('.cp-list').innerHTML = hit.map((t) => `<button type="button" data-file="${esc(t.file)}"><b>${esc(t.title || t.slug)}</b><small>${esc(t.lib)}・${esc(t.slug)}・${t.pages}ページ</small></button>`).join('') || `<p class="mj-muted">${esc(error || '見つかりません')}</p>`;
  };
  m.innerHTML = `<section class="cp-dialog" role="dialog" aria-label="別の資料へコピー">
    <header><h2>${pages.length}ページを別の資料へコピー</h2><p class="mj-muted">選んだ資料の最後（裏表紙があればその前）に足します。図（figs/）も一緒に写します。</p></header>
    <input class="cp-search" type="search" placeholder="資料を探す" autocomplete="off">
    <nav class="cp-list"></nav>
    <footer><button type="button" data-cp="close">やめる</button></footer>
  </section>`;
  render();
  const search = m.querySelector('.cp-search');
  search.focus();
  search.addEventListener('input', () => render(search.value));
  const close = () => { m.hidden = true; m.innerHTML = ''; m.onclick = null; window.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  m.onclick = async (e) => {
    if (e.target === m || e.target.closest('[data-cp="close"]')) return close();
    const b = e.target.closest('[data-file]');
    if (!b) return;
    b.disabled = true;
    const r = await sendPages({ text: pagesText(pages), target: b.dataset.file });
    close();
    if (!r.ok) return toast(r.data?.error || 'コピーできませんでした', 'error');
    toast(`「${b.querySelector('b').textContent}」の最後に${pages.length}ページを足しました${r.data?.copied?.length ? `（図 ${r.data.copied.length}枚も写しました）` : ''}`);
  };
}

// --- 画像の貼り付け・ドロップ ------------------------------------------------------------
async function insertImages(files) {
  const imgs = files.filter((f) => /^image\//.test(f.type));
  if (!imgs.length) return;
  finishEdit(true);
  const paths = [];
  for (const f of imgs) {
    const ext = (f.name.match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1] || f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const base = (f.name && f.name !== 'image.png' ? f.name.replace(/\.[^.]+$/, '') : 'pasted').replace(/[^\w\-一-龠ぁ-んァ-ヶー]+/g, '-').slice(0, 40) || 'image';
    const r = await uploadImage(`${base}.${ext}`, f);
    if (!r.ok) { toast('画像を保存できませんでした', 'error'); continue; }
    paths.push(r.path);
  }
  if (!paths.length) return;
  const next = appendToSlide(state.text, state.ranges[state.current], paths.map((p) => `![h:380](${p})`));
  setText(next, { label: '画像の追加' });
  toast(`${paths.length}枚の画像を figs/ に保存して入れました`);
}
document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea, .cm-editor')) return;
  const files = [...e.clipboardData.files];
  if (files.some((f) => /^image\//.test(f.type))) { e.preventDefault(); insertImages(files); return; }
  // 編集していないときの ⌘V：コピーしたページ（または「# 」で始まる Markdown）をページとして貼る
  if (state.editing || !$('#modal').hidden) return;
  const text = e.clipboardData.getData('text/plain');
  if (!COPY_MARK.test(text) && !/^\s*(#\s|<!--\s*_class)/.test(text)) return;
  e.preventDefault();
  pastePages(text);
});
let dragDepth = 0;
const wrap = $('#stage-wrap');
wrap.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; dragDepth++; $('#drop-hint').hidden = false; });
wrap.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; } });
wrap.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
wrap.addEventListener('drop', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth = 0; $('#drop-hint').hidden = true;
  insertImages([...e.dataTransfer.files]);
});

// --- ページ検索（⌘P） ・ショートカット一覧（?） ---------------------------------------------------
function openPalette() {
  finishEdit(true);
  const ov = $('#overlay');
  ov.hidden = false;
  ov.innerHTML = `<div class="mj-palette" role="dialog" aria-label="ページへ移動">
    <div class="mj-palette-input">${icon('search', 16)}<input id="palette-q" placeholder="ページのタイトルや本文で探す（Enterで移動）" autocomplete="off"></div>
    <ul id="palette-list"></ul></div>`;
  const q = $('#palette-q');
  const plain = state.ranges.map((r) => state.text.split('\n').slice(r.start, r.end).join(' ').replace(/<!--[\s\S]*?-->/g, '').replace(/[#*`>|]/g, ' ').toLowerCase());
  let sel = 0, hits = [];
  const draw = () => {
    const v = q.value.trim().toLowerCase();
    hits = state.titles.map((t, i) => ({ t, i, score: !v ? 1 : t.toLowerCase().includes(v) ? 3 : plain[i].includes(v) ? 1 : 0 })).filter((h) => h.score).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 60);
    sel = Math.min(sel, Math.max(0, hits.length - 1));
    $('#palette-list').innerHTML = hits.map((h, k) => `<li data-i="${h.i}" class="${k === sel ? 'is-sel' : ''}"><b>P.${h.i + 1}</b> ${esc(h.t || '（タイトルなし）')}</li>`).join('') || '<li class="mj-muted">見つかりません</li>';
    $('#palette-list .is-sel')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { ov.hidden = true; ov.innerHTML = ''; };
  q.addEventListener('input', () => { sel = 0; draw(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    if (e.key === 'Enter' && hits[sel]) { e.preventDefault(); close(); go(hits[sel].i); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  $('#palette-list').addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) { close(); go(Number(li.dataset.i)); } });
  ov.onclick = (e) => { if (e.target === ov) close(); };
  draw();
  q.focus();
}
function openHelp() {
  const k = (s) => s.replace(/⌘/g, isMac ? '⌘' : 'Ctrl+');
  const rows = [
    ['文字を直す', [['クリック', '文字を直す（記号が見える）'], ['Enter', '確定（要素は選んだまま）'], ['⇧Enter', '改行'], ['選んだまま Enter', 'もう一度直す'], ['選んだまま ↑↓ / Tab', '前後の要素へ'], ['Esc', '取り消し／選択を外す'], [k('⌘⏎'), '確定'], [k('⌘B'), '太字'], [k('⌘I'), '斜体'], [k('⌘⇧C'), 'コード'], [k('⌘K'), 'リンク']]],
    ['リスト・表', [['⇧Enter', '次の項目（空なら終わる）'], ['Enter', '確定'], ['Tab / ⇧Tab', '字下げ／解除、表は隣のセルへ'], ['Backspace', '空の項目を消す']]],
    ['ページ', [['↑ ↓', '前後のページ'], [k('⌥N'), '後ろに新しいページ'], [k('⌘D'), '複製'], [k('⌘C / ⌘X / ⌘V'), 'ページのコピー／切り取り／貼り付け（別の資料にも・図も一緒に）'], ['⌥↑ / ⌥↓', '上下へ移動'], ['⌫', '削除（一覧で選んでいるとき）'], [k('⌘P'), 'ページを探す'], [k('⌘⇧K'), '書き方の一覧（見本を見て入れる）'], [k('⌘⇧E'), 'PDFに書き出す'], ['⇧クリック / ⌘クリック', '一覧で複数選ぶ'], ['ドラッグ', '一覧で並べ替え'], ['右クリック', '一覧でページの操作']]],
    ['全体', [[k('⌘S'), '保存'], [k('⌘Z'), '元に戻す'], [k('⇧⌘Z'), 'やり直す'], [k('⌘/'), 'スライド／分割の切り替え'], [k('⌘⏎'), '発表（編集中でないとき）'], [k('⌘0'), '画面に合わせる'], [k('⌘+ / ⌘-'), '拡大／縮小'], [k('⌘\\'), '集中モード（一覧を隠す）'], [k('⌘⌥\\'), '右のサイドバーを開閉'], [k('⌘⇧I'), '検査の表示（要確認）を消す／出す'], ['?', 'この一覧'], ['図をダブルクリック', '図を編集']]],
  ];
  const ov = $('#overlay');
  ov.hidden = false;
  ov.innerHTML = `<div class="mj-help" role="dialog" aria-label="ショートカット"><h2>ショートカット</h2><div class="mj-help-grid">${rows.map(([h, list]) => `<section><h3>${h}</h3><dl>${list.map(([a, b]) => `<dt><kbd>${esc(a)}</kbd></dt><dd>${esc(b)}</dd>`).join('')}</dl></section>`).join('')}</div><p class="mj-muted">画像はステージへドロップか貼り付けで figs/ に保存されます</p></div>`;
  ov.onclick = () => { ov.hidden = true; ov.innerHTML = ''; };
}

// --- 外部変更（SSE）・競合 ----------------------------------------------------------------
function showBannerHtml(html, onAct) {
  const b = $('#banner');
  b.hidden = false;
  b.innerHTML = html;
  b.onclick = (e) => { const act = e.target.closest('[data-b]')?.dataset.b; if (act) onAct(act); };
}
function showBanner(text, hash) {
  showBannerHtml(`<span>ファイルが外部で変更されました。</span>
    <button type="button" data-b="load">外部の内容を読み込む（編集を破棄）</button>
    <button type="button" data-b="diff">違いを見る</button><button type="button" data-b="keep">自分の編集を残す</button><span>保存すると外部の変更を上書きします。</span>`, (act) => {
    if (act === 'load') { flushPendingNote(); pushHistory(null); state.saved = text; state.baseHash = hash; state.text = text; render(); syncSourceEditor(); hideBanner(); afterChange(); toast('外部の変更を読み込みました'); }
    if (act === 'diff') { flushPendingNote(); historyPanel.compareTexts(text, state.text); }
    if (act === 'keep') { state.saved = text; state.baseHash = hash; hideBanner(); updateStatus(); }
  });
}
function showConflict(theirs, hash) {
  showBannerHtml(`<span>保存しようとしたファイルは、読み込んだあとに別の場所で変更されています。</span>
    <button type="button" data-b="diff" class="mj-primary">違いを見る</button><button type="button" data-b="overwrite">自分の内容で上書き</button>
    <button type="button" data-b="load">相手の内容を読み込む（自分の編集は⌘Zで戻せます）</button>`, (act) => {
    if (act === 'diff') { flushPendingNote(); historyPanel.compareTexts(theirs, state.text); }
    if (act === 'overwrite') { state.baseHash = hash; hideBanner(); save({ force: true }); }
    if (act === 'load') { flushPendingNote(); pushHistory(null); state.text = theirs; state.saved = theirs; state.baseHash = hash; render(); syncSourceEditor(); hideBanner(); afterChange(); }
  });
}
function hideBanner() { $('#banner').hidden = true; draftOffer = null; }
let online = true;
function setOnline(v) {
  if (online === v) return;
  online = v;
  document.body.classList.toggle('is-offline', !v);
  if (!v) toast('接続が切れました。編集は下書きに残ります', 'error');
  else toast('接続を回復しました');
  updateStatus();
}
function listen() {
  subscribeEvents({
    deck: (e) => {
      refreshHistory();
      const { text, hash } = JSON.parse(e.data);
      if (text === state.text) { state.saved = text; state.baseHash = hash || state.baseHash; updateStatus(); return; }
      if (dirty() || state.editing) { showBanner(text, hash); return; }
      pushHistory(null);
      state.saved = text; state.text = text; state.baseHash = hash || state.baseHash;
      render(); syncSourceEditor(); afterChange();
      toast('外部の変更を読み込みました');
    },
    asset: () => { flushPendingNote(); state.figVersion = Date.now(); checkCache.clear(); render({ keepInspector: true }); refreshHistory(); },
  }, {
    onOpen: () => setOnline(true),
    onError: () => setOnline(false), // EventSource は自動でつなぎ直す
  });
}

// --- 通知 --------------------------------------------------------------------------
let toastTimer;
function toast(msg, level = 'info', actions = [], sticky = false) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + actions.map((a, i) => `<button type="button" class="toast-action" data-toast-action="${i}">${esc(a.label)}</button>`).join('');
  t.className = `is-${level}`;
  t.hidden = false;
  t.onclick = (e) => {
    const i = e.target.closest('[data-toast-action]')?.dataset.toastAction;
    if (i != null && actions[Number(i)]) { actions[Number(i)].run(); t.hidden = true; }
  };
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, actions.length ? 10000 : msg.length > 40 ? 5000 : 2400);
}

// --- キーボード ---------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  // 開いているメニューは ↑↓ で移れる（G01）
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const menu = [...document.querySelectorAll('#insert-menu, #export-menu, #ctx-menu, #more-menu, #help-menu, #issues-menu')].find((m) => !m.hidden);
    if (menu) {
      const items = [...menu.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      if (items.length) {
        e.preventDefault();
        const i = items.indexOf(document.activeElement);
        const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
        return;
      }
    }
  }
  const key = e.key.toLowerCase();
  // ダイアログ・オーバーレイが開いている間は、画面のショートカットを先に止める（D06）
  if (mod(e) && key === 's') {
    e.preventDefault();
    if (typeof window.__figureSave === 'function') window.__figureSave(); else save();
    return;
  }
  const overlayOpen = !$('#overlay').hidden || !$('#modal').hidden;
  if (overlayOpen) {
    if (e.key === 'Escape' && !$('#overlay').hidden) {
      $('#overlay').hidden = true;
      $('#overlay').innerHTML = '';
    }
    return;
  }
  // Esc で開いているメニューを閉じる（G01）
  if (e.key === 'Escape') {
    let closed = false;
    for (const sel of ['#insert-menu', '#export-menu', '#ctx-menu', '#more-menu', '#file-menu', '#help-menu', '#issues-menu']) {
      const m = $(sel);
      if (m && !m.hidden) {
        m.hidden = true; closed = true;
        const trigger = { '#insert-menu': '#btn-insert', '#export-menu': '#btn-export', '#more-menu': '#btn-more', '#file-menu': '#file-name', '#help-menu': '#btn-help-menu', '#issues-menu': '#summary' }[sel];
        if (trigger) (sel === '#export-menu' && !$('#btn-export').offsetWidth ? $('#btn-more') : $(trigger))?.focus();
      }
    }
    if (closed) { e.preventDefault(); return; }
  }
  if (mod(e) && key === 's') { e.preventDefault(); save(); return; }
  if (mod(e) && e.shiftKey && key === 'e') { e.preventDefault(); exportDeck('pdf'); return; }
  if (mod(e) && (key === 'e' || key === '/')) { e.preventDefault(); toggleSource(); return; }
  if (mod(e) && key === 'p') { e.preventDefault(); openPalette(); return; }
  if (mod(e) && e.shiftKey && key === 'k') { e.preventDefault(); openCheatsheet(); return; }
  if (mod(e) && e.shiftKey && key === 'i') { e.preventDefault(); toggleIssues(); return; }
  if (mod(e) && e.altKey && (e.key === '\\' || e.code === 'Backslash')) { e.preventDefault(); toggleRight(); return; }
  if (mod(e) && e.key === '\\') { e.preventDefault(); document.body.classList.toggle('is-focus'); requestAnimationFrame(renderStage); return; }
  const typing = state.editing || e.target.closest?.('input:not([type="checkbox"]):not([type="radio"]), textarea, select, .cm-editor, [contenteditable="true"], [contenteditable="plaintext-only"]');
  if (mod(e) && key === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod(e) && key === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (typing) return;
  if (mod(e) && key === 'd') { e.preventDefault(); pageOp('duplicate'); return; }
  if (mod(e) && key === '0') { e.preventDefault(); zoom = 'fit'; renderStage(); renderZoom(); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); const j = state.current + (e.key === 'ArrowUp' ? -1 : 1); if (j >= 0 && j < state.sections.length) pageOp('move', state.current, j); return; }
  if (mod(e) && key === 'a' && e.target.closest?.('#thumbs')) { e.preventDefault(); state.selected = new Set(state.sections.map((_, i) => i).filter((i) => i !== state.current)); paintSelection(); return; }
  if (mod(e) && (key === '=' || key === '+' || key === '-')) { e.preventDefault(); setZoom(key === '-' ? -1 : 1); return; }
  if (e.altKey && !mod(e) && e.code === 'KeyN') { e.preventDefault(); pageOp('blank'); return; } // 新しいページ（N だけだと、文字を打ったつもりでページが増える）
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // 要素を選んでいるとき
  if (pickedEl()) {
    if (e.key === 'Enter') { e.preventDefault(); const el = pickedEl(); clearPick(); startEdit(el, { offset: 'end' }); return; }
    if (e.key === 'Escape') { e.preventDefault(); clearPick(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); movePick(1); return; }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); movePick(-1); return; }
    // 文字を打ったら、そのまま編集を始めてその文字を入れる（ページを送ったり消したりしない）
    if (e.key.length === 1 && e.key !== ' ') { e.preventDefault(); const el = pickedEl(); clearPick(); startEdit(el, { offset: 'end' }); document.execCommand('insertText', false, e.key); return; }
    if (['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) { e.preventDefault(); return; }
  }
  if (e.key === 'Escape' && state.selected.size) { clearSelection(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(state.current + 1); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(state.current - 1); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); }
  else if (e.key === 'End') { e.preventDefault(); go(state.sections.length - 1); }
  // ページの削除は、左の一覧を操作しているとき（ページを選んでいるとき）だけ。文字を消すつもりの ⌫ でページが消えないように
  else if ((e.key === 'Backspace' || e.key === 'Delete') && (e.target.closest?.('#thumbs') || state.selected.size)) { e.preventDefault(); pageOp('delete'); }
  else if (e.key === '?') { e.preventDefault(); openHelp(); }
  else if (e.key === 'Enter') {
    // Enterでこのページのタイトルを直す
    const h = $('#stage section h1.mj-editable');
    if (h) { e.preventDefault(); startEdit(h, { offset: 'end' }); }
  }
});
window.addEventListener('beforeunload', (e) => { saveDraft(); if (dirty() || (typeof window.__figureDirty === 'function' && window.__figureDirty())) { e.preventDefault(); e.returnValue = ''; } });

// --- 起動 --------------------------------------------------------------------------
$('#btn-hub').addEventListener('click', async (e) => {
  // アプリの中では、このウインドウをライブラリーに変えず、ライブラリーを前へ出す（W03）
  if (inTauri) {
    e.preventDefault();
    if (await showLibrary()) return;
    toast('ライブラリーを開けませんでした', 'error');
  }
});
$('#btn-save').addEventListener('click', () => save());
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => toggleSource(b.dataset.view === 'split')));
$('#btn-undo').innerHTML = icon('undo', 16);
$('#btn-redo').innerHTML = icon('redo', 16);
$('#btn-help').innerHTML = `${icon('help', 16)} ショートカット`;
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-help').addEventListener('click', openHelp);
$('#btn-cheat').innerHTML = `${icon('book', 15)} 書き方の一覧`;
$('#btn-cheat').addEventListener('click', openCheatsheet);
// 書き出し：本文を保存し、アプリでは保存先を選んでから書き出す。
if(inTauri)runtimeStatus().then(st=>{document.querySelector('[data-x="pdf-chrome"]').hidden=!st.chrome;});
let lastExport = null;
let exporting = false;
const EXPORT_LABEL = { 'pdf-chrome': 'PDF（Chrome）', pdf: 'PDF', 'pdf-notes': '発表者用PDF', pptx: 'PowerPoint', html: 'HTML' };
async function exportDeck(fmt) {
  $('#export-menu').hidden = true;
  if (fmt === 'reveal') {
    if (!lastExport) return toast('まだ書き出していません', 'error');
    const r = await revealExport(lastExport);
    if (!r.ok) toast('まだ書き出していません', 'error');
    return;
  }
  if (exporting) return; // ⌘⇧E の二重実行を止める（E08）
  exporting = true;
  try {
  if (dirty()) await save();
  if (dirty()) return toast('保存できなかったため、書き出しをやめました', 'error');
  const st = await runtimeStatus();
  if (!st.native && (!st.node || !st.chrome)) return toast(st.message, 'error');
  const btn = $('#btn-export');
  btn.disabled = true;
  const t0 = Date.now();
  let pageProgress='';
  const unsubscribe=inTauri?subscribeEvents({'export-progress':e=>{const p=JSON.parse(e.data);pageProgress=`${p.page} / ${p.total} ページ`;btn.textContent=`書き出し中… ${pageProgress}`;}}):()=>{};
  const tick = setInterval(() => { btn.textContent = `書き出し中… ${pageProgress||`${Math.round((Date.now() - t0) / 1000)}秒`}`; }, 500);
  btn.textContent = '書き出し中…';
  toast(`${EXPORT_LABEL[fmt]}を書き出しています（${state.sections.length}ページ）`, 'info', inTauri ? [{ label: 'やめる', run: () => cancelExport() }] : [], true);
  try {
    const r = await exportDeckFile(fmt);
    if(r.cancelled){toast('書き出しをキャンセルしました');return;}
    const j = r.data || {};
    if (!r.ok) {
      const err = new Error(j.error || '書き出しに失敗しました');
      err.detail = j.detail || null;
      throw err;
    }
    lastExport = fmt;
    const revealBtn = $('#export-menu [data-x="reveal"]');
    if (revealBtn) revealBtn.disabled = false;
    const reveal = !inTauri && fmt === 'html';
    if (reveal) await revealExport(fmt);
    else if(!inTauri) { const a = document.createElement('a'); a.href = exportFileUrl(fmt); a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
    const mb = (j.size / 1024 / 1024).toFixed(1);
    toast(`${EXPORT_LABEL[fmt]}を書き出しました（${mb}MB・${(j.ms / 1000).toFixed(0)}秒）：${j.file.split('/').pop()}`,'info',inTauri?[{label:'開く',run:()=>openExport(fmt)},{label:'Finder で表示',run:()=>revealExport(fmt)}]:[]);
    return r;
  } catch (e) {
    toast(e.message, 'error', [{ label: '詳しい内容をコピー', run: () => navigator.clipboard?.writeText(String(e.detail || e.message)) }]);
  } finally {
    clearInterval(tick);
    unsubscribe();
    btn.disabled = false; btn.textContent = '書き出し';
    exporting = false;
  }
  } finally {
    exporting = false;
  }
}
$('#export-menu [data-x="reveal"]').disabled = true;
$('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); $('#export-menu').hidden = !$('#export-menu').hidden; });
$('#export-menu').addEventListener('click', (e) => { const x = e.target.closest('[data-x]')?.dataset.x; if (x && (x !== 'reveal' || lastExport)) exportDeck(x); });
document.addEventListener('click', (e) => { if (!e.target.closest('.mj-export') && !e.target.closest('[data-more="export"]')) $('#export-menu').hidden = true; });

// 右のサイドバー（編集・メモ）を折りたたむ。状態は次に開いたときも引き継ぐ
function toggleRight(open = document.body.classList.contains('no-right')) {
  document.body.classList.toggle('no-right', !open);
  settings.setItem('mj-right', open ? '1' : '0');
  $('#btn-right').innerHTML = icon(open ? 'panelRightClose' : 'panelRightOpen', 17);
  $('#btn-right').title = open ? '右のサイドバーを閉じる（⌘⌥\\）' : '右のサイドバーを開く（⌘⌥\\）';
  requestAnimationFrame(renderStage);
}
$('#btn-right').addEventListener('click', () => toggleRight());
// 検査の表示（スライドの枠・サムネイルの⚠・ツールバーの件数）を消す。検査そのものは続けるので、戻すとすぐ出る
function toggleIssues(show = document.body.classList.contains('no-issues')) {
  document.body.classList.toggle('no-issues', !show);
  settings.setItem('mj-issues', show ? '1' : '0');
  $('#btn-issues').innerHTML = `${icon(show ? 'eye' : 'eyeOff', 16)} ${show ? '見切れの表示を隠す' : '見切れの表示を出す'}`;
  $('#btn-issues').setAttribute('aria-pressed', String(show));
  $('#btn-issues').title = show ? '検査の表示を消す（⌘⇧I）' : '検査の表示を出す（⌘⇧I）';
  $('#btn-issues').classList.toggle('is-on', !show);
}
$('#btn-issues').addEventListener('click', () => toggleIssues());
toggleIssues(settings.getItem('mj-issues') !== '0');
toggleRight(settings.getItem('mj-right') !== '0');
$('#btn-left').addEventListener('click', () => { state.leftMode = state.leftMode === 'thumbs' ? 'outline' : 'thumbs'; settings.setItem('mj-left', state.leftMode); renderLeft(); });
function syncAutosaveUI() { $('#autosave').checked = state.autosave; $('#btn-save').hidden = state.autosave; }
syncAutosaveUI();
$('#file-name').addEventListener('click', (e) => { e.stopPropagation(); $('#file-menu').hidden = !$('#file-menu').hidden; });
$('#file-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-menu').hidden = !$('#file-menu').hidden; } });
$('#file-menu').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-file]')?.dataset.file;
  if (!a) return;
  $('#file-menu').hidden = true;
  if (a === 'reveal') {
    const r = await revealPath(state.file);
    if (!r.ok) toast('Finder で開けませんでした', 'error');
  }
  if (a === 'rename') await renameCurrentDeck();
});

// 題名のメニューから、いま開いている資料のフォルダ名を変える（T03）
async function renameCurrentDeck() {
  if (!inTauri) return showLibrary();
  try {
    const at = await deckLocation();
    if (!at?.slug) return showLibrary();
    const to = await promptDialog({ title: '名前を変える', label: '新しいフォルダ名', value: at.slug });
    if (!to || to === at.slug) return;
    if (dirty() && !(await save())) return;
    const r = await renameDeck(to);
    const next = state.file.replace(/\/[^/]+\/slides\.md$/, `/${r.slug || to}/slides.md`);
    try {
      await openDeckWindow({ deckPath: next });
    } catch (e) {
      toast(`名前は変わりました（${r.slug || to}）。ライブラリーから開き直してください`, 'error');
      await showLibrary();
      return;
    }
    closeWindowNow();
  } catch (e) { toast(e.message || String(e), 'error'); }
}

document.addEventListener('click', (e) => { if (!e.target.closest('.mj-file-wrap')) $('#file-menu').hidden = true; });
$('#btn-more').addEventListener('click', (e) => { e.stopPropagation(); $('#more-menu').hidden = !$('#more-menu').hidden; });
$('#more-menu').addEventListener('click', (e) => {
  const a = e.target.closest('[data-more]')?.dataset.more;
  if (!a) return;
  $('#more-menu').hidden = true;
  if (a === 'cheat') openCheatsheet();
  else if (a === 'help') openHelp();
  else if (a === 'issues') toggleIssues();
  else if (a === 'summary') $('#btn-next-issue').click();
  else if (a === 'export') { $('#export-menu').hidden = false; $('#export-menu button:not([hidden])')?.focus(); }
});
document.addEventListener('focusin', (e) => {
  if (e.target.closest?.('.mj-menu') || e.target.closest?.('#btn-insert, #btn-export, #btn-more, #btn-help-menu, #summary')) return;
  for (const m of document.querySelectorAll('#insert-menu, #export-menu, #ctx-menu, #more-menu, #file-menu, #help-menu, #issues-menu')) m.hidden = true;
});
document.addEventListener('click', (e) => { if (!e.target.closest('.mj-more')) $('#more-menu').hidden = true; });
$('#autosave').addEventListener('change', (e) => { state.autosave = e.target.checked; settings.setItem('mj-autosave', e.target.checked ? '1' : '0'); syncAutosaveUI(); if (state.autosave && dirty()) save(); });
new ResizeObserver(() => { if (!state.editing) renderStage(); }).observe($('#stage-wrap'));
$('#zoom').addEventListener('click', (e) => {
  const z = e.target.closest('[data-z]')?.dataset.z;
  if (!z) return;
  if (z === 'fit') zoom = 'fit'; else if (z === '100') zoom = 1; else return setZoom(z === '+' ? 1 : -1);
  renderStage(); renderZoom();
});

observer = new IntersectionObserver((entries) => {
  for (const en of entries) {
    en.target.dataset.visible = en.isIntersecting ? '1' : '0';
    if (en.isIntersecting && state.leftMode === 'thumbs') fillThumb(en.target);
  }
}, { root: $('#thumbs'), rootMargin: '400px 0px' });
// 一覧の幅が変わったら、見えているサムネイルをその幅で描き直す（L02）
new ResizeObserver(() => {
  if (state.leftMode !== 'thumbs') return;
  for (const el of $('#thumbs').children) {
    if (el.dataset.visible === '1') { el._html = null; fillThumb(el); }
  }
}).observe($('#thumbs'));

await setupMarp();
renderInsertMenu();
const startView = new URLSearchParams(location.search).get('view') || settings.getItem('mj-view');
const loaded = await loadDeck();
state.text = state.saved = loaded.text;
state.baseHash = loaded.hash || await sha1(loaded.text);
state.current = Math.max(0, (Number(location.hash.slice(1)) || 1) - 1);
render({ prepared: await initialRender() });
go(state.current);
renderZoom();
updateHistoryButtons();
listen();
if (inTauri) {
  onCloseRequested(async () => {
    closePending = true;
    clearTimeout(autosaveTimer);
    await settings.flush();
    finishEdit(true);
    flushSource();
    flushPendingNote();
    const figDirty = typeof window.__figureDirty === 'function' && window.__figureDirty();
    if (!dirty() && !figDirty) return closeWindowNow();
    const answer = await closeConfirmDialog('保存していない変更があります。保存してから閉じますか？保存しないで閉じると変更は失われます。');
    if (answer === true) {
      if (await saveEverything()) closeWindowNow(); else cancelCloseWindow();
    } else if (answer === 'discard') {
      discardOnClose = true;
      clearTimeout(draftTimer);
      await clearDraft();
      return closeWindowNow();
    } else {
      cancelCloseWindow();
    }
    closePending = false;
    if (state.autosave && dirty()) autosaveTimer = setTimeout(() => save({ auto: true }), 1200);
  });
}
settings.reportErrors();
await offerDraft();
// 異常終了に備えて、起動の復元案内のあとから1秒ごとに下書きへ残す
setInterval(() => saveDraft(), 1000);
notes.load();
if (state.inspTab === 'history') historyPanel.load();
// 前回の表示（スライド／分割）を引き継ぐ。?view=split で分割から始める（go() が URL を書き換える前に読んだ値）
if (startView === 'split') toggleSource(true);
async function nativeMenu(id) {
  if(id.startsWith('export-')) return exportDeck(id.slice(7));
  switch(id){
    case 'save': return saveEverything();
    case 'reveal': return revealPath(state.abs);
    case 'page-new': return pageOp('blank');
    case 'page-duplicate': return pageOp('duplicate');
    case 'page-delete': return pageOp('delete');
    case 'view-slide': return toggleSource(false);
    case 'view-split': return toggleSource();
    case 'view-list': document.body.classList.toggle('is-focus');return requestAnimationFrame(renderStage);
    case 'view-right': return toggleRight();
    case 'zoom-in': return setZoom(1);
    case 'zoom-out': return setZoom(-1);
    case 'zoom-fit': zoom='fit';renderStage();return renderZoom();
    case 'present': return $('#btn-present').click();
    case 'shortcuts': return openHelp();
    case 'writing': return openCheatsheet();
    case 'settings': return openSettings(value=>{state.autosave=value;syncAutosaveUI();if(value&&dirty())save();});
  }
}
window.__marpkit = { menu:nativeMenu, save: saveEverything, go, toggleSource, undo, redo, pageOp, exportDeck, openHelp, openCheatsheet, toggleRight };
for(const id of window.__marpkitPending||[]) nativeMenu(id);
delete window.__marpkitPending;
if (!inTauri || state.debug) {
window.__dialogTest = { confirmDialog, closeConfirmDialog };
window.__editor = { cutPages, copyText, pastePages, openSendDialog, pickedEl, toggleIssues, historyPanel, exportDeck, toggleRight, cheatsheet, cm: () => cm, notes, state, go, save, render, applyElementEdit, editTarget, EDITABLE, isEditable, undo, redo, pageOp, multiOp, startEdit, finishEdit, toggleSource, hist, readyAt: Date.now() }; // E2E 用
Promise.all([document.fonts.ready, ...[...document.querySelectorAll('#stage img')].map(img => img.decode().catch(() => {}))])
  .then(() => requestAnimationFrame(() => requestAnimationFrame(() => { window.__editor.paintedAt = Date.now(); })));

}

for (const [trigger, menu, wrap] of [['#btn-help-menu', '#help-menu', '.mj-help-menu'], ['#summary', '#issues-menu', '.mj-issues-menu']]) {
  $(trigger).addEventListener('click', (e) => { e.stopPropagation(); $(menu).hidden = !$(menu).hidden; });
  $(menu).addEventListener('click', (e) => { if (e.target.closest('button')) $(menu).hidden = true; });
  document.addEventListener('click', (e) => { if (!e.target.closest(wrap)) $(menu).hidden = true; });
}
