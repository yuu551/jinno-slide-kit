// 構造を持つ部品（場面図・流れ・比較・自己紹介・リンク・語り）。
// コンテナの中身を行単位で読み、部品のHTMLへ置き換える。文字の装飾（**太字**など）は markdown-it で描画する。
//
//   ::: scene [倍率]                       場面図。### キャプション | 結論 でグループを分ける（省略可）
//   - [user] 開発者: 吹き出しの文            [icon] は user / agent / llm / server / db / doc / browser / tool /
//     続きの行                                search / mail / calendar / chat / cloud / pc。[agent!] で強調
//     → 相談                                 次の人への矢印とラベル（ラベルなしは「→」だけ）
//   - [agent!] AIエージェント {実行基盤 / SDK}   {…} は外枠（外→内）。{~LLM} は破線
//
//   ::: flow [vertical] [倍率]             - タイトル: 説明（**タイトル** で強調）
//   ::: compare [倍率]                     - 列の見出し / 入れ子リストで項目 / 「※」で始まる項目は列の補足
//   ::: profile [倍率]                     ![](写真) と、その次の行の写真の説明（任意） / - 項目名: 内容
//   ::: links [倍率]                       - [名前](URL): 補足
//   ::: prose [倍率]                       段落を語りの文章として大きく組む
//   ::: bullets [倍率] [rule]              箇条書き。### で小見出し、rule で上に罫線
//   > [!設定] 本文                          補足の囲みに小さな見出しを付ける
import container from 'markdown-it-container';

import { Bot, Calendar, Cloud, Database, FileText, Globe, Link, Mail, MessageCircle,
  Monitor, Search, Server, Sparkles, User, Wrench } from 'lucide';
import { iconPaths, iconSvg } from './icons.mjs';

const scene = { user: User, agent: Bot, llm: Sparkles, server: Server, db: Database, doc: FileText,
  browser: Globe, tool: Wrench, search: Search, mail: Mail, calendar: Calendar, chat: MessageCircle,
  cloud: Cloud, pc: Monitor };
export const SCENE_ICONS = Object.fromEntries(Object.entries(scene).map(([key, shapes]) => [key, iconPaths(shapes)]));
const svg = body => iconSvg(body);
const LINK_ICON = svg(iconPaths(Link));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 行は { text, line, off }（line は元のMarkdownの行番号、off はその行で text が始まる桁）で扱う。
// エディター用の描画（sourceMapPlugin を使ったとき）だけ、文字ごとに data-span="行:桁-行:桁" を付けて直接編集できるようにする。
const entry = (text, line, off = 0) => ({ text, line, off });

// 「- 」で始まる行を項目として、字下げされた続きの行をまとめる
function items(entries) {
  const out = [];
  for (const e of entries) {
    if (/^- /.test(e.text)) out.push({ head: entry(e.text.slice(2), e.line, e.off + 2), rest: [] });
    else if (out.length && /^\s+\S/.test(e.text)) {
      const k = e.text.match(/^ {0,2}/)[0].length;
      out[out.length - 1].rest.push(entry(e.text.slice(k), e.line, e.off + k));
    } else if (out.length && !e.text.trim()) out[out.length - 1].rest.push(entry('', e.line, e.off));
  }
  for (const it of out) while (it.rest.length && !it.rest[it.rest.length - 1].text.trim()) it.rest.pop();
  return out;
}

function parseArgs(info, name) {
  const words = info.trim().split(/\s+/).slice(1);
  const scale = words.find((w) => /^\d+(\.\d+)?$/.test(w));
  return { scale: scale && Number(scale), words: words.filter((w) => w !== scale) };
}
const scaleStyle = (scale) => (scale ? ` style="--component-scale: ${scale}"` : '');

