# 作図の部品（scripts/jfig.py）

`scripts/jfig.py` は本文の図を描く部品で、Python の標準ライブラリだけで動く。資料の `figs/src/make_figs.py` に作図を書き、`slides figs <slides.md>` で作り直す（`slides figs` は uv で実行し、jfig と cover_art を import できるようにする）。単体で動かすときは `sys.path` にこのスキルの `scripts` を足す。`make_figs.py` の先頭には雛形と同じ `# /// script` の見出しを残す。

```python
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
from pathlib import Path
from jfig import *

OUT = Path(__file__).resolve().parents[1]      # figs/

def before():
    f = Fig(1160, 400, '今までは3件とも集計し直していた')   # 第3引数は読み上げ用の説明
    ...
    return f

before().save(OUT / 'before.svg')
```

見本の図は `uv run scripts/jfig_demo.py <出力フォルダー>` で描ける（今まで／これから・構成図・発表の要点・許可と拒否・手順）。新しい図はこの見本の座標を写して、題材に置き換えるところから始める。描いたら資料に入れて `slides check --contact` の実寸PNGで見る。

## 座標の約束

- 原点は左上、幅は1160。高さは中身に合わせて280〜420。
- `icon()` と `aws()` の x は横の中心、y は上端。名前は y＋大きさ＋29 前後、補足はその下に出る。
- `T()` の y は文字のベースライン。`\n` で改行する。
- 色は名前で渡す（`ACC` `G` `O` `INK` `LINE` `MUTED` など）。役割の色は tone で渡す（`'a'` 主役・`'g'` Agentと通す・`'o'` 止める・`'p'` 外部・`'n'` 色なし・`'q'` 灰の区画）。
- `tw(s, z)` は文字列のおおよその幅。箱の幅を決める目安にする。

## 部品

| 部品 | 使う所 |
|---|---|
| `Fig(w, h, title)` | 図。`f.save(path)` で書き出す |
| `f.T(x, y, s, z=22, a='start', b=False, c=INK, mono=False)` | 文字。a は `start` `middle` `end`。mono はコード体（字下げを残す） |
| `f.R(x, y, w, h, fill, stroke, sw, rx, dash)` | 四角。区画は `fill=GRAY, stroke=None` |
| `f.L(pts, c=LINE, w=1.6, arrow=False, dash=False, both=False)` | 折れ線。矢じりは線と同じ色 |
| `f.A(x1, y1, x2, y2, label='', z=20, c=LINE, dy=-11)` | まっすぐな矢印と1行のラベル |
| `f.icon(x, y, kind, label, sub, size=72, tone)` | 線画。kind は `user` `agent` `document` `database` `service` `settings` `identity` `lock` `key` `token` `vault` `terminal` `browser` `search` `clock` `shield` `log` `tool` `approval` `receipt` `budget` `wallet` `refund` `device` `globe` |
| `f.aws(x, y, name, label, sub, size=64)` | AWSの公式アイコン。name はサービス名（`'API Gateway'`）か `slides icons find` が返す名前 |
| `f.bubble(x, y, w, s, tip)` | 灰色の吹き出し（1〜2行）。tip=(x, y) は話し手の頭やアイコンの縁 |
| `f.think(x, y, w, s, tip)` | 考えごとの雲。声に出す前の迷い |
| `f.box(x, y, w, h, s, sub, tone='n')` | 名前と補足を中央に置く箱。tone='a' で主役 |
| `f.frame(x, y, w, h, label, aws=None, tone='n', dash=False)` | サービスや環境の境界。左上に名前と公式アイコン |
| `f.card(x, y, w, h, title, body, tone)` | 上辺だけ色の付いた白いカード。締めや観点の列 |
| `f.head(x, y, s, w, tone)` | 見出しと下線（「今まで」「これから」） |
| `f.tag(x, y, s, tone)` | 小さな札（用語・「例」）。幅を返す |
| `f.num(x, y, n)` `f.ok(x, y)` `f.ng(x, y)` `f.warn(x, y)` | 番号・✓・×・⚠ |
| `f.blocked(pts, label)` | 止める経路。最後に×と理由 |
| `f.code(x, y, w, lines, title, hl)` | 暗い地のコード窓。高さを返す |
| `facts(f, x, y, w, items)` | 事実のタイル。items は (見出し, 値, 補足) |
| `steps(f, x, y, items, gap)` | 番号つきの手順。items は (操作, 補足) |

