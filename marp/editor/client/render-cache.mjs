// Parse the complete document so references, source lines and inherited directives stay correct.
// Marpit exposes each slide's tokens; only changed token groups need HTML rendering.
export function installSlideCache(marp, seed = []) {
  const original = marp.renderMarkdown.bind(marp);
  let cache = seed;
  const stats = { rendered: 0, reused: 0 };
  marp.renderMarkdown = function (text, env = {}) {
    if (!env.htmlAsArray) return original(text, env);
    const parsed = this.markdown.parse(text, env);
    // Components insert and replace tokens after Marpit captured lastSlideTokens.
    // Split the final stream instead, so their wrappers and generated content remain.
    const slides = [];
    let slide;
    for (const token of parsed) {
      if (token.meta?.marpitSlideElement === 1) { slide = []; slides.push(slide); }
      if (slide) slide.push(token);
      if (token.meta?.marpitSlideElement === -1) slide = undefined;
    }
    // Marpit assigns random scoped-style names on every parse. Stable names within this
    // editor keep unchanged HTML/CSS cached, including scoped animation references.
    slides.forEach((tokens, index) => {
      for (const token of tokens) {
        const scope = token.meta?.marpitStyleScoped;
        if (!scope?.key) continue;
        const before = scope.key, after = `editor${index}`;
        const replace = css => {
          let value = css.replaceAll(`data-marpit-scope-${before}`, `data-marpit-scope-${after}`);
          for (const name of scope.keyframeSet || []) value = value.replaceAll(`${name}-${before}`, `${name}-${after}`);
          return value;
        };
        scope.key = after;
        scope.styles = scope.styles.map(replace);
        for (const attr of token.attrs || []) if (attr[0] === `data-marpit-scope-${before}`) attr[0] = `data-marpit-scope-${after}`;
        this.lastStyles = this.lastStyles.map(replace);
      }
    });
    const context = (text.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0] || '') + '\n' +
      [...text.matchAll(/<!--[\s\S]*?-->/g)].map(m => m[0]).filter(s => /\b(?:photos|chapters)\s*:/.test(s)).join('\n');
    const next = [];
    stats.rendered = stats.reused = 0;
    const html = slides.map((tokens, i) => {
      const key = JSON.stringify([context, env.references || null, tokens]);
      let value;
      if (cache[i]?.key === key) { value = cache[i].html; stats.reused++; }
      else { value = this.markdown.renderer.render(tokens, this.markdown.options, env); stats.rendered++; }
      next.push({ key, html: value });
      return value;
    });
    cache = next;
    return html;
  };
  return { stats, snapshot: () => cache, seed: value => { cache = value; } };
}