export default function components(md) {
  const inline = (text) => md.renderInline(text.trim());
  // 区間 [from, to]（from = { e, col }、to = { e, col }）を data-span にする。続きの行は to.e.off の字下げで始まる
  const span = (from, to = null) => {
    if (!md.jinnoSourceMap) return '';
    const b = to || { e: from.e, col: from.e.text.length };
    return ` data-span="${from.e.line}:${from.e.off + from.col}-${b.e.line}:${b.e.off + b.col}" data-indent="${b.e.off}"`;
  };
  const tailOf = (e) => ({ e, col: e.text.replace(/\s+$/, '').length });

  const renderers = {
    scene(entries, { scale }) {
      const groups = [];
      let g = null;
      for (const e of entries) {
        const m = e.text.match(/^###\s+(.*?)(?:\s*[|｜]\s*(.*))?$/d);
        if (m) { groups.push((g = { caption: m[1], verdict: m[2], capAt: m.indices[1], verAt: m.indices[2], e, lines: [] })); continue; }
        if (!g) groups.push((g = { lines: [] }));
        g.lines.push(e);
      }
      const node = (it) => {
        const h = it.head;
        const m = h.text.match(/^\[(\w+)(!?)\]\s*(.*?)\s*(?:\{([^}]*)\})?\s*(?:[:：]\s*(.*))?$/d);
        if (!m) return { html: `<div class="scene-node"><span class="scene-label"${span({ e: h, col: 0 })}>${inline(h.text)}</span></div>` };
        const [, icon, strong, label, frames, first] = m;
        const bubbleEntries = [];
        if (first !== undefined && first.trim()) bubbleEntries.push({ e: h, col: m.indices[5][0] });
        let arrow = null, arrowAt = null;
        for (const r of it.rest) {
          const am = r.text.match(/^(\s*)→\s*/);
          if (am) { arrow = r.text.slice(am[0].length); arrowAt = { e: r, col: am[0].length }; break; }
          if (r.text.trim()) bubbleEntries.push({ e: r, col: 0 });
        }
        const bubble = bubbleEntries.map((b) => b.e.text.slice(b.col)).join('\n').trim();
        const bspan = bubbleEntries.length ? span(bubbleEntries[0], tailOf(bubbleEntries[bubbleEntries.length - 1].e)) : '';
        let html = `<div class="scene-node${strong ? ' is-emphasis' : ''}">${bubble ? `<p class="scene-bubble"${bspan}>${inline(bubble)}</p>` : ''}<span class="scene-icon">${svg(SCENE_ICONS[icon] || SCENE_ICONS.user)}</span><span class="scene-label"${span({ e: h, col: m.indices[3][0] }, { e: h, col: m.indices[3][1] })}>${inline(label)}</span></div>`;
        if (frames) {
          const dashed = frames.trim().startsWith('~');
          const names = frames.replace(/^\s*~/, '').split(/\s*\/\s*/).filter(Boolean);
          for (const f of names.reverse()) html = `<div class="scene-frame${dashed ? ' is-dashed' : ''}"><b>${inline(f)}</b>${html}</div>`;
        }
        return { html, arrow, arrowAt };
      };
      const body = groups.map((gr) => {
        const nodes = items(gr.lines).map(node);
        const row = nodes.map((n) => n.html + (n.arrow !== null ? `<span class="scene-arrow" aria-hidden="true">${n.arrow ? `<span${span(n.arrowAt, tailOf(n.arrowAt.e))}>${inline(n.arrow)}</span>` : ''}</span>` : '')).join('');
        const cap = gr.caption
          ? `<div class="scene-caption"><span${span({ e: gr.e, col: gr.capAt[0] }, { e: gr.e, col: gr.capAt[1] })}>${inline(gr.caption)}</span>${gr.verdict ? `<small${span({ e: gr.e, col: gr.verAt[0] }, { e: gr.e, col: gr.verAt[1] })}>${inline(gr.verdict)}</small>` : ''}</div>`
          : '';
        return `<div class="scene-group"><div class="scene-row">${row}</div>${cap}</div>`;
      }).join('');
      return `<div class="scene cols-${groups.length}"${scaleStyle(scale)}>${body}</div>`;
    },

    flow(entries, { scale, words }) {
      const dir = words.includes('vertical') ? 'is-vertical' : 'is-horizontal';
      const seq = items(entries).map((it, i) => {
        const h = it.head;
        const m = h.text.match(/^(\*\*)?(.*?)\1?\s*(?:[:：]\s*(.*))?$/d);
        const emphasis = Boolean(m[1]);
        const bodyEntries = [...(m[3] !== undefined && m[3].trim() ? [{ e: h, col: m.indices[3][0] }] : []), ...it.rest.filter((r) => r.text.trim()).map((r) => ({ e: r, col: 0 }))];
        const body = bodyEntries.map((b) => b.e.text.slice(b.col)).join('\n');
        const bspan = bodyEntries.length ? span(bodyEntries[0], tailOf(bodyEntries[bodyEntries.length - 1].e)) : '';
        return `<div class="flow-seq">${i ? '<span class="flow-arrow" aria-hidden="true"></span>' : ''}<article class="${emphasis ? 'is-emphasis' : ''}"><strong${span({ e: h, col: m.indices[2][0] }, { e: h, col: m.indices[2][1] })}>${inline(m[2])}</strong>${body ? `<p${bspan}>${inline(body)}</p>` : ''}</article></div>`;
      });
      return `<div class="flow ${dir}"${scaleStyle(scale)}>${seq.join('')}</div>`;
    },

    compare(entries, { scale }) {
      const cols = items(entries).map((it) => {
        const points = items(it.rest);
        const text = (p, col = 0) => [p.head.text.slice(col), ...p.rest.map((r) => r.text)].join('\n');
        const last = (p) => tailOf(p.rest.length ? p.rest[p.rest.length - 1] : p.head);
        const list = points.filter((p) => !/^※/.test(p.head.text)).map((p) => `<li${span({ e: p.head, col: 0 }, last(p))}>${inline(text(p))}</li>`).join('');
        const notes = points.filter((p) => /^※/.test(p.head.text)).map((n) => {
          const col = n.head.text.match(/^※\s*/)[0].length;
          return `<span${span({ e: n.head, col }, last(n))}>${inline(text(n, col))}</span>`;
        }).join('<br>');
        return `<article><h3${span({ e: it.head, col: 0 }, tailOf(it.head))}>${inline(it.head.text)}</h3><ul>${list}</ul>${notes ? `<small>${notes}</small>` : ''}</article>`;
      });
      return `<div class="compare cols-${cols.length}"${scaleStyle(scale)}>${cols.join('')}</div>`;
    },

    profile(entries, { scale }) {
      const img = entries.findIndex((e) => /^!\[/.test(e.text.trim()));
      let photo = '';
      if (img >= 0) {
        const nx = entries[img + 1];
        const note = nx && !/^- /.test(nx.text) && nx.text.trim() ? nx : null;
        photo = `<figure class="profile-photo">${md.renderInline(entries[img].text.trim())}${note ? `<figcaption${span({ e: note, col: 0 }, tailOf(note))}>${inline(note.text)}</figcaption>` : ''}</figure>`;
      }
      const rows = items(entries).map((it) => {
        const h = it.head;
        const m = h.text.match(/^(.*?)[:：]\s*(.*)$/d);
        const label = m ? m[1] : h.text;
        const textEntries = [...(m ? [{ e: h, col: m.indices[2][0] }] : []), ...it.rest.filter((r) => r.text.trim()).map((r) => ({ e: r, col: 0 }))];
        const text = textEntries.map((t) => t.e.text.slice(t.col)).join('\n');
        const tspan = textEntries.length ? span(textEntries[0], tailOf(textEntries[textEntries.length - 1].e)) : '';
        return `<div class="profile-row"><span class="profile-label"${span({ e: h, col: 0 }, { e: h, col: m ? m.indices[1][1] : h.text.length })}>${inline(label)}</span><p${tspan}>${inline(text)}</p></div>`;
      });
      return `<div class="profile${photo ? '' : ' no-photo'}"${scaleStyle(scale)}>${photo}<div class="profile-rows">${rows.join('')}</div></div>`;
    },

    links(entries, { scale }) {
      const list = items(entries).map((it) => {
        const h = it.head;
        const m = h.text.match(/^\[([^\]]+)\]\(([^)]+)\)\s*(?:[:：]\s*(.*))?$/d);
        const label = m ? m[1] : h.text;
        const noteEntries = [...(m && m[3] !== undefined && m[3].trim() ? [{ e: h, col: m.indices[3][0] }] : []), ...it.rest.filter((r) => r.text.trim()).map((r) => ({ e: r, col: 0 }))];
        const note = noteEntries.map((t) => t.e.text.slice(t.col)).join('\n');
        const nspan = noteEntries.length ? span(noteEntries[0], tailOf(noteEntries[noteEntries.length - 1].e)) : '';
        const lspan = m ? span({ e: h, col: m.indices[1][0] }, { e: h, col: m.indices[1][1] }) : span({ e: h, col: 0 });
        return `<article><span class="link-icon">${LINK_ICON}</span><div class="link-copy"><strong${lspan}>${inline(label)}</strong>${m?.[2] ? `<span class="link-url">${esc(m[2])}</span>` : ''}${note ? `<p${nspan}>${inline(note)}</p>` : ''}</div></article>`;
      });
      return `<div class="links cols-${list.length > 1 ? 2 : 1}"${scaleStyle(scale)}>${list.join('')}</div>`;
    },
  };

  for (const name of Object.keys(renderers)) md.use(container, name, { validate: (p) => p.trim().split(/\s+/)[0] === name });
  md.use(container, 'prose', {
    validate: (p) => p.trim().split(/\s+/)[0] === 'prose',
    render: (tokens, idx) => (tokens[idx].nesting === 1 ? `<div class="prose"${scaleStyle(parseArgs(tokens[idx].info).scale)}>\n` : '</div>\n'),
  });

  md.use(container, 'bullets', {
    validate: (p) => p.trim().split(/\s+/)[0] === 'bullets',
    render: (tokens, idx) => {
      if (tokens[idx].nesting !== 1) return '</div>\n';
      const { scale, words } = parseArgs(tokens[idx].info);
      return `<div class="bullet-block${words.includes('rule') ? ' top-rule-on' : ''}"${scaleStyle(scale)}>\n`;
    },
  });

  // 補足の囲み：先頭の [!見出し] を小さな見出しにする
  md.core.ruler.push('jinno_callout_label', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open' || tokens[i + 1]?.type !== 'paragraph_open') continue;
      const inl = tokens[i + 2];
      const first = inl?.children?.[0];
      const m = first?.type === 'text' && first.content.match(/^\[!([^\]]+)\]\s*/);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      if (!first.content && inl.children[1]?.type === 'softbreak') inl.children.splice(1, 1);
      const label = new state.Token('html_block', '', 0);
      label.content = `<small>${esc(m[1])}</small>\n`;
      tokens.splice(i + 1, 0, label);
      tokens[i].attrJoin('class', 'has-label');
    }
  });

  md.core.ruler.push('jinno_components', (state) => {
    const tokens = state.tokens;
    const src = state.src.split('\n');
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const m = t.type.match(/^container_(\w+)_open$/);
      if (!m || !renderers[m[1]]) continue;
      let depth = 0, j = i;
      for (; j < tokens.length; j++) {
        if (tokens[j].type === t.type) depth++;
        if (tokens[j].type === `container_${m[1]}_close` && --depth === 0) break;
      }
      const [start, end] = t.map;
      const lines = src.slice(start + 1, end).map((text, k) => entry(text, start + 1 + k));
      if (lines.length && /^:{3,}\s*$/.test(lines[lines.length - 1].text)) lines.pop();
      const block = new state.Token('html_block', '', 0);
      block.content = renderers[m[1]](lines, parseArgs(t.info, m[1])) + '\n';
      block.map = t.map;
      block.level = t.level;
      tokens.splice(i, j - i + 1, block);
    }
  });
}
