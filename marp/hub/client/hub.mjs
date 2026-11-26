import { CHEATSHEET } from '../../cheatsheet.mjs';
import { openSettings } from '../../shared/app-settings.mjs';
import { settings } from '../../shared/settings.mjs';
// ライブラリー（ハブ）の画面。ギャラリー・資料の詳細・Git（資料単位のコミット・履歴・版の比較・復元、リポジトリ単位のpush/pull）。
// 表紙やページのサムネイルは、エディターと同じ marp-core + plugin.mjs で描き、資料ごとのテーマが混ざらないよう Shadow DOM に入れる。
import { Marp } from '@marp-team/marp-core';
import jinnoPlugin from '../../plugin.mjs';
import { rangesFromText, splitSlides } from '../../editor/client/markdown.mjs';
import { alignPages } from '../../lib/diff.mjs';
import { icon } from '../../editor/client/icons.mjs';
import { guardIME } from '../../editor/client/ime.mjs';
import { confirmDialog, promptDialog } from '../../shared/dialog.mjs';
import {
  pickLibraryFolder, hubFolderInfo, onLibraryDrop, hubInfo, hubLibraries, hubAddLibrary, hubDecks, hubCreateDeck, hubDeckText, hubDeckOp,
  hubOpen, hubPdf, cancelHubPdf, hubGit, hubFileUrl, hubGitFileUrl, openDeckWindow, openFileWindow, closeDeckWindow, runtimeStatus, inTauri, openHubExport,
} from '../../editor/client/backend.mjs';
window.addEventListener('settings-error', () => toast('設定を読み書きできませんでした。フォルダの権限と空き容量を確かめてください', 'error'));
guardIME(); // 日本語の変換を確定する Enter を、アプリの操作として受け取らない


const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDate = (ms) => { const d = new Date(ms); const now = new Date(); const same = d.toDateString() === now.toDateString(); return same ? `今日 ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' }); };

let pdfBusy = false; // 一度に1つだけ PDF を書き出す
const state = { libs: [], lib: new URLSearchParams(location.search).get('lib') || settings.getItem('hb-lib') || '', decks: [], q: '', tag: '', theme: '', sort: settings.getItem('hb-sort') || 'updated', archived: false, detail: null, selected: null };

// --- 描画（Marp） -----------------------------------------------------------------------
let marp;
async function setupMarp() {
  const info = await hubInfo();
  state.debug = info.debug; state.templates=info.templates;
  state.themes=info.themes.map(css=>css.match(/@theme\s+([^\s*]+)/)?.[1]).filter(Boolean);
  marp = new Marp({ html: true, inlineSVG: false, emoji: { shortcode: false, unicode: false }, math: false, minifyCSS: false, script: false });
  for (const css of info.themes) marp.themeSet.add(css);
  marp.use(jinnoPlugin);
}
// text を描いて、各ページの section と CSS を返す。画像の参照は srcOf(相対パス) で差し替える
function renderDeck(text, srcOf) {
  const { html, css } = marp.render(text);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll('img[src]')) {
    const s = img.getAttribute('src');
    if (!/^(data:|https?:|\/)/.test(s)) img.setAttribute('src', srcOf(s));
  }
  return { css, sections: [...tpl.content.querySelectorAll('div.marpit > section')].map((s) => s.outerHTML) };
}
// 表紙だけ（フロントマター＋1ページ目）を描く。全ページを描くより速い
function coverText(text) {
  const r = rangesFromText(text);
  const lines = text.split('\n');
  return lines.slice(0, r[0].start).join('\n') + '\n' + lines.slice(r[0].start, r[0].end).join('\n');
}
function mountSlide(host, css, section, width) {
  const s = width / 1280;
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${css}\n:host{display:block;width:${width}px;height:${720 * s}px;overflow:hidden;background:#fff}.sc{width:1280px;height:720px;transform:scale(${s});transform-origin:0 0}</style><div class="sc"><div class="marpit">${section}</div></div>`;
}

// --- ライブラリーとギャラリー ---------------------------------------------------------------
async function loadLibraries() {
  const { libraries } = await hubLibraries();
  state.libs = libraries;
  if (!libraries.some((l) => l.id === state.lib)) state.lib = libraries[0].id;
  $('#lib-select').innerHTML = libraries.map((l) => `<option value="${esc(l.id)}" ${l.id === state.lib ? 'selected' : ''}>${esc(l.name)}（${esc(l.path)}）</option>`).join('');
  renderGitBar();
}
const curLib = () => state.libs.find((l) => l.id === state.lib);

async function loadDecks() {
  const { decks } = await hubDecks({ lib: state.lib, archived: state.archived });
  state.decks = decks;
  renderFilters();
  renderGallery();
}

function renderFilters() {
  const tags = new Map(), themes = new Map();
  for (const d of state.decks) { for (const t of d.tags) tags.set(t, (tags.get(t) || 0) + 1); themes.set(d.event || d.theme, (themes.get(d.event || d.theme) || 0) + 1); }
  const chip = (kind, v, n, on) => `<button type="button" class="hb-chip ${on ? 'is-on' : ''}" data-${kind}="${esc(v)}">${esc(v)}<span>${n}</span></button>`;
  $('#filters').innerHTML = [...themes].map(([v, n]) => chip('theme', v, n, state.theme === v)).join('') + (tags.size ? '<span class="hb-sep"></span>' : '') + [...tags].sort((a, b) => b[1] - a[1]).map(([v, n]) => chip('tag', v, n, state.tag === v)).join('');
}
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.hb-chip');
  if (!b) return;
  if (b.dataset.tag != null) state.tag = state.tag === b.dataset.tag ? '' : b.dataset.tag;
  if (b.dataset.theme != null) state.theme = state.theme === b.dataset.theme ? '' : b.dataset.theme;
  renderFilters(); renderGallery();
});

