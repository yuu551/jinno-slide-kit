# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""表紙と裏表紙の右面（560×720）に置く挿絵の部品。標準のPythonだけで動く。

面の色・点の地紋・円弧はテーマが描くので、挿絵は透明な地に主役だけを描く。
語彙は白いカード、淡い棒、つなぐ線、主役の面の4つに限る。立体、窓の飾り、
アイコンの羅列、英字の見出しは描かない。濃い面（stage）でもそのまま読めるよう、
カードは白で塗り、輪郭と線はアクセントにする。色はPetrolで指定し、
`uv run marp/scripts/figure_palette.py <figs>` でPaperの色を足す。
"""
from html import escape
from pathlib import Path

ACCENT = "#4a8399"   # 輪郭・線・主役の面
WASH = "#c9dde3"     # カードの中の棒、控えめな要素
PAPER = "#ffffff"    # カードの地
WIDTH, HEIGHT = 560, 720


def card(x, y, w, h, bars=(0.62, 0.46, 0.54), r=14, stroke=ACCENT, dash=None):
    """白いカード。bars はカードの内幅に対する棒の長さの比。"""
    dashed = f' stroke-dasharray="{dash}"' if dash else ''
    out = [f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r:g}" fill="{PAPER}" '
           f'stroke="{stroke}" stroke-width="3"{dashed}/>']
    out += _bars(x, y, w, h, bars, WASH)
    return ''.join(out)


def block(x, y, w, h, bars=(0.78, 0.66, 0.84, 0.56), r=16):
    """主役の面。1枚の挿絵に1つか2つまで。"""
    out = [f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r:g}" fill="{ACCENT}"/>']
    out += _bars(x, y, w, h, bars, PAPER, opacity=0.85)
    return ''.join(out)


def bar(x, y, w, h=9, fill=WASH, opacity=None):
    o = f' opacity="{opacity:g}"' if opacity is not None else ''
    return f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{h / 2:g}" fill="{fill}"{o}/>'


def link(d, width=3.5, color=ACCENT, dash=None):
    """カードや面をつなぐ線。d はSVGのパス。"""
    dashed = f' stroke-dasharray="{dash}"' if dash else ''
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width:g}" '
            f'stroke-linecap="round" stroke-linejoin="round"{dashed}/>')


def dot(cx, cy, r=7, fill=ACCENT, stroke=None):
    s = f' stroke="{stroke}" stroke-width="3"' if stroke else ''
    return f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="{fill}"{s}/>'


def _bars(x, y, w, h, ratios, fill, opacity=None):
    if not ratios:
        return []
    pad = max(18, min(30, w * 0.12))
    step = min(26, (h - 2 * pad) / max(1, len(ratios) - 1)) if len(ratios) > 1 else 0
    top = y + (h - step * (len(ratios) - 1)) / 2 - 4.5
    return [bar(x + pad, top + i * step, (w - 2 * pad) * ratio, fill=fill, opacity=opacity)
            for i, ratio in enumerate(ratios)]


def save(path, title, parts):
    """透明な地の560×720のSVGを書く。"""
    body = ''.join(parts)
    Path(path).write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" '
        f'viewBox="0 0 {WIDTH} {HEIGHT}" role="img"><title>{escape(title)}</title>{body}</svg>\n',
        encoding="utf-8")
