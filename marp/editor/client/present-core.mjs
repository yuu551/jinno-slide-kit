// 発表画面・発表者画面で共通の部品。
//   loadDeck()   … エディターと同じ marp-core + jinnoPlugin + テーマで描画し、保存・外部変更（SSE）で描き直す
//   SlideView    … 1280×720 を枠いっぱいに等比拡大して1枚ずつ見せる。前後を先に描いておき、画像の読み込みが済んでから切り替える
//   createSync() … BroadcastChannel で開いている画面どうしのページ・黒画面を合わせる
//   bindKeys()   … PowerPoint / Keynote に合わせたキー操作（数字＋Enter のジャンプ込み）
import { Marp } from '@marp-team/marp-core';
import jinnoPlugin from '../../plugin.mjs';
import { guardIME } from './ime.mjs';
import { deckInfo, loadDeck as loadDeckText, subscribeEvents, openPresentWindow, openPresenterWindow, inTauri, presentationFullscreen } from './backend.mjs';
guardIME(); // 日本語の変換を確定する Enter を、アプリの操作として受け取らない

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// --- デッキ -----------------------------------------------------------------------
let themeAssets = Promise.resolve();
const keepImages = [];
function preloadThemeAssets(css) {
  // 表紙・章扉の背景（CSSの background-image）は img.decode() で待てないので、先に読み込んでおく
  const urls = [...new Set([...css.matchAll(/url\(["']?(\/theme-assets\/[^"')]+\.(?:png|jpe?g|webp|gif|svg))["']?\)/gi)].map((m) => m[1]))];
  themeAssets = Promise.all(urls.map((u) => {
    const img = new Image();
    img.src = u;
    keepImages.push(img);
    return img.decode().catch(() => {});
  }));
}

export async function loadDeck() {
  const info = await deckInfo();
  // エディター（client/main.mjs の setupMarp）と同じ設定
  const marp = new Marp({ html: true, inlineSVG: false, emoji: { shortcode: false, unicode: false }, math: false, minifyCSS: false, script: false });
  for (const css of info.themes) marp.themeSet.add(css);
  marp.use(jinnoPlugin);

  const deck = { info, name: info.name, title: info.name, text: null, sections: [], notes: [], css: '', figVersion: 0 };
  const subs = new Set();
  const styleEl = document.getElementById('marp-css');

  const render = (text) => {
    deck.text = text;
    const { html, css, comments } = marp.render(text);
    if (css !== deck.css) { styleEl.textContent = css; deck.css = css; preloadThemeAssets(css); }
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    if (deck.figVersion) for (const img of tpl.content.querySelectorAll('img[src]')) {
      const s = img.getAttribute('src');
      if (!/^(data:|https?:)/.test(s)) img.setAttribute('src', `${s}${s.includes('?') ? '&' : '?'}v=${deck.figVersion}`);
    }
    deck.sections = [...tpl.content.querySelectorAll('div.marpit > section')].map((s) => s.outerHTML);
    deck.notes = deck.sections.map((_, i) => (comments?.[i] || []).map((c) => c.trim()).filter(Boolean).join('\n\n'));
    const t = text.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
    deck.title = t ? t[1] : info.name;
  };

  const { text } = await loadDeckText();
  render(text);

  const onText = (e) => {
    const { text } = JSON.parse(e.data);
    if (text === deck.text) return;
    render(text);
    for (const f of subs) f('deck');
  };
  subscribeEvents({
    deck: onText,   // 外部のエディター・エージェントによる書き換え
    saved: onText,  // このエディターでの保存（server.mjs の発表モード用フック）
    asset: () => { deck.figVersion = Date.now(); render(deck.text); for (const f of subs) f('asset'); },
  });
  deck.onChange = (f) => subs.add(f);
  return deck;
}

