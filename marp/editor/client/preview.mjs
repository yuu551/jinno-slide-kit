import { settings } from '../../shared/settings.mjs';
// プレビュー専用の画面（/preview）。全ページを縦に並べて読むだけ。
// ほかのエディターで slides.md を書き、横のウィンドウで見る使い方を想定する。保存のたびに描き直し、変わったページへ自動で移動する。
import { $, esc, openPresent, openPresenter } from './present-core.mjs';

export async function startPreview(deck) {
  const list = $('#pw-list');
  const cols = Number(settings.getItem('pw-cols') || 1);
  const setCols = (n) => {
    document.body.dataset.cols = n;
    settings.setItem('pw-cols', n);
    for (const b of document.querySelectorAll('#pw-cols button')) b.classList.toggle('is-on', Number(b.dataset.c) === n);
    layout();
  };
  let prev = [];

  const layout = () => {
    const n = Number(document.body.dataset.cols || 1);
    const w = (list.clientWidth - 48 - (n - 1) * 24) / n;
    const s = Math.max(0.15, w / 1280);
    for (const f of list.querySelectorAll('.pw-frame')) {
      f.style.width = `${1280 * s}px`; f.style.height = `${720 * s}px`;
      f.firstElementChild.style.transform = `scale(${s})`;
    }
  };

  const draw = (why) => {
    const secs = deck.sections;
    // 変わったページ（中身の比較）
    const changed = [];
    secs.forEach((h, i) => { if (prev[i] !== h) changed.push(i); });
    const rebuild = list.children.length !== secs.length;
    if (rebuild) {
      list.innerHTML = secs.map((h, i) => `<article class="pw-page" id="p${i + 1}" data-i="${i}">
        <div class="pw-head"><a href="#p${i + 1}">P.${i + 1}</a></div>
        <div class="pw-frame"><div class="pw-scale"><div class="marpit">${h}</div></div></div>
        <div class="pw-note" hidden></div></article>`).join('');
    } else {
      for (const i of changed) list.children[i].querySelector('.marpit').innerHTML = secs[i];
    }
    secs.forEach((_, i) => {
      const n = list.children[i].querySelector('.pw-note');
      n.innerHTML = deck.notes[i] ? esc(deck.notes[i]).replace(/\n/g, '<br>') : '<span class="pw-muted">ノートなし</span>';
      n.hidden = !$('#pw-notes').checked;
    });
    layout();
    $('#pw-title').textContent = deck.title;
    document.title = `${deck.title} — プレビュー`;
    $('#pw-status').textContent = `${secs.length}ページ`;
    if (why && prev.length && changed.length && changed.length < secs.length) {
      const i = changed[0];
      const el = list.children[i];
      for (const k of changed) { const c = list.children[k]; c.classList.remove('is-changed'); void c.offsetWidth; c.classList.add('is-changed'); }
      if ($('#pw-follow').checked) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#pw-status').textContent = `${secs.length}ページ　P.${changed.map((k) => k + 1).slice(0, 6).join('・')}${changed.length > 6 ? '…' : ''} を更新`;
    }
    prev = [...secs];
  };

  document.querySelector('#pw-cols').addEventListener('click', (e) => { const c = e.target.closest('[data-c]'); if (c) setCols(Number(c.dataset.c)); });
  $('#pw-notes').addEventListener('change', () => draw());
  $('#pw-present').addEventListener('click', () => {
    const i = Math.max(0, [...list.children].findIndex((el) => el.getBoundingClientRect().bottom > 80));
    openPresent(i); openPresenter(i);
  });
  $('#pw-edit').addEventListener('click', (e) => {
    const i = Math.max(0, [...list.children].findIndex((el) => el.getBoundingClientRect().bottom > 80));
    e.currentTarget.href = `/#${i + 1}`;
  });
  new ResizeObserver(layout).observe(list);
  deck.onChange((why) => draw(why || 'deck'));
  draw();
  setCols(cols);
  if (location.hash) document.querySelector(location.hash.replace(/^#(\d+)$/, '#p$1'))?.scrollIntoView();
}
