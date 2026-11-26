# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""作例・雛形・S3の再現試験の表紙の挿絵（figs/cover-art.svg）を描き直す。

面の色・点の地紋・円弧はテーマ（petrol.css）が描くので、ここでは透明な地に主役だけを描く。
原稿の題材ごとに、白いカード・淡い棒・つなぐ線・主役の面の組み合わせで仕組みを一つ示す。
原本から移した挿絵（CIMD・Jev・RAG）は絵を変えず、地の面と点だけを外す。

  uv run scripts/dev/cover-art.py
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "skills/marp-jinno/scripts"))
sys.path.insert(0, str(ROOT / "marp/scripts"))
from cover_art import ACCENT, PAPER, WASH, bar, block, card, dot, link, save  # noqa: E402
from figure_palette import adaptive_svg  # noqa: E402

GALLERY = ROOT / "examples/gallery"
TEMPLATES = ROOT / "marp/templates"
VALIDATION = ROOT / "examples/validation"


def lightning():
    """コマ送りで動く玉が、最後の二コマで止まる。"""
    parts = []
    frames = ((86, 176), (296, 176), (86, 386), (296, 386))
    balls = ((44, 112), (92, 70), (130, 52), (130, 52))
    for i, ((x, y), (bx, by)) in enumerate(zip(frames, balls)):
        parts.append(card(x, y, 178, 178, ()))
        parts.append(bar(x + 22, y + 148, 134, 6, WASH))
        parts.append(dot(x + bx, y + by, 15, ACCENT if i == 3 else WASH))
    return "コマ送りで動く玉が最後の二コマで同じ位置にとどまる", parts


def release():
    """保存した検索条件で、合う写真だけを呼び出す。"""
    parts = [block(110, 150, 340, 84, (0.7, 0.46)), ]
    picks = {(0, 0), (1, 1), (2, 0)}
    for col in range(3):
        for row in range(2):
            x, y = 90 + col * 134, 330 + row * 134
            hit = (col, row) in picks
            parts.append(f'<rect x="{x}" y="{y}" width="112" height="112" rx="12" fill="{PAPER}" '
                         f'stroke="{ACCENT if hit else WASH}" stroke-width="3"/>')
            parts.append(f'<rect x="{x + 16}" y="{y + 16}" width="80" height="56" rx="6" fill="{WASH}"/>')
            parts.append(bar(x + 16, y + 84, 52, 7, WASH))
            if hit:
                parts.append(link(f"M280 234V268C280 286 {x + 56} 290 {x + 56} 310V{y}"))
    return "保存した検索条件に合う写真を呼び出す", parts


def talk():
    """読書メモの一行から、次の一冊を選ぶ。"""
    parts = [card(84, 150, 250, 116, (0.72, 0.5)),
             link("M334 208H392C410 208 418 220 418 240V330")]
    books = ((96, 58, 196), (160, 46, 230), (212, 64, 176), (282, 52, 214), (390, 56, 240), (452, 40, 188))
    for i, (x, w, h) in enumerate(books):
        y = 560 - h
        fill = ACCENT if i == 4 else PAPER
        parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{ACCENT}" stroke-width="3"/>')
        parts.append(bar(x + 12, y + 24, w - 24, 8, PAPER if i == 4 else WASH, 0.85 if i == 4 else None))
    parts.append(link("M74 560H496", 3))
    return "読書メモの一行から次の一冊を選ぶ", parts


def update():
    """三つの集計のうち、失敗した一つだけを再実行する。"""
    parts = []
    for i in range(3):
        y = 176 + i * 130
        parts.append(card(76, y, 196, 96, (0.66, 0.44), dash="9 8" if i == 1 else None))
    parts += [link("M272 354C320 354 316 354 344 354", dash=None),
              block(344, 306, 150, 96, (0.66, 0.44))]
    return "三つの集計のうち失敗した一つだけを再実行する", parts


def webinar():
    """録音の波形から、雨音の区間を切り出す。"""
    heights = (18, 34, 26, 52, 40, 70, 46, 30, 62, 88, 74, 96, 66, 84, 58, 44, 72, 36, 54, 28, 42, 22)
    parts = [f'<rect x="56" y="176" width="448" height="200" rx="14" fill="{PAPER}" stroke="{ACCENT}" stroke-width="3"/>']
    for i, h in enumerate(heights):
        x = 84 + i * 18.6
        inside = 8 <= i <= 15
        parts.append(bar(x, 276 - h / 2, 8, h, ACCENT if inside else WASH))
    parts += [link("M226 194V358", 2.5), link("M374 194V358", 2.5),
              link("M300 376V436"),
              block(150, 436, 300, 124, ())]
    for i, h in enumerate(heights[8:16]):
        parts.append(bar(188 + i * 30, 498 - h * 0.42, 10, h * 0.84, PAPER, 0.85))
    return "録音の波形から雨音の区間を切り出す", parts


def s3_conditional():
    """二人が同じ設定を編集し、先に保存した変更は残り、古い内容からの保存は手前で止まる。"""
    parts = [card(72, 150, 176, 124, (0.64, 0.44, 0.54)),
             card(312, 150, 176, 124, (0.64, 0.44, 0.54)),
             link("M160 274C160 346 230 340 230 420"),
             # 破線の長さは約115.2。両端が線で終わるよう、線10・間11.05の6本にする
             link("M400 274C400 330 340 326 340 366", dash="10 11.05"),
             bar(304, 372, 72, 10, ACCENT),
             block(100, 420, 360, 150)]
    return "先に保存した変更を残し、古い内容からの保存を止める", parts


DRAWN = {
    TEMPLATES / "lightning": lightning,
    TEMPLATES / "release": release,
    TEMPLATES / "talk": talk,
    TEMPLATES / "update": update,
    TEMPLATES / "webinar": webinar,
    VALIDATION / "s3-conditional-writes": s3_conditional,
}
# 原本の挿絵は、地の面・点の地紋・円弧だけを外す（絵の線と色は変えない）
KEPT = ["cognito-cimd", "jev-guardrail", "rag-webinar"]


def strip_stock(svg):
    svg = re.sub(r'\n<style data-jinno-palette="dark".*?</style>\n', '', svg, flags=re.S)
    svg = re.sub(r'<rect (?=[^>]*width="560")(?=[^>]*height="720")[^>]*/>', '', svg)
    svg = re.sub(r'<circle cx="[\d.]+" cy="[\d.]+" r="1\.4"[^>]*/>', '', svg)
    return re.sub(r'<circle [^>]*r="(?:1\d\d|[2-9]\d\d)"[^>]*fill="none"[^>]*/>', '', svg)


def main():
    for folder, draw in DRAWN.items():
        title, parts = draw()
        out = folder / "figs/cover-art.svg"
        save(out, title, parts)
        out.write_bytes(adaptive_svg(out.read_bytes()))
    for name in KEPT:
        out = GALLERY / name / "figs/cover-art.svg"
        out.write_bytes(adaptive_svg(strip_stock(out.read_text(encoding="utf-8")).encode()))


if __name__ == "__main__":
    main()
