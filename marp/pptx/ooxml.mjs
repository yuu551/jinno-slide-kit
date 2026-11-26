// extract.js が返した部品の列を、PowerPoint のスライドの XML（DrawingML）にする。
// 座標は px（1280×720）で受け取り、EMU（1px = 9525）にする。
export const EMU = 9525;
const e = (v) => Math.round(v * EMU);
const pt100 = (pxv) => Math.round(pxv * 75); // px → 1/100 pt（1px = 0.75pt）
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const FONT = { sans: 'Noto Sans JP', mono: 'Courier New' };

const srgb = (c) => `<a:srgbClr val="${c.color.toUpperCase()}">${c.alpha < 0.999 ? `<a:alpha val="${Math.round(Math.max(0, c.alpha) * 100000)}"/>` : ''}</a:srgbClr>`;
function fillXml(f) {
  if (!f) return '<a:noFill/>';
  if (f.grad) {
    const gs = f.grad.stops.map((s) => `<a:gs pos="${Math.round(Math.max(0, Math.min(1, s.pos)) * 100000)}">${srgb(s.c)}</a:gs>`).join('');
    if (f.grad.radial) return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`;
    const ang = (((f.grad.angle - 90) % 360) + 360) % 360;
    return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:lin ang="${Math.round(ang * 60000)}" scaled="0"/></a:gradFill>`;
  }
  return `<a:solidFill>${srgb(f)}</a:solidFill>`;
}
function lineXml(l) {
  if (!l) return '<a:ln><a:noFill/></a:ln>';
  const cap = l.cap === 'round' ? ' cap="rnd"' : l.cap === 'square' ? ' cap="sq"' : ' cap="flat"';
  let dash = '';
  if (l.dash === 'dash') dash = '<a:prstDash val="dash"/>';
  else if (l.dash === 'sysDot') dash = '<a:prstDash val="sysDot"/>';
  else if (l.dash && l.dash.custom) {
    const w = l.w || 1;
    const ds = [];
    for (let i = 0; i + 1 < l.dash.custom.length; i += 2) ds.push(`<a:ds d="${Math.max(1, Math.round(l.dash.custom[i] / w * 100000))}" sp="${Math.max(1, Math.round(l.dash.custom[i + 1] / w * 100000))}"/>`);
    dash = `<a:custDash>${ds.join('')}</a:custDash>`;
  }
  const join = l.join === 'round' ? '<a:round/>' : l.join === 'bevel' ? '<a:bevel/>' : '<a:miter lim="800000"/>';
  return `<a:ln w="${e(l.w)}"${cap}>${fillXml(l)}${dash}${join}</a:ln>`;
}
function effectXml(s) {
  if (!s) return '';
  const dist = Math.hypot(s.x, s.y), dir = ((Math.atan2(s.y, s.x) * 180 / Math.PI) + 360) % 360;
  return `<a:effectLst><a:outerShdw blurRad="${e(s.blur)}" dist="${e(dist)}" dir="${Math.round(dir * 60000)}" algn="ctr" rotWithShape="0">${srgb(s.color)}</a:outerShdw></a:effectLst>`;
}
const xfrm = (x, y, w, h, rot = 0, flipV = false) => `<a:xfrm${rot ? ` rot="${Math.round(rot * 60000)}"` : ''}${flipV ? ' flipV="1"' : ''}><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${Math.max(1, e(w))}" cy="${Math.max(1, e(h))}"/></a:xfrm>`;

// ---------- 範囲 ----------
export function bounds(it) {
  if (it.k === 'shape' && it.geom === 'path') {
    const xs = [], ys = [];
    for (const s of it.path) { if (s.c === 'Z') continue; xs.push(s.x); ys.push(s.y); if (s.c === 'C') { xs.push(s.x1, s.x2); ys.push(s.y1, s.y2); } }
    const lw = it.line ? it.line.w / 2 : 0;
    return { x: Math.min(...xs) - lw, y: Math.min(...ys) - lw, w: Math.max(...xs) - Math.min(...xs) + 2 * lw, h: Math.max(...ys) - Math.min(...ys) + 2 * lw };
  }
  if (it.k === 'text') return it._box || layoutText(it.paras, null).box;
  if (it.k === 'group') {
    const bs = it.items.map(bounds).filter(Boolean);
    if (!bs.length) return null;
    const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
    return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
  }
  if (it.k === 'table') return { x: it.x, y: it.y, w: it.cols.reduce((a, b) => a + b, 0), h: it.rows.reduce((a, b) => a + b, 0) };
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}

