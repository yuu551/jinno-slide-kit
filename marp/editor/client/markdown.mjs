// 画面上で編集したテキストを、元のMarkdownの行へ書き戻すための処理。
// 行の対応は plugin.mjs の sourceMapPlugin が付ける data-line="開始-終了"（0始まり、終了は含まない）を使う。

// --- DOM → Markdown（インライン） ------------------------------------------------
// mode: 'block' は <br> を改行へ、'line'（見出し・表のセル）は <br> のまま残す。
// Marpは改行を「<br />＋改行文字」で出すので、テキスト中の改行文字は捨てる（描画上は空白にもならない）
export function inlineMarkdown(node, mode = 'block') {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { out += n.textContent.replace(/\n/g, '').replace(/\u00a0/g, ' ').replace(/</g, '&lt;'); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = n.tagName.toLowerCase();
    const inner = () => inlineMarkdown(n, mode);
    if (n.classList.contains('agenda-copy')) {
      // アジェンダは「章名」と「説明」に分けて描画しているので、Markdownでは1行目と2行目へ戻す
      const [title, desc] = [n.querySelector(':scope > strong'), n.querySelector(':scope > p')];
      out += (title ? inlineMarkdown(title, mode) : '') + (desc ? '\n' + inlineMarkdown(desc, mode) : '');
      continue;
    }
    if (tag === 'br') out += mode === 'block' ? '\n' : '<br>';
    else if (tag === 'strong' || tag === 'b') { const s = inner(); out += s.trim() ? `**${s}**` : s; }
    else if (tag === 'em' || tag === 'i') { const s = inner(); out += s.trim() ? `*${s}*` : s; }
    else if (tag === 'code') out += '`' + n.textContent + '`';
    else if (tag === 'a') out += `[${inner()}](${n.getAttribute('href') || ''})`;
    else if (tag === 'img') out += `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`;
    else if (tag === 'div' || tag === 'p') out += (out && !out.endsWith('\n') ? (mode === 'block' ? '\n' : '<br>') : '') + inner();
    else if (tag === 'svg') continue;
    else out += inner();
  }
  return out;
}

