// 画面からバックエンドを呼ぶ口。
//   - ブラウザで動くとき：今の HTTP の API と EventSource（Node や Rust の互換層のサーバー）
//   - Tauri（アプリ）の中：invoke と event（Rust のバックエンド）
//
// 決めごと
//   - API ごとに関数を1つ。URL・method・コマンド名はこのファイルの中だけに書き、画面のコードには出さない
//   - 返す形は、いまの画面が使っている形のまま（status や ok が要る呼び出しには返す）
//   - 画像の src やダウンロードのように fetch を通らないものも、URL を作る関数にしてここに置く
//     （アプリの中では、画面のサーバー（Rust）が同じ URL で配るので、そのまま使える）
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/// アプリ（Tauri）の中で動いているか
export const inTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

const jsonHeaders = { 'content-type': 'application/json' };

// --- ブラウザ（HTTP）の土台 ------------------------------------------------------------------

// body なしの GET は body を渡さない。
// 文字列（SVG の中身）と Blob（画像）はそのまま送る（見出しは付けない。画像は自分の種類で送る）。
// オブジェクトのときだけ JSON にして、JSON の見出しを付ける。
async function request(method, url, body) {
  const opt = { method, ...(method === 'POST' ? { headers: jsonHeaders } : {}) };
  if (body !== undefined) {
    const raw = typeof body === 'string' || body instanceof Blob;
    if (!raw) opt.headers = jsonHeaders;
    else if (body instanceof Blob) opt.headers = { 'content-type': body.type || 'application/octet-stream' };
    opt.body = raw ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch { /* JSON でないときは null のまま */ }
  return { ok: res.ok, status: res.status, data };
}

// --- アプリ（invoke）の土台 ------------------------------------------------------------------

// Rust 側が投げた {"status":..,"error":..} を、HTTP と同じ形（ok・status・data）にそろえる。
// 例外は投げずに ok:false を返す（ブラウザのときと同じ扱いに揃えるため）
async function command(name, args) {
  try {
    const v = await invoke(name, args ?? {});
    // 何も返さないコマンド（ウインドウを開くなど）は、ok だけ返す
    return v === null || v === undefined ? { ok: true } : v;
  } catch (e) {
    const raw = typeof e === 'string' ? e : (e?.message || String(e));
    let status = 500;
    let error = raw;
    try {
      const j = JSON.parse(raw);
      status = j.status ?? 500;
      error = j.error || raw;
      return { ok: false, status, data: { error, detail: j.detail || null } };
    } catch { /* 文字のまま */ }
    return { ok: false, status, data: { error } };
  }
}

// エディターの API は、Rust 側の api_call という1つのコマンドに名前を渡して呼ぶ
function call(name, args) {
  const clean = JSON.parse(JSON.stringify(args ?? {}, (_, value) => typeof value === 'string' ? value.replace(/([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g, (_, pair) => pair || '\ufffd') : value));
  return command('api_call', { name, args: clean });
}

/// アプリの中では invoke、ブラウザでは HTTP を使う
const either = (name, args, http) => (inTauri ? call(name, args) : http());

// --- エディター：資料の情報と中身 ------------------------------------------------------------

export async function deckInfo() {
  return either('info', {}, async () => (await request('GET', '/api/info')).data);
}

export async function loadDeck() {
  return either('deckGet', {}, async () => (await request('GET', '/api/deck')).data);
}

// 保存。base が今のファイルと違えば 409 で今の中身が返る（conflict に入れる）
export async function saveDeck({ text, base, force = false }) {
  return either('deckSave', { text, base, force }, async () => {
    const r = await request('PUT', '/api/deck', { text, base, force });
    return {
      ok: r.ok,
      status: r.status,
      hash: r.status === 200 ? r.data?.hash : undefined,
      conflict: r.status === 409 ? r.data : null,
    };
  });
}

// --- エディター：検査・書き出し --------------------------------------------------------------

// 全体の検査（check.mjs --json をサーバーが呼ぶ）。結果の JSON をそのまま返す
export async function checkAll(text) {
  return either('checkAll', { text }, async () => (await request('POST', '/api/check', { text })).data);
}

// 走っている書き出し・検査を止める（E03。アプリの中だけ）
export async function cancelExport() {
  if (inTauri) await call('cancelExport', {}).catch(() => {});
}

export async function cancelCheck() {
  if (inTauri) await call('cancelCheck', {}).catch(() => {});
}

// 書き出し（pdf / pdf-notes / pptx / html）。できたファイルの情報を返す
export async function exportDeck(format) {
  return either('exportDeck', { format }, async () => {
    const r = await request('POST', `/api/export?format=${encodeURIComponent(format)}`);
    return { ok: r.ok, data: r.data };
  });
}

// 書き出したファイルを受け取る URL（ブラウザのダウンロードのリンクに使う）
export function exportFileUrl(format) {
  return `/api/export-file?format=${encodeURIComponent(format)}`;
}

// Finder で見せる（直前の書き出し、または HTML）
export async function revealPath(path) {
  if (!inTauri) return { ok: false };
  const r = await command('reveal_path', { path });
  return { ok: r?.ok !== false };
}

export async function revealExport(format) {
  return either('revealExport', { format }, async () => ({ ok: (await request('POST', `/api/reveal?format=${encodeURIComponent(format)}`)).ok }));
}
export async function openExport(format) { return call('openExport', { format }); }
export async function openHubExport(lib,slug,reveal=false) { return command('hub_call',{name:reveal?'revealExport':'openExport',args:{lib,slug}}); }

// --- エディター：図と画像 --------------------------------------------------------------------

export async function newFigure() {
  return either('newFigure', {}, async () => (await request('POST', '/api/new-figure')).data);
}

export async function uploadImage(name, blob) {
  if (inTauri) {
    const r = await invoke('upload_image', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-marpkit-name': encodeURIComponent(name) } });
    return { ok: r.ok !== false, path: r.path };
  }
  const r = await request('POST', `/api/upload?name=${encodeURIComponent(name)}`, blob);
  return { ok: r.ok, path: r.data?.path };
}

export async function readDeckFile(path) {
  if (inTauri) {
    const r = await call('readFile', { path });
    return { ok: r.ok !== false, text: r.text, drawio: r.drawio };
  }
  const r = await request('GET', `/api/file?path=${encodeURIComponent(path)}`);
  return { ok: r.ok, text: r.data?.text, drawio: r.data?.drawio };
}

export async function writeDeckFile(path, text) {
  if (inTauri) return { ok: (await call('writeFile', { path, text })).ok !== false };
  return { ok: (await request('PUT', `/api/file?path=${encodeURIComponent(path)}`, text)).ok };
}

export async function openInDrawio(path) {
  if (inTauri) return { ok: (await call('openDrawio', { path })).ok !== false };
  return { ok: (await request('POST', `/api/open-drawio?path=${encodeURIComponent(path)}`)).ok };
}

// --- エディター：ページのコピー --------------------------------------------------------------

// 別の資料へ送るための一覧。読めなかったときは error に文言を入れて返す
export async function copyTargets() {
  if (inTauri) {
    const r = await call('copyTargets', {});
    return { targets: r.targets || [], error: r.error || null };
  }
  try {
    const r = await request('GET', '/api/copy-targets');
    return { targets: r.data?.targets || [], error: r.ok ? null : r.data?.error || '一覧を読めませんでした' };
  } catch {
    return { targets: [], error: '一覧を読めませんでした' };
  }
}

export async function importPages({ text, from }) {
  return either('importPages', { text, from }, async () => (await request('POST', '/api/import-pages', { text, from })).data);
}

export async function sendPages({ text, target }) {
  return either('sendPages', { text, target }, async () => {
    const r = await request('POST', '/api/send-pages', { text, target });
    return { ok: r.ok, data: r.data };
  });
}

// --- エディター：履歴と Git ------------------------------------------------------------------

// 版の画像（img の src に使う）。アプリの中でも画面のサーバーが同じ URL で配る
export function historyObjectUrl(hash) {
  return `/api/history/object/${encodeURIComponent(hash)}`;
}

export async function historyList() {
  return either('historyList', {}, async () => (await request('GET', '/api/history')).data);
}

export async function historyText({ rev, id }) {
  return either('historyText', { rev, id }, async () => {
    const url = rev ? `/api/history/text?rev=${encodeURIComponent(rev)}` : `/api/history/text?id=${encodeURIComponent(id)}`;
    const r = await request('GET', url);
    return { ok: r.ok, text: r.data?.text };
  });
}

export async function historyNamed(label) {
  return either('historyNamed', { label }, async () => ({ ok: (await request('POST', '/api/history/named', { label })).ok }));
}

export async function historyRestoring(label) {
  return either('historyRestoring', { label }, async () => ({ ok: (await request('POST', '/api/history/restoring', { label })).ok }));
}

export async function historyRestoreFigure({ path, hash, label }) {
  return either('historyRestoreFigure', { path, hash, label }, async () => ({ ok: (await request('POST', '/api/history/restore-figure', { path, hash, label })).ok }));
}

export async function gitCommit(message) {
  if (inTauri) {
    const r = await call('gitCommit', { message });
    return { ok: r.ok !== false, data: r.data ?? (r.error ? { error: r.error } : {}) };
  }
  const r = await request('POST', '/api/git/commit', { message });
  return { ok: r.ok, data: r.data };
}

// --- エディター：エージェント用メモ ----------------------------------------------------------

export async function loadNotes() {
  return either('notesGet', {}, async () => (await request('GET', '/api/notes')).data);
}

export async function saveNotes({ notes, draft, scope }) {
  return either('notesSave', { notes, draft, scope }, async () => ({ ok: (await request('PUT', '/api/notes', { notes, draft, scope })).ok }));
}

// --- エディター：知らせ（外部の変更・保存・図の更新） ----------------------------------------

// handlers は { deck: fn, asset: fn, saved: fn } のような形。返り値を呼ぶと購読をやめる
export function subscribeEvents(handlers = {}, { onOpen, onError } = {}) {
  if (inTauri) {
    const unlisteners = [];
    let opened = false;
    // 自分のウインドウ宛ての知らせだけを受ける（別の資料のイベントが混ざらないように。review-P4 の must 7）
    const self = getCurrentWebviewWindow();
    for (const [name, fn] of Object.entries(handlers)) {
      const p = self.listen(name, (e) => {
        if (!opened) { opened = true; onOpen?.(); }
        // Rust は JSON の文字列で送る（EventSource の e.data と同じ形にする）
        fn({ data: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload) });
      });
      unlisteners.push(p);
    }
    onOpen?.();
    return () => { for (const p of unlisteners) p.then((un) => un()).catch(() => {}); };
  }
  const es = new EventSource('/api/events');
  if (onOpen) es.onopen = onOpen;
  if (onError) es.onerror = onError;
  for (const [name, fn] of Object.entries(handlers)) es.addEventListener(name, fn);
  return () => es.close();
}

// --- ウインドウ（アプリの中では Tauri のウインドウ、ブラウザではタブ） ------------------------

// 発表画面・発表者画面を開く（画面のサーバーの /present・/presenter）。
// page は 1 から数えたページ番号
/// アプリの中でライブラリーのウインドウを前へ出す（W03）。ブラウザでは false。
export async function showLibrary() {
  if (!inTauri) return false;
  try {
    const u = await command('hub_url');
    if (!u?.url) return false;
    await command('open_library', { url: u.url });
    return true;
  } catch {
    return false;
  }
}

// 閉じる確認（D01）。アプリのウインドウが CloseRequested を止めて知らせてくる
export async function onCloseRequested(cb) {
  if (!inTauri) return false;
  const unlisten = await getCurrentWebviewWindow().listen('close-requested', cb);
  // 受け手を用意できたことを Rust に知らせる（読み込み中は閉じられる）
  await invoke('close_guard_ready').catch(() => {});
  return unlisten;
}
export async function closeWindowNow() {
  if (inTauri) await command('close_window_now').catch(() => {});
}
export async function cancelCloseWindow() {
  if (inTauri) await command('close_window_cancel').catch(() => {});
}

export async function openPresentWindow(page) {
  if (inTauri) return (await command('open_present', { page }))?.ok !== false ? { ok: true } : null;
  window.open(`/present#${page}`, 'mj-present', 'popup,width=1280,height=760');
  return { ok: true };
}

export async function openPresenterWindow(page) {
  if (inTauri) return (await command('open_presenter', { page }))?.ok !== false ? { ok: true } : null;
  window.open(`/presenter#${page}`, 'mj-presenter', 'popup,width=1440,height=900');
  return { ok: true };
}

export async function openPreviewWindow() {
  if (inTauri) return (await command('open_preview', {}))?.ok !== false ? { ok: true } : null;
  window.open('/preview', 'mj-preview', 'popup,width=1280,height=760');
  return { ok: true };
}

// ライブラリー（ハブ）の画面で資料を開く。アプリの中では新しいウインドウ、ブラウザでは新しいタブ
// 名前を変えた・アーカイブした資料のウインドウを閉じる（アプリの中だけ。ブラウザはタブなので閉じない）
export async function closeDeckWindow(deckPath) {
  if (!inTauri || !deckPath) return;
  const r = await command('close_deck', { deckPath: deckPath.endsWith('slides.md') ? deckPath : `${deckPath}/slides.md` });
  if (r && r.ok === false) throw new Error(r.data?.error || '保存できませんでした');
}

export async function openDeckWindow({ lib, slug, view = 'edit', page, deckPath }) {
  if (inTauri) {
    if (!deckPath) throw new Error('資料の場所が分かりません');
    // 発表は発表画面、それ以外はエディターのウインドウを開く
    const r = view === 'present'
      ? await command('open_present_for', { deckPath, page })
      : await command('open_editor', { deckPath, view: view === 'split' ? 'split' : 'slide', page });
    if (r?.ok === false) throw new Error(r.data?.error || 'ウインドウを開けませんでした');
    return { url: r.url, opened: true };
  }
  const r = await hubOpen({ lib, slug, view, page });
  return { url: r.url, opened: false };
}

// 書き出した PDF などをウインドウで開く。
// アプリの中では、ライブラリーのウインドウを使わずに、書き出したファイル用の別のウインドウを開く
export async function openFileWindow(url, label = 'file') {
  if (inTauri) {
    const abs = new URL(url, location.href).href;
    const r = await command('open_file_window', { url: abs, label: `file-${label}`, title: '書き出したファイル' });
    return r?.ok !== false ? { ok: true } : { ok: false };
  }
  window.open(url, '_blank');
  return { ok: true };
}

// --- ライブラリー（ハブ） --------------------------------------------------------------------

// アプリの中では invoke（hub_call）、ブラウザでは Node のハブのサーバーを呼ぶ
async function hubEither(name, args, http) {
  if (!inTauri) return http();
  const r = await command('hub_call', { name, args: args ?? {} });
  if (r.ok === false) {
    const err = new Error(r.data?.error || 'ライブラリーを操作できませんでした');
    err.detail = r.data?.detail || null;
    throw err;
  }
  return r;
}

// ハブの API は、サーバーが返した error をそのまま例外の文言にする（今と同じ扱い）
async function hubRequest(method, url, body) {
  const r = await request(method, url, body);
  if (!r.ok) {
    const err = new Error(r.data?.error || `エラー（${r.status}）`);
    err.detail = r.data?.detail || null;
    throw err;
  }
  return r.data;
}

export async function hubInfo() {
  return hubEither('info', {}, () => hubRequest('GET', '/api/info'));
}

export async function hubLibraries() {
  return hubEither('libraries', {}, () => hubRequest('GET', '/api/libraries'));
}

export async function hubAddLibrary({ path, name }) {
  return hubEither('librariesAdd', { path, name }, () => hubRequest('POST', '/api/libraries', { path, name }));
}

export async function hubDecks({ lib, archived = false }) {
  return hubEither('decks', { lib, archived }, () => hubRequest('GET', `/api/decks?lib=${encodeURIComponent(lib)}&archived=${archived ? 1 : 0}`));
}

// 雛形からの作成とフォルダからの取り込みで共通の入口。
export async function hubCreateDeck(body) {
  return hubEither('decksCreate', body, () => hubRequest('POST', '/api/decks', body));
}

export async function hubDeckText({ lib, slug }) {
  return hubEither('deckText', { lib, slug }, () => hubRequest('GET', `/api/deck-text?lib=${encodeURIComponent(lib)}&slug=${encodeURIComponent(slug)}`));
}

export async function hubDeckOp({ lib, slug, op, to, title }) {
  return hubEither('decksOp', { lib, slug, op, to, title }, () => hubRequest('POST', '/api/decks/op', { lib, slug, op, to, title }));
}

export async function hubOpen({ lib, slug, view, page }) {
  return hubRequest('POST', '/api/open', { lib, slug, view, page });
}

export async function cancelHubPdf() {
  if (inTauri) await hubEither('cancelPdf', {}, () => ({ ok: true })).catch(() => {});
}

export async function hubPdf({ lib, slug }) {
  return hubEither('pdf', { lib, slug }, () => hubRequest('POST', '/api/pdf', { lib, slug }));
}

// Git は op（init・status・log・commit・file・restore・remote・fetch・pull・push）ごとに同じ入口
export async function hubGit(op, body = {}) {
  if (inTauri) return hubEither('git', { op, ...body }, () => hubRequest('POST', `/api/git/${op}`, body));
  if (op === 'file' || op === 'status' || op === 'log') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ lib: body.lib, slug: body.slug, rev: body.rev, limit: body.limit })) {
      if (v !== undefined && v !== null && v !== '') q.set(k, v);
    }
    return hubRequest('GET', `/api/git/${op}?${q}`);
  }
  return hubRequest('POST', `/api/git/${op}`, body);
}

