#!/usr/bin/env node
// 神野スライド（Marp）の入口。
//   slides new <dir> [--template 型] [--title タイトル] [--author 名前] [--theme petrol|paper] [--accent 色]
//                                                                   雛形から新しい資料を作る（型は slides templates で一覧）
//                                                                   表紙と裏表紙の名前は --author、なければ git の user.name
//   slides figs <slides.md>                                         figs/src/make_figs.py で図を作り直して検査する（jfig を import できる）
//   slides check <slides.md> [--pages 3-10] [--contact] [--no-shots] 見切れ・図の文字を検査し、PNGを出す
//   slides build <slides.md> [--pdf] [--html] [--pptx] [--notes]    dist/ へ書き出す（指定なしはPDFとHTML。--notes で発表者ノートをPDFの注釈に入れる）
//                                                                   --pptx は文字・図形・表を直せる PowerPoint（Googleスライドにも取り込める）
//   slides edit <slides.md> [--split]                               エディターを開く（--split で分割表示から）
//   slides preview <slides.md>                                      プレビュー（読むだけ・保存で自動更新）をブラウザで開く
//   slides split <slides.md>                                        エディターを分割表示（左にMarkdown・右にスライド）で開く
//   slides hub [--library ~/Slides]                                 資料のライブラリー（ギャラリー・Git）を開く
//   slides open                                                     ライブラリーをブラウザで開く（動いていなければ起動する）
//   slides service install|uninstall|restart|status                        ライブラリーをログイン時に自動で起動する（macOS の LaunchAgent）
//   slides notes <slides.md>                                        発表者ノートを書き出す（通読用）
//   slides icons fetch|find <語>|dir                                AWS の公式アイコン集を配布元から取得して探す（docs/aws-icons.md）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uvInstallHint, uvScriptArgs } from '../shared/python.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.resolve(root, '..');
const [cmd, ...args] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const bin = (name) => path.join(project, 'node_modules', '.bin', name);
const run = (command, argv, opts = {}) => {
  const r = spawnSync(command, argv, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CHROME_PATH: CHROME }, ...opts });
  if (command === 'uv' && r.error?.code === 'ENOENT') {
    console.error(uvInstallHint);
    process.exit(1);
  }
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const flag = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--pdf', '--html', '--pptx', '--contact', '--no-shots', '--notes'].includes(args[i - 1])));

