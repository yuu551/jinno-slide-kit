# キットの使い方 / Kit reference

## 日本語

以下のコマンドはキットのフォルダーで実行します。Python のスクリプトには uv を使います。macOS では `brew install uv` で uv を導入できます。`./install.sh` を実行すると、uv が `.python-version` で指定した Python を用意します。

| やりたいこと | 操作 |
| --- | --- |
| 雛形を選ぶ | `pnpm slides templates` で一覧を表示。`talk` は読書メモの6枚。`update` は夜間集計の再実行を紹介する8枚。 |
| SVG単体も紫にして配る | `uv run scripts/paper-edition.py examples/gallery/jev-guardrail/slides.md ~/Slides/jev-paper` で、参照中の図の色を紫に固定した原稿一式を新しいフォルダーに書き出す。 |
| 自分の題名で作る | `pnpm slides new ~/Slides/my-webinar --template webinar --title "雨音の編集入門"` |
| エディターで開く | `pnpm slides split ~/Slides/my-webinar/slides.md` で、左に Markdown・右にスライドを並べて開く。`pnpm slides edit` ならスライドだけの画面で開く。 |
| 図を直す | エディターで図をダブルクリックして文字や形を編集。Python で描き直すときは資料の `figs/src/make_figs.py` を編集し、`pnpm slides figs ~/Slides/my-webinar/slides.md` を実行。再生成すると SVG を上書きします。 |
| レイアウトを確かめる | `pnpm slides check ~/Slides/my-webinar/slides.md --contact` を実行。文字のはみ出しや画像の読み込み失敗は `.check/report.json`、各ページの PNG は `.check/pages/`。 |
| 日本語を見直す | `pnpm slides check ~/Slides/my-webinar/slides.md --no-shots` で検査結果を表示。`ai-phrase` にはページ番号・該当箇所・言い換えの候補が出る。`ai-comma` は見出し・リード・箇条書き・表の読点を指摘する。 |
| AWS の公式アイコンを使う | `pnpm slides icons fetch` で公式の配布元から取得し、`pnpm slides icons find api gateway` で探す。図には `skills/marp-jinno/scripts/jfig.py` の `aws()` で入れる。キットには同梱しない。[AWS の公式アイコンを使う](aws-icons.md) |
| 表紙の名前を入れる | `pnpm slides new … --author "名前"`。指定しなければ git の user.name が入る。 |
| 資料を開く・発表する | `pnpm slides hub` でライブラリーを開く。エディターの「発表」で投影画面と発表者画面を表示。 |
| 書き出す | エディターを ⌘S で保存し、ターミナルで Ctrl+C を押して終了。`pnpm slides build ~/Slides/my-webinar/slides.md --pdf --pptx --html` で資料の `dist/` に3形式を書き出す。PowerPoint の文字・表・図形は書き出した後も編集できる。 |
| 書き出した HTML を渡す | `dist/slides.html` と同じ階層に `dist/figs/` を置く。 |

`--no-shots` はページの PNG を省く指定です。上の `--contact` でも同じ日本語の検査が走ります。表紙・章扉・裏表紙、図やコードの中の文は `ai-phrase` の対象外です。候補を原稿と読み比べ、図のラベルも含めて意味に合う言葉を選んでください。[日本語の決まりと言い換えの例](japanese-rules.md)

### 雛形の見本

| 雛形 | 題材 | スライド |
| --- | --- | --- |
| [update](../marp/templates/update/slides.md) | 失敗した夜間集計の再実行 | [変更前](images/update-before.png)・[変更後](images/update-after.png) |
| [release](../marp/templates/release/slides.md) | 写真の検索条件を保存する | [検索画面](images/release-search.png) |
| [webinar](../marp/templates/webinar/slides.md) | 30秒の録音から雨音を切り出す | [音の重なり](images/webinar-sound-map.png)・[デモ](images/webinar-demo.png) |
| [lightning](../marp/templates/lightning/slides.md) | 最後のひとコマで玉を止める | [3コマ](images/lightning-motion.png)・[4コマ](images/lightning-hold.png) |
| [talk](../marp/templates/talk/slides.md) | 読書メモから次の一冊を選ぶ | [スライド原稿](../marp/templates/talk/slides.md) |

表や会話の書き方はエディターの「ヘルプ」からも開けます。[記法の早見表](cheatsheet.md)

