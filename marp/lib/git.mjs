// Git の操作。ライブラリー（1つのリポジトリ）の中で、資料のフォルダ単位に commit・log・restore する。
// リモートとのやり取り（fetch・pull・push）はリポジトリ単位。pull は fast-forward のみ（食い違いは自動で直さない）。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export class GitError extends Error {
  constructor(message, detail = '') { super(message); this.detail = detail; }
}

function git(cwd, args, { input, timeout = 60000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout, maxBuffer: 256 << 20, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env } }, (err, stdout, stderr) => {
      if (err) return reject(new GitError(explain(String(stderr) || err.message), String(stderr)));
      resolve(stdout);
    });
    if (input != null) child.stdin.end(input);
  });
}
const text = async (cwd, args, o) => String(await git(cwd, args, o));

// よくあるエラーを日本語で説明する
function explain(msg) {
  if (/not a git repository/i.test(msg)) return 'Gitのリポジトリではありません';
  if (/nothing to commit|no changes added/i.test(msg)) return 'コミットする変更がありません';
  if (/Please tell me who you are|user\.email/i.test(msg)) return 'Gitのユーザー名とメールアドレスが設定されていません（git config user.name / user.email）';
  if (/Not possible to fast-forward|diverged|non-fast-forward|fetch first/i.test(msg)) return '手元とリモートの履歴が食い違っています。ターミナルで git pull --rebase などを使って解消してください';
  if (/Could not read from remote|Authentication failed|Permission denied|could not resolve host/i.test(msg)) return 'リモートに接続できません（認証かネットワークを確認してください）';
  if (/no upstream|has no upstream/i.test(msg)) return 'リモートのブランチが設定されていません';
  if (/does not appear to be a git repository|No such remote/i.test(msg)) return 'リモートが設定されていません';
  return msg.trim().split('\n').slice(-3).join(' ');
}

export async function repoRoot(dir) {
  try { return (await text(dir, ['rev-parse', '--show-toplevel'])).trim(); } catch { return null; }
}

// 資料のフォルダ（dir）の変更。dir を省略するとリポジトリ全体
export async function status(root, dir = '.') {
  const out = await text(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', dir]);
  const files = [];
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const code = p.slice(0, 2), file = p.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // 移動は元の名前が続く
    files.push({ code, file, kind: code === '??' ? 'added' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified' });
  }
  return { files, count: files.length };
}

export async function branchInfo(root) {
  const info = { branch: null, upstream: null, ahead: 0, behind: 0, remote: null, head: null };
  try { info.branch = (await text(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch {}
  try { info.head = (await text(root, ['rev-parse', '--short', 'HEAD'])).trim(); } catch {}
  try { info.remote = (await text(root, ['remote', 'get-url', 'origin'])).trim(); } catch {}
  try {
    info.upstream = (await text(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    const [behind, ahead] = (await text(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).trim().split(/\s+/).map(Number);
    Object.assign(info, { ahead, behind });
  } catch {}
  return info;
}

// dir の変更だけをコミットする（ほかの資料の変更は含めない）
export async function commit(root, dir, message) {
  if (!message?.trim()) throw new GitError('コミットのメッセージを入れてください');
  await git(root, ['add', '-A', '--', dir]);
  const staged = (await text(root, ['diff', '--cached', '--name-only', '--', dir])).trim();
  if (!staged) throw new GitError('コミットする変更がありません');
  await git(root, ['commit', '-m', message.trim(), '--only', '--', dir]);
  return (await text(root, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function log(root, dir = '.', limit = 200) {
  let out;
  try { out = await text(root, ['log', `-n${limit}`, '--date=iso-strict', '--format=%x1e%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--shortstat', '--', dir]); } catch (e) { if (/does not have any commits/i.test(e.detail)) return []; throw e; }
  return out.split('\x1e').filter((s) => s.trim()).map((rec) => {
    const [head, ...rest] = rec.split('\n');
    const [hash, short, author, date, subject] = head.split('\x1f');
    const stat = rest.join(' ').trim();
    return { hash, short, author, date, subject, stat };
  });
}

// ある版のファイル（なければ null）
export function validRev(rev) {
  const v = String(rev || '').trim();
  if (!v || v.length > 64 || v.startsWith('-')) return false;
  if (v === 'HEAD' || /^HEAD~[0-9]+$/.test(v)) return true;
  return v.length >= 4 && v.length <= 64 && /^[0-9a-f]+$/i.test(v);
}

export async function show(root, rev, file) {
  if (!validRev(rev)) return null;
  try { return await git(root, ['show', '--end-of-options', `${rev}:${file}`]); } catch { return null; }
}

export async function parentOf(root, rev) {
  if (!validRev(rev)) return null;
  try { return (await text(root, ['rev-parse', `${rev}^`])).trim(); } catch { return null; }
}

// dir を rev の状態へ戻す（作業ツリーだけ。コミットは別に行う）。rev のあとに足したファイルは消す
export async function restore(root, dir, rev) {
  if (!validRev(rev)) throw new GitError('版の指定が正しくありません');
  await git(root, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]);
  const tracked = (await text(root, ['ls-tree', '-r', '--name-only', rev, '--', dir])).split('\n').filter(Boolean);
  if (!tracked.length) throw new GitError('その版にはこの資料がありません');
  const now = (await text(root, ['ls-files', '--', dir])).split('\n').filter(Boolean);
  await git(root, ['checkout', rev, '--', dir]);
  for (const f of now) if (!tracked.includes(f)) await fs.rm(path.join(root, f), { force: true });
  await git(root, ['reset', '-q', '--', dir]); // ステージは空に戻す
}

export async function fetchRemote(root) { await git(root, ['fetch', '--prune'], { timeout: 120000 }); return branchInfo(root); }
export async function pull(root) { await git(root, ['pull', '--ff-only'], { timeout: 120000 }); return branchInfo(root); }
export async function push(root) {
  const b = await branchInfo(root);
  if (!b.remote) throw new GitError('リモートが設定されていません');
  if (b.upstream) await git(root, ['push'], { timeout: 120000 });
  else await git(root, ['push', '-u', 'origin', 'HEAD'], { timeout: 120000 });
  return branchInfo(root);
}
export async function setRemote(root, url) {
  const b = await branchInfo(root);
  await git(root, b.remote ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  return branchInfo(root);
}

export const GITIGNORE = ['.check/', 'dist/', '.render-*.html', '.editor-history/', '.editor-check-*.md', '.agent-notes.json', 'node_modules/', '.DS_Store', ''].join('\n');

export async function init(root, { message = 'ライブラリーを作成' } = {}) {
  await fs.mkdir(root, { recursive: true });
  if (!(await repoRoot(root)) || (await repoRoot(root)) !== path.resolve(root)) {
    await git(root, ['init', '-b', 'main']);
  }
  const gi = path.join(root, '.gitignore');
  try { await fs.access(gi); } catch { await fs.writeFile(gi, GITIGNORE); }
  await git(root, ['add', '-A']);
  const staged = (await text(root, ['diff', '--cached', '--name-only'])).trim();
  if (staged) await git(root, ['commit', '-m', message]);
  return branchInfo(root);
}
