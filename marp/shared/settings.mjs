// アプリの設定は Rust のファイルへ、ブラウザは従来の localStorage へ。
import { invoke } from '@tauri-apps/api/core';

const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let initialError = null;
const cache = native ? await invoke('settings_get').catch(error => { initialError = String(error); return {}; }) : null;
let pending = Promise.resolve();
const failed = new Set();
const notify = error => window.dispatchEvent(new CustomEvent('settings-error', { detail: String(error) }));

export const settings = {
  getItem(key) { return native ? cache[key] ?? null : localStorage.getItem(key); },
  setItem(key, value) {
    if (!native) return localStorage.setItem(key, value);
    const text = String(value);
    if (cache[key] === text && !failed.has(key)) return;
    cache[key] = text;
    pending = pending.then(() => invoke('settings_set', { key, value: text }))
      .then(() => failed.delete(key))
      .catch(error => { failed.add(key); notify(error); });
  },
  // 設定の失敗は通知する。資料を閉じる・終了する操作は妨げない。
  async flush() { await pending; },
  reportErrors() { if (initialError) { notify(initialError); initialError = null; } },
};