`./install.sh` で依存パッケージと `marp-jinno` スキルを導入できます。依存の導入後は `./install.sh --no-deps` を使えます。`--aws-icons` を付けると AWS の公式アイコン集も配布元から取得します。スキルの追加先は既存の Claude Code と Codex の設定です。

macOS アプリをビルドするには Rust と Xcode Command Line Tools を用意して `pnpm app:build` を実行します。`src-tauri/target/release/bundle/macos/MarpKit.app` を開くとライブラリーが表示されます。開発用の検査は `pnpm test` で実行できます。[変更を送るには](../CONTRIBUTING.md)

## English

Run these commands from the kit directory. Python scripts run with uv. On macOS, install uv with `brew install uv`, then run `./install.sh` to install the Python version pinned in `.python-version`. The editor and the examples are in Japanese.

| Task | How |
| --- | --- |
| Choose a template | Run `pnpm slides templates`. The `talk` template has six slides about reading notes, and `update` has eight about retrying a failed job. |
| Share standalone violet SVGs | Run `uv run scripts/paper-edition.py examples/gallery/jev-guardrail/slides.md ~/Slides/jev-paper` to create an editable Paper edition whose SVGs use fixed violet paint. |
| Set the title when creating a deck | `pnpm slides new ~/Slides/my-webinar --template webinar --title "Editing a rain recording"` |
| Open a deck in the editor | Run `pnpm slides split ~/Slides/my-webinar/slides.md` to open the Markdown on the left and the slides on the right. `pnpm slides edit` opens the slide view instead. |
| Edit a diagram | Double-click the figure in the editor to edit its text and shapes. To redraw it with Python, edit the deck’s `figs/src/make_figs.py` and run `pnpm slides figs ~/Slides/my-webinar/slides.md`. Regenerating overwrites the SVGs. |
| Check slide layout | Run `pnpm slides check ~/Slides/my-webinar/slides.md --contact`. See `.check/report.json` for issues such as overflow or missing images, and `.check/pages/` for a PNG of each slide. |
| Review Japanese wording | Run `pnpm slides check ~/Slides/my-webinar/slides.md --no-shots`. Each `ai-phrase` warning shows the page, the wording in context, and a suggested rewrite. Look for `ai-comma` to review commas in titles, leads, bullets and table cells. |
| Use official AWS icons | Run `pnpm slides icons fetch` to download the icon package from AWS, then `pnpm slides icons find api gateway`. Embed icons with `aws()` in `skills/marp-jinno/scripts/jfig.py`. The kit does not bundle them. [Details (Japanese)](aws-icons.md) |
| Put your name on the cover | `pnpm slides new … --author "Name"`. Without it, git's user.name is used. |
| Open the library or present | Run `pnpm slides hub` to open the library. Select **発表** in the editor to open the audience and presenter windows. |
| Export the deck | Press ⌘S to save and Ctrl+C in Terminal to exit the editor. Run `pnpm slides build ~/Slides/my-webinar/slides.md --pdf --pptx --html`. The files appear in the deck’s `dist/` directory. Text, tables, and shapes in the PowerPoint file are editable. |
| Share the HTML export | Keep `dist/figs/` next to `dist/slides.html`. |

`--no-shots` skips the page PNGs. The same wording checks also run with `--contact`. Review the suggestions in context. Check the covers, section dividers, diagram labels, and code by hand because `ai-phrase` skips them. [Examples and rewrites (Japanese)](japanese-rules.md)

The [template examples](#雛形の見本) include a feature update (`update`), an app walkthrough (`release`), a webinar with a demo (`webinar`), a five-minute lightning talk (`lightning`), and a short talk (`talk`). Pass the template name to `pnpm slides new` with `--template`.

The editor’s Help menu also includes examples of tables and dialogue. [Syntax reference](cheatsheet.md)

Run `./install.sh` to install dependencies and add the `marp-jinno` skill to existing Claude Code and Codex configurations. Use `./install.sh --no-deps` if you already installed the dependencies. Add `--aws-icons` to download the official AWS icon package as well.

To build the macOS app, install Rust and Xcode Command Line Tools, then run `pnpm app:build`. Open `src-tauri/target/release/bundle/macos/MarpKit.app` to see the library. Run `pnpm test` for the development checks. [Contributing](../CONTRIBUTING.md)


[表紙の設計 / Cover design](covers.md) · [図の描き方 / Drawing diagrams](../skills/marp-jinno/references/figures.md) · [MIT License](../LICENSE) · [依存パッケージのライセンス / Dependency licenses](dependencies.md)