// 資料の画像（img の src に使う）
export function hubFileUrl(lib, slug, path) {
  return `/files/${encodeURIComponent(lib)}/${slug}/${path}`;
}

// 過去の版の画像（img の src に使う）。rev が WORKTREE のときは今のファイル
export function hubGitFileUrl(lib, rev, path) {
  if (rev === 'WORKTREE') return `/files/${encodeURIComponent(lib)}/${path}`;
  return `/git-file/${encodeURIComponent(lib)}?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}`;
}

// --- アプリの都合 ----------------------------------------------------------------------------

// Node と Chrome があるか（検査と書き出しの前に見る）。ブラウザでは常に true
export async function runtimeStatus() {
  if (!inTauri) return { node: true, chrome: true, message: '' };
  const r = await command('node_status', {});
  return { node: true, chrome: false, message: '', ...r };
}

export async function deckLocation() {
  if (!inTauri) return null;
  return command('api_call', { name: 'deckLocation', args: {} }).catch(() => null);
}

export async function draftGet() {
  if (!inTauri) return null;
  const r = await call('draftGet', {});
  return r?.draft || null;
}
export async function draftSet(draft) {
  if (!inTauri) return;
  return call('draftSet', draft);
}
export async function draftClear(options = {}) {
  if (!inTauri) return;
  return call('draftClear', options);
}

export async function renameDeck(to) {
  const result = await call('renameDeck', { to });
  if (result?.ok === false) throw new Error(result.data?.error || '名前を変更できませんでした');
  return result;
}

export async function presentationFullscreen(active = null, toggle = false) {
  if (!inTauri) return null;
  return command('presentation_fullscreen', { active, toggle });
}

export function pickLibraryFolder(purpose) { return invoke('pick_library_folder',{purpose}); }
export function hubFolderInfo(path) { return hubEither('folderInfo',{path},()=>hubRequest('GET','/api/folder-info?path='+encodeURIComponent(path))); }
export async function onLibraryDrop(handler) {
  if (!inTauri) return;
  return getCurrentWebviewWindow().onDragDropEvent(e=>{if(e.payload.type==='drop')handler(e.payload.paths);});
}
