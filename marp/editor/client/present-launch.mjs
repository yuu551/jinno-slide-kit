// エディターから発表モードを始める（ツールバーの「発表」ボタンと ⌘⏎ / Ctrl+Enter）。
// main.mjs とは独立。今のページ（URL の #N）から、発表画面と発表者画面を別ウィンドウで開く。
//
// このファイルは束ねずにそのまま配る（/present-launch.js）ので、他のモジュールを import しない。
// アプリ（Tauri）の中では invoke でウインドウを開き、ブラウザではこれまでどおり window.open を使う。
const btn = document.getElementById('btn-present');
// withGlobalTauri を切っても動くよう、Tauri の内部 API を使う
const tauriInvoke = typeof window !== 'undefined' && (window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke);
const inTauri = !!tauriInvoke;

function notice(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'is-info';
  t.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { t.hidden = true; }, 3600);
}

// 開けたら true。アプリの中では Tauri のウインドウ、ブラウザでは名前付きのタブ
async function openWindow(kind, n) {
  if (inTauri) {
    try {
      await tauriInvoke(kind === 'present' ? 'open_present' : 'open_presenter', { page: n });
      return true;
    } catch {
      return false;
    }
  }
  const url = kind === 'present' ? `/present#${n}` : `/presenter#${n}`;
  const name = kind === 'present' ? 'mj-present' : 'mj-presenter';
  const size = kind === 'present' ? 'popup,width=1280,height=760' : 'popup,width=1440,height=900';
  return window.open(url, name, size);
}

async function launch() {
  const n = Math.max(1, Number(location.hash.slice(1)) || 1);
  // 名前付きの窓なので、2回目以降は開いている窓がそのページへ移る
  const present = await openWindow('present', n).catch(() => null);
  const presenter = await openWindow('presenter', n).catch(() => null);
  present?.focus?.();
  if (!present) notice(inTauri ? '発表画面を開けませんでした。もう一度「発表」を押してください。' : 'ポップアップがブロックされました。アドレスバーの右端から許可してください');
  else if (!presenter) notice('発表者画面は、発表画面で S キーを押すと開けます');
  // 未保存の変更があれば、窓を開いたあとで保存する（保存すると発表画面にもすぐ反映される）
  if (document.querySelector('#status.is-dirty') && window.__marpkit?.save) window.__marpkit.save().then((ok) => { if (ok) notice('保存して、最新の内容で発表を始めました'); });
}

btn?.addEventListener('click', launch);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
  // 直接編集・ソース・入力欄の ⌘⏎ はそれぞれの意味（確定など）を優先する
  if (e.target.closest?.('input, textarea, select, .cm-editor, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
  if (!document.getElementById('modal')?.hidden) return;
  e.preventDefault();
  launch();
});
