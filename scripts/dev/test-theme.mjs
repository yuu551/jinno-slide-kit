// 各雛形から作った資料を両テーマで検査する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createMarp, CHROME } from '../../marp/scripts/render-lib.mjs';
import { TEMPLATES } from '../../marp/editor/client/templates.mjs';
import { exportPptx } from '../../marp/pptx/index.mjs';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'marp/bin/slides.mjs');
const templates = await fs.readdir(path.join(root, 'marp/templates'), { withFileTypes: true });
const marp = createMarp();
const code = marp.render('```text\n"sample"\n```').html;
assert.match(code, /<pre\b[^>]*><code><span class="hljs-string">&quot;sample&quot;<\/span>/);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marpkit-theme-'));
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage();
  // The same paint is used by an authored shape, a vendor icon and a fixed-color logo.
  // Export must resolve the image's palette when it turns the three into editable shapes.
  const figs = path.join(dir, 'figs');
  await fs.mkdir(figs);
  await fs.writeFile(path.join(figs, 'palette.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20" viewBox="0 0 60 20">
    <rect width="20" height="20" fill="#4a8399"/>
    <svg x="20" width="20" height="20"><rect width="20" height="20" fill="#4a8399"/></svg>
    <g data-fixed-color=""><rect x="40" width="20" height="20" fill="#4a8399"/></g>
  </svg>`);
  execFileSync('uv', ['run', path.join(root, 'marp/scripts/figure_palette.py'), figs]);
  for (const theme of ['petrol', 'paper']) {
    const source = path.join(dir, 'slides.md');
    await fs.writeFile(source, `---\ntheme: ${theme}\n---\n\n![w:600](figs/palette.svg)`);
    const output = path.join(dir, `${theme}.pptx`);
    await exportPptx(source, output);
    const zip = await JSZip.loadAsync(await fs.readFile(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const paints = [...xml.matchAll(/<a:solidFill><a:srgbClr val="([0-9a-f]{6})"/gi)].map(m => m[1].toLowerCase());
    assert.equal(paints.filter(c => c === '78549e').length, theme === 'paper' ? 1 : 0);
    assert.equal(paints.filter(c => c === '4a8399').length, theme === 'paper' ? 2 : 3);
  }

  for (const { name } of templates.filter(entry => entry.isDirectory())) {
    const defaultTheme = ['update', 'release'].includes(name) ? 'petrol' : 'paper';
    for (const theme of ['petrol', 'paper']) {
      assert.ok(marp.themeSet.has(theme));
      const deck = path.join(dir, `${name}-${theme}`);
      const args = ['new', deck, '--template', name, '--author', 'テスト 花子'];
      if (theme !== defaultTheme) args.push('--theme', theme);
      execFileSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
      const md = path.join(deck, 'slides.md');
      const source = await fs.readFile(md, 'utf8');
      assert.equal(source.match(/^theme: (.+)$/m)?.[1], theme);
      assert.doesNotMatch(source, /--accent:/);
      const pages = source.split('\n---\n');
      const closing = TEMPLATES.find(item => item.id === 'closing');
      assert.equal(closing.body('', pages[1]), pages.at(-1).trim());
      assert.match(pages.at(-1), /_class: closing back-cover/);
      execFileSync(process.execPath, [cli, 'check', md, '--no-shots'], { stdio: 'inherit' });
      const report = JSON.parse(await fs.readFile(path.join(deck, '.check/report.json'), 'utf8'));
      await page.goto(pathToFileURL(path.join(deck, '.render-slides.html')).href);
      const jackets = await page.locator('section:is(.cover, .back-cover)').evaluateAll(sections =>
        sections.map(section => {
          const heading = getComputedStyle(section.querySelector('h1'));
          const art = section.querySelector('.image-block img');
          const panel = getComputedStyle(section, '::before');
          const meta = section.querySelector('.kicker span');
          return {
            font: heading.fontFamily, weight: heading.fontWeight, size: heading.fontSize,
            ink: heading.color, stock: getComputedStyle(section).backgroundColor,
            art: art.currentSrc, width: art.offsetWidth, height: art.offsetHeight,
            scheme: getComputedStyle(art).colorScheme,
            panel: [panel.width, panel.backgroundColor], tag: meta && getComputedStyle(meta).backgroundColor,
          };
        }));
      assert.equal(jackets.length, 2);
      const [front, back] = jackets;
      assert.deepEqual(front, back, name + ' / ' + theme);
      assert.match(front.font, /Talk Sans/);
      assert.equal(front.weight, '700');
      assert.match(front.art, /cover-art\.svg$/);
      assert.deepEqual([front.width, front.height], [560, 720]);
      // 右の面はテーマが描き、肩の日付や枠は札で囲まない
      assert.equal(front.panel[0], '560px');
      assert.ok(!front.tag || front.tag === 'rgba(0, 0, 0, 0)', `${name} / ${theme}: 肩の札`);
      assert.ok(front.scheme.includes(theme === 'paper' ? 'dark' : 'light'));
      assert.equal(report.warnings, 0, `${name} / ${theme}: レイアウトの警告`);
    }
  }
} finally {
  await browser.close();
  await fs.rm(dir, { recursive: true, force: true });
}