const escapeLineStart = (line) => (/^\s*([#>+\-*]|\d+[.)])\s/.test(line) ? '\\' + line.replace(/^\s+/, '') : line);

// --- 表の行 ------------------------------------------------------------------------
export function splitRow(line) {
  const lead = line.match(/^\s*/)[0];
  let s = line.trim();
  const hasLead = s.startsWith('|');
  const hasTrail = s.endsWith('|') && !s.endsWith('\\|');
  if (hasLead) s = s.slice(1);
  if (hasTrail) s = s.slice(0, -1);
  const cells = [];
  let cur = '', inCode = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (s[i] === '`') inCode = !inCode;
    if (s[i] === '|' && !inCode) { cells.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return { lead, cells, hasLead, hasTrail };
}
export function joinRow({ lead, cells, hasLead, hasTrail }) {
  return lead + (hasLead ? '|' : '') + cells.join('|') + (hasTrail ? '|' : '');
}

// --- 行頭の記法（見出し・リスト・話者・引用）を保ったまま置き換える ---------------------
function prefixes(orig, el) {
  const l0 = orig[0] ?? '';
  let m = l0.match(/^(\s*#{1,6}\s+)/);
  if (m) return { first: m[1], cont: m[1], heading: true };
  m = l0.match(/^(\s*(?:>\s?)+)/);
  if (m) return { first: m[1], cont: m[1] };
  m = l0.match(/^(\s*(?:[-*+]|\d+[.)])\s+)/);
  if (m) {
    let first = m[1];
    const rest = l0.slice(first.length);
    if (el.classList.contains('dialogue-bubble')) {
      // 「[right] 名前:」「[photo=figs/me.png] 名前:」の括弧も話者の一部として残す
      const sp = rest.match(/^((?:\[[^\]\n]*\]\s*)?[^:：\s\[][^:：]{0,15}[:：]\s*)/);
      if (sp) first += sp[1];
    }
    const cont = orig.length > 1 ? orig[1].match(/^\s*/)[0] : ' '.repeat(m[1].length);
    return { first, cont };
  }
  const ind = l0.match(/^\s*/)[0];
  return { first: ind, cont: orig.length > 1 ? orig[1].match(/^\s*/)[0] : ind };
}

// 編集した要素 el の内容で text を書き換えて返す。変更がなければ null。
export function applyElementEdit(text, el) {
  const lines = text.split('\n');
  const cell = el.closest('td, th');
  if (cell) {
    const tr = cell.closest('tr');
    const row = Number(tr?.dataset.line?.split('-')[0]);
    if (!Number.isFinite(row) || lines[row] === undefined) return null;
    const parsed = splitRow(lines[row]);
    const idx = cell.cellIndex;
    if (idx >= parsed.cells.length) return null;
    const md = inlineMarkdown(cell, 'line').replace(/\n/g, '<br>').replace(/(?<!\\)\|/g, '\\|').trim();
    const next = ` ${md} `;
    if (parsed.cells[idx].trim() === md) return null;
    parsed.cells[idx] = next;
    lines[row] = joinRow(parsed);
    return lines.join('\n');
  }
  const [s, e] = (el.dataset.line || '').split('-').map(Number);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const orig = lines.slice(s, e);
  const p = prefixes(orig, el);
  let replacement;
  if (p.heading || el.tagName === 'H1') {
    const md = inlineMarkdown(el, 'line').replace(/\n+/g, '<br>').trim();
    replacement = [p.first + md];
  } else {
    const md = inlineMarkdown(el, 'block').replace(/\n+$/g, '').replace(/^\n+/, '');
    replacement = md.split('\n').map((l, i) => (i ? p.cont : p.first) + (i || !p.first.trim() ? escapeLineStart(l) : l));
  }
  if (replacement.join('\n') === orig.join('\n')) return null;
  lines.splice(s, e - s, ...replacement);
  return lines.join('\n');
}

// --- スライドの範囲 ----------------------------------------------------------------
// 区切り線の行をMarkdownから探す（フロントマターとコードブロックは除く）
export function separatorLines(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0, fence = null;
  if (lines[0]?.trim() === '---') { i = 1; while (i < lines.length && lines[i].trim() !== '---') i++; out.push({ fm: true, line: i }); i++; }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (l.trim().startsWith(fence)) fence = null; continue; }
    if (!fence && /^---\s*$/.test(l)) out.push({ line: i });
  }
  return out;
}

export function rangesFromText(text) {
  const lines = text.split('\n');
  const seps = separatorLines(text);
  const ranges = [];
  let start = 0;
  let k = 0;
  if (seps[0]?.fm) { start = seps[0].line + 1; k = 1; }
  for (; k < seps.length; k++) { ranges.push({ start, end: seps[k].line }); start = seps[k].line + 1; }
  ranges.push({ start, end: lines.length });
  return ranges;
}

// --- スライド内の指示（_class・ノート・倍率・画像の高さ） ----------------------------------
const DIRECTIVE = /^\s*_?(class|chapter|chapters|footer|header|paginate|style|backgroundColor|backgroundImage|backgroundPosition|backgroundRepeat|backgroundSize|color|theme|size|headingDivider|marp|title|author|description|lang|math)\s*:/;
const isDirective = (body) => {
  const ls = body.split('\n').filter((l) => l.trim());
  return ls.length > 0 && ls.every((l) => DIRECTIVE.test(l));
};

export function readSlideMeta(lines) {
  const src = lines.join('\n');
  const cls = src.match(/<!--\s*_class:\s*([^]*?)\s*-->/);
  const notes = [];
  for (const m of src.matchAll(/<!--([^]*?)-->/g)) if (!isDirective(m[1])) notes.push(m[1].replace(/^\n|\n$/g, '').trim());
  const scales = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(\s*):::\s*(scale|dialogue|purpose|agenda|band|speech|scene|flow|compare|profile|links|prose|bullets)\b\s*(.*)$/);
    if (!m) return;
    const num = m[3].match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
    scales.push({ line: i, name: m[2], value: num ? Number(num[1]) : 1, rest: m[3].replace(/(?:^|\s)\d+(?:\.\d+)?(?=\s|$)/, '').trim(), indent: m[1] });
  });
  const images = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const h = m[1].match(/(?:^|\s)h(?:eight)?:(\d+)(?:px)?/);
      images.push({ line: i, alt: m[1], src: m[2], height: h ? Number(h[1]) : null, index: m.index, length: m[0].length });
    }
  });
  return { classes: cls ? cls[1].split(/\s+/).filter(Boolean) : [], notes, scales, images };
}