const HUB_URL = 'http://127.0.0.1:4860/';
const LABEL = 'jp.jinno.marp-library';
const PLIST = path.join(process.env.HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(process.env.HOME, 'Library', 'Logs', 'jinno-marp-library.log');
// ログイン時にライブラリーを起動し、落ちても立ち上げ直す。git が見えるよう PATH を渡す
function plist() {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const PATH = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${x(process.execPath)}</string><string>${x(path.join(root, 'hub', 'server.mjs'))}</string><string>--no-open</string></array>
  <key>WorkingDirectory</key><string>${x(project)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(PATH)}</string><key>HOME</key><string>${x(process.env.HOME)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${x(LOG)}</string>
  <key>StandardErrorPath</key><string>${x(LOG)}</string>
</dict>
</plist>
`;
}

function templates() {
  const dir = path.join(root, 'templates');
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'template.json')))
    .map((d) => ({ dir: d, path: path.join(dir, d), ...JSON.parse(fs.readFileSync(path.join(dir, d, 'template.json'), 'utf8')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mustMd(file) {
  if (!file || !fs.existsSync(file)) { console.error(`Markdownが見つかりません: ${file || '(未指定)'}`); process.exit(2); }
  return path.resolve(file);
}

switch (cmd) {
  case 'new': {
    const dir = path.resolve(positional[0] || '.');
    if (opt('--accent') && !/^#[0-9a-f]{6}$/i.test(opt('--accent'))) { console.error('色は # と6桁の16進数で指定してください'); process.exit(2); }
    if (fs.existsSync(path.join(dir, 'slides.md'))) { console.error(`${dir}/slides.md は既にあります`); process.exit(2); }
    const tpl = templates().find((t) => t.name === (opt('--template') || 'talk') || t.dir === opt('--template'));
    if (!tpl) { console.error(`雛形が見つかりません: ${opt('--template')}（slides templates で一覧）`); process.exit(2); }
    fs.cpSync(tpl.path, dir, { recursive: true, filter: (s) => !s.includes('.check') && !path.basename(s).startsWith('.render') && path.basename(s) !== 'template.json' && !s.includes('__pycache__') });
    const md = path.join(dir, 'slides.md');
    const title = opt('--title') || tpl.defaultTitle;
    let text = fs.readFileSync(md, 'utf8');
    // フロントマターの title は <br> を空白に、本文（表紙）はそのまま
    const plainTitle = title.replace(/<br\s*\/?>/g, ' ');
    text = text.replace(/^title: "\{\{TITLE\}\}"/m, () => 'title: ' + JSON.stringify(plainTitle))
      .replaceAll('{{TITLE}}', () => title);
    if (opt('--theme')) text = text.replace(/^theme: .*/m, `theme: ${opt('--theme')}`);
    const accent = opt('--accent');
    if (accent) {
      const rule = `  section { --accent: ${accent}; }`;
      if (/^style: \|$/m.test(text)) text = text.replace(/^style: \|$/m, `style: |\n${rule}`);
      else text = text.replace(/^---\n/, `---\nstyle: |\n${rule}\n`);
    }
    // 表紙と裏表紙の名前。雛形の「Your Name」を --author か git の user.name に替える
    let author = opt('--author');
    let from = '--author';
    if (!author) {
      const r = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8', cwd: fs.existsSync(dir) ? dir : process.cwd() });
      author = r.status === 0 ? r.stdout.trim() : '';
      from = 'git の user.name';
    }
    const hasPlaceholder = text.includes('Your Name');
    if (author && hasPlaceholder) text = text.replaceAll('Your Name', author.replace(/[<>&]/g, ''));
    fs.writeFileSync(md, text);
    const rel = path.relative(process.cwd(), md);
    console.log(`作成しました（${tpl.name}：${tpl.description}）: ${rel}`);
    if (hasPlaceholder) console.log(author ? `表紙と裏表紙の名前: ${author}（${from} から。読みや所属は slides.md の <p class="who"> で直す）`
      : '表紙と裏表紙の名前が「Your Name」のままです。--author "名前" を付けて作り直すか、slides.md の <p class="who"> を直してください');
    if (fs.existsSync(path.join(dir, 'figs', 'src', 'make_figs.py'))) console.log(`図の作り直し: slides figs ${rel}`);
    console.log(`検査: slides check ${rel}`);
    break;
  }
  case 'templates':
    for (const t of templates()) console.log(`${t.name.padEnd(10)} ${t.description}\n${' '.repeat(11)}例: ${t.defaultTitle.replace(/<br\s*\/?>/g, ' ')}`);
    break;
  case 'figs': {
    // figs/src/make_figs.py を動かして figs/*.svg を作り直し、図の文字だけ検査する
    const md = mustMd(positional[0]);
    const script = path.join(path.dirname(md), 'figs', 'src', 'make_figs.py');
    if (!fs.existsSync(script)) { console.error(`作図スクリプトがありません: ${script}`); process.exit(2); }
    // 作図スクリプトから `from jfig import *` で同梱の部品（skills/marp-jinno/scripts）を読めるようにする
    const parts = path.join(project, 'skills', 'marp-jinno', 'scripts');
    const PYTHONPATH = [parts, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    run('uv', uvScriptArgs(script), { cwd: path.dirname(md), env: { ...process.env, CHROME_PATH: CHROME, PYTHONPATH } });
    run('uv', uvScriptArgs(path.join(root, 'scripts/figure_palette.py'), path.join(path.dirname(md), 'figs')));
    run('node', [path.join(root, 'scripts', 'check.mjs'), md, '--no-shots']);
    break;
  }
  case 'check':
    run('node', [path.join(root, 'scripts', 'check.mjs'), mustMd(positional[0]), ...args.filter((a) => a !== positional[0])]);
    break;
  case 'build': {
    const md = mustMd(positional[0]);
    const dir = path.dirname(md), name = path.basename(md, '.md');
    const dist = path.join(dir, 'dist');
    const want = ['--pdf', '--html', '--pptx'].filter(flag);
    const targets = want.length ? want : ['--pdf', '--html'];
    fs.mkdirSync(dist, { recursive: true });
    const base = ['--config-file', path.join(project, '.marprc.yml'), md];
    for (const t of targets) {
      const ext = t.slice(2);
      // PowerPoint は独自の書き出し（marp/pptx）。Marp 標準の「各ページを画像で」は使わない
      if (t === '--pptx') {
        const { exportPptx } = await import(path.join(root, 'pptx', 'index.mjs'));
        await exportPptx(md, path.join(dist, `${name}.pptx`), { log: (m) => console.log(m) });
        continue;
      }
      // 発表者ノートは、--notes を付けたときだけ PDF に入れる（お客様に渡す PDF に社内のメモが注釈として残らないように）
      const extra = t === '--pdf' ? ['--pdf', '--pdf-outlines', ...(flag('--notes') ? ['--pdf-notes'] : [])] : t === '--pptx' ? ['--pptx'] : [];
      run(bin('marp'), [...base, ...extra, '-o', path.join(dist, `${name}.${ext}`)]);
    }
    // HTMLは図を相対パスで読むので、figs/ も一緒に置く
    if (targets.includes('--html') && fs.existsSync(path.join(dir, 'figs'))) fs.cpSync(path.join(dir, 'figs'), path.join(dist, 'figs'), { recursive: true });
    console.log(`→ ${path.relative(process.cwd(), dist)}/`);
    break;
  }
  case 'preview': {
    const server = path.join(root, 'editor', 'server.mjs');
    run('node', [server, mustMd(positional[0]), '--preview', ...args.slice(1).filter((a) => a !== positional[0])], { stdio: 'inherit' });
    break;
  }
  case 'split': {
    const server = path.join(root, 'editor', 'server.mjs');
    run('node', [server, mustMd(positional[0]), '--split', ...args.slice(1).filter((a) => a !== positional[0])], { stdio: 'inherit' });
    break;
  }
  case 'open': {
    // 動いていればそのまま開く。なければ裏で起動してから開く
    const up = await fetch(`${HUB_URL}api/info`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
    if (!up) {
      spawn(process.execPath, [path.join(root, 'hub', 'server.mjs'), '--no-open'], { cwd: project, detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (await fetch(`${HUB_URL}api/info`).then((r) => r.ok).catch(() => false)) break; }
    }
    run('open', [HUB_URL]);
    break;
  }
  case 'service': {
    const sub = positional[0] || 'status';
    const uid = process.getuid();
    if (sub === 'install') {
      // 手で起動したライブラリーが同じポートを使っていれば止めてから入れる
      spawnSync('pkill', ['-f', 'marp/hub/server.mjs']);
      fs.mkdirSync(path.dirname(PLIST), { recursive: true });
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.writeFileSync(PLIST, plist());
      spawnSync('launchctl', ['bootout', `gui/${uid}`, PLIST], { stdio: 'ignore' });
      const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST], { encoding: 'utf8' });
      if (r.status) { console.error(`登録できませんでした: ${r.stderr.trim()}`); process.exit(1); }
      for (let i = 0; i < 40; i++) { await new Promise((res) => setTimeout(res, 250)); if (await fetch(`${HUB_URL}api/info`).then((x) => x.ok).catch(() => false)) break; }
      console.log(`ログイン時に自動で起動するようにしました: ${HUB_URL}\n  設定: ${PLIST}\n  ログ: ${LOG}\n  外すとき: slides service uninstall`);
      console.log('Chrome で開いて、アドレスバーの右の「アプリをインストール」を押すと Dock から開けます。');
    } else if (sub === 'restart') {
      // 道具を更新したあとに読み直す
      const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { encoding: 'utf8' });
      console.log(r.status ? `再起動できませんでした（入っていないかもしれません）: ${r.stderr.trim()}` : `再起動しました: ${HUB_URL}`);
    } else if (sub === 'uninstall') {
      spawnSync('launchctl', ['bootout', `gui/${uid}`, PLIST], { stdio: 'ignore' });
      if (fs.existsSync(PLIST)) fs.rmSync(PLIST);
      console.log('自動起動を外しました（ライブラリーも止まりました）。');
    } else {
      const loaded = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }).status === 0;
      const up = await fetch(`${HUB_URL}api/info`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
      console.log(`自動起動: ${loaded ? '入っている' : '入っていない'}（${PLIST}）\nライブラリー: ${up ? `動いている ${HUB_URL}` : '止まっている'}`);
    }
    break;
  }
  case 'hub': {
    run('node', [path.join(root, 'hub', 'server.mjs'), ...args], { stdio: 'inherit' });
    break;
  }
  case 'edit': {
    const server = path.join(root, 'editor', 'server.mjs');
    if (!fs.existsSync(server)) { console.error('エディターがまだありません'); process.exit(2); }
    run('node', [server, mustMd(positional[0]), ...args.slice(1)], { stdio: 'inherit' });
    break;
  }
  case 'icons':
    run('node', [path.join(root, 'scripts', 'aws-icons.mjs'), ...args]);
    break;
  case 'notes': {
    const md = mustMd(positional[0]);
    const { createMarp } = await import(path.join(root, 'scripts', 'render-lib.mjs'));
    const src = fs.readFileSync(md, 'utf8');
    const marp = createMarp();
    const { comments } = marp.render(src);
    // タイトル・リードと発表者ノートを並べる（通読で論理の飛躍を探す用）
    const tokens = marp.markdown.parse(src, {});
    const pages = [];
    let cur = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'marpit_slide_open') pages.push((cur = { title: '', lead: '' }));
      if (t.type === 'heading_open' && t.tag === 'h1' && cur && !cur.title) cur.title = tokens[i + 1].content.replace(/<br\s*\/?>/g, ' ');
      if (t.type === 'paragraph_open' && t.attrGet('class') === 'lead' && cur) cur.lead = tokens[i + 1].content.replace(/\n/g, '');
    }
    console.log(pages.map((p, i) => `## P.${i + 1} ${p.title}\n${p.lead}${comments[i]?.length ? `\n\n> ${comments[i].join('\n> ').replace(/\n/g, '\n> ')}` : ''}`).join('\n\n'));
    break;
  }
  default: {
    if (cmd && !['help', '-h', '--help'].includes(cmd)) {
      console.error(`不明なコマンド: ${cmd}`);
      process.exitCode = 2;
    }
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    for (const line of lines) {
      if (!line.startsWith('//')) break;
      console.log(line.replace(/^\/\/ ?/, ''));
    }
  }
}
