// 発表モード（/present・/presenter）のE2Eテスト。デッキを一時フォルダへコピーしてエディターを起動し、
// 表示・キー操作・両画面の同期・編集の反映・エディターからの起動・描画の一致（画素差分）を確かめる。
// usage: node marp/editor/test-present.mjs [decks/a decks/b ...]
import { chromium } from 'playwright-core';
import { startServer } from './test-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const decks = process.argv.slice(2).length
  ? process.argv.slice(2).map((d) => path.resolve(d))
  : [path.join(here, '../templates/talk')];
const shots = path.join(here, 'screenshots');
await fs.mkdir(shots, { recursive: true });

const results = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, msg, ms = 8000) => {
  const t0 = Date.now();
  for (;;) { if (await fn()) return; if (Date.now() - t0 > ms) throw new Error(`timeout: ${msg}`); await sleep(80); }
};

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function runDeck(src, port) {
  const label = path.basename(src);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'marp-present-e2e-'));
  await fs.cp(path.join(src, 'slides.md'), path.join(tmp, 'slides.md'));
  await fs.cp(path.join(src, 'figs'), path.join(tmp, 'figs'), { recursive: true }).catch(() => {});
  const deck = path.join(tmp, 'slides.md');
  const { server, url } = await startServer(deck, port);

  const test = async (name, fn) => {
    const full = `[${label}] ${name}`;
    try { await fn(); results.push([full, 'ok']); console.log(`✓ ${full}`); }
    catch (e) { results.push([full, 'NG', e.message]); console.log(`✗ ${full}\n    ${e.message.split('\n').slice(0, 14).join('\n    ')}`); }
  };

  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  const watch = (p, name) => {
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  };
  ctx.on('page', (p) => watch(p, p.url()));

  // ページ i（0始まり）が表示され終わるまで待つ
  const presentAt = (p, i) => waitFor(() => p.evaluate((i) => {
    const x = window.__present;
    return x && x.nav.index === i && x.view.index === i && x.view.visible?._html === x.deck.sections[i];
  }, i), `発表画面が ${i + 1} ページ目`);
  const presenterAt = (p, i) => waitFor(() => p.evaluate((i) => {
    const x = window.__presenter;
    if (!x || x.nav.index !== i || x.current.index !== i || x.current.visible?._html !== x.deck.sections[i]) return false;
    return i + 1 >= x.deck.sections.length ? x.next.index === -1 : x.next.index === i + 1;
  }, i), `発表者画面が ${i + 1} ページ目`);
  const idx = (p) => p.evaluate(() => (window.__present || window.__presenter).nav.index);

  const read = () => fs.readFile(deck, 'utf8');
  let present, presenter;
  try {
    present = await ctx.newPage();
    await present.goto(url + 'present');
    await present.waitForFunction(() => document.body.classList.contains('is-ready'), null, { timeout: 30000 });
    const count = await present.evaluate(() => window.__present.deck.sections.length);

    await test('発表画面が開き、1枚目（表紙）が画面いっぱいに出る', async () => {
      await presentAt(present, 0);
      const r = await present.evaluate(() => {
        const sec = document.querySelector('#view .pv-layer.is-current section');
        const b = sec.getBoundingClientRect();
        const bg = getComputedStyle(sec).backgroundColor;
        return { cls: sec.className, w: b.width, h: b.height, x: b.left, y: b.top, bg, page: document.querySelector('#bar-page').textContent };
      });
      assert(r.cls.includes('cover'), `表紙ではない: ${r.cls}`);
      assert(Math.abs(r.w - 1920) < 1 && Math.abs(r.h - 1080) < 1 && Math.abs(r.x) < 1 && Math.abs(r.y) < 1, `大きさ: ${JSON.stringify(r)}`);
      assert(r.bg === 'rgb(252, 250, 253)', `表紙の背景色が異なる: ${r.bg}`);
      assert(r.page === `1 / ${count}`, `ページ番号: ${r.page}`);
    });

    await test('キーでページが進む・戻る・ジャンプする（→ Space ← PageDown Backspace End Home 数字+Enter）', async () => {
      const steps = [['ArrowRight', 1], ['Space', 2], ['ArrowLeft', 1], ['PageDown', 2], ['ArrowDown', 3], ['ArrowUp', 2], ['Backspace', 1], ['PageUp', 0], ['End', count - 1], ['Home', 0]];
      for (const [k, want] of steps) { await present.keyboard.press(k); await presentAt(present, want); }
      await present.keyboard.type('12');
      assert(await present.evaluate(() => document.querySelector('#jump').textContent.startsWith('12')), '入力中の番号が出ない');
      await present.keyboard.press('Enter');
      await presentAt(present, Math.min(11, count - 1));
      assert(await present.evaluate(() => location.hash) === `#${Math.min(12, count)}`, 'URLの#Nが追従しない');
      await present.keyboard.press('Home');
      await presentAt(present, 0);
    });

    await test('クリックで次へ、B・W・. で黒／白画面、送りキーで黒画面を解除', async () => {
      await present.mouse.click(960, 400);
      await presentAt(present, 1);
      await present.keyboard.press('b');
      assert(await present.evaluate(() => !document.querySelector('#blank').hidden && document.querySelector('#blank').className === 'is-black'), '黒画面にならない');
      await present.keyboard.press('ArrowRight');
      assert(await present.evaluate(() => document.querySelector('#blank').hidden), '送りキーで黒画面が解除されない');
      assert(await idx(present) === 1, '黒画面の解除でページが進んでしまった');
      await present.keyboard.press('w');
      assert(await present.evaluate(() => document.querySelector('#blank').className === 'is-white'), '白画面にならない');
      await present.keyboard.press('w');
      await present.keyboard.press('.');
      assert(await present.evaluate(() => document.querySelector('#blank').className === 'is-black'), '. で黒画面にならない');
      await present.keyboard.press('.');
      assert(await present.evaluate(() => document.querySelector('#blank').hidden), '. で戻らない');
    });

    await test('マウスを動かすと操作バーが出て、止めると消える（カーソルも隠す）', async () => {
      await present.mouse.move(900, 500);
      await present.mouse.move(960, 540);
      assert(await present.evaluate(() => !document.body.classList.contains('is-idle')), 'バーが出ない');
      await present.waitForTimeout(3000);
      assert(await present.evaluate(() => document.body.classList.contains('is-idle') && getComputedStyle(document.querySelector('#bar')).opacity === '0'), 'バーが消えない');
      assert(await present.evaluate(() => getComputedStyle(document.querySelector('#stage')).cursor === 'none'), 'カーソルが隠れない');
    });

    // ノートのあるページ
    const notePage = await present.evaluate(() => window.__present.deck.notes.findIndex((n, i) => i > 2 && n.length > 20 && /<h1[ >]/.test(window.__present.deck.sections[i]) && !/class="[^"]*(cover|divider)/.test(window.__present.deck.sections[i])));

    await test('発表者画面を開くと、現在・次のスライドとノートが出る', async () => {
      await present.keyboard.press('Home');
      await present.keyboard.type(String(notePage + 1));
      await present.keyboard.press('Enter');
      await presentAt(present, notePage);
      presenter = await ctx.newPage();
      await presenter.setViewportSize({ width: 1440, height: 900 });
      await presenter.goto(url + 'presenter'); // ページ指定なし → 開いている発表画面に合わせる
      await presenter.waitForFunction(() => document.body.classList.contains('is-ready'), null, { timeout: 30000 });
      await presenterAt(presenter, notePage);
      const r = await presenter.evaluate(() => ({
        note: document.querySelector('#notes').textContent,
        want: window.__presenter.deck.notes[window.__presenter.nav.index],
        page: document.querySelector('#page-cur').textContent + '/' + document.querySelector('#page-all').textContent,
        conn: document.querySelector('#conn').textContent,
        cur: document.querySelector('#current .pv-layer.is-current section')?.getBoundingClientRect().width,
        nxt: document.querySelector('#next .pv-layer.is-current section')?.getBoundingClientRect().width,
      }));
      assert(r.note.replace(/\s+/g, '') === r.want.replace(/\*\*|`/g, '').replace(/\s+/g, ''), `ノートが違う: ${r.note.slice(0, 60)}`);
      assert(r.page === `${notePage + 1}/${count}`, `ページ: ${r.page}`);
      assert(r.conn.includes('つながっています'), `接続表示: ${r.conn}`);
      assert(r.cur > 700 && r.nxt > 300 && r.cur > r.nxt, `大きさ: 現在 ${r.cur} 次 ${r.nxt}`);
    });

    await test('発表者画面で送ると発表画面も同じページになる（逆も）', async () => {
      await presenter.keyboard.press('Home');
      await presentAt(present, 0);
      await presenter.keyboard.press('ArrowRight');
      await presenterAt(presenter, 1);
      await presentAt(present, 1);
      await presenter.click('#next-btn');
      await presentAt(present, 2);
      await presenter.click('#prev');
      await presentAt(present, 1);
      await present.keyboard.press('ArrowLeft');
      await presenterAt(presenter, 0);
      await present.keyboard.type('3');
      await present.keyboard.press('Enter');
      await presenterAt(presenter, 2);
      await presenter.keyboard.press('End');
      await presentAt(present, count - 1);
      await presenterAt(presenter, count - 1);
      assert(await presenter.evaluate(() => getComputedStyle(document.querySelector('.pr-end')).display !== 'none'), '最後のページで「最後のスライドです」が出ない');
      await presenter.keyboard.press('Home');
      await presentAt(present, 0);
      // 黒画面も同期する
      await presenter.keyboard.press('b');
      await waitFor(() => present.evaluate(() => !document.querySelector('#blank').hidden), '発表画面の黒画面');
      assert(await presenter.evaluate(() => !document.querySelector('#blank-flag').hidden), '発表者画面に黒画面中の表示がない');
      await present.keyboard.press('b');
      await waitFor(() => presenter.evaluate(() => document.querySelector('#blank-flag').hidden), '発表者画面の黒画面解除');
    });

    await test('発表者画面の一覧（G・一覧ボタン）から好きなページに飛べる（発表画面も追従）', async () => {
      const target = Math.min(7, count - 1);
      await presenter.keyboard.press('g');
      await waitFor(() => presenter.evaluate((n) => !document.querySelector('#grid').hidden && document.querySelectorAll('.pr-tile').length === n, count), '一覧が開く');
      await waitFor(() => presenter.evaluate(() => !!document.querySelector('.pr-tile.is-current .pv-layer.is-current section')), '今のページの縮小が描かれる');
      await presenter.click(`.pr-tile[data-i="${target}"]`);
      await presenterAt(presenter, target);
      await presentAt(present, target);
      assert(await presenter.evaluate(() => document.querySelector('#grid').hidden), 'クリックで一覧が閉じない');
      // ボタンで開き、矢印キー＋Enter で選ぶ（矢印でページ自体は動かない）
      await presenter.click('#grid-btn');
      await presenter.keyboard.press('ArrowLeft');
      assert(await idx(presenter) === target, '一覧を開いたまま矢印でページが動いた');
      await presenter.keyboard.press('Enter');
      await presenterAt(presenter, target - 1);
      await presentAt(present, target - 1);
      await presenter.keyboard.press('g');
      await presenter.keyboard.press('Escape');
      assert(await presenter.evaluate(() => document.querySelector('#grid').hidden), 'Esc で一覧が閉じない');
      assert(await idx(presenter) === target - 1, 'Esc でページが動いた');
      await presenter.keyboard.press('Home');
      await presentAt(present, 0);
    });

    await test('経過時間：最初の送りで動き出し、一時停止・リセットできる。目標を入れると残りが出る', async () => {
      await presenter.click('#t-reset');
      await presenter.keyboard.press('ArrowRight');
      await presenter.waitForTimeout(1300);
      const t1 = await presenter.evaluate(() => document.querySelector('#elapsed').textContent);
      assert(t1 !== '00:00', `動いていない: ${t1}`);
      await presenter.click('#t-toggle');
      const paused = await presenter.evaluate(() => document.querySelector('#elapsed').textContent);
      await presenter.waitForTimeout(1200);
      assert(await presenter.evaluate(() => document.querySelector('#elapsed').textContent) === paused, '一時停止しない');
      await presenter.fill('#target', '10');
      const rem = await presenter.evaluate(() => document.querySelector('#remaining').textContent);
      assert(/^0?9:5\d$/.test(rem), `残り: ${rem}`);
      await presenter.click('#t-reset');
      assert(await presenter.evaluate(() => document.querySelector('#elapsed').textContent) === '00:00', 'リセットされない');
      assert(await presenter.evaluate(() => /^\d\d:\d\d$/.test(document.querySelector('#clock').textContent)), '現在時刻');
      await presenter.click('#note-bigger');
      assert(await presenter.evaluate(() => document.querySelector('#notes').style.fontSize) !== '', 'ノートの文字サイズ');
      await presenter.click('#note-smaller');
      await presenter.keyboard.press('Home');
      await presentAt(present, 0);
    });

    await test('デッキを外部で書き換えると両画面が更新される（ページ位置は保つ）', async () => {
      const target = Math.min(notePage, count - 1);
      await present.keyboard.type(String(target + 1));
      await present.keyboard.press('Enter');
      await presenterAt(presenter, target);
      await presentAt(present, target);
      const h1 = await present.evaluate(() => document.querySelector('#view .pv-layer.is-current section h1')?.textContent);
      assert(h1, 'このページに見出しがない');
      const t = await read();
      assert(t.includes(`# ${h1}\n`), `見出しが原稿に見つからない: ${h1}`);
      await fs.writeFile(deck, t.replace(`# ${h1}\n`, `# ${h1}（外部変更）\n`));
      await waitFor(() => present.evaluate(() => document.querySelector('#view .pv-layer.is-current section h1')?.textContent.endsWith('（外部変更）')), '発表画面の更新');
      await waitFor(() => presenter.evaluate(() => document.querySelector('#current .pv-layer.is-current section h1')?.textContent.endsWith('（外部変更）')), '発表者画面の更新');
      assert(await idx(present) === target && await idx(presenter) === target, 'ページ位置が変わった');
      // ノートの書き換えも反映される
      const t2 = await read();
      const note = await presenter.evaluate(() => window.__presenter.deck.notes[window.__presenter.nav.index]);
      const firstLine = note.split('\n')[0];
      assert(t2.includes(firstLine), 'ノートが原稿に見つからない');
      await fs.writeFile(deck, t2.replace(firstLine, `${firstLine}（ノート追記）`));
      await waitFor(() => presenter.evaluate(() => document.querySelector('#notes').textContent.includes('（ノート追記）')), 'ノートの更新');
    });

    let editor;
    await test('エディターで保存すると両画面に反映される', async () => {
      editor = await ctx.newPage();
      await editor.setViewportSize({ width: 1600, height: 960 });
      await editor.goto(url + '#2');
      await editor.waitForFunction(() => window.__editor?.state.sections.length > 0, null, { timeout: 30000 });
      const i = await idx(present);
      await editor.evaluate((i) => {
        const e = window.__editor;
        const lines = e.state.text.split('\n');
        const r = e.state.ranges[i];
        const k = lines.slice(r.start, r.end).findIndex((l) => l.startsWith('# '));
        lines[r.start + k] += '（エディター保存）';
        e.state.text = lines.join('\n');
        e.render();
      }, i);
      await editor.keyboard.press(`${mod}+s`);
      await waitFor(() => editor.evaluate(() => window.__editor.state.text === window.__editor.state.saved), '保存');
      await waitFor(() => present.evaluate(() => document.querySelector('#view .pv-layer.is-current section h1')?.textContent.endsWith('（エディター保存）')), '発表画面の更新');
      await waitFor(() => presenter.evaluate(() => document.querySelector('#current .pv-layer.is-current section h1')?.textContent.endsWith('（エディター保存）')), '発表者画面の更新');
      assert(await editor.evaluate(() => document.querySelector('#banner').hidden), 'エディターに外部変更の警告が出てしまった');
    });

    await test('エディターの「発表」ボタンと ⌘⏎ で、今のページから両画面が開く', async () => {
      await present.close(); await presenter.close();
      const n = Math.min(5, count);
      await editor.evaluate((n) => window.__editor.go(n - 1), n);
      await editor.mouse.click(5, 900); // ステージ外
      await editor.locator('#toolbar').screenshot({ path: path.join(shots, `present-${label}-editor-toolbar.png`) });
      const pops = [];
      const onPop = (p) => pops.push(p);
      ctx.on('page', onPop);
      await editor.click('#btn-present');
      await waitFor(() => pops.length >= 2 && pops.every((p) => p.url() !== 'about:blank'), '2つの窓が開く');
      await Promise.all(pops.map((p) => p.waitForLoadState('domcontentloaded')));
      present = pops.find((p) => /\/present#/.test(p.url()));
      presenter = pops.find((p) => /\/presenter#/.test(p.url()));
      assert(present && presenter, `開いたURL: ${pops.map((p) => p.url()).join(', ')}`);
      assert(present.url().endsWith(`/present#${n}`) && presenter.url().endsWith(`/presenter#${n}`), `ページ: ${present.url()} ${presenter.url()}`);
      await present.waitForFunction(() => document.body.classList.contains('is-ready'), null, { timeout: 30000 });
      await presenter.waitForFunction(() => document.body.classList.contains('is-ready'), null, { timeout: 30000 });
      await presentAt(present, n - 1);
      await presenterAt(presenter, n - 1);
      // ⌘⏎：開いている窓がそのページへ移る
      const m = Math.min(3, count);
      await editor.evaluate((m) => window.__editor.go(m - 1), m);
      await editor.bringToFront();
      await editor.keyboard.press(`${mod}+Enter`);
      await presentAt(present, m - 1);
      await presenterAt(presenter, m - 1);
      ctx.off('page', onPop);
    });

    await test('スライドの描画がエディターのステージと一致する（画素差分）', async () => {
      await present.setViewportSize({ width: 1280, height: 720 });
      await editor.setViewportSize({ width: 2000, height: 1100 });
      const pick = await present.evaluate(() => {
        const s = window.__present.deck.sections;
        const find = (re) => s.findIndex((h) => re.test(h));
        return [...new Set([0, find(/class="[^"]*divider/), find(/<img[^>]+figs\//), find(/<table/), s.length - 1].filter((i) => i >= 0))];
      });
      const out = [];
      for (const i of pick) {
        await editor.evaluate((i) => window.__editor.go(i), i);
        await editor.mouse.move(1, 1);
        // エディターのステージを等倍にし、検査の枠線などエディター固有の飾りを外して撮る
        await editor.evaluate(async () => {
          const st = document.querySelector('#stage');
          st.style.width = '1280px'; st.style.height = '720px'; st.style.boxShadow = 'none';
          st.querySelector('.mj-scale').style.transform = 'none';
          for (const el of st.querySelectorAll('.mj-issue, .mj-issue-warn, .mj-editable')) el.classList.remove('mj-issue', 'mj-issue-warn', 'mj-editable');
          await Promise.all([...st.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
          await document.fonts.ready;
        });
        await editor.waitForTimeout(150);
        const a = await editor.locator('#stage').screenshot();
        await present.evaluate((i) => window.__present.nav.go(i), i);
        await presentAt(present, i);
        await present.evaluate(() => { document.body.classList.add('is-idle'); document.querySelector('#hint').hidden = true; });
        await present.waitForTimeout(350);
        const b = await present.screenshot();
        const d = await present.evaluate(async ([a, b]) => {
          const load = (src) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = src; });
          const [ia, ib] = await Promise.all([load(a), load(b)]);
          if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
          const c = new OffscreenCanvas(ia.width, ia.height).getContext('2d');
          c.drawImage(ia, 0, 0); const da = c.getImageData(0, 0, ia.width, ia.height).data;
          c.clearRect(0, 0, ia.width, ia.height); c.drawImage(ib, 0, 0); const db = c.getImageData(0, 0, ib.width, ib.height).data;
          let bad = 0;
          for (let k = 0; k < da.length; k += 4) if (Math.max(Math.abs(da[k] - db[k]), Math.abs(da[k + 1] - db[k + 1]), Math.abs(da[k + 2] - db[k + 2])) > 24) bad++;
          return { ratio: bad / (da.length / 4) };
        }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`]);
        if (d.size) throw new Error(`P.${i + 1} 画像の大きさが違う: ${d.size}`);
        out.push(`P.${i + 1}: ${(d.ratio * 100).toFixed(3)}%`);
        if (d.ratio > 0.002) {
          await fs.writeFile(path.join(shots, `diff-${label}-p${i + 1}-editor.png`), a);
          await fs.writeFile(path.join(shots, `diff-${label}-p${i + 1}-present.png`), b);
          throw new Error(`P.${i + 1} の差分が大きい: ${(d.ratio * 100).toFixed(3)}%`);
        }
      }
      console.log(`    差分 ${out.join(' / ')}`);
    });

    await test('スクリーンショット（発表画面 1920×1080・1440×900、発表者画面）', async () => {
      const figPage = await present.evaluate(() => Math.max(0, window.__present.deck.sections.findIndex((h, i) => i > 0 && /<img[^>]+figs\//.test(h))));
      for (const [w, h] of [[1920, 1080], [1440, 900]]) {
        await present.setViewportSize({ width: w, height: h });
        await present.evaluate(() => window.__present.nav.go(0));
        await presentAt(present, 0);
        await present.evaluate(() => { document.body.classList.add('is-idle'); document.querySelector('#hint').hidden = true; });
        await present.waitForTimeout(300);
        await present.screenshot({ path: path.join(shots, `present-${label}-${w}x${h}-cover.png`) });
        await present.evaluate((i) => window.__present.nav.go(i), figPage);
        await presentAt(present, figPage);
        await present.mouse.move(w / 2, h / 2); await present.mouse.move(w / 2 + 10, h / 2);
        await present.waitForTimeout(350);
        await present.screenshot({ path: path.join(shots, `present-${label}-${w}x${h}-bar.png`) });
        // 1440×900（16:10）は上下に黒帯。スライドが中央で幅いっぱい
        const b = await present.evaluate(() => document.querySelector('#view .pv-layer.is-current section').getBoundingClientRect().toJSON());
        assert(Math.abs(b.width - w) < 1 && Math.abs(b.top - (h - w * 9 / 16) / 2) < 1, `配置: ${JSON.stringify(b)}`);
      }
      await presenter.bringToFront();
      for (const [w, h] of [[1440, 900], [1920, 1080], [1280, 800]]) {
        await presenter.setViewportSize({ width: w, height: h });
        await presenter.evaluate((i) => window.__presenter.nav.go(i), notePage);
        await presenterAt(presenter, notePage);
        await presenter.waitForTimeout(300);
        await presenter.screenshot({ path: path.join(shots, `presenter-${label}-${w}x${h}.png`) });
      }
      await present.keyboard.press('?');
      await present.waitForTimeout(100);
      await present.screenshot({ path: path.join(shots, `present-${label}-help.png`) });
      await present.keyboard.press('Escape');
      assert(await present.evaluate(() => document.querySelector('#help').hidden), '操作一覧が閉じない');
    });

    await test('P の印刷用：全ページのノート付き一覧が組める', async () => {
      await present.setViewportSize({ width: 1280, height: 900 });
      const rows = await present.evaluate(async () => (await window.__present.print()).querySelectorAll('.pp-row').length);
      assert(rows === count, `行数: ${rows} / ${count}`);
      await present.emulateMedia({ media: 'print' });
      await present.screenshot({ path: path.join(shots, `present-${label}-print.png`) });
      assert(await present.evaluate(() => getComputedStyle(document.querySelector('#stage')).display === 'none'), '印刷時に発表画面が隠れない');
      await present.emulateMedia({ media: 'screen' });
      await present.evaluate(() => { document.getElementById('pv-print').innerHTML = ''; });
    });

    await test('JSエラーがない', async () => { assert(errors.length === 0, errors.join('\n')); });
  } finally {
    await ctx.close();
    server.kill();
  }
  const ng = results.filter((r) => r[1] !== 'ok' && r[0].startsWith(`[${label}]`));
  if (!ng.length) await fs.rm(tmp, { recursive: true, force: true });
  else console.log(`    一時デッキ: ${tmp}`);
}

try {
  let port = 4995;
  for (const d of decks) await runDeck(d, port++);
} finally {
  await browser.close();
}
const ng = results.filter((r) => r[1] !== 'ok');
console.log(`\n${results.length - ng.length}/${results.length} 通過`);
process.exitCode = ng.length ? 1 : 0;
