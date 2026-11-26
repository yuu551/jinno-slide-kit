// highlight.js 用の Cedar（AgentCore Policy のルール言語）の定義。plugin.mjs で登録する。
// 色はテーマの .code-window にある hljs-keyword / literal / string / number / comment / variable / type を使う。
// AgentCore の拡張（when guardrails / when temporal / formerly within）もキーワードとして扱う。
export default function cedar(hljs) {
  return {
    name: 'Cedar',
    aliases: ['cedar'],
    keywords: {
      keyword: 'permit forbid suppressOutput when unless in is has like if then else guardrails temporal formerly within',
      literal: 'true false',
      variable: 'principal action resource context',
    },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.C_NUMBER_MODE,
      // AgentCore::Action のような名前空間つきの型名
      { scope: 'type', match: /\b[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)+/ },
    ],
  };
}