export function setSlideClasses(lines, classes) {
  const out = [...lines];
  const i = out.findIndex((l) => /<!--\s*_class:/.test(l));
  const line = classes.length ? `<!-- _class: ${classes.join(' ')} -->` : null;
  if (i >= 0) {
    if (line) out[i] = line;
    else { out.splice(i, 1); if (out[i] !== undefined && !out[i].trim() && (i === 0 || !out[i - 1]?.trim())) out.splice(i, 1); }
  } else if (line) {
    let at = 0;
    while (at < out.length && !out[at].trim()) at++;
    out.splice(at, 0, line, '');
  }
  return out;
}

export function setSlideNote(lines, note) {
  let src = lines.join('\n');
  const body = note.trim().replace(/-->/g, '-- >');
  let found = false;
  src = src.replace(/<!--([^]*?)-->/g, (m, inner) => {
    if (found || isDirective(inner)) return m;
    found = true;
    return body ? `<!--\n${body}\n-->` : '\u0000';
  });
  src = src.replace(/\n*\u0000\n*/g, '\n\n');
  if (!found && body) {
    const trail = src.match(/\n*$/)[0];
    src = src.replace(/\n*$/, '') + `\n\n<!--\n${body}\n-->` + (trail || '\n');
  }
  return src.split('\n');
}

export function setScale(lines, item, value) {
  const out = [...lines];
  const v = Math.round(value * 100) / 100;
  const parts = [item.name];
  if (!(item.name !== 'scale' && v === 1)) parts.push(String(v));
  if (item.rest) parts.push(item.rest);
  out[item.line] = `${item.indent}::: ${parts.join(' ')}`;
  return out;
}

export function setImageHeight(lines, img, height) {
  const out = [...lines];
  const l = out[img.line];
  const alt = img.height != null ? img.alt.replace(/(^|\s)h(?:eight)?:\d+(?:px)?/, `$1h:${height}`) : `h:${height}${img.alt ? ' ' + img.alt : ''}`;
  const seg = `![${alt}](${img.src})`;
  out[img.line] = l.slice(0, img.index) + seg + l.slice(img.index + img.length);
  return out;
}

// =====================================================================================
// Typora風の編集：編集中の要素には元のMarkdownをそのまま見せ、確定したらその区間だけを書き換える。
// editTarget(text, el) → { content, apply(value) → 新しい text | null, kind } | null
//   kind: 'cell'（表のセル）/ 'span'（部品の中の文字。data-span で行と桁を持つ）/ 'lines'（段落・見出し・リスト項目など）
// =====================================================================================
export function editTarget(text, el) {
  const lines = text.split('\n');
  const cell = el.closest('td, th');
  if (cell) {
    const tr = cell.closest('tr');
    const row = Number(tr?.dataset.line?.split('-')[0]);
    if (!Number.isFinite(row) || lines[row] === undefined) return null;
    const parsed = splitRow(lines[row]);
    const idx = cell.cellIndex;
    if (idx >= parsed.cells.length) return null;
    const content = parsed.cells[idx].trim().replace(/<br\s*\/?>/gi, '\n');
    return {
      kind: 'cell', content, row, col: idx,
      apply(value) {
        const v = value.replace(/\n+$/, '').replace(/\n/g, '<br>').replace(/(?<!\\)\|/g, '\\|').trim();
        if (v === parsed.cells[idx].trim()) return null;
        const p = splitRow(lines[row]);
        p.cells[idx] = ` ${v} `;
        const out = [...lines]; out[row] = joinRow(p);
        return out.join('\n');
      },
    };
  }
  if (el.dataset.span) {
    const m = el.dataset.span.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
    if (!m) return null;
    const [l1, c1, l2, c2] = m.slice(1).map(Number);
    const indent = ' '.repeat(Number(el.dataset.indent || 0));
    const seg = [];
    for (let l = l1; l <= l2; l++) {
      const s = l === l1 ? c1 : indent.length, e = l === l2 ? c2 : lines[l].length;
      seg.push(lines[l].slice(s, e));
    }
    const content = seg.join('\n');
    return {
      kind: 'span', content,
      apply(value) {
        const v = value.replace(/\n+$/, '');
        if (v === content) return null;
        const vs = v.split('\n');
        const head = lines[l1].slice(0, c1), tail = lines[l2].slice(c2);
        const repl = vs.map((x, i) => (i ? indent : head) + x);
        repl[repl.length - 1] += tail;
        const out = [...lines]; out.splice(l1, l2 - l1 + 1, ...repl);
        return out.join('\n');
      },
    };
  }
  const [s, e] = (el.dataset.line || '').split('-').map(Number);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const orig = lines.slice(s, e);
  const p = prefixes(orig, el);
  const heading = p.heading || el.tagName === 'H1';
  const body = orig.map((l, i) => (i === 0 ? l.slice(p.first.length) : l.startsWith(p.cont) ? l.slice(p.cont.length) : l.replace(/^\s+/, '')));
  const content = heading ? body.join(' ').replace(/<br\s*\/?>/gi, '\n') : body.join('\n');
  return {
    kind: 'lines', content, start: s, end: e, prefix: p,
    apply(value) {
      const v = value.replace(/\n+$/, '').replace(/^\n+/, '');
      if (v === content) return null;
      const repl = heading ? [p.first + v.split('\n').join('<br>')] : v.split('\n').map((l, i) => (i ? p.cont : p.first) + l);
      const out = [...lines]; out.splice(s, e - s, ...repl);
      return out.join('\n');
    },
  };
}

