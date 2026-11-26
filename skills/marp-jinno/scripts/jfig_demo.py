# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""jfig の見本の図を描く。題材は架空の「問い合わせ対応 Agent が注文の状況を調べる」。

    uv run jfig_demo.py <出力フォルダー>

出力した SVG は references/parts.md の型に対応する。座標の取り方を写して、自分の題材に置き換える。
AWS の公式アイコンを使う図（arch・announce）は、先に `slides icons fetch` が要る。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jfig import *  # noqa: E402,F403

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'demo')

# 比較の2枚は同じ座標を使う。役者・箱・結果の位置を変えず、変わったところだけを描き分ける
USER_X, USER_Y = 112, 150          # 人のアイコン（中心と上端）
MID_X, MID_W = 400, 330            # 真ん中の列（道具や仕組み）
RES_X = 800                        # 右の列（結果）


def before():
    f = Fig(1160, 400, '今までは担当者が3つの画面を行き来して調べていた')
    f.head(24, 34, '今まで', 1112)
    f.icon(USER_X, USER_Y, 'user', 'サポート担当', '問い合わせを受けた')
    f.think(28, 64, 200, 'どの画面だっけ？', (USER_X, USER_Y))
    rows = [('注文の管理画面', '注文番号で探す'), ('配送の追跡画面', '伝票番号に読み替える'), ('在庫の管理画面', '倉庫ごとに開く')]
    for i, (name, sub) in enumerate(rows):
        y = 70 + i * 104
        f.box(MID_X, y, MID_W, 82, name, sub)
        f.L([(USER_X + 52, USER_Y + 40), (MID_X - 8, y + 41)], LINE, 1.4, arrow=True)
    f.icon(RES_X + 32, 92, 'clock', tone='o', size=64)
    f.T(RES_X + 80, 136, '回答まで15分（例）', 26, b=True, c=O)
    f.T(RES_X, 214, '番号を読み替えながら\n3つの画面を開く', 19, c=MUTED, lh=1.5)
    f.T(RES_X, 300, '担当によって\n調べる順番が違う', 19, c=MUTED, lh=1.5)
    return f


def after():
    f = Fig(1160, 400, 'これからはAgentに聞けば注文から配送まで1回で返る')
    f.head(24, 34, 'これから', 1112, tone='a')
    f.icon(USER_X, USER_Y, 'user', 'サポート担当', '問い合わせを受けた')
    f.bubble(20, 62, 236, '注文1042は\n今どこ？', (USER_X + 40, USER_Y + 6))
    f.frame(MID_X, 70, MID_W, 290, '問い合わせ Agent', tone='a')
    f.icon(MID_X + 72, 132, 'agent', size=64)
    for i, s in enumerate(['注文を調べる', '配送を調べる', '在庫を調べる']):
        f.box(MID_X + 140, 124 + i * 70, 170, 52, s, tone='n', z=18, b=False)
    f.A(USER_X + 52, USER_Y + 40, MID_X - 8, USER_Y + 40, '質問')
    f.ok(RES_X + 12, 110)
    f.T(RES_X + 34, 118, '1回の質問で返る', 26, b=True, c=G)
    f.R(RES_X, 150, 336, 132, GRAY, None, rx=8)
    f.T(RES_X + 20, 184, '回答の例', 16, b=True, c=MUTED)
    f.T(RES_X + 20, 218, '注文1042は今朝7時に\n大阪の倉庫を出ました', 20, lh=1.45)
    return f


def arch():
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
    f.L([(1000, 282), (1000, 330), (300, 330), (300, 270)], LINE, 1.4, arrow=True, dash=True)
    f.T(650, 320, '{"id": 1042, "status": "出荷済み"}', 18, 'middle', mono=True, c=ACC_T)
    f.bubble(840, 56, 278, '読むだけのロールで呼ぶ', (780, 150))
    return f


def announce():
    f = Fig(1160, 290, '発表の要点と事実')
    f.aws(80, 18, 'Lambda', size=96)
    f.T(160, 54, '注文の状況を問い合わせから1回で返す（見本の文言）', 28, b=True)
    x = 160
    for s in ['注文', '配送', '在庫']:
        x += f.tag(x, 82, s, 'a', 18) + 12
    facts(f, 0, 160, 1160, [('提供状況', '一般提供', '2026年1月（例）'), ('使える場所', '東京・大阪', '記事の表のとおり'),
                            ('料金', '追加料金なし', '呼び出しの料金は別'), ('始め方', 'コンソール', '設定を1つ足す')])
    return f


def allow_deny():
    f = Fig(1160, 330, '照会は通し、登録は手前で止める')
    for y, op, ok in [(30, '注文を照会', True), (190, '返金を登録', False)]:
        f.icon(80, y, 'agent', size=64)
        f.T(80, y + 92, 'Agent', 19, 'middle', True)
        f.icon(520, y, 'lock', 'ポリシー', size=64, z=19)
        f.aws(1040, y, 'Lambda', '注文 API', size=64, z=19)
        f.A(124, y + 34, 476, y + 34, op)
        if ok:
            f.L([(566, y + 34), (994, y + 34)], G, 1.8, arrow=True)
            f.T(780, y + 22, '許可', 19, 'middle', c=G)
        else:
            f.blocked([(566, y + 34), (860, y + 34)], label='登録は許可していない')
    return f


def how_to():
    f = Fig(1160, 330, '設定は3つの手順で終わる')
    steps(f, 24, 40, [('ロールを作る', '読み取りだけを許可'), ('ツールを登録する', 'get_order を追加'),
                      ('Agent から呼ぶ', '注文番号を渡して確認')], gap=96, mono=(1,))
    f.code(560, 20, 576, ['{', '  "name": "get_order",', '  "input": {"id": "1042"}', '}'], 'ツールの呼び出し（例）', hl=(1,))
    return f


if __name__ == '__main__':
    for name, fn in [('before', before), ('after', after), ('arch', arch), ('announce', announce),
                     ('allow-deny', allow_deny), ('how-to', how_to)]:
        try:
            print(fn().save(OUT / f'demo-{name}.svg'))
        except FileNotFoundError as e:
            print(f'{name}: {e}')