// ---------- 文字の組み方 ----------
// PowerPoint と Googleスライドの行の置き方（較正で測った値）
//   行間 1倍 = 字の大きさの 1.2 倍。1倍のとき、行の上端からベースラインまでが字の大きさの 0.962 倍
//   1倍を超える行間は、余りを置く位置が2つのアプリで違う。そこで、ブラウザで折り返した1行を1段落にして
//   行間は1倍、行と行の間は「段落前の間隔（pt）」で指定する（どちらのアプリでも同じ位置になる）
export const LINE = { natural: 1.2, baseline: 0.962 };
// 段落の列を、箱（なければ文字の範囲から作る）の中に、ブラウザと同じ位置になるよう置く
export function layoutText(paras, box, { slack = true, textInset = null } = {}) {
  const rows = [];
  for (const p of paras) {
    const left = Math.min(...p.lines.map((l) => l.left)), right = Math.max(...p.lines.map((l) => l.right));
    p.lines.forEach((l, i) => {
      const size = Math.max(...l.runs.map((r) => r.style.size));
      const top = l.baseline - LINE.baseline * size;
      rows.push({ p, l, i, size, top, height: LINE.natural * size, left: l.penLeft ?? l.left, right: l.right, pLeft: left, pRight: right, bLeft: i === 0 && p.bullet ? p.bullet.left : null });
    });
  }
  let x0, x1, y0;
  if (box) {
    const ti = textInset || { l: 0, t: 0, r: 0, b: 0 };
    x0 = box.x + ti.l; x1 = box.x + box.w - ti.r; y0 = box.y + ti.t;
  } else {
    const L = Math.min(...rows.map((r) => Math.min(r.left, r.bLeft ?? Infinity)));
    const R = Math.max(...rows.map((r) => r.right));
    // フォントの違いで幅がわずかに伸びても折り返さないよう、文字の進む向きに余白をとる
    // 行はブラウザで折り返した位置で区切ってあるので、箱は広くてよい。アプリの書体の幅の違い（字間を読まない
    // Googleスライドでは palt で詰めたカッコが広がる）で最後の字だけ次の行へ落ちないよう、3割（最低24px）広げる
    const extra = slack ? Math.max(24, (R - L) * 0.3) : 0;
    const aligns = new Set(paras.map((p) => p.align));
    x0 = L - (aligns.has('center') || aligns.has('right') ? extra : 0);
    x1 = R + (aligns.size === 1 && aligns.has('right') ? 0 : extra);
    // 左寄せは、ページの右端を越えない範囲で広げる（中央・右寄せは位置が変わるので、そのまま）
    if (aligns.size === 1 && aligns.has('left')) x1 = Math.max(R + 12, Math.min(x1, 1276));
    y0 = Math.min(...rows.map((r) => r.top));
  }
  const W = x1 - x0;
  // PowerPoint は段落前の間隔を 1pt 単位に丸める。丸めた残りを次の行へ繰り越して、ずれを溜めない
  let placed = null;
  const out = rows.map((r, k) => {
    const prev = rows[k - 1];
    let gap = 0;
    if (prev) {
      const want = r.top - (placed + prev.height);
      gap = want > 0 ? Math.round(want * 0.75) / 0.75 : want;
    }
    placed = prev ? placed + prev.height + Math.max(0, gap) : r.top;
    let marL = 0, marR = 0, indent = 0;
    const align = r.p.align;
    if (align === 'center') {
      const c = (r.left + r.right) / 2 - x0;
      if (c <= W / 2) marR = W - 2 * c; else marL = 2 * c - W;
    } else if (align === 'right') {
      marR = x1 - r.right;
    } else {
      // 続きの行も、最初の行と同じ字下げにそろえる（ブラウザの行頭の位置）
      marL = r.left - x0;
      if (r.bLeft !== null) indent = r.bLeft - r.left;
    }
    // 間隔が負になる（行の高さが字の1.2倍より狭い）ときは、その行の行間を縮める
    const pct = gap < -0.5 ? Math.max(0.5, (r.height + gap) / r.height) : 1;
    return { align, marL: Math.max(0, marL), marR: Math.max(0, marR), indent, spcBef: Math.max(0, gap), pct, bullet: r.i === 0 ? r.p.bullet : null, lines: [r.l], size: r.size };
  });
  const tIns = Math.max(0, Math.min(...rows.map((r) => r.top)) - y0);
  const last = rows[rows.length - 1];
  const bx = box ? box : { x: x0, y: y0, w: W, h: last.top + last.height - y0 };
  return { box: bx, tIns, paras: out };
}