// --- 1枚ずつ見せる枠 ---------------------------------------------------------------
async function settle(el) {
  await frame(); // 配置してから（フォントの読み込みが始まるように）
  el.getBoundingClientRect();
  const imgs = [...el.querySelectorAll('img')];
  await Promise.all([...imgs.map((i) => i.decode().catch(() => {})), themeAssets, document.fonts.ready]);
}

export class SlideView {
  constructor(host, deck, { ahead = [1, -1, 2], align = 'center' } = {}) {
    this.host = host; this.deck = deck; this.ahead = ahead; this.align = align;
    this.layers = new Map(); this.visible = null; this.index = -1; this.token = 0;
    host.classList.add('pv-view');
    new ResizeObserver(() => this.layout()).observe(host);
    this.layout();
  }
  layout() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const s = Math.max(0.05, Math.min(w / 1280, h / 720));
    this.host.style.setProperty('--pv-s', s);
    this.host.style.setProperty('--pv-x', `${Math.round((w - 1280 * s) / 2)}px`);
    this.host.style.setProperty('--pv-y', `${this.align === 'top' ? 0 : Math.round((h - 720 * s) / 2)}px`);
    this.scale = s;
  }
  make(html) {
    const el = document.createElement('div');
    el.className = 'pv-layer';
    el.innerHTML = `<div class="pv-slide"><div class="marpit">${html}</div></div>`;
    el._html = html;
    for (const a of el.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
    this.host.appendChild(el);
    el._ready = settle(el);
    return el;
  }
  layer(i) {
    const html = this.deck.sections[i];
    if (html == null) return null;
    let l = this.layers.get(i);
    if (!l || l._html !== html) { l = this.make(html); this.layers.set(i, l); this.sweep(); }
    return l;
  }
  sweep() {
    const keep = new Set(this.layers.values());
    if (this.visible) keep.add(this.visible);
    for (const el of [...this.host.children]) if (el.classList.contains('pv-layer') && !keep.has(el)) el.remove();
  }
  // i 番目を見せる。準備（画像のデコード）が済むまで今の絵を残すので、ちらつかない
  async show(i) {
    const token = ++this.token;
    const l = this.layer(i);
    if (!l) { this.clear(); return true; }
    if (l !== this.visible) await Promise.race([l._ready, sleep(1500)]);
    if (token !== this.token) return false;
    if (this.visible !== l) {
      l.classList.add('is-current');
      this.visible?.classList.remove('is-current');
      this.visible = l;
    }
    this.host.classList.remove('is-empty');
    this.index = i;
    for (const k of [...this.layers.keys()]) if (k < i - 2 || k > i + 3) this.layers.delete(k);
    for (const d of this.ahead) this.layer(i + d);
    this.sweep();
    return true;
  }
  clear() {
    this.token++;
    this.visible?.classList.remove('is-current');
    this.visible = null; this.index = -1;
    this.host.classList.add('is-empty');
  }
  refresh() { return this.index >= 0 ? this.show(Math.min(this.index, this.deck.sections.length - 1)) : Promise.resolve(); }
  ready() { return this.visible?._ready || Promise.resolve(); }
}

// --- 画面どうしの同期 ----------------------------------------------------------------
// state: { index, blank: '' | 'black' | 'white' }
export function createSync(role, { getState, apply }) {
  const ch = new BroadcastChannel('mj-present');
  const id = Math.random().toString(36).slice(2);
  const peers = new Map();
  const peerSubs = new Set();
  const post = (type, extra = {}) => ch.postMessage({ type, from: id, role, ...extra });
  const explicit = /^#\d+$/.test(location.hash);
  let adopted = explicit;
  const notePeers = () => { for (const f of peerSubs) f(peers); };
  ch.onmessage = ({ data: m }) => {
    if (!m || m.from === id) return;
    if (m.type === 'state') { peers.set(m.from, m.role); apply(m); notePeers(); }
    if (m.type === 'hello') { peers.set(m.from, m.role); post('here', getState()); notePeers(); }
    if (m.type === 'here') {
      peers.set(m.from, m.role); notePeers();
      if (!adopted) { adopted = true; apply(m); }
    }
    if (m.type === 'bye') { peers.delete(m.from); notePeers(); }
  };
  post('hello', getState());
  // ページを指定して開いた（エディターや他の画面から）ときは、こちらに合わせてもらう
  if (explicit) post('state', getState());
  addEventListener('pagehide', () => post('bye'));
  return {
    broadcast: () => post('state', getState()),
    peers, onPeers: (f) => peerSubs.add(f),
    has: (r) => [...peers.values()].includes(r),
  };
}

