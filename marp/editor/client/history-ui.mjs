// 履歴タブと版の比較。Git がなくても、保存・外部の変更・図の変更・名前を付けた版をさかのぼれる。
//   右の「履歴」タブ … 版の一覧（Git のコミットも同じ並びに出す）。名前を付けて残す・コミット
//   比較（クリック） … その版と今の内容の違いを、変わったページだけ前後のスライドで並べる。文字の差分も見られる
//   戻す … 全体をその版に／ページごとに／図ごとに。全体とページは未保存の変更として入る（⌘Z で取り消せる）
import { alignPages, lineDiff } from '../../lib/diff.mjs';
import { splitSlides, joinSlides } from './markdown.mjs';
import { historyList, historyText, historyNamed, historyRestoring, historyRestoreFigure, historyObjectUrl, gitCommit } from './backend.mjs';
import { confirmDialog } from '../../shared/dialog.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const KIND = { open: ['開いた', 'k-open'], save: ['保存', 'k-save'], external: ['外部の変更', 'k-ext'], figure: ['図', 'k-fig'], restore: ['戻した', 'k-restore'], named: ['名前付き', 'k-named'], git: ['Git', 'k-git'] };
const pages = (t) => (t ? splitSlides(t).chunks.map((c) => c.join('\n').trim()) : []);

function when(iso) {
  const d = new Date(iso), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - day) / 864e5);
  return { day: diff === 0 ? '今日' : diff === 1 ? '昨日' : `${d.getMonth() + 1}月${d.getDate()}日`, hm, full: `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` };
}
const deltaText = (d) => (d ? [d.mod && `変更${d.mod}`, d.add && `追加${d.add}`, d.del && `削除${d.del}`].filter(Boolean).join('・') || 'ページは同じ' : '');

