# AWSの公式アイコン

AWSのサービスを図に描くときは、AWSが配布している公式アイコン（AWS Architecture Icons）を使う。キットにはアイコン集を同梱しない。使う人が配布元から取得して手元に置き、図に埋め込む。AWSは顧客とパートナーが構成図や、ホワイトペーパー・プレゼンテーションなどの資料に使うことを認めている。方針と手動の取得手順はキットの `docs/aws-icons.md`。

## 取得する（初回だけ）

```sh
node marp/bin/slides.mjs icons fetch     # 公式ページから最新のアイコン集を取得して ~/.cache/jinno-marp/aws-icons に展開
node marp/bin/slides.mjs icons find api gateway
node marp/bin/slides.mjs icons find dynamodb table
```

`find` はサービスのアイコン（`Arch_…_64`）を先に、リソースのアイコン（`Res_…_48`）をその次に出す。1列目の名前をそのまま `f.aws()` に渡せる。サービス名の一部（`'API Gateway'`）でもよい。

取得できない環境（社内のプロキシなど）では、`docs/aws-icons.md` の手順でブラウザーから zip を落とし、`slides icons fetch --zip <ファイル>` で展開する。それもできないときは、`service` の線画とサービス名で描き、ロゴらしい図形を自作しない。

## 図に入れる

```python
f.aws(560, 158, 'API Gateway', 'Amazon API Gateway', 'GET /orders/{id}')   # x は中心、y は上端、既定の大きさ64
f.frame(420, 36, 720, 340, 'Amazon VPC', aws='Res_Amazon-VPC_Virtual-private-cloud-VPC_48')
```

- サービスのアイコン（色の付いた正方形）は、そのサービスを指す所に使う。リソースのアイコン（線だけのもの）は、ルール・テーブル・エンドポイントなどサービスの中の部品を指すときに使う。汎用のアイコン（`Res_Internet_48_Light`・`Res_Client_48_Light`・`Res_Users_48_Light` など）は白地用の Light を使う。
- 色・形・縦横比を変えない。回転・切り抜き・影・枠を足さない。役割の色で塗り直さない（`aws()` は Paper でも色を変えない印を付けて埋め込む）。
- 同じ図の公式アイコンは同じ大きさにそろえる。主従は位置と境界の枠の塗りで示す。
- 名前はアイコンの下に正式名（Amazon / AWS を含む）で書き、補足に役割を書く。アイコンの中に文字を重ねない。
- 専用のアイコンがない機能に別のサービスのアイコンを流用しない。親のサービスのアイコンと機能名で示す。
- 人・Agent・汎用の役割（利用者・文書・鍵など）は jfig の線画を使う。公式アイコンは AWS のサービスとリソースに限る。

## 作例の図

作例（`examples/gallery`）の図に入っているアイコンは、資料の一部として描いたもの。そのまま残してよい。アイコンだけを抜き出して別の素材集にしない。