// --- リスト項目 ------------------------------------------------------------------------
const LIST_MARK = /^(\s*)([-*+]|(\d+)([.)]))(\s+)/;

// s行目から始まる項目の後ろへ、同じ深さ・同じ記号の空の項目を入れる。戻り値 { text, line }
export function insertListItemAfter(text, s, e, value = '') {
  const lines = text.split('\n');
  const m = lines[s].match(LIST_MARK);
  if (!m) return null;
  const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
  // 項目の終わり（続きの行と、より深い入れ子）まで進める
  let end = e;
  const depth = m[1].length;
  while (end < lines.length && lines[end].trim() && (lines[end].match(/^\s*/)[0].length > depth) && !/^:::/.test(lines[end].trim())) end++;
  lines.splice(end, 0, `${m[1]}${marker}${m[5]}${value}`);
  return { text: lines.join('\n'), line: end };
}

export function removeListItem(text, s, e) {
  const lines = text.split('\n');
  lines.splice(s, e - s);
  return lines.join('\n');
}

// 字下げ（delta=+1）／字下げの解除（-1）。入れ子の中身も一緒に動かす
export function indentListItem(text, s, e, delta) {
  const lines = text.split('\n');
  const m = lines[s].match(LIST_MARK);
  if (!m) return null;
  const step = m[3] ? 3 : 2;
  if (delta < 0 && m[1].length < step) return null;
  for (let i = s; i < e; i++) lines[i] = delta > 0 ? ' '.repeat(step) + lines[i] : lines[i].replace(new RegExp(`^ {${step}}`), '');
  return lines.join('\n');
}

// --- 表 -----------------------------------------------------------------------------
// row は表の中の行番号（ヘッダー行・区切り行を含む）。表の行範囲を返す
export function tableRange(text, row) {
  const lines = text.split('\n');
  let a = row, b = row;
  while (a > 0 && /^\s*\|/.test(lines[a - 1])) a--;
  while (b + 1 < lines.length && /^\s*\|/.test(lines[b + 1])) b++;
  return { start: a, end: b + 1 };
}
export function tableOp(text, row, col, op) {
  const lines = text.split('\n');
  const { start, end } = tableRange(text, row);
  const sepLine = start + 1;
  const width = splitRow(lines[start]).cells.length;
  const blankRow = (p) => joinRow({ ...p, cells: Array.from({ length: width }, () => '  ') });
  if (op === 'row-below' || op === 'row-above') {
    const at = op === 'row-below' ? Math.max(row, sepLine) + 1 : Math.max(row, sepLine + 1);
    lines.splice(at, 0, blankRow(splitRow(lines[start])));
    return { text: lines.join('\n'), row: at, col };
  }
  if (op === 'row-delete') {
    if (row <= sepLine || end - start <= 3) return null; // ヘッダーと最後の1行は消さない
    lines.splice(row, 1);
    return { text: lines.join('\n'), row: Math.min(row, end - 2), col };
  }
  if (op === 'col-right' || op === 'col-left' || op === 'col-delete') {
    if (op === 'col-delete' && width <= 1) return null;
    for (let i = start; i < end; i++) {
      const p = splitRow(lines[i]);
      const at = op === 'col-right' ? col + 1 : col;
      if (op === 'col-delete') p.cells.splice(col, 1);
      else p.cells.splice(at, 0, i === sepLine ? ' --- ' : '  ');
      lines[i] = joinRow(p);
    }
    return { text: lines.join('\n'), row, col: op === 'col-right' ? col + 1 : op === 'col-delete' ? Math.max(0, col - 1) : col };
  }
  return null;
}

