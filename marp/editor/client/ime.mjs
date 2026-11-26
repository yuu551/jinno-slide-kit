// 日本語入力（IME）の変換中のキーは、アプリのどの処理にも渡さない。
// 変換を確定する Enter を「確定・改行・送信」と取り違えると、確定しただけで編集が終わったり改行が入ったりする。
// 変換中の keydown は isComposing が true（Safari は keyCode 229 で、確定の Enter が compositionend の後に来ることがある）。
// 変換そのものはブラウザの既定の動作なので、止めるのは伝わり方（stopImmediatePropagation）だけ。
// CodeMirror は自分で変換を扱うので、その中は素通しにする。
let lastCompositionEnd = 0;
export function guardIME(win = window) {
  win.addEventListener('compositionend', () => { lastCompositionEnd = performance.now(); }, true);
  win.addEventListener('keydown', (e) => {
    if (e.target?.closest?.('.cm-editor')) return;
    const justEnded = e.key === 'Enter' && performance.now() - lastCompositionEnd < 30; // Safari：確定の Enter が直後に来る
    if (e.isComposing || e.keyCode === 229 || justEnded) e.stopImmediatePropagation();
  }, true);
}
