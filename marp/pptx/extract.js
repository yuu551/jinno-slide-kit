// ブラウザの中で動く。Marpが描いた各ページ（section）を、PowerPoint の部品の列（scene）に分解する。
// 座標はすべてページ左上からの px（1280×720）。重なりの順は DOM の順（描かれる順）に従う。
//   shape  図形（四角・角丸・楕円・自由な線）。塗り・線・影
//   text   テキストボックス。ブラウザで折り返した位置で改行を入れる
//   image  画像（PNG・JPEG）。切り抜き・角丸
//   table  表（PowerPoint の表）
//   group  まとまり（SVGの図1枚など）
//   raster 置き換えられない背景（繰り返しのグラデーションなど）。node 側で撮って画像にする
(() => {
  const EPS = 0.01;
  const SKIP_SVG = new Set(['defs', 'marker', 'clippath', 'mask', 'symbol', 'lineargradient', 'radialgradient', 'pattern', 'title', 'desc', 'style', 'metadata', 'script', 'filter']);

  // ---------- 色・数値 ----------
  const ctx2d = document.createElement('canvas').getContext('2d');
  function color(c) {
    if (!c || c === 'none' || c === 'transparent') return null;
    // color-mix() の計算結果は color(srgb r g b / a) の形（0〜1）
    const cm = c.match(/^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([-\d.e]+%?))?\)$/);
    if (cm) {
      const a = cm[4] === undefined ? 1 : cm[4].endsWith('%') ? parseFloat(cm[4]) / 100 : Number(cm[4]);
      if (a <= 0.002) return null;
      return { color: [cm[1], cm[2], cm[3]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255))).toString(16).padStart(2, '0')).join(''), alpha: a };
    }
    if (/^(oklab|oklch|lab|lch|color)\(/.test(c)) {
      // そのほかの色空間は、1px の canvas に塗って読む
      const cv = document.createElement('canvas'); cv.width = cv.height = 1;
      const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = x.getImageData(0, 0, 1, 1).data;
      if (a === 0) return null;
      return { color: [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''), alpha: a / 255 };
    }
    let m = c.match(/^rgba?\(([^)]+)\)$/);
    if (!m) {
      // color-mix() や名前の色は canvas に解決させる
      ctx2d.fillStyle = '#000'; ctx2d.fillStyle = c;
      const v = ctx2d.fillStyle;
      if (v.startsWith('#')) return { color: v.slice(1).toLowerCase(), alpha: 1 };
      m = v.match(/^rgba?\(([^)]+)\)$/);
      if (!m) return null;
    }
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const [r, g, b] = parts.slice(0, 3).map(Number);
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3]);
    if (a <= 0.002) return null;
    return { color: [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''), alpha: a };
  }
  const withAlpha = (c, a) => (c ? { color: c.color, alpha: c.alpha * a } : null);
  const px = (v) => parseFloat(v) || 0;
  const splitTop = (s) => {
    // 括弧の外のカンマで分ける
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  // ---------- 行列 ----------
  const I = () => new DOMMatrix();
  const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const scaleOf = (m) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const axisAligned = (m) => Math.abs(m.b) < EPS && Math.abs(m.c) < EPS;
  // 回転と拡大だけ（傾きなし）なら、PowerPoint の「回転した箱」で表せる
  function frameOf(m, w, h) {
    const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
    if (Math.abs(m.a * m.c + m.b * m.d) > EPS * sx * sy) return null; // 傾きがある
    const det = m.a * m.d - m.b * m.c;
    let rot = Math.atan2(m.b, m.a) * 180 / Math.PI;
    const flipV = det < 0;
    const c = apply(m, w / 2, h / 2);
    const W = w * sx, H = h * sy;
    rot = ((rot % 360) + 360) % 360;
    if (Math.abs(rot - 360) < 0.01) rot = 0;
    return { x: c.x - W / 2, y: c.y - H / 2, w: W, h: H, rot, flipV };
  }

  // ---------- 形のパス ----------
  // コマンドは絶対座標の M L C Z だけにそろえる
  function rectPath(x, y, w, h, radii) {
    // radii: [[rx,ry] 左上, 右上, 右下, 左下]
    const k = 0.5522847498;
    const [tl, tr, br, bl] = radii || [[0, 0], [0, 0], [0, 0], [0, 0]];
    const p = [];
    p.push({ c: 'M', x: x + tl[0], y });
    p.push({ c: 'L', x: x + w - tr[0], y });
    if (tr[0] || tr[1]) p.push({ c: 'C', x1: x + w - tr[0] + tr[0] * k, y1: y, x2: x + w, y2: y + tr[1] - tr[1] * k, x: x + w, y: y + tr[1] });
    p.push({ c: 'L', x: x + w, y: y + h - br[1] });
    if (br[0] || br[1]) p.push({ c: 'C', x1: x + w, y1: y + h - br[1] + br[1] * k, x2: x + w - br[0] + br[0] * k, y2: y + h, x: x + w - br[0], y: y + h });
    p.push({ c: 'L', x: x + bl[0], y: y + h });
    if (bl[0] || bl[1]) p.push({ c: 'C', x1: x + bl[0] - bl[0] * k, y1: y + h, x2: x, y2: y + h - bl[1] + bl[1] * k, x, y: y + h - bl[1] });
    p.push({ c: 'L', x, y: y + tl[1] });
    if (tl[0] || tl[1]) p.push({ c: 'C', x1: x, y1: y + tl[1] - tl[1] * k, x2: x + tl[0] - tl[0] * k, y2: y, x: x + tl[0], y });
    p.push({ c: 'Z' });
    return p;
  }
  function ellipsePath(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return [
      { c: 'M', x: cx + rx, y: cy },
      { c: 'C', x1: cx + rx, y1: cy + ry * k, x2: cx + rx * k, y2: cy + ry, x: cx, y: cy + ry },
      { c: 'C', x1: cx - rx * k, y1: cy + ry, x2: cx - rx, y2: cy + ry * k, x: cx - rx, y: cy },
      { c: 'C', x1: cx - rx, y1: cy - ry * k, x2: cx - rx * k, y2: cy - ry, x: cx, y: cy - ry },
      { c: 'C', x1: cx + rx * k, y1: cy - ry, x2: cx + rx, y2: cy - ry * k, x: cx + rx, y: cy },
      { c: 'Z' },
    ];
  }
  const polyPath = (pts, close = true) => [...pts.map((p, i) => ({ c: i ? 'L' : 'M', x: p.x, y: p.y })), ...(close ? [{ c: 'Z' }] : [])];
  const mapPath = (path, m) => path.map((s) => {
    if (s.c === 'Z') return s;
    const p = apply(m, s.x, s.y);
    if (s.c !== 'C') return { c: s.c, x: p.x, y: p.y };
    const a = apply(m, s.x1, s.y1), b = apply(m, s.x2, s.y2);
    return { c: 'C', x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: p.x, y: p.y };
  });

  // SVG の d を M L C Z に直す（相対・H V S Q T A を展開）
  function parseD(d) {
    const toks = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) || [];
    const out = [];
    let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lc = null, lq = null;
    const num = () => Number(toks[i++]);
    const isNum = () => i < toks.length && !/^[a-z]$/i.test(toks[i]);
    while (i < toks.length) {
      if (/^[a-z]$/i.test(toks[i])) cmd = toks[i++];
      else if (!cmd) break;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === 'Z') { out.push({ c: 'Z' }); x = sx; y = sy; lc = lq = null; if (!isNum()) continue; }
      if (!isNum() && C !== 'Z') { cmd = ''; continue; }
      if (C === 'M') {
        x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); sx = x; sy = y;
        out.push({ c: 'M', x, y }); cmd = rel ? 'l' : 'L'; lc = lq = null;
      } else if (C === 'L') { x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); out.push({ c: 'L', x, y }); lc = lq = null; }
      else if (C === 'H') { x = (rel ? x : 0) + num(); out.push({ c: 'L', x, y }); lc = lq = null; }
      else if (C === 'V') { y = (rel ? y : 0) + num(); out.push({ c: 'L', x, y }); lc = lq = null; }
      else if (C === 'C' || C === 'S') {
        let x1, y1;
        if (C === 'C') { x1 = (rel ? x : 0) + num(); y1 = (rel ? y : 0) + num(); }
        else { x1 = lc ? 2 * x - lc.x : x; y1 = lc ? 2 * y - lc.y : y; }
        const x2 = (rel ? x : 0) + num(), y2 = (rel ? y : 0) + num();
        const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
        out.push({ c: 'C', x1, y1, x2, y2, x: nx, y: ny }); lc = { x: x2, y: y2 }; lq = null; x = nx; y = ny;
      } else if (C === 'Q' || C === 'T') {
        let qx, qy;
        if (C === 'Q') { qx = (rel ? x : 0) + num(); qy = (rel ? y : 0) + num(); }
        else { qx = lq ? 2 * x - lq.x : x; qy = lq ? 2 * y - lq.y : y; }
        const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
        out.push({ c: 'C', x1: x + 2 / 3 * (qx - x), y1: y + 2 / 3 * (qy - y), x2: nx + 2 / 3 * (qx - nx), y2: ny + 2 / 3 * (qy - ny), x: nx, y: ny });
        lq = { x: qx, y: qy }; lc = null; x = nx; y = ny;
      } else if (C === 'A') {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
        for (const seg of arcToCubic(x, y, rx, ry, rot, large, sweep, nx, ny)) out.push(seg);
        x = nx; y = ny; lc = lq = null;
      } else { i++; }
    }
    return out;
  }
  function arcToCubic(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
    if (!rx || !ry) return [{ c: 'L', x: x2, y: y2 }];
    rx = Math.abs(rx); ry = Math.abs(ry);
    const r = phi * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
    let lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const sign = fa === fs ? -1 : 1;
    const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const coef = sign * Math.sqrt(Math.max(0, num / (rx * rx * yp * yp + ry * ry * xp * xp)));
    const cxp = coef * (rx * yp) / ry, cyp = coef * -(ry * xp) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
    let t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI;
    if (fs && dt < 0) dt += 2 * Math.PI;
    const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
    const segs = [];
    const d = dt / n, k = 4 / 3 * Math.tan(d / 4);
    for (let i = 0; i < n; i++) {
      const a1 = t1 + i * d, a2 = a1 + d;
      const p = (a) => ({ x: cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, y: cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos });
      const dp = (a) => ({ x: -rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, y: -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos });
      const P1 = p(a1), P2 = p(a2), D1 = dp(a1), D2 = dp(a2);
      segs.push({ c: 'C', x1: P1.x + k * D1.x, y1: P1.y + k * D1.y, x2: P2.x - k * D2.x, y2: P2.y - k * D2.y, x: P2.x, y: P2.y });
    }
    return segs;
  }

  // ---------- 状態 ----------
  let base = null;     // いまのページの左上（client 座標）
  let items = null;    // いまのまとまりの部品の列
  let rasterSeq = 0;
  const rel = (r) => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
  const pageMatrix = () => new DOMMatrix([1, 0, 0, 1, -base.left, -base.top]);
  const push = (it) => { items.push(it); return it; };

  // ---------- 疑似要素・リストの印を本物の要素にする ----------
  const STYLE_ID = 'pptx-pseudo-off';
  function counterValue(el, name) {
    // 兄弟のうち同じカウンターを増やす要素の何番目か（入れ子の reset は親でかかる前提）
    let n = 0;
    const parent = el.parentElement;
    if (!parent) return 1;
    for (const sib of parent.children) {
      const inc = getComputedStyle(sib).counterIncrement || '';
      if (new RegExp(`(^|\\s)${name}(\\s|$)`).test(inc)) n++;
      if (sib === el) break;
    }
    return n || 1;
  }
  function cssContent(el, value) {
    if (!value || value === 'none' || value === 'normal') return null;
    let out = '', i = 0, any = false;
    const s = value;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        let j = i + 1, str = '';
        while (j < s.length && s[j] !== ch) {
          if (s[j] === '\\') {
            const hexm = s.slice(j + 1).match(/^[0-9a-fA-F]{1,6}\s?/);
            if (hexm) { str += String.fromCodePoint(parseInt(hexm[0], 16)); j += 1 + hexm[0].length; continue; }
            str += s[j + 1]; j += 2; continue;
          }
          str += s[j++];
        }
        out += str; i = j + 1; any = true;
      } else if (s.startsWith('counter(', i)) {
        const j = s.indexOf(')', i);
        const [name, style] = s.slice(i + 8, j).split(',').map((x) => x.trim());
        const n = counterValue(el, name);
        out += style === 'decimal-leading-zero' ? String(n).padStart(2, '0') : style === 'upper-alpha' ? String.fromCharCode(64 + n) : style === 'lower-alpha' ? String.fromCharCode(96 + n) : String(n);
        i = j + 1; any = true;
      } else if (s.startsWith('attr(', i)) {
        const j = s.indexOf(')', i);
        out += el.getAttribute(s.slice(i + 5, j).trim()) || ''; i = j + 1; any = true;
      } else if (s.startsWith('url(', i)) {
        const j = s.indexOf(')', i); i = j + 1; any = true; // 画像の content は背景として扱う（まれ）
      } else i++;
    }
    return any ? out : null;
  }
  function materialize(sec) {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = '.pptx-nb::before{content:none!important}.pptx-na::after{content:none!important}.pptx-nm{list-style-type:none!important}.pptx-nm::marker{content:none!important}';
      document.head.appendChild(st);
    }
    const els = [sec, ...sec.querySelectorAll('*')].filter((el) => !(el instanceof SVGElement));
    const jobs = [];
    for (const el of els) {
      for (const pseudo of ['::before', '::after']) {
        const pcs = getComputedStyle(el, pseudo);
        const text = cssContent(el, pcs.content);
        if (text === null) continue;
        if (pcs.display === 'none') continue;
        const props = {};
        for (let k = 0; k < pcs.length; k++) { const p = pcs[k]; props[p] = pcs.getPropertyValue(p); }
        jobs.push({ el, pseudo, text, props });
      }
      // ::marker（list-style の点・番号）
      const cs = getComputedStyle(el);
      if (cs.display === 'list-item' && cs.listStyleType !== 'none' && cs.listStyleImage === 'none') {
        const mcs = getComputedStyle(el, '::marker');
        const idx = [...el.parentElement.children].filter((c) => c.tagName === el.tagName).indexOf(el) + (Number(el.parentElement.getAttribute('start')) || 1);
        const t = cs.listStyleType;
        const text = t === 'disc' ? '•' : t === 'circle' ? '◦' : t === 'square' ? '▪' : t === 'decimal' ? `${idx}.` : t === 'decimal-leading-zero' ? `${String(idx).padStart(2, '0')}.` : t === 'lower-alpha' || t === 'lower-latin' ? `${String.fromCharCode(96 + idx)}.` : t === 'upper-alpha' || t === 'upper-latin' ? `${String.fromCharCode(64 + idx)}.` : '•';
        jobs.push({ el, marker: true, text, props: { color: mcs.color, 'font-size': mcs.fontSize, 'font-weight': mcs.fontWeight, 'font-family': mcs.fontFamily }, outside: cs.listStylePosition !== 'inside' });
      }
    }
    for (const j of jobs) {
      const span = document.createElement('span');
      span.dataset.pptxPseudo = j.marker ? 'marker' : j.pseudo;
      span.textContent = j.text;
      if (j.marker) {
        // 外側の印は、行頭の左へ（ブラウザの既定：印の幅＋空白ぶん左）
        span.style.cssText = `color:${j.props.color};font-size:${j.props['font-size']};font-weight:${j.props['font-weight']};font-family:${j.props['font-family']};` + (j.outside ? 'position:absolute;transform:translateX(calc(-100% - 0.5em));' : 'margin-right:0.5em;');
        j.el.classList.add('pptx-nm');
        if (j.outside && getComputedStyle(j.el).position === 'static') j.el.style.position = 'relative';
        // 印は行の頭に置きたいので、最初の子として入れる
        j.el.insertBefore(span, j.el.firstChild);
        continue;
      }
      for (const [k, v] of Object.entries(j.props)) {
        if (k === 'content' || k.startsWith('--')) continue;
        span.style.setProperty(k, v);
      }
      if (j.pseudo === '::before') { j.el.insertBefore(span, j.el.firstChild); j.el.classList.add('pptx-nb'); }
      else { j.el.appendChild(span); j.el.classList.add('pptx-na'); }
    }
  }

  // ---------- 箱の幾何 ----------
  // 要素の border-box を、ページ座標への行列と大きさで返す（transform も含める）
  function boxGeometry(el, cs) {
    const hasT = (cs.transform && cs.transform !== 'none') || (cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none') || (cs.translate && cs.translate !== 'none');
    if (!hasT) {
      const r = el.getBoundingClientRect();
      return { m: new DOMMatrix([1, 0, 0, 1, r.left - base.left, r.top - base.top]), w: r.width, h: r.height };
    }
    const save = el.style.cssText;
    el.style.setProperty('transform', 'none', 'important');
    el.style.setProperty('rotate', 'none', 'important');
    el.style.setProperty('scale', 'none', 'important');
    el.style.setProperty('translate', 'none', 'important');
    const r = el.getBoundingClientRect();
    el.style.cssText = save;
    const [ox, oy] = cs.transformOrigin.split(' ').map(px);
    let t = new DOMMatrix([1, 0, 0, 1, r.left - base.left, r.top - base.top]).translate(ox, oy);
    if (cs.translate && cs.translate !== 'none') { const [a, b = '0'] = cs.translate.split(' '); t = t.translate(px(a), px(b)); }
    if (cs.rotate && cs.rotate !== 'none') t = t.rotate(parseFloat(cs.rotate));
    if (cs.scale && cs.scale !== 'none') { const [a, b = a] = cs.scale.split(' ').map(Number); t = t.scale(a, b); }
    if (cs.transform && cs.transform !== 'none') t = t.multiply(new DOMMatrix(cs.transform));
    t = t.translate(-ox, -oy);
    // 要素の大きさ（transform 前）は offsetWidth 相当
    return { m: t, w: el.offsetWidth || r.width, h: el.offsetHeight || r.height };
  }
  function radiiOf(cs, w, h) {
    const corner = (v) => { const [a, b = a] = v.split(' '); const f = (s, L) => s.endsWith('%') ? parseFloat(s) / 100 * L : px(s); return [f(a, w), f(b, h)]; };
    const r = [corner(cs.borderTopLeftRadius), corner(cs.borderTopRightRadius), corner(cs.borderBottomRightRadius), corner(cs.borderBottomLeftRadius)];
    // 辺の長さを超える分は縮める（CSSの決まり）
    const f = Math.min(1, w / (r[0][0] + r[1][0] || 1), w / (r[3][0] + r[2][0] || 1), h / (r[0][1] + r[3][1] || 1), h / (r[1][1] + r[2][1] || 1));
    return r.map(([a, b]) => [a * f, b * f]);
  }
  const noRadius = (r) => r.every(([a, b]) => a < 0.5 && b < 0.5);

  // 箱の形の部品を作る（axis-aligned なら preset、回転なら回転つき preset、それ以外はパス）
  function boxShape(m, x, y, w, h, radii, fill, line, extra = {}) {
    if (w <= 0.01 && h <= 0.01) return null;
    const local = new DOMMatrix([1, 0, 0, 1, x, y]);
    const mm = m.multiply(local);
    const fr = frameOf(mm, w, h);
    const sameR = radii && radii.every(([a, b]) => Math.abs(a - radii[0][0]) < 0.5 && Math.abs(b - radii[0][0]) < 0.5);
    const ellipse = radii && radii.every(([a, b]) => Math.abs(a - w / 2) < 0.5 && Math.abs(b - h / 2) < 0.5);
    if (fr) {
      let geom = 'rect', adj;
      if (radii && !noRadius(radii)) {
        if (ellipse) geom = 'ellipse';
        else if (sameR) { geom = 'roundRect'; adj = Math.min(50000, Math.round(radii[0][0] / Math.min(w, h) * 100000)); }
        else geom = null;
      }
      if (geom) return { k: 'shape', geom, adj, ...fr, w: fr.w, h: fr.h, fill, line, ...extra };
    }
    const path = mapPath(rectPath(0, 0, w, h, radii && !noRadius(radii) ? radii : null), mm);
    return { k: 'shape', geom: 'path', path, fill, line, ...extra };
  }

  function parseShadows(v) {
    if (!v || v === 'none') return [];
    return splitTop(v).map((s) => {
      const inset = /\binset\b/.test(s);
      const col = s.match(/rgba?\([^)]+\)|color\([^)]+\)|#[0-9a-f]{3,8}|color-mix\(.+\)/i)?.[0];
      const nums = s.replace(col || '', '').replace('inset', '').trim().split(/\s+/).map(px);
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      return { inset, x, y, blur, spread, color: color(col || 'rgba(0,0,0,0.5)') };
    }).filter((s) => s.color);
  }

  // ---------- 背景の画像のおき方 ----------
  async function placeBgLayer(url, cs, idx, bx, by, bw, bh, natOverride = null) {
    const nat = natOverride || await naturalSize(url);
    const sizes = splitTop(cs.backgroundSize), poss = splitTop(cs.backgroundPosition);
    const size = (sizes[idx] || sizes[0] || 'auto').trim();
    const pos = (poss[idx] || poss[0] || '0% 0%').trim();
    let w = nat.w, h = nat.h;
    const ratio = nat.w && nat.h ? nat.w / nat.h : 1;
    if (size === 'cover' || size === 'contain') {
      const s = size === 'cover' ? Math.max(bw / nat.w, bh / nat.h) : Math.min(bw / nat.w, bh / nat.h);
      w = nat.w * s; h = nat.h * s;
    } else if (size !== 'auto' && size !== 'auto auto') {
      const [a, b = 'auto'] = size.split(/\s+/);
      const f = (s, L) => s.endsWith('%') ? parseFloat(s) / 100 * L : px(s);
      if (a !== 'auto') w = f(a, bw);
      if (b !== 'auto') h = f(b, bh);
      if (a === 'auto' && b !== 'auto') w = h * ratio;
      if (b === 'auto' && a !== 'auto') h = w / ratio;
    }
    // 位置は calc() や「right 34px」も来るので、ブラウザに解かせる（空きの幅を親にした left / top）
    const x = bx + resolveLen(cs.backgroundPositionX ? splitTop(cs.backgroundPositionX)[idx] ?? splitTop(cs.backgroundPositionX)[0] : pos.split(/\s+/)[0], bw - w);
    const y = by + resolveLen(cs.backgroundPositionY ? splitTop(cs.backgroundPositionY)[idx] ?? splitTop(cs.backgroundPositionY)[0] : (pos.split(/\s+/)[1] || '50%'), bh - h);
    return { x, y, w, h };
  }
  let probe = null;
  function resolveLen(v, free) {
    if (!v) return 0;
    v = v.trim();
    if (/^-?[\d.]+px$/.test(v)) return parseFloat(v);
    if (/^-?[\d.]+%$/.test(v)) return parseFloat(v) / 100 * free;
    const kw = { left: '0%', top: '0%', center: '50%', right: '100%', bottom: '100%' };
    // 「right 34px」の形は calc(100% - 34px) に
    const m = v.match(/^(left|right|top|bottom|center)(?:\s+(.+))?$/);
    if (m) v = m[2] ? (m[1] === 'right' || m[1] === 'bottom' ? `calc(100% - ${m[2]})` : m[2]) : kw[m[1]];
    if (!probe) {
      probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:0;top:0;height:0;visibility:hidden';
      probe.appendChild(document.createElement('div'));
      document.body.appendChild(probe);
    }
    // left は空きの幅について一次式なので、幅 0 と 1000 で解いて当てはめる（空きが負のときも使える）
    const c = probe.firstChild;
    c.style.cssText = `position:absolute;left:${v};width:0;height:0`;
    probe.style.width = '0px'; const b0 = parseFloat(getComputedStyle(c).left);
    probe.style.width = '1000px'; const b1 = parseFloat(getComputedStyle(c).left);
    return b0 + (b1 - b0) / 1000 * free;
  }
  const sizeCache = new Map();
  function naturalSize(url) {
    if (sizeCache.has(url)) return sizeCache.get(url);
    const p = new Promise((res) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth || 300, h: im.naturalHeight || 150 }); im.onerror = () => res({ w: 300, h: 150 }); im.src = url; });
    sizeCache.set(url, p);
    return p;
  }
  const urlOf = (s) => s.match(/url\(["']?(.*?)["']?\)$/)?.[1];
  const isSvgUrl = (u) => /^data:image\/svg\+xml/.test(u) || /\.svg(\?|#|$)/i.test(u);
  async function readText(url) {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const meta = url.slice(5, comma), data = url.slice(comma + 1);
      return /;base64/.test(meta) ? new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))) : decodeURIComponent(data);
    }
    return window.pptxReadText(url);
  }

  // ---------- 箱を塗る ----------
  async function paintBox(el, cs, alpha) {
    const { m, w, h } = boxGeometry(el, cs);
    if (w < 0.01 && h < 0.01 && !hasBorder(cs)) return;
    const radii = radiiOf(cs, w, h);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => {
      const st = cs[`border${s}Style`];
      const bw = st === 'none' || st === 'hidden' ? 0 : px(cs[`border${s}Width`]);
      return { w: bw, style: st, color: bw ? withAlpha(color(cs[`border${s}Color`]), alpha) : null };
    });
    // マスク（線画アイコン）：背景の色でマスクの形を塗る
    const mask = cs.webkitMaskImage && cs.webkitMaskImage !== 'none' ? cs.webkitMaskImage : (cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage : null);
    if (mask) {
      const u = urlOf(splitTop(mask)[0]);
      const fill = withAlpha(color(cs.backgroundColor), alpha);
      if (u && isSvgUrl(u) && fill) {
        const msize = (cs.webkitMaskSize || cs.maskSize || 'auto');
        const mpos = (cs.webkitMaskPosition || cs.maskPosition || '0% 0%');
        const fake = { backgroundSize: msize, backgroundPosition: mpos };
        const pl = await placeBgLayer(u, fake, 0, 0, 0, w, h);
        await svgFromUrl(u, m.multiply(new DOMMatrix([1, 0, 0, 1, pl.x, pl.y])), pl.w, pl.h, { override: fill, name: 'icon' });
      } else if (u) {
        push({ k: 'raster', id: markRaster(el, 'mask'), ...boundsOf(m, w, h) });
      }
      return;
    }
    // 影（ぼかしのないものは図形として後ろに置く。ぼかしのあるものは塗りの図形の影にする）
    let shadows = parseShadows(cs.boxShadow).filter((s) => !s.inset);
    // ぼかしもずれもない広がりだけの影（0 0 0 1px など）は、外側の枠線として図形の線にする
    let ring = null;
    const uniform0 = sides.every((s) => s.w > 0 && Math.abs(s.w - sides[0].w) < 0.01 && s.style === sides[0].style);
    if (!uniform0) {
      const r0 = shadows.find((x) => !x.x && !x.y && x.blur < 0.5 && x.spread > 0);
      if (r0) { ring = { ...withAlpha(r0.color, alpha), w: r0.spread }; shadows = shadows.filter((x) => x !== r0); }
    }
    let effect = null;
    for (const s of shadows.slice().reverse()) {
      if (s.blur < 0.5) {
        const r2 = radii.map(([a, b]) => [Math.max(0, a + s.spread), Math.max(0, b + s.spread)]);
        const sh = boxShape(m, s.x - s.spread, s.y - s.spread, w + 2 * s.spread, h + 2 * s.spread, noRadius(radii) ? null : r2, withAlpha(s.color, alpha), null);
        if (sh) push(sh);
      } else if (!effect) effect = { blur: s.blur, x: s.x, y: s.y, color: withAlpha(s.color, alpha) };
    }
    // 背景色と背景画像
    let fill = withAlpha(color(cs.backgroundColor), alpha);
    const layers = cs.backgroundImage && cs.backgroundImage !== 'none' ? splitTop(cs.backgroundImage) : [];
    const imageLayers = [];
    let needRaster = false;
    for (const [i, L] of layers.entries()) {
      if (L.startsWith('url(')) imageLayers.push({ url: urlOf(L), i });
      else if (/^linear-gradient/.test(L)) {
        // グラデーションの層も、大きさ・位置を見て四角として置く（同じ色だけなら単色の四角。罫線や帯に使っている）
        const cols = [...L.matchAll(/rgba?\([^)]+\)|color\([^)]+\)|#[0-9a-f]{3,8}|color-mix\((?:[^()]|\([^)]*\))*\)/gi)].map((x) => color(x[0])).filter(Boolean);
        if (!cols.length) continue;
        const solid = cols.every((c) => c.color === cols[0].color && Math.abs(c.alpha - cols[0].alpha) < 0.01);
        const g = solid ? withAlpha(cols[0], alpha) : (!/repeating/.test(L) ? (() => { const gg = gradientOf(L, alpha); return gg ? { grad: gg } : null; })() : null);
        if (g) imageLayers.push({ fill: g, i });
        else needRaster = true;
      } else if (/^repeating-linear-gradient/.test(L)) {
        // 縦・横の縞（工程表の月の区切りなど）は、細い四角の並びにする
        const st = stripesOf(L, w, h, alpha);
        if (st) imageLayers.push({ stripes: st, i }); else needRaster = true;
      } else if (L !== 'none') needRaster = true;
    }
    const uniform = sides.every((s) => s.w > 0 && Math.abs(s.w - sides[0].w) < 0.01 && s.style === sides[0].style && s.color && sides[0].color && s.color.color === sides[0].color.color && Math.abs(s.color.alpha - sides[0].color.alpha) < 0.01);
    const lineOf = (s) => ({ ...s.color, w: s.w, dash: s.style === 'dashed' ? 'dash' : s.style === 'dotted' ? 'sysDot' : null });
    const bgClip = cs.backgroundClip;
    const inset = bgClip === 'content-box' ? [px(cs.paddingTop) + sides[0].w, px(cs.paddingRight) + sides[1].w, px(cs.paddingBottom) + sides[2].w, px(cs.paddingLeft) + sides[3].w] : bgClip === 'padding-box' ? sides.map((s) => s.w) : [0, 0, 0, 0];
    if (uniform && !needRaster && (inset.every((v) => v === 0) || bgClip === 'padding-box')) {
      const bw = sides[0].w;
      const r2 = radii.map(([a, b]) => [Math.max(0, a - bw / 2), Math.max(0, b - bw / 2)]);
      const sh = boxShape(m, bw / 2, bw / 2, w - bw, h - bw, noRadius(radii) ? null : r2, imageLayers.length ? null : fill, lineOf(sides[0]), effect ? { shadow: effect } : {});
      if (imageLayers.length && fill) { const f = boxShape(m, 0, 0, w, h, noRadius(radii) ? null : radii, fill, null); if (f) push(f); }
      for (const L of imageLayers.reverse()) await bgImage(el, cs, m, L, inset, w, h, alpha, radii);
      if (sh) push(sh);
      return;
    }
    if (ring) {
      const sp = ring.w;
      const r3 = radii.map(([a, b]) => [a + sp / 2, b + sp / 2]);
      const sh = boxShape(m, -sp / 2, -sp / 2, w + sp, h + sp, noRadius(radii) ? null : r3, needRaster ? null : fill, ring, effect ? { shadow: effect } : {});
      if (sh) { sh._ringFor = { w, h }; push(sh); }
      effect = null;
      if (!needRaster) fill = null;
    }
    if (fill && fill !== null) {
      const r2 = radii.map(([a, b], k) => [Math.max(0, a - inset[[3, 1, 1, 3][k]]), Math.max(0, b - inset[[0, 0, 2, 2][k]])]);
      const sh = boxShape(m, inset[3], inset[0], w - inset[1] - inset[3], h - inset[0] - inset[2], noRadius(radii) ? null : r2, fill, null, effect ? { shadow: effect } : {});
      if (sh) push(sh);
      effect = null;
    }
    if (needRaster) push({ k: 'raster', id: markRaster(el, 'bg'), ...boundsOf(m, w, h) });
    for (const L of imageLayers.reverse()) await bgImage(el, cs, m, L, inset, w, h, alpha, radii);
    // 辺ごとの線：台形（隣の辺の太さで斜めに切る）
    const [t, r, b, l] = sides.map((s) => s.w);
    const polys = [
      [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w - r, y: t }, { x: l, y: t }],
      [{ x: w, y: 0 }, { x: w, y: h }, { x: w - r, y: h - b }, { x: w - r, y: t }],
      [{ x: 0, y: h }, { x: w, y: h }, { x: w - r, y: h - b }, { x: l, y: h - b }],
      [{ x: 0, y: 0 }, { x: 0, y: h }, { x: l, y: h - b }, { x: l, y: t }],
    ];
    const lines = [
      [{ x: 0, y: t / 2 }, { x: w, y: t / 2 }], [{ x: w - r / 2, y: 0 }, { x: w - r / 2, y: h }],
      [{ x: 0, y: h - b / 2 }, { x: w, y: h - b / 2 }], [{ x: l / 2, y: 0 }, { x: l / 2, y: h }],
    ];
    sides.forEach((s, k) => {
      if (!s.w || !s.color) return;
      if (s.style === 'dashed' || s.style === 'dotted') {
        push({ k: 'shape', geom: 'path', path: mapPath(polyPath(lines[k], false), m), fill: null, line: lineOf(s) });
        return;
      }
      const poly = polys[k];
      // 隣の辺がなければ長方形になる
      const isRect = (k % 2 === 0 ? (l === 0 && r === 0) : (t === 0 && b === 0));
      if (isRect) {
        const rx = k === 1 ? w - r : 0, ry = k === 2 ? h - b : 0;
        const rw = k % 2 === 0 ? w : s.w, rh = k % 2 === 0 ? s.w : h;
        const sh = boxShape(m, rx, ry, rw, rh, null, s.color, null);
        if (sh) push(sh);
      } else {
        push({ k: 'shape', geom: 'path', path: mapPath(polyPath(poly), m), fill: s.color, line: null });
      }
    });
  }
  const hasBorder = (cs) => ['Top', 'Right', 'Bottom', 'Left'].some((s) => px(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none');
  function boundsOf(m, w, h) {
    const pts = [apply(m, 0, 0), apply(m, w, 0), apply(m, w, h), apply(m, 0, h)];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  function markRaster(el, what) {
    const id = `r${++rasterSeq}`;
    el.dataset.pptxRaster = (el.dataset.pptxRaster ? el.dataset.pptxRaster + ' ' : '') + id;
    el.dataset[`pptxRaster${id}`] = what;
    return id;
  }
  function gradientOf(L, alpha) {
    const inner = L.slice(L.indexOf('(') + 1, L.lastIndexOf(')'));
    const parts = splitTop(inner);
    let angle = 180;
    if (/^(to |[-\d.]+deg|[-\d.]+turn)/.test(parts[0])) {
      const a = parts.shift();
      if (a.endsWith('deg')) angle = parseFloat(a);
      else if (a.endsWith('turn')) angle = parseFloat(a) * 360;
      else angle = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 }[a] ?? 180;
    }
    const stops = parts.map((p, i) => {
      const col = p.match(/rgba?\([^)]+\)|color\([^)]+\)|#[0-9a-f]{3,8}|color-mix\((?:[^()]|\([^)]*\))*\)|[a-z]+/i)?.[0];
      const pos = p.replace(col, '').trim().match(/([-\d.]+)%/);
      return { pos: pos ? parseFloat(pos[1]) / 100 : i / Math.max(1, parts.length - 1), c: withAlpha(color(col), alpha) };
    }).filter((s) => s.c);
    if (stops.length < 2) return null;
    return { angle, stops };
  }
  async function bgImage(el, cs, m, L, inset, w, h, alpha, radii) {
    const bx = inset[3], by = inset[0], bw = w - inset[1] - inset[3], bh = h - inset[0] - inset[2];
    const rep = splitTop(cs.backgroundRepeat)[L.i] || splitTop(cs.backgroundRepeat)[0] || 'repeat';
    if (L.stripes) {
      for (const r of L.stripes) {
        const x0 = Math.max(r.x, bx), y0 = Math.max(r.y, by), x1 = Math.min(r.x + r.w, bx + bw), y1 = Math.min(r.y + r.h, by + bh);
        if (x1 - x0 < 0.05 || y1 - y0 < 0.05) continue;
        const sh = boxShape(m, x0, y0, x1 - x0, y1 - y0, null, r.fill, null);
        if (sh) push(sh);
      }
      return;
    }
    if (L.fill) {
      const pl = await placeBgLayer(null, cs, L.i, bx, by, bw, bh, { w: bw, h: bh });
      if (!/no-repeat/.test(rep) && (pl.w < bw - 1 || pl.h < bh - 1)) { push({ k: 'raster', id: markRaster(el, 'bg'), ...boundsOf(m, w, h) }); return; }
      const x0 = Math.max(pl.x, bx), y0 = Math.max(pl.y, by), x1 = Math.min(pl.x + pl.w, bx + bw), y1 = Math.min(pl.y + pl.h, by + bh);
      if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return;
      const full = x0 <= bx + 0.5 && y0 <= by + 0.5 && x1 >= bx + bw - 0.5 && y1 >= by + bh - 0.5;
      const sh = boxShape(m, x0, y0, x1 - x0, y1 - y0, full && !noRadius(radii) ? radii : null, L.fill, null);
      if (sh) push(sh);
      return;
    }
    if (!L.url) return;
    const pl = await placeBgLayer(L.url, cs, L.i, bx, by, bw, bh);
    const nat = await naturalSize(L.url);
    if (!/no-repeat/.test(rep) && (pl.w < bw - 1 || pl.h < bh - 1)) { push({ k: 'raster', id: markRaster(el, 'bg'), ...boundsOf(m, w, h) }); return; }
    const filt = filterOverride(cs.filter);
    if (isSvgUrl(L.url)) {
      await svgFromUrl(L.url, m.multiply(new DOMMatrix([1, 0, 0, 1, pl.x, pl.y])), pl.w, pl.h, { alpha, override: filt, clip: { x: bx, y: by, w: bw, h: bh }, name: 'background' });
      return;
    }
    // 箱からはみ出す部分は切り抜く
    const cx0 = Math.max(pl.x, bx), cy0 = Math.max(pl.y, by), cx1 = Math.min(pl.x + pl.w, bx + bw), cy1 = Math.min(pl.y + pl.h, by + bh);
    if (cx1 <= cx0 || cy1 <= cy0) return;
    const crop = { l: (cx0 - pl.x) / pl.w, t: (cy0 - pl.y) / pl.h, r: (pl.x + pl.w - cx1) / pl.w, b: (pl.y + pl.h - cy1) / pl.h };
    const fr = frameOf(m.multiply(new DOMMatrix([1, 0, 0, 1, cx0, cy0])), cx1 - cx0, cy1 - cy0);
    if (!fr) { push({ k: 'raster', id: markRaster(el, 'bg'), ...boundsOf(m, w, h) }); return; }
    push({ k: 'image', src: L.url, ...fr, crop, alpha, nat });
  }
  // repeating-linear-gradient の硬い境目だけの縞を、四角の列にする（なめらかな移り変わりがあれば null）
  function stripesOf(L, w, h, alpha) {
    const inner = L.slice(L.indexOf('(') + 1, L.lastIndexOf(')'));
    const parts = splitTop(inner);
    let angle = 180;
    if (/^(to |[-\d.]+deg)/.test(parts[0])) {
      const a = parts.shift();
      angle = a.endsWith('deg') ? parseFloat(a) : { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }[a];
    }
    if (![0, 90, 180, 270].includes(((angle % 360) + 360) % 360)) return null;
    const horiz = angle % 180 === 90; // 90deg：左から右へ（縦の縞）
    const len = horiz ? w : h;
    const stops = [];
    for (const p of parts) {
      const col = p.match(/^(rgba?\([^)]+\)|color\([^)]+\)|#[0-9a-f]{3,8}|[a-z]+)/i)?.[0];
      if (!col) return null;
      const rest = splitTop(p.slice(col.length).trim().replace(/\s+(?![^(]*\))/g, ',')).filter(Boolean);
      const c = withAlpha(color(col), alpha);
      if (!rest.length) return null;
      for (const r of rest) stops.push({ c, pos: resolveLen(r, len) });
    }
    if (stops.length < 2) return null;
    const period = stops[stops.length - 1].pos - stops[0].pos;
    if (period < 1 || len / period > 400) return null;
    const segs = [];
    for (let k = 1; k < stops.length; k++) {
      const a = stops[k - 1], b = stops[k];
      if (b.pos - a.pos < 0.01) continue;
      const same = (!a.c && !b.c) || (a.c && b.c && a.c.color === b.c.color && Math.abs(a.c.alpha - b.c.alpha) < 0.01);
      if (!same) return null;
      if (a.c) segs.push({ from: a.pos - stops[0].pos, to: b.pos - stops[0].pos, fill: a.c });
    }
    const out = [];
    for (let o = stops[0].pos - Math.ceil(stops[0].pos / period) * period; o < len; o += period) {
      for (const sg of segs) {
        const s0 = o + sg.from, s1 = o + sg.to;
        out.push(horiz ? { x: s0, y: 0, w: s1 - s0, h, fill: sg.fill } : { x: 0, y: s0, w, h: s1 - s0, fill: sg.fill });
      }
    }
    return out;
  }
  // brightness(0) は黒に塗りつぶす（ロゴを墨にするのに使っている）
  function filterOverride(f) {
    if (!f || f === 'none') return null;
    if (/brightness\(0\)/.test(f) && !/invert/.test(f)) return { color: '000000', alpha: 1 };
    if (/brightness\(0\).*invert\(1\)/.test(f)) return { color: 'ffffff', alpha: 1 };
    return null;
  }

  // ---------- 文字 ----------
  const isInline = (cs) => cs.display === 'inline' || cs.display === 'contents';
  function fontStyle(host, alpha) {
    const cs = getComputedStyle(host);
    const col = color(cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color && !/transparent/.test(cs.webkitTextFillColor) ? cs.webkitTextFillColor : cs.color);
    if (!col) return null;
    const isSvg = host instanceof SVGElement;
    let size = parseFloat(cs.fontSize);
    if (isSvg) {
      const ctm = host.getScreenCTM();
      if (ctm) size *= scaleOf(ctm);
      const fill = color(cs.fill);
      if (!fill) return null;
      Object.assign(col, fill);
      col.alpha *= Number(cs.fillOpacity || 1);
    }
    let op = 1;
    for (let e = host; e && e !== document.body; e = e.parentElement) { const o = Number(getComputedStyle(e).opacity); if (!isNaN(o)) op *= o; if (e.tagName === 'SECTION') break; }
    const sup = cs.verticalAlign === 'super' ? 30000 : cs.verticalAlign === 'sub' ? -25000 : 0;
    return {
      size,
      bold: Number(cs.fontWeight) >= 600,
      italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
      underline: /underline/.test(cs.textDecorationLine),
      ucolor: /underline/.test(cs.textDecorationLine) ? withAlpha(color(cs.textDecorationColor), 1) : null,
      strike: /line-through/.test(cs.textDecorationLine),
      mono: /mono|courier|consolas|menlo|monaco/i.test(cs.fontFamily),
      latin: latinOf(cs.fontFamily),
      color: col.color,
      alpha: Math.min(1, col.alpha * op * alpha),
      spacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
      href: host.closest('a')?.href || null,
      caps: cs.textTransform,
      baseline: sup,
    };
  }
  // PowerPoint・Googleスライドの両方にある書体に置き換える（英字の書体。和文はいつも Noto Sans JP）
  //   等幅 → Courier New ／ Helvetica・Arial・Inter など欧文の書体が先頭 → Arial ／ それ以外 → Noto Sans JP
  function latinOf(family) {
    if (/mono|courier|consolas|menlo|monaco/i.test(family)) return 'Courier New';
    const first = (family.split(',')[0] || '').replace(/["']/g, '').trim();
    if (/^(helvetica|helvetica neue|arial|inter|sf pro|-apple-system|system-ui|segoe ui|roboto)/i.test(first)) return 'Arial';
    return 'Noto Sans JP';
  }
  const fontCss = (st) => `${st.bold ? 700 : 400} ${st.size}px "${st.latin}", "Noto Sans JP"`;
  const range = document.createRange();
  // 要素の書体のアセント（文字の矩形の上端からベースラインまで）。SVG は画面上の大きさに直す
  const ascCache = new WeakMap();
  function ascentOf(host) {
    if (ascCache.has(host)) return ascCache.get(host);
    const cs = getComputedStyle(host);
    ctx2d.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let a = ctx2d.measureText('Hg日').fontBoundingBoxAscent;
    if (host instanceof SVGElement) { const m = host.getScreenCTM(); if (m) a *= scaleOf(m); }
    ascCache.set(host, a);
    return a;
  }
  // 文字の塊（同じ持ち主のテキストノード）を、行に分けたランにする
  function linesOf(nodes, alpha) {
    const chars = [];
    for (const n of nodes) {
      const st = fontStyle(n.parentElement, alpha);
      if (!st) continue;
      const pre = /^(pre|break-spaces)/.test(getComputedStyle(n.parentElement).whiteSpace);
      let t = n.textContent;
      if (st.caps === 'uppercase') t = t.toUpperCase();
      else if (st.caps === 'lowercase') t = t.toLowerCase();
      for (let i = 0; i < n.textContent.length; i++) {
        const len = n.textContent.codePointAt(i) > 0xffff ? 2 : 1;
        range.setStart(n, i); range.setEnd(n, i + len);
        const nativeRect = window.__pptxCharacterRect?.(n, i, len);
        const rects = (nativeRect ? [nativeRect] : [...range.getClientRects()]).filter((r) => r.width > 0.01 || r.height > 0.01);
        chars.push({ ch: t.slice(i, i + len), st, rect: rects.length ? rects[rects.length - 1] : null, node: n, asc: nativeRect?.baseline == null ? ascentOf(n.parentElement) : nativeRect.baseline-nativeRect.top, pre });
        i += len - 1;
      }
    }
    const lines = [];
    let cur = null;
    for (const c of chars) {
      if (!c.rect) { if (cur) cur.chars.push(c); continue; }
      const mid = c.rect.top + c.rect.height / 2;
      // 前の文字より下に出たら次の行。横書きで左に戻ったときも次の行
      const newline = !cur || mid > cur.bottom + 0.5 || (cur.lastRight !== null && c.rect.right < cur.lastLeft - 2 && mid > cur.top);
      if (newline) { cur = { chars: [], top: c.rect.top, bottom: c.rect.bottom, lastRight: null, lastLeft: null }; lines.push(cur); }
      cur.chars.push(c);
      cur.top = Math.min(cur.top, c.rect.top); cur.bottom = Math.max(cur.bottom, c.rect.bottom);
      cur.lastRight = c.rect.right; cur.lastLeft = c.rect.left;
    }
    const out = [];
    for (const l of lines) {
      const ws = (ch) => /^[ \t\n\r\f]$/.test(ch);
      // 描かれない空白（折り返しで消えたもの・詰められたもの）は落とす
      let cs = l.chars.filter((c, i, a) => !(ws(c.ch) && (!c.rect || c.rect.width < 0.01)) || (ws(c.ch) && i > 0 && i < a.length - 1 && c.rect && c.rect.width > 0.01));
      cs = cs.filter((c) => !(ws(c.ch) && !c.rect));
      // 行頭の空白は落とす（コードなど空白を保つ書き方では、字下げとして残す）
      while (cs.length && ws(cs[0].ch) && !(cs[0].pre && cs[0].ch === ' ' && cs[0].rect)) cs.shift();
      while (cs.length && ws(cs[cs.length - 1].ch)) cs.pop();
      const real = cs.filter((c) => c.rect);
      if (!real.some((c) => /\S/.test(c.ch))) continue;
      for (const c of cs) if (/[\t\n\r\f]/.test(c.ch)) c.ch = ' ';
      // 行の大きさ：主な文字（いちばん大きい字）の矩形
      const maxSize = Math.max(...real.map((c) => c.st.size));
      const main = real.filter((c) => c.st.size === maxSize);
      // 1文字ずつ、PowerPoint の書体（Noto Sans JP）で描いたときの字の位置がブラウザと同じになるよう字間を決める
      // （カッコを詰める palt や、書体の違いを吸収する）。詰めた字は、開きカッコは字の前を、閉じカッコ・句読点は
      // 字の後ろを、ほかは前後を半分ずつ詰めたものとみなす（全角の字形の中での字の位置に合わせる）
      const OPEN = /[「『（［｛〔〈《【〘〖“‘]/, CLOSE = /[」』）］｝〕〉》】〙〗”’、。，．]/;
      const pens = [];
      cs.forEach((c, k) => {
        c.fit = 0;
        if (!c.rect) return;
        ctx2d.font = fontCss(c.st);
        ctx2d.fontKerning = 'none';
        c.advA = ctx2d.measureText(c.ch).width;
        let nx = null;
        for (let j = k + 1; j < cs.length; j++) if (cs[j].rect) { nx = cs[j].rect.left; break; }
        const advB = nx !== null && nx >= c.rect.left ? nx - c.rect.left - c.st.spacing : c.rect.width - c.st.spacing;
        const d = advB - c.advA;
        const shift = d >= -0.3 ? 0 : OPEN.test(c.ch) ? d : CLOSE.test(c.ch) ? 0 : d / 2;
        pens.push({ c, pen: c.rect.left + shift });
      });
      // 英字・数字の続き（単語）は、1字ずつ合わせると字形の違いで字間がばらつくので、頭と終わりだけ合わせて中は均等にする
      const isLatin = (ch) => /[\u0020-\u024f\u2000-\u206f]/.test(ch) && !/[\s]/.test(ch);
      for (let k = 0; k < pens.length;) {
        if (!isLatin(pens[k].c.ch)) { k++; continue; }
        let j = k;
        while (j + 1 < pens.length && isLatin(pens[j + 1].c.ch)) j++;
        if (j > k) {
          // 字と字の間を同じだけ空ける（字の幅に比例させると、w や m の後ろだけ広く見える）
          const start = pens[k].pen, endB = pens[j].c.rect.right - pens[j].c.st.spacing, natural = pens.slice(k, j + 1).reduce((a, p) => a + p.c.advA, 0);
          const delta = (endB - start - natural) / (j - k);
          let acc = 0;
          for (let q = k; q <= j; q++) { pens[q].pen = start + acc + (q - k) * delta; acc += pens[q].c.advA; }
        }
        k = j + 1;
      }
      // 字間（字の後ろの空き。CSS の letter-spacing を含む）を 0.5px 単位で。丸めの残りは次の字へ繰り越す
      // （Googleスライドには字間の機能がなく、この指定は読まれない。PowerPoint では効く）
      const PTPX = 0.5;
      let pos = pens.length ? pens[0].pen : 0;
      for (let k = 0; k < pens.length - 1; k++) {
        const { c } = pens[k];
        const want = pens[k + 1].pen - pos - c.advA;
        const q = Math.max(-0.5 * c.st.size, Math.min(0.5 * c.st.size, Math.round(want / PTPX) * PTPX));
        c.fit = q - c.st.spacing;
        pos += c.advA + q;
      }
      const penLeft = pens.length ? pens[0].pen - base.left : null;
      const lastC = pens.length ? pens[pens.length - 1].c : null;
      const penRight = lastC ? pos + lastC.advA - base.left : null;
      const runs = [];
      for (const c of cs) {
        const last = runs[runs.length - 1];
        const key = JSON.stringify(c.st) + '|' + (c.fit || 0);
        if (last && last.key === key) last.text += c.ch;
        else runs.push({ key, text: c.ch, style: c.st, fit: c.fit || 0 });
      }
      const left = Math.min(...real.map((c) => c.rect.left)), right = Math.max(...real.map((c) => c.rect.right));
      out.push({
        penLeft,
        penRight,
        baseline: Math.max(...main.map((c) => c.rect.top + c.asc)) - base.top,
        top: Math.min(...main.map((c) => c.rect.top)) - base.top,
        bottom: Math.max(...main.map((c) => c.rect.bottom)) - base.top,
        left: Math.min(...real.map((c) => c.rect.left)) - base.left,
        right: Math.max(...real.map((c) => c.rect.right)) - base.left,
        size: maxSize,
        runs: runs.map(({ text, style, fit }) => ({ text, style, fit })),
      });
    }
    return out;
  }
  // 要素が持つ（インラインの子孫を通じた）テキストノード。ブロックの子の中身は含めない
  function ownTextNodes(el) {
    const out = [];
    const visit = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) { if (ch.textContent.length) out.push(ch); continue; }
        if (ch.nodeType !== 1) continue;
        if (ch instanceof SVGElement || ch.tagName === 'IMG' || ch.tagName === 'BR') continue;
        if (ch.dataset.pptxPseudo && node.tagName === 'LI' && node.firstElementChild === ch) continue; // 行頭文字は段落の印で描く
        const cs = getComputedStyle(ch);
        if (cs.display === 'none') continue;
        if (isInline(cs) && cs.position !== 'absolute' && cs.position !== 'fixed' && cs.float === 'none') {
          if (cs.visibility === 'hidden') continue;
          visit(ch);
        }
      }
    };
    visit(el);
    return out;
  }
  // インラインの子孫の背景・枠（コードの地、マーカー）
  function inlineBoxes(el, alpha) {
    const visit = (node) => {
      for (const ch of node.children) {
        if (ch instanceof SVGElement || ch.tagName === 'IMG') continue;
        const cs = getComputedStyle(ch);
        if (!isInline(cs) || cs.position === 'absolute') continue;
        const bg = withAlpha(color(cs.backgroundColor), alpha);
        const bw = px(cs.borderTopWidth), bcol = cs.borderTopStyle !== 'none' && bw ? withAlpha(color(cs.borderTopColor), alpha) : null;
        if (bg || bcol) {
          const rad = px(cs.borderTopLeftRadius);
          for (const r of ch.getClientRects()) {
            if (r.width < 0.5) continue;
            const R = rel(r);
            const line = bcol ? { ...bcol, w: bw } : null;
            const ins = bcol ? bw / 2 : 0;
            const geom = rad > 0.5 ? 'roundRect' : 'rect';
            push({ k: 'shape', geom, adj: rad > 0.5 ? Math.min(50000, Math.round(rad / Math.min(R.w, R.h) * 100000)) : undefined, x: R.x + ins, y: R.y + ins, w: R.w - 2 * ins, h: R.h - 2 * ins, rot: 0, fill: bg, line });
          }
        }
        visit(ch);
      }
    };
    visit(el);
  }
  // 文字の塊を1つの段落にする（行の位置は node 側で箱に合わせて組み直す）
  function paraOf(el, cs, nodes, alpha) {
    const lines = linesOf(nodes, alpha);
    if (!lines.length) return null;
    const lh = cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.45 : px(cs.lineHeight);
    let align = /center/.test(cs.textAlign) ? 'center' : /right|end/.test(cs.textAlign) ? 'right' : 'left';
    if (cs.direction === 'rtl' && cs.textAlign === 'start') align = 'right';
    const p = { align, lh, lines };
    const b = bulletOf(el, alpha);
    if (b) { if (b.shape) pickGlyph(b, lines[0].baseline); p.bullet = b; }
    return p;
  }
  const textItem = (el, cs, nodes, alpha) => { const p = paraOf(el, cs, nodes, alpha); return p ? { k: 'text', paras: [p], name: el.tagName.toLowerCase() } : null; };
  // li の ::before（丸・線・文字）を行頭文字にする
  function bulletSpan(el) {
    const s = el.firstElementChild;
    return s && s.dataset.pptxPseudo && (s.dataset.pptxPseudo === '::before' || s.dataset.pptxPseudo === 'marker') ? s : null;
  }
  function bulletOf(el, alpha) {
    if (el.tagName !== 'LI' && getComputedStyle(el).display !== 'list-item') return null;
    const s = bulletSpan(el);
    if (!s) return null;
    const scs = getComputedStyle(s);
    const r = s.getBoundingClientRect();
    const text = s.textContent.trim();
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (text) {
      // 本文より大きい番号（アジェンダの数字など）は行頭文字にせず、別の文字として置く
      if (parseFloat(scs.fontSize) > fs * 1.02) return null;
      const c = withAlpha(color(scs.color), alpha);
      return c ? { char: text, color: c.color, alpha: c.alpha, size: parseFloat(scs.fontSize), left: r.left - base.left, top: r.top - base.top, w: r.width, h: r.height, mono: /mono/i.test(scs.fontFamily), bold: Number(scs.fontWeight) >= 600, fs } : null;
    }
    const c = withAlpha(color(scs.backgroundColor), alpha);
    if (!c || r.width < 0.5) return null;
    const round = px(scs.borderTopLeftRadius) >= Math.min(r.width, r.height) / 2 - 0.5;
    const shape = round ? 'dot' : r.width > r.height * 2 ? 'dash' : 'square';
    return { shape, color: c.color, alpha: c.alpha, left: r.left - base.left, top: r.top - base.top, w: r.width, h: r.height, fs };
  }

  // 丸・線・四角の行頭文字を、幅と高さ（ベースラインからの中心の高さ）がいちばん近くなる字形と大きさにする
  // ● は Googleスライドで小さく描かれ PowerPoint と大きさが合わないので、丸は • に限る
  // 四角（■）も Googleスライドと PowerPoint で大きさが倍ほど違い、▪・◼ は PowerPoint の Noto Sans JP にないので、• で出す
  const GLYPHS = { dot: ['•'], dash: ['–', '—'], square: ['•'] };
  const inkCache = new Map();
  function inkOf(g) {
    if (inkCache.has(g)) return inkCache.get(g);
    ctx2d.font = '400 100px "Noto Sans JP"';
    const m = ctx2d.measureText(g);
    const v = { w: (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / 100, c: (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 200, h: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 100 };
    inkCache.set(g, v);
    return v;
  }
  function pickGlyph(b, baseline) {
    const want = baseline - (b.top + b.h / 2); // 丸の中心がベースラインからどれだけ上か
    let best = null;
    for (const g of GLYPHS[b.shape]) {
      const k = inkOf(g);
      if (!(k.w > 0.02)) continue;
      // 行頭文字が本文の字より大きいと、Googleスライドは行の高さを広げてしまう
      const F = Math.min(b.w / k.w, b.fs * 0.98);
      const err = Math.abs(k.c * F - want) + Math.abs(k.h * F - b.h) * 0.5;
      if (!best || err < best.err) best = { g, F, err };
    }
    if (best) { b.glyph = best.g; b.glyphSize = best.F; }
  }

  // ---------- 文字だけのまとまり（段落・箇条書き・カード） ----------
  const PAINT_FREE = (cs) => !color(cs.backgroundColor) && (cs.backgroundImage === 'none' || !cs.backgroundImage) && !hasBorder(cs) && (cs.boxShadow === 'none' || !cs.boxShadow) && (!cs.webkitMaskImage || cs.webkitMaskImage === 'none');
  // el の中が「縦に積んだ文字の塊」だけなら、その塊の列を返す。図・画像・塗りのある子があれば null
  function flowOf(el, alpha = 1) {
    const owners = [];
    const deco = []; // 文字のない飾り（区切りの線など）。まとまりとは別に図形として描く
    let ok = true;
    const visit = (node) => {
      for (const ch of node.children) {
        if (!ok) return;
        if (ch instanceof SVGElement || ['IMG', 'TABLE', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT'].includes(ch.tagName)) { ok = false; return; }
        const cs = getComputedStyle(ch);
        if (cs.display === 'none') continue;
        if (ch.dataset.pptxPseudo && bulletSpan(ch.parentElement) === ch && bulletOf(ch.parentElement, 1)) continue; // 行頭文字
        if (!ch.textContent.trim()) {
          if (ch.querySelector('img, svg, table')) { ok = false; return; }
          if (!PAINT_FREE(cs) || ch.children.length) deco.push(ch);
          continue;
        }
        if (cs.transform !== 'none' || Number(cs.opacity) < 1) { ok = false; return; }
        if (isInline(cs)) {
          if (cs.position === 'absolute' || cs.position === 'fixed') { ok = false; return; }
          // インラインの地（コード・マーカー）は段落に入れられないので、まとまりにしない
          if (color(cs.backgroundColor) || hasBorder(cs)) { ok = false; return; }
          visit(ch);
          continue;
        }
        if (cs.position === 'absolute' || cs.position === 'fixed' || cs.visibility === 'hidden') { ok = false; return; }
        if (!PAINT_FREE(cs)) {
          // 線だけ（下線・区切り線）の子は、線を図形として描き、文字はまとまりに入れる
          const onlyBorder = !color(cs.backgroundColor) && (cs.backgroundImage === 'none' || !cs.backgroundImage) && (cs.boxShadow === 'none' || !cs.boxShadow) && (!cs.webkitMaskImage || cs.webkitMaskImage === 'none');
          if (!onlyBorder) { ok = false; return; }
          deco.push(ch);
        }
        const own = ownTextNodes(ch);
        if (own.some((n) => /\S/.test(n.textContent))) owners.push({ el: ch, cs, nodes: own });
        visit(ch);
      }
    };
    const own = ownTextNodes(el);
    if (own.some((n) => /\S/.test(n.textContent))) owners.push({ el, cs: getComputedStyle(el), nodes: own });
    visit(el);
    if (!ok || !owners.length) return null;
    let paras = [];
    for (const o of owners) {
      const p = paraOf(o.el, o.cs, o.nodes, alpha);
      if (p) paras.push(p);
    }
    if (!paras.length) return null;
    paras.sort((a, b) => a.lines[0].top - b.lines[0].top || a.lines[0].left - b.lines[0].left);
    // 同じ行に横に並ぶ1行の塊（見出しと補足、帯の項目など）は、1つの行にまとめる。間の空きは前の字の字間にする
    const merged = [];
    for (const p of paras) {
      const prev = merged[merged.length - 1];
      const one = p.lines.length === 1 && !p.bullet;
      if (prev && one && prev._row && Math.abs(prev.lines[0].baseline - p.lines[0].baseline) < 1.5 && p.lines[0].left >= prev.lines[0].right - 1) {
        const L = prev.lines[0], R = p.lines[0];
        const lastRun = L.runs[L.runs.length - 1];
        const gap = (R.penLeft ?? R.left) - L.penRight;
        // 間の空きは空白文字で作り、端数を字間で合わせる（Googleスライドは字間を読まないので、空白の数で近づける）
        ctx2d.font = fontCss(lastRun.style);
        const sw = ctx2d.measureText(' ').width || lastRun.style.size * 0.25;
        const n = Math.max(1, Math.round(gap / sw));
        if (gap > sw * 0.4) L.runs.push({ text: ' '.repeat(n), style: lastRun.style, fit: (gap - n * sw) / n });
        else lastRun.fit += 0;
        L.runs.push(...R.runs);
        L.right = R.right; L.penRight = R.penRight;
        L.top = Math.min(L.top, R.top); L.bottom = Math.max(L.bottom, R.bottom);
        L.size = Math.max(L.size, R.size);
        if (R.size > L.size - 0.01) L.baseline = Math.max(L.baseline, R.baseline);
        continue;
      }
      merged.push(Object.assign(p, { _row: one }));
    }
    paras = merged.map((p) => { delete p._row; return p; });
    // 縦に積まれているか（横に並ぶ塊があれば別々のまま）
    for (let i = 1; i < paras.length; i++) {
      const prev = paras[i - 1].lines[paras[i - 1].lines.length - 1];
      if (paras[i].lines[0].top < prev.bottom - 2) return null;
    }
    return { paras, deco };
  }

  // ---------- 表 ----------
  function tableItem(table, alpha) {
    const tr = table.getBoundingClientRect();
    const rows = [...table.rows];
    if (!rows.length) return null;
    const cells = [];
    const xs = new Set(), ys = new Set();
    for (const row of rows) {
      for (const cell of row.cells) {
        const r = cell.getBoundingClientRect();
        if (r.width < 0.5 || r.height < 0.5) continue;
        xs.add(Math.round((r.left - base.left) * 4) / 4); xs.add(Math.round((r.right - base.left) * 4) / 4);
        ys.add(Math.round((r.top - base.top) * 4) / 4); ys.add(Math.round((r.bottom - base.top) * 4) / 4);
        cells.push({ cell, row, r: rel(r) });
      }
    }
    // 近い座標（罫線の太さ分のずれ）はまとめる
    const merge = (arr) => { const s = [...arr].sort((a, b) => a - b); const o = []; for (const v of s) if (!o.length || v - o[o.length - 1] > 1.5) o.push(v); return o; };
    const X = merge(xs), Y = merge(ys);
    const near = (arr, v) => arr.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(arr[bi] - v) ? i : bi), 0);
    const nR = Y.length - 1, nC = X.length - 1;
    if (nR < 1 || nC < 1) return null;
    const grid = [...Array(nR)].map(() => Array(nC).fill(null));
    const collapse = getComputedStyle(table).borderCollapse === 'collapse';
    for (const c of cells) {
      const c0 = near(X, c.r.x), c1 = near(X, c.r.x + c.r.w), r0 = near(Y, c.r.y), r1 = near(Y, c.r.y + c.r.h);
      if (c1 <= c0 || r1 <= r0) continue;
      const cs = getComputedStyle(c.cell), rcs = getComputedStyle(c.row);
      // 塗り：セル → 行 → 行のまとまり（thead/tbody）の順に見る
      const sec = c.row.parentElement;
      const fill = withAlpha(color(cs.backgroundColor) || color(rcs.backgroundColor) || (sec && sec !== table ? color(getComputedStyle(sec).backgroundColor) : null), alpha * Number(cs.opacity || 1));
      const side = (s) => {
        const pick = (st) => (st[`border${s}Style`] !== 'none' && px(st[`border${s}Width`]) > 0 ? { w: px(st[`border${s}Width`]), color: withAlpha(color(st[`border${s}Color`]), alpha), dash: st[`border${s}Style`] === 'dashed' ? 'dash' : st[`border${s}Style`] === 'dotted' ? 'sysDot' : null } : null);
        let b = pick(cs);
        if (!b && collapse) {
          if (s === 'Top' && c.row === rows[r0]) b = pick(rcs) || (r0 === 0 ? pick(getComputedStyle(table)) : null);
          if (s === 'Bottom') b = pick(rcs) || (r1 === nR ? pick(getComputedStyle(table)) : null);
          if (s === 'Left' && c0 === 0) b = pick(getComputedStyle(table));
          if (s === 'Right' && c1 === nC) b = pick(getComputedStyle(table));
        }
        return b && b.color ? b : null;
      };
      const paras = [];
      // セルの中の文字の塊を上から順に段落にする
      const owners = [];
      const collect = (el) => {
        const own = ownTextNodes(el);
        const ecs = getComputedStyle(el);
        if (own.some((n) => /\S/.test(n.textContent))) owners.push({ el, cs: ecs, nodes: own });
        for (const ch of el.children) {
          if (ch instanceof SVGElement || ch.tagName === 'IMG') continue;
          const ccs = getComputedStyle(ch);
          if (ccs.display === 'none') continue;
          if (!isInline(ccs) || ccs.position === 'absolute') collect(ch);
          else collectInlineBlocks(ch);
        }
      };
      const collectInlineBlocks = (el) => { for (const ch of el.children) { const ccs = getComputedStyle(ch); if (!isInline(ccs)) collect(ch); else collectInlineBlocks(ch); } };
      collect(c.cell);
      for (const o of owners) {
        const t = paraOf(o.el, o.cs, o.nodes, alpha);
        if (t) paras.push(t);
      }
      grid[r0][c0] = {
        x: X[c0], y: Y[r0], w: X[c1] - X[c0], h: Y[r1] - Y[r0],
        colspan: c1 - c0, rowspan: r1 - r0, fill,
        border: { t: side('Top'), r: side('Right'), b: side('Bottom'), l: side('Left') },
        pad: { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) },
        valign: cs.verticalAlign === 'top' ? 't' : cs.verticalAlign === 'bottom' ? 'b' : 'ctr',
        paras,
        el: c.cell,
      };
      for (let i = r0; i < r1; i++) for (let j = c0; j < c1; j++) if (i !== r0 || j !== c0) grid[i][j] = { merged: true, hMerge: i === r0, vMerge: i !== r0 };
    }
    // 罫線の重なり（border-collapse）：境目ごとに太いほうを勝たせ、両側のセルに同じ線を持たせる（PowerPoint は片方しか使わない）
    const origin = (r, c) => { for (let i = r; i >= 0; i--) for (let j = c; j >= 0; j--) { const g = grid[i][j]; if (g && !g.merged && i + g.rowspan > r && j + g.colspan > c) return g; } return null; };
    const win = (a, b) => (!a ? b : !b ? a : b.w > a.w + 0.01 ? b : a);
    for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) {
      const A = origin(r, c);
      if (!A) continue;
      if (r + 1 < nR) { const B = origin(r + 1, c); if (B && B !== A) { const w = win(A.border.b, B.border.t); A.border.b = w; B.border.t = w; } }
      if (c + 1 < nC) { const B = origin(r, c + 1); if (B && B !== A) { const w = win(A.border.r, B.border.l); A.border.r = w; B.border.l = w; } }
    }
    return { k: 'table', x: X[0], y: Y[0], cols: X.slice(1).map((v, i) => v - X[i]), rows: Y.slice(1).map((v, i) => v - Y[i]), grid };
  }

  // ---------- HTML の要素をたどる ----------
  // 箱の部品の中から、箱全体を覆う図形（文字を入れる先）を探す
  function mainShape(list, m, w, h) {
    const fr = frameOf(m, w, h);
    if (!fr || fr.rot) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (it.k !== 'shape' || it.geom === 'path' || it.rot || it.text) continue;
      const pad = it.line ? it.line.w / 2 + 0.6 : 0.6;
      if (it._ringFor) { const sp = it.line.w; if (Math.abs(it.x + sp / 2 - fr.x) < 0.7 && Math.abs(it.y + sp / 2 - fr.y) < 0.7 && Math.abs(it.w - sp - fr.w) < 0.7 && Math.abs(it.h - sp - fr.h) < 0.7) return it; continue; }
      if (Math.abs(it.x - fr.x) <= pad && Math.abs(it.y - fr.y) <= pad && Math.abs(it.x + it.w - fr.x - fr.w) <= pad && Math.abs(it.y + it.h - fr.y - fr.h) <= pad) return it;
    }
    return null;
  }
  const GROUP_MAX_W = 1100;
  async function walk(el, alpha, opts = {}) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') return;
    alpha *= Number(cs.opacity);
    if (alpha < 0.002) return;
    const visible = cs.visibility !== 'hidden';
    if (el instanceof SVGSVGElement) {
      const r = el.getBoundingClientRect();
      const group = { k: 'group', name: el.getAttribute('aria-label') || 'svg', items: [] };
      const save = items; items = group.items;
      await svgElement(el, alpha);
      items = save;
      attachTexts(group.items);
      if (group.items.length) push(group.items.length === 1 ? group.items[0] : group);
      return;
    }
    if (el.tagName === 'IMG') { if (visible) await imgElement(el, cs, alpha); return; }
    if (el.tagName === 'TABLE' && visible && !opts.noTable) {
      await paintBox(el, cs, alpha);
      const t = tableItem(el, alpha);
      if (t) {
        // 表の中の文字以外の飾り（バー・印）は表の上に重ねる
        const overlays = [];
        const save = items; items = overlays;
        for (const row of el.rows) for (const cell of row.cells) {
          const ccs = getComputedStyle(cell);
          const layers = ccs.backgroundImage && ccs.backgroundImage !== 'none' ? ccs.backgroundImage : '';
          // セルの背景の画像・縞は、表の上に重ねて描く（色と罫線は表のセルが持つ）
          if (layers && /gradient|url\(/.test(layers)) await paintCellLayers(cell, ccs, alpha);
          for (const ch of cell.children) await walk(ch, alpha, { noText: true });
        }
        items = save;
        push(t);
        for (const o of mergeRuns(overlays)) push(o);
      }
      return;
    }
    if (el.tagName === 'BR') return;
    const inline = isInline(cs) && el.tagName !== 'SECTION';
    if (inline) { await walkInlineDescendants(el, alpha, opts); return; }

    // この要素の部品は、いったん別の列にためる（あとで1つのまとまりにするため）
    const mine = [];
    const save = items; items = mine;
    try {
      if (visible && !opts.skipBox) await paintBox(el, cs, alpha);
      const geo = boxGeometry(el, cs);
      // 中が文字だけなら、段落の列にして、箱の図形に入れる（なければ1つのテキストボックス）
      const flow = !opts.noText && visible && el.tagName !== 'SECTION' ? flowOf(el, alpha) : null;
      if (flow) {
        const host = mainShape(mine, geo.m, geo.w, geo.h);
        if (host) host.text = { paras: flow.paras };
        else push({ k: 'text', paras: flow.paras, name: nameOf(el) });
        for (const d of flow.deco) await walk(d, alpha, { noText: true });
      } else {
        let bulletDone = false;
        if (!opts.noText) {
          const nodes = ownTextNodes(el);
          if (nodes.some((n) => /\S/.test(n.textContent))) {
            if (visible) inlineBoxes(el, alpha);
            const p = paraOf(el, cs, nodes, alpha);
            if (p) {
              bulletDone = !!p.bullet;
              const host = !hasBlockChildren(el) ? mainShape(mine, geo.m, geo.w, geo.h) : null;
              if (host && !host.text) host.text = { paras: [p] };
              else push({ k: 'text', paras: [p], name: el.tagName.toLowerCase() });
            }
          }
        }
        for (const ch of el.children) {
          if (bulletDone && bulletSpan(el) === ch) continue;
          await walk(ch, alpha, { ...opts, skipBox: false });
        }
      }
    } finally { items = save; }
    // 塗りのある箱で、部品が2つ以上になったら1つのまとまりに（ページ全体を覆うような大きな地はまとめない）
    const paints = visible && !PAINT_FREE(cs);
    const geo = el.getBoundingClientRect();
    // 部品の中にまとまり・表があるもの（帯の地など大きな入れ物）はまとめない
    const leaf = !mine.some((x) => x.k === 'table' || x.k === 'group');
    if (paints && mine.length > 1 && el.tagName !== 'SECTION' && leaf && (geo.width < GROUP_MAX_W || /^H[1-6]$/.test(el.tagName))) {
      push({ k: 'group', name: nameOf(el), items: mine });
    } else for (const it of mine) push(it);
  }
  const NAMES = { H1: 'タイトル', H2: '見出し', H3: '見出し', H4: '見出し', P: '段落', UL: '箇条書き', OL: '番号付きの箇条書き', LI: '項目', TABLE: '表', SECTION: 'ページ' };
  function nameOf(el) {
    if (el.classList?.contains('lead')) return 'リード';
    const c = typeof el.className === 'string' && el.className.split(' ').find((x) => x && !x.startsWith('pptx-'));
    return NAMES[el.tagName] || c || el.tagName.toLowerCase();
  }
  // 縦（横）に連なる同じ幅・同じ色の細い四角（行ごとに分かれた区切りの線）を、1本にまとめる
  function mergeRuns(list) {
    const out = [];
    for (const it of list) {
      const thin = it.k === 'shape' && it.geom === 'rect' && !it.line && !it.text && !it.rot && it.fill && !it.fill.grad;
      if (thin) {
        const prev = out.find((o) => o._thin && o.fill.color === it.fill.color && Math.abs(o.fill.alpha - it.fill.alpha) < 0.01 &&
          ((Math.abs(o.x - it.x) < 0.3 && Math.abs(o.w - it.w) < 0.3 && Math.abs(o.y + o.h - it.y) < 0.6) || (Math.abs(o.y - it.y) < 0.3 && Math.abs(o.h - it.h) < 0.3 && Math.abs(o.x + o.w - it.x) < 0.6)));
        if (prev) { if (Math.abs(prev.x - it.x) < 0.3) prev.h = it.y + it.h - prev.y; else prev.w = it.x + it.w - prev.x; continue; }
        out.push({ ...it, _thin: true });
        continue;
      }
      out.push(it);
    }
    return out.map((o) => { delete o._thin; return o; });
  }
  async function paintCellLayers(cell, cs, alpha) {
    const fake = new Proxy(cs, { get: (t, k) => (k === 'backgroundColor' ? 'transparent' : /^border.*(Width|Style)$/.test(k) ? (k.endsWith('Style') ? 'none' : '0px') : k === 'boxShadow' ? 'none' : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    await paintBox(cell, fake, alpha);
  }
  const hasBlockChildren = (el) => [...el.children].some((c) => !c.dataset?.pptxPseudo && !isInline(getComputedStyle(c)) && getComputedStyle(c).display !== 'none');

  // SVG の図の中で、四角の中に置いた文字を、その四角に入れる（四角＋文字の細切れを避ける）
  function bboxOf(it) {
    if (it.k === 'shape' && it.geom !== 'path') return { x: it.x, y: it.y, w: it.w, h: it.h };
    if (it.k === 'shape') { const xs = it.path.filter((s) => s.c !== 'Z').flatMap((s) => (s.c === 'C' ? [s.x, s.x1, s.x2] : [s.x])), ys = it.path.filter((s) => s.c !== 'Z').flatMap((s) => (s.c === 'C' ? [s.y, s.y1, s.y2] : [s.y])); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
    if (it.k === 'text') { const ls = it.paras.flatMap((p) => p.lines); const x = Math.min(...ls.map((l) => l.left)), y = Math.min(...ls.map((l) => l.top)); return { x, y, w: Math.max(...ls.map((l) => l.right)) - x, h: Math.max(...ls.map((l) => l.bottom)) - y }; }
    if (it.k === 'image' || it.k === 'raster') return { x: it.x, y: it.y, w: it.w, h: it.h };
    if (it.k === 'group') { const bs = it.items.map(bboxOf).filter(Boolean); if (!bs.length) return null; const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y)); return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }; }
    return null;
  }
  const inside = (a, b, tol = 1) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  function attachTexts(list) {
    for (const it of list) if (it.k === 'group') attachTexts(it.items);
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.k !== 'text') continue;
      const tb = bboxOf(t);
      for (let j = i - 1; j >= 0; j--) {
        const s = list[j];
        const sb = bboxOf(s);
        if (!sb) continue;
        // ページ全体を覆う地（スライドの背景にするもの）には入れない
        const pageBg = sb.w >= 1270 && sb.h >= 710;
        const candidate = s.k === 'shape' && s.geom !== 'path' && !s.rot && (s.fill || s.line) && !pageBg && sb.w > tb.w && inside(tb, sb, 1);
        if (candidate) {
          // 間に、文字に重なる部品があれば入れない（重なり順が変わるため）
          const blocked = list.slice(j + 1, i).some((x) => x.k !== 'text' && overlaps(bboxOf(x) || { x: 0, y: 0, w: 0, h: 0 }, tb));
          if (blocked) break;
          // 前に入れた文字より下にあるときだけ足す
          if (s.text) {
            const last = s.text.paras[s.text.paras.length - 1];
            // WebKit の SVG 文字矩形は小数のまま返り、フォントの丸めで約0.06px重なる。
            const tolerance = window.__pptxCharacterRect ? 1.25 : 1;
            if (tb.y < last.lines[last.lines.length - 1].bottom - tolerance) break;
            s.text.paras.push(...t.paras);
          } else s.text = { paras: [...t.paras] };
          list.splice(i, 1); i--;
          break;
        }
        // 文字の後ろにある別の部品が文字に重なっていたら、それより奥は探さない
        if (s.k !== 'text' && overlaps(sb, tb)) break;
      }
    }
  }
  async function walkInlineDescendants(el, alpha, opts) {
    for (const ch of el.children) {
      const ccs = getComputedStyle(ch);
      if (ccs.display === 'none') continue;
      if (isInline(ccs) && !(ch instanceof SVGElement) && ch.tagName !== 'IMG' && ccs.position !== 'absolute') await walkInlineDescendants(ch, alpha * Number(ccs.opacity), opts);
      else await walk(ch, alpha, opts);
    }
  }

  async function imgElement(img, cs, alpha) {
    const { m, w, h } = boxGeometry(img, cs);
    const src = img.currentSrc || img.src;
    if (!src || w < 0.5 || h < 0.5) return;
    const nat = { w: img.naturalWidth || w, h: img.naturalHeight || h };
    const pl = objectFit(cs, nat, w, h);
    const radii = radiiOf(cs, w, h);
    if (isSvgUrl(src)) {
      await svgFromUrl(src, m.multiply(new DOMMatrix([1, 0, 0, 1, pl.x, pl.y])), pl.w, pl.h, { alpha, figureScheme: cs.colorScheme.includes('dark') ? 'dark' : 'light', override: filterOverride(cs.filter), clip: { x: 0, y: 0, w, h }, name: (img.getAttribute('src') || '').split('/').pop() });
      return;
    }
    const cx0 = Math.max(pl.x, 0), cy0 = Math.max(pl.y, 0), cx1 = Math.min(pl.x + pl.w, w), cy1 = Math.min(pl.y + pl.h, h);
    const crop = { l: (cx0 - pl.x) / pl.w, t: (cy0 - pl.y) / pl.h, r: (pl.x + pl.w - cx1) / pl.w, b: (pl.y + pl.h - cy1) / pl.h };
    const fr = frameOf(m.multiply(new DOMMatrix([1, 0, 0, 1, cx0, cy0])), cx1 - cx0, cy1 - cy0);
    if (!fr) return;
    const round = !noRadius(radii) ? (radii.every(([a, b]) => Math.abs(a - w / 2) < 0.5 && Math.abs(b - h / 2) < 0.5) ? { geom: 'ellipse' } : { geom: 'roundRect', adj: Math.min(50000, Math.round(radii[0][0] / Math.min(w, h) * 100000)) }) : {};
    push({ k: 'image', src, ...fr, crop, alpha, nat, ...round, name: (img.getAttribute('alt') || img.getAttribute('src') || '').split('/').pop() });
  }
  function objectFit(cs, nat, w, h) {
    const fit = cs.objectFit;
    let iw = w, ih = h;
    if (fit === 'contain' || fit === 'scale-down') { const s = Math.min(w / nat.w, h / nat.h); iw = nat.w * (fit === 'scale-down' ? Math.min(1, s) : s); ih = nat.h * (fit === 'scale-down' ? Math.min(1, s) : s); }
    else if (fit === 'cover') { const s = Math.max(w / nat.w, h / nat.h); iw = nat.w * s; ih = nat.h * s; }
    else if (fit === 'none') { iw = nat.w; ih = nat.h; }
    const [ax = '50%', ay = '50%'] = cs.objectPosition.split(/\s+/);
    const f = (s, free) => s.endsWith('%') ? parseFloat(s) / 100 * free : px(s);
    return { x: f(ax, w - iw), y: f(ay, h - ih), w: iw, h: ih };
  }

  // ---------- SVG ----------
  let svgSeq = 0;
  async function svgFromUrl(url, m, w, h, opts = {}) {
    let text;
    try { text = await readText(url); } catch { return; }
    if (!text) return;
    text = text.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/i, '');
    const host = document.createElement('div');
    // 回転のない置き方でページに重ねて描き、getScreenCTM で座標を取る
    const fr = frameOf(m, w, h) || { x: 0, y: 0, w, h, rot: 0 };
    host.style.cssText = `position:absolute;left:${base.left + fr.x + window.scrollX}px;top:${base.top + fr.y + window.scrollY}px;width:${fr.w}px;height:${fr.h}px;pointer-events:none;z-index:-1;visibility:visible`;
    host.innerHTML = text;
    const svg = host.querySelector('svg');
    if (!svg) return;
    // id がページの中でぶつからないように付け替える
    const pre = `pp${++svgSeq}-`;
    // The standalone image inherits its color scheme from <img>. After mounting
    // its editable shapes in this document, bind the same palette to this SVG.
    for (const style of svg.querySelectorAll(':scope > style[data-jinno-palette]')) {
      if (style.dataset.jinnoPalette !== opts.figureScheme) { style.remove(); continue; }
      svg.setAttribute('data-pptx-figure', pre);
      style.removeAttribute('media');
      style.textContent = style.textContent.replaceAll(':root', `svg[data-pptx-figure="${pre}"]`);
    }
    for (const e of svg.querySelectorAll('[id]')) e.id = pre + e.id;
    for (const e of [svg, ...svg.querySelectorAll('*')]) {
      for (const a of [...e.attributes]) {
        if (a.name !== 'style' && /url\(["']?#/.test(a.value)) e.setAttribute(a.name, a.value.replace(/url\((["']?)#/g, `url($1#${pre}`));
        if ((a.name === 'href' || a.name === 'xlink:href') && a.value.startsWith('#')) e.setAttribute(a.name, `#${pre}${a.value.slice(1)}`);
      }
      const st = e.getAttribute('style');
      if (st && /url\(["']?#/.test(st)) e.setAttribute('style', st.replace(/url\((["']?)#/g, `url($1#${pre}`));
    }
    for (const st of svg.querySelectorAll('style')) st.textContent = st.textContent.replace(/#([A-Za-z_][\w-]*)/g, (s, id) => (svg.querySelector(`#${CSS.escape(pre + id)}`) ? `#${pre}${id}` : s));
    if (!svg.getAttribute('viewBox')) {
      const W = parseFloat(svg.getAttribute('width')) || fr.w, H = parseFloat(svg.getAttribute('height')) || fr.h;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    svg.setAttribute('width', fr.w); svg.setAttribute('height', fr.h);
    svg.style.cssText = 'display:block;overflow:visible';
    document.body.appendChild(host);
    try {
      const group = { k: 'group', name: opts.name || 'figure', items: [] };
      const save = items; items = group.items;
      await svgElement(svg, opts.alpha ?? 1, opts);
      items = save;
      attachTexts(group.items);
      if (fr.rot) group.rot = fr.rot; // 回転は無視（まれ）
      if (group.items.length) push(group);
    } finally { host.remove(); }
  }
  function useToClone(svg) {
    for (const u of [...svg.querySelectorAll('use')]) {
      const ref = u.getAttribute('href') || u.getAttribute('xlink:href');
      const target = ref && svg.ownerDocument.getElementById(ref.slice(1));
      if (!target) continue;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      for (const a of u.attributes) if (!['href', 'xlink:href', 'x', 'y', 'width', 'height'].includes(a.name)) g.setAttribute(a.name, a.value);
      const x = parseFloat(u.getAttribute('x')) || 0, y = parseFloat(u.getAttribute('y')) || 0;
      g.setAttribute('transform', `${u.getAttribute('transform') || ''} translate(${x} ${y})`);
      let clone = target.cloneNode(true);
      clone.removeAttribute('id');
      if (clone.tagName.toLowerCase() === 'symbol') {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const a of clone.attributes) s.setAttribute(a.name, a.value);
        s.setAttribute('width', u.getAttribute('width') || '100%'); s.setAttribute('height', u.getAttribute('height') || '100%');
        s.append(...clone.childNodes); clone = s;
      }
      g.appendChild(clone);
      u.replaceWith(g);
    }
  }
  async function svgElement(svg, alpha, opts = {}) {
    useToClone(svg);
    await svgNode(svg, alpha, opts);
  }
  function paintOf(cs, el, kind, alpha, override) {
    const v = kind === 'fill' ? cs.fill : cs.stroke;
    if (!v || v === 'none') return null;
    const op = Number(kind === 'fill' ? cs.fillOpacity : cs.strokeOpacity) * alpha;
    if (override) return { ...override, alpha: override.alpha * op };
    if (/^url\(/.test(v)) {
      const id = v.match(/url\(["']?#([^"')]+)/)?.[1];
      const g = id && document.getElementById(id);
      if (g && /gradient/i.test(g.tagName)) {
        const stops = [...g.querySelectorAll('stop')].map((s) => {
          const scs = getComputedStyle(s);
          const c = color(scs.stopColor);
          let off = s.getAttribute('offset') || '0';
          off = off.endsWith('%') ? parseFloat(off) / 100 : Number(off);
          return c ? { pos: off, c: { color: c.color, alpha: c.alpha * Number(scs.stopOpacity || 1) * op } } : null;
        }).filter(Boolean);
        if (stops.length >= 2) {
          if (g.tagName.toLowerCase() === 'lineargradient') {
            const n = (a, d) => { const s = g.getAttribute(a); return s === null ? d : s.endsWith('%') ? parseFloat(s) / 100 : Number(s); };
            const x1 = n('x1', 0), y1 = n('y1', 0), x2 = n('x2', 1), y2 = n('y2', 0);
            const ang = (Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI + 90 + 360) % 360; // CSS の角度（上が0°）
            return { grad: { angle: ang, stops } };
          }
          return { grad: { radial: true, stops } };
        }
        if (stops.length === 1) return stops[0].c;
      }
      const fb = v.match(/\)\s*(.+)$/)?.[1];
      return fb ? withAlpha(color(fb), op) : null;
    }
    if (v === 'context-stroke' || v === 'context-fill') return null;
    return withAlpha(color(v), op);
  }
  function geometryOf(el) {
    const tag = el.tagName.toLowerCase();
    const n = (a) => el[a]?.baseVal?.value ?? parseFloat(el.getAttribute(a)) ?? 0;
    switch (tag) {
      case 'rect': {
        const x = n('x'), y = n('y'), w = n('width'), h = n('height');
        let rx = el.getAttribute('rx'), ry = el.getAttribute('ry');
        rx = rx === null || rx === 'auto' ? null : n('rx'); ry = ry === null || ry === 'auto' ? null : n('ry');
        if (rx === null) rx = ry ?? 0; if (ry === null) ry = rx;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        return { rect: { x, y, w, h, rx, ry }, path: rectPath(x, y, w, h, rx || ry ? [[rx, ry], [rx, ry], [rx, ry], [rx, ry]] : null) };
      }
      case 'circle': { const cx = n('cx'), cy = n('cy'), r = n('r'); return { ellipse: { cx, cy, rx: r, ry: r }, path: ellipsePath(cx, cy, r, r) }; }
      case 'ellipse': { const cx = n('cx'), cy = n('cy'), rx = n('rx'), ry = n('ry'); return { ellipse: { cx, cy, rx, ry }, path: ellipsePath(cx, cy, rx, ry) }; }
      case 'line': return { path: [{ c: 'M', x: n('x1'), y: n('y1') }, { c: 'L', x: n('x2'), y: n('y2') }], open: true };
      case 'polyline': case 'polygon': {
        const pts = [...el.points].map((p) => ({ x: p.x, y: p.y }));
        return { path: polyPath(pts, tag === 'polygon'), open: tag === 'polyline' };
      }
      case 'path': return { path: parseD(el.getAttribute('d') || '') };
      default: return null;
    }
  }
  function lineStyle(cs, stroke, scale) {
    if (!stroke) return null;
    const w = px(cs.strokeWidth) * scale;
    if (w <= 0) return null;
    let dash = null;
    if (cs.strokeDasharray && cs.strokeDasharray !== 'none') {
      const arr = cs.strokeDasharray.split(/[\s,]+/).map(px).map((v) => v * scale);
      if (arr.length && arr.some((v) => v > 0)) dash = { custom: arr.length % 2 ? [...arr, ...arr] : arr, w };
    }
    return { ...stroke, w, dash, cap: cs.strokeLinecap, join: cs.strokeLinejoin };
  }
  // 線の端の向き（矢印の印を置くため）
  function endpoints(path) {
    const pts = [];
    let start = null;
    for (const s of path) {
      if (s.c === 'M') { start = s; pts.push({ x: s.x, y: s.y, inx: null, iny: null, seg: 'M' }); }
      else if (s.c === 'L') pts.push({ x: s.x, y: s.y, cx: null, seg: 'L' });
      else if (s.c === 'C') pts.push({ x: s.x, y: s.y, c1: { x: s.x1, y: s.y1 }, c2: { x: s.x2, y: s.y2 }, seg: 'C' });
      else if (s.c === 'Z' && start) pts.push({ x: start.x, y: start.y, seg: 'Z' });
    }
    return pts;
  }
  function markerAt(markerEl, vertex, angle, strokeW, elM, alpha, override, reverse) {
    const vb = markerEl.viewBox?.baseVal;
    const mw = markerEl.markerWidth?.baseVal?.value ?? 3, mh = markerEl.markerHeight?.baseVal?.value ?? 3;
    const refX = markerEl.refX?.baseVal?.value ?? 0, refY = markerEl.refY?.baseVal?.value ?? 0;
    const units = markerEl.getAttribute('markerUnits') || 'strokeWidth';
    let s = 1;
    if (vb && vb.width && vb.height) s = Math.min(mw / vb.width, mh / vb.height);
    const orient = markerEl.getAttribute('orient') || '0';
    let ang = 0;
    if (orient === 'auto') ang = angle;
    else if (orient === 'auto-start-reverse') ang = reverse ? angle + 180 : angle;
    else ang = parseFloat(orient) || 0;
    const scale = units === 'strokeWidth' ? strokeW : 1;
    const M = elM.translate(vertex.x, vertex.y).rotate(ang).scale(scale).scale(s).translate(-refX, -refY);
    const mcsParent = getComputedStyle(markerEl);
    if (mcsParent.display === 'none') return;
    for (const ch of markerEl.children) svgGeom(ch, alpha, override, M);
  }
  function svgGeom(el, alpha, override, M, ownerStroke) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'g') { const cs = getComputedStyle(el); const t = el.transform?.baseVal?.consolidate()?.matrix; const MM = t ? M.multiply(DOMMatrix.fromMatrix(t)) : M; for (const ch of el.children) svgGeom(ch, alpha * Number(cs.opacity), override, MM, ownerStroke); return; }
    const g = geometryOf(el);
    if (!g || emptyPath(g)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const a = alpha * Number(cs.opacity);
    const t = el.transform?.baseVal?.consolidate()?.matrix;
    const MM = t ? M.multiply(DOMMatrix.fromMatrix(t)) : M;
    const sc = scaleOf(MM);
    let fill = g.open ? null : paintOf(cs, el, 'fill', a, override);
    if (cs.fill === 'context-stroke' && ownerStroke) fill = ownerStroke;
    const stroke = lineStyle(cs, paintOf(cs, el, 'stroke', a, override), sc);
    if (!fill && !stroke) return;
    push(shapeFromGeom(g, MM, fill, stroke));
  }
  function shapeFromGeom(g, M, fill, line) {
    if (g.rect && axisAligned(M)) {
      const { x, y, w, h, rx, ry } = g.rect;
      const p0 = apply(M, x, y), p1 = apply(M, x + w, y + h);
      const X = Math.min(p0.x, p1.x), Y = Math.min(p0.y, p1.y), W = Math.abs(p1.x - p0.x), H = Math.abs(p1.y - p0.y);
      const srx = rx * Math.abs(M.a), sry = ry * Math.abs(M.d);
      if (!rx && !ry) return { k: 'shape', geom: 'rect', x: X, y: Y, w: W, h: H, rot: 0, fill, line };
      if (Math.abs(srx - sry) < 0.5) return { k: 'shape', geom: Math.abs(srx - W / 2) < 0.5 && Math.abs(sry - H / 2) < 0.5 ? 'ellipse' : 'roundRect', adj: Math.min(50000, Math.round(srx / Math.min(W, H) * 100000)), x: X, y: Y, w: W, h: H, rot: 0, fill, line };
    }
    if (g.ellipse && axisAligned(M)) {
      const { cx, cy, rx, ry } = g.ellipse;
      const c = apply(M, cx, cy);
      const W = 2 * rx * Math.abs(M.a), H = 2 * ry * Math.abs(M.d);
      return { k: 'shape', geom: 'ellipse', x: c.x - W / 2, y: c.y - H / 2, w: W, h: H, rot: 0, fill, line };
    }
    return { k: 'shape', geom: 'path', path: mapPath(g.path, M), fill, line, open: !!g.open };
  }
  // 点が2つ未満のパス（d が空など）は描くものがない
  const emptyPath = (g) => g.path.filter((s) => s.c !== 'Z').length < 2;
  async function svgNode(el, alpha, opts) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_SVG.has(tag)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const a = alpha * Number(cs.opacity);
    if (a < 0.002) return;
    const override = opts.override || null;
    if (tag === 'svg' || tag === 'g' || tag === 'a' || tag === 'switch') {
      // 1つの図の中の入れ子の svg（アイコン）はまとまりにする
      if (tag === 'svg' && el.parentElement && el.parentElement.closest('svg')) {
        const group = { k: 'group', name: el.getAttribute('data-service-icon') || 'icon', items: [] };
        const save = items; items = group.items;
        for (const ch of el.children) await svgNode(ch, a, opts);
        items = save;
        if (group.items.length) push(group);
        return;
      }
      for (const ch of el.children) {
        await svgNode(ch, a, opts);
        if (tag === 'switch') break;
      }
      return;
    }
    if (tag === 'foreignobject') { for (const ch of el.children) await walk(ch, a); return; }
    if (cs.visibility === 'hidden') return;
    if (tag === 'text') { svgText(el, a, override); return; }
    if (tag === 'image') { await svgImage(el, a, opts); return; }
    const g = geometryOf(el);
    if (!g || emptyPath(g)) return;
    const M = pageMatrix().multiply(DOMMatrix.fromMatrix(el.getScreenCTM()));
    const sc = scaleOf(M);
    const fill = g.open ? null : paintOf(cs, el, 'fill', a, override);
    const strokePaint = paintOf(cs, el, 'stroke', a, override);
    const stroke = lineStyle(cs, strokePaint, sc);
    // 塗りがあって線がなく、開いたパスでも塗る（SVGは開いたパスも塗る）
    let f2 = fill;
    if (!f2 && tag === 'path' && !g.open) f2 = null;
    if (f2 || stroke) push(shapeFromGeom(g, M, f2, stroke));
    // 矢印などの印
    for (const [prop, which] of [['markerStart', 'start'], ['markerMid', 'mid'], ['markerEnd', 'end']]) {
      const v = cs[prop];
      if (!v || v === 'none') continue;
      const id = v.match(/url\(["']?#([^"')]+)/)?.[1];
      const mk = id && document.getElementById(id);
      if (!mk) continue;
      const pts = endpoints(g.path);
      if (pts.length < 2) continue;
      const strokeW = px(cs.strokeWidth);
      const dir = (p, q) => Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
      const local = DOMMatrix.fromMatrix(el.getScreenCTM());
      const LM = pageMatrix().multiply(local);
      if (which === 'start') {
        const p0 = pts[0], p1 = pts[1];
        const q = p1.seg === 'C' && (Math.abs(p1.c1.x - p0.x) > 0.01 || Math.abs(p1.c1.y - p0.y) > 0.01) ? p1.c1 : p1;
        markerAt(mk, p0, dir(p0, q), strokeW, LM, a, override || strokePaint, true);
      } else if (which === 'end') {
        const pn = pts[pts.length - 1], pm = pts[pts.length - 2];
        const q = pn.seg === 'C' && (Math.abs(pn.c2.x - pn.x) > 0.01 || Math.abs(pn.c2.y - pn.y) > 0.01) ? pn.c2 : pm;
        markerAt(mk, pn, dir(q, pn), strokeW, LM, a, override, false);
      } else {
        for (let i = 1; i < pts.length - 1; i++) markerAt(mk, pts[i], (dir(pts[i - 1], pts[i]) + dir(pts[i], pts[i + 1])) / 2, strokeW, LM, a, override, false);
      }
    }
  }
  function svgText(el, alpha, override) {
    // テキストノードの持ち主ごとではなく、<text> 1つを1つのテキストボックスにする
    const nodes = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) if (n.parentElement.closest('text') === el && getComputedStyle(n.parentElement).display !== 'none') nodes.push(n);
    if (!nodes.length) return;
    let lines = linesOf(nodes, alpha);
    if (!lines.length) return;
    if (override) for (const l of lines) for (const r of l.runs) { r.style = { ...r.style, color: override.color }; }
    const cs = getComputedStyle(el);
    const anchor = cs.textAnchor;
    const align = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left';
    // 行の間隔：行の上端の差。1行なら文字の高さ
    let lh = lines.length > 1 ? (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1) : (lines[0].bottom - lines[0].top) * 1.2;
    // 行の間隔がそろっていなければ1行ずつ分ける
    const even = lines.length < 3 || lines.slice(1).every((l, i) => Math.abs((l.top - lines[i].top) - lh) < 1.5);
    if (!even || lh <= 0) { for (const l of lines) push({ k: 'text', paras: [{ align, lh: (l.bottom - l.top) * 1.2, lines: [l] }], name: 'text' }); return; }
    push({ k: 'text', paras: [{ align, lh, lines }], name: 'text' });
  }
  async function svgImage(el, alpha, opts) {
    const href = el.getAttribute('href') || el.getAttribute('xlink:href');
    if (!href) return;
    const M = pageMatrix().multiply(DOMMatrix.fromMatrix(el.getScreenCTM()));
    const n = (a) => el[a]?.baseVal?.value ?? 0;
    const x = n('x'), y = n('y'), w = n('width'), h = n('height');
    const url = new URL(href, el.ownerDocument.baseURI).href;
    const nat = await naturalSize(url);
    const par = (el.getAttribute('preserveAspectRatio') || 'xMidYMid meet').split(/\s+/);
    let iw = w, ih = h, ix = x, iy = y;
    if (par[0] !== 'none') {
      const s = (par[1] === 'slice' ? Math.max : Math.min)(w / nat.w, h / nat.h);
      iw = nat.w * s; ih = nat.h * s;
      const al = par[0];
      ix = x + (/xMid/.test(al) ? (w - iw) / 2 : /xMax/.test(al) ? w - iw : 0);
      iy = y + (/YMid/.test(al) ? (h - ih) / 2 : /YMax/.test(al) ? h - ih : 0);
    }
    if (isSvgUrl(url)) { await svgFromUrl(url, M.multiply(new DOMMatrix([1, 0, 0, 1, ix, iy])), iw, ih, { ...opts, alpha }); return; }
    // 切り抜き：画像の枠（slice のとき）・clipPath の四角・入れ子の svg の表示範囲を、ページ上の四角として重ねる
    if (!axisAligned(M)) return;
    const pg = (x0, y0, x1, y1, MM) => { const a = apply(MM, x0, y0), b = apply(MM, x1, y1); return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }; };
    const img = pg(ix, iy, ix + iw, iy + ih, M);
    let vis = pg(x, y, x + w, y + h, M);
    const cut = (r) => { vis = { x0: Math.max(vis.x0, r.x0), y0: Math.max(vis.y0, r.y0), x1: Math.min(vis.x1, r.x1), y1: Math.min(vis.y1, r.y1) }; };
    let round = {};
    for (let e = el; e && e instanceof SVGElement; e = e.parentElement) {
      const cp0 = getComputedStyle(e).clipPath;
      const cid = cp0 && cp0 !== 'none' && cp0.match(/url\(["']?#([^"')]+)/)?.[1];
      const cp = cid && document.getElementById(cid);
      if (cp) {
        const units = cp.getAttribute('clipPathUnits') || 'userSpaceOnUse';
        const shapes = [...cp.children].filter((c) => ['rect', 'circle', 'ellipse', 'path', 'polygon'].includes(c.tagName.toLowerCase()));
        if (shapes.length === 1 && units === 'userSpaceOnUse') {
          const c = shapes[0];
          const bb = c.getBBox();
          const EM = pageMatrix().multiply(DOMMatrix.fromMatrix(e.getScreenCTM()));
          const t = c.transform?.baseVal?.consolidate()?.matrix;
          cut(pg(bb.x, bb.y, bb.x + bb.width, bb.y + bb.height, t ? EM.multiply(DOMMatrix.fromMatrix(t)) : EM));
          if (e === el) {
            const tag = c.tagName.toLowerCase();
            const rx = tag === 'rect' ? (c.rx?.baseVal?.value || 0) : 0;
            if (tag === 'circle' || tag === 'ellipse') round = { geom: 'ellipse' };
            else if (rx > 0) round = { geom: 'roundRect', rxPage: rx * scaleOf(EM) };
          }
        }
      }
      // 入れ子の svg は、その表示範囲で切り抜かれる（overflow: visible でなければ）
      if (e.tagName.toLowerCase() === 'svg' && e !== el && getComputedStyle(e).overflow !== 'visible') {
        const par = e.parentElement && e.parentElement instanceof SVGElement ? e.parentElement : null;
        if (par) {
          const PM = pageMatrix().multiply(DOMMatrix.fromMatrix(par.getScreenCTM()));
          const vx = e.x.baseVal.value, vy = e.y.baseVal.value, vw = e.width.baseVal.value, vh = e.height.baseVal.value;
          cut(pg(vx, vy, vx + vw, vy + vh, PM));
        } else {
          const r = e.getBoundingClientRect();
          cut({ x0: r.left - base.left, y0: r.top - base.top, x1: r.right - base.left, y1: r.bottom - base.top });
        }
      }
    }
    if (vis.x1 - vis.x0 < 0.5 || vis.y1 - vis.y0 < 0.5) return;
    const IW = img.x1 - img.x0, IH = img.y1 - img.y0;
    const crop = { l: Math.max(0, (vis.x0 - img.x0) / IW), t: Math.max(0, (vis.y0 - img.y0) / IH), r: Math.max(0, (img.x1 - vis.x1) / IW), b: Math.max(0, (img.y1 - vis.y1) / IH) };
    const fr = { x: Math.max(vis.x0, img.x0), y: Math.max(vis.y0, img.y0), w: Math.min(vis.x1, img.x1) - Math.max(vis.x0, img.x0), h: Math.min(vis.y1, img.y1) - Math.max(vis.y0, img.y0), rot: 0 };
    if (fr.w < 0.5 || fr.h < 0.5) return;
    if (round.rxPage !== undefined) round = { geom: 'roundRect', adj: Math.min(50000, Math.round(round.rxPage / Math.min(fr.w, fr.h) * 100000)) };
    push({ k: 'image', src: url, ...fr, crop, alpha, nat, ...round, name: 'image' });
  }

  // ---------- ページ全体 ----------
  async function slideScene(sec) {
    base = sec.getBoundingClientRect();
    items = [];
    const cs = getComputedStyle(sec);
    // ページの地：単色はスライドの背景に。画像は一番下の画像に
    const bg = color(cs.backgroundColor);
    const save = sec.style.backgroundColor;
    await walk(sec, 1, { sectionBg: true });
    // 四角の中に置いた文字（コードの窓の中のコードなど）は、その四角に入れる
    attachTexts(items);
    // 先頭が地の色の全面の四角なら、スライドの背景にする
    let background = null;
    const first = items[0];
    if (first && first.k === 'shape' && first.geom === 'rect' && !first.line && first.fill && !first.fill.grad && first.x <= 0.5 && first.y <= 0.5 && first.w >= 1279 && first.h >= 719 && first.fill.alpha >= 0.999) {
      background = first.fill.color; items.shift();
    } else if (bg && bg.alpha >= 0.999) background = bg.color;
    sec.style.backgroundColor = save;
    return { background, items };
  }

  window.__pptxExtract = async (indexes) => {
    const sections = [...document.querySelectorAll('section[id]')];
    for (const sec of sections) materialize(sec);
    if (window.__pptxWaitFrame) await window.__pptxWaitFrame();
    else await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await document.fonts.ready;
    const out = [];
    for (const [i, sec] of sections.entries()) {
      if (indexes && !indexes.includes(i)) continue;
      out.push({ index: i, ...(await slideScene(sec)) });
    }
    return out;
  };
})();
