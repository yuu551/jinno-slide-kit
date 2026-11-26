// ライブラリー：Marpの資料を集めた場所。1つのライブラリー＝1つのフォルダ（多くは1つのGitリポジトリ）、1つの資料＝その下のフォルダ。
// 設定は ~/.config/jinno-marp/config.json。ライブラリーは複数持てる（例：登壇用と、お客様ごと）。
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rangesFromText } from '../editor/client/markdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const KIT = path.resolve(here, '..', '..');
export const CONFIG = process.env.JINNO_MARP_CONFIG || path.join(os.homedir(), '.config', 'jinno-marp', 'config.json');
export const DEFAULT_LIBRARY = path.join(os.homedir(), 'Slides');
const expand = (p) => path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));

export async function loadConfig() {
  try {
    const c = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
    c.libraries = (c.libraries || []).map((l) => ({ ...l, path: expand(l.path) }));
    if (!c.libraries.length) throw new Error('empty');
    return c;
  } catch {
    return { libraries: [{ id: 'slides', name: 'Slides', path: DEFAULT_LIBRARY }] };
  }
}
export async function saveConfig(c) {
  await fs.mkdir(path.dirname(CONFIG), { recursive: true });
  const out = { ...c, libraries: c.libraries.map((l) => ({ ...l, path: l.path.replace(os.homedir(), '~') })) };
  await fs.writeFile(CONFIG, JSON.stringify(out, null, 2) + '\n');
}
export async function existingFolder(input) {
  if (typeof input!=='string'||!input.trim()||(!path.isAbsolute(input)&&input!=='~'&&!input.startsWith('~/'))) throw new Error('フォルダを選ぶか、/ または ~/ で始まる場所を指定してください');
  const abs=await fs.realpath(expand(input)).catch(()=>{throw new Error('フォルダが見つかりません。場所を確かめてください');});
  if(!(await fs.stat(abs)).isDirectory())throw new Error('フォルダを選んでください');
  return abs;
}

export async function addLibrary(p, name) {
  const c = await loadConfig();
  const abs = await existingFolder(p);
  if (!c.libraries.some((l) => l.path === abs)) {
    const id = slugify(name || path.basename(abs)) || `lib${c.libraries.length + 1}`;
    c.libraries.push({ id: c.libraries.some((l) => l.id === id) ? `${id}-${c.libraries.length + 1}` : id, name: name || path.basename(abs), path: abs });
    await saveConfig(c);
  }
  return c;
}

