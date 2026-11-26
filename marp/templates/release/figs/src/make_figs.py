# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Draw the fictional photo library and its contact prints. No external assets."""
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parents[1]
INK = "#293135"
ACCENT = "#48595e"
MID = "#69767a"
PAPER = "#f4f5f5"
RULE = "#c4cccd"


def label(x, y, words, size=24, *, color=INK, bold=False, anchor="start"):
    weight = 700 if bold else 400
    return (f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{anchor}">{escape(words)}</text>')


def frame(x, y, w, h, fill="white", stroke=RULE, radius=8):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>')


def path(d, stroke=INK, width=3, fill="none"):
    return (f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{width}" '
            'stroke-linecap="round" stroke-linejoin="round"/>')


def photo(x, y, scale, subject):
    """Three views of the coast, each drawn inside a 260 by 144 print."""
    sky = frame(0, 0, 260, 144, "#e5e9e9", "none", 0)
    if subject == "岬":
        scene = (
            '<circle cx="192" cy="38" r="16" fill="#fff"/>'
            + path("M0 92 L50 67 L87 61 L129 91 L167 106 H0 Z", "none", 0, "#899597")
            + path("M0 104 L44 81 L91 77 L143 106 H260 V144 H0 Z", "none", 0, ACCENT)
            + path("M167 120 h54 m-39 9 h50", "white", 2)
        )
    elif subject == "桟橋":
        scene = (
            '<circle cx="64" cy="38" r="15" fill="#fff"/>'
            + path("M0 86 Q68 78 122 88 T260 80 V144 H0 Z", "none", 0, "#a1acad")
            + path("M120 144 L174 83 H184 L173 144 Z", "none", 0, ACCENT)
            + path("M154 109 v-21 m20 8 V78 m-7 50 v-23", INK, 3)
            + path("M8 104 h44 m4 13 h37 m112-13 h22", "white", 2)
        )
    else:
        scene = (
            path("M0 73 Q33 95 75 75 T156 75 T235 75 L260 81 V144 H0 Z", "none", 0, "#a1acad")
            + path("M0 101 Q44 123 100 99 T200 99 Q233 110 260 94 V144 H0 Z", "none", 0, ACCENT)
            + path("M8 93 Q39 106 68 96 M119 84 Q143 76 171 86 M180 119 Q219 129 245 114", "white", 3)
        )
    return f'<g transform="translate({x} {y}) scale({scale})">{sky}{scene}</g>'


def save(name, title, height, parts):
    body = "\n".join(parts)
    text = (f'<svg xmlns="http://www.w3.org/2000/svg" width="1060" height="{height}" '
            f'viewBox="0 0 1060 {height}" font-family="sans-serif" role="img">\n'
            f'<title>{escape(title)}</title>\n{body}\n</svg>\n')
    (OUT / f"{name}.svg").write_text(text, encoding="utf-8")


def contact_print():
    parts = [frame(8, 12, 1044, 258, "#303738", "none", 4)]
    for x in range(31, 1034, 36):
        for y in (24, 248):
            parts.append(frame(x, y, 17, 9, PAPER, "none", 2))
    for x, subject in zip((40, 385, 730), ("岬", "桟橋", "波")):
        parts.append(photo(x, 48, 1.10, subject))
        parts.append(label(x, 232, subject, 19, color="white"))
    save("contact-print", "海辺の横写真を並べたコンタクトプリント", 282, parts)


def saved_view():
    parts = [
        frame(8, 10, 1044, 292), frame(9, 11, 315, 290, PAPER, "none", 6),
        label(39, 72, "保存した検索", 24, bold=True),
        frame(29, 98, 275, 64, "white", ACCENT), label(52, 140, "海辺の横写真", 28, bold=True),
        label(362, 73, "海辺の横写真", 32, bold=True), label(988, 70, "2 枚", 21, anchor="end"),
        label(364, 110, "タグ「海辺」　／　向き「横」", 21, color=ACCENT),
        photo(365, 137, 1.02, "岬"), photo(670, 137, 1.02, "桟橋"),
    ]
    save("saved-view", "保存した検索を開くと条件に合う横写真が2枚並ぶ", 316, parts)


def search_steps(saved):
    parts = [
        '<circle cx="99" cy="122" r="25" fill="#e4e8e8" stroke="#293135" stroke-width="3"/>',
        path("M49 210 v-15 q0-34 50-34 t50 34 v15 z", INK, 3, "white"),
        label(99, 267, "編集者", 26, bold=True, anchor="middle"),
        path("M172 166 H248 m-10-9 10 9-10 9", MID),
        label(473, 70, "保存した検索" if saved else "写真の絞り込み", 26, bold=True, anchor="middle"),
        path("M701 166 H771 m-10-9 10 9-10 9", MID),
        frame(810, 91, 193, 118, PAPER), frame(794, 107, 193, 118),
        photo(805, 118, 0.66, "岬"), label(898, 267, "海辺の横写真", 26, bold=True, anchor="middle"),
    ]
    if saved:
        parts += [frame(281, 113, 386, 105, PAPER, ACCENT),
                  label(474, 176, "海辺の横写真", 31, color=ACCENT, bold=True, anchor="middle"),
                  label(474, 267, "名前を選ぶ", 23, anchor="middle")]
    else:
        parts += [frame(281, 101, 386, 55), frame(281, 172, 386, 55),
                  label(310, 138, "タグ", 22), label(459, 139, "海辺", 25, bold=True),
                  label(310, 209, "向き", 22), label(459, 210, "横", 25, bold=True),
                  label(474, 267, "条件を選ぶ", 23, anchor="middle")]
    name = "after" if saved else "before"
    save(name, "同じ横写真をもう一度探す手順", 316, parts)


def arrivals():
    parts = [label(30, 43, "朝に保存", 27, bold=True), label(383, 43, "昼に追加", 27, bold=True),
             label(734, 43, "夕方に開く", 27, color=ACCENT, bold=True),
             path("M34 68 H1014 m-13-9 13 9-13 9", MID)]
    for x in (36, 385, 735):
        parts.append(f'<circle cx="{x}" cy="68" r="6" fill="{ACCENT}"/>')
    parts += [
        frame(20, 103, 296, 196, PAPER), label(42, 153, "海辺の横写真", 29, bold=True),
        label(42, 209, "タグ「海辺」", 24), label(42, 256, "向き「横」", 24),
        photo(379, 115, 0.49, "波"), label(530, 162, "波・横", 24),
        frame(414, 206, 48, 75, "#a1acad", "none", 0),
        path("M415 261 L438 238 L462 255 V281 H415 Z", "none", 0, ACCENT),
        label(530, 254, "岬・縦", 24), path("M681 96 V297", RULE, 2),
        label(730, 151, "元の2枚 ＋ 波", 31, bold=True, color=ACCENT),
        label(730, 214, "横写真が3枚に", 25), label(730, 261, "縦写真は対象外", 23, color=MID),
    ]
    save("new-arrivals", "保存後に加えた2枚のうち横写真だけが検索結果に加わる", 319, parts)


contact_print()
saved_view()
search_steps(False)
search_steps(True)
arrivals()