function visibleDecks() {
  const q = state.q.trim().toLowerCase();
  let list = state.decks.filter((d) => d.archived === state.archived && (!q || `${d.title} ${d.slug} ${d.tags.join(' ')} ${d.event}`.toLowerCase().includes(q)) && (!state.tag || d.tags.includes(state.tag)) && (!state.theme || (d.event || d.theme) === state.theme));
  if (state.sort === 'title') list = list.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  if (state.sort === 'pages') list = list.sort((a, b) => b.pages - a.pages);
  return list;
}

const coverCache = new Map(); // key: lib/slug/updated → { css, section }
let coverObserver;
const coverWidths = new WeakMap();
const coverSizer = new ResizeObserver(entries => {
  for (const {target: card} of entries) {
    const el = card.querySelector('.hb-cover');
    if (el?.shadowRoot && Math.abs((coverWidths.get(el) || 0) - card.clientWidth) > 0.5) requestAnimationFrame(() => { if (el.isConnected) drawCover(el); });
  }
});
function renderGallery() {
  const list = visibleDecks();
  const g = $('#gallery');
  coverObserver?.disconnect(); coverSizer.disconnect();
  if (!state.decks.length) {
    g.innerHTML = `<div class="hb-empty"><h2>このライブラリーにはまだ資料がありません</h2>
      <p>${esc(curLib()?.path || '')}</p>
      <div><button type="button" class="hb-primary" data-n="template">雛形から作る</button><button type="button" data-n="folder">フォルダから取り込む</button></div></div>`;
    return;
  }
  if (!list.length) { g.innerHTML = '<div class="hb-empty"><p>条件に合う資料がありません</p></div>'; return; }
  g.innerHTML = list.map((d) => `<article class="hb-card ${d.archived ? 'is-archived' : ''}" data-slug="${esc(d.slug)}" tabindex="0">
      <div class="hb-cover" data-cover="${esc(d.slug)}"></div>
      <div class="hb-card-body">
        <h3 title="${esc(d.title)}">${esc(d.title)}</h3>
        <p class="hb-meta">${d.pages}ページ・${fmtDate(d.updated)}${d.event ? `・${esc(d.event)}` : ''}</p>
        <p class="hb-tags">${d.tags.map((t) => `<span>${esc(t)}</span>`).join('')}${d.changes ? `<span class="hb-dirty" title="未コミットの変更">● 未コミット ${d.changes}</span>` : ''}${d.archived ? '<span class="hb-arch">アーカイブ</span>' : ''}</p>
      </div>
      <div class="hb-card-actions">
        <button type="button" data-a="edit" title="編集">編集</button>
        <button type="button" data-a="split" title="左にMarkdown、右にスライドで編集">分割</button>
        <button type="button" data-a="present" title="発表">▶</button>
      </div>
    </article>`).join('');
  coverObserver?.disconnect();
  coverObserver = new IntersectionObserver((ents) => { for (const en of ents) if (en.isIntersecting) { coverObserver.unobserve(en.target); drawCover(en.target); } }, { rootMargin: '300px' });
  $$('.hb-cover', g).forEach((el) => coverObserver.observe(el));
  $$('.hb-card', g).forEach(el => coverSizer.observe(el));
}
async function drawCover(el) {
  try {
  const d = state.decks.find((x) => x.slug === el.dataset.cover);
  if (!d) return;
  const key = `${state.lib}/${d.slug}/${d.updated}`;
  let c = coverCache.get(key);
  if (!c) {
    const { text } = await hubDeckText({ lib: state.lib, slug: d.slug });
    const r = renderDeck(coverText(text), (s) => hubFileUrl(state.lib, d.slug, s));
    c = { css: r.css, section: r.sections[0] || '' };
    coverCache.set(key, c);
  }
  if (!el.isConnected) return;
  const width = el.closest('.hb-card').clientWidth;
  coverWidths.set(el, width);
  mountSlide(el, c.css, c.section, width);
  } catch (e) {
    // 名前変更・移動で破棄されたカードへの返事は反映しない。
    if (el.isConnected) el.textContent='表紙を読み込めません';
  }
}

