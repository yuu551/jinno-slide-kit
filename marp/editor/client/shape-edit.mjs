// 図（SVG）の形を SVG-Edit で直すモード。svg-edit.mjs のモーダルの「形も編集」から開く。
// SVG-Edit は iframe（/svgedit/marpkit-host.html、同一オリジン）に丸ごと載せ、親から window.svgEditor を直接使う。
// 保存は SVG-Edit の書き出しを使わず、shape-serialize.mjs で元のSVGに合わせて書き出す。
import { prepare, snapshot, serialize, today } from './shape-serialize.mjs';
import { confirmDialog } from '../../shared/dialog.mjs';
import { readDeckFile, writeDeckFile } from './backend.mjs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function openShapeEditor({ path, modal, toast, onSaved, onClose }) {
  const r = await readDeckFile(path);
  if (!r.ok) { toast('SVGを読めませんでした', 'error'); return; }
  const { text } = r;
  let prep;
  try { prep = prepare(text); } catch (e) { toast(e.message, 'error'); return; }

  modal.hidden = false;
  modal.innerHTML = `
    <div class="mj-modal-card mj-shape-card" role="dialog" aria-label="図の形を編集">
      <div class="mj-modal-head">
        <strong>${esc(path)}</strong>
        <span class="mj-modal-hint">クリックで選んでドラッグで移動、四隅で拡大縮小。色は下のパレット、線の太さ・破線は下のバー</span>
        <span class="mj-spacer"></span>
        <span class="mj-shape-status" aria-live="polite"></span>
        <button type="button" data-act="save" class="mj-primary" disabled>保存</button>
        <button type="button" data-act="close">閉じる</button>
      </div>
      <div class="mj-shape-body"><iframe class="mj-shape-frame" title="SVG-Edit" src="/svgedit/marpkit-host.html"></iframe></div>
    </div>`;
  const frame = modal.querySelector('.mj-shape-frame');
  const saveBtn = modal.querySelector('[data-act="save"]');
  const status = modal.querySelector('.mj-shape-status');

  let editor, state, savedUndo = 0;
  const undoSize = () => editor?.svgCanvas.undoMgr.getUndoStackSize() ?? 0;
  const dirty = () => !!state && undoSize() !== savedUndo;
  window.__figureDirty = dirty;
  const refresh = () => { window.dispatchEvent(new Event('figure-dirty-changed')); saveBtn.disabled = !state; status.textContent = dirty() ? '未保存の変更あり' : ''; };

  try {
    await new Promise((resolve, reject) => { frame.addEventListener('load', resolve, { once: true }); setTimeout(() => reject(new Error('SVG-Edit を読み込めませんでした')), 20000); });
    const win = frame.contentWindow;
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => (win.svgEditor?.isReady ? resolve() : Date.now() - t0 > 20000 ? reject(new Error('SVG-Edit の起動待ちで時間切れ')) : setTimeout(tick, 50));
      tick();
    });
    editor = win.svgEditor;
    await editor.loadFromString(prep.loadText, { noAlert: true });
    editor.svgCanvas.undoMgr.resetUndoStack();
    state = snapshot(editor.svgCanvas.getSvgContent(), prep);
    editor.zoomChanged(win, 'canvas'); // 図全体が収まる倍率に
    editor.topPanel?.updateTitle?.(path.split('/').pop());
    // bind は既存のハンドラを置き換えるので、元のハンドラ（SVG-Edit の画面更新）も呼ぶ
    const prev = editor.svgCanvas.bind('changed', (...a) => { prev?.(...a); refresh(); });
    win.addEventListener('mouseup', () => setTimeout(refresh, 0));
    win.addEventListener('keyup', () => setTimeout(refresh, 0));
    refresh();
  } catch (e) {
    toast(String(e.message || e), 'error');
  }

  const close = async (force) => {
    if (document.querySelector('#mj-dialog-host:not([hidden])')) return;
    if (!force && dirty() && !(await confirmDialog({ title: '変更を破棄', message: '保存していない形の変更があります。破棄して閉じますか？', ok: '破棄する', danger: true }))) return;
    delete window.__figureDirty;
    window.dispatchEvent(new Event('figure-dirty-changed'));
    delete window.__figureSave;
    modal.hidden = true; modal.innerHTML = ''; modal.onclick = null;
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => { if (document.querySelector('#mj-dialog-host:not([hidden])')) return; if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);

  const save = async () => {
    if (!state) return;
    // 編集中の文字・パスの確定、グループ内編集の解除、選択の解除（選択枠は svgcontent の外なので書き出しには入らない）
    const c = editor.svgCanvas;
    if (c.getMode() === 'textedit') c.textActions.toSelectMode();
    if (c.getMode() === 'pathedit') c.pathActions.toSelectMode(c.getSelectedElements()[0]);
    c.setMode('select');
    if (c.getCurrentGroup?.()) c.leaveContext();
    c.clearSelection();
    const out = serialize(state, { mark: today() });
    const res = await writeDeckFile(path, out);
    if (!res.ok) { toast('SVGを保存できませんでした', 'error'); return false; }
    savedUndo = undoSize();
    refresh();
    toast('図を保存しました');
    onSaved?.(path);
    return true;
  };

  window.__figureSave = () => (dirty() ? save() : true);

  modal.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'save') await save();
  };

  // テスト・デバッグ用
  window.__shape = { get editor() { return editor; }, get state() { return state; }, save, close, dirty };
}
