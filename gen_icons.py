"""Generate extension icons: grey 2-bar meter + theme-color top bar with the
extension's mark, in the colours core.json names."""
import json
import os
import sys

UNAVAILABLE = 3

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as err:
    print(f'{err}. Install pillow to draw the icons.', file=sys.stderr)
    sys.exit(UNAVAILABLE)

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, 'icons')
CONFIG = os.path.join(ROOT, 'core.json')

SIZES = [16, 48, 128]
BAR_LOW = (95, 95, 110)
BAR_MID = (140, 140, 155)
LETTER_COLOR = (255, 255, 255, 235)
FONT_PATHS = [
    '/System/Library/Fonts/Supplemental/Arial Black.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    'C:/Windows/Fonts/ariblk.ttf',
]


def read_style():
    """The extension's own colours and mark, from core.json's `icon`:
    `background` and `accent` as [r, g, b] and `letter` as one character."""
    try:
        with open(CONFIG, encoding='utf-8') as handle:
            icon = json.load(handle)['icon']
        background, accent, letter = icon['background'], icon['accent'], icon['letter']
    except (OSError, ValueError, KeyError, TypeError) as unreadable:
        raise SystemExit(f'core.json names no icon to draw: {unreadable!r}')
    for colour in (background, accent):
        if not (isinstance(colour, list) and len(colour) == 3
                and all(type(c) is int and 0 <= c <= 255 for c in colour)):
            raise SystemExit(f'core.json names a colour that is not [r, g, b]: {colour!r}')
    if not (isinstance(letter, str) and len(letter) == 1):
        raise SystemExit(f'core.json names a mark that is not one character: {letter!r}')
    return tuple(background), tuple(accent), letter


def load_font(size):
    for path in FONT_PATHS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise SystemExit('no face here to draw the mark with. Looked for:\n  '
                     + '\n  '.join(FONT_PATHS))


def draw_icon(size, style):
    background, accent, letter = style
    bars = [
        (0.35, BAR_LOW),
        (0.60, BAR_MID),
        (0.90, accent),
    ]
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = max(1, size // 16)
    radius = max(2, size // 6)
    draw.rounded_rectangle([pad, pad, size - pad - 1, size - pad - 1],
                           radius=radius, fill=background)

    n_bars = len(bars)
    margin_x = size * 0.22
    margin_bottom = size * 0.18
    bar_bottom = size - margin_bottom
    max_bar_h = size * 0.62
    total_bar_area = size - 2 * margin_x
    bar_w = total_bar_area / (n_bars * 1.6)
    gap = (total_bar_area - bar_w * n_bars) / (n_bars - 1)

    for i, (h_frac, color) in enumerate(bars):
        x0 = margin_x + i * (bar_w + gap)
        x1 = x0 + bar_w
        bar_h = max_bar_h * h_frac
        top = bar_bottom - bar_h

        bar_radius = max(1, int(bar_w * 0.25))
        draw.rounded_rectangle([x0, top, x1, bar_bottom],
                               radius=bar_radius, fill=color)

    font = load_font(max(7, int(size * 0.45)))
    draw.text((size * 0.10, size * 0.02), letter, font=font, fill=LETTER_COLOR)

    return img

if __name__ == '__main__':
    style = read_style()
    for s in SIZES:
        img = draw_icon(s, style)
        img.save(os.path.join(OUT_DIR, f'icon{s}.png'))
        print(f'Generated icon{s}.png')