$('#gallery').addEventListener('click', async (e) => {
  const n = e.target.closest('[data-n]')?.dataset.n;
  if (n) return openNew(n);
  const card = e.target.closest('.hb-card');
  if (!card) return;
  const slug = card.dataset.slug;
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a) { e.stopPropagation(); return openDeck(slug, a); }
  selectCard(slug);
});
function selectCard(slug) {
  state.selected = slug;
  for (const card of $$('.hb-card')) card.classList.toggle('is-selected', card.dataset.slug === slug);
}
$('#gallery').addEventListener('dblclick', e => {
  const card=e.target.closest('.hb-card');
  if (card && !e.target.closest('button')) openDeck(card.dataset.slug);
});
$('#gallery').addEventListener('keydown', e => {
  if (!e.target.classList.contains('hb-card')) return;
  if (e.key === 'Enter') { e.preventDefault(); openDeck(e.target.dataset.slug); }
  if (e.key === ' ') { e.preventDefault(); openDetail(e.target.dataset.slug); }
});
const cardMenu = document.createElement('div');
cardMenu.id = 'card-menu'; cardMenu.className = 'hb-menu'; cardMenu.hidden = true;
cardMenu.setAttribute('role', 'menu'); document.body.appendChild(cardMenu);
let menuDeck;
function closeCardMenu() { cardMenu.hidden = true; }
$('#gallery').addEventListener('contextmenu', e => {
  const card = e.target.closest('.hb-card'); if (!card) return;
  e.preventDefault(); selectCard(card.dataset.slug); card.focus();
  menuDeck = state.decks.find(d => d.slug === card.dataset.slug);
  const actions = [['edit','開く'],['split','Markdown と並べて開く'],['present','発表'],['pdf','PDFを書き出す'],['duplicate','複製'],['rename','名前を変更…'],[menuDeck.archived?'unarchive':'archive',menuDeck.archived?'アーカイブから戻す':'アーカイブ'],['reveal','Finder で表示'],['trash','ゴミ箱に入れる…']];
  cardMenu.innerHTML = actions.map(([key,label]) => `<button type="button" data-x="${key}">${label}</button>`).join('');
  cardMenu.hidden = false;
  cardMenu.style.left = Math.max(8,Math.min(e.clientX,innerWidth-cardMenu.offsetWidth-8))+'px';
  cardMenu.style.top = Math.max(8,Math.min(e.clientY,innerHeight-cardMenu.offsetHeight-8))+'px';
  cardMenu.querySelector('button').focus();
});
cardMenu.addEventListener('click', e => { if (!e.target.closest('button')) return; closeCardMenu(); onDetailClick(e,menuDeck); });
cardMenu.addEventListener('keydown', e => {
  if (!['ArrowUp','ArrowDown'].includes(e.key)) return;
  e.preventDefault(); const items=$$('button',cardMenu), i=items.indexOf(document.activeElement);
  items[(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
});
document.addEventListener('click', e => { if (!e.target.closest('#card-menu')) closeCardMenu(); });

// 資料の slides.md の場所（アプリの中では、この場所でウインドウを閉じる）
function deckPathOf(slug) {
  const l = curLib();
  return l?.path ? `${l.path.replace(/\/$/, '')}/${slug}/slides.md` : undefined;
}

async function openDeck(slug, view = 'edit', page) {
  try {
    // アプリの中では Rust が新しいウインドウを開く（別の process のサーバーは立てない）。
    // ブラウザでは今までどおり、ハブが起こしたエディターのサーバーを新しいタブで開く。
    const l = curLib();
    const deckPath = l?.path ? `${l.path.replace(/\/$/, '')}/${slug}/slides.md` : undefined;
    const r = await openDeckWindow({ lib: state.lib, slug, view, page, deckPath });
    if (r?.url && !r.opened) window.open(r.url, view === 'present' ? 'mj-present' : `mj-edit-${slug}`);
  } catch (err) { toast(err.message, 'error'); }
}

// --- Gitのバー（リポジトリ単位） ----------------------------------------------------------------
function renderGitBar() {
  const l = curLib();
  const bar = $('#git-bar');
  if (!l) return;
  const menu = html => `<button type="button" id="btn-sync" aria-haspopup="menu">同期 ▾</button><span id="sync-menu" class="hb-menu" role="menu" hidden>${html}</span>`;
  if (!l.git) {
    bar.innerHTML = menu( `<span class="hb-muted">Git未管理</span><button type="button" data-g="init">Gitを始める</button>`);
    return;
  }
  const g = l.git;
  const sync = g.remote ? (g.upstream ? `↑${g.ahead} ↓${g.behind}` : '未送信') : 'リモートなし';
  bar.innerHTML = menu(`<span class="hb-branch" title="${esc(g.repo)}">${icon('outline', 13)} ${esc(g.branch || '')}</span>
    <span class="hb-sync ${g.behind ? 'is-behind' : ''}" title="${esc(g.remote || 'リモートが設定されていません')}">${esc(sync)}</span>
    ${l.changes ? `<span class="hb-dirty">未コミット ${l.changes}</span>` : ''}
    ${g.remote ? `<button type="button" data-g="fetch" title="リモートの状態を確認（git fetch）">確認</button>
      <button type="button" data-g="pull" title="リモートの変更を取り込む（fast-forwardのみ）" ${g.behind ? '' : 'disabled'}>取り込む</button>
      <button type="button" data-g="push" title="コミットをリモートへ送る（git push）" ${g.ahead || !g.upstream ? '' : 'disabled'}>送る</button>`
      : `<button type="button" data-g="remote">リモートを設定</button>`}`);
}
$('#git-bar').addEventListener('click', async (e) => {
  if (e.target.closest('#btn-sync')) { $('#sync-menu').hidden = !$('#sync-menu').hidden; return; }
  const op = e.target.closest('[data-g]')?.dataset.g;
  if (!op) return;
  const btn = e.target.closest('button');
  $('#sync-menu').hidden = true;
  if (op === 'remote') return openRemoteDialog();
  if (op === 'push' && !(await confirmDialog({ title: 'リモートへ送る', message: `このライブラリーのコミットを ${curLib().git.remote} へ送ります。よろしいですか？`, ok: '送る' }))) return;
  btn.disabled = true;
  try {
    await hubGit(op, { lib: state.lib });
    toast({ init: 'Gitを始めました（最初のコミットを作成）', fetch: 'リモートの状態を確認しました', pull: 'リモートの変更を取り込みました', push: 'リモートへ送りました' }[op]);
    await loadLibraries(); await loadDecks();
  } catch (err) { toast(err.message, 'error'); await loadLibraries(); }
});
function openRemoteDialog() {
  dialog(`<h2>リモートを設定</h2>
    <p class="hb-muted">GitHubなどのリポジトリのURLを入れます。送る（push）のは「送る」を押したときだけです。</p>
    <label class="hb-field">URL<input id="remote-url" placeholder="git@github.com:you/slides.git または https://github.com/you/slides.git"></label>
    <div class="hb-dialog-actions"><button type="button" data-d="cancel">やめる</button><button type="button" data-d="ok" class="hb-primary">設定する</button></div>`, async (act, box) => {
    if (act !== 'ok') return true;
    const u = $('#remote-url', box).value.trim();
    if (!u) return false;
    await hubGit('remote', { lib: state.lib, url: u });
    toast('リモートを設定しました');
    await loadLibraries();
    return true;
  });
}

// --- 資料の詳細 ---------------------------------------------------------------------
async function openDetail(slug, tab = 'pages') {
  const d = state.decks.find((x) => x.slug === slug);
  if (!d) return;
  state.detail = { slug, tab };
  const el = $('#detail');
  el.hidden = false;
  document.body.classList.add('with-detail');
  el.innerHTML = `<div class="hb-detail-head">
      <button type="button" class="hb-close" data-x="close" title="閉じる（Esc）">×</button>
      <div class="hb-detail-title"><h2>${esc(d.title)}</h2><p class="hb-muted">${esc(d.slug)}・${d.pages}ページ・${fmtDate(d.updated)}</p></div>
    </div>
    <div class="hb-detail-actions">
      <button type="button" class="hb-primary" data-x="edit">編集</button>
      <button type="button" data-x="split">分割で編集</button>
      <button type="button" data-x="present">▶ 発表</button>
      <button type="button" data-x="pdf">PDFを書き出す</button>
      <span class="hb-spacer"></span>
      <button type="button" data-x="duplicate">複製</button>
      <button type="button" data-x="rename">名前を変える</button>
      <button type="button" data-x="${d.archived ? 'unarchive' : 'archive'}">${d.archived ? 'アーカイブから戻す' : 'アーカイブ'}</button>
    </div>
    <nav class="hb-tabs"><button type="button" data-tab="pages" class="${tab === 'pages' ? 'is-on' : ''}">ページ</button><button type="button" data-tab="git" class="${tab === 'git' ? 'is-on' : ''}">変更と履歴${d.changes ? `<span class="hb-count">${d.changes}</span>` : ''}</button></nav>
    <div id="detail-body"></div>`;
  el.onclick = (e) => onDetailClick(e, d);
  if (tab === 'pages') renderPages(d); else renderGit(d);
}
function closeDetail() { $('#detail').hidden = true; document.body.classList.remove('with-detail'); state.detail = null; }

async function renderPages(d) {
  const body = $('#detail-body');
  body.innerHTML = '<p class="hb-muted">読み込み中…</p>';
  let text;
  try { ({text}=await hubDeckText({lib:state.lib,slug:d.slug})); }
  catch(e) {if(body.isConnected)body.textContent='ページを読み込めませんでした。資料を開き直してください。';return;}
  if(!body.isConnected || state.detail?.slug!==d.slug)return;
  const r = renderDeck(text, (s) => hubFileUrl(state.lib, d.slug, s));
  body.innerHTML = `<div class="hb-pages">${r.sections.map((_, i) => `<figure class="hb-page" data-page="${i + 1}"><div class="hb-page-slide"></div><figcaption>P.${i + 1}</figcaption></figure>`).join('')}</div>`;
  const io = new IntersectionObserver((ents) => { for (const en of ents) if (en.isIntersecting) { io.unobserve(en.target); const i = Number(en.target.closest('.hb-page').dataset.page) - 1; mountSlide(en.target, r.css, r.sections[i], en.target.clientWidth || 200); } }, { root: $('#detail'), rootMargin: '300px' });
  $$('.hb-page-slide', body).forEach((x) => io.observe(x));
}

async function renderGit(d) {
  const body = $('#detail-body');
  const l = curLib();
  if (!l.git) { body.innerHTML = `<div class="hb-empty-small"><p>このライブラリーはGitで管理されていません。</p><button type="button" data-x="git-init" class="hb-primary">Gitを始める</button></div>`; return; }
  body.innerHTML = '<p class="hb-muted">読み込み中…</p>';
  const [st, lg] = await Promise.all([hubGit('status', { lib: state.lib, slug: d.slug }), hubGit('log', { lib: state.lib, slug: d.slug })]);
  const kind = { added: '追加', modified: '変更', deleted: '削除' };
  body.innerHTML = `<section class="hb-panel">
      <h3>この資料の未コミットの変更 <span class="hb-muted">${st.count}件</span></h3>
      ${st.count ? `<ul class="hb-files">${st.files.map((f) => `<li><span class="hb-kind is-${f.kind}">${kind[f.kind]}</span>${esc(f.file.split('/').slice(-2).join('/'))}</li>`).join('')}</ul>
        <div class="hb-commit"><input id="commit-msg" placeholder="コミットのメッセージ（例：P.12の図を直した）" autocomplete="off"><button type="button" data-x="commit" class="hb-primary">この資料だけコミット</button></div>
        <p class="hb-muted">コミットするのはこの資料のフォルダだけです。ほかの資料の変更は含めません。${st.count ? '<button type="button" class="hb-link" data-x="diff-worktree">変更を見る</button>' : ''}</p>`
        : '<p class="hb-muted">変更はありません。</p>'}
    </section>
    <section class="hb-panel">
      <h3>履歴 <span class="hb-muted">${lg.log.length}件</span></h3>
      ${lg.log.length ? `<ol class="hb-log">${lg.log.map((c, k) => `<li data-rev="${c.hash}">
          <div><b>${esc(c.subject)}</b><span class="hb-muted">${esc(c.short)}・${esc(new Date(c.date).toLocaleString('ja-JP'))}・${esc(c.author)}</span>${c.stat ? `<span class="hb-stat">${esc(c.stat.replace(/files? changed/, 'ファイル').replace(/insertions?\(\+\)/, '行追加').replace(/deletions?\(-\)/, '行削除'))}</span>` : ''}</div>
          <div class="hb-log-actions"><button type="button" data-x="diff" data-rev="${c.hash}">変更を見る</button>${k ? `<button type="button" data-x="restore" data-rev="${c.hash}">この版に戻す</button>` : ''}</div>
        </li>`).join('')}</ol>` : '<p class="hb-muted">まだコミットがありません。</p>'}
    </section>`;
}

async function onDetailClick(e, d) {
  const b = e.target.closest('[data-x], [data-tab]');
  if (!b) return;
  if (b.dataset.tab) return openDetail(d.slug, b.dataset.tab);
  const x = b.dataset.x;
  try {
    if (x === 'close') return closeDetail();
    if (x === 'edit' || x === 'split' || x === 'present') return openDeck(d.slug, x);
    if (x === 'pdf') {
      if (pdfBusy) return;
      pdfBusy = true;
      b.disabled = true; b.textContent = '書き出し中…';
      try {
        const st = await runtimeStatus();
        if (!st.native && (!st.node || !st.chrome)) throw new Error(st.message);
        toast('PDF を書き出しています…', 'info', inTauri ? [{ label: 'やめる', run: () => cancelHubPdf() }] : [], true);
        const r = await hubPdf({ lib: state.lib, slug: d.slug });
        if(r.cancelled){toast('書き出しをキャンセルしました');return;}
        if(!inTauri)await openFileWindow(r.url);
        const lib=state.lib,slug=d.slug;
        toast('PDF を書き出しました','info',inTauri?[{label:'開く',run:()=>openHubExport(lib,slug)},{label:'Finder で表示',run:()=>openHubExport(lib,slug,true)}]:[]);
      } finally {
        pdfBusy = false;
        b.disabled = false; b.textContent = 'PDFを書き出す';
      }
      return;
    }
    if (x === 'duplicate') { const r = await hubDeckOp({ lib: state.lib, slug: d.slug, op: 'duplicate' }); toast(`複製しました（${r.slug}）`); await loadDecks(); return openDetail(r.slug); }
    if (x === 'rename') {
      return dialog(`<h2>名前を変更</h2><p>${inTauri ? '開いているエディターを保存して閉じます。' : 'ブラウザの編集タブは先に保存してください。'}</p>
        <label class="hb-field">題名<input id="rename-title" value="${esc(d.title)}"></label>
        <details><summary>詳しい設定</summary><label class="hb-field">フォルダ名<input id="rename-folder" value="${esc(d.slug.replace(/^_archive\//,''))}"></label></details>
        <div class="hb-dialog-actions"><button type="button" data-d="cancel">やめる</button><button type="button" data-d="ok" class="hb-primary">変更する</button></div>`, async (act, box) => {
        if (act !== 'ok') return true;
        const title = $('#rename-title', box).value.trim(), to = $('#rename-folder', box).value.trim();
        if (!title) { toast('題名を入れてください','error'); $('#rename-title',box).focus(); return false; }
        await closeDeckWindow(deckPathOf(d.slug));
        let r;
        try { r=await hubDeckOp({lib:state.lib,slug:d.slug,op:'rename',to,title}); }
        catch (e) { if (inTauri) await openDeckWindow({deckPath:deckPathOf(d.slug)}); throw e; }
        toast('名前を変更しました'); await loadDecks(); await openDetail(r.slug); return true;
      });
    }
    if (x === 'reveal') { await hubDeckOp({lib:state.lib,slug:d.slug,op:'reveal'}); return; }
    if (x === 'trash') {
      if (!await confirmDialog({title:'ゴミ箱に入れる',message:`「${d.title}」をゴミ箱に移します。${inTauri ? '開いているエディターは保存して閉じます。' : 'ブラウザの編集タブは先に保存してください。'}`,ok:'ゴミ箱に入れる',danger:true})) return;
      await closeDeckWindow(deckPathOf(d.slug));
      await hubDeckOp({lib:state.lib,slug:d.slug,op:'trash'});
      closeDetail(); await loadDecks(); await loadLibraries(); toast('ゴミ箱に移しました'); return;
    }
    if (x === 'archive' || x === 'unarchive') {
      const lib = state.lib;
      try { await closeDeckWindow(deckPathOf(d.slug)); } catch (e) { return toast(String(e.message || e), 'error'); }
      const r = await hubDeckOp({ lib: state.lib, slug: d.slug, op: x });
      toast(x === 'archive' ? 'アーカイブに移しました' : 'アーカイブから戻しました', 'info', x === 'archive' ? [{ label: '元に戻す', run: async () => { try { await hubDeckOp({ lib, slug: r.slug, op: 'unarchive' }); closeDetail(); await loadDecks(); await loadLibraries(); } catch (e) { toast(String(e.message || e), 'error'); } } }] : []);
      closeDetail(); await loadDecks(); await loadLibraries(); return void r;
    }
    if (x === 'git-init') { await hubGit('init', { lib: state.lib }); await loadLibraries(); return renderGit(d); }
    if (x === 'commit') {
      const msg = $('#commit-msg').value.trim();
      if (!msg) { $('#commit-msg').focus(); return toast('メッセージを入れてください', 'error'); }
      b.disabled = true;
      const r = await hubGit('commit', { lib: state.lib, slug: d.slug, message: msg });
      toast(`コミットしました（${r.hash}）`);
      await loadLibraries(); await loadDecks();
      return openDetail(d.slug, 'git');
    }
    if (x === 'diff') return openDiff(d, b.dataset.rev);
    if (x === 'diff-worktree') return openDiff(d, 'WORKTREE');
    if (x === 'restore') {
      if (!(await confirmDialog({ title: 'この版に戻す', message: 'この資料をこの版の内容に戻します。今のファイルは書き換わります（戻した結果は未コミットの変更になるので、気に入らなければ履歴から戻せます）。よろしいですか？', ok: '戻す', danger: true }))) return;
      await hubGit('restore', { lib: state.lib, slug: d.slug, rev: b.dataset.rev });
      toast('この版の内容に戻しました（未コミット）');
      await loadDecks(); await loadLibraries();
      return openDetail(d.slug, 'git');
    }
  } catch (err) { toastError(err); b.disabled = false; }
}

// --- 版の比較（変わったページだけ前後を並べる） ------------------------------------------------------
async function openDiff(d, rev) {
  const ov = $('#overlay');
  ov.hidden = false;
  ov.innerHTML = '<div class="hb-diff"><p class="hb-muted">読み込み中…</p></div>';
  const q = (r) => hubGit('file', { lib: state.lib, slug: d.slug, rev: r });
  const after = await q(rev);
  const beforeRev = after.parent;
  const before = beforeRev ? await q(beforeRev) : { text: null };
  const src = (r) => (s) => hubGitFileUrl(state.lib, r, `${d.slug}/${s}`);
  const A = before.text ? renderDeck(before.text, src(beforeRev)) : { css: '', sections: [] };
  const B = after.text ? renderDeck(after.text, src(rev)) : { css: '', sections: [] };
  const chunks = (t) => (t ? splitSlides(t).chunks.map((c) => c.join('\n')) : []);
  const ops = alignPages(chunks(before.text), chunks(after.text));
  const changed = ops.filter((o) => o.t !== 'same');
  const label = { mod: '変更', add: '追加', del: '削除' };
  const title = rev === 'WORKTREE' ? '未コミットの変更（最後のコミット → 今のファイル）' : `${rev.slice(0, 7)} の変更（${beforeRev ? beforeRev.slice(0, 7) : 'なし'} → ${rev.slice(0, 7)}）`;
  ov.innerHTML = `<div class="hb-diff" role="dialog" aria-label="版の比較">
    <div class="hb-diff-head"><h2>${esc(title)}</h2><span class="hb-muted">変更 ${changed.filter((o) => o.t === 'mod').length}・追加 ${changed.filter((o) => o.t === 'add').length}・削除 ${changed.filter((o) => o.t === 'del').length}（変わらないページ ${ops.length - changed.length}）</span><span class="hb-spacer"></span><button type="button" data-close>閉じる（Esc）</button></div>
    <div class="hb-diff-cols"><span>前（${beforeRev ? esc(beforeRev.slice(0, 7)) : 'なし'}）</span><span>後（${rev === 'WORKTREE' ? '今のファイル' : esc(rev.slice(0, 7))}）</span></div>
    <div class="hb-diff-list">${changed.length ? changed.map((o, k) => `<div class="hb-diff-row is-${o.t}">
        <div class="hb-diff-label">${label[o.t]}　${o.a != null ? `P.${o.a + 1}` : ''}${o.a != null && o.b != null ? ' → ' : ''}${o.b != null ? `P.${o.b + 1}` : ''}</div>
        <div class="hb-diff-pair"><div class="hb-diff-a" data-k="${k}">${o.a == null ? '<span class="hb-none">（なし）</span>' : ''}</div><div class="hb-diff-b" data-k="${k}">${o.b == null ? '<span class="hb-none">（なし）</span>' : ''}</div></div>
      </div>`).join('') : '<p class="hb-muted">スライドの内容は変わっていません（図のファイルだけの変更かもしれません）。</p>'}</div></div>`;
  changed.forEach((o, k) => {
    const w = Math.min(560, (ov.clientWidth - 120) / 2);
    if (o.a != null) mountSlide($(`.hb-diff-a[data-k="${k}"]`, ov), A.css, A.sections[o.a], w);
    if (o.b != null) mountSlide($(`.hb-diff-b[data-k="${k}"]`, ov), B.css, B.sections[o.b], w);
  });
  ov.onclick = (e) => { if (e.target === ov || e.target.closest('[data-close]')) { ov.hidden = true; ov.innerHTML = ''; } };
}

// --- 新しい資料・取り込み ----------------------------------------------------------------
function dialog(html, onAct) {
  const ov = $('#overlay');
  ov.hidden = false;
  ov.innerHTML = `<div class="hb-dialog" role="dialog">${html}</div>`;
  const box = $('.hb-dialog', ov);
  box.querySelector('input, select')?.focus();
  const close = () => { if (box.isConnected) { ov.hidden = true; ov.innerHTML = ''; } };
  box.onclick = async (e) => {
    const act = e.target.closest('[data-d]')?.dataset.d;
    if (!act) return;
    try { if (await onAct(act, box, e.target.closest('[data-d]')) !== false) close(); } catch (err) { toast(err.message, 'error'); }
  };
  box.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('input')) box.querySelector('[data-d="ok"]')?.click(); if (e.key === 'Escape') close(); };
  ov.onclick = (e) => { if (e.target === ov) close(); };
}
async function openNew(kind, initialPath = '') {
  $('#new-menu').hidden = true;
  if(inTauri && ['folder','library'].includes(kind) && !initialPath){
    try {initialPath=await pickLibraryFolder(kind);if(!initialPath)return;}catch(e){toastError(e);return;}
  }
  if (kind === 'template') {
    const names = {talk: '登壇（短い雛形）', update: 'クラウドのアップデート紹介',
      release: 'アプリのアップデート紹介', webinar: 'ウェビナー', lightning: 'ライトニングトーク', blank: '白紙'};
    const themes = {paper: 'Paper（紫）', petrol: 'Petrol（青緑）'};
    const templates=state.templates;
    let selected='talk';
    dialog(`<h2>資料の型を選ぶ</h2><p class="hb-muted">用途に合う型から始めて、本文や図を書き換えます。</p>
      <div class="hb-template-grid">${templates.map(t=>`<button type="button" class="hb-template ${t.name===selected?'is-on':''}" data-template="${esc(t.name)}" aria-pressed="${t.name===selected}" title="${esc(t.description)}"><span class="hb-template-preview"></span><b>${esc(names[t.name]||t.name)}</b></button>`).join('')}</div>
      <label class="hb-field">題名<input id="n-title" placeholder="空なら型の見本の題名を使います"></label>
      <label class="hb-field">テーマ<select id="n-theme">${state.themes.map(t=>`<option value="${esc(t)}">${esc(themes[t]||t)}</option>`).join('')}</select></label>
      <details><summary>詳しい設定</summary><label class="hb-field">フォルダ名<input id="n-slug" placeholder="空なら題名から作ります"></label></details>
      <div class="hb-dialog-actions"><button type="button" data-d="cancel">やめる</button><button type="button" data-d="ok" class="hb-primary">作って開く</button></div>`, async (act,box,button)=>{
        if(act!=='ok')return true;
        button.disabled=true;
        try {
          const r=await hubCreateDeck({lib:state.lib,from:'template',template:selected,title:$('#n-title',box).value.trim(),slug:$('#n-slug',box).value.trim(),theme:$('#n-theme',box).value});
          await loadDecks();await loadLibraries();toast('資料を作成しました');await openDeck(r.slug,'edit');return true;
        } finally {button.disabled=false;}
      });
    const box=$('.hb-dialog');
    const choose=name=>{
      selected=name;
      for(const b of $$('[data-template]',box)){b.classList.toggle('is-on',b.dataset.template===name);b.setAttribute('aria-pressed',String(b.dataset.template===name));}
      const t=templates.find(t=>t.name===name);
      $('#n-theme',box).value=t.text.match(/^theme:\s*(.+)$/m)?.[1]||'paper';
      $('#n-title',box).placeholder=t.defaultTitle.replace(/<br\s*\/?>/g,' ');
    };
    for(const button of $$('[data-template]',box)){
      const t=templates.find(t=>t.name===button.dataset.template);
      const r=renderDeck(coverText(t.text.replaceAll('{{TITLE}}',t.defaultTitle)),s=>`/template-files/${encodeURIComponent(t.dir)}/${s}`);
      const host=$('.hb-template-preview',button);mountSlide(host,r.css,r.sections[0],host.clientWidth||160);
      button.onclick=()=>choose(t.name);
    }
    choose(selected);
    // 型を選ぶ前に題名の入力へスクロールさせない。
    box.querySelector(`[data-template="${selected}"]`).focus({preventScroll:true});
    box.scrollTop=0;
    return;
  }
  if (kind === 'folder') {
    return dialog(`<h2>フォルダから取り込む</h2><p class="hb-muted">slides.md と figs/ があるフォルダをコピーします。元のフォルダはそのまま残ります。</p>
      <label class="hb-field">フォルダ<input id="f-path" value="${esc(initialPath)}" ${inTauri?'readonly':''} placeholder="/ か ~/ で始まる場所"></label>
      <div class="hb-dialog-actions"><button type="button" data-d="cancel">やめる</button><button type="button" data-d="ok" class="hb-primary">取り込む</button></div>`, async (act, box) => {
      if (act !== 'ok') return true;
      const p = $('#f-path', box).value.trim();
      if (!p) return false;
      const r = await hubCreateDeck({ lib: state.lib, from: 'folder', path: p });
      await loadDecks(); await loadLibraries();
      toast(`取り込みました（${r.slug}）`);
      openDetail(r.slug);
      return true;
    });
  }
  if (kind === 'library') {
    return dialog(`<h2>ライブラリーを追加</h2><p class="hb-muted">資料を集めるフォルダを追加します。お客様ごとなど、別のGitリポジトリで管理したいときに使います。</p>
      <label class="hb-field">フォルダ<input id="l-path" value="${esc(initialPath)}" ${inTauri?'readonly':''} placeholder="/ か ~/ で始まる場所"></label>
      <label class="hb-field">表示名<input id="l-name" placeholder="お客様A"></label>
      <div class="hb-dialog-actions"><button type="button" data-d="cancel">やめる</button><button type="button" data-d="ok" class="hb-primary">追加する</button></div>`, async (act, box) => {
      if (act !== 'ok') return true;
      const p = $('#l-path', box).value.trim();
      if (!p) return false;
      const r = await hubAddLibrary({ path: p, name: $('#l-name', box).value.trim() });
      state.libs = r.libraries;
      state.lib = r.libraries[r.libraries.length - 1].id;
      settings.setItem('hb-lib', state.lib);
      await loadLibraries(); await loadDecks();
      return true;
    });
  }
}
$('#btn-new').addEventListener('click', (e) => { e.stopPropagation(); $('#new-menu').hidden = !$('#new-menu').hidden; });
$('#new-menu').addEventListener('click', (e) => { const n = e.target.closest('[data-n]')?.dataset.n; if (n) openNew(n); });
document.addEventListener('click', (e) => { if (!e.target.closest('.hb-new')) $('#new-menu').hidden = true; });

