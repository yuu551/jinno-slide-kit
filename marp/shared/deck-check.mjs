// CLI とアプリで同じ検査を行う。DOM の測定関数はその画面で実行する。

export function checkLayout({ range }) {
  const LIMIT_BOTTOM = 665; // フッター（55px）の上端
  const res = [];
  const sections = [...document.querySelectorAll('section[id]')];
  sections.forEach((sec, idx) => {
    const no = idx + 1;
    if (range && (no < range[0] || no > range[1])) return;
    const cls = sec.className;
    const LIMIT = /\bfull\b/.test(cls) ? 720 : 720 - (parseFloat(getComputedStyle(sec).getPropertyValue('--footer-h')) || 720 - LIMIT_BOTTOM);

    const base = sec.getBoundingClientRect();
    const rel = (r) => ({ x: r.left - base.left, y: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top });
    const push = (type, level, msg, extra = {}) => res.push({ page: no, type, level, msg, ...extra });
    const label = (el) => (el.textContent || el.getAttribute?.('src') || '').trim().replace(/\s+/g, ' ').slice(0, 40);

    // 文字の実際の描画範囲（要素の箱ではなく、行ごとの矩形）
    const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
    const range_ = document.createRange();
    const seen = new Set();
    for (let n; (n = walker.nextNode());) {
      if (!n.textContent.trim()) continue;
      const host = n.parentElement;
      if (host.closest('footer')) continue;
      range_.selectNodeContents(n);
      for (const rect of range_.getClientRects()) {
        const r = rel(rect);
        if (r.b - r.y < 2) continue;
        const key = host.tagName + label(host);
        if ((r.r > 1281 || r.x < -1 || r.b > 721) && !seen.has('s' + key)) {
          seen.add('s' + key); push('overflow-slide', 'error', `スライドの外へ: 「${label(host)}」`, { box: r });
        } else if (r.b > LIMIT + 1 && !/\b(cover|divider|closing)\b/.test(cls) && !seen.has('f' + key)) {
          seen.add('f' + key); push('overflow-footer', r.b - LIMIT > 3 ? 'error' : 'warn', `フッター領域へ${Math.round(r.b - LIMIT)}px: 「${label(host)}」`, { box: r });
        }
      }
    }
    // 要素（図・枠）のはみ出し
    for (const el of sec.querySelectorAll('.blocks > *, .blocks img, .code-window, table, .speech-message, .dialogue-row, .purpose-row')) {
      const r = rel(el.getBoundingClientRect());
      if (r.b - r.y < 1) continue;
      if (r.r > 1281 || r.x < -1 || r.b > 721) push('overflow-slide', 'error', `要素がスライドの外へ: ${el.tagName.toLowerCase()}.${el.className}`, { box: r });
      else if (r.b > LIMIT + 1 && !/\b(cover|divider|closing)\b/.test(cls)) push('overflow-footer', r.b - LIMIT > 3 ? 'error' : 'warn', `要素がフッター領域へ${Math.round(r.b - LIMIT)}px: ${el.tagName.toLowerCase()}.${el.className || ''} ${label(el)}`, { box: r });
    }
    // 枠の中で切れている
    for (const el of sec.querySelectorAll('pre, td, th, .speech-message, .dialogue-bubble, .purpose-label, h3, h4, dt, dd, .label, .strip b')) {
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
        const cs = getComputedStyle(el);
        if (cs.overflow !== 'visible' || cs.overflowX !== 'visible') push('overflow-box', 'error', `枠内で切れている: 「${label(el)}」`);
        else if (el.scrollWidth > el.clientWidth + 1) push('overflow-box', 'error', `文字が枠の外へはみ出している（${el.scrollWidth - el.clientWidth}px）: 「${label(el)}」`);
      }
    }
    // 泣き別れ：最後の行が1〜2文字だけ（「る」「し」だけが次の行に落ちる）
    if (!/\b(cover|divider|closing)\b/.test(cls)) {
      for (const el of sec.querySelectorAll('p, li, td, th, dd, dt, h1, h3, h4, .steps b')) {
        const kids = [...el.childNodes];
        const stopAt = kids.findIndex((n) => n.nodeType === 1 && /^(UL|OL|DIV|TABLE)$/.test(n.tagName));
        const own = (stopAt < 0 ? kids : kids.slice(0, stopAt)).filter((n) => (n.nodeType === 3 && n.textContent.trim()) || n.nodeType === 1);
        if (!own.length) continue;
        const r = document.createRange();
        r.setStartBefore(own[0]); r.setEndAfter(own[own.length - 1]);
        const rects = [...r.getClientRects()].filter((x) => x.width > 1 && x.height > 4);
        if (rects.length < 2) continue;
        const tops = [...new Set(rects.map((x) => Math.round(x.top)))];
        if (tops.length < 2) continue;
        const lastTop = Math.max(...tops);
        const lastW = rects.filter((x) => Math.round(x.top) === lastTop).reduce((a, x) => a + x.width, 0);
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (lastW < fs * 2.6) push('widow', 'warn', `最後の行が${Math.max(1, Math.round(lastW / fs))}文字だけ: 「${label(el).slice(-14)}」`);
      }
    }
    // 画像
    for (const img of sec.querySelectorAll('img')) {
      if (!img.complete || img.naturalWidth === 0) { push('image-missing', 'error', `画像が読めない: ${img.getAttribute('src')}`); continue; }
      const want = parseFloat(img.style.height);
      const got = img.getBoundingClientRect().height;
      if (want && got < want - 1) push('image-shrunk', 'warn', `図が${Math.round(want)}→${Math.round(got)}pxに縮小（横幅の制約）: ${img.getAttribute('src')}`);
    }
    // タイトル・リード・パンくず
    const h1 = sec.querySelector(':scope > h1');
    if (h1 && !/\b(cover|divider|closing)\b/.test(cls)) {
      const cs = getComputedStyle(h1);
      const inner = h1.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
      if (inner / parseFloat(cs.lineHeight) > 1.5) push('title-wrap', 'warn', `タイトルが2行: 「${label(h1)}」`);
    }
    const lead = sec.querySelector(':scope > p.lead');
    if (lead) {
      const lh = parseFloat(getComputedStyle(lead).lineHeight);
      const lines = Math.round(lead.getBoundingClientRect().height / lh);
      if (lines >= 4) push('lead-lines', 'warn', `リード文が${lines}行`);
    }
    const footer = sec.querySelector(':scope > footer');
    if (footer && footer.textContent.trim()) {
      const items = [...footer.querySelectorAll('span')].map((s) => s.getBoundingClientRect().top);
      if (items.length && Math.max(...items) - Math.min(...items) > 4) push('footer-wrap', 'warn', 'パンくずが2行');
    }
  });
  return res;
}

