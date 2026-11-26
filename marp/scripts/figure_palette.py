# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Add a portable Paper palette to authored SVGs without changing their drawing."""
import argparse
from pathlib import Path
import re
from xml.etree import ElementTree

# Authored accent, ink, wash and rule colors. Status green/orange and product art
# use separate roles. Accent colors are not selected by a hue threshold.
PAPER = {
    "#4a8399": "#78549e", "#28677d": "#70458e", "#2f6273": "#56346f",
    "#1c4858": "#492b60", "#345c6b": "#594064", "#16323c": "#38253e",
    "#0b8f8c": "#8654a1", "#8fd3c6": "#d9b2e6",
    "#edf4f6": "#eee6f6", "#e7eff2": "#e9dff0", "#e3ebee": "#e5d9ed",
    "#e5edef": "#ede4f2", "#c9dde3": "#cfbcd9", "#bcd3db": "#c5afd2",
    "#d5e3e8": "#d8c8e3", "#dfeaee": "#e3d6eb", "#d3e1e6": "#d7c4e1",
    "#e9f0f3": "#eee6f3", "#e5edf0": "#ece2f0", "#e6edf3": "#eae3f3",
    "#232f3e": "#342a3c", "#545b64": "#64586d", "#3a3f44": "#42344c",
    "#5f6b76": "#70647a", "#3d444b": "#514458", "#69727a": "#756a7c",
    "#c9d0d5": "#d1c6d8", "#b9c0c6": "#c3b7ca", "#dde3e6": "#e3dce7",
    "#f4f5f7": "#f3eff6", "#f5f5f5": "#f5f1f6", "#d8dce0": "#ddd3e3",
    "#c6d1d6": "#d0c4d9", "#9aa6b0": "#a399ad", "#e3e7ea": "#e8e0ed",
    "#a9b0b6": "#b3a8bc", "#b5bbc0": "#bfb6c6", "#1f2328": "#332c39",
    "#293135": "#3b2d45", "#556166": "#675a70", "#48595e": "#654576",
    "#69767a": "#71657b", "#b9c2c4": "#c9bad3", "#c4cccd": "#cfc1d6",
    "#f4f5f5": "#f4eff6", "#e5e9e9": "#e7dfed", "#343a40": "#42334b",
}
PROPERTIES = ("fill", "stroke", "color", "stop-color", "flood-color")
STYLE = re.compile(rb'\n<style data-jinno-palette="(?:dark|light)"[^>]*>.*?</style>\n', re.S)


def adaptive_svg(data):
    """Keep original SVG bytes, adding only selectors for paint actually used."""
    original = STYLE.sub(b"", data)
    root = ElementTree.fromstring(original)
    paints = set()

    def visit(node):
        tag = node.tag.rsplit("}", 1)[-1]
        if (node is not root and tag in ("svg", "image")) or "data-fixed-color" in node.attrib:
            return
        for prop in PROPERTIES:
            value = node.get(prop, "").lower()
            if value in PAPER:
                paints.add((prop, value))
        for child in node:
            visit(child)

    visit(root)
    rules = []
    for prop, value in sorted(paints):
        selector = f'[{prop}="{value}" i]'
        guard = ':not(svg svg, svg svg *, [data-fixed-color], [data-fixed-color] *)'
        selectors = f':root {selector}{guard}'
        if root.get(prop, "").lower() == value:
            selectors += f', :root{selector}'
        rules.append(f'{selectors} {{ {prop}: {PAPER[value]} }}')

    # Extend the slide stock behind a figure, keeping white cards and icons white.
    canvas = first_canvas(root)
    if canvas is not None:
        rules.append(f':root > rect:first-of-type[fill="{canvas.get("fill")}" i] {{ fill: {STOCK} }}')
    if not rules:
        return original
    style = ('\n<style data-jinno-palette="dark" media="(prefers-color-scheme: dark)">\n'
             + "\n".join(rules) + "\n</style>\n").encode()
    end = original.rindex(b"</svg>")
    return original[:end] + style + original[end:]


STOCK = "#fcfafd"


def first_canvas(root):
    viewbox = root.get("viewBox", "").replace(",", " ").split()
    if len(viewbox) != 4 or "data-fixed-color" in root.attrib:
        return None
    rect = root.find("{*}rect")
    if rect is None or rect.get("fill", "").lower() not in {"white", "#fff", "#ffffff"}:
        return None
    if "data-fixed-color" in rect.attrib or "transform" in rect.attrib:
        return None
    try:
        bounds = [float(rect.get(key, "0")) for key in ("x", "y", "width", "height")]
        if bounds == [float(v) for v in viewbox]:
            return rect
    except ValueError:
        pass
    return None


def prepare(directory):
    for file in sorted(directory.rglob("*.svg")):
        before = file.read_bytes()
        after = adaptive_svg(before)
        if before != after:
            file.write_bytes(after)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="folder of authored SVG figures")
    prepare(parser.parse_args().directory)