function toastError(err) {
  const msg = String(err?.message || err);
  const detail = err?.detail ? String(err.detail) : '';
  toast(msg, 'error', detail ? [{ label: '詳しい内容をコピー', run: () => navigator.clipboard?.writeText(detail) }] : []);
}

// --- 通知・キー ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, level = 'info', actions = [], sticky = false) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + actions.map((a, i) => `<button type="button" class="toast-action" data-toast-action="${i}">${esc(a.label)}</button>`).join('');
  t.className = `is-${level}`; t.hidden = false;
  t.onclick = (e) => {
    const i = e.target.closest('[data-toast-action]')?.dataset.toastAction;
    if (i != null && actions[Number(i)]) { try { actions[Number(i)].run(); } catch (err) { toast(String(err), 'error'); } t.hidden = true; }
  };
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, actions.length ? 10000 : level === 'error' ? 5000 : 2600);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!cardMenu.hidden) { closeCardMenu(); $$('.hb-card').find(c=>c.dataset.slug===state.selected)?.focus(); return; }
    if ($('#sync-menu') && !$('#sync-menu').hidden) { $('#sync-menu').hidden = true; $('#btn-sync').focus(); return; }
    if (!$('#new-menu').hidden) { $('#new-menu').hidden = true; return; }
    if (!$('#overlay').hidden) { $('#overlay').hidden = true; $('#overlay').innerHTML = ''; return; }
    if (!$('#detail').hidden) return closeDetail();
  }
  if (e.key === '/' && !e.target.closest('input, textarea, select')) { e.preventDefault(); $('#q').focus(); }
});
$('#q').addEventListener('input', (e) => { state.q = e.target.value; renderGallery(); });
$('#sort').value = state.sort;
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; settings.setItem('hb-sort', state.sort); renderGallery(); });
$('#library-scope').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-scope]'); if (!tab) return;
  state.archived = tab.dataset.scope === 'archived';
  for (const b of $$('#library-scope button')) { const active = b === tab; b.classList.toggle('is-on', active); b.setAttribute('aria-pressed', String(active)); }
  closeDetail(); state.tag = state.theme = ''; loadDecks();
});
document.addEventListener('click', e => { if (!e.target.closest('#git-bar') && $('#sync-menu')) $('#sync-menu').hidden = true; });
$('#lib-select').addEventListener('change', async (e) => { state.lib = e.target.value; settings.setItem('hb-lib', state.lib); closeDetail(); state.tag = state.theme = ''; renderGitBar(); await loadDecks(); });
// ほかの画面（エディター）で保存・コミットされたときに、戻ってきたら一覧を更新する
window.addEventListener('focus', () => { loadLibraries().then(loadDecks).catch(() => {}); });