- `frame()` と `R()` は中を塗るので、先に置いた線画やアイコンを隠す。境界の枠は先に描き、中の役者や箱をあとから描く。
- 斜めの矢印に `A()` のラベルを付けると線と重なりやすい。斜めの線は `L()` で引き、ラベルは `T()` で線の脇の空いた所に置く。
- `box()` の補足を等幅にしたいとき（範囲・パス・ID）は `box(..., smono=True)`。
- `![h:N]` の N は図の高さと同じにする（[図の選び方](figures.md) の「大きさと文字」）。

`bubble` は3行以上、tip が胴の内側だと例外を出す。`A` のラベルに改行を入れても例外を出す（説明が要るなら吹き出しにする）。`aws` は公式アイコンが手元にないと例外を出す（[AWSの公式アイコン](aws-icons.md)）。

## 型ごとのコード

### 今まで／これから（同じ座標の2枚）

```python
USER_X, USER_Y, MID_X, MID_W, RES_X = 112, 150, 400, 330, 800

def before():
    f = Fig(1160, 400, '今までは担当者が3つの画面を行き来して調べていた')
    f.head(24, 34, '今まで', 1112)
    f.icon(USER_X, USER_Y, 'user', 'サポート担当', '問い合わせを受けた')
    f.think(28, 64, 200, 'どの画面だっけ？', (USER_X, USER_Y))
    for i, (name, sub) in enumerate([('注文の管理画面', '注文番号で探す'), ('配送の追跡画面', '伝票番号に読み替える'), ('在庫の管理画面', '倉庫ごとに開く')]):
        y = 70 + i * 104
        f.box(MID_X, y, MID_W, 82, name, sub)
        f.L([(USER_X + 52, USER_Y + 40), (MID_X - 8, y + 41)], LINE, 1.4, arrow=True)
    f.icon(RES_X + 32, 92, 'clock', tone='o', size=64)
    f.T(RES_X + 80, 136, '回答まで15分（例）', 26, b=True, c=O)
    return f

def after():
    f = Fig(1160, 400, 'これからはAgentに聞けば1回で返る')
    f.head(24, 34, 'これから', 1112, tone='a')
    f.icon(USER_X, USER_Y, 'user', 'サポート担当', '問い合わせを受けた')
    f.bubble(20, 62, 236, '注文1042は\n今どこ？', (USER_X + 40, USER_Y + 6))
    f.frame(MID_X, 70, MID_W, 290, '問い合わせ Agent', tone='a')     # 塗るのは主役の枠だけ
    f.icon(MID_X + 72, 132, 'agent', size=64)
    ...
    f.ok(RES_X + 12, 110)
    f.T(RES_X + 34, 118, '1回の質問で返る', 26, b=True, c=G)
    return f
```

人・真ん中の列・結果の列の座標を定数にして2枚で共有する。今までの手間は線の数・箱の数・時計の数字で、これからは主役の枠と✓で見せる。

### 構成図

```python
f = Fig(1160, 390, '問い合わせAgentがAPIを通して注文の状況を読む構成')
f.icon(90, 150, 'user', 'サポート担当')
f.bubble(14, 40, 186, '1042は今どこ？', (90, 148))
f.icon(300, 150, 'agent', '問い合わせ Agent')
f.A(140, 190, 250, 190, '質問')
f.frame(420, 36, 720, 340, 'AWS アカウント')
for x, name, label, sub in [(560, 'API Gateway', 'Amazon API Gateway', 'GET /orders/{id}'),
                            (780, 'Lambda', 'AWS Lambda', '注文を組み立てる'),
                            (1000, 'DynamoDB', 'Amazon DynamoDB', '注文・配送の表')]:
    f.aws(x, 158, name, label, sub)
f.A(350, 190, 520, 190)
f.A(600, 190, 740, 190, '呼び出し')
f.A(820, 190, 960, 190, 'GetItem')
f.L([(1000, 282), (1000, 330), (300, 330), (300, 270)], LINE, 1.4, arrow=True, dash=True)   # 戻り
f.T(650, 320, '{"id": 1042, "status": "出荷済み"}', 18, 'middle', mono=True, c=ACC_T)
f.bubble(840, 56, 278, '読むだけのロールで呼ぶ', (780, 150))                          # 条件の吹き出し
```

