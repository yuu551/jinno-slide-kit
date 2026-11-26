// 神野スライド用のMarp拡張。Node（marp-cli）とブラウザ（エディター）の両方から使うので、fsなどに依存しない。
//
// 追加する記法
//   <!-- chapter: 基礎 -->          以降のページのフッターにパンくずを出す（章の一覧はフロントマターの chapters）
//   ::: dialogue [scale]            「- 私: 〜」「- Agent君: 〜」のリストを掛け合いにする
//   ::: speech [話者] / ::: band    語りかけの吹き出し／帯（::: speech 私 photo=figs/me.png で顔写真）
//   photos: [私=figs/me.png]        フロントマター。掛け合い・語りかけの話者を顔写真にする（既定の割り当て）
//   ::: purpose [scale]             「- 対象」「- **目的**」の入れ子リストを対象と目的にする
//   ::: agenda [scale]              番号付きリストをアジェンダにする
//   ::: quote [scale]               引用。「— 」で始まる段落は出典になる
//   ::: scale 1.3                   中の部品（表・コード・箇条書きなど）の倍率を変える
//   ```python ラベル                コードをウィンドウ風に。フェンス直後の段落はキャプション
import container from 'markdown-it-container';
import components from './components.mjs';
import cedar from './lib/hljs-cedar.mjs';

import { Bot, User } from 'lucide';
import { iconPaths, iconSvg } from './icons.mjs';
const person = iconSvg(iconPaths(User));
export const ICONS = { person, ai: iconSvg(iconPaths(Bot)), speaker: person };

const CHAPTERS = Symbol('chapters');
const PHOTOS = Symbol('photos');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const isAgent = (name) => /agent|エージェント|ai|bot/i.test(name);

function parseList(v) {
  if (Array.isArray(v)) return v.map(String);
  return String(v).replace(/^\[|\]$/g, '').split(/[,、]/).map((s) => s.trim()).filter(Boolean);
}

function breadcrumb(chapters, current) {
  const list = chapters.includes(current) ? chapters : [...chapters, current];
  return list
    .map((c, i) => `${i ? '<span class="bc-sep">›</span>' : ''}<span class="${c === current ? 'bc-item bc-current' : 'bc-item'}">${esc(c)}</span>`)
    .join('');
}

// 「::: name 引数」を読む。数値は倍率、それ以外は文字列の引数。
function parseInfo(info, name) {
  const rest = info.trim().slice(name.length).trim();
  const scale = rest.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  return { scale: scale ? Number(scale[1]) : undefined, text: rest.replace(/(?:^|\s)\d+(?:\.\d+)?(?:\s|$)/, ' ').trim() };
}
const scaleStyle = (scale) => (scale ? ` style="--component-scale: ${scale}"` : '');

