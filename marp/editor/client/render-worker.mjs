import { createEditorRenderer } from './render-core.mjs';
self.onmessage = ({ data }) => {
  try {
    const { marp, cache } = createEditorRenderer(data.themes);
    const result = marp.render(data.text, { htmlAsArray: true });
    self.postMessage({ result, cache: cache.snapshot() });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
