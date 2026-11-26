# AWS の公式アイコンを使う

構成図に AWS のサービスを描くときは、AWS が配布している公式アイコン（[AWS Architecture Icons](https://aws.amazon.com/architecture/icons/)）を使います。

## 同梱しない理由

公式ページは、顧客とパートナーがアイコンを使って構成図を作ることを認めています。ホワイトペーパー・プレゼンテーション・データシート・ポスターなどの資料に入れることも案内されています。一方で、アイコン集をまとめて再配布してよいとは書かれていません。そのため、このキットにはアイコン集を入れず、使う人が配布元から取得して自分のパソコンに置きます。

作例（`examples/gallery`）の図に入っているアイコンは、資料の一部として描いたものなので残しています。図からアイコンだけを抜き出して素材集にしないでください。アイコンの色・形・縦横比も変えません。

## 取得する

キットのフォルダーで次を実行します。公式ページから最新のアイコン集（Icon package の zip）のリンクを読み、`~/.cache/jinno-marp/aws-icons/` に SVG だけを展開します。アイコン集は四半期ごとに更新されるので、新しいサービスが見つからないときは同じコマンドでもう一度取得します。

```sh
pnpm slides icons fetch
pnpm slides icons find api gateway     # 名前と場所を探す
pnpm slides icons dir                  # 展開先と取得元を表示
```

`./install.sh --aws-icons` でも、依存とスキルを入れたあとに同じ取得を行います。展開先は環境変数 `JINNO_MARP_AWS_ICONS_HOME` で変えられます。

## 取得できない環境では

社内のプロキシなどで自動の取得ができないときは、手で落として展開します。

1. ブラウザーで [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) を開き、Icon package（Asset Package）の zip をダウンロードする
2. キットのフォルダーで `pnpm slides icons fetch --zip ~/Downloads/Icon-package_….zip` を実行する
3. `pnpm slides icons find <語>` で探せれば完了

zip の URL が分かっている場合は `pnpm slides icons fetch --url <URL>` も使えます。

## 図に入れる

図は `skills/marp-jinno/scripts/jfig.py` の `aws()` で埋め込みます。アイコンは図の SVG の中に入るので、できあがった資料を開くときにキャッシュは要りません。Paper のテーマでもアイコンの色は変わりません。

```python
from jfig import *
f = Fig(1160, 360)
f.aws(560, 120, 'API Gateway', 'Amazon API Gateway', 'GET /orders/{id}')
f.save('figs/arch.svg')
```

使い方の決まり（同じ図では大きさをそろえる、名前は正式名で下に書く、など）はスキルの [AWSの公式アイコン](../skills/marp-jinno/references/aws-icons.md) にあります。
