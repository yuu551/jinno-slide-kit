// 書き方の早見表（チートシート）。エディターの「書き方」と docs/cheatsheet.md の元データ。
// 記法を足したら、ここにも1件足す（plugin.mjs / components.mjs / テーマのクラス）。
//   syntax  そのまま書く・コピーする記法
//   page    「ページとして挿入」とプレビューに使う1ページ分（省略時は タイトル＋リード＋syntax）
//   preview プレビューだけ差し替えるとき（画像のパスをダミーの図にするなど）
//   fm      プレビューのフロントマターに足す行（chapters・photos など）
//   notes   書き分け・オプション

// プレビュー用のダミーの図と顔写真（エディターが /cheat/ で配る。実際の資料では figs/ のファイルを指す）。
// data: の SVG は markdown-it が画像として通さないため、ファイルにしてある
const FIG = '/cheat/figure.svg';
const FACE = '/cheat/face.svg';

export const GROUPS = [
  ['page', 'ページの基本'],
  ['kind', 'ページの種類'],
  ['figure', '図・コード・表'],
  ['talk', '会話・語り'],
  ['parts', '構造の部品'],
  ['size', '大きさ・調整'],
];

const jacketKicker = '<p class="kicker">読書メモ <span>勉強会</span></p>';
const jacketAuthor = '<p class="who"><b>Your Name</b></p>';
const jacketArt = '![](figs/cover-art.svg)';
const coverPage = `<!-- _class: cover cover-talk -->

# 読書メモから<br>次の一冊を選ぶ

${jacketKicker}

<p class="sub">読み終えた本に一行だけ書き添える</p>

${jacketAuthor}

${jacketArt}`;
const backCoverPage = `<!-- _class: closing back-cover -->

# ありがとうございました

${jacketKicker}

${jacketAuthor}

${jacketArt}`;

