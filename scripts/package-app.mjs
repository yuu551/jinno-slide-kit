// 配布する画面・テーマ・雛形をビルド時に固定する。元のキットには書き込まない。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { prepareExportTemplates } from './prepare-export-templates.mjs';
await prepareExportTemplates();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src-tauri/resources/kit');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const excluded = new Set(['.check', 'dist', '.editor-history', '.DS_Store', '__pycache__']);
for (const rel of ['marp/themes', 'marp/templates', 'marp/editor/client', 'marp/hub/client', 'marp/export']) {
  await fs.cp(path.join(root, rel), path.join(out, rel), { recursive: true, filter: src => !src.split(path.sep).some(p => excluded.has(p) || p.startsWith('.render-')) });
}
await fs.cp(path.join(root, 'node_modules/svgedit/dist/editor'), path.join(out, 'node_modules/svgedit/dist/editor'), {
  recursive: true, filter: src => !src.endsWith('.map'),
});
await fs.copyFile(path.join(root, 'node_modules/svgedit/LICENSE-MIT.txt'), path.join(out, 'node_modules/svgedit/LICENSE-MIT.txt'));
await fs.mkdir(path.join(out,'licenses'),{recursive:true});
await fs.copyFile(path.join(root,'node_modules/@marp-team/marp-cli/LICENSE'),path.join(out,'licenses/marp-cli-LICENSE'));
await fs.copyFile(path.join(root,'node_modules/@marp-team/marp-cli/lib/bespoke.js.LICENSE.txt'),path.join(out,'licenses/bespoke-LICENSE.txt'));
const entries = { app: 'marp/editor/client/main.mjs', present: 'marp/editor/client/present-app.mjs', hub: 'marp/hub/client/hub.mjs', export: 'marp/export/client.mjs' };
const clientBundle = await esbuild.build({ metafile: true, entryPoints: Object.fromEntries(Object.entries(entries).map(([name, rel]) => [name, path.join(root, rel)])),
  outdir: path.join(out, '.check/rust-bundle'), bundle: true, format: 'esm', platform: 'browser', splitting: true, chunkNames: 'chunks/[name]-[hash]',
  minify: true, logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' },
});
const workerBundle = await esbuild.build({ metafile: true, entryPoints: [path.join(root, 'marp/editor/client/render-worker.mjs')],
  outfile: path.join(out, '.check/rust-bundle/render-worker.js'), bundle: true, format: 'iife', platform: 'browser',
  minify: true, logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' },
});
// Keep the upstream notices beside the JavaScript shipped in the local app bundle.
const packages = new Set(['svgedit', '@marp-team/marp-cli'].map(name => path.join(root, 'node_modules', name)));
const inputs = [...Object.keys(clientBundle.metafile.inputs), ...Object.keys(workerBundle.metafile.inputs)];
for (const input of inputs) {
  if (input.startsWith('(disabled):')) continue;
  const resolved = path.resolve(input);
  const packagePath = resolved.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/);
  if (packagePath) packages.add(packagePath[1]);
}
for (const directory of packages) {
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const dest = path.join(out, 'licenses', metadata.name, metadata.version);
  await fs.mkdir(dest, { recursive: true });
  const notices = (await fs.readdir(directory)).filter(file => /^(licen[cs]e|copying|notice|authors|copyright)/i.test(file));
  if (!notices.length) notices.push(...(await fs.readdir(directory)).filter(file => /^readme/i.test(file)));
  for (const file of notices) await fs.cp(path.join(directory, file), path.join(dest, file), { recursive: true });
  await fs.writeFile(path.join(dest, 'package-info.json'), JSON.stringify({
    name: metadata.name, version: metadata.version, license: metadata.license,
  }, null, 2) + '\n');
}
await fs.copyFile(path.join(root, 'LICENSE'), path.join(out, 'licenses', 'jinno-slide-kit-LICENSE'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ api: 1, version: pkg.version, revision }, null, 2) + '\n');
console.log(`アプリの同梱ファイル: ${out}`);