function runProps(st, extra = '', fit = 0) {
  const attrs = [`lang="ja-JP"`, `altLang="en-US"`, `sz="${Math.max(100, pt100(st.size))}"`, `b="${st.bold ? 1 : 0}"`, `i="${st.italic ? 1 : 0}"`];
  if (st.underline) attrs.push('u="sng"');
  if (st.strike) attrs.push('strike="sngStrike"');
  if (st.spacing || fit) attrs.push(`spc="${pt100(st.spacing + fit)}"`);
  if (st.baseline) attrs.push(`baseline="${st.baseline}"`);
  attrs.push('dirty="0"');
  const face = st.latin || (st.mono ? FONT.mono : FONT.sans);
  const ufill = st.underline && st.ucolor ? `<a:uFill>${fillXml(st.ucolor)}</a:uFill>` : '';
  return `<a:rPr ${attrs.join(' ')}>${fillXml({ color: st.color, alpha: st.alpha })}${ufill}<a:latin typeface="${face}"/><a:ea typeface="${FONT.sans}"/><a:cs typeface="${face}"/>${extra}</a:rPr>`;
}
// 行頭文字：丸・角・線は、ブラウザで描いた大きさになるよう文字の大きさを決める
function bulletXml(p) {
  const b = p.bullet;
  if (!b) return '<a:buNone/>';
  const textSize = p.size || p.lines[0].size;
  if (b.char) {
    const pct = Math.round(Math.max(25, Math.min(400, b.size / textSize * 100)) * 1000);
    return `<a:buClr>${srgb(b)}</a:buClr><a:buSzPct val="${pct}"/><a:buFont typeface="${b.mono ? FONT.mono : FONT.sans}"/><a:buChar char="${esc(b.char)}"/>`;
  }
  // 丸（●）・四角（■）・線（–）を、描いた幅になる大きさに
  const glyph = b.glyph || (b.shape === 'dot' ? '●' : b.shape === 'dash' ? '–' : '■');
  const size = b.glyphSize || b.w / 0.78;
  const pct = Math.round(Math.max(25, Math.min(98, size / textSize * 100)) * 1000);
  return `<a:buClr>${srgb(b)}</a:buClr><a:buSzPct val="${pct}"/><a:buFont typeface="${FONT.sans}"/><a:buChar char="${glyph}"/>`;
}
function lnSpc(p) {
  return `<a:spcPct val="${Math.round((p.pct || 1) * 100000)}"/>`;
}
function parasXml(laid, ctx) {
  return laid.paras.map((p) => {
    const ppr = [`algn="${p.align === 'center' ? 'ctr' : p.align === 'right' ? 'r' : 'l'}"`];
    if (p.marL) ppr.push(`marL="${e(p.marL)}"`);
    if (p.marR) ppr.push(`marR="${e(p.marR)}"`);
    ppr.push(`indent="${e(p.indent)}"`);
    let x = `<a:p><a:pPr ${ppr.join(' ')}><a:lnSpc>${lnSpc(p)}</a:lnSpc><a:spcBef><a:spcPts val="${pt100(p.spcBef)}"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft>${bulletXml(p)}</a:pPr>`;
    let lastStyle = null;
    p.lines.forEach((l, li) => {
      if (li > 0) x += `<a:br>${runProps(lastStyle || l.runs[0].style)}</a:br>`;
      for (const r of l.runs) {
        let link = '';
        if (r.style.href && /^https?:|^mailto:/.test(r.style.href)) link = `<a:hlinkClick r:id="${ctx.link(r.style.href)}"/>`;
        x += `<a:r>${runProps(r.style, link, r.fit || 0)}<a:t>${esc(r.text)}</a:t></a:r>`;
        lastStyle = r.style;
      }
    });
    x += `<a:endParaRPr lang="ja-JP" sz="${Math.max(100, pt100((lastStyle || p.lines[0].runs[0].style).size))}" dirty="0"/></a:p>`;
    return x;
  }).join('');
}
function txBody(laid, ctx, { lIns = 0, rIns = 0, bIns = 0, wrap = true } = {}) {
  return `<p:txBody><a:bodyPr wrap="${wrap ? 'square' : 'none'}" lIns="${e(lIns)}" tIns="${e(laid.tIns)}" rIns="${e(rIns)}" bIns="${e(bIns)}" rtlCol="0" anchor="t" anchorCtr="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${parasXml(laid, ctx)}</p:txBody>`;
}
// 図形の種類ごとの「文字を置ける範囲」。角丸・楕円は内側に寄るので、その分を差し引く
function presetTextInset(it) {
  if (it.geom === 'roundRect') { const r = Math.min(it.w, it.h) * (it.adj ?? 16667) / 100000; const d = r * 0.29289; return { l: d, t: d, r: d, b: d }; }
  if (it.geom === 'ellipse') return { l: it.w * 0.14645, t: it.h * 0.14645, r: it.w * 0.14645, b: it.h * 0.14645 };
  return { l: 0, t: 0, r: 0, b: 0 };
}