export const CHEATSHEET = [
  // --- ページの基本 ---------------------------------------------------------------
  {
    id: 'page', group: 'page', name: '1ページの形', when: 'すべてのページ',
    syntax: `# タイトル

最初の段落がリード文になります。読む理由と結論を2行までで。

ここから下が本文（図・部品・箇条書き）です。`,
    notes: ['`---`（前後に空行）でページを区切る', 'リードを出したくないページは `<!-- _class: no-lead -->`'],
  },
  {
    id: 'frontmatter', group: 'page', name: 'フロントマター（資料全体の設定）', when: 'ファイルの先頭に1回',
    syntax: `---
marp: true
theme: paper
paginate: true
title: "資料のタイトル"
chapters: [基礎, 仕組み, 使ってみる]
photos: [私=figs/me.png]
style: |
  section { --accent: #574789; --font-scale: 1.06; }
---`,
    page: '# フロントマターはページに出ません\n\nテーマ・章の一覧・顔写真・アクセント色など、資料全体の設定です。',
    notes: ['`--accent` はアクセント色、`--font-scale` は文字の大きさ（全体）', '`chapters` と `photos` は下の「章のパンくず」「顔写真」を参照'],
  },
  {
    id: 'chapter', group: 'page', name: '章のパンくず', when: '章のあるデッキ',
    syntax: '<!-- chapter: 仕組み -->',
    page: '<!-- chapter: 仕組み -->\n\n# 章の最初のページ\n\nフッターに章の並びが出て、今の章が強調されます。',
    fm: ['chapters: [基礎, 仕組み, 使ってみる]'],
    notes: ['章の最初のページに1回書くと、以降のページに続く', '章の一覧はフロントマターの `chapters`', 'このページだけフッターを消す: `<!-- _footer: "" -->`'],
  },
  {
    id: 'note', group: 'page', name: '発表者ノート', when: '話すこと・出典',
    syntax: `<!--
ここに話すことや出典を書きます。スライドには出ません。
-->`,
    page: '# 発表者ノート\n\nノートは発表者画面と PDF のノートに出ます。\n\n<!--\nここに話すことや出典を書きます。\n-->',
    notes: ['ディレクティブ（`_class:` など）でないコメントがノートになる'],
  },
  // --- ページの種類 ---------------------------------------------------------------
  {
    id: 'cover', group: 'kind', name: '表紙', when: '1ページ目',
    syntax: coverPage, page: coverPage,
    notes: ['右の560×720の面（色・点・円弧）はテーマが描く。挿絵は透明な地に題材の主役だけを描いて置く。', '肩の `kicker` に資料名、`span` に日付・イベント名・持ち時間を書く。罫の右に小さく出る。', '右の面を濃くするなら両端を `stage` にする（`layout: stage` の資料は自動）。表紙と裏表紙は同じ指定にする。'],
  },
  {
    id: 'divider', group: 'kind', name: '章扉', when: '章の始まり',
    syntax: `<!-- _class: divider -->

# 章の名前

この章で話すことを1行で。`,
  },
  {
    id: 'closing', group: 'kind', name: '裏表紙', when: '最後のページ',
    syntax: backCoverPage, page: backCoverPage,
    notes: ['表紙と同じ肩・署名・挿絵を置く。署名の後にMarkdownリンクの段落を書くと、題名の下に連絡先として出る。'],
  },
  {
    id: 'centered', group: 'kind', name: '本文を縦中央に', when: '部品が小さく、上に寄って見えるとき',
    syntax: '<!-- _class: centered -->',
    page: '<!-- _class: centered -->\n\n# 縦中央のページ\n\n本文をページの縦中央に置きます。\n\n::: band\n伝えたいことを**帯**で。\n:::',
  },
  {
    id: 'statement', group: 'kind', name: '主張のページ', when: '一言で言い切るとき',
    syntax: `<!-- _class: statement -->

# 見出し

大きな文字で言い切る一文。`,
  },
  {
    id: 'full', group: 'kind', name: '図を全面に', when: '図だけで見せるページ',
    syntax: `<!-- _class: full -->

# タイトル

![](figs/x.svg)`,
    preview: `<!-- _class: full -->\n\n# タイトル\n\n![](${FIG})`,
    notes: ['フッターが消え、図が本文の領域いっぱいに広がる'],
  },
  // --- 図・コード・表 ---------------------------------------------------------------
  {
    id: 'figure', group: 'figure', name: '図（SVG）', when: 'リード＋図の基本のページ',
    syntax: '![h:380](figs/x.svg)',
    preview: `# 図のページ\n\n図を読む理由になるリード文を書きます。\n\n![h:380](${FIG})`,
    notes: ['`h:380` は高さ（328〜410px が目安）。細部を読ませる図は縮めない', 'エディターでは図をダブルクリックで直接編集', '図は `figs/src/make_figs.py` で作って `slides figs` で作り直す'],
  },
  {
    id: 'code', group: 'figure', name: 'コード（ウィンドウ風）', when: '設定やコードを見せる',
    syntax: `\`\`\`python ウィンドウの見出し
def handler(event, context):
    return {"ok": True}
\`\`\`
フェンスの直後の段落がキャプションになります`,
    notes: ['言語なしは ` ```text 見出し `', 'Mermaid は ` ```mermaid `'],
  },
  {
    id: 'table', group: 'figure', name: '表', when: '観点ごとの比較・一覧',
    syntax: `| 項目 | 説明 |
| --- | --- |
| 1つ目 | **強調**もできる |
| 2つ目 | セルの中の改行は <br> |`,
    notes: ['大きさは `::: scale 1.2` で包む', '1列目は太字・薄い地になる'],
  },
  // --- 会話・語り ---------------------------------------------------------------
  {
    id: 'dialogue', group: 'talk', name: '掛け合い', when: '疑問と答えで話を進める',
    syntax: `::: dialogue 0.95
- 私: ここに疑問を書きます。
  2行目も書けます。
- Agent君: ここに答えを書きます。
:::`,
    notes: ['名前に agent / AI / bot を含むと右・ロボットのアイコン', '明示: `- [ai] 名前:` `- [person right] 名前:`', '顔写真: `- [photo=figs/me.png] 私:`（全体はフロントマターの `photos`）'],
  },
  {
    id: 'speech', group: 'talk', name: '語りかけ', when: '自分の言葉で1つ伝える',
    syntax: `::: speech 私
ここに**語りかけ**を書きます。
:::`,
    notes: ['顔写真: `::: speech 私 photo=figs/me.png`', '縦中央と合わせると収まりがよい: `<!-- _class: centered lead-1 -->`'],
  },
  {
    id: 'band', group: 'talk', name: '帯', when: '結論をひと言で強調',
    syntax: `::: band
ここに**伝えたいこと**を書きます。
:::`,
  },
  {
    id: 'photos', group: 'talk', name: '話者の顔写真', when: '「私」を写真にしたい',
    syntax: 'photos: [私=figs/me.png]',
    page: '# 顔写真の掛け合い\n\nフロントマターに書くと、掛け合いと語りかけの「私」が写真になります。\n\n::: dialogue 0.9\n- 私: 写真で話すと親しみが出るね。\n- Agent君: アイコンの大きさは線画と同じだよ。\n:::',
    preview: `# 顔写真の掛け合い\n\nフロントマターに書くと、掛け合いと語りかけの「私」が写真になります。\n\n::: dialogue 0.9\n- [photo=${FACE}] 私: 写真で話すと親しみが出るね。\n- Agent君: アイコンの大きさは線画と同じだよ。\n:::`,
    notes: ['フロントマターに書く（資料全体の既定）', '1か所だけ変える: `- [photo=figs/other.png] 私:`'],
  },
  {
    id: 'quote', group: 'talk', name: '引用（人の言葉）', when: '発言を引用する',
    syntax: `::: quote
小さく始めて、成功事例が増えてから共通化を進めましょう。

— 出典の名前『資料名』
:::`,
    notes: ['「— 」で始まる段落が出典になる'],
  },
  {
    id: 'prose', group: 'talk', name: '語り（文章）', when: 'おわりに・まとめの文章',
    syntax: `::: prose 1.15
ここに締めくくりの文章を書きます。**伝えたいこと**は太字に。

段落を分けて書けます。
:::`,
  },
  // --- 構造の部品 ---------------------------------------------------------------
  {
    id: 'purpose', group: 'parts', name: '対象と目的', when: '冒頭で誰に向けた資料かを示す',
    syntax: `::: purpose 1.12
- 対象
  - この技術を知り、使ってみたい方
- **目的**
  - 全体像と使い分けを理解する
:::`,
    notes: ['`**目的**` のように太字の行が強調される'],
  },
  {
    id: 'agenda', group: 'parts', name: 'アジェンダ', when: '章の並び',
    syntax: `::: agenda
1. 1つ目の章
   2行目が説明になります
2. 2つ目の章
3. 3つ目の章
:::`,
  },
  {
    id: 'scene', group: 'parts', name: '場面図', when: '誰が誰に何を頼むか',
    syntax: `::: scene 1.28
- [user] 利用者: ここに依頼を書きます
  → 依頼
- [agent!] Agent君 {実行基盤}: 次に何をするか考える
  → 呼び出し
- [server] 外部サービス
:::`,
    notes: ['アイコン: user / agent / llm / server / db / doc / browser / tool / search / mail / calendar / chat / cloud / pc', '`[agent!]` で強調、`{外枠 / 内枠}` で枠、`{~LLM}` で破線の枠', '`### キャプション | 結論` でグループを分ける'],
  },
  {
    id: 'flow', group: 'parts', name: '流れ', when: '処理の順番',
    syntax: `::: flow 1.28
- 判断: 必要な情報とツールを選ぶ
- **呼び出し**: 接続先へ要求する
- 観測: 結果やエラーを読む
:::`,
    notes: ['縦に並べる: `::: flow vertical`', '`**タイトル**` の段が強調される'],
  },
  {
    id: 'compare', group: 'parts', name: '比較', when: '2〜3案の違い',
    syntax: `::: compare 1.28
- 案A
  - 良いところ
  - 気をつけるところ
- 案B
  - 良いところ
  - ※ 向いている場面
:::`,
    notes: ['「※」で始まる項目は列の補足'],
  },
  {
    id: 'bullets', group: 'parts', name: '見出しつき箇条書き', when: '観点ごとに短く並べる',
    syntax: `::: bullets 1.18 rule
### 観点1
- 短く1行で
### 観点2
- 短く1行で
:::`,
    notes: ['`rule` で上に罫線'],
  },
  {
    id: 'callout', group: 'parts', name: '補足の囲み', when: '表やコードの下に1〜2行',
    syntax: '> [!設定] 見出しつきの補足を1〜2行で書きます。',
    notes: ['見出しなしは `> 補足`'],
  },
  {
    id: 'profile', group: 'parts', name: '自己紹介', when: '登壇者の紹介',
    syntax: `::: profile 1.28
![](figs/me.png)
写真の説明（任意）
- 名前: 発表者名
- 関心のある分野: 可視化
:::`,
    preview: `# 自己紹介\n\n簡単な自己紹介をさせていただきます！\n\n::: profile 1.1\n![](${FACE})\n- 名前: 発表者名\n- 関心のある分野: 可視化\n:::`,
  },
  {
    id: 'links', group: 'parts', name: 'リンク', when: '参考資料',
    syntax: `::: links
- [ドキュメントの名前](https://example.com/): 何の根拠か
- [ブログの名前](https://example.com/): 何の根拠か
:::`,
  },
  // --- 大きさ・調整 ---------------------------------------------------------------
  {
    id: 'scale', group: 'size', name: '部品の倍率', when: '部品を大きく・小さく',
    syntax: `::: dialogue 0.9      ← 部品名のあとの数字が倍率

::: scale 1.2         ← 表・コード・箇条書きなどを包む
| 項目 | 説明 |
| --- | --- |
| 1つ目 | 説明 |
:::`,
    page: '# 倍率\n\n表やコードは `::: scale` で包んで倍率を変えます。\n\n::: scale 1.2\n| 項目 | 説明 |\n| --- | --- |\n| 1つ目 | 説明を書きます |\n| 2つ目 | 説明を書きます |\n:::',
    notes: ['見切れたら、倍率を下げる前に文言・改行・図の余白を見直す', 'エディターの右側のスライダーでも変えられる'],
  },
  {
    id: 'lead', group: 'size', name: 'リードの大きさ', when: 'リードが長い・短い',
    syntax: '<!-- _class: lead-s -->',
    page: '<!-- _class: lead-s -->\n\n# リードの大きさ\n\nlead-1（1.0）/ lead-11（1.1）/ lead-s（1.12）/ lead-m（1.16）/ lead-l（1.26）。既定は1.2です。',
    notes: ['`lead-1` 1.0 / `lead-11` 1.1 / `lead-s` 1.12 / `lead-m` 1.16 / `lead-l` 1.26（既定 1.2）', 'クラスは空白で並べる: `<!-- _class: centered lead-1 -->`'],
  },
  {
    id: 'scoped', group: 'size', name: 'このページだけの調整', when: '1枚だけ色や余白を変える',
    syntax: '<style scoped>section { --lead-scale: 1.1; --accent: #825539; }</style>',
    page: '<style scoped>section { --accent: #825539; }</style>\n\n# このページだけアクセントを変える\n\n**強調**や部品の色が、このページだけ変わります。\n\n::: band\nこのページだけ**橙**に。\n:::',
    notes: ['タイトルより前に書く', '全体の設定はフロントマターの `style`'],
  },
];

// 1ページ分の Markdown（挿入とプレビューの元）
export function pageOf(e) {
  return e.page || `# ここにタイトル\n\nリード文を書きます。読む理由と結論を2行までで。\n\n${e.syntax}`;
}
export function previewOf(e) {
  return e.preview || pageOf(e);
}
