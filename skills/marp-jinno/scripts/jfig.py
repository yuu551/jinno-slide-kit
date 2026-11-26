# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""神野さん風の本文の図（SVG）を描く部品。Python の標準ライブラリだけで動く。

色は Petrol で指定する。`slides figs <slides.md>` が Paper 用の色を図に足すので、
原稿の `theme:` を切り替えるだけで両方のテーマに合う。AWS の公式アイコンは
`slides icons fetch` で手元に取得したものを埋め込み、色も形も変えない。

    import sys
    sys.path.insert(0, '<キット>/skills/marp-jinno/scripts')
    from jfig import *

    f = Fig(1160, 360)
    f.icon(110, 70, 'user', 'サポート担当')                    # x は中心、y は上端
    f.aws(560, 70, 'Lambda', 'AWS Lambda', '注文を組み立てる')
    f.A(170, 110, 500, 110, '照会')
    f.bubble(20, 6, 220, '1042は今どこ？', (110, 68))
    f.save('figs/after.svg')

部品の一覧と描き方の型は references/parts.md。座標は左上が原点、幅は 1160 が基本。
"""
from pathlib import Path
import html
import json
import os
import re
import unicodedata

# ---- 色（Petrol）。Paper では slides figs が同じ役割の色に置き換える ----------------
INK, LINE, MUTED = '#232f3e', '#545b64', '#5f6b76'      # 文字・線・補足の文字
RULE, QL, GRAY = '#c9d0d5', '#dde3e6', '#f5f5f5'        # 罫・区画の線・吹き出しと区画の地
ACC, ACC_T, ACC_L, ACC_M = '#4a8399', '#2f6273', '#edf4f6', '#c9dde3'   # 主役の線・文字・淡い面・中間
G, G_L, G_T = '#2e8b6f', '#e3f2ed', '#1f6b54'           # Agent・通す・成功（両テーマ共通）
O, O_L, O_T = '#c2703d', '#f8ebe2', '#9a5428'           # 止める・注意・失敗（両テーマ共通）
P, P_L, P_T = '#6f5ba6', '#ece8f4', '#54448a'           # 外部のサービスを描き分けるときだけ
CODE_BG, CODE_FG, CODE_DIM, CODE_HL = '#1f2733', '#e6edf3', '#9aa6b0', '#2d3b4c'
FONT = 'Noto Sans JP, Hiragino Sans, sans-serif'
MONO = 'SFMono-Regular, Menlo, Consolas, monospace'

#: 役割の色。(線, 淡い面, 文字)。'a' 主役、'g' Agent・通す、'o' 止める・注意、'p' 外部、
#: 'n' 色なし（白地に灰の線）、'q' 区画（灰の地）
TONES = {'a': (ACC, ACC_L, ACC_T), 'g': (G, G_L, G_T), 'o': (O, O_L, O_T), 'p': (P, P_L, P_T),
         'n': (LINE, 'white', INK), 'q': (QL, GRAY, INK)}

# ---- 線画のアイコン（78×78 の座標）。人・Agent・汎用の役割を描き分ける ----------------
SHAPES = {
    'user': '<circle cx="39" cy="18" r="16"/><path d="M9 77 Q8 42 39 40 Q70 42 69 77Z"/>',
    'agent': '<rect x="7" y="18" width="64" height="51" rx="12"/><path d="M39 18V3M29 3H49M0 33V54M78 33V54M25 69V78M53 69V78"/><circle cx="26" cy="39" r="3"/><circle cx="52" cy="39" r="3"/><path d="M27 54H51"/>',
    'document': '<path d="M9 0H51L69 18V78H9Z M51 0V18H69"/><path d="M21 32H57M21 46H57M21 60H49"/>',
    'lock': '<rect x="9" y="30" width="60" height="46" rx="6"/><path d="M21 30V17A18 18 0 0 1 57 17V30"/><circle cx="39" cy="49" r="4"/><path d="M39 53V63"/>',
    'service': '<rect x="8" y="3" width="62" height="20" rx="4"/><rect x="8" y="29" width="62" height="20" rx="4"/><rect x="8" y="55" width="62" height="20" rx="4"/><path d="M17 13H22M17 39H22M17 65H22"/>',
    'database': '<path d="M8 16V62C8 79 70 79 70 62V16"/><ellipse cx="39" cy="16" rx="31" ry="12"/><path d="M8 39C8 56 70 56 70 39"/>',
    'settings': '<rect x="7" y="9" width="64" height="60" rx="5"/><path d="M17 25H61M17 39H61M17 53H61"/><circle cx="29" cy="25" r="5"/><circle cx="49" cy="39" r="5"/><circle cx="34" cy="53" r="5"/>',
    'identity': '<rect x="5" y="14" width="68" height="50" rx="5"/><circle cx="24" cy="32" r="8"/><path d="M12 54Q12 43 24 43Q36 43 36 54M46 29H63M46 40H63M46 51H58"/>',
    'vault': '<rect x="8" y="7" width="62" height="64" rx="5"/><rect x="16" y="15" width="46" height="48" rx="3"/><path d="M8 23H16M8 55H16"/><circle cx="39" cy="39" r="13"/><circle cx="39" cy="39" r="3"/><path d="M39 26V33M39 45V52M26 39H33M45 39H52"/>',
    'key': '<circle cx="23" cy="25" r="17"/><circle cx="19" cy="21" r="4"/><path d="M36 36L69 69L61 76L51 66L56 61L48 53L43 58L32 47"/>',
    'token': '<path d="M25 7H53L72 26V53L53 72H25L6 53V26Z"/><circle cx="39" cy="39" r="21"/><path d="M28 39H50M39 28V50"/>',
    'terminal': '<rect x="5" y="11" width="68" height="56" rx="6"/><path d="M17 31L28 40L17 49M34 50H52"/>',
    'browser': '<rect x="5" y="9" width="68" height="60" rx="5"/><path d="M5 25H73M14 17H17M24 17H27M34 17H37M18 38H58M18 48H47M18 58H53"/>',
    'search': '<circle cx="31" cy="30" r="23"/><path d="M48 47L72 71M48 55L64 71M20 30H42M31 19V41"/>',
    'clock': '<circle cx="39" cy="39" r="32"/><path d="M39 18V39L54 49M39 10V14M68 39H64M39 68V64M10 39H14"/>',
    'shield': '<path d="M39 5L67 16V38Q67 59 39 74Q11 59 11 38V16Z"/><path d="M25 38L35 48L54 27"/>',
    'log': '<path d="M14 7H54L65 18V71H14Z M54 7V18H65"/><path d="M24 29H28M35 29H55M24 41H28M35 41H55M24 53H28M35 53H49M24 62H28M35 62H55"/>',
    'tool': '<path d="M46 8Q63 2 71 16L57 30L48 21L34 35Q30 42 35 47L16 69Q8 77 3 69Q0 64 7 59L29 39Q22 27 30 16Q35 10 46 8Z"/>',
    'approval': '<path d="M13 8H53L65 20V70H13Z M53 8V20H65"/><path d="M23 29H49M23 39H40"/><circle cx="53" cy="56" r="17"/><path d="M43 56L50 63L63 48"/>',
    'receipt': '<path d="M14 5H64V73L56 67L48 73L40 67L32 73L24 67L14 73Z"/><path d="M24 19H54M24 29H54M24 39H43M29 53L36 60L51 46"/>',
    'budget': '<rect x="8" y="13" width="62" height="55" rx="5"/><path d="M8 28H70M20 8V20M58 8V20"/><rect x="19" y="43" width="40" height="12" rx="2"/><path d="M44 43V55M24 49H38"/>',
    'wallet': '<path d="M10 24V16Q10 10 17 10H62V24"/><rect x="7" y="24" width="64" height="46" rx="7"/><path d="M71 38H49V56H71"/><circle cx="57" cy="47" r="2"/>',
    'refund': '<circle cx="45" cy="46" r="23"/><path d="M18 27H8V17M9 27C17 8 48 5 65 20"/><path d="M38 33L45 43L52 33M45 43V59M36 44H54M36 51H54"/>',
    'device': '<rect x="10" y="22" width="58" height="46" rx="6"/><rect x="27" y="34" width="24" height="22" rx="2"/><path d="M33 34V28M45 34V28M33 62V56M45 62V56M21 41H27M21 49H27M51 41H57M51 49H57M56 22V10"/><circle cx="56" cy="7" r="3"/>',
    'globe': '<circle cx="39" cy="39" r="32"/><ellipse cx="39" cy="39" rx="14" ry="32"/><path d="M7 39H71M12 23H66M12 55H66"/>',
}
#: 線画の既定の色。Agent は緑、ほかは主役の色。比べる2者を色で分けたいときは tone で指定する
KIND_TONE = {'agent': 'g'}


def tw(s, z):
    """文字列のおおよその幅（px）。全角1.0・半角0.6で数える。枠の幅を決める目安で、最後は描画して確かめる。"""
    return sum(z * (1.0 if unicodedata.east_asian_width(c) in 'WFA' else 0.6) for c in s)


def esc(s):
    return html.escape(str(s), quote=True)


# ---- AWS の公式アイコン ---------------------------------------------------------------
_AWS = None


def _aws_index():
    """slides icons fetch で展開したアイコン集の一覧を読む。"""
    global _AWS
    if _AWS is None:
        home = Path(os.environ.get('JINNO_MARP_AWS_ICONS_HOME')
                    or Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'jinno-marp' / 'aws-icons')
        cur = home / 'current.json'
        if not cur.exists():
            raise FileNotFoundError(
                'AWS の公式アイコンが手元にありません。キットで `node marp/bin/slides.mjs icons fetch` を実行してください'
                '（取得できない環境は docs/aws-icons.md の手動の手順）。それまではサービス名を書いた箱で描き、ロゴを自作しない')
        d = Path(json.loads(cur.read_text())['dir'])
        _AWS = (d, json.loads((d / 'index.json').read_text()))
    return _AWS


def _norm(s):
    s = re.sub(r'^(arch|res|arch-category)_', '', s.lower())
    s = re.sub(r'_(16|20|24|32|48|64)(@5x)?(_light|_dark)?$', r'\3', s)
    return re.sub(r'[^a-z0-9]', '', re.sub(r'\b(amazon|aws)\b', '', s))


def aws_path(name):
    """アイコンのファイルを名前で探す。'API Gateway'・'Arch_Amazon-API-Gateway_64'・'dynamodb table' のどれでもよい。
    サービスのアイコン（64）を先に、なければリソース（48・白地用の Light）を返す。"""
    d, index = _aws_index()
    exact = [e for e in index if e['key'] == name]
    if exact:
        return d / exact[0]['file']
    words = [_norm(w) for w in re.split(r'[\s/]+', name) if _norm(w)]
    rank = {'service': 0, 'resource': 1, 'group': 2, 'category': 3, 'other': 4}

    def score(e):
        k = e['key']
        return (rank[e['kind']], 0 if re.search(r'_64$|_48(_Light)?$|_32$', k) else 1, 1 if k.endswith('_Dark') else 0,
                0 if _norm(k) == ''.join(words) else 1, len(k))
    hits = sorted((e for e in index if all(w in _norm(e['key']) for w in words)), key=score)
    if not hits:
        raise KeyError(f'AWS のアイコンが見つかりません: {name}（`slides icons find <語>` で正式名を探す）')
    return d / hits[0]['file']


def aws_svg(name, x, y, size):
    """公式アイコンを入れ子の <svg> として返す。色と形はそのまま。Paper でも色を変えない印を付ける。"""
    p = aws_path(name)
    src = p.read_text(encoding='utf-8')
    vb = re.search(r'viewBox="([^"]+)"', src).group(1)
    inner = re.sub(r'^.*?<svg[^>]*>|</svg>\s*$', '', src, flags=re.S)
    inner = re.sub(r'<title>.*?</title>', '', inner, flags=re.S)
    if 'url(#' not in inner and 'href="#' not in inner:
        inner = re.sub(r'\sid="[^"]*"', '', inner)        # 同じアイコンを2回置いても id が重ならない
    inner = re.sub(r'>\s+<', '><', inner.strip())
    return (f'<svg x="{x:g}" y="{y:g}" width="{size:g}" height="{size:g}" viewBox="{vb}" '
            f'data-fixed-color="" data-aws-icon="{esc(p.stem)}">{inner}</svg>')


# ---- 図 -------------------------------------------------------------------------------
def bubble_outline(x, y, w, h, tx, ty, r=8):
    """胴と尻尾が一続きの輪郭。尻尾の根元に胴の線を残さない。"""
    r = min(r, w / 2, h / 2)
    side = 'top' if ty < y else 'bottom' if ty > y + h else 'left' if tx < x else 'right'
    bx = min(max(tx, x + 22), x + w - 22)
    by = min(max(ty, y + 20), y + h - 20)
    d = [f'M{x + r} {y}']
    if side == 'top':
        d += [f'H{bx - 11}L{tx} {ty}L{bx + 11} {y}']
    d += [f'H{x + w - r}Q{x + w} {y} {x + w} {y + r}']
    if side == 'right':
        d += [f'V{by - 11}L{tx} {ty}L{x + w} {by + 11}']
    d += [f'V{y + h - r}Q{x + w} {y + h} {x + w - r} {y + h}']
    if side == 'bottom':
        d += [f'H{bx + 11}L{tx} {ty}L{bx - 11} {y + h}']
    d += [f'H{x + r}Q{x} {y + h} {x} {y + h - r}']
    if side == 'left':
        d += [f'V{by + 11}L{tx} {ty}L{x} {by - 11}']
    d += [f'V{y + r}Q{x} {y} {x + r} {y}Z']
    return ''.join(d)


class Fig:
    """本文の図。幅1160が基本、高さは中身に合わせて 280〜420。"""

    def __init__(self, width=1160, height=380, title=None):
        self.width, self.height = width, height
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
                      f'viewBox="0 0 {width} {height}" role="img">']
        if title:
            self.parts.append(f'<title>{esc(title)}</title>')
        self.parts.append(f'<rect width="{width}" height="{height}" fill="white"/>')
        self._markers = set()

    # ---- 基本 ---------------------------------------------------------------------
    def T(self, x, y, s, z=22, a='start', b=False, c=INK, lh=1.38, mono=False):
        """文字。y はベースライン。`\\n` で改行（行ごとに tspan）。a は start・middle・end。"""
        fam = MONO if mono else FONT
        spans = ''.join(f'<tspan x="{x:g}" dy="{0 if i == 0 else round(z * lh, 2)}">{esc(l)}</tspan>'
                        for i, l in enumerate(str(s).split('\n')))
        keep = ' xml:space="preserve"' if mono else ''          # コードの字下げを残す
        self.parts.append(f'<text x="{x:g}" y="{y:g}" fill="{c}" font-family="{fam}" font-size="{z}" '
                          f'text-anchor="{a}" font-weight="{600 if b else 400}"{keep}>{spans}</text>')

    def R(self, x, y, w, h, fill='white', stroke=LINE, sw=1.2, rx=8, dash=False):
        """四角。区画は fill=GRAY・stroke=None、主役は fill=ACC_L・stroke=ACC。"""
        d = ' stroke-dasharray="6 5"' if dash else ''
        st = f'stroke="{stroke}" stroke-width="{sw}"' if stroke else 'stroke="none"'
        self.parts.append(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx}" fill="{fill}" {st}{d}/>')

    def C(self, x, y, r, fill='white', stroke=None, sw=1.8):
        st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
        self.parts.append(f'<circle cx="{x:g}" cy="{y:g}" r="{r:g}" fill="{fill}"{st}/>')

    def _marker(self, color):
        key = color.lstrip('#').lower()
        if key not in self._markers:
            self._markers.add(key)
            self.parts.append(f'<defs><marker id="ah-{key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" '
                              f'markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="{color}"/>'
                              f'</marker></defs>')
        return f'ah-{key}'

    def L(self, pts, c=LINE, w=1.6, arrow=False, dash=False, both=False):
        """折れ線。pts は [(x, y), ...]。arrow で終点に矢じり、both で両端。矢じりは線と同じ色。"""
        d = 'M' + 'L'.join(f'{x:g} {y:g}' for x, y in pts)
        a = ' stroke-dasharray="6 5"' if dash else ''
        if arrow or both:
            m = self._marker(c)
            a += f' marker-end="url(#{m})"' + (f' marker-start="url(#{m})"' if both else '')
        self.parts.append(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{w}" '
                          f'stroke-linejoin="round"{a}/>')

    def A(self, x1, y1, x2, y2, label='', z=20, c=LINE, dy=-11, dash=False, tc=None):
        """まっすぐな矢印。label は線の上（dy で上下）。ラベルは1行、2行要るなら吹き出しにする。"""
        self.L([(x1, y1), (x2, y2)], c, arrow=True, dash=dash)
        if label:
            if '\n' in label:
                raise ValueError('矢印のラベルは1行。説明が要るなら bubble() で添える')
            self.T((x1 + x2) / 2, (y1 + y2) / 2 + dy, label, z, 'middle', c=tc or (INK if c == LINE else c))

    # ---- 役者とアイコン --------------------------------------------------------------
    def icon(self, x, y, kind, label='', sub='', size=72, tone=None, z=21, sz=17):
        """線画のアイコン。x は中心、y は上端。名前（太字）と補足（灰）はアイコンの下に置く。
        tone: None は既定（Agent は緑、ほかは主役の色）、'n' で灰。比べる2者を分けるときだけ色を変える。"""
        if kind not in SHAPES:
            raise KeyError(f'線画にないアイコン: {kind}。サービスなら aws()、ないものは service と名前で描く')
        st = TONES[tone or KIND_TONE.get(kind, 'a')][0]
        self.parts.append(f'<g transform="translate({x - size / 2:g} {y:g}) scale({size / 78:g})" fill="white" '
                          f'stroke="{st}" stroke-width="{2.4 * 78 / size:.2f}" stroke-linejoin="round" '
                          f'stroke-linecap="round">{SHAPES[kind]}</g>')
        self._caption(x, y + size, label, sub, z, sz)

    def aws(self, x, y, name, label='', sub='', size=64, z=21, sz=17):
        """AWS の公式アイコン。x は中心、y は上端。name はサービス名（'API Gateway'）かファイル名の語幹。
        同じ図の公式アイコンは同じ大きさにそろえる。色や形を変えない。"""
        self.parts.append(aws_svg(name, x - size / 2, y, size))
        self._caption(x, y + size, label, sub, z, sz)

    def _caption(self, x, bottom, label, sub, z, sz):
        if label:
            self.T(x, bottom + z + 8, label, z, 'middle', True)
        if sub:
            n = len(str(label).split('\n')) if label else 0
            self.T(x, bottom + 8 + n * z * 1.38 + sz + (4 if label else 0), sub, sz, 'middle', c=MUTED)

    def bubble(self, x, y, w, s, tip, tone=None, z=21):
        """灰色の吹き出し（1〜2行）。tip=(tx, ty) は話し手のアイコンの輪郭（人なら頭、Agent ならアンテナ）。
        tip は吹き出しの外に置く。人の発言とサービスの補足のどちらにも使う。"""
        lines = str(s).split('\n')
        if len(lines) > 2:
            raise ValueError('吹き出しは2行まで')
        h = 22 + len(lines) * z * 1.36
        tx, ty = tip
        if x <= tx <= x + w and y <= ty <= y + h:
            raise ValueError('吹き出しの tip は胴の外を指す')
        st, fl = (LINE, GRAY) if tone is None else TONES[tone][:2]
        self.parts.append(f'<path d="{bubble_outline(x, y, w, h, tx, ty)}" fill="{fl}" stroke="{st}" stroke-width="1.1"/>')
        self.T(x + w / 2, y + 11 + z, s, z, 'middle', lh=1.36)
        return h

    def think(self, x, y, w, s, tip, z=21):
        """考えごとの雲（声に出す前の迷い）。小さな丸の列が tip（頭）へ向かう。発言は bubble() を使う。"""
        lines = str(s).split('\n')
        h = 26 + len(lines) * z * 1.36
        self.R(x, y, w, h, GRAY, LINE, 1.1, rx=h / 2)
        tx, ty = tip
        cx, cy = x + w / 2, y + h
        for k, r in ((0.35, 6), (0.65, 4)):
            self.C(cx + (tx - cx) * k, cy + (ty - cy) * k, r, GRAY, LINE, 1.1)
        self.T(x + w / 2, y + 13 + z, s, z, 'middle', lh=1.36)

    # ---- 箱と枠 -------------------------------------------------------------------
    def box(self, x, y, w, h, s, sub='', tone='n', z=22, sz=17, b=True, smono=False):
        """中央に名前（＋補足）を置く箱。tone='a' で主役（淡い面＋色の線）。1つの図で塗るのは1〜2個まで。
        smono=True で補足を等幅にする（範囲・パス・ID）。"""
        st, fl, tc = TONES[tone]
        self.R(x, y, w, h, fl, st, 1.4 if tone != 'n' else 1.2)
        n = len(str(s).split('\n'))
        if sub:
            top = y + h / 2 - (n * z * 1.3 + sz + 6) / 2 + z * 0.92
            self.T(x + w / 2, top, s, z, 'middle', b, tc, 1.3)
            self.T(x + w / 2, top + n * z * 1.3 + 2, sub, sz, 'middle', c=MUTED, mono=smono)
        else:
            self.T(x + w / 2, y + h / 2 - (n - 1) * z * 0.65 + z * 0.36, s, z, 'middle', b, tc, 1.3)

    def frame(self, x, y, w, h, label, aws=None, tone='n', dash=False, z=20, icon_size=34):
        """サービスや環境の境界。左上の内側に名前（と公式アイコン）を置く。中を塗るので、中の役者や箱より先に描く。
        tone='a' はこの図の主役の境界だけ。dash は「同じ管理の範囲」など意味のある境界に限る。"""
        st, fl, tc = TONES[tone]
        self.R(x, y, w, h, fl if tone != 'n' else 'white', st, 1.4 if tone != 'n' else 1.2, rx=10, dash=dash)
        tx = x + 16
        if aws:
            self.parts.append(aws_svg(aws, x + 14, y + 12, icon_size))
            tx = x + 24 + icon_size
        self.T(tx, y + 12 + icon_size / 2 + z * 0.36, label, z, 'start', True, tc)

    def card(self, x, y, w, h, title, body='', tone='n', z=22, bz=18):
        """白いカード。上辺だけ役割の色。見出しと本文を左揃えで置く（本文は `\\n` で改行）。"""
        st = TONES[tone][0]
        self.R(x, y, w, h, 'white', RULE, 1.1, rx=6)
        self.L([(x + 1, y + 1), (x + w - 1, y + 1)], st, 4 if tone != 'n' else 1.2)
        self.T(x + 18, y + 22 + z, title, z, b=True)
        if body:
            self.T(x + 18, y + 30 + z + bz * 1.5, body, bz, c=MUTED, lh=1.5)

    def tag(self, x, y, s, tone='a', z=16, a='start'):
        """小さな札（「これまで」「例」など）。x, y は左上（a='end' なら右上）。"""
        st, fl, tc = TONES[tone]
        w = tw(s, z) + 20
        x0 = x - w if a == 'end' else x
        self.R(x0, y, w, z + 14, fl, st, 1.1, rx=4)
        self.T(x0 + w / 2, y + z + 4, s, z, 'middle', True, tc)
        return w

    def head(self, x, y, s, w, tone='n', z=22):
        """列や段の見出しと下線。左右比較の「これまで／これから」に使う（帯は使わない）。"""
        st, _, tc = TONES[tone]
        self.T(x, y, s, z, b=True, c=tc)
        self.L([(x, y + 14), (x + w, y + 14)], st if tone != 'n' else RULE, 1.4)

    # ---- 印 ---------------------------------------------------------------------
    def num(self, x, y, n, r=17, tone='a', ring=False, z=None):
        st, fl, tc = TONES[tone]
        z = z or round(r * 1.05)
        if ring:
            self.C(x, y, r, 'white', st, 1.6)
            self.T(x, y + z * 0.36, str(n), z, 'middle', True, tc)
        else:
            self.C(x, y, r, st)
            self.T(x, y + z * 0.36, str(n), z, 'middle', True, 'white')

    def ok(self, x, y, c=G):
        self.parts.append(f'<path d="M{x - 10} {y}L{x - 3} {y + 7}L{x + 11} {y - 9}" fill="none" stroke="{c}" '
                          f'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>')

    def ng(self, x, y, c=O, r=11):
        """止めた位置の×。線は接続先の手前で終え、×の先へ矢印を続けない。"""
        self.parts.append(f'<path d="M{x - r} {y - r}L{x + r} {y + r}M{x + r} {y - r}L{x - r} {y + r}" fill="none" '
                          f'stroke="{c}" stroke-width="3.4" stroke-linecap="round"/>')

    def warn(self, x, y):
        # 「!」は文字にせず線と点で描く（小さな文字は svg-text-small の検査に当たる）
        self.parts.append(f'<path d="M{x} {y - 12}L{x + 12} {y + 9}L{x - 12} {y + 9}Z" fill="{O_L}" stroke="{O}" '
                          f'stroke-width="1.8" stroke-linejoin="round"/><path d="M{x} {y - 5}V{y + 1}" stroke="{O}" '
                          f'stroke-width="2.4" stroke-linecap="round"/><circle cx="{x}" cy="{y + 5}" r="1.5" fill="{O}"/>')

    def blocked(self, pts, c=O, label='', z=19):
        """止める経路。最後の点に×を置く。label は×の下に置く（「範囲外は拒否」など）。"""
        self.L(pts, c, 1.8)
        x, y = pts[-1]
        self.ng(x, y, c)
        if label:
            self.T(x, y + 36, label, z, 'middle', c=O_T)

    # ---- コード ------------------------------------------------------------------
    def code(self, x, y, w, lines, title='', z=17, hl=(), lh=1.5):
        """暗い地のコード窓。lines は文字列のリスト。hl は強調する行の番号（0始まり）。"""
        top = 40 if title else 16
        h = top + len(lines) * z * lh + 16
        self.R(x, y, w, h, CODE_BG, None, rx=8)
        if title:
            self.T(x + 18, y + 27, title, 16, c=CODE_DIM, mono=True)
        for i, s in enumerate(lines):
            yy = y + top + i * z * lh
            if i in hl:
                self.R(x + 6, yy + 2, w - 12, z * lh, CODE_HL, None, rx=4)
            self.T(x + 18, yy + z * 1.1, s, z, c=CODE_FG, mono=True)
        return h

    # ---- 保存 --------------------------------------------------------------------
    def svg(self):
        return ''.join(self.parts) + '</svg>\n'

    def save(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.svg(), encoding='utf-8')
        return path


# ---- よく使う組み合わせ ----------------------------------------------------------------
def facts(f, x, y, w, items, h=112, gap=18):
    """事実のタイル（提供状況・対象・料金など）を横に並べる。items は (見出し, 値, 補足)。"""
    n = len(items)
    cw = (w - gap * (n - 1)) / n
    for i, it in enumerate(items):
        label, value, sub = (list(it) + ['', ''])[:3]
        cx = x + i * (cw + gap)
        f.R(cx, y, cw, h, GRAY, None, rx=6)
        f.L([(cx + 2, y), (cx + 2, y + h)], ACC, 5)
        f.T(cx + 22, y + 30, label, 16, b=True, c=MUTED)
        f.T(cx + 22, y + 66, value, 24, b=True)
        if sub:
            f.T(cx + 22, y + 96, sub, 16, c=MUTED)


def steps(f, x, y, items, gap=78, z=22, sz=17, mono=()):
    """番号つきの手順を縦に並べる。items は (操作, 補足)。mono に入れた番号の操作はコード体。"""
    for i, it in enumerate(items):
        title, sub = (list(it) + [''])[:2]
        yy = y + i * gap
        f.num(x + 18, yy, i + 1)
        if i < len(items) - 1:
            f.L([(x + 18, yy + 22), (x + 18, yy + gap - 22)], RULE, 1.4)
        f.T(x + 52, yy + z * 0.36, title, z, b=True, mono=i in mono)
        if sub:
            f.T(x + 52, yy + z * 0.36 + sz + 10, sub, sz, c=MUTED)


__all__ = [n for n in dir() if not n.startswith('_')] + ['_norm']