// --- ページ（スライド）単位の操作 -------------------------------------------------------------
// head はフロントマター（と最初の区切りまで）、chunks は各ページの行。前後の空行は整える
export function splitSlides(text) {
  const lines = text.split('\n');
  const ranges = rangesFromText(text);
  const head = lines.slice(0, ranges[0].start);
  const trim = (arr) => { let a = 0, b = arr.length; while (a < b && !arr[a].trim()) a++; while (b > a && !arr[b - 1].trim()) b--; return arr.slice(a, b); };
  return { head, chunks: ranges.map((r) => trim(lines.slice(r.start, r.end))) };
}
export function joinSlides({ head, chunks }) {
  const h = [...head];
  while (h.length && !h[h.length - 1].trim()) h.pop();
  const body = chunks.map((c) => c.join('\n')).join('\n\n---\n\n');
  return (h.length ? h.join('\n') + '\n\n' : '') + body + '\n';
}
export function slideOp(text, op, i, j) {
  const d = splitSlides(text);
  const c = d.chunks;
  if (op === 'duplicate') c.splice(i + 1, 0, [...c[i]]);
  else if (op === 'delete') { if (c.length <= 1) return null; c.splice(i, 1); }
  else if (op === 'move') { if (j < 0 || j >= c.length || i === j) return null; const [x] = c.splice(i, 1); c.splice(j, 0, x); }
  else if (op === 'blank') c.splice(i + 1, 0, ['# 新しいページ', '', 'ここにリード文を書きます。']);
  else return null;
  return joinSlides(d);
}

// ページの本文の最後（末尾のノートのコメントより前）に行を足す
export function appendToSlide(text, range, newLines) {
  const lines = text.split('\n');
  let at = range.end;
  while (at > range.start && !lines[at - 1].trim()) at--;
  // 末尾がコメント（ノート）なら、その前へ
  if (at > range.start && /-->\s*$/.test(lines[at - 1])) {
    let k = at - 1;
    while (k > range.start && !/^\s*<!--/.test(lines[k])) k--;
    if (/^\s*<!--/.test(lines[k]) && !/^\s*<!--\s*_?(class|chapter|footer|header|paginate|style)\s*:/.test(lines[k])) {
      at = k;
      while (at > range.start && !lines[at - 1].trim()) at--;
    }
  }
  lines.splice(at, 0, '', ...newLines);
  return lines.join('\n');
}

// ページのタイトル（検索・一覧用）
export function slideTitles(text) {
  const lines = text.split('\n');
  return rangesFromText(text).map((r) => {
    const l = lines.slice(r.start, r.end).find((x) => /^#\s/.test(x));
    return l ? l.replace(/^#\s+/, '').replace(/<br\s*\/?>/g, ' ').replace(/\*\*/g, '') : '';
  });
}

// 複数ページの操作。indices は選んだページ（昇順でなくてよい）。to は移動先（元の並びでの位置。この位置の前へ入れる）
export function slidesOpMulti(text, op, indices, to) {
  const d = splitSlides(text);
  const c = d.chunks;
  const set = [...new Set(indices)].filter((i) => i >= 0 && i < c.length).sort((a, b) => a - b);
  if (!set.length) return null;
  if (op === 'delete') {
    if (set.length >= c.length) return null;
    d.chunks = c.filter((_, i) => !set.includes(i));
    return { text: joinSlides(d), current: Math.min(set[0], d.chunks.length - 1), selected: [] };
  }
  if (op === 'duplicate') {
    const copies = set.map((i) => [...c[i]]);
    const at = set[set.length - 1] + 1;
    c.splice(at, 0, ...copies);
    return { text: joinSlides(d), current: at, selected: copies.map((_, k) => at + k) };
  }
  if (op === 'move') {
    const moving = set.map((i) => c[i]);
    const rest = c.filter((_, i) => !set.includes(i));
    const at = to - set.filter((i) => i < to).length;
    rest.splice(at, 0, ...moving);
    d.chunks = rest;
    if (rest.every((x, i) => x === c[i])) return null;
    return { text: joinSlides(d), current: at, selected: moving.map((_, k) => at + k) };
  }
  return null;
}
