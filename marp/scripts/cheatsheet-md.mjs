// marp/cheatsheet.mjs から docs/cheatsheet.md（書き方の早見表）を作る。記法を足したら作り直す。
// usage: node marp/scripts/cheatsheet-md.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHEATSHEET, GROUPS } from '../cheatsheet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = [
  '# 書き方の早見表',
  '',
  'エディターでは ツールバーの「書き方」（⌘⇧K）で、見本を見ながらそのまま入れられます。',
  'この表は `marp/cheatsheet.mjs` から `node marp/scripts/cheatsheet-md.mjs` で作っています（直接は直さない）。',
  '',
  ...GROUPS.map(([g, label]) => `- [${label}](#${label})`),
  '',
];
for (const [g, label] of GROUPS) {
  out.push(`## ${label}`, '');
  for (const e of CHEATSHEET.filter((x) => x.group === g)) {
    out.push(`### ${e.name}`, '', `使いどころ：${e.when}`, '', '```markdown', e.syntax, '```', '');
    if (e.notes?.length) out.push(...e.notes.map((n) => `- ${n}`), '');
  }
}
fs.writeFileSync(path.join(root, 'docs', 'cheatsheet.md'), out.join('\n'));
console.log(`docs/cheatsheet.md（${CHEATSHEET.length}項目）`);
