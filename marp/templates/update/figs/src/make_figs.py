# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Draw three independent jobs and their run history using only SVG primitives."""
from pathlib import Path

OUT = Path(__file__).resolve().parents[1]
INK = "#293135"
MID = "#556166"
RULE = "#b9c2c4"
JOBS = ("売上", "在庫", "配送")
ICONS = (
    '<path d="M8 4h38v45l-6-4-5 4-6-4-6 4-5-4-5 4-5-4z M17 16h20 M17 23h12 M17 33h20"/>',
    '<path d="m5 15 22-11 22 11v25L27 51 5 40z M5 15l22 11 22-11 M27 26v25 M16 10l22 11v10"/>',
    '<path d="M4 13h28v25H4z M32 21h10l8 10v7h-5 M33 38h3 M35 24v7h12"/>'
    '<circle cx="13" cy="39" r="5"/><circle cx="40" cy="39" r="5"/>',
)


def label(x, y, words, size, color=INK, weight=400, align="start"):
    return (f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{align}">{words}</text>')


def line(x1, y1, x2, y2, color=RULE, width=2):
    return f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{color}" stroke-width="{width}" fill="none"/>'


def status(x, y, success):
    symbol = 'm-8 0 6 6 11-13' if success else 'm-6-6 12 12 m0-12-12 12'
    return (f'<circle cx="{x}" cy="{y}" r="18" fill="white" stroke="{MID}" stroke-width="2"/>'
            f'<path d="M{x} {y} {symbol}" stroke="{INK}" stroke-width="2.6" fill="none" '
            'stroke-linecap="round" stroke-linejoin="round"/>')


def save(name, title, height, parts):
    body = "\n".join(parts)
    (OUT / f"{name}.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1060" height="{height}" '
        f'viewBox="0 0 1060 {height}" role="img" font-family="system-ui,sans-serif">\n'
        f'<title>{title}</title>\n{body}\n</svg>\n', encoding="utf-8")


def cover():
    pieces = []
    for i, (job, icon) in enumerate(zip(JOBS, ICONS)):
        x = 18 + 351 * i
        pieces += [
            line(x, 20, x + 317, 20, MID),
            f'<g transform="translate({x + 16} 49) scale(1.45)" stroke="{INK}" stroke-width="2.1" '
            f'stroke-linecap="round" stroke-linejoin="round" fill="none">{icon}</g>',
            label(x + 115, 94, job, 36, weight=600),
            status(x + 38, 175, i != 1),
            label(x + 76, 184, "読み込み失敗" if i == 1 else "集計済み", 25, MID),
        ]
    save("night-run", "夜間集計の結果。売上と配送は成功し、在庫は失敗した", 218, pieces)


def history(failed_only):
    pieces = [
        label(24, 38, "集計", 23, MID), label(240, 38, "初回の結果", 23, MID),
        label(704, 38, "復旧後の操作", 23, MID), line(20, 58, 1036, 58),
    ]
    for i, job in enumerate(JOBS):
        y = 111 + 88 * i
        retry = not failed_only or i == 1
        pieces += [
            label(24, y + 10, job, 30, weight=600), status(256, y, i != 1),
            label(298, y + 9, "読み込み失敗" if i == 1 else "成功", 26),
            line(507, y, 638, y, MID if retry else RULE),
        ]
        if retry:
            pieces += [f'<path d="m629 {y - 7} 10 7-10 7" stroke="{MID}" stroke-width="2" fill="none"/>',
                       f'<rect x="688" y="{y - 29}" width="312" height="58" rx="6" '
                       f'fill="#edf0f0" stroke="{MID}" stroke-width="2"/>']
        pieces.append(label(710, y + 9, "再実行する" if retry else "初回の結果を使う", 26,
                            INK if retry else MID, weight=600 if retry else 400))
    name = "retry-failed" if failed_only else "retry-all"
    title = "失敗した在庫だけ再実行する" if failed_only else "3件とも再実行する"
    save(name, title, 333, pieces)


cover()
history(failed_only=False)
history(failed_only=True)