// ---------- 部品 ----------
const finite = (b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite);
export function itemXml(it0, ctx) {
  let it = it0;
  // 座標が壊れた部品（空のパスなど）は出さない。PowerPoint が「修復」を求めるため
  if (it.k !== 'group' && it.k !== 'table' && !finite(bounds(it))) { ctx.skipped = (ctx.skipped || 0) + 1; return ''; }
  const id = ctx.id();
  const name = esc(`${it.name || it.k} ${id}`);
  switch (it.k) {
    case 'shape': {
      let geom, x, y, w, h, rot = it.rot || 0;
      if (it.geom === 'path') {
        const b = bounds({ ...it, line: null });
        x = b.x; y = b.y; w = Math.max(b.w, 0.01); h = Math.max(b.h, 0.01);
        const W = Math.max(1, e(w)), H = Math.max(1, e(h));
        const P = (px_, py_) => `<a:pt x="${Math.round((px_ - x) * EMU)}" y="${Math.round((py_ - y) * EMU)}"/>`;
        let d = '';
        for (const s of it.path) {
          if (s.c === 'M') d += `<a:moveTo>${P(s.x, s.y)}</a:moveTo>`;
          else if (s.c === 'L') d += `<a:lnTo>${P(s.x, s.y)}</a:lnTo>`;
          else if (s.c === 'C') d += `<a:cubicBezTo>${P(s.x1, s.y1)}${P(s.x2, s.y2)}${P(s.x, s.y)}</a:cubicBezTo>`;
          else if (s.c === 'Z') d += '<a:close/>';
        }
        geom = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}"${it.fill ? '' : ' fill="none"'}>${d}</a:path></a:pathLst></a:custGeom>`;
      } else {
        ({ x, y, w, h } = it);
        geom = `<a:prstGeom prst="${it.geom}"><a:avLst>${it.geom === 'roundRect' ? `<a:gd name="adj" fmla="val ${it.adj ?? 16667}"/>` : ''}</a:avLst></a:prstGeom>`;
      }
      let body = '';
      if (it.text && (it.geom === 'roundRect' || it.geom === 'ellipse')) {
        // 角丸・楕円は文字を置ける範囲が内側に狭い。収まらなければ、同じ形の自由な図形にして、文字の範囲を図形いっぱいにする
        const ti = presetTextInset(it);
        const lines = it.text.paras.flatMap((p) => p.lines);
        const fits = lines.every((l) => l.right - l.left + Math.max(2, l.size * 0.15) <= w - ti.l - ti.r && l.left >= x + ti.l - 0.5 && l.right <= x + w - ti.r + 0.5) && Math.min(...lines.map((l) => l.top)) >= y + ti.t - 2;
        if (!fits) {
          const k = 0.5522847498;
          const r = it.geom === 'ellipse' ? null : Math.min(w, h) * (it.adj ?? 16667) / 100000;
          const P = (px_, py_) => `<a:pt x="${Math.round(px_ * EMU)}" y="${Math.round(py_ * EMU)}"/>`;
          let d;
          if (r === null) {
            const rx = w / 2, ry = h / 2;
            d = `<a:moveTo>${P(w, ry)}</a:moveTo><a:cubicBezTo>${P(w, ry + ry * k)}${P(rx + rx * k, h)}${P(rx, h)}</a:cubicBezTo><a:cubicBezTo>${P(rx - rx * k, h)}${P(0, ry + ry * k)}${P(0, ry)}</a:cubicBezTo><a:cubicBezTo>${P(0, ry - ry * k)}${P(rx - rx * k, 0)}${P(rx, 0)}</a:cubicBezTo><a:cubicBezTo>${P(rx + rx * k, 0)}${P(w, ry - ry * k)}${P(w, ry)}</a:cubicBezTo><a:close/>`;
          } else {
            d = `<a:moveTo>${P(r, 0)}</a:moveTo><a:lnTo>${P(w - r, 0)}</a:lnTo><a:cubicBezTo>${P(w - r + r * k, 0)}${P(w, r - r * k)}${P(w, r)}</a:cubicBezTo><a:lnTo>${P(w, h - r)}</a:lnTo><a:cubicBezTo>${P(w, h - r + r * k)}${P(w - r + r * k, h)}${P(w - r, h)}</a:cubicBezTo><a:lnTo>${P(r, h)}</a:lnTo><a:cubicBezTo>${P(r - r * k, h)}${P(0, h - r + r * k)}${P(0, h - r)}</a:cubicBezTo><a:lnTo>${P(0, r)}</a:lnTo><a:cubicBezTo>${P(0, r - r * k)}${P(r - r * k, 0)}${P(r, 0)}</a:cubicBezTo><a:close/>`;
          }
          geom = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${Math.max(1, e(w))}" h="${Math.max(1, e(h))}">${d}</a:path></a:pathLst></a:custGeom>`;
          it = { ...it, geom: 'rect' }; // 文字の範囲は四角と同じ
        }
      }
      if (it.text) {
        const ti = presetTextInset(it);
        const laid = layoutText(it.text.paras, { x, y, w, h }, { textInset: ti });
        // 図形の文字の範囲（角丸・楕円は内側に寄る）を基準に組んだので、余白は足さない
        body = txBody(laid, ctx, { lIns: 0, rIns: 0, bIns: 0 });
      }
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h, rot, it.flipV)}${geom}${fillXml(it.fill)}${lineXml(it.line)}${effectXml(it.shadow)}</p:spPr>${body}</p:sp>`;
    }
    case 'text': {
      const laid = layoutText(it.paras, null);
      const b = laid.box;
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(b.x, b.y, b.w, b.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>${txBody(laid, ctx)}</p:sp>`;
    }
    case 'image': {
      const rid = ctx.media(it);
      if (!rid) return '';
      const c = it.crop || {};
      const src = (c.l || c.t || c.r || c.b) ? `<a:srcRect l="${Math.round((c.l || 0) * 100000)}" t="${Math.round((c.t || 0) * 100000)}" r="${Math.round((c.r || 0) * 100000)}" b="${Math.round((c.b || 0) * 100000)}"/>` : '';
      const geom = it.geom === 'roundRect' ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${it.adj}"/></a:avLst></a:prstGeom>` : it.geom === 'ellipse' ? '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
      const alpha = it.alpha !== undefined && it.alpha < 0.999 ? `<a:alphaModFix amt="${Math.round(it.alpha * 100000)}"/>` : '';
      return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}">${alpha}</a:blip>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(it.x, it.y, it.w, it.h, it.rot || 0)}${geom}</p:spPr></p:pic>`;
    }
    case 'group': {
      const inner = it.items.map((c) => itemXml(c, ctx)).join('');
      const b = bounds({ ...it, items: it.items.filter((c) => c.k === 'group' || c.k === 'table' || finite(bounds(c))) });
      if (!b || !inner) return inner;
      const off = `<a:off x="${e(b.x)}" y="${e(b.y)}"/><a:ext cx="${Math.max(1, e(b.w))}" cy="${Math.max(1, e(b.h))}"/>`;
      return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>${off}<a:chOff x="${e(b.x)}" y="${e(b.y)}"/><a:chExt cx="${Math.max(1, e(b.w))}" cy="${Math.max(1, e(b.h))}"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`;
    }
    case 'table': return tableXml(it, ctx, id, name);
    default: return '';
  }
}

function borderXml(tag, b) {
  if (!b) return `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
  const dash = b.dash ? `<a:prstDash val="${b.dash}"/>` : '<a:prstDash val="solid"/>';
  return `<a:${tag} w="${e(b.w)}" cap="flat" cmpd="sng" algn="ctr">${fillXml(b.color)}${dash}<a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:${tag}>`;
}
function tableXml(t, ctx, id, name) {
  const W = t.cols.reduce((a, b) => a + b, 0), H = t.rows.reduce((a, b) => a + b, 0);
  let x = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`;
  x += `<p:xfrm><a:off x="${e(t.x)}" y="${e(t.y)}"/><a:ext cx="${e(W)}" cy="${e(H)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0"/><a:tblGrid>`;
  x += t.cols.map((w) => `<a:gridCol w="${e(w)}"/>`).join('') + '</a:tblGrid>';
  t.grid.forEach((row, ri) => {
    x += `<a:tr h="${e(t.rows[ri])}">`;
    row.forEach((c, ci) => {
      if (!c || c.merged) {
        const attrs = c ? `${c.hMerge ? ' hMerge="1"' : ''}${c.vMerge ? ' vMerge="1"' : ''}` : '';
        x += `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP" sz="100" dirty="0"/></a:p></a:txBody><a:tcPr marL="0" marR="0" marT="0" marB="0">${['lnL', 'lnR', 'lnT', 'lnB'].map((k) => borderXml(k, null)).join('')}<a:noFill/></a:tcPr></a:tc>`;
        return;
      }
      let body;
      let marT = 0;
      if (c.paras.length) {
        const laid = layoutText(c.paras, { x: c.x, y: c.y, w: c.w, h: c.h });
        marT = laid.tIns;
        body = `<a:txBody><a:bodyPr/><a:lstStyle/>${parasXml(laid, ctx)}</a:txBody>`;
      } else body = '<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP" sz="100" dirty="0"/></a:p></a:txBody>';
      const span = `${c.colspan > 1 ? ` gridSpan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowSpan="${c.rowspan}"` : ''}`;
      const bd = c.border;
      x += `<a:tc${span}>${body}<a:tcPr marL="0" marR="0" marT="${e(marT)}" marB="0" anchor="t">${borderXml('lnL', bd.l)}${borderXml('lnR', bd.r)}${borderXml('lnT', bd.t)}${borderXml('lnB', bd.b)}${fillXml(c.fill)}</a:tcPr></a:tc>`;
    });
    x += '</a:tr>';
  });
  return x + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
}

export function slideXml(scene, ctx) {
  const bg = scene.background ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${scene.background.toUpperCase()}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : '';
  const body = scene.items.map((it) => itemXml(it, ctx)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
