"""Generate extension icons: grey 2-bar meter + Twitch purple top bar with T mark."""
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 48, 128]
BG_COLOR = (24, 24, 27)        # Twitch background
BAR_LOW = (95, 95, 110)
BAR_MID = (140, 140, 155)
BAR_HIGH = (145, 70, 255)      # Twitch purple
LETTER = 'T'
LETTER_COLOR = (255, 255, 255, 235)
FONT_PATHS = [
    '/System/Library/Fonts/Supplemental/Arial Black.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    'C:/Windows/Fonts/ariblk.ttf',
]

BARS = [
    (0.35, BAR_LOW),
    (0.60, BAR_MID),
    (0.90, BAR_HIGH),
]


def load_font(size):
    for path in FONT_PATHS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = max(1, size // 16)
    radius = max(2, size // 6)
    draw.rounded_rectangle(
        [pad, pad, size - pad - 1, size - pad - 1],
        radius=radius, fill=BG_COLOR
    )

    n_bars = len(BARS)
    margin_x = size * 0.22
    margin_bottom = size * 0.18
    bar_bottom = size - margin_bottom
    max_bar_h = size * 0.62
    total_bar_area = size - 2 * margin_x
    bar_w = total_bar_area / (n_bars * 1.6)
    gap = (total_bar_area - bar_w * n_bars) / (n_bars - 1)

    for i, (h_frac, color) in enumerate(BARS):
        x0 = margin_x + i * (bar_w + gap)
        x1 = x0 + bar_w
        bar_h = max_bar_h * h_frac
        top = bar_bottom - bar_h
        bar_radius = max(1, int(bar_w * 0.25))
        draw.rounded_rectangle(
            [x0, top, x1, bar_bottom],
            radius=bar_radius, fill=color
        )

    font = load_font(max(7, int(size * 0.45)))
    draw.text((size * 0.10, size * 0.02), LETTER, font=font, fill=LETTER_COLOR)

    return img


for s in SIZES:
    img = draw_icon(s)
    img.save(f'icons/icon{s}.png')
    print(f'Generated icon{s}.png')
