// Rust の HTTP の互換層が配る JS を作る（画面は esbuild で1つにまとめて配っている）。
// Rust 側（src-tauri/src/http.rs）が必要なときに呼ぶ。手で流すこともできる。
//
// usage: node scripts/bundle-client.mjs <outdir>
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { prepareExportTemplates } from './prepare-export-templates.mjs';
await prepareExportTemplates();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/bundle-client.mjs <outdir>');
  process.exit(1);
}
await fs.mkdir(out, { recursive: true });
const jobs = [
  ['marp/editor/client/main.mjs', 'app.js'],
  ['marp/editor/client/render-worker.mjs', 'render-worker.js'],
  ['marp/editor/client/present-app.mjs', 'present.js'],
  ['marp/hub/client/hub.mjs', 'hub.js'],
  ['marp/export/client.mjs', 'export.js'],
];
for (const [entry, name] of jobs) {
  const r = await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, format: name === 'render-worker.js' ? 'iife' : 'esm', platform: 'browser',
    minify: true, write: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
  });
  await fs.writeFile(path.join(out, name), r.outputFiles[0].text);
}