export function measureSvg() {
    const root = document.querySelector('body>svg').getBoundingClientRect();
    const texts = [...document.querySelectorAll('svg text')].map((e) => { const b = e.getBoundingClientRect(); return { t: e.textContent.trim(), x: b.x - root.x, y: b.y - root.y, w: b.width, h: b.height }; }).filter((t) => t.t && t.w > 0);
    const outside = texts.filter((t) => t.x < -1 || t.y < -1 || t.x + t.w > root.width + 1 || t.y + t.h > root.height + 1).map((t) => t.t);
    const overlaps = [];
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 3 && h > 3 && h > Math.min(a.h, b.h) * 0.35) overlaps.push(`${a.t} × ${b.t}`);
    }
    // 枠からのはみ出し：文字の書き出し位置を含むいちばん小さい枠（rect）を囲みとみなし、
    // 文字の範囲がその枠の内側（左右3px）に収まっているかを見る。背景の全面の rect は除く。
    const rects = [...document.querySelectorAll('svg rect')].map((e) => { const b = e.getBoundingClientRect(); return { x: b.x - root.x, y: b.y - root.y, w: b.width, h: b.height }; })
      .filter((r) => r.w > 30 && r.h > 20 && !(r.w >= root.width - 2 && r.h >= root.height - 2));
    const boxed = [];
    for (const t of texts) {
      const cy = t.y + t.h / 2, sx = t.x + Math.min(8, t.w / 2);
      const host = rects.filter((r) => sx >= r.x && sx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h).sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (!host) continue;
      if (t.x + t.w > host.x + host.w - 3 || t.x < host.x + 1) boxed.push(`「${t.t.slice(0, 24)}」が枠からはみ出し（${Math.round(t.x + t.w - (host.x + host.w))}px）`);
    }
    // 文字を横切る線：M/L だけの直線の path・line が、文字の中央の帯（上下25%を除く）を通っていないか
    // 線の上に白い下地（塗りが白で線なしの rect）や丸を重ねて文字を置いている場合は、線は隠れているので数えない
    const segs = [];
    for (const e of document.querySelectorAll('svg path, svg line')) {
      const m = e.getScreenCTM(); if (!m) continue;
      let pts = [];
      if (e.tagName === 'line') pts = [[+e.getAttribute('x1'), +e.getAttribute('y1')], [+e.getAttribute('x2'), +e.getAttribute('y2')]];
      else { const d = e.getAttribute('d') || ''; if (!/^[\sML\d.,-]+$/.test(d)) continue; pts = [...d.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map((q) => [+q[1], +q[2]]); }
      if (e.closest('marker, defs')) continue;
      const tp = pts.map(([x, y]) => [m.a * x + m.c * y + m.e - root.x, m.b * x + m.d * y + m.f - root.y]);
      for (let i = 1; i < tp.length; i++) segs.push([tp[i - 1], tp[i], e]);
    }
    const masks = [...document.querySelectorAll('svg rect, svg circle')].filter((e) => {
      const fill = (e.getAttribute('fill') || '').toLowerCase();
      return e.tagName === 'circle' || (['white', '#fff', '#ffffff'].includes(fill) && (!e.getAttribute('stroke') || e.getAttribute('stroke') === 'none'));
    }).map((e) => { const b = e.getBoundingClientRect(); return { e, x: b.x - root.x, y: b.y - root.y, w: b.width, h: b.height }; });
    const crossed = [];
    texts.forEach((t, k) => {
      const x0 = t.x + 2, x1 = t.x + t.w - 2, y0 = t.y + t.h * 0.25, y1 = t.y + t.h * 0.75;
      const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
      const covered = (seg) => masks.some((mk) => cx >= mk.x && cx <= mk.x + mk.w && cy >= mk.y && cy <= mk.y + mk.h
        && (seg[2].compareDocumentPosition(mk.e) & Node.DOCUMENT_POSITION_FOLLOWING));
      const hit = segs.some((seg) => {
        const [[ax, ay], [bx, by]] = seg;
        if (covered(seg)) return false;
        if (Math.abs(ay - by) < 0.5) return ay > y0 && ay < y1 && Math.max(ax, bx) > x0 && Math.min(ax, bx) < x1;
        if (Math.abs(ax - bx) < 0.5) return ax > x0 && ax < x1 && Math.max(ay, by) > y0 && Math.min(ay, by) < y1;
        return false;
      });
      if (hit) crossed.push(`「${t.t.slice(0, 24)}」を線が横切っている`);
    });
    // AIっぽさ：小さすぎる文字（16px未満）・大きな数字を3つ以上並べる・01/02 の通し番号
    const fs_ = (e) => parseFloat(getComputedStyle(e).fontSize) || 0;
    const allText = [...document.querySelectorAll('svg text, svg tspan')].filter((e) => e.textContent.trim());
    const small = [...new Set(allText.filter((e) => e.tagName === 'text' && fs_(e) < 16 && e.getBoundingClientRect().width > 0).map((e) => e.textContent.trim().slice(0, 16)))];
    const bigNums = allText.filter((e) => fs_(e) >= 40 && /\d/.test(e.textContent) && !e.querySelector('tspan')).length;
    const serial = allText.filter((e) => /^0[1-9]$/.test(e.textContent.trim())).length;
    return { outside, overlaps, boxed, crossed, small, bigNums, serial };
}

