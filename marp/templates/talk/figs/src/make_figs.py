# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Regenerate the reading diagram with Python's standard library."""
from pathlib import Path
from xml.etree import ElementTree as ET

svg = ET.Element("svg", xmlns="http://www.w3.org/2000/svg", viewBox="0 0 1020 340",
                 width="1020", height="340", role="img")
ET.SubElement(svg, "title").text = "本を読む、問いを書く、次の本を選ぶ。下は一冊目の例"
steps = [("読む", "気になったページ"), ("書き留める", "一行の問い"), ("本棚で探す", "次の一冊")]
# 下の段は、同じ一冊でたどった例（雛形の表と同じ本）
examples = [("読んだページ（例）", ["草木の手帳 p.18"]), ("書いた問い（例）", ["葉のつき方を", "見分けるには？"]),
            ("選んだ本（例）", ["葉の形の図鑑"])]


def text(x, y, size, label, color="#293135"):
    node = ET.SubElement(svg, "text", x=str(x), y=str(y), fill=color,
                         **{"font-family": "sans-serif", "font-size": str(size), "text-anchor": "middle"})
    node.text = label


for index, (action, caption) in enumerate(steps):
    x = index * 350 + 20
    ET.SubElement(svg, "rect", x=str(x), y="16", width="270", height="136", rx="14",
                  stroke="#b9c0c6", fill="#f4f5f7")
    text(x + 135, 76, 34, action)
    text(x + 135, 122, 21, caption)
    if index < len(steps) - 1:
        ET.SubElement(svg, "path", d=f"M{x+283} 84h51m-10 -8l10 8-10 8",
                      stroke="#2f6273", fill="none", **{"stroke-width": "3"})
    label, lines = examples[index]
    ET.SubElement(svg, "path", d=f"M{x+135} 152v32", stroke="#b9c0c6", fill="none",
                  **{"stroke-width": "2", "stroke-dasharray": "5 5"})
    ET.SubElement(svg, "rect", x=str(x), y="184", width="270", height="138", rx="10",
                  stroke="#c9d0d5", fill="white")
    text(x + 135, 220, 18, label, "#5f6b76")
    top = 268 if len(lines) == 1 else 254
    for k, line in enumerate(lines):
        text(x + 135, top + k * 32, 24, line)
out = Path(__file__).resolve().parents[1] / "reading.svg"
ET.indent(svg)
out.write_text(ET.tostring(svg, encoding="unicode") + "\n", encoding="utf-8")