// marp.use(jinnoPlugin) で使う。Marpitは markdown-it のインスタンスを渡すので、Marpit本体は md.marpit から取る。
export default function jinnoPlugin(md) {
  const marp = md.marpit;
  // highlight.js に無い言語を足す（```cedar で色が付く）。エディター・発表画面・marp-cli のどれもここを通る
  if (marp?.highlightjs && !marp.highlightjs.getLanguage('cedar')) marp.highlightjs.registerLanguage('cedar', cedar);
  md.use(components);

  // ページごとの _class を保ちながら、原稿全体の組版を選ぶ。
  marp.customDirectives.global.layout = value =>
    ['classic', 'stage'].includes(value) ? { layout: value } : {};
  md.core.ruler.after('marpit_directives_apply', 'jinno_layout', state => {
    for (const token of state.tokens) {
      if (token.type === 'marpit_slide_open' && token.meta?.marpitDirectives.layout)
        token.attrJoin('class', token.meta.marpitDirectives.layout);
    }
  });

  // --- パンくず -------------------------------------------------------------
  marp.customDirectives.global.chapters = (v, marpit) => {
    marpit[CHAPTERS] = parseList(v);
    return {};
  };
  // 話者ごとの顔写真。「名前=画像のパス」の並び。掛け合い・語りかけで、個別の photo= がなければこれを使う
  marp.customDirectives.global.photos = (v, marpit) => {
    marpit[PHOTOS] = Object.fromEntries(parseList(v).map((x) => x.split('=').map((s) => s.trim())).filter(([k, p]) => k && p));
    return {};
  };
  // 文書全体を読むときだけ空に戻す（フッターのパンくずは parseInline でこの規則をもう一度通るため）
  md.core.ruler.after('normalize', 'jinno_reset_photos', (state) => { if (!state.inlineMode) marp[PHOTOS] = {}; });
  const photoOf = (speaker, own) => own || marp[PHOTOS]?.[speaker] || '';
  const photoIcon = (src) => `<img src="${esc(src)}" alt="">`;
  marp.customDirectives.local.chapter = (v, marpit) => {
    if (!v) return { footer: '' };
    return { footer: breadcrumb(marpit[CHAPTERS] || [], String(v)) };
  };

  // --- コンテナ -------------------------------------------------------------
  const box = (name, open, close = '</div>\n') =>
    md.use(container, name, {
      validate: (p) => p.trim().split(/\s+/)[0] === name,
      render: (tokens, idx) => (tokens[idx].nesting === 1 ? open(parseInfo(tokens[idx].info, name)) : close),
    });
  box('dialogue', ({ scale }) => `<div class="dialogue is-stacked"${scaleStyle(scale)}>\n`);
  box('purpose', ({ scale }) => `<div class="purpose"${scaleStyle(scale)}>\n`);
  box('agenda', ({ scale }) => `<div class="agenda"${scaleStyle(scale)}>\n`);
  box('scale', ({ scale }) => `<div class="scaled"${scaleStyle(scale)}>\n`);
  box('quote', ({ scale }) => `<figure class="quote-block"${scaleStyle(scale)}>\n`, '</figure>\n');
  md.core.ruler.push('jinno_quote_cite', (state) => {
    let depth = 0;
    for (const t of state.tokens) {
      if (t.type === 'container_quote_open') depth++;
      else if (t.type === 'container_quote_close') depth--;
      else if (depth && t.type === 'inline' && /^[—―]\s/.test(t.content)) {
        const first = t.children?.find((c) => c.type === 'text');
        if (first) first.content = first.content.replace(/^[—―]\s+/, '');
        const open = state.tokens[state.tokens.indexOf(t) - 1];
        if (open?.type === 'paragraph_open') open.attrSet('class', 'quote-cite');
      }
    }
  });
  box('band', ({ scale }) => `<div class="speech-block speech-band"${scaleStyle(scale)}><div class="speech-message">\n`, '</div></div>\n');
  md.use(container, 'speech', {
    validate: (p) => p.trim().split(/\s+/)[0] === 'speech',
    render: (tokens, idx) => {
      if (tokens[idx].nesting === 1) {
        const { scale, text } = parseInfo(tokens[idx].info, 'speech');
        const own = text.match(/(?:^|\s)photo=(\S+)/);
        tokens[idx].meta = { speaker: text.replace(/(?:^|\s)photo=\S+/, '').trim(), photo: own?.[1] };
        return `<div class="speech-block speech-bubble"${scaleStyle(scale)}><div class="speech-message">\n`;
      }
      // 開きタグ側のトークンから話者を探す
      let depth = 0, speaker = '', own = '';
      for (let i = idx - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t.type === 'container_speech_close') depth++;
        if (t.type === 'container_speech_open') { if (depth === 0) { speaker = t.meta?.speaker || ''; own = t.meta?.photo || ''; break; } depth--; }
      }
      const photo = photoOf(speaker, own);
      const face = photo ? `<img class="speech-speaker-photo" src="${esc(photo)}" alt="">` : ICONS.speaker;
      return `</div><div class="speech-speaker">${face}${speaker ? `<span>${esc(speaker)}</span>` : ''}</div></div>\n`;
    },
  });

  // --- コード ---------------------------------------------------------------
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const [lang = '', ...label] = t.info.trim().split(/\s+/);
    if (lang === 'mermaid') return fence(tokens, idx, options, env, self);
    const info = t.info;
    t.info = lang === 'text' ? '' : lang;
    let body = fence(tokens, idx, options, env, self);
    t.info = info;
    // シェルのコマンドは highlight.js がほとんど色を付けないので、行頭のコマンド名・--オプション・<差し替える値>に色を足す
    if (['bash', 'sh', 'shell', 'zsh'].includes(lang)) body = body.replace(/(^|\n|<code[^>]*>)(\s*)([a-z][\w.-]*)(?= )/g, (m, br, sp, cmd) => `${br}${sp}<span class="hljs-built_in">${cmd}</span>`)
      .replace(/(^|[\s(])(--?[a-zA-Z][\w-]*)/g, (m, pre, flag) => `${pre}<span class="hljs-attr">${flag}</span>`)
      .replace(/&lt;[^&\n]*?&gt;/g, (m) => `<span class="hljs-string">${m}</span>`);
    // 言語なし（text）でも、文字列だけは色を付ける
    if (!t.info.trim() || lang === 'text') body = body.replace(/&quot;[^\n]*?&quot;/g, (m) => `<span class="hljs-string">${m}</span>`);
    const title = label.join(' ');
    const close = t.meta?.caption ? '' : '</figure>';
    return `<figure class="code-block"><div class="code-window"><div class="code-chrome"><i></i><i></i><i></i>${title ? `<span>${md.renderInline(title)}</span>` : ''}</div>${body}</div>${close}\n`;
  };

  // --- 構造の組み立て（inline解析の後） -----------------------------------------
  md.core.ruler.push('jinno_structure', (state) => {
    const tokens = state.tokens;
    const T = state.Token;
    const html = (content) => Object.assign(new T('html_block', '', 0), { content });

    // 掛け合い・対象と目的のリストを部品の形へ
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type.startsWith('container_') && t.nesting === 1) stack.push({ name: t.type.slice(10, -5), listLevel: t.level + 1, rows: 0 });
      else if (t.type.startsWith('container_') && t.nesting === -1) stack.pop();
      const ctx = stack[stack.length - 1];
      if (!ctx) continue;

      if (ctx.name === 'dialogue') {
        if ((t.type === 'bullet_list_open' || t.type === 'bullet_list_close') && t.level === ctx.listLevel) t.hidden = true;
        if (t.type === 'list_item_open' && t.level === ctx.listLevel + 1) {
          // 直後の段落の先頭「名前:」を話者として取り出す
          const inline = tokens[i + 2];
          let speaker = '';
          const first = inline?.children?.[0];
          // 「[right] 名前:」「[ai left] 名前:」のように、アイコンと左右を明示できる（既定はAgentなら右・AI）
          // 「[photo=figs/me.png] 私:」で顔写真（フロントマターの photos でも割り当てられる）
          const m = first?.type === 'text' && first.content.match(/^(?:\[((?:[a-z]+(?:=[^\s\]]+)?\s*)+)\]\s*)?([^:：]{1,16})[:：]\s*/);
          let opts = [];
          if (m) { opts = (m[1] || '').split(/\s+/); speaker = m[2].trim(); first.content = first.content.slice(m[0].length); }
          const agent = opts.includes('ai') || (!opts.includes('person') && isAgent(speaker));
          const side = opts.includes('right') ? 'right' : opts.includes('left') ? 'left' : agent ? 'right' : 'left';
          t.tag = 'div'; t.attrs = [['class', `dialogue-row is-${side}`]]; t.markup = ''; t.info = '';
          tokens[i + 1].hidden = false; tokens[i + 1].attrs = [['class', 'dialogue-bubble']];
          const photo = photoOf(speaker, opts.find((o) => o.startsWith('photo='))?.slice(6));
          const face = photo ? `<span class="person-icon has-photo">${photoIcon(photo)}</span>` : `<span class="person-icon">${agent ? ICONS.ai : ICONS.person}</span>`;
          ctx.pending = `<div class="dialogue-who">${face}<span class="dialogue-speaker">${esc(speaker)}</span></div>`;
        }
        if (t.type === 'paragraph_close' && ctx.pending) { t.hidden = false; tokens.splice(i + 1, 0, html(ctx.pending)); ctx.pending = null; i++; }
        if (t.type === 'list_item_close' && t.level === ctx.listLevel + 1) t.tag = 'div';
      }

      if (ctx.name === 'agenda' && t.type === 'inline' && tokens[i - 1]?.type === 'paragraph_open') {
        // 1行目を章名、2行目以降を説明にする
        const kids = t.children;
        const br = kids.findIndex((c) => c.type === 'softbreak' || c.type === 'hardbreak');
        const tag = (content) => Object.assign(new T('html_inline', '', 0), { content });
        if (br >= 0) kids.splice(br, 1, tag('</strong><p>'));
        kids.unshift(tag('<span class="agenda-copy"><strong>'));
        kids.push(tag(br >= 0 ? '</p></span>' : '</strong></span>'));
      }

      if (ctx.name === 'purpose') {
        if ((t.type === 'bullet_list_open' || t.type === 'bullet_list_close') && t.level === ctx.listLevel) t.hidden = true;
        if (t.type === 'list_item_open' && t.level === ctx.listLevel + 1) {
          const inline = tokens[i + 2];
          const emphasis = inline?.children?.some((c) => c.type === 'strong_open');
          t.tag = 'div'; t.attrs = [['class', `purpose-row${emphasis ? ' is-emphasis' : ''}`]];
          Object.assign(tokens[i + 1], { hidden: false, tag: 'span', attrs: [['class', 'purpose-label']], block: false });
          Object.assign(tokens[i + 3], { hidden: false, tag: 'span', block: true });
          if (ctx.rows++ > 0) { tokens.splice(i, 0, html('<span class="purpose-arrow" aria-hidden="true"></span>')); i++; }
        }
        if (t.type === 'list_item_close' && t.level === ctx.listLevel + 1) t.tag = 'div';
      }
    }

    // コードの直後の段落はキャプションとして figure の中へ入れる
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'fence' || tokens[i + 1]?.type !== 'paragraph_open' || tokens[i + 1].level !== t.level) continue;
      t.meta = { ...(t.meta || {}), caption: true };
      Object.assign(tokens[i + 1], { tag: 'figcaption', attrs: [['class', 'code-caption']] });
      let j = i + 2;
      while (tokens[j].type !== 'paragraph_close') j++;
      tokens[j].tag = 'figcaption';
      tokens.splice(j + 1, 0, html('</figure>\n'));
    }

    // ページごとに、タイトル直後の段落をリード、それ以降を .blocks で包む
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'marpit_slide_open') continue;
      let end = i + 1;
      while (end < tokens.length && tokens[end].type !== 'marpit_slide_close') end++;
      // ヘッダー・フッターのトークンは section の直下に残す
      let start = i + 1;
      while (start < end && /^marpit_(header|footer)/.test(tokens[start].type)) {
        while (start < end && !/^marpit_(header|footer)_close$/.test(tokens[start].type)) start++;
        start++;
      }
      let stop = end;
      for (let k = start; k < end; k++) if (tokens[k].type === 'marpit_footer_open' || tokens[k].type === 'marpit_header_open') { stop = k; break; }

      const base = tokens[i].level + 1;
      let cursor = start;
      const skippable = (t) => ['marpit_comment', 'front_matter'].includes(t.type) || t.type.startsWith('marpit_style') || (t.type === 'html_block' && /^\s*<style/i.test(t.content));
      const skip = () => { while (cursor < stop && skippable(tokens[cursor])) cursor++; };
      skip();
      if (tokens[cursor]?.type === 'heading_open' && tokens[cursor].tag === 'h1') {
        while (cursor < stop && tokens[cursor].type !== 'heading_close') cursor++;
        cursor++;
        skip();
        const p = tokens[cursor];
        const inline = tokens[cursor + 1];
        const onlyImage = inline?.children?.every((c) => c.type === 'image' || (c.type === 'text' && !c.content.trim()) || c.type === 'softbreak');
        const noLead = /(^|\s)no-lead(\s|$)/.test(tokens[i].meta?.marpitDirectives?.class || '');
        if (p?.type === 'paragraph_open' && p.level === base && !onlyImage && !noLead) {
          p.attrJoin('class', 'lead');
          while (cursor < stop && tokens[cursor].type !== 'paragraph_close') cursor++;
          cursor++;
        }
      }
      // 画像だけの段落は図として扱う
      let hasImage = false, firstBlock = true;
      for (let k = cursor; k < stop; k++) {
        const tk = tokens[k];
        if (tk.level !== base || tk.nesting === -1 || tk.type === 'marpit_comment') continue;
        const inl = tokens[k + 1];
        const img = tk.type === 'paragraph_open' && inl?.children?.length && inl.children.every((c) => c.type === 'image' || c.type === 'softbreak' || (c.type === 'text' && !c.content.trim()));
        if (img) { tk.attrJoin('class', 'image-block'); if (firstBlock) hasImage = true; }
        firstBlock = false;
      }
      tokens.splice(stop, 0, html('</div>\n'));
      tokens.splice(cursor, 0, html(`<div class="blocks${hasImage ? ' is-visual' : ''}">\n`));
      i = stop + 2;
    }
  });

}

// エディター用（オプトイン）。ブロック要素に元のMarkdownの行範囲を data-line="開始-終了"（0始まり、終了は含まない）で付ける。
// jinnoPlugin の後に marp.use(sourceMapPlugin) したときだけ効くので、marp-cli や検査の出力は変わらない。
export function sourceMapPlugin(md) {
  md.jinnoSourceMap = true; // components.mjs が部品の中の文字にも data-span を付ける
  const skip = new Set(['inline', 'html_block', 'marpit_comment', 'front_matter', 'fence', 'code_block', 'hr']);
  md.core.ruler.push('jinno_source_map', (state) => {
    for (const t of state.tokens) {
      if (!t.map || t.nesting === -1 || skip.has(t.type) || t.type.startsWith('container_')) continue;
      t.attrSet('data-line', `${t.map[0]}-${t.map[1]}`);
    }
  });
}
