# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Draw a new set of stop-motion frames; each frame represents 0.25 s."""
from pathlib import Path

OUT = Path(__file__).resolve().parents[1]
ACCENT = "#2f6273"
INK = "#3a3f44"


def label(x, y, text, size=22, color=INK):
    return (f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" '
            f'text-anchor="middle">{text}</text>')


def card(x, index, position, highlight):
    color = ACCENT if highlight else "#9aa6b0"
    cx = (45, 108, 171)[position]
    return [
        f'<g transform="translate({x} 22)">',
        f'<rect x="0" y="0" width="216" height="174" rx="7" fill="white" stroke="{color}" stroke-width="3"/>',
        '<path d="M13 131 H203" fill="none" stroke="#9aa6b0" stroke-width="2"/>',
        f'<circle cx="{cx}" cy="105" r="25" fill="{color}"/>',
        f'<g transform="rotate({position * 90} {cx} 105)">',
        f'<path d="M{cx - 17} 93 Q{cx - 9} 80 {cx + 4} 87" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/>',
        '</g>',
        label(108, 161, f"{index} コマ目", color=color),
        '</g>',
    ]


def strip(name, positions):
    # Keep the first three frames in the same place for the before/after comparison.
    parts = []
    for i, position in enumerate(positions):
        parts.extend(card(18 + 271 * i, i + 1, position, len(positions) == 4 and i >= 2))
        if i + 1 < len(positions):
            x = 242 + 271 * i
            parts.append(f'<path d="M{x} 109 h36 m-9-8 9 8-9 8" fill="none" stroke="#69767a" stroke-width="3"/>')
    if len(positions) == 4:
        parts.extend([
            f'<path d="M560 212 v15 h487 v-15" stroke="{ACCENT}" stroke-width="3" fill="none"/>',
            label(803, 264, "同じ位置が 0.5 秒続く", 24, ACCENT),
        ])
    else:
        parts.extend([
            '<path d="M18 212 v15 h757 v-15" stroke="#69767a" stroke-width="3" fill="none"/>',
            label(397, 264, "3 コマで 0.75 秒", 24),
        ])
    body = "\n".join(parts)
    (OUT / f"{name}.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1065" height="283" '
        'viewBox="0 0 1065 283" font-family="sans-serif" role="img">\n'
        f'<title>玉の位置を示す{len(positions)}コマの絵コンテ</title>\n{body}\n</svg>\n',
        encoding="utf-8")


strip("move", [0, 1, 2])
strip("hold", [0, 1, 2, 2])
