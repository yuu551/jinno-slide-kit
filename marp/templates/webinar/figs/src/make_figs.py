# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Draw an illustrative waveform for a fictional 30-second recording."""
from math import cos, exp, sin
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parents[1]
INK = "#3a3f44"
ACCENT = "#2f6273"
MID = "#69727a"
RULE = "#c9d0d5"
WASH = "#e5edef"
LEFT, RIGHT = 68, 1004


def x_at(seconds):
    return LEFT + (RIGHT - LEFT) * seconds / 30


def label(x, y, words, size=22, *, bold=False, color=INK, anchor="start"):
    weight = 700 if bold else 400
    return (f'<text x="{x}" y="{y}" fill="{color}" text-anchor="{anchor}" '
            f'font-size="{size}" font-weight="{weight}">{escape(words)}</text>')


def rect(x, y, w, h, fill, radius=0):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}"/>'


def line(x1, y1, x2, y2, color=RULE, width=2):
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="{color}" stroke-width="{width}"/>')


def wave(y, size):
    # Even rain with short peaks for footsteps before 8 s and after 22 s.
    steps = (0.7, 2.1, 3.4, 4.9, 6.4, 7.6, 22.3, 23.7, 25.2, 26.8, 28.1, 29.6)
    bars = {MID: [], ACCENT: []}
    for i in range(235):
        second = 30 * i / 234
        rain = 0.14 + 0.11 * sin(i * 1.81) ** 2 + 0.10 * cos(i * 0.39) ** 2
        foot = sum(0.70 * exp(-((second - step) / 0.24) ** 2) for step in steps)
        amplitude = size * (rain + foot)
        color = ACCENT if 9 <= second <= 21 else MID
        bars[color].append(f"M{x_at(second):.0f} {y - amplitude:.1f} V{y + amplitude:.1f}")
    return "\n".join(f'<path d="{" ".join(segments)}" fill="none" stroke="{color}" stroke-width="2.8"/>'
                     for color, segments in bars.items())


def ticks(y, values):
    parts = []
    for second in values:
        x = x_at(second)
        parts += [line(x, y, x, y + 9, MID), label(x, y + 38, f"{second}秒", anchor="middle")]
    return parts


def save(name, title, height, parts):
    elements = "\n".join(parts)
    (OUT / f"{name}.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1072" height="{height}" '
        f'viewBox="0 0 1072 {height}" role="img" font-family="sans-serif">\n'
        f'<title>{escape(title)}</title>\n{elements}\n</svg>\n', encoding="utf-8")


def cover():
    start, end = x_at(9), x_at(21)
    parts = [
        rect(10, 12, 1052, 212, "#fff", 12), rect(start, 22, end - start, 164, WASH),
        label((start + end) / 2, 55, "切り出す12秒", 24, bold=True, color=ACCENT, anchor="middle"),
        line(LEFT, 123, RIGHT, 123), wave(123, 63),
        line(start, 22, start, 186, ACCENT, 3), line(end, 22, end, 186, ACCENT, 3),
        label(LEFT, 212, "0秒", anchor="middle"), label(RIGHT, 212, "30秒", anchor="middle"),
    ]
    save("cover-wave", "30秒の録音から中央の12秒を切り出す", 236, parts)


def sound_map():
    parts = [label(LEFT, 54, "傘をたたく雨", 27, bold=True),
             rect(LEFT, 73, RIGHT - LEFT, 50, WASH, 4),
             label(LEFT + 18, 107, "録音中ずっと続く", 23, color=ACCENT),
             label(LEFT, 177, "足音", 27, bold=True),
             rect(LEFT, 195, x_at(8) - LEFT, 53, MID, 4),
             rect(x_at(22), 195, RIGHT - x_at(22), 53, MID, 4),
             label(LEFT + 18, 231, "歩く", 24, color="white"),
             label(x_at(22) + 18, 231, "また歩く", 24, color="white"),
             label(x_at(15), 231, "立ち止まる", 24, anchor="middle"), line(LEFT, 266, RIGHT, 266)]
    parts += ticks(266, (0, 8, 22, 30))
    save("sound-map", "雨が続く30秒間の最初と最後に足音が重なる", 328, parts)


def selection():
    start, end = x_at(9), x_at(21)
    parts = [
        label(x_at(8), 45, "足音が消える", 24, anchor="end"),
        label(x_at(22), 45, "足音が戻る", 24),
        line(x_at(8), 58, x_at(8), 155, MID), line(x_at(22), 58, x_at(22), 155, MID),
        rect(start, 75, end - start, 114, WASH), wave(132, 48),
        line(start, 70, start, 226, ACCENT, 3), line(end, 70, end, 226, ACCENT, 3),
        line(start, 213, end, 213, ACCENT, 3),
        label(start - 18, 216, "9秒", 24, anchor="end"),
        label(end + 18, 216, "21秒", 24),
        label(x_at(15), 274, "選ぶ範囲　12秒", 31, color=ACCENT, bold=True, anchor="middle"),
    ]
    save("selection", "両端から1秒ずつ内側の9〜21秒を選ぶ", 309, parts)


def editor():
    start, end = x_at(9), x_at(21)
    parts = [
        rect(10, 10, 1052, 310, "#e3e0e9", 12), rect(12, 12, 1048, 306, "#fff", 10),
        label(42, 53, "rain-walk.wav", 24, bold=True), line(12, 73, 1060, 73),
        rect(start, 85, end - start, 112, WASH),
        line(LEFT, 141, RIGHT, 141), wave(141, 48),
        line(start, 85, start, 198, ACCENT, 3), line(end, 85, end, 198, ACCENT, 3),
        line(LEFT, 203, RIGHT, 203),
    ]
    parts += ticks(203, (0, 9, 21, 30))
    parts += [rect(12, 259, 1048, 57, "#f4f5f7"), label(52, 297, "選択開始　9秒", 24),
              label(408, 297, "終了　21秒", 24), label(755, 297, "長さ　12秒", 26, bold=True, color=ACCENT)]
    save("editor-range", "編集中の波形と選択範囲の表示例", 332, parts)


cover()
sound_map()
selection()
editor()