export function createHistory({ state, render, setText, save, dirty, go, toast, modal }) {
  const data = { items: [], git: null, status: 'loading', naming: false };
  let onChange = () => {};

  async function load() {
    try {
      const r = await historyList();
      data.items = r.items || [];
      data.git = r.git;
      data.status = 'ok';
    } catch { data.status = 'error'; }
    onChange();
  }

  // ローカルの版と Git のコミットを時刻で1本に並べる
  function timeline() {
    const local = data.items.map((e) => ({ ...e, src: 'local' }));
    const git = (data.git?.log || []).map((c) => ({ id: `git:${c.hash}`, rev: c.hash, time: new Date(c.date).toISOString(), kind: 'git', label: c.subject, short: c.short, author: c.author, stat: c.stat, src: 'git' }));
    return [...local, ...git].sort((a, b) => b.time.localeCompare(a.time));
  }

  function html() {
    if (data.status === 'loading') return '<section class="mj-panel"><p class="mj-muted">履歴を読み込み中…</p></section>';
    const list = timeline();
    let lastDay = '';
    const rows = list.map((e) => {
      const w = when(e.time);
      const head = w.day !== lastDay ? `<h3 class="mj-hist-day">${w.day}</h3>` : '';
      lastDay = w.day;
      const [k, cls] = KIND[e.kind] || [e.kind, ''];
      const sub = e.src === 'git' ? `${esc(e.short)}・${esc(e.author)}` : e.figures ? e.figures.map((f) => esc(f.path.replace(/^figs\//, ''))).slice(0, 3).join('、') + (e.figures.length > 3 ? ` ほか${e.figures.length - 3}枚` : '') : `${e.pages}ページ${e.delta ? `・${deltaText(e.delta)}` : ''}`;
      return `${head}<button type="button" class="mj-hist-item" data-h="${esc(e.id)}">
        <span class="mj-hist-time">${w.hm}</span>
        <span class="mj-hist-body"><span class="mj-hist-kind ${cls}">${k}</span>${e.label && e.kind !== 'open' && e.kind !== 'save' && e.kind !== 'external' ? `<b>${esc(e.label)}</b>` : ''}<small>${sub}</small></span>
      </button>`;
    }).join('');
    const git = data.git ? `
      <div class="mj-hist-git">
        <div class="mj-hist-git-head"><span class="mj-hist-kind k-git">Git</span>${data.git.changes ? `未コミットの変更 ${data.git.changes}件` : 'コミット済み'}</div>
        ${data.git.changes ? `<div class="mj-hist-commit"><input id="hist-commit" placeholder="コミットのメッセージ（例：P.12の図を直した）" autocomplete="off"><button type="button" data-hx="commit">この資料をコミット</button></div>` : ''}
      </div>` : '';
    return `<section class="mj-panel mj-hist">
      <div class="mj-hist-intro"><h2>履歴</h2><p class="mj-muted">保存・エディター以外での変更・図の変更を自動で残しています（Git がなくても使えます）。版を押すと今との違いを見られます。</p></div>
      ${data.naming ? `<div class="mj-hist-name"><input id="hist-name" placeholder="版の名前（例：レビュー前・社内共有版）" maxlength="80" autocomplete="off"><button type="button" class="mj-primary" data-hx="name-ok">残す</button><button type="button" data-hx="name-cancel">やめる</button></div>`
        : '<button type="button" class="mj-wide" data-hx="name">＋ 今の版に名前を付けて残す</button>'}
      ${git}
      <div class="mj-hist-list">${rows || '<p class="mj-muted">まだ履歴がありません。保存すると残ります。</p>'}</div>
    </section>`;
  }

  function bind(root) {
    root.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => openCompare(b.dataset.h)));
    root.querySelector('[data-hx="name"]')?.addEventListener('click', () => { data.naming = true; onChange(); setTimeout(() => root.ownerDocument.querySelector('#hist-name')?.focus(), 0); });
    root.querySelector('[data-hx="name-cancel"]')?.addEventListener('click', () => { data.naming = false; onChange(); });
    const doName = async () => {
      const label = root.querySelector('#hist-name')?.value.trim();
      if (dirty()) await save();
      const r = await historyNamed(label);
      data.naming = false;
      if (r.ok) toast(`「${label || '名前なし'}」として残しました`); else toast('残せませんでした', 'error');
      await load();
    };
    root.querySelector('[data-hx="name-ok"]')?.addEventListener('click', doName);
    root.querySelector('#hist-name')?.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doName(); if (e.key === 'Escape') { data.naming = false; onChange(); } });
    const doCommit = async () => {
      if (dirty()) await save();
      const message = root.querySelector('#hist-commit')?.value;
      const r = await gitCommit(message);
      if (!r.ok) return toast(r.data?.error || 'コミットできませんでした', 'error');
      toast(`コミットしました（${r.data?.result}）`);
      await load();
    };
    root.querySelector('[data-hx="commit"]')?.addEventListener('click', doCommit);
    root.querySelector('#hist-commit')?.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doCommit(); });
  }

  // --- 比較 ---------------------------------------------------------------------------------
  async function textOf(item) {
    const r = await historyText(item.src === 'git' ? { rev: item.rev } : { id: item.id });
    if (!r.ok) throw new Error('版を読めませんでした');
    return r.text;
  }

  function mount(host, md) {
    const { html: out, css } = render(md);
    const secs = [...new DOMParser().parseFromString(out, 'text/html').querySelectorAll('div.marpit > section')].map((s) => s.outerHTML);
    return { css, secs };
  }
  function paintSlide(host, css, sec, w) {
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css} .f{width:${w}px;height:${(w * 720) / 1280}px;overflow:hidden;border-radius:6px;box-shadow:0 2px 10px #1a202c1c} .s{width:1280px;height:720px;transform:scale(${w / 1280});transform-origin:0 0}</style><div class="f"><div class="s"><div class="marpit">${sec}</div></div></div>`;
  }

  async function openCompare(id, base = 'now', texts = null) {
    const list = timeline();
    const idx = list.findIndex((e) => e.id === id);
    const item = texts ? { id: 'external-comparison', kind: 'external', label: '外部の変更' } : list[idx];
    if (!item) return;
    modal.hidden = false;
    modal.innerHTML = '<section class="hs-dialog"><p class="mj-muted" style="padding:24px">読み込み中…</p></section>';
    let beforeText, afterText, beforeLabel, afterLabel;
    try {
      const itemText = texts ? texts[0] : await textOf(item);
      if (texts) {
        beforeText = texts[0]; afterText = texts[1];
        beforeLabel = '外部の内容'; afterLabel = '自分の編集';
      } else if (base === 'prev') {
        const prev = list.slice(idx + 1).find((e) => (e.src === 'git' ? true : !!e.hash));
        beforeText = prev ? await textOf(prev) : '';
        afterText = itemText;
        beforeLabel = prev ? `${when(prev.time).full}（${(KIND[prev.kind] || [''])[0]}）` : 'なし';
        afterLabel = `${when(item.time).full}（${(KIND[item.kind] || [''])[0]}）`;
      } else {
        beforeText = itemText;
        afterText = state.text;
        beforeLabel = `${when(item.time).full} の版`;
        afterLabel = `今の内容${dirty() ? '（未保存を含む）' : ''}`;
      }
    } catch (e) { modal.innerHTML = ''; modal.hidden = true; return toast(e.message, 'error'); }

    const A = pages(beforeText), B = pages(afterText);
    const ops = alignPages(A, B);
    const changed = ops.filter((o) => o.t !== 'same');
    const count = (t) => changed.filter((o) => o.t === t).length;
    const label = { mod: '変更', add: '追加', del: '削除' };
    // 「今と比べる」ときだけ、ページごと・全体を戻せる（戻すと、その版の内容が今に入る）
    const canRestore = !texts && base === 'now' && item.kind !== 'figure';
    const figs = item.figures || [];
    modal.innerHTML = `<section class="hs-dialog" role="dialog" aria-label="版の比較">
      <header class="hs-head">
        <div><span class="mj-kicker">${esc((KIND[item.kind] || [item.kind])[0])}${item.label && !['open', 'save', 'external'].includes(item.kind) ? `・${esc(item.label)}` : ''}</span>
          <h2>${esc(beforeLabel)} → ${esc(afterLabel)}</h2>
          <p class="mj-muted">変更 ${count('mod')}・追加 ${count('add')}・削除 ${count('del')}（同じページ ${ops.length - changed.length}）${figs.length ? `・図 ${figs.length}枚` : ''}</p></div>
        <div class="hs-tools">
          ${texts ? '' : `<span class="mj-view" role="group"><button type="button" data-base="now" class="${base === 'now' ? 'is-on' : ''}">今と比べる</button><button type="button" data-base="prev" class="${base === 'prev' ? 'is-on' : ''}">ひとつ前と比べる</button></span>`}
          ${canRestore && changed.length ? '<button type="button" class="mj-primary" data-hs="restore-all">この版に戻す</button>' : ''}
          <button type="button" data-hs="close" aria-label="閉じる">✕</button>
        </div>
      </header>
      <div class="hs-body">
        ${figs.length ? `<h3 class="hs-sec">図の変更</h3><div class="hs-figs">${figs.map((f, k) => `<div class="hs-fig">
            <div class="hs-fig-name">${esc(f.path)}${f.before ? '' : '（追加）'}${f.after ? '' : '（削除）'}</div>
            <div class="hs-pair"><div class="hs-img">${f.before ? `<img src="${historyObjectUrl(f.before)}" alt="前">` : '<span class="hs-none">（なし）</span>'}</div><div class="hs-img">${f.after ? `<img src="${historyObjectUrl(f.after)}" alt="後">` : '<span class="hs-none">（なし）</span>'}</div></div>
            <div class="hs-row-tools"><button type="button" data-fig="${k}">この図を変更前に戻す</button></div></div>`).join('')}</div>` : ''}
        ${changed.length ? `<h3 class="hs-sec">スライド</h3><div class="hs-cols"><span>${esc(beforeLabel)}</span><span>${esc(afterLabel)}</span></div>` : ''}
        ${changed.map((o, k) => `<div class="hs-row is-${o.t}">
            <div class="hs-row-head"><span class="hs-badge">${label[o.t]}</span>${o.a != null ? `P.${o.a + 1}` : ''}${o.a != null && o.b != null ? ' → ' : ''}${o.b != null ? `P.${o.b + 1}` : ''}
              <span class="mj-spacer"></span>
              <button type="button" class="hs-link" data-text="${k}">文字の差分</button>
              ${canRestore ? `<button type="button" data-page="${k}">${o.t === 'add' ? 'このページを消す（版になかった）' : o.t === 'del' ? 'このページを戻す（入れ直す）' : 'このページを版の内容に戻す'}</button>` : ''}
              ${o.b != null && base === 'now' ? `<button type="button" class="hs-link" data-go="${o.b}">開く</button>` : ''}</div>
            <div class="hs-pair"><div class="hs-slide" data-a="${k}">${o.a == null ? '<span class="hs-none">（なし）</span>' : ''}</div><div class="hs-slide" data-b="${k}">${o.b == null ? '<span class="hs-none">（なし）</span>' : ''}</div></div>
            <pre class="hs-text" data-t="${k}" hidden></pre>
          </div>`).join('')}
        ${!changed.length && !figs.length ? '<p class="mj-muted hs-same">スライドの内容は同じです。</p>' : ''}
        ${!changed.length && figs.length ? '<p class="mj-muted hs-same">スライドの文章は変わっていません（図だけの変更です）。</p>' : ''}
      </div>
    </section>`;

    const RA = mount(null, beforeText || '---\nmarp: true\n---\n'), RB = mount(null, afterText);
    const w = Math.min(520, (modal.querySelector('.hs-body').clientWidth - 70) / 2);
    changed.forEach((o, k) => {
      if (o.a != null) paintSlide(modal.querySelector(`[data-a="${k}"]`), RA.css, RA.secs[o.a] || '', w);
      if (o.b != null) paintSlide(modal.querySelector(`[data-b="${k}"]`), RB.css, RB.secs[o.b] || '', w);
    });

    const close = () => { modal.hidden = true; modal.innerHTML = ''; modal.onclick = null; window.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (document.querySelector('#mj-dialog-host:not([hidden])')) return; if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    modal.onclick = async (e) => {
      if (e.target === modal) return close();
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.hs === 'close') return close();
      if (t.dataset.base) { close(); return openCompare(id, t.dataset.base); }
      if (t.dataset.go != null) { close(); return go(Number(t.dataset.go)); }
      if (t.dataset.text != null) {
        const o = changed[Number(t.dataset.text)];
        const pre = modal.querySelector(`[data-t="${t.dataset.text}"]`);
        if (!pre.hidden) { pre.hidden = true; return; }
        pre.innerHTML = lineDiff(o.a != null ? A[o.a] : '', o.b != null ? B[o.b] : '').map((l) => `<span class="d${l.t === '+' ? 'a' : l.t === '-' ? 'd' : 's'}">${l.t} ${esc(l.s)}</span>`).join('\n');
        pre.hidden = false;
        return;
      }
      if (t.dataset.hs === 'restore-all') {
        if (!(await confirmDialog({ title: 'この版に戻す', message: `${beforeLabel}に戻しますか？\n今の内容は未保存の変更として置き換わります（⌘Z で取り消せます。保存すると確定）。`, ok: '戻す' }))) return;
        await historyRestoring(`${beforeLabel}に戻した`);
        setText(beforeText, { label: '版を戻す' });
        close();
        return toast(`${beforeLabel}に戻しました（未保存。⌘Z で取り消せます）`);
      }
      if (t.dataset.page != null) {
        const o = changed[Number(t.dataset.page)];
        const d = splitSlides(state.text);
        const verChunks = splitSlides(beforeText).chunks;
        if (o.t === 'mod') d.chunks[o.b] = [...verChunks[o.a]];
        else if (o.t === 'add') d.chunks.splice(o.b, 1);
        else {
          // 版にだけあるページ：直前の「同じ」ページの後ろへ入れ直す
          const k = ops.indexOf(o);
          const prevB = [...ops.slice(0, k)].reverse().find((x) => x.b != null)?.b;
          d.chunks.splice(prevB == null ? 0 : prevB + 1, 0, [...verChunks[o.a]]);
        }
        setText(joinSlides(d), { label: 'ページを版に戻す' });
        toast('ページを戻しました（未保存。⌘Z で取り消せます）');
        close();
        return openCompare(id, 'now');
      }
      if (t.dataset.fig != null) {
        const f = figs[Number(t.dataset.fig)];
        if (!(await confirmDialog({ title: '図を戻す', message: `${f.path} を変更前に戻しますか？（図のファイルを書き換えます。戻したことも履歴に残ります）`, ok: '戻す' }))) return;
        const r = await historyRestoreFigure({ path: f.path, hash: f.before, label: `${f.path} を戻した` });
        toast(r.ok ? `${f.path} を戻しました` : '戻せませんでした', r.ok ? 'info' : 'error');
      }
    };
  }

  return { load, html, bind, openCompare, compareTexts: (before, after) => openCompare(null, 'external', [before, after]), get data() { return data; }, set onChange(fn) { onChange = fn; } };
}
