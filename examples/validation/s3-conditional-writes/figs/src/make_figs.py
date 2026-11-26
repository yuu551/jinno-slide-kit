# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Rebuild the editable SVGs with `pnpm slides figs` on this deck's slides.md.

The cover art (../cover-art.svg) is drawn by scripts/dev/cover-art.py like the gallery decks.
"""
from html import escape
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from marks import actor, label


OUT = Path(__file__).resolve().parent.parent
INK = "#343a40"
NEUTRAL = "#545b64"
RULE = "#c6d1d6"
PETROL = "#2f6273"
BLUE = "#4a8399"
PALE = "#edf4f6"
GREEN = "#247458"
ORANGE = "#a85327"


def box(x, y, width, height, fill="white", stroke=RULE, radius=8):
    return (f'<rect x="{x}" y="{y}" width="{width}" height="{height}" '
            f'rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')


def path(d, color=NEUTRAL, width=2, dash=None):
    pattern = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<path d="{d}" stroke="{color}" stroke-width="{width}" '
            f'fill="none" stroke-linecap="round" stroke-linejoin="round"{pattern}/>')


def horizontal_arrow(start, end, y, color=NEUTRAL, dashed=False):
    direction = 1 if end > start else -1
    tip_base = end - 11 * direction
    return (path(f"M {start} {y} H {tip_base}", color, 2.4,
                 "5 5" if dashed else None)
            + f'<path d="M {end} {y} L {tip_base} {y - 5.5} '
              f'L {tip_base} {y + 5.5} Z" fill="{color}"/>')


def write(name, width, height, title, parts):
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" '
           f'height="{height}" viewBox="0 0 {width} {height}" role="img">',
           f"<title>{escape(title)}</title>", *parts, "</svg>"]
    (OUT / f"{name}.svg").write_text("\n".join(svg) + "\n", encoding="utf-8")


def trace(conditional):
    left, middle, right = 112, 580, 1048
    parts = []
    for x, kind, name in [(left, "user", "開発者A"), (middle, "database", "S3 · settings.json"),
                          (right, "user", "開発者B")]:
        color = PETROL if kind == "database" else NEUTRAL
        parts += [actor(kind, x, 6, size=48, color=color),
                  label(x, 84, name, 24, color, weight=700),
                  path(f"M{x} 98 V351", RULE, 1.7, "4 5")]

    read = "読み込み　30秒・2回" + ("（E1）" if conditional else "")
    for target in (left, right):
        parts += [label((middle + target) / 2, 119, read, 21, NEUTRAL),
                  horizontal_arrow(middle + (-8 if target == left else 8), target, 131, dashed=True)]
    header = '　If-Match: "E1"' if conditional else ""
    parts += [label((left + middle) / 2, 173, "保存　60秒・2回" + header, 22, INK, weight=600),
              horizontal_arrow(left, middle, 186),
              label((left + middle) / 2, 220, "200 OK" + ("　新しいETagはE2" if conditional else ""), 20, GREEN),
              horizontal_arrow(middle, left, 231, GREEN, dashed=True),
              label((middle + right) / 2, 265, "保存　30秒・3回" + header, 22, INK, weight=600),
              horizontal_arrow(right, middle, 279)]
    if conditional:
        parts += [path(f"M{middle - 7} 272 l14 14 M{middle - 7} 286 l14 -14", ORANGE, 3),
                  label((middle + right) / 2, 316, "412 Precondition Failed", 22, ORANGE, weight=700),
                  horizontal_arrow(middle, right, 330, ORANGE, dashed=True)]
    else:
        parts += [label((middle + right) / 2, 316, "200 OK", 20, GREEN),
                  horizontal_arrow(middle, right, 330, GREEN, dashed=True)]
    parts += [box(205, 361, 750, 54, PALE, BLUE),
              label(231, 396, "S3に残る設定", 21, PETROL, "start", 700),
              label(456, 396, "タイムアウト 60秒" if conditional else "タイムアウト 30秒", 24, INK, "start", 600),
              label(760, 396, "リトライ 2回" if conditional else "リトライ 3回", 24, INK, "start", 600)]
    write("with-condition" if conditional else "without-condition", 1160, 420,
          "条件付きの保存でBに412を返す" if conditional else "条件なしの保存でAの変更が消える", parts)


def recovery():
    # The values occupy identical positions in each snapshot.
    snapshots = [
        (16, "S3から読み直す", "settings.json", "2回", "取得したETag", '"E2"'),
        (419, "Bが手元で編集する", "next.json", "3回", "付ける条件", 'If-Match: "E2"'),
        (822, "S3への保存が成功", "settings.json", "3回", "応答", "200 OK"),
    ]
    parts = []
    for index, (x, title, filename, retries, footer, result) in enumerate(snapshots):
        tint = PALE if index == 2 else "white"
        edge = BLUE if index == 2 else RULE
        parts += [label(x + 157, 58, title, 24, PETROL, weight=700),
                  box(x, 82, 314, 232, tint, edge),
                  actor("document", x + 34, 104, size=33, color=PETROL),
                  label(x + 62, 131, filename, 23, PETROL, "start", 700),
                  path(f"M{x + 22} 153 H{x + 291}", RULE, 1.3),
                  label(x + 23, 201, "タイムアウト", 21, NEUTRAL, "start"),
                  label(x + 290, 201, "60秒", 25, INK, "end", 700),
                  label(x + 23, 259, "リトライ", 21, NEUTRAL, "start"),
                  label(x + 290, 259, retries, 25, INK if index == 0 else PETROL, "end", 700),
                  label(x + 157, 351, footer, 18, NEUTRAL),
                  label(x + 157, 388, result, 24, GREEN if index == 2 else PETROL, weight=700)]
    parts += [horizontal_arrow(344, 403, 210), horizontal_arrow(747, 806, 210)]
    write("retry", 1160, 410, "Bが新しい設定に自分の変更を適用して保存する例", parts)


if __name__ == "__main__":
    trace(False)
    trace(True)
    recovery()
