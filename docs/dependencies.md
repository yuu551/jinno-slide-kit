# 外部パッケージのライセンス

配布する Git ツリーにはプログラムのソース、依存の定義とロックファイルを入れています。npm のパッケージ本体は `pnpm install --frozen-lockfile`、Rust のクレートは Cargo が取得します。コンパイル済みのアプリやバンドルはローカルで生成します。

Noto Sans JP の静的ウェイト 400・450・700 はスライドの改行と太さを保つために同梱しています。フォントの著作権表示と SIL OFL 1.1 はテーマ素材に含まれます。[同梱の許諾文](../marp/themes/assets/NotoSansJP-OFL.txt) · [SIL OFL](https://openfontlicense.org/open-font-license-official-text/)

## npm の直接依存

パッケージマネージャーは pnpm 12.23.0（MIT）、Node.js は 22.12 以降を使います。開発用の Node.js は `.node-version` で固定しています。Corepack を使う環境では `corepack pnpm install --frozen-lockfile` でプロジェクト指定の版を起動できます。

ロックファイルにはキットの依存が 219 件、pnpm 本体と各 OS 用の実行ファイルが 17 件あります。全 236 件について、導入済みのパッケージは package.json、他の OS・CPU 向けなど未導入のものは npm 公式レジストリで同じ版のライセンス表記を確認しました。

| パッケージ | 固定版 | 宣言された条件 |
| --- | --- | --- |
| [@codemirror/lang-markdown](https://www.npmjs.com/package/@codemirror/lang-markdown/v/6.5.2) | 6.5.2 | MIT |
| [@codemirror/state](https://www.npmjs.com/package/@codemirror/state/v/6.7.6) | 6.7.6 | MIT |
| [@codemirror/view](https://www.npmjs.com/package/@codemirror/view/v/6.44.0) | 6.44.0 | MIT |
| [@marp-team/marp-cli](https://www.npmjs.com/package/@marp-team/marp-cli/v/4.5.1) | 4.5.1 | MIT |
| [@marp-team/marp-core](https://www.npmjs.com/package/@marp-team/marp-core/v/4.4.0) | 4.4.0 | MIT |
| [@tauri-apps/api](https://www.npmjs.com/package/@tauri-apps/api/v/2.12.5) | 2.12.5 | Apache-2.0 OR MIT |
| [@tauri-apps/cli](https://www.npmjs.com/package/@tauri-apps/cli/v/2.12.6) | 2.12.6 | Apache-2.0 OR MIT |
| [codemirror](https://www.npmjs.com/package/codemirror/v/6.0.2) | 6.0.2 | MIT |
| [esbuild](https://www.npmjs.com/package/esbuild/v/0.28.2) | 0.28.2 | MIT |
| [jszip](https://www.npmjs.com/package/jszip/v/3.10.2) | 3.10.2 | (MIT OR GPL-3.0-or-later) |
| [lucide](https://www.npmjs.com/package/lucide/v/1.80.0) | 1.80.0 | ISC |
| [markdown-it-container](https://www.npmjs.com/package/markdown-it-container/v/4.0.0) | 4.0.0 | MIT |
| [playwright-core](https://www.npmjs.com/package/playwright-core/v/1.65.1) | 1.65.1 | Apache-2.0 |
| [pptxgenjs](https://www.npmjs.com/package/pptxgenjs/v/4.0.1) | 4.0.1 | MIT |
| [svgedit](https://www.npmjs.com/package/svgedit/v/7.4.2) | 7.4.2 | (MIT AND Apache-2.0 AND ISC AND LGPL-3.0-or-later AND X11) |

- エディターとスライドの線画は Lucide の公式パッケージから読み込みます。固定版の ISC 許諾文と Feather 由来のアイコンに適用される MIT 許諾文を同梱しています。作例の PDF を再配布するときは、同じフォルダーの `NOTICE.txt` を添えてください。[同梱の著作権表示と許諾文](../THIRD_PARTY_NOTICES.md)
- JSZip は MIT を選択できます。DOMPurify は Apache-2.0 を選択できます。SVG-Edit には複数の条件があります。対象ファイルは同パッケージの `licenseInfo.json`、作者は `AUTHORS` で確認できます。macOS アプリのビルド時はキット内の `licenses/` に関連する表示をコピーします。バイナリの再配布時には、組み込んだ JavaScript・Rust コンポーネントの条件を個別に確認してください。[JSZip](https://github.com/Stuk/jszip/blob/main/LICENSE.markdown) · [SVG-Edit](https://github.com/SVG-Edit/svgedit)
- `pnpm licenses list` で現在の環境に入ったパッケージを確認できます。Rust 側は `src-tauri/Cargo.lock` でバージョンを固定し、同フォルダーの `cargo metadata --locked --format-version 1` で各クレートの `license`・`license_file` を確認できます。

SVG-Edit 7.4.2 の配布済み `dist/editor/Editor.js` には、jsPDF の HTML 変換用に DOMPurify 3.4.11 が埋め込まれています。このコピーはロックファイルの更新や `pnpm audit` の対象外です。キットの PDF 書き出しは Chrome または WebKit を使い、SVG-Edit 自身の PDF 書き出しも Canvas の画像を jsPDF の `addImage` に渡すため、どちらもこの HTML 変換を呼びません。SVG-Edit を更新するときは配布ファイル内の版も確認してください。

## Rust の直接依存

macOS アプリのビルドには `rust-toolchain.toml` で指定した Rust を使います（`Cargo.toml` の下限は 1.91）。Tauri は `cargo build --locked` で `src-tauri/Cargo.lock` の解決版を使います。下表にはビルド時の `tauri-build` と macOS 専用のクレートを含みます。

| クレート | 固定版 | 宣言された条件 |
| --- | --- | --- |
| [block2](https://crates.io/crates/block2/0.6.2) | 0.6.2 | MIT |
| [libc](https://crates.io/crates/libc/0.2.191) | 0.2.191 | MIT OR Apache-2.0 |
| [lopdf](https://crates.io/crates/lopdf/0.47.0) | 0.47.0 | MIT |
| [notify](https://crates.io/crates/notify/9.0.0) | 9.0.0 | CC0-1.0 |
| [objc2](https://crates.io/crates/objc2/0.6.5) | 0.6.5 | MIT |
| [objc2-app-kit](https://crates.io/crates/objc2-app-kit/0.3.2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-foundation](https://crates.io/crates/objc2-core-foundation/0.3.2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-foundation](https://crates.io/crates/objc2-foundation/0.3.2) | 0.3.2 | MIT |
| [objc2-pdf-kit](https://crates.io/crates/objc2-pdf-kit/0.3.2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-web-kit](https://crates.io/crates/objc2-web-kit/0.3.2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [regex](https://crates.io/crates/regex/1.13.2) | 1.13.2 | MIT OR Apache-2.0 |
| [serde](https://crates.io/crates/serde/1.0.229) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_json](https://crates.io/crates/serde_json/1.0.154) | 1.0.154 | MIT OR Apache-2.0 |
| [sha2](https://crates.io/crates/sha2/0.11.2) | 0.11.2 | MIT OR Apache-2.0 |
| [tauri](https://crates.io/crates/tauri/2.12.7) | 2.12.7 | Apache-2.0 OR MIT |
| [tauri-build](https://crates.io/crates/tauri-build/2.7.6) | 2.7.6 | Apache-2.0 OR MIT |
| [tauri-plugin-dialog](https://crates.io/crates/tauri-plugin-dialog/2.8.4) | 2.8.4 | Apache-2.0 OR MIT |
| [unicode-normalization](https://crates.io/crates/unicode-normalization/0.1.26) | 0.1.26 | (MIT OR Apache-2.0) AND Unicode-3.0 |

## 今回の更新で変わったライセンス表記

- npm の `argparse` は Python-2.0 の 2.0.1 と、PSF-2.0 を宣言する 3.0.4 が両方入ります。
- Rust の `unicode-normalization` 0.1.26 は、MIT または Apache-2.0 に加えて Unicode-3.0 を宣言しています。クレートに `LICENSE-UNICODE` が同梱されています。
- Rust の `ecb` 0.2.1 は MIT に加えて Apache-2.0 も選べます。`siphasher` 1.0.4 は `MIT/Apache-2.0` の表記を `MIT OR Apache-2.0` に改めています。

## npm ロックファイル全体の内訳

<details><summary>(MIT AND Apache-2.0 AND ISC AND LGPL-3.0-or-later AND X11)（1件）</summary>

`svgedit@7.4.2`

</details>

<details><summary>(MIT AND Zlib)（2件）</summary>

`pako@1.0.11`, `pako@2.2.0`

</details>

<details><summary>(MIT OR GPL-3.0-or-later)（1件）</summary>

`jszip@3.10.2`

</details>

<details><summary>(MPL-2.0 OR Apache-2.0)（1件）</summary>

`dompurify@3.5.0`

</details>

<details><summary>Apache-2.0（10件）</summary>

`@puppeteer/browsers@3.3.0`, `browser-fs-access@0.38.0`, `chromium-bidi@157.0.8090-0`, `mathjax-full@3.2.2`, `mhchemparser@4.2.1`, `mj-context-menu@0.6.1`, `playwright-core@1.65.1`, `puppeteer-core@25.19.0`, `speech-rule-engine@4.1.5`, `webdriver-bidi-protocol@1.0.2`

</details>

<details><summary>Apache-2.0 OR MIT（13件）</summary>

`@tauri-apps/api@2.12.5`, `@tauri-apps/cli-darwin-arm64@2.12.6`, `@tauri-apps/cli-darwin-x64@2.12.6`, `@tauri-apps/cli-linux-arm-gnueabihf@2.12.6`, `@tauri-apps/cli-linux-arm64-gnu@2.12.6`, `@tauri-apps/cli-linux-arm64-musl@2.12.6`, `@tauri-apps/cli-linux-riscv64-gnu@2.12.6`, `@tauri-apps/cli-linux-x64-gnu@2.12.6`, `@tauri-apps/cli-linux-x64-musl@2.12.6`, `@tauri-apps/cli-win32-arm64-msvc@2.12.6`, `@tauri-apps/cli-win32-ia32-msvc@2.12.6`, `@tauri-apps/cli-win32-x64-msvc@2.12.6`, `@tauri-apps/cli@2.12.6`

</details>

<details><summary>BSD-2-Clause（1件）</summary>

`entities@4.5.0`

</details>

<details><summary>BSD-3-Clause（3件）</summary>

`devtools-protocol@0.0.1724436`, `highlight.js@11.12.0`, `source-map-js@1.2.4`

</details>

<details><summary>Chromium's License（1件）</summary>

`pathseg@1.2.1`

</details>

<details><summary>ISC（9件）</summary>

`cliui@9.0.1`, `get-caller-file@2.0.5`, `https@1.0.0`, `inherits@2.0.4`, `lucide@1.80.0`, `picocolors@1.1.1`, `setprototypeof@1.2.0`, `y18n@5.0.8`, `yargs-parser@22.0.0`

</details>

<details><summary>MIT（187件）</summary>

`@babel/code-frame@7.29.7`, `@babel/helper-validator-identifier@7.29.7`, `@babel/runtime@7.29.15`, `@codemirror/autocomplete@6.20.4`, `@codemirror/commands@6.11.1`, `@codemirror/lang-css@6.3.1`, `@codemirror/lang-html@6.4.12`, `@codemirror/lang-javascript@6.2.5`, `@codemirror/lang-markdown@6.5.2`, `@codemirror/language@6.13.1`, `@codemirror/lint@6.9.8`, `@codemirror/search@6.7.2`, `@codemirror/state@6.7.6`, `@codemirror/streamparser@6.0.0`, `@codemirror/view@6.44.0`, `@esbuild/aix-ppc64@0.28.2`, `@esbuild/android-arm64@0.28.2`, `@esbuild/android-arm@0.28.2`, `@esbuild/android-x64@0.28.2`, `@esbuild/darwin-arm64@0.28.2`, `@esbuild/darwin-x64@0.28.2`, `@esbuild/freebsd-arm64@0.28.2`, `@esbuild/freebsd-x64@0.28.2`, `@esbuild/linux-arm64@0.28.2`, `@esbuild/linux-arm@0.28.2`, `@esbuild/linux-ia32@0.28.2`, `@esbuild/linux-loong64@0.28.2`, `@esbuild/linux-mips64el@0.28.2`, `@esbuild/linux-ppc64@0.28.2`, `@esbuild/linux-riscv64@0.28.2`, `@esbuild/linux-s390x@0.28.2`, `@esbuild/linux-x64@0.28.2`, `@esbuild/netbsd-arm64@0.28.2`, `@esbuild/netbsd-x64@0.28.2`, `@esbuild/openbsd-arm64@0.28.2`, `@esbuild/openbsd-x64@0.28.2`, `@esbuild/openharmony-arm64@0.28.2`, `@esbuild/sunos-x64@0.28.2`, `@esbuild/win32-arm64@0.28.2`, `@esbuild/win32-ia32@0.28.2`, `@esbuild/win32-x64@0.28.2`, `@lezer/common@1.5.6`, `@lezer/css@1.3.9`, `@lezer/highlight@1.2.5`, `@lezer/html@1.3.13`, `@lezer/javascript@1.5.6`, `@lezer/lr@1.4.12`, `@lezer/markdown@1.8.1`, `@marijn/find-cluster-break@1.0.4`, `@marp-team/marp-cli@4.5.1`, `@marp-team/marp-core@4.4.0`, `@marp-team/marpit-svg-polyfill@2.1.0`, `@marp-team/marpit@3.2.3`, `@pnpm/exe.android-arm64@12.23.0`, `@pnpm/exe.android-x64@12.23.0`, `@pnpm/exe.darwin-arm64@12.23.0`, `@pnpm/exe.darwin-x64@12.23.0`, `@pnpm/exe.freebsd-x64@12.23.0`, `@pnpm/exe.linux-arm64-musl@12.23.0`, `@pnpm/exe.linux-arm64@12.23.0`, `@pnpm/exe.linux-loong64@12.23.0`, `@pnpm/exe.linux-ppc64@12.23.0`, `@pnpm/exe.linux-riscv64@12.23.0`, `@pnpm/exe.linux-s390x@12.23.0`, `@pnpm/exe.linux-x64-musl@12.23.0`, `@pnpm/exe.linux-x64@12.23.0`, `@pnpm/exe.netbsd-x64@12.23.0`, `@pnpm/exe.win32-arm64@12.23.0`, `@pnpm/exe.win32-x64@12.23.0`, `@rollup/rollup-linux-x64-gnu@4.62.2`, `@svgedit/svgcanvas@7.4.2`, `@types/node@22.20.5`, `@types/pako@2.0.4`, `@types/raf@3.4.3`, `@types/trusted-types@2.0.7`, `@xmldom/xmldom@0.9.12`, `accepts@1.3.8`, `ansi-regex@6.6.0`, `ansi-styles@6.2.3`, `base64-arraybuffer@1.0.2`, `batch@0.6.1`, `buffer-crc32@0.2.13`, `callsites@3.1.0`, `canvg@3.0.11`, `chokidar@4.0.3`, `codemirror@6.0.2`, `commander@13.1.0`, `commander@15.1.0`, `commander@2.20.3`, `core-js@3.51.0`, `core-util-is@1.0.3`, `cosmiconfig@9.0.2`, `crelt@1.0.7`, `css-line-break@2.1.0`, `cssesc@3.0.0`, `cssfilter@0.0.10`, `debug@2.6.9`, `depd@1.1.2`, `elix@15.0.1`, `emoji-regex@10.6.0`, `env-paths@2.2.1`, `error-ex@1.3.4`, `esbuild@0.28.2`, `escalade@3.2.0`, `escape-html@1.0.3`, `esm@3.2.25`, `fast-png@6.4.0`, `fd-slicer@1.1.0`, `fflate@0.8.3`, `font-family-papandreou@0.2.0-patch2`, `get-east-asian-width@1.7.0`, `html2canvas@1.4.1`, `http-errors@1.8.1`, `i18next@26.3.6`, `image-size@2.1.0`, `immediate@3.0.6`, `import-fresh@3.3.1`, `iobuffer@5.4.0`, `is-arrayish@0.2.1`, `isarray@1.0.0`, `js-tokens@4.0.0`, `js-yaml@4.3.2`, `js-yaml@5.5.0`, `json-parse-even-better-errors@2.3.1`, `jspdf@4.2.1`, `katex@0.19.1`, `lie@3.3.0`, `lines-and-columns@1.2.4`, `linkify-it@5.0.2`, `lodash.kebabcase@4.1.1`, `markdown-it-container@4.0.0`, `markdown-it-front-matter@0.2.4`, `markdown-it@14.3.3`, `mdurl@2.1.0`, `mime-db@1.52.0`, `mime-types@2.1.35`, `mitt@3.0.1`, `modern-tar@0.8.6`, `ms@2.0.0`, `nanoid@3.3.20`, `negotiator@0.6.3`, `parent-module@1.0.1`, `parse-json@5.2.0`, `parseurl@1.3.3`, `pend@1.2.0`, `performance-now@2.1.0`, `pnpm@12.23.0`, `postcss-selector-parser@7.2.1`, `postcss@8.5.33`, `pptxgenjs@4.0.1`, `process-nextick-args@2.0.1`, `punycode.js@2.3.1`, `raf@3.4.1`, `readable-stream@2.3.8`, `readdirp@4.1.2`, `regenerator-runtime@0.13.11`, `resolve-from@4.0.0`, `safe-buffer@5.1.2`, `serve-index@1.9.2`, `setimmediate@1.0.5`, `specificity@0.4.1`, `stackblur-canvas@2.7.0`, `statuses@1.5.0`, `string-width@7.2.0`, `string-width@8.3.0`, `string_decoder@1.1.1`, `strip-ansi@7.2.0`, `style-mod@4.1.5`, `svg-pathdata@6.0.3`, `svg2pdf.js@2.7.0`, `svgpath@2.6.0`, `text-segmentation@1.0.3`, `tmp@0.2.7`, `toidentifier@1.0.1`, `typed-query-selector@2.12.4`, `uc.micro@2.1.0`, `undici-types@6.21.0`, `util-deprecate@1.0.2`, `utrie@1.0.2`, `w3c-keyname@2.2.8`, `wicked-good-xpath@1.3.0`, `wrap-ansi@9.0.2`, `ws@8.23.0`, `xss@1.0.17`, `yargs@18.2.0`, `yauzl@2.10.0`, `zod@4.6.7`

</details>

<details><summary>MIT OR SEE LICENSE IN FEEL-FREE.md（1件）</summary>

`rgbcolor@1.0.1`

</details>

<details><summary>MIT-0（4件）</summary>

`@csstools/postcss-is-pseudo-class@5.0.3`, `@csstools/selector-resolve-nested@3.1.0`, `@csstools/selector-specificity@5.0.0`, `postcss-nesting@13.0.2`

</details>

<details><summary>PSF-2.0（1件）</summary>

`argparse@3.0.4`

</details>

<details><summary>Python-2.0（1件）</summary>

`argparse@2.0.1`

</details>
