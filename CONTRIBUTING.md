# 変更を送るには

リポジトリをクローンして `pnpm install --frozen-lockfile` を実行してください。作業中の資料はリポジトリの外に置きます。

- テーマや記法を変更したら `pnpm test` を実行します。早見表を変更した場合は `pnpm cheatsheet` でドキュメントを更新します。
- テスト用の資料は新しく書いてください。第三者の画像や書体を追加するときは、配布元と利用条件を先に確認します。
- Git に追加したあと `uv run scripts/check-release.py --staged` を実行します。手元の辞書は `~/.config/jinno-slide-kit/release-words.txt` に置くと自動で読み込まれます。UTF-8 で1行に1語を書き、正規表現には `re:` を付けます。別の辞書を使うときは `--terms <ファイル>` を指定します。結果には一致した値を表示しません。
- 画像を追加・更新したら表示と出典を確認し、`shasum -a 256 <ファイル>` の値を `scripts/reviewed-images.json` に記録します。
- 作例のPDFを更新するときは `pnpm slides build <原稿> --pdf` で書き出します。全ページとリンク先を確認し、`scripts/check-release.py` の `GALLERY_PDFS` に新しいファイルのSHA-256を記録します。
- プルリクエストには、変えた点と動作確認に使ったコマンドを書いてください。