await onLibraryDrop(async paths=>{
  if(paths.length!==1){toast('フォルダは1つずつ取り込んでください','error');return;}
  try {const folder=await hubFolderInfo(paths[0]);await openNew(folder.deck?'folder':'library',folder.path);}catch(e){toastError(e);}
});
await setupMarp();
await loadLibraries();
await loadDecks();
settings.reportErrors();
if (!inTauri || state.debug) window.__hub = { state, loadDecks, loadLibraries, openDetail, openDiff, alignPages, readyAt: Date.now() };
if (!inTauri || state.debug) {
  const firstPaint = async () => {
    const covers = [...document.querySelectorAll('#gallery .hb-cover')].filter(el => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0; });
    if (covers.some(el => !el.shadowRoot?.querySelector('section'))) return requestAnimationFrame(firstPaint);
    await Promise.all([document.fonts.ready, ...covers.flatMap(el => [...el.shadowRoot.querySelectorAll('img')]).map(img => img.decode().catch(() => {}))]);
    requestAnimationFrame(() => requestAnimationFrame(() => { window.__hub.paintedAt = Date.now(); }));
  };
  requestAnimationFrame(firstPaint);
}


window.__marpkit={menu(id){
  if(id==='new')return openNew('template');
  if(id==='settings')return openSettings();
  if(id==='shortcuts')return confirmDialog({title:'ショートカット一覧',message:'⌘N：新しい資料　⌘O：開く　⌘L：ライブラリー　⌘,：設定　⌘W：閉じる　⌘Q：終了。編集のショートカットは資料を開いてから同じメニューで確認できます。',ok:'閉じる',cancel:null});
  if(id==='writing'){
    dialog(`<h2>書き方の一覧</h2><p>資料を開くと、テーマに合わせた見本を見て挿入できます。</p>${CHEATSHEET.map(e=>`<details><summary>${esc(e.name)}</summary><p>${esc(e.when)}</p><pre style="white-space:pre-wrap">${esc(e.syntax)}</pre></details>`).join('')}<div class="hb-dialog-actions"><button type="button" data-d="close">閉じる</button></div>`,()=>true);
    document.querySelector('[data-d="close"]').focus({preventScroll:true});
  }
}};
for(const id of window.__marpkitPending||[])window.__marpkit.menu(id);
delete window.__marpkitPending;