export function slugify(s) {
  return String(s).normalize('NFKC').trim().replace(/[\s/\\:*?"<>|#%]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
}

// フロントマターの簡易な読み取り（key: value と key: [a, b]）
export function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else { try { if (v.startsWith('"')) v = JSON.parse(v); else v = v.replace(/^'|'$/g, '').replaceAll("''", "'"); } catch { v = v.replace(/^["']|["']$/g, ''); } }
    fm[kv[1]] = v;
  }
  return fm;
}

export async function deckInfo(lib, slug) {
  const dir = path.join(lib.path, slug);
  const file = path.join(dir, 'slides.md');
  const [text, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
  const fm = frontMatter(text);
  const firstH1 = text.match(/^#\s+(.+)$/m)?.[1].replace(/<br\s*\/?>/g, ' ').replace(/\*\*/g, '') || slug;
  let figMtime = 0;
  try { for (const f of await fs.readdir(path.join(dir, 'figs'))) { const s = await fs.stat(path.join(dir, 'figs', f)); if (s.mtimeMs > figMtime) figMtime = s.mtimeMs; } } catch {}
  return {
    slug, dir, lib: lib.id,
    title: fm.title || firstH1,
    theme: fm.theme || 'default',
    tags: Array.isArray(fm.tags) ? fm.tags : fm.tags ? String(fm.tags).split(/[,、]/).map((x) => x.trim()).filter(Boolean) : [],
    event: fm.event || '',
    author: fm.author || '',
    date: fm.date || '',
    pages: rangesFromText(text).length,
    updated: Math.max(st.mtimeMs, figMtime),
    archived: slug.startsWith('_archive/'),
  };
}

// 資料の一覧（ライブラリー直下と _archive/ の下の、slides.md を持つフォルダ）
export async function listDecks(lib, { archived = false } = {}) {
  const out = [];
  const scan = async (base, prefix) => {
    let ents = [];
    try { ents = await fs.readdir(base, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.name === '_archive' && !prefix) { if (archived) await scan(path.join(base, e.name), '_archive/'); continue; }
      if (fss.existsSync(path.join(base, e.name, 'slides.md'))) {
        try { out.push(await deckInfo(lib, prefix + e.name)); } catch {}
      }
    }
  };
  await scan(lib.path, '');
  return out.sort((a, b) => b.updated - a.updated);
}

const uniqueSlug = (lib, want) => {
  let s = slugify(want) || 'new-deck', n = 2;
  const base = s;
  while (fss.existsSync(path.join(lib.path, s))) s = `${base}-${n++}`;
  return s;
};

export async function templateCatalog() {
  const list=[];
  for (const dir of ['talk', 'update', 'release', 'webinar', 'lightning']) {
    const base=path.join(KIT,'marp/templates',dir);
    const meta=JSON.parse(await fs.readFile(path.join(base,'template.json'),'utf8'));
    const text=await fs.readFile(path.join(base,'slides.md'),'utf8');
    list.push({...meta,dir,text});
  }
  list.push({name:'blank',dir:'',description:'白紙の1ページから始めます',defaultTitle:'新しい資料',text:'---\nmarp: true\ntheme: paper\npaginate: true\ntitle: "{{TITLE}}"\n---\n\n# {{TITLE}}\n'});
  return list;
}

export async function createDeck(lib, { slug, title, theme, template = 'talk' }) {
  const tpl=(await templateCatalog()).find(t=>t.name===template||t.dir===template);
  if (!tpl) throw new Error('型を選んでください');
  if (theme && !(await fs.readdir(path.join(KIT,'marp/themes'))).includes(theme+'.css')) throw new Error('テーマを選んでください');
  title ||= tpl.defaultTitle;
  const s = uniqueSlug(lib, slug || title || 'new-deck'), dir=path.join(lib.path,s);
  if (tpl.dir) await fs.cp(path.join(KIT,'marp/templates',tpl.dir),dir,{recursive:true,filter:p=>!p.includes('.check')&&!path.basename(p).startsWith('.render')&&path.basename(p)!=='template.json'&&!p.includes('__pycache__')});
  else await fs.mkdir(dir,{recursive:true});
  let text=tpl.text.replace(/^title: "\{\{TITLE\}\}"/m,`title: ${JSON.stringify(title.replace(/<br\s*\/?>/g,' '))}`).replaceAll('{{TITLE}}',title);
  if(theme) text=text.replace(/^theme: .*/m,`theme: ${theme}`);
  await fs.writeFile(path.join(dir,'slides.md'),text);
  return s;
}

export async function duplicateDeck(lib, slug) {
  const s = uniqueSlug(lib, `${path.basename(slug)}-copy`);
  await fs.cp(path.join(lib.path, slug), path.join(lib.path, s), { recursive: true, filter: (p) => !/[/\\](\.check|dist|\.editor-history)([/\\]|$)/.test(p) });
  return s;
}

export function withTitle(text, title) {
  const value = JSON.stringify(String(title).trim());
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm) return `---\nmarp: true\ntitle: ${value}\n---\n${text}`;
  const body = /^title:/m.test(fm[1]) ? fm[1].replace(/^title:.*$/m, `title: ${value}`) : fm[1]+`\ntitle: ${value}`;
  return `---\n${body}\n---\n${text.slice(fm[0].length)}`;
}

export async function renameDeck(lib, slug, to, title) {
  const name = slugify(to || path.basename(slug));
  if (!name) throw new Error('名前を入れてください');
  const s = slug.startsWith('_archive/') ? `_archive/${name}` : name;
  const from = path.join(lib.path, slug), dest = path.join(lib.path, s);
  if (s !== slug && fss.existsSync(dest)) throw new Error('同じ名前の資料があります');
  const file = path.join(from, 'slides.md'), original = await fs.readFile(file, 'utf8');
  if (title !== undefined && !String(title).trim()) throw new Error('題名を入れてください');
  // ファイルを同じフォルダの一時名へ書き、入れ替えてからフォルダを動かす。
  const write = async text => { const tmp = file+`.rename-${process.pid}.tmp`; try { await fs.writeFile(tmp,text); await fs.rename(tmp,file); } finally { await fs.rm(tmp,{force:true}); } };
  if (title !== undefined) await write(withTitle(original, title));
  try { if (s !== slug) await fs.rename(from, dest); }
  catch (e) { if (title !== undefined) await write(original); throw e; }
  return s;
}

export async function trashDeck(lib, slug) {
  const trash = path.join(os.homedir(), '.Trash');
  await fs.mkdir(trash, {recursive:true});
  const from=path.join(lib.path,slug), name=path.basename(slug);
  let dest=path.join(trash,name), n=2;
  while (fss.existsSync(dest)) dest=path.join(trash,`${name}-${n++}`);
  await fs.rename(from,dest);
  return dest;
}

export async function archiveDeck(lib, slug, restore = false) {
  const name = path.basename(slug);
  const from = path.join(lib.path, slug);
  const to = restore ? path.join(lib.path, name) : path.join(lib.path, '_archive', name);
  if (fss.existsSync(to)) throw new Error('移動先に同じ名前の資料があります');
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return restore ? name : `_archive/${name}`;
}

// 別の場所にある Marp の資料フォルダ（slides.md と figs/）を取り込む。元は消さない
export async function importFolder(lib, src, slug) {
  src=await existingFolder(src);
  if (!fss.existsSync(path.join(src, 'slides.md'))) throw new Error('slides.md がありません');
  const s = uniqueSlug(lib, slug || path.basename(src));
  const dest=path.join(await fs.realpath(lib.path),s);
  if(dest.startsWith(src+path.sep))throw new Error('取り込む資料の中にコピー先を作ることはできません');
  await fs.cp(src, path.join(lib.path, s), { recursive: true, filter: (p) => !/[/\\](\.check|dist|\.editor-history|node_modules)([/\\]|$)/.test(p) && !/\.render-.*\.html$/.test(p) });
  return s;
}

export async function revealDeck(lib, slug) {
  await new Promise((resolve,reject) => execFile('/usr/bin/open', ['-R',path.join(lib.path,slug)], e=>e?reject(e):resolve()));
}
