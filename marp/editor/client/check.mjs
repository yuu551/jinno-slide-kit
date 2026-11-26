// ブラウザ内の見切れチェック。基準は marp/shared/deck-check.mjs（CLI）と同じ（フッター上端はテーマの --footer-h から、
// スライド外、枠内の切れ、画像の読込失敗・縮小、タイトル2行、リード4行以上）。scale は section に掛かっている縮小率（等倍なら1）。
// 判定を変えたら deck-check.mjs もそろえる。scripts/dev/test-check-parity.mjs で両方の結果が同じか確かめる。
const LIMIT_BOTTOM = 665;

export function checkSection(sec, scale = 1) {
  const res = [];
  const cls = sec.className;
  const limit = /\bfull\b/.test(cls) ? 720 : 720 - (parseFloat(getComputedStyle(sec).getPropertyValue('--footer-h')) || 720 - LIMIT_BOTTOM);
  const exempt = /\b(cover|divider|closing)\b/.test(cls);
  const base = sec.getBoundingClientRect();
  const rel = (r) => ({ x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, r: (r.right - base.left) / scale, b: (r.bottom - base.top) / scale });
  const label = (el) => (el.textContent || el.getAttribute?.('src') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const push = (type, level, msg, el) => res.push({ type, level, msg, el });
  const flagged = new Set();

  const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n; (n = walker.nextNode());) {
    if (!n.textContent.trim()) continue;
    const host = n.parentElement;
    if (host.closest('footer')) continue;
    range.selectNodeContents(n);
    for (const rect of range.getClientRects()) {
      const r = rel(rect);
      if (r.b - r.y < 2) continue;
      if (flagged.has(host)) break;
      if (r.r > 1281 || r.x < -1 || r.b > 721) { flagged.add(host); push('overflow-slide', 'error', `スライドの外へ: 「${label(host)}」`, host); }
      else if (r.b > limit + 1 && !exempt) { flagged.add(host); push('overflow-footer', r.b - limit > 3 ? 'error' : 'warn', `フッター領域へ${Math.round(r.b - limit)}px: 「${label(host)}」`, host); }
    }
  }
  for (const el of sec.querySelectorAll('.blocks > *, .blocks img, .code-window, table, .speech-message, .dialogue-row, .purpose-row')) {
    if (flagged.has(el)) continue;
    const r = rel(el.getBoundingClientRect());
    if (r.b - r.y < 1) continue;
    if (r.r > 1281 || r.x < -1 || r.b > 721) { flagged.add(el); push('overflow-slide', 'error', `要素がスライドの外へ: ${el.tagName.toLowerCase()}`, el); }
    else if (r.b > limit + 1 && !exempt) { flagged.add(el); push('overflow-footer', r.b - limit > 3 ? 'error' : 'warn', `要素がフッター領域へ${Math.round(r.b - limit)}px: ${label(el) || el.tagName.toLowerCase()}`, el); }
  }
  for (const el of sec.querySelectorAll('pre, td, th, .speech-message, .dialogue-bubble, .purpose-label')) {
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      const cs = getComputedStyle(el);
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible') push('overflow-box', 'error', `枠内で切れている: 「${label(el)}」`, el);
    }
  }
  for (const img of sec.querySelectorAll('img')) {
    if (img.complete && img.naturalWidth === 0) { push('image-missing', 'error', `画像が読めない: ${img.getAttribute('src')}`, img); continue; }
    const want = parseFloat(img.style.height);
    const got = img.getBoundingClientRect().height / scale;
    if (img.complete && want && got < want - 1) push('image-shrunk', 'warn', `図が${Math.round(want)}→${Math.round(got)}pxに縮小（横幅の制約）`, img);
  }
  const h1 = sec.querySelector(':scope > h1');
  if (h1 && !exempt) {
    // 見出しの帯（上下の余白と下線）を除いた高さを、行の高さで割る。余白はテーマや layout で変わる
    const cs = getComputedStyle(h1);
    const inner = h1.getBoundingClientRect().height / scale - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
    if (inner / parseFloat(cs.lineHeight) > 1.5) push('title-wrap', 'warn', `タイトルが2行: 「${label(h1)}」`, h1);
  }
  const lead = sec.querySelector(':scope > p.lead');
  if (lead) {
    const lh = parseFloat(getComputedStyle(lead).lineHeight);
    const lines = Math.round(lead.getBoundingClientRect().height / scale / lh);
    if (lines >= 4) push('lead-lines', 'warn', `リード文が${lines}行`, lead);
  }
  const footer = sec.querySelector(':scope > footer');
  if (footer && footer.textContent.trim()) {
    const tops = [...footer.querySelectorAll('span')].map((s) => s.getBoundingClientRect().top);
    if (tops.length && (Math.max(...tops) - Math.min(...tops)) / scale > 4) push('footer-wrap', 'warn', 'パンくずが2行', footer);
  }
  return res;
}
