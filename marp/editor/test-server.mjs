// テスト用にエディターのサーバーを立ち上げる。
// MARP_BACKEND=rust のときは、Node のサーバーの代わりに Rust の互換層（marp-native --http）を立ち上げる。
// どちらも同じ形（URL を標準出力に出し、同じ API を返す）なので、テストの本体は変えずに切り替えられる。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
export const RUST_BIN = path.join(root, 'src-tauri', 'target', 'debug', 'marp-native');

export const backendName = () => (process.env.MARP_BACKEND === 'rust' ? 'rust' : 'node');

// 起動した子だけを片付ける。例外や SIGINT でも監視サーバーを残さない。
const children = new Set();
const cleanup = () => { for (const child of children) child.kill(); };
process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });

// 古い実行ファイルでテストを流さないよう、毎回ビルドする（差分が無ければすぐ終わる）
let built = false;
function ensureRustBinary() {
  if (built) return;
  built = true;
  try {
    // アプリに同梱する画面の JS を先に作る（無いとビルドが止まるため）
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts', 'bundle-client.mjs'), path.join(root, 'src-tauri', 'resources')], { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch { /* Node の束を作れなくても、あとで本体が作る */ }
    execFileSync('cargo', ['build', '--offline'], {
      cwd: path.join(root, 'src-tauri'),
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
    });
  } catch (e) {
    // 失敗したら止める（古い実行ファイルでテストを流さない）
    throw new Error(`Rust の実行ファイルを作れませんでした: ${String(e.message).split('\n')[0]}`);
  }
  if (!fs.existsSync(RUST_BIN)) throw new Error(`Rust の実行ファイルがありません: ${RUST_BIN}`);
}

// deckFile は slides.md の場所（フォルダを渡したときは slides.md を足す）
export async function startServer(deckFile, port, extraArgs = []) {
  const deckPath = deckFile.endsWith('.md') ? deckFile : path.join(deckFile, 'slides.md');
  const rust = backendName() === 'rust';
  if (rust) ensureRustBinary();
  const args = rust
    ? ['--http', deckPath, '--no-open', '--port', String(port), ...extraArgs]
    : [path.join(here, 'server.mjs'), deckPath, '--no-open', '--port', String(port), ...extraArgs];
  // キットの場所は MARP_ROOT で渡す（アプリの「覚える」処理を通さない。review-P4 の must 1）
  const server = spawn(rust ? RUST_BIN : process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MARP_ROOT: root, MARP_NO_HUB: '1' } });
  children.add(server);
  server.once('exit', () => children.delete(server));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.kill(); reject(new Error(`${rust ? 'Rust の互換層' : 'Node のサーバー'} の起動に時間がかかっています`)); }, rust ? 120000 : 30000);
    server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(timer); resolve(m[0]); } });
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
    server.on('exit', () => { clearTimeout(timer); reject(new Error(`${rust ? 'Rust の互換層' : 'Node のサーバー'} が終了しました`)); });
  });
  return { server, url, backend: rust ? 'rust' : 'node' };
}
