// 版の比較に使う差分の計算。Node（履歴の記録）とブラウザ（エディター・ハブの比較画面）の両方で使う。
import { splitSlides } from '../editor/client/markdown.mjs';

// ページの対応を最長共通部分列で取る（ページを挿入しても後ろのページが全部「変更」にならないように）。
// a・b はページごとの文字列。戻り値は { t: 'same' | 'mod' | 'add' | 'del', a?, b? } の並び
export function alignPages(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: 'same', a: i++, b: j++ }); continue; }
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push({ t: 'add', b: j++ });
    else ops.push({ t: 'del', a: i++ });
  }
  // 削除と追加が隣り合っていれば「変更」にまとめる
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k], nx = ops[k + 1];
    if (o.t === 'del' && nx?.t === 'add') { out.push({ t: 'mod', a: o.a, b: nx.b }); k++; }
    else if (o.t === 'add' && nx?.t === 'del') { out.push({ t: 'mod', a: nx.a, b: o.b }); k++; }
    else out.push(o);
  }
  return out;
}

// ページごとの本文（前後の空行は比べない）
export const pagesOf = (text) => (text ? splitSlides(text).chunks.map((c) => c.join('\n').trim()) : []);

// 2つの版の変わったページの数
export function pageDelta(before, after) {
  const ops = alignPages(pagesOf(before), pagesOf(after));
  const d = { mod: 0, add: 0, del: 0 };
  for (const o of ops) if (o.t !== 'same') d[o.t]++;
  return d;
}

// 行の差分（ページの中の文字の比較に使う）。{ t: ' ' | '-' | '+', s } の並び
export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) out.push({ t: '+', s: B[j++] });
    else out.push({ t: '-', s: A[i++] });
  }
  return out;
}
