import { settings } from '../../shared/settings.mjs';
// 「書き方」の早見表。左で探して選び、右でこの資料のテーマのまま見本を見て、そのまま入れる。
//   このページに入れる … 今のページの末尾（分割表示では左のカーソルの位置）。ページの種類はページの先頭へ
//   新しいページで入れる … 今のページの後ろに1ページ足す
//   コピー … 記法をクリップボードへ
// フロントマターに書く設定（顔写真など）は、フロントマターへ書き足す。
import { jacketForDeck } from './templates.mjs';
import { CHEATSHEET, GROUPS, pageOf, previewOf } from '../../cheatsheet.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 注記の中の `記法` だけコードにする
const note = (s) => s.split(/(`[^`]+`)/).map((p) => (p.startsWith('`') ? `<code>${esc(p.slice(1, -1))}</code>` : esc(p))).join('');

// ページの先頭に置く1行（ページの種類など）。これがある項目は「このページに入れる」でこの行だけ足す
const DIRECTIVE = { cover: '<!-- _class: cover cover-talk -->', divider: '<!-- _class: divider -->', closing: '<!-- _class: closing back-cover -->', centered: '<!-- _class: centered -->', statement: '<!-- _class: statement -->', full: '<!-- _class: full -->', lead: '<!-- _class: lead-s -->', chapter: '<!-- chapter: 章の名前 -->', scoped: '<style scoped>section { --lead-scale: 1.1; }</style>' };
const FRONT = { photos: 'photos: [私=figs/me.png]' };
const NO_INSERT = new Set(['page', 'frontmatter', 'note']);

export function createCheatsheet({ modal, render, deckText, firstPage, insert, toast }) {
  let current = settings.getItem('mj-cheat') || 'dialogue';
  let query = '';

  function example(e, text) {
    return e.id === 'cover' || e.id === 'closing' ? jacketForDeck(text, firstPage()) : text;
  }

  // この資料のテーマ・色で描画し、見本専用の設定だけを上書きする。
  function previewMd(e) {
    const m = deckText().match(/^---\n([\s\S]*?)\n---/);
    const deckLines = m ? m[1].split('\n') : ['marp: true', 'theme: paper'];
    const extra = e.fm || [];
    const keys = new Set(extra.map((l) => l.split(':')[0].trim()));
    // style: | の続きの行も含めて残す
    const kept = [];
    let skipping = false;
    for (const l of deckLines) {
      const key = l.match(/^([A-Za-z_-]+):/)?.[1];
      if (key) skipping = keys.has(key) || key === 'paginate';
      if (!skipping) kept.push(l);
    }
    return `---\n${[...kept, ...extra].join('\n')}\n---\n\n${example(e, previewOf(e))}`;
  }

  function list() {
    const q = query.trim().toLowerCase();
    const hit = (e) => !q || `${e.name} ${e.when} ${e.syntax} ${(e.notes || []).join(' ')}`.toLowerCase().includes(q);
    return GROUPS.map(([g, label]) => {
      const items = CHEATSHEET.filter((e) => e.group === g && hit(e));
      if (!items.length) return '';
      return `<h3>${esc(label)}</h3>${items.map((e) => `<button type="button" class="${e.id === current ? 'is-on' : ''}" data-id="${e.id}"><b>${esc(e.name)}</b><small>${esc(e.when)}</small></button>`).join('')}`;
    }).join('') || '<p class="cs-none">見つかりません</p>';
  }

  function detail() {
    const e = CHEATSHEET.find((x) => x.id === current) || CHEATSHEET[0];
    const where = FRONT[e.id] ? 'フロントマターに書き足す' : DIRECTIVE[e.id] ? 'このページの先頭に入れる' : 'このページに入れる';
    return `
      <div class="cs-head">
        <div><h2>${esc(e.name)}</h2><p>${esc(e.when)}</p></div>
        <div class="cs-actions">
          ${NO_INSERT.has(e.id) ? '' : `<button type="button" class="mj-primary" data-act="here">${where}<kbd>⏎</kbd></button>`}
          ${FRONT[e.id] || e.id === 'frontmatter' ? '' : `<button type="button" data-act="page">新しいページで<kbd>⇧⏎</kbd></button>`}
        </div>
      </div>
      <div class="cs-preview" aria-label="見本"></div>
      <div class="cs-body">
        <div class="cs-code"><pre><code>${esc(example(e, e.syntax))}</code></pre>
          <button type="button" class="cs-copy" data-act="copy" title="記法をコピー（⌘C）">コピー</button></div>
        ${e.notes?.length ? `<ul class="cs-notes">${e.notes.map((n) => `<li>${note(n)}</li>`).join('')}</ul>` : '<div></div>'}
      </div>`;
  }

  function paintPreview() {
    const e = CHEATSHEET.find((x) => x.id === current);
    const host = modal.querySelector('.cs-preview');
    if (!e || !host) return;
    try {
      const { html, css } = render(previewMd(e));
      const sec = new DOMParser().parseFromString(html, 'text/html').querySelector('div.marpit > section');
      const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
      const w = host.clientWidth || 560;
      root.innerHTML = `<style>${css}
        :host { display: block; }
        .frame { width: ${w}px; height: ${(w * 720) / 1280}px; overflow: hidden; border-radius: 8px; box-shadow: 0 6px 24px #1a202c1f; }
        .scale { width: 1280px; height: 720px; transform: scale(${w / 1280}); transform-origin: 0 0; }</style>
        <div class="frame"><div class="scale"><div class="marpit">${sec ? sec.outerHTML : ''}</div></div></div>`;
    } catch (err) { host.textContent = `見本を描けませんでした: ${err.message}`; }
  }

  function paint(keepSearch = false) {
    modal.querySelector('.cs-list').innerHTML = list();
    modal.querySelector('.cs-detail').innerHTML = detail();
    paintPreview();
    modal.querySelector('.cs-list .is-on')?.scrollIntoView({ block: 'nearest' });
    if (!keepSearch) modal.querySelector('.cs-search').focus();
  }

  function select(id) {
    current = id;
    settings.setItem('mj-cheat', id);
    paint(true);
  }

  async function act(kind) {
    const e = CHEATSHEET.find((x) => x.id === current);
    if (!e) return;
    if (kind === 'copy') {
      try { await navigator.clipboard.writeText(example(e, e.syntax)); toast(`「${e.name}」の書き方をコピーしました`); } catch { toast('コピーできませんでした', 'error'); }
      return;
    }
    if (kind === 'here' && NO_INSERT.has(e.id)) return;
    if (kind === 'page' && (FRONT[e.id] || e.id === 'frontmatter')) return;
    close();
    if (kind === 'page') insert({ mode: 'page', text: example(e, pageOf(e)), label: e.name });
    else if (FRONT[e.id]) insert({ mode: 'front', text: FRONT[e.id], label: e.name });
    else if (DIRECTIVE[e.id]) insert({ mode: 'top', text: DIRECTIVE[e.id], label: e.name });
    else insert({ mode: 'here', text: e.syntax, label: e.name });
  }

  function close() {
    window.removeEventListener('keydown', onKey, true);
    modal.hidden = true; modal.innerHTML = ''; modal.onclick = null; modal.ondblclick = null;
  }
  const visible = () => [...modal.querySelectorAll('.cs-list [data-id]')].map((b) => b.dataset.id);
  const onKey = (e) => {
    if (!modal.querySelector('.cs-dialog')) return window.removeEventListener('keydown', onKey, true);
    let done = true;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const ids = visible(); const i = ids.indexOf(current);
      const next = ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? -1 : i) + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next);
    } else if (e.key === 'Enter') act(e.shiftKey ? 'page' : 'here');
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !getSelection().toString()) act('copy');
    else done = false;
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  };

  function open() {
    query = ''; // 開くたびに探し直す（選んでいた項目は覚えておく）
    modal.hidden = false;
    modal.innerHTML = `
      <section class="cs-dialog" role="dialog" aria-modal="true" aria-label="書き方">
        <aside class="cs-side">
          <div class="cs-title"><strong>書き方</strong><span>選ぶと右に見本。⏎ でこのページへ</span></div>
          <input class="cs-search" type="search" placeholder="部品を探す（例：掛け合い、表、倍率）" value="${esc(query)}" autocomplete="off">
          <nav class="cs-list"></nav>
        </aside>
        <div class="cs-main">
          <button type="button" class="cs-close" data-act="close" aria-label="閉じる">✕</button>
          <div class="cs-detail"></div>
        </div>
      </section>`;
    const search = modal.querySelector('.cs-search');
    search.addEventListener('input', () => {
      query = search.value;
      modal.querySelector('.cs-list').innerHTML = list();
      const ids = visible();
      if (ids.length && !ids.includes(current)) select(ids[0]);
    });
    modal.onclick = (e) => {
      if (e.target === modal) return close();
      const id = e.target.closest('[data-id]')?.dataset.id;
      if (id) return select(id);
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'close') close(); else if (a) act(a);
    };
    modal.ondblclick = (e) => { if (e.target.closest('.cs-list [data-id]')) act('here'); };
    window.addEventListener('keydown', onKey, true);
    paint();
  }

  return { open, close, previewMd };
}
