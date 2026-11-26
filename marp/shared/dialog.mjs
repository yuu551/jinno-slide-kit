// 画面の中の共通ダイアログ（G05）。WKWebView の confirm / prompt は「キャンセル」しか返さないので、
// アプリでもブラウザでも同じ見た目のダイアログを使う。
let seq = 0;
// いま出ているダイアログを閉じる関数。次を出す前に、前の Promise をキャンセルで決着させる
let activeCancel = null;

function host() {
  let el = document.getElementById('mj-dialog-host');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mj-dialog-host';
    el.className = 'mj-dialog-host';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function open({ title, message, body = '', ok, cancel, danger = false, value = null, extra = null }) {
  return new Promise((resolve) => {
    const cancelValue = value === null ? false : null;
    if (activeCancel) activeCancel();
    const el = host();
    const id = `mj-dialog-${++seq}`;
    const previous = document.activeElement;
    el.innerHTML = `
      <div class="mj-dialog-backdrop">
        <section class="mj-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-body">
          <h2 id="${id}-title">${esc(title)}</h2>
          <div id="${id}-body" class="mj-dialog-body">${message ? `<p>${esc(message)}</p>` : ''}${body}</div>
          <footer>
            ${extra ? `<button type="button" data-act="extra" class="${extra.danger ? 'is-danger' : ''}">${esc(extra.label)}</button>` : ''}
            ${cancel ? `<button type="button" data-act="cancel">${esc(cancel)}</button>` : ''}
            <button type="button" data-act="ok" class="${danger ? 'is-danger' : 'mj-primary'}">${esc(ok)}</button>
          </footer>
        </section>
      </div>`;
    el.hidden = false;
    const dialog = el.querySelector('.mj-dialog');
    const input = el.querySelector('input, textarea');
    let cancelSelf = null;
    const finish = (v) => {
      if (activeCancel === cancelSelf) activeCancel = null;
      el.hidden = true;
      el.innerHTML = '';
      window.removeEventListener('keydown', onKey, true);
      if (previous && previous.focus) previous.focus();
      resolve(v);
    };
    const onKey = (e) => {
      // ダイアログが開いている間は、後ろの画面のキー操作へ渡さない
      if (e.key === 'Enter' && input && e.target === input && !e.isComposing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(input.value);
        return;
      }
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(value === null ? false : null); return; }
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll('button, input, textarea')].filter((x) => !x.disabled);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      const next = (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    };
    el.querySelector('[data-act="extra"]')?.addEventListener('click', () => finish(extra.value));
    el.querySelector('[data-act="cancel"]')?.addEventListener('click', () => finish(value === null ? false : null));
    el.querySelector('[data-act="ok"]').addEventListener('click', () => finish(value === null ? true : (input?.value ?? '')));
    const backdrop = el.querySelector('.mj-dialog-backdrop');
    let startedOnBackdrop = false;
    backdrop.addEventListener('pointerdown', (e) => { startedOnBackdrop = e.target === backdrop; });
    backdrop.addEventListener('click', (e) => {
      if (startedOnBackdrop && e.target === e.currentTarget) finish(value === null ? false : null);
    });
    cancelSelf = () => finish(value === null ? false : null);
    activeCancel = cancelSelf;
    window.addEventListener('keydown', onKey, true);
    const okBtn = el.querySelector('[data-act="ok"]');
    const cancelBtn = el.querySelector('[data-act="cancel"]');
    // 危ない操作は、既定で「キャンセル」にフォーカスを置く（G05）
    (input || (danger && cancelBtn) || okBtn).focus();
    if (input) input.select();
  });
}

export function confirmDialog(opts = {}) {
  return open({ title: '確認', ok: 'OK', cancel: 'キャンセル', ...opts });
}

/// 閉じるときの確認（保存する・保存しない・キャンセル）
export function closeConfirmDialog(message) {
  return confirmDialog({
    title: '未保存の変更',
    message,
    ok: '保存して閉じる',
    cancel: 'キャンセル',
    extra: { label: '保存しないで閉じる', value: 'discard', danger: true },
  });
}

export function promptDialog({ title = '入力', label = '', value = '', ok = 'OK', cancel = 'キャンセル' } = {}) {
  const body = `<label class="mj-dialog-field"><span>${esc(label)}</span><input data-dialog-input value="${esc(value)}"></label>`;
  return open({ title, message: '', body, ok, cancel, value: '' });
}
