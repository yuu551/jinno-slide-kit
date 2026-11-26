// エージェント用メモ。
//   直したい点を「このスライド / 選択した要素 / 資料全体」の単位でためて、
//   「エージェント向けにコピー」で Claude Code / Codex へ貼る形のプロンプトにする。
// Marp のページには ID がないので、メモはページのタイトルと本文の指紋、要素は元の行と文字で覚えておき、
// 開くたびに今のファイルの中から探し直す（ページの追加・移動・改稿のあとでも同じ場所を指せる）。
// 保存先はデッキのフォルダの .agent-notes.json（Gitには入れない）。
import { deckInfo, loadNotes, saveNotes } from './backend.mjs';
import { confirmDialog } from '../../shared/dialog.mjs';
const MAX = 100;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const squash = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/[*_`#>|\\-]/g, '').replace(/\s+/g, ' ').trim();

// ページの指紋：タイトルを除いた本文の先頭120字（空白・記号を詰める）
function fingerprint(lines) {
  return squash(lines.filter((l) => !/^#\s/.test(l) && !/^<!--/.test(l)).join(' ')).slice(0, 120);
}
function similarity(a, b) {
  if (!a || !b) return 0;
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const A = grams(a), B = grams(b);
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return (2 * hit) / (A.size + B.size || 1);
}

export function createNotes({ state, go, toast, confirmBox = (m) => confirmDialog({ title: '確認', message: m, ok: '削除する', danger: true }) }) {
  const data = { notes: [], draft: '', scope: 'slide', status: 'loading' };
  let saveTimer = null;
  let info = null;
  let onChange = () => {};

  const lines = () => state.text.split('\n');
  const slideLines = (i) => { const r = state.ranges[i]; return r ? lines().slice(r.start, r.end) : []; };

  // 今のファイルでメモの対象を探す。見つからなければ missing
  function locate(n) {
    if (n.scope === 'deck') return { label: '資料全体', copied: '資料全体' };
    const count = state.ranges.length;
    let best = -1, score = 0;
    for (let i = 0; i < count; i++) {
      let s = 0;
      if (n.title && state.titles[i] === n.title) s += 1;
      s += similarity(n.fp, fingerprint(slideLines(i))) * 0.9;
      s -= Math.min(Math.abs(i - n.index), 40) * 0.002; // 同点なら元の位置に近いページ
      if (s > score) { score = s; best = i; }
    }
    if (best < 0 || score < 0.35) return { label: '対象のページが見つかりません', copied: `対象のページが見つかりません（元はスライド${n.index + 1}「${n.title || ''}」）`, missing: true };
    const r = state.ranges[best];
    const title = state.titles[best] || '（タイトルなし）';
    const page = `スライド${best + 1}「${title}」`;
    const range = `slides.md ${r.start + 1}〜${r.end}行目`;
    if (n.scope !== 'block') return { index: best, label: page, copied: `${page}; ${range}` };
    // 要素：同じページの中で、覚えておいた文字がある行を探す
    const ls = slideLines(best);
    const key = squash(n.block?.text).slice(0, 30);
    let line = -1;
    if (key) for (let k = 0; k < ls.length; k++) if (squash(ls[k]).includes(key.slice(0, 16))) { line = r.start + k; break; }
    const what = n.block?.text ? `「${n.block.text.slice(0, 24)}${n.block.text.length > 24 ? '…' : ''}」` : '';
    if (line < 0) return { index: best, label: `${page}・要素は見つかりません`, copied: `${page}; ${range}; 要素${what}は見つかりません`, missing: true };
    return { index: best, line, label: `${page}・${n.block.kind || '要素'}`, copied: `${page}; slides.md ${line + 1}行目の${n.block.kind || '要素'}${what}` };
  }

  function prompt() {
    const file = info?.abs || 'slides.md';
    return [
      `Marp の資料「${state.titles[0] || info?.name || ''}」へのフィードバックです（ファイル: ${file}）。`,
      '最新のファイルを読み、以下を反映してください。対象の行だけを直し、ほかのページは変えないでください。',
      '図（figs/*.svg）を直すときは、figs/src/make_figs.py があればそちらを直して `slides figs` で作り直してください。`<!-- edited-in-editor: … -->` の印がある図は、ファイルを直接直してください。',
      '判断に迷う点や対象が見つからない点は変更せず、確認事項として教えてください。',
      `直したら \`${info?.slides ? `node ${info.slides}` : 'slides'} check ${file}\` で error 0 を確かめてください。`,
      '',
      ...data.notes.map((n) => `- [${locate(n).copied}] ${n.text}`),
    ].join('\n');
  }

  function persist(force = false) {
    data.status = 'saving';
    onChange(force);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const r = await saveNotes({ notes: data.notes, draft: data.draft, scope: data.scope });
        data.status = r.ok ? 'saved' : 'error';
      } catch { data.status = 'error'; }
      onChange();
    }, 300);
  }

  function add() {
    const text = data.draft.trim();
    if (!text || data.notes.length >= MAX) return;
    const i = state.current;
    const n = { id: crypto.randomUUID(), scope: data.scope, text, createdAt: new Date().toISOString() };
    if (data.scope !== 'deck') Object.assign(n, { index: i, title: state.titles[i] || '', fp: fingerprint(slideLines(i)) });
    if (data.scope === 'block') {
      const pick = state.lastPick;
      if (!pick || pick.slide !== i) return;
      n.block = { line: pick.line, kind: pick.kind, text: pick.text };
    }
    data.notes.push(n);
    data.draft = '';
    persist(true); // 入力欄にフォーカスがあっても一覧を描き直す
  }

  const scopeLabel = { slide: 'このスライド', block: '選択した要素', deck: '資料全体' };
  const placeholder = { slide: '例：図を大きくして、リードを1行にまとめる', block: '例：この図の説明を具体的にする', deck: '例：経営層向けに、結論を先にして全体を短く' };

  function html() {
    const pick = state.lastPick?.slide === state.current ? state.lastPick : null;
    const statusText = { loading: 'メモを読み込み中…', saving: 'ローカルへ保存中…', error: 'ローカル保存に失敗しました。次の編集時に再試行します。', saved: 'ローカルに保存済み' }[data.status];
    const canAdd = data.status !== 'loading' && data.draft.trim() && data.notes.length < MAX && !(data.scope === 'block' && !pick);
    return `
      <section class="mj-panel mj-notes">
        <div class="mj-notes-intro">
          <span class="mj-notes-orb" aria-hidden="true">✦</span>
          <div><span class="mj-kicker">エージェントメモ</span><h2>エージェント用メモ</h2>
          <p>直したい点をメモにためて、まとめてコピーします。資料と一緒に自動保存されます。</p></div>
        </div>
        <p class="mj-notes-status is-${data.status}">${statusText}</p>
        <div class="mj-scope" role="group" aria-label="メモの対象">
          ${['slide', 'block', 'deck'].map((k) => `<button type="button" data-scope="${k}" class="${data.scope === k ? 'is-active' : ''}" ${data.status === 'loading' || (k === 'block' && !pick) ? 'disabled' : ''}>${scopeLabel[k]}</button>`).join('')}
        </div>
        ${data.scope === 'block' && pick ? `<p class="mj-muted mj-notes-target">対象：${esc(pick.kind || '要素')}「${esc(pick.text.slice(0, 30))}」</p>` : ''}
        <textarea id="note-draft" rows="4" maxlength="5000" placeholder="${placeholder[data.scope]}" ${data.status === 'loading' ? 'disabled' : ''}>${esc(data.draft)}</textarea>
        <button type="button" class="mj-wide" data-n="add" ${canAdd ? '' : 'disabled'}>＋ メモを追加</button>
        ${data.notes.length ? `
          <div class="mj-note-list">
            ${data.notes.map((n) => { const l = locate(n); return `<article class="mj-note${l.missing ? ' is-missing' : ''}">
              <div><button type="button" class="mj-note-target" data-jump="${n.id}">${esc(l.label)} ↗</button><p>${esc(n.text)}</p></div>
              <button type="button" class="mj-note-del" data-del="${n.id}" title="メモを削除">✕</button></article>`; }).join('')}
          </div>
          <button type="button" class="mj-wide mj-primary" data-n="copy">エージェント向けにコピー（${data.notes.length}件）</button>
          <button type="button" class="mj-wide mj-notes-clear" data-n="clear">メモをすべて削除</button>
          <p class="mj-muted mj-notes-hint">コピーした内容を Claude Code / Codex のセッションへ貼り付けてください。ファイルの場所と行が入っているので、そのページだけを直してくれます。</p>` : ''}
      </section>`;
  }

  function bind(root) {
    const draft = root.querySelector('#note-draft');
    draft?.addEventListener('input', () => {
      data.draft = draft.value;
      const btn = root.querySelector('[data-n="add"]');
      const pick = state.lastPick?.slide === state.current;
      if (btn) btn.disabled = !(data.draft.trim() && data.notes.length < MAX && !(data.scope === 'block' && !pick));
      persist();
    });
    draft?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } e.stopPropagation(); });
    root.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { data.scope = b.dataset.scope; persist(true); }));
    root.querySelector('[data-n="add"]')?.addEventListener('click', add);
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const at = data.notes.findIndex((n) => n.id === b.dataset.del);
      if (at < 0) return;
      const [gone] = data.notes.splice(at, 1);
      persist(true);
      toast('メモを削除しました', 'info', [{ label: '元に戻す', run: () => { data.notes.splice(Math.min(at, data.notes.length), 0, gone); persist(true); } }]);
    }));
    root.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
      const n = data.notes.find((x) => x.id === b.dataset.jump);
      const l = n && locate(n);
      if (l?.index !== undefined) go(l.index);
    }));
    root.querySelector('[data-n="copy"]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(prompt()); toast('コピーしました。Claude Code / Codex へ貼り付けてください'); }
      catch { toast('コピーできませんでした', 'error'); }
    });
    root.querySelector('[data-n="clear"]')?.addEventListener('click', async () => {
      if (!(await confirmBox('エージェント向けメモをすべて削除しますか？\nこの資料に保存されたメモと入力途中の内容を削除します。削除のあと、しばらくは［元に戻す］で戻せます。'))) return;
      const before = { notes: data.notes, draft: data.draft, scope: data.scope };
      data.notes = []; data.draft = ''; data.scope = 'slide';
      persist(true);
      toast('メモを削除しました', 'info', [{ label: '元に戻す', run: () => { const now = data.notes || []; const ids = new Set(before.notes.map((n) => n.id)); data.notes = [...before.notes, ...now.filter((n) => !ids.has(n.id))]; data.draft = before.draft; data.scope = before.scope; persist(true); } }]);
    });
  }

  async function load() {
    try {
      info = await deckInfo();
      const r = await loadNotes();
      Object.assign(data, { notes: r.notes || [], draft: r.draft || '', scope: r.scope || 'slide', status: 'saved' });
    } catch { data.status = 'error'; }
    onChange();
  }

  return {
    load, html, bind, prompt, locate,
    get count() { return data.notes.length; },
    get data() { return data; },
    set onChange(fn) { onChange = fn; },
  };
}
