# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""SVG primitives for slide diagrams. Coordinates and stroke widths are in viewBox units."""
from html import escape


SHAPES = {
    'user': '<circle cx="39" cy="18" r="16"/><path d="M9 77 Q8 42 39 40 Q70 42 69 77Z"/>',
    'agent': '<rect x="7" y="18" width="64" height="51" rx="12"/><path d="M39 18V3M29 3H49M0 33V54M78 33V54M25 69V78M53 69V78"/><circle cx="26" cy="39" r="3"/><circle cx="52" cy="39" r="3"/><path d="M27 54H51"/>',
    'document': '<path d="M9 0H51L69 18V78H9Z M51 0V18H69"/><path d="M21 32H57M21 46H57M21 60H49"/>',
    'lock': '<rect x="9" y="30" width="60" height="46" rx="6"/><path d="M21 30V17A18 18 0 0 1 57 17V30"/><circle cx="39" cy="49" r="4"/><path d="M39 53V63"/>',
    'service': '<rect x="8" y="3" width="62" height="20" rx="4"/><rect x="8" y="29" width="62" height="20" rx="4"/><rect x="8" y="55" width="62" height="20" rx="4"/><path d="M17 13H22M17 39H22M17 65H22"/>',
    'database': '<path d="M8 16V62C8 79 70 79 70 62V16"/><ellipse cx="39" cy="16" rx="31" ry="12"/><path d="M8 39C8 56 70 56 70 39"/>',
    'settings': '<rect x="7" y="9" width="64" height="60" rx="5"/><path d="M17 25H61M17 39H61M17 53H61"/><circle cx="29" cy="25" r="5"/><circle cx="49" cy="39" r="5"/><circle cx="34" cy="53" r="5"/>',
    'identity': '<rect x="5" y="14" width="68" height="50" rx="5"/><circle cx="24" cy="32" r="8"/><path d="M12 54Q12 43 24 43Q36 43 36 54M46 29H63M46 40H63M46 51H58"/>',
}


def bubble_outline(x, y, w, h, tx, ty, radius=8):
    """One closed contour, with no border crossing the body/tail join."""
    r = min(radius, w/2, h/2)
    side = 'top' if ty < y else 'bottom' if ty > y+h else 'left' if tx < x else 'right'
    bx = min(max(tx, x+22), x+w-22)
    by = min(max(ty, y+20), y+h-20)
    parts = [f'M{x+r} {y}']
    if side == 'top': parts += [f'H{bx-12}L{tx} {ty}L{bx+12} {y}']
    parts += [f'H{x+w-r}Q{x+w} {y} {x+w} {y+r}']
    if side == 'right': parts += [f'V{by-12}L{tx} {ty}L{x+w} {by+12}']
    parts += [f'V{y+h-r}Q{x+w} {y+h} {x+w-r} {y+h}']
    if side == 'bottom': parts += [f'H{bx+12}L{tx} {ty}L{bx-12} {y+h}']
    parts += [f'H{x+r}Q{x} {y+h} {x} {y+h-r}']
    if side == 'left': parts += [f'V{by+12}L{tx} {ty}L{x} {by-12}']
    parts += [f'V{y+r}Q{x} {y} {x+r} {y}Z']
    return ''.join(parts)


def actor(kind, cx, top, size=68, color="#545b64"):
    """Draw one actor. Its caption belongs below top + size."""
    shape = SHAPES[kind]
    return (f'<g transform="translate({cx - size / 2:g} {top:g}) scale({size / 78:g})" '
            f'fill="none" stroke="{escape(color, quote=True)}" stroke-width="2.4" '
            f'stroke-linejoin="round" stroke-linecap="round">{shape}</g>')


def label(x, y, text, size=22, color="#343a40", anchor="middle", weight=400):
    """Position by baseline. Explicit line breaks become editable tspans."""
    spans = []
    for i, line in enumerate(text.splitlines()):
        dy = size * 1.35 if i else 0
        spans.append(f'<tspan x="{x:g}" dy="{dy:g}">{escape(line)}</tspan>')
    return (f'<text x="{x:g}" y="{y:g}" font-family="Noto Sans JP, Hiragino Sans, sans-serif" '
            f'font-size="{size:g}" fill="{escape(color, quote=True)}" text-anchor="{anchor}" '
            f'font-weight="{weight}">{"".join(spans)}</text>')


def speech(x, y, width, text, tip, size=21):
    """Draw a continuous callout. The tip is the contact point on the speaking actor."""
    lines = text.splitlines()
    if not 1 <= len(lines) <= 2:
        raise ValueError("Use one or two lines in a callout.")
    height = 22 + size * 1.35 * len(lines)
    tx, ty = tip
    if x <= tx <= x + width and y <= ty <= y + height:
        raise ValueError("The callout tip must be outside the text area.")
    outline = bubble_outline(x, y, width, height, tx, ty)
    return (f'<path d="{outline}" fill="#f4f5f7" stroke="#a1a8ae" stroke-width="1.5"/>'
            + label(x + width / 2, y + 11 + size, text, size))