// --- ページ操作（両画面で共通） ---------------------------------------------------------
export function createNav(deck, { render, role }) {
  const nav = {
    index: Math.max(0, Math.min((Number(location.hash.slice(1)) || 1) - 1, deck.sections.length - 1)),
    blank: '',
    get count() { return deck.sections.length; },
  };
  let sync;
  const update = (broadcast) => {
    history.replaceState(null, "", `${location.pathname}${location.search}#${nav.index + 1}`);
    render();
    if (broadcast) sync?.broadcast();
    for (const f of nav._subs) f();
  };
  nav._subs = new Set();
  nav.onMove = (f) => nav._subs.add(f);
  nav.go = (i, { broadcast = true } = {}) => {
    const n = Math.max(0, Math.min(i, nav.count - 1));
    if (n === nav.index && !nav.blank) return;
    nav.index = n; nav.blank = '';
    update(broadcast);
  };
  // 黒・白画面のときは、送りキーで元へ戻すだけ（PowerPoint と同じ）
  nav.next = () => (nav.blank ? nav.setBlank('') : nav.go(nav.index + 1));
  nav.prev = () => (nav.blank ? nav.setBlank('') : nav.go(nav.index - 1));
  nav.first = () => nav.go(0);
  nav.last = () => nav.go(nav.count - 1);
  nav.render = () => update(false);
  nav.setBlank = (kind) => { nav.blank = kind; update(true); };
  nav.toggleBlank = (kind) => nav.setBlank(nav.blank === kind ? '' : kind);
  sync = createSync(role, {
    getState: () => ({ index: nav.index, blank: nav.blank }),
    apply: (m) => {
      const n = Math.max(0, Math.min(m.index, nav.count - 1));
      if (n === nav.index && (m.blank || '') === nav.blank) return;
      nav.index = n; nav.blank = m.blank || '';
      update(false);
    },
  });
  nav.sync = sync;
  addEventListener('hashchange', () => {
    const n = Number(location.hash.slice(1));
    if (n && n - 1 !== nav.index) nav.go(n - 1);
  });
  deck.onChange(() => {
    if (nav.index > nav.count - 1) nav.index = Math.max(0, nav.count - 1);
    render();
    for (const f of nav._subs) f();
  });
  return nav;
}

// キー操作。actions: { next, prev, first, last, goto(i), black, white, fullscreen, other, print, help, escape }
export function bindKeys(nav, actions, { onBuffer } = {}) {
  let buf = '';
  const setBuf = (v) => { buf = v; onBuffer?.(buf); };
  // ボタンを押したあとにフォーカスが残ると、Space・Enter でボタンも押されて2枚進むので外す
  document.addEventListener('click', (e) => { const b = e.target.closest?.('button'); if (b) b.blur(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const act = (fn) => { e.preventDefault(); fn?.(); };
    if (/^[0-9]$/.test(k)) return act(() => setBuf((buf + k).slice(-4)));
    if (buf && k === 'Enter') return act(() => { const n = Number(buf); setBuf(''); if (n) nav.go(n - 1); });
    if (buf && k === 'Backspace') return act(() => setBuf(buf.slice(0, -1)));
    if (buf && k === 'Escape') return act(() => setBuf(''));
    if (buf) setBuf('');
    switch (k) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'Enter': case 'n': case 'N':
        return act(nav.next);
      case ' ': return act(e.shiftKey ? nav.prev : nav.next);
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
        return act(nav.prev);
      case 'Home': return act(nav.first);
      case 'End': return act(nav.last);
      case 'b': case 'B': case '.': return act(() => nav.toggleBlank('black'));
      case 'w': case 'W': case ',': return act(() => nav.toggleBlank('white'));
      case 'f': case 'F': case 'F5': return act(actions.fullscreen);
      case 's': case 'S': return act(actions.other);
      case 'p': case 'P': return act(actions.print);
      case 'g': case 'G': return actions.grid ? act(actions.grid) : undefined;
      case '?': case 'h': case 'H': return act(actions.help);
      case 'Escape': return actions.escape?.(e);
      default:
    }
  });
}

