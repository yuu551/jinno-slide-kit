#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Write a standalone Paper edition of a gallery deck, including its referenced figures."""
import argparse
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory
from xml.dom import minidom
from xml.etree import ElementTree
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "marp/scripts"))
from figure_palette import PAPER, STOCK, STYLE, first_canvas

HEX = re.compile(r"#[0-9a-f]{6}\b", re.I)
FIGURE = re.compile(r"""(?<![\w/])figs/[\w./-]+\.(?:svg|png|jpe?g|webp)\b""", re.I)


def colors(value):
    return HEX.sub(lambda m: PAPER.get(m[0].lower(), m[0]), value)


def recolor_svg(data):
    source = STYLE.sub(b"", data)
    doc = minidom.parseString(source)
    if first_canvas(ElementTree.fromstring(source)) is not None:
        canvas = next(n for n in doc.documentElement.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName == "rect")
        canvas.setAttribute("fill", STOCK)

    def paint(node):
        # Nested SVGs and image hrefs carry original product icons and screenshots.
        if (node is not doc.documentElement and node.localName in {"svg", "image"}) or node.hasAttribute("data-fixed-color"):
            return
        for attr in ("fill", "stroke", "stop-color", "color", "style"):
            if node.hasAttribute(attr):
                node.setAttribute(attr, colors(node.getAttribute(attr)))
        for child in node.childNodes:
            if child.nodeType == child.ELEMENT_NODE:
                paint(child)
            elif node.localName == "style" and child.nodeType in (child.TEXT_NODE, child.CDATA_SECTION_NODE):
                child.data = colors(child.data)

    paint(doc.documentElement)
    return doc.toxml(encoding="utf-8")


def edition(source, target):
    source = source.resolve(strict=True)
    if target.exists():
        raise ValueError(f"Choose a new output directory: {target}")
    text = source.read_text(encoding="utf-8")
    front = re.match(r"\A---\n(.+?)\n---(?=\n)", text, re.S)
    if not front or not re.search(r"^theme: petrol\s*$", front[1], re.M):
        raise ValueError("The source must have theme: petrol in its front matter")
    header = re.sub(r"^theme: petrol[ \t]*$", "theme: paper", front[1], flags=re.M)
    header = re.sub(r"(?m)^  (.*(?:--accent|color|background).*)$", lambda m: colors(m[0]), header)
    body = re.sub(r"<style\b[^>]*>.*?</style>", lambda m: colors(m[0]), text[front.end():], flags=re.S)
    root = source.parent
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=target.parent) as temp:
        result = Path(temp) / "edition"
        result.mkdir()
        for ref in sorted(set(FIGURE.findall(text))):
            original = (root / ref).resolve(strict=True)
            if not original.is_relative_to(root / "figs") or ".." in Path(ref).parts:
                raise ValueError(f"Figure outside the deck: {ref}")
            output = result / ref
            output.parent.mkdir(parents=True, exist_ok=True)
            if original.suffix.lower() == ".svg":
                output.write_bytes(recolor_svg(original.read_bytes()))
            else:
                shutil.copyfile(original, output)
        (result / "slides.md").write_text("---\n" + header + "\n---" + body, encoding="utf-8")
        result.rename(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Petrol gallery slides.md")
    parser.add_argument("output", type=Path, help="new directory for the editable edition")
    args = parser.parse_args()
    try:
        edition(args.source, args.output)
    except (OSError, ValueError) as err:
        parser.exit(1, f"{err}\n")