- 人とAgentは枠の外、サービスは境界の枠の中。経路のラベルに要求の中身（パス・API名・値）を書く。
- 戻りの線は補足の文字より下を通す。吹き出しの尻尾はアイコンの上辺へ。
- 公式アイコンは64でそろえる。名前は正式名、補足に役割。

### 発表の要点

```python
f = Fig(1160, 290, '発表の要点と事実')
f.aws(80, 18, 'Lambda', size=96)
f.T(160, 54, '一言の定義（何がどうなったか）', 28, b=True)
x = 160
for s in ['用語1', '用語2', '設定名']:
    x += f.tag(x, 82, s, 'a', 18) + 12
facts(f, 0, 160, 1160, [('発表日', '2026年1月15日', 'What\'s New'), ('対象', '機能の名前', '補足'),
                        ('使える範囲', 'すべての地域', '記事の表記'), ('料金', '追加料金なし', '記事に記載なし など')])
```

### 許可と拒否

```python
for y, op, ok in [(30, '注文を照会', True), (190, '返金を登録', False)]:
    f.icon(80, y, 'agent', size=64)
    f.icon(520, y, 'lock', 'ポリシー', size=64, z=19)
    f.aws(1040, y, 'Lambda', '注文 API', size=64, z=19)
    f.A(124, y + 34, 476, y + 34, op)
    if ok:
        f.L([(566, y + 34), (994, y + 34)], G, 1.8, arrow=True)
        f.T(780, y + 22, '許可', 19, 'middle', c=G)
    else:
        f.blocked([(566, y + 34), (860, y + 34)], label='登録は許可していない')   # ×の先に線を続けない
```

### 手順とコード

```python
steps(f, 24, 40, [('ロールを作る', '読み取りだけを許可'), ('ツールを登録する', 'get_order を追加'),
                  ('Agent から呼ぶ', '注文番号を渡して確認')], gap=96)
f.code(560, 20, 576, ['{', '  "name": "get_order",', '  "input": {"id": "1042"}', '}'], 'ツールの呼び出し（例）', hl=(1,))
```

### 締め（列ごとの要点）

```python
xs = [24, 306, 588, 870]
for x, (title, body, key) in zip(xs, [('見出し1', '短い説明を\n2行で', '要点'), ...]):
    f.card(x, 20, 266, 250, title, body, tone='a' if x == xs[0] else 'n')
    f.T(x + 18, 240, key, 19, b=True, c=ACC_T)
```

## 表紙の挿絵

`scripts/cover_art.py` の部品（`card` 白いカード・`bar` 淡い棒・`link` つなぐ線・`block` 主役の面・`dot` 点）で、560×720 の透明な地に題材の仕組みを一つ描く。`make_figs.py` の中で import して `save()` で書く。

```python
from cover_art import block, card, link, save

def cover():
    parts = []
    for i in range(3):                                   # 三つの集計。失敗した1つは破線
        y = 176 + i * 130
        parts.append(card(76, y, 196, 96, (0.66, 0.44), dash='9 8' if i == 1 else None))
    parts += [link('M272 354C320 354 316 354 344 354'),  # 失敗した1つから主役の面へ
              block(344, 306, 150, 96, (0.66, 0.44))]    # 主役の面は1枚に1〜2つ
    save(OUT / 'cover-art.svg', '三つの集計のうち失敗した一つだけを再実行する', parts)
```

座標は面の中（x 40〜520、y 120〜600）に収める。キットの `scripts/dev/cover-art.py` は作例と雛形の挿絵をまとめて描き直す開発用のスクリプトで、資料からは使わない。

## 以前の部品

`scripts/marks.py`（`actor` `label` `speech`）は S3 の見本（`examples/validation/s3-conditional-writes/figs/src/make_figs.py`）が使っている。新しく描く図は jfig を使う。