export async function toggleFullscreen() {
  if (inTauri) {
    const active = await presentationFullscreen(null, true);
    document.querySelector('#bar-full')?.classList.toggle('is-on', active);
    return;
  }
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

export async function exitFullscreen() {
  if (inTauri) { await presentationFullscreen(false); document.querySelector('#bar-full')?.classList.remove('is-on'); }
  else if (document.fullscreenElement) await document.exitFullscreen?.();
}

// 発表画面・発表者画面を開く（アプリの中では Tauri のウインドウ、ブラウザではタブ）
export const openPresent = (i) => openPresentWindow(i + 1);
export const openPresenter = (i) => openPresenterWindow(i + 1);

// ノート：素のテキスト（改行を保つ）。**太字** と `コード` だけ整形する
export function noteHTML(text) {
  if (!text) return '';
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

export const HELP = [
  ['→ ↓ Space PageDown Enter クリック', '次へ'],
  ['← ↑ ⇧Space PageUp Backspace', '前へ'],
  ['Home / End', '最初 / 最後'],
  ['数字 → Enter', 'そのページへ'],
  ['G', 'スライドの一覧から選ぶ（発表者画面）'],
  ['B または .', '黒画面（もう一度で戻る）'],
  ['W または ,', '白画面'],
  ['F', '全画面の切り替え（Esc で解除）'],
  ['S', 'もう一方の画面（発表者画面 / 発表画面）を開く'],
  ['P', 'ノート付きの一覧を印刷'],
  ['?', 'この一覧'],
];
export const helpHTML = () => `<div class="pv-help-card"><h2>操作</h2><dl>${HELP.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><p>Esc または ? で閉じる</p></div>`;

// --- ノート付き一覧の印刷 -------------------------------------------------------------
export async function printDeck(deck, { print = true } = {}) {
  let host = document.getElementById('pv-print');
  if (!host) { host = document.createElement('div'); host.id = 'pv-print'; document.body.appendChild(host); }
  const n = deck.sections.length;
  host.innerHTML = `<h1 class="pp-title">${esc(deck.title)}</h1>` + deck.sections.map((s, i) => `
    <div class="pp-row">
      <div class="pp-slide"><div class="pp-scale"><div class="marpit">${s}</div></div></div>
      <div class="pp-note"><div class="pp-no">${i + 1} / ${n}</div><div class="pp-text">${noteHTML(deck.notes[i]) || '<span class="pp-empty">（ノートなし）</span>'}</div></div>
    </div>`).join('');
  const imgs = [...host.querySelectorAll('img')];
  await Promise.race([Promise.all([...imgs.map((i) => i.decode().catch(() => {})), themeAssets, document.fonts.ready]), sleep(8000)]);
  if (!print) return host;
  const done = () => { host.innerHTML = ''; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
  return host;
}

// 画面を眠らせない（対応ブラウザのみ）
export function keepAwake() {
  let lock = null;
  const req = async () => { try { if (document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen'); } catch { /* 未対応 */ } };
  document.addEventListener('visibilitychange', req);
  req();
  return () => lock?.release();
}
