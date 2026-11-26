// 資料ごとのローカル履歴。Git がなくても版を残して、比べて、戻せる。
//
// 置き場所はデッキのフォルダの .editor-history/（Git には入れない）
//   index.json      版の一覧（新しいものが後ろ）
//   objects/<sha1>  中身（同じ内容は1回だけ置く）
//
// 記録するもの（kind）
//   open      エディターで開いたとき（前の版と違えば）
//   save      エディターで保存したとき
//   external  エディター以外（Claude・ほかのエディター・生成スクリプト）で slides.md が変わったとき
//   figure    図（figs/）が変わったとき。どの図がどう変わったかを figures に持つ
//   restore   版を戻したとき
//   named     名前を付けて残した版（間引かない）
//
// 間引き：直近1日はすべて、1週間までは1時間に1つ、それより前は1日に1つ。名前付きの版と直近30件は残す。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pageDelta, pagesOf } from './diff.mjs';

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const KEEP_RECENT = 30;
const HOUR = 3600e3, DAY = 24 * HOUR;

export function openHistory(deckDir, deckFile = 'slides.md') {
  const dir = path.join(deckDir, '.editor-history');
  const objDir = path.join(dir, 'objects');
  const indexFile = path.join(dir, 'index.json');
  let entries = null;
  let queue = Promise.resolve(); // 書き込みを1本ずつ

  async function load() {
    if (entries) return entries;
    await fsp.mkdir(objDir, { recursive: true });
    try { entries = JSON.parse(await fsp.readFile(indexFile, 'utf8')).entries || []; } catch { entries = []; }
    await migrateLegacy();
    return entries;
  }
  // 以前の形式（保存の直前の版を <日時>.md で残していた）を取り込む
  async function migrateLegacy() {
    const olds = (await fsp.readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}T.*\.md$/.test(f)).sort();
    if (!olds.length) return;
    let prev = null;
    for (const f of olds) {
      const text = await fsp.readFile(path.join(dir, f), 'utf8');
      const iso = f.replace(/\.md$/, '').replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      const h = await putObject(text);
      if (h !== prev) entries.push(entry({ kind: 'save', label: '保存（以前の履歴から取り込み）', hash: h, text, time: new Date(iso).toISOString() }));
      prev = h;
      await fsp.rm(path.join(dir, f), { force: true });
    }
    entries.sort((a, b) => a.time.localeCompare(b.time));
    await writeIndex();
  }

  async function putObject(content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const h = sha1(buf);
    const f = path.join(objDir, h);
    if (!fs.existsSync(f)) await fsp.writeFile(f, buf);
    return h;
  }
  const readObject = (h) => fsp.readFile(path.join(objDir, h));
  // 書く前にファイルを読み直して、ほかのプロセス（同じ資料を開いた別のエディター・送り出し）の記録と合わせる
  const removed = new Set();
  async function writeIndex() {
    let disk = [];
    try { disk = JSON.parse(await fsp.readFile(indexFile, 'utf8')).entries || []; } catch {}
    const byId = new Map(disk.filter((e) => !removed.has(e.id)).map((e) => [e.id, e]));
    for (const e of entries) byId.set(e.id, e);
    entries = [...byId.values()].sort((a, b) => a.time.localeCompare(b.time));
    const tmp = `${indexFile}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 1));
    await fsp.rename(tmp, indexFile);
  }
  function entry({ kind, label = '', hash, text, time, figures, delta }) {
    const title = text.match(/^---\n[\s\S]*?^title:\s*"?(.+?)"?\s*$/m)?.[1] || '';
    return { id: `${Date.parse(time || new Date().toISOString()).toString(36)}-${crypto.randomBytes(3).toString('hex')}`, time: time || new Date().toISOString(), kind, label, hash, pages: pagesOf(text).length, title, ...(figures ? { figures } : {}), ...(delta ? { delta } : {}) };
  }
  const latestDeck = () => [...entries].reverse().find((e) => e.hash);

  // slides.md の版を残す。前の版と同じなら何もしない（名前付きは同じでも残す）
  function record(text, { kind = 'save', label = '' } = {}) {
    const job = queue.then(async () => {
      await load();
      const h = await putObject(text);
      const last = latestDeck();
      if (last && last.hash === h && kind !== 'named') return null;
      const prevText = last ? (await readObject(last.hash)).toString() : '';
      const e = entry({ kind, label, hash: h, text, delta: last ? pageDelta(prevText, text) : null });
      entries.push(e);
      prune();
      await writeIndex();
      return e;
    });
    queue = job.catch(() => {});
    return job;
  }

  // 図の変更を残す。changes は [{ path, before: Buffer|null, after: Buffer|null }]
  function recordFigures(changes, { kind = 'figure', label = '' } = {}) {
    const job = queue.then(async () => {
      await load();
      const figures = [];
      for (const c of changes) {
        const before = c.before ? await putObject(c.before) : null;
        const after = c.after ? await putObject(c.after) : null;
        if (before !== after) figures.push({ path: c.path, before, after });
      }
      if (!figures.length) return null;
      const last = latestDeck();
      const text = last ? (await readObject(last.hash)).toString() : '';
      const e = entry({ kind, label: label || (figures.length === 1 ? figures[0].path : `図 ${figures.length}枚`), hash: last?.hash || null, text, figures });
      entries.push(e);
      prune();
      await writeIndex();
      return e;
    });
    queue = job.catch(() => {});
    return job;
  }

  function prune() {
    const now = Date.now();
    const keep = new Set(entries.slice(-KEEP_RECENT).map((e) => e.id));
    const buckets = new Set();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === 'named' || keep.has(e.id)) continue;
      const age = now - Date.parse(e.time);
      if (age < DAY) continue;
      const key = age < 7 * DAY ? `h${Math.floor(Date.parse(e.time) / HOUR)}` : `d${Math.floor(Date.parse(e.time) / DAY)}`;
      if (buckets.has(key)) { removed.add(e.id); entries.splice(i, 1); } else buckets.add(key);
    }
  }
  // どの版からも指されていない中身を消す
  async function gc() {
    await load();
    const used = new Set();
    for (const e of entries) { if (e.hash) used.add(e.hash); for (const f of e.figures || []) { if (f.before) used.add(f.before); if (f.after) used.add(f.after); } }
    for (const f of await fsp.readdir(objDir)) if (!used.has(f)) await fsp.rm(path.join(objDir, f), { force: true });
  }

  return {
    dir,
    record,
    recordFigures,
    gc,
    async list() {
      await load();
      // ほかのプロセスが足した版も見えるように、ファイルの内容と合わせる
      try {
        const disk = JSON.parse(await fsp.readFile(indexFile, 'utf8')).entries || [];
        const byId = new Map(entries.map((e) => [e.id, e]));
        for (const e of disk) if (!byId.has(e.id) && !removed.has(e.id)) byId.set(e.id, e);
        entries = [...byId.values()].sort((a, b) => a.time.localeCompare(b.time));
      } catch {}
      return [...entries].reverse();
    },
    async get(id) { await load(); return entries.find((e) => e.id === id) || null; },
    async text(id) { await load(); const e = entries.find((x) => x.id === id); return e?.hash ? (await readObject(e.hash)).toString() : null; },
    async object(h) { if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('不正な指定です'); return readObject(h); },
    async rename(id, label) { await load(); const e = entries.find((x) => x.id === id); if (!e) return null; e.label = label; if (label && e.kind !== 'named') e.kind = 'named'; await writeIndex(); return e; },
  };
}
