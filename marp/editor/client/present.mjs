// 発表画面（/present）。全画面で1枚ずつ見せる。操作バーはマウスを動かしたときだけ出す。
import { $, SlideView, createNav, bindKeys, toggleFullscreen, exitFullscreen, openPresenter, printDeck, helpHTML, keepAwake } from './present-core.mjs';

export async function startPresent(deck) {
  document.title = `${deck.title} — 発表`;
  const view = new SlideView($('#view'), deck);
  const blank = $('#blank');
  const bar = $('#bar');

  const nav = createNav(deck, {
    role: 'present',
    render: () => {
      view.show(nav.index); // 中身が変わったページは描き直す（準備が済むまで今の絵を残す）
      blank.className = nav.blank ? `is-${nav.blank}` : '';
      blank.hidden = !nav.blank;
      $('#bar-page').textContent = `${nav.index + 1} / ${nav.count}`;
      $('#bar-progress').style.width = `${((nav.index + 1) / Math.max(1, nav.count)) * 100}%`;
      $('#bar-prev').disabled = nav.index <= 0;
      $('#bar-next').disabled = nav.index >= nav.count - 1;
    },
  });

  // --- 操作バーとカーソル：動かしたときだけ出し、2.5秒で隠す ---------------------------
  let idleTimer;
  const wake = () => {
    document.body.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!bar.matches(':hover')) document.body.classList.add('is-idle'); }, 2500);
  };
  const sleepUI = () => { clearTimeout(idleTimer); document.body.classList.add('is-idle'); };
  addEventListener('mousemove', wake);
  bar.addEventListener('mouseleave', wake);
  document.body.classList.add('is-idle');

  // --- 操作 -----------------------------------------------------------------------
  const help = $('#help');
  const toggleHelp = (open = help.hidden) => { help.hidden = !open; if (open) help.innerHTML = helpHTML(); };
  const openOther = () => openPresenter(nav.index);
  const print = () => printDeck(deck);
  bindKeys(nav, {
    fullscreen: toggleFullscreen, other: openOther, print, help: () => toggleHelp(),
    escape: () => { if (!help.hidden) toggleHelp(false); else if (nav.blank) nav.setBlank(''); else exitFullscreen(); },
  }, {
    onBuffer: (b) => { const el = $('#jump'); el.hidden = !b; el.textContent = b ? `${b} ↵` : ''; },
  });
  // キーで送るときは操作バーを引っ込める
  addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey) sleepUI(); }, true);

  // クリックで次へ（リンク・操作バー・一覧は除く）
  let swiped = false;
  $('#stage').addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; }
    if (e.target.closest('a[href], #bar, #help')) return;
    if (!help.hidden) { toggleHelp(false); return; }
    nav.next();
  });
  // タッチ：左右のスワイプ
  let tx = null;
  $('#stage').addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
  $('#stage').addEventListener('touchend', (e) => {
    if (tx == null) return;
    const dx = e.changedTouches[0].clientX - tx;
    tx = null;
    if (Math.abs(dx) > 50) { swiped = true; if (dx < 0) nav.next(); else nav.prev(); }
  });

  $('#bar-prev').addEventListener('click', () => nav.prev());
  $('#bar-next').addEventListener('click', () => nav.next());
  $('#bar-full').addEventListener('click', toggleFullscreen);
  $('#bar-presenter').addEventListener('click', openOther);
  $('#bar-help').addEventListener('click', () => toggleHelp());
  const onFs = () => $('#bar-full').classList.toggle('is-on', !!document.fullscreenElement);
  document.addEventListener('fullscreenchange', onFs);

  // 開いた直後だけ、操作の手がかりを出す
  const hint = $('#hint');
  hint.hidden = false;
  setTimeout(() => hint.classList.add('is-out'), 3500);
  setTimeout(() => { hint.hidden = true; }, 4200);

  keepAwake();
  nav.render();
  await view.show(nav.index);
  document.body.classList.add('is-ready');
  window.__present = { nav, view, deck, print: () => printDeck(deck, { print: false }) }; // E2E 用
}
