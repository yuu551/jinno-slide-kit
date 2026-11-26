import { settings } from '../../shared/settings.mjs';
// 発表者画面（/presenter）。現在・次のスライド、ノート、経過時間・残り時間・現在時刻。
// ページ送りは発表画面と BroadcastChannel で同期する（どちらで操作しても同じページになる）。
import { $, SlideView, createNav, bindKeys, openPresent, printDeck, helpHTML, noteHTML, keepAwake, toggleFullscreen, exitFullscreen } from './present-core.mjs';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => {
  const t = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export async function startPresenter(deck) {
  document.title = `${deck.title} — 発表者画面`;
  $('#deck-name').textContent = deck.title;
  const current = new SlideView($('#current'), deck, { align: 'top' });
  const next = new SlideView($('#next'), deck, { ahead: [1] });
  const key = (k) => `mj-present:${deck.name}:${k}`;

  // --- ノート -----------------------------------------------------------------------
  let noteSize = Number(settings.getItem('mj-present:note-size')) || 22;
  const applyNoteSize = () => {
    $('#notes').style.fontSize = `${noteSize}px`;
    $('#note-size').textContent = `${noteSize}px`;
    settings.setItem('mj-present:note-size', String(noteSize));
  };
  $('#note-smaller').addEventListener('click', () => { noteSize = Math.max(12, noteSize - 2); applyNoteSize(); });
  $('#note-bigger').addEventListener('click', () => { noteSize = Math.min(56, noteSize + 2); applyNoteSize(); });
  applyNoteSize();

  // --- タイマー（この窓を再読み込みしても続くよう sessionStorage に置く） ----------------------------
  const timer = JSON.parse(sessionStorage.getItem(key('timer')) || 'null') || { running: false, startedAt: 0, acc: 0 };
  const saveTimer = () => sessionStorage.setItem(key('timer'), JSON.stringify(timer));
  const elapsed = () => timer.acc + (timer.running ? Date.now() - timer.startedAt : 0);
  const startTimer = () => { if (timer.running) return; timer.running = true; timer.startedAt = Date.now(); saveTimer(); tick(); };
  const pauseTimer = () => { if (!timer.running) return; timer.acc = elapsed(); timer.running = false; saveTimer(); tick(); };
  const resetTimer = () => { timer.running = false; timer.acc = 0; timer.startedAt = 0; saveTimer(); tick(); };
  $('#t-toggle').addEventListener('click', () => (timer.running ? pauseTimer() : startTimer()));
  $('#t-reset').addEventListener('click', resetTimer);

  const target = $('#target');
  const guess = deck.name.match(/(\d+)\s*min/i)?.[1] || '';
  target.value = settings.getItem(key('target')) ?? guess;
  target.addEventListener('input', () => { settings.setItem(key('target'), target.value); tick(); });
  target.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') target.blur(); });

  function tick() {
    const ms = elapsed();
    $('#elapsed').textContent = fmt(ms);
    $('#t-toggle').textContent = timer.running ? '一時停止' : ms ? '再開' : '開始';
    $('#t-toggle').classList.toggle('is-running', timer.running);
    $('#timer-box').classList.toggle('is-paused', !timer.running && ms > 0);
    const goal = Number(target.value) * 60000;
    const rem = $('#remaining');
    const box = $('#remain-box');
    if (goal > 0) {
      const left = goal - ms;
      rem.textContent = left >= 0 ? fmt(left) : `+${fmt(left)}`;
      box.dataset.level = left < 0 ? 'over' : left <= Math.min(5 * 60000, goal * 0.15) ? 'warn' : '';
      $('#remain-label').textContent = left >= 0 ? '残り' : '超過';
      $('#prog-time').style.width = `${Math.min(100, (ms / goal) * 100)}%`;
    } else {
      rem.textContent = '--:--';
      box.dataset.level = '';
      $('#remain-label').textContent = '残り';
      $('#prog-time').style.width = '0';
    }
    const now = new Date();
    $('#clock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  setInterval(tick, 250);

  // --- ページ ----------------------------------------------------------------------
  const nav = createNav(deck, {
    role: 'presenter',
    render: () => {
      const i = nav.index, n = nav.count;
      current.show(i);
      if (i + 1 < n) { next.show(i + 1); $('#next-no').textContent = `${i + 2} / ${n}`; }
      else { next.clear(); $('#next-no').textContent = ''; }
      $('#next-wrap').classList.toggle('is-end', i + 1 >= n);
      $('#page-cur').textContent = i + 1;
      $('#page-all').textContent = n;
      const note = deck.notes[i];
      const box = $('#notes');
      const html = noteHTML(note) || '<p class="pr-empty">このページにはノートがありません</p>';
      if (box._html !== html) { box.innerHTML = html; box._html = html; box.scrollTop = 0; }
      $('#prog-page').style.width = `${((i + 1) / Math.max(1, n)) * 100}%`;
      $('#prev').disabled = i <= 0;
      $('#next-btn').disabled = i >= n - 1;
      $('#blank-flag').hidden = !nav.blank;
      $('#blank-flag').textContent = nav.blank === 'white' ? '白画面を表示中（W で戻る）' : '黒画面を表示中（B で戻る）';
      $('#current-wrap').classList.toggle('is-blank', !!nav.blank);
      $('#black').classList.toggle('is-on', nav.blank === 'black');
      $('#white').classList.toggle('is-on', nav.blank === 'white');
    },
  });
  // 最初にページを送ったらタイマーを始める（開始ボタンでも始められる）
  const autoStart = (fn) => () => { const before = nav.index; fn(); if (nav.index !== before && !timer.running && !elapsed()) startTimer(); };
  const goNext = autoStart(nav.next), goPrev = autoStart(nav.prev);
  const autoStartGo = (i) => autoStart(() => nav.go(i))();

  // --- 発表画面とのつながり ------------------------------------------------------------
  const conn = () => {
    const on = nav.sync.has('present');
    $('#conn').textContent = on ? '発表画面とつながっています' : '発表画面は開いていません';
    $('#conn').classList.toggle('is-on', on);
    $('#open-present').classList.toggle('is-attention', !on);
  };
  nav.sync.onPeers(conn);
  conn();

  // --- 操作 ------------------------------------------------------------------------
  const help = $('#help');
  const toggleHelp = (open = help.hidden) => { help.hidden = !open; if (open) help.innerHTML = helpHTML(); };
  // スライドの一覧（G）：好きなページを選んで飛ぶ。縮小の絵は見えたものから描く
  const grid = $('#grid'), gridBody = $('#grid-body');
  const tiles = [];
  let focus = 0;
  const seen = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { const t = e.target; t._view ||= new SlideView(t.querySelector('.pr-tile-view'), deck, { ahead: [] }); t._view.show(Number(t.dataset.i)); }
  }, { root: gridBody, rootMargin: '300px 0px' });
  const syncTiles = () => {
    while (tiles.length < nav.count) {
      const t = document.createElement('button');
      t.type = 'button'; t.className = 'pr-tile'; t.dataset.i = tiles.length;
      t.innerHTML = `<div class="pr-tile-view"></div><span class="pr-tile-no">${tiles.length + 1}</span>`;
      t.addEventListener('click', () => pick(Number(t.dataset.i)));
      gridBody.appendChild(t); tiles.push(t); seen.observe(t);
    }
    while (tiles.length > nav.count) { const t = tiles.pop(); seen.unobserve(t); t.remove(); }
    for (const t of tiles) {
      t.classList.toggle('is-current', Number(t.dataset.i) === nav.index);
      t._view?.show(Number(t.dataset.i)); // 書き換えた資料を反映する（同じ中身なら描き直さない）
    }
  };
  const setFocus = (i) => {
    focus = Math.max(0, Math.min(tiles.length - 1, i));
    tiles.forEach((t, k) => t.classList.toggle('is-focus', k === focus));
    tiles[focus]?.scrollIntoView({ block: 'nearest' });
  };
  const toggleGrid = (open = grid.hidden) => {
    grid.hidden = !open;
    if (!open) return;
    if (!help.hidden) toggleHelp(false);
    syncTiles();
    setFocus(nav.index);
    tiles[focus]?.scrollIntoView({ block: 'center' });
  };
  const pick = (i) => { toggleGrid(false); autoStartGo(i); };
  const cols = () => getComputedStyle(gridBody).gridTemplateColumns.split(' ').length;
  // 一覧を開いている間は、矢印キーで選び、Enter で飛ぶ（ページ送りのキーより先に受ける）
  document.addEventListener('keydown', (e) => {
    if (grid.hidden || !help.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols(), ArrowUp: -cols() }[e.key];
    const take = (fn) => { e.preventDefault(); e.stopImmediatePropagation(); fn(); };
    if (move) return take(() => setFocus(focus + move));
    if (e.key === 'Home') return take(() => setFocus(0));
    if (e.key === 'End') return take(() => setFocus(tiles.length - 1));
    if (e.key === 'Escape' || e.key === 'g' || e.key === 'G') return take(() => toggleGrid(false));
    if ((e.key === 'Enter' || e.key === ' ') && $('#jump').hidden) return take(() => pick(focus));
  }, true);
  nav.onMove(() => { if (!grid.hidden) syncTiles(); });

  const openOther = () => openPresent(nav.index);
  const print = () => printDeck(deck);
  bindKeys({ next: goNext, prev: goPrev, go: autoStartGo, first: nav.first, last: nav.last, toggleBlank: nav.toggleBlank }, {
    fullscreen: toggleFullscreen, other: openOther, print, help: () => toggleHelp(), grid: () => toggleGrid(),
    escape: () => { if (!help.hidden) toggleHelp(false); else exitFullscreen(); },
  }, {
    onBuffer: (b) => { const el = $('#jump'); el.hidden = !b; el.textContent = b ? `${b} ↵` : ''; },
  });
  $('#prev').addEventListener('click', goPrev);
  $('#next-btn').addEventListener('click', goNext);
  $('#current').addEventListener('click', (e) => { if (!e.target.closest('a[href]')) goNext(); });
  $('#next').addEventListener('click', goNext);
  $('#black').addEventListener('click', () => nav.toggleBlank('black'));
  $('#white').addEventListener('click', () => nav.toggleBlank('white'));
  $('#open-present').addEventListener('click', openOther);
  $('#print').addEventListener('click', print);
  $('#help-btn').addEventListener('click', () => toggleHelp());
  $('#grid-btn').addEventListener('click', () => toggleGrid());
  help.addEventListener('click', () => toggleHelp(false));

  keepAwake();
  tick();
  nav.render();
  await Promise.all([current.show(nav.index), nav.index + 1 < nav.count ? next.show(nav.index + 1) : null]);
  document.body.classList.add('is-ready');
  window.__presenter = { nav, current, next, deck, timer, toggleGrid, print: () => printDeck(deck, { print: false }) }; // E2E 用
}