export function checkWriting(phrases) {
  const res = [];
  const titles = new Map();
  // 読点の決まり（docs/japanese-rules.md）。短い主語・目的語・主題のすぐあと、1文に2つ以上は1件ずつ warn。
  // 長い主語や目的語のあとの読点は作例にもあるので1件ずつは出さず、リードの1割以上に出たら資料に1件だけ warn
  const SHORT_TOPIC = /^[^、]{1,14}?(のは|では|には|だけは|後も|ごとに|は|が|を|も)、/;
  const NOUN_TOPIC = /[一-鿿゠-ヿA-Za-z0-9）」』)](が|を|は|も)、/;
  const sentencesOf = (text) => text.split(/[。！？!?]/).map((s) => s.trim()).filter(Boolean);
  const commaIssues = (page, sent, where) => {
    const out = [];
    const m = sent.match(SHORT_TOPIC);
    if (m && !/(場合|とき|ため)は、$/.test(m[0])) out.push({ page, type: 'ai-comma', level: 'warn', msg: `${where}主語・目的語の直後の読点「${sent.slice(0, m[0].length + 6)}…」` });
    if ((sent.match(/、/g) || []).length >= 2) out.push({ page, type: 'ai-comma', level: 'warn', msg: `${where}1文に読点が2つ以上「${sent.slice(0, 24)}…」` });
    return out;
  };
  let leadSentences = 0;
  const longTopic = [];
  document.querySelectorAll('section[id]').forEach((sec, i) => {
    // 表紙と裏表紙の名前が雛形のまま
    if (/\b(cover|closing)\b/.test(sec.className) && /Your Name|\{\{/.test(sec.querySelector('.who')?.textContent || '')) res.push({ page: i + 1, type: 'placeholder', level: 'warn', msg: '表紙・裏表紙の名前が「Your Name」や {{…}} のまま。発表者の名前に替える（slides new --author でも入る）' });
    if (/\b(cover|closing)\b/.test(sec.className)) return;
    const allLead = sec.querySelector(':scope > p.lead')?.textContent.trim() || '';
    for (const sent of sentencesOf(allLead)) {
      leadSentences++;
      const m = sent.match(NOUN_TOPIC);
      if (m && !SHORT_TOPIC.test(sent) && !/(場合|時|際)は、/.test(sent.slice(Math.max(0, m.index - 1), m.index + 3))) longTopic.push({ page: i + 1, text: sent.slice(0, m.index + 3) });
    }
  });
  if (longTopic.length >= 2 && longTopic.length / Math.max(1, leadSentences) >= 0.1) {
    res.push({ page: longTopic[0].page, type: 'ai-comma', level: 'warn', msg: `リードの読点が多い。主語・目的語のあとに読点を打った文が${leadSentences}文中${longTopic.length}文（${longTopic.slice(0, 4).map((x) => `P.${x.page}「…${x.text.slice(-12)}」`).join('、')}）。語順を変えるか文を分けて読点を取る` });
  }
  document.querySelectorAll('section[id]').forEach((sec, i) => {
    const h1 = sec.querySelector(':scope > h1');
    const cls = sec.className;
    if (!h1 || /\b(closing|divider|cover)\b/.test(cls)) return;
    const t = h1.textContent.trim();
    if (!t) return;
    if (titles.has(t)) res.push({ page: i + 1, type: 'title-duplicate', level: 'info', msg: `P.${titles.get(t)} と同じタイトル「${t}」` });
    else titles.set(t, i + 1);
    if (sec.querySelector('.blocks.is-visual') && !sec.querySelector(':scope > p.lead') && !/\bfull\b/.test(cls)) res.push({ page: i + 1, type: 'figure-no-lead', level: 'info', msg: `図のページにリードがない「${t}」` });
    // AIっぽさ：見出しの読点、主語・目的語と述語の間の読点、決まり文句
    if (t.includes('、')) res.push({ page: i + 1, type: 'ai-comma', level: 'warn', msg: `タイトルに読点「${t}」` });
    const lead = sec.querySelector(':scope > p.lead')?.textContent.trim() || '';
    for (const sent of lead.split('。').filter(Boolean)) res.push(...commaIssues(i + 1, sent, ''));
    // 箇条書きと表のセルも同じ決まりで見る（コードと図の中は除く）
    const inBody = (e) => !e.closest('pre, code, section svg, footer, header');
    for (const [sel, where] of [['li', '箇条書きの'], ['td, th', '表の']]) {
      for (const e of [...sec.querySelectorAll(sel)].filter(inBody)) {
        const own = e.cloneNode(true);
        own.querySelectorAll('ul, ol, pre, code').forEach((x) => x.remove());
        for (const sent of sentencesOf(own.textContent.replace(/\s+/g, ' '))) res.push(...commaIssues(i + 1, sent, where));
      }
    }
    // 本文（コード・図の中は除く）を、使わない言葉の一覧（phrases.json）に当てる
    const clone = sec.cloneNode(true);
    clone.querySelectorAll('pre, code, svg, img, footer, header').forEach((x) => x.remove());
    const text = clone.textContent;
    const seen = new Set();
    for (const p of phrases) {
      const m = text.match(new RegExp(p.pattern));
      if (!m || seen.has(m[0])) continue;
      seen.add(m[0]);
      const at = Math.max(0, m.index - 8);
      res.push({ page: i + 1, type: 'ai-phrase', level: 'warn', msg: `使わない言葉「${m[0]}」（…${text.slice(at, m.index + m[0].length + 8).replace(/\s+/g, ' ')}…）→ ${p.say}` });
    }
  });
  // AIっぽさ：同じ形のページ（2文のリード＋図）が4枚以上続く
  let run = 0;
  document.querySelectorAll('section[id]').forEach((sec, i) => {
    const lead = sec.querySelector(':scope > p.lead');
    const same = lead && lead.querySelector('br') && sec.querySelector('.blocks.is-visual') && !sec.querySelector('.blocks > ul');
    run = same ? run + 1 : 0;
    if (run === 4) res.push({ page: i + 1, type: 'ai-monotone', level: 'info', msg: '2文のリード＋図のページが4枚続いている。文章・表・箇条書きのページを混ぜる' });
  });
  return res;
}

// 図の SVG の中で実際に描いた範囲（viewBox の座標）。図いっぱいの背景の矩形と defs は数えない
export function inkBox() {
  const root = document.querySelector('body > svg');
  if (!root) return null;
  const vb = root.viewBox.baseVal;
  const toRoot = root.getCTM().inverse();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of root.querySelectorAll('rect, path, text, circle, ellipse, line, polyline, polygon, image, use, svg')) {
    if (e.closest('defs, marker, clipPath, mask')) continue;
    if (e.parentNode !== root && e.parentNode.closest('svg') !== root) continue;   // 入れ子の公式アイコンは外枠だけ数える
    if (e.tagName === 'rect' && e.parentNode === root && Math.abs(e.width.baseVal.value - vb.width) < 1 && Math.abs(e.height.baseVal.value - vb.height) < 1) continue;
    let bb;
    try { bb = e.getBBox(); } catch { continue; }
    if (!bb.width && !bb.height) continue;
    const m = toRoot.multiply(e.getCTM());
    for (const [x, y] of [[bb.x, bb.y], [bb.x + bb.width, bb.y + bb.height]]) {
      const q = new DOMPoint(x, y).matrixTransform(m);
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export function svgFindings(r, src, pages) {
  const issues = [];
  for (const t of r.outside) issues.push({ page: pages[0], type: 'svg-text-outside', level: 'error', msg: `${src}: 「${t}」がviewBoxの外` });
  for (const t of r.overlaps) issues.push({ page: pages[0], type: 'svg-text-overlap', level: 'warn', msg: `${src}: ${t}` });
  for (const t of r.boxed) issues.push({ page: pages[0], type: 'svg-text-box', level: 'warn', msg: `${src}: ${t}` });
  for (const t of r.crossed) issues.push({ page: pages[0], type: 'svg-text-line', level: 'warn', msg: `${src}: ${t}` });
  if (r.small.length) issues.push({ page: pages[0], type: 'svg-text-small', level: 'warn', msg: `${src}: 16px未満の文字 ${r.small.length}件（${r.small.slice(0, 3).join('・')}…）` });
  if (r.bigNums >= 3) issues.push({ page: pages[0], type: 'ai-three-numbers', level: 'warn', msg: `${src}: 大きな数字が${r.bigNums}つ並んでいる。根拠のある数字に絞る` });
  if (r.serial >= 2) issues.push({ page: pages[0], type: 'ai-serial', level: 'warn', msg: `${src}: 01・02 の通し番号。番号をやめるか流れで見せる` });
  return issues;
}
