"""Generate Chrome Web Store screenshot mockups (640x400), ja + en.

Drawn straight with PIL: the three scenes popup / settings / overlay, in ja and
en. The colours and the UI strings match the values in popup.html,
options.html and _locales.

`--check` redraws into a temporary directory and reads the committed files byte
by byte before comparing the pixels. It writes nothing. Exit 1 means the two
differ, exit 3 that this machine cannot draw them (no pillow, no face).
`--out <dir>` writes into that directory instead of docs/screenshots. An
argument this does not know and a `--out` with no value are exit 2, and neither
draws anything. A destination that was named and cannot be written is exit 2 as
well (the committed one, with no argument, is exit 1).
"""
import hashlib
import json
import math
import os
import shutil
import stat
import sys
import tempfile
import zlib

UNAVAILABLE = 3

try:
    from PIL import Image, ImageDraw, ImageFont
    # Pillow reaches for raqm where it is installed, and the two engines place
    # the glyphs differently. The comparison is against the committed images,
    # so the engine is pinned here.
    BASIC_LAYOUT = ImageFont.Layout.BASIC
except (AttributeError, ImportError) as err:
    # Not the end of the run: an argument that is wrong deserves the answer for
    # arguments (exit 2), and the one for a machine that cannot draw (exit 3)
    # must not stand in for it.
    CANNOT_DRAW = f'{err}. Install pillow to draw the screenshots.'
else:
    CANNOT_DRAW = None

W, H = 640, 400

ROOT = os.path.dirname(os.path.abspath(__file__))
# Reference images the extension does not ship, so they live under docs/. The
# path is resolved from this file rather than from the working directory.
OUT_DIR = os.path.join(ROOT, 'docs', 'screenshots')

# ── Colors (the values in popup.html / options.html) ─────────────────
PAGE_BG = (15, 15, 35)    # #0f0f23 options body
POPUP_BG = (26, 26, 46)   # #1a1a2e
INFO_BG = (22, 33, 62)    # #16213e info-section / toggle inactive
CARD_BG = (26, 26, 46)    # #1a1a2e loudness-card
TEAL = (78, 205, 196)     # #4ecdc4
YELLOW = (249, 202, 36)   # #f9ca24
PINK = (255, 107, 157)    # #ff6b9d
WHITE = (255, 255, 255)
LIGHT = (225, 225, 225)   # #e1e1e1
CC = (204, 204, 204)      # #cccccc
GRAY = (136, 136, 136)    # #888
DIM = (102, 102, 102)     # #666
HINT = (153, 153, 153)    # #999 the muted text in the popup
DIM2 = (85, 85, 85)       # #555
DIM3 = (68, 68, 68)       # #444
BORDER = (42, 42, 74)     # #2a2a4a
LIVE_RED = (233, 25, 22)  # #e91916
PURPLE = (145, 71, 255)   # #9147ff Twitch purple
SWITCH_ON = (27, 58, 75)  # #1b3a4b
RESET_BORDER = (50, 119, 129)  # rgba(78, 205, 196, 0.5) on INFO_BG
RESET_BG = (25, 43, 70)        # rgba(78, 205, 196, 0.06) on INFO_BG
RESET_BUTTON_HEIGHT = 36
HEADER_GEAR_RADIUS = 6      # the settings icon in the popup header
PLAYER_GEAR_RADIUS = 5      # the settings icon in the player controls
FULLSCREEN_SIZE = 12        # the fullscreen icon in the player controls


# The committed images are drawn with these two faces. Another face changes the
# bytes of all six, so nothing is picked from a list of candidates: these two
# are used and the run stops without them. They are committed under tools/, so
# the CI runner rasterizes the same glyphs.
FONT_DIR = os.path.join(ROOT, 'tools', 'fonts')
FONT_REGULAR_FILE = os.path.join(FONT_DIR, 'MPLUS1p-Regular.ttf')
FONT_BOLD_FILE = os.path.join(FONT_DIR, 'MPLUS1p-Bold.ttf')


def _font(size, bold=False):
    path = FONT_BOLD_FILE if bold else FONT_REGULAR_FILE
    try:
        return ImageFont.truetype(path, size, layout_engine=BASIC_LAYOUT)
    except OSError as err:
        # Which of the two faces failed is not in what was raised.
        raise OSError(err.errno or 0, str(err), path) from err


# The faces resolve only where pillow is. A face that will not read is carried
# back rather than raised, so the arguments are read before the run answers
# that it cannot draw (an argument that is wrong stays exit 2).
if CANNOT_DRAW is None:
    try:
        FONT = _font(13)
        FONT_SM = _font(11)
        FONT_LG = _font(18)
        FONT_TITLE = _font(15, bold=True)
        FONT_BOLD = _font(13, bold=True)
        FONT_VAL = _font(17, bold=True)
        FONT_XL = _font(20, bold=True)
        FONT_XS = _font(9)
        FONT_PRESET = _font(11, bold=True)
    except OSError as err:
        CANNOT_DRAW = (f'{os.path.relpath(err.filename, ROOT)} cannot be read '
                       f'({err.strerror}). The images in docs/screenshots/ are drawn '
                       'with this face, and another one redraws all six.')


def draw_gear(draw, center, color, radius=HEADER_GEAR_RADIUS):
    """Draw a gear: PIL's default face has no glyph for U+2699 and lands tofu."""
    cx, cy = center
    for step in range(8):
        angle = math.pi * step / 4
        inner = (cx + math.cos(angle) * radius, cy + math.sin(angle) * radius)
        outer = (cx + math.cos(angle) * (radius + 3), cy + math.sin(angle) * (radius + 3))
        draw.line([inner, outer], fill=color, width=2)
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], outline=color, width=2)
    draw.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=color)


def draw_fullscreen(draw, center, color, size=FULLSCREEN_SIZE):
    """Draw the fullscreen icon. U+26F6 lands tofu for the same reason."""
    cx, cy = center
    half, arm = size / 2, size / 3
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = cx + half * sx, cy + half * sy
            draw.line([(x, y), (x - arm * sx, y)], fill=color, width=2)
            draw.line([(x, y), (x, y - arm * sy)], fill=color, width=2)


def rr(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def fit_text(draw, text, font, max_width):
    if draw.textlength(text, font=font) <= max_width:
        return text
    trimmed = text
    while trimmed and draw.textlength(trimmed + '…', font=font) > max_width:
        trimmed = trimmed[:-1]
    return trimmed + '…'


def draw_reset_icon(draw, left, top, size, color):
    """Draw the rotating arrow of the popup.html SVG (a 24-unit viewBox)."""
    k = size / 24.0
    width = max(2, round(1.8 * k))
    cx, cy, r = 12.0, 12.0, 7.81
    arc_end = (6.1, 6.9)

    def pt(x, y):
        return (left + x * k, top + y * k)

    draw.arc(
        [left + (cx - r) * k, top + (cy - r) * k,
         left + (cx + r) * k, top + (cy + r) * k],
        220.8, 144.9, fill=color, width=width,
    )
    draw.line([pt(*arc_end), pt(4, 10)], fill=color, width=width)
    draw.line([pt(4, 4), pt(4, 10), pt(10, 10)], fill=color, width=width)


# ── Localized strings ────────────────────────────────────────────────

# What the extension shows is the catalog's, and this reads it there. Written
# out again it was a third copy of every label, kept by hand beside the pages
# and the catalog with nothing comparing the three, so a screenshot could go on
# showing a string the extension had stopped using.
FROM_CATALOG = {
    'name': 'extName',
    'apply': 'applyToChannel',
    'auto_label': 'autoApplyLoudness',
    'target_label': 'targetLufs',
    'target_desc': 'targetLufsDesc',
    'auto_defaults_label': 'allChannelsAutoApply',
    'auto_defaults_desc': 'allChannelsAutoApplyDesc',
    'adgain_label': 'adGain',
    'adgain_desc': 'adGainDesc',
    'unit_label': 'displayUnit',
    'unit_desc': 'displayUnitDesc',
    'overlay_label': 'showGainOverlay',
    'overlay_desc': 'showGainOverlayDesc',
    'type_live': 'typeLive',
    'type_vod': 'typeVod',
    'auto': 'labelAuto',
}

# The rows options.html lays out, in its order: the message the label shows,
# the message under it, and the control the page carries on that row with how
# many of it. The
# drawing walks this, so what is drawn cannot drift from it, and test.js
# compares it with the page. Nothing else notices when the page grows a row,
# reorders two, or swaps a control: these screenshots are a hand-drawn mock and
# `--check` only holds the drawing to its own committed output.
SETTING_ROWS = (
    # Target LUFS: -30..-6, value -18 -> frac (-18-(-30))/24 = 0.5
    ('target_label', 'target_desc', 'range', {'at': 0.5, 'value': '-18 LUFS'}),
    ('auto_defaults_label', 'auto_defaults_desc', 'toggle',
     {'switches': (('type_live', 167, True), ('type_vod', 89, False))}),
    # CM Gain: -24..6, value -6 -> frac (-6-(-24))/30 = 0.6
    ('adgain_label', 'adgain_desc', 'range', {'at': 0.6, 'value': '-6 dB'}),
    ('unit_label', 'unit_desc', 'buttons',
     {'at': 95, 'names': (('%', 13, True), ('dB', 11, False))}),
    ('overlay_label', 'overlay_desc', 'toggle', {'switches': ((None, 56, True),)}),
)
# How many of that control a row carries, read off what its drawing is given
# rather than declared a second time beside it.
HOW_MANY = {'range': lambda p: 1,
            'toggle': lambda p: len(p['switches']),
            'buttons': lambda p: len(p['names'])}
ROW_HEIGHT = 36
FIRST_ROW = 31
CARD_BELOW_LAST = 43
CARD_TO_CHANNELS = 9
SETTINGS_TOP = 43
CHANNELS_HEIGHT = 126

def sheet_height(rows=None):
    """The bottom of the settings sheet's last card, for a number of rows."""
    many = len(SETTING_ROWS) if rows is None else rows
    card = FIRST_ROW + (many - 1) * ROW_HEIGHT + CARD_BELOW_LAST
    return SETTINGS_TOP + card + CARD_TO_CHANNELS + CHANNELS_HEIGHT


def rows_drawn():
    """Each row the settings sheet draws: the two messages, the control, the count."""
    return [(FROM_CATALOG[label], FROM_CATALOG[desc], control, HOW_MANY[control](params))
            for label, desc, control, params in SETTING_ROWS]

# What the drawing invents: a stream nobody is watching, the channels nobody
# saved, and the headings and badges this mock draws around them — Twitch's
# own furniture as much as the extension's.
STRINGS = {
    'ja': {
        'channel': 'サンプル配信ch.',
        'live': 'LIVE',
        'auto_hint': 'この種別は自動追従が\n有効です',
        'manual': 'MANUAL VOLUME',
        'settings': 'SETTINGS',
        'saved': 'SAVED CHANNELS',
        'col_channel': 'CHANNEL',
        'channels': [
            ('Game Stream TV', 'Auto (63%)', '80%'),
            ('雑談ラジオ', '120%', '—'),
            ('Music Box', 'Auto (55%)', '70%'),
        ],
        'stream_title': '【雑談】ゲーム配信のあとに少しだけ',
        'viewers': '1,234 人が視聴中',
    },
    'en': {
        'channel': 'Sample Stream',
        'live': 'LIVE',
        'auto_hint': 'Auto-follow is enabled\nfor this type',
        'manual': 'MANUAL VOLUME',
        'settings': 'SETTINGS',
        'saved': 'SAVED CHANNELS',
        'col_channel': 'CHANNEL',
        'channels': [
            ('Game Stream TV', 'Auto (63%)', '80%'),
            ('Talk Radio', '120%', '—'),
            ('Music Box', 'Auto (55%)', '70%'),
        ],
        'stream_title': 'Just chatting after the game',
        'viewers': '1,234 watching',
    },
}


def _messages(lang):
    """The catalog the extension reads for a language."""
    path = os.path.join(ROOT, '_locales', lang, 'messages.json')
    try:
        with open(path, encoding='utf-8') as handle:
            return {key: entry['message'] for key, entry in json.load(handle).items()}
    except OSError as err:
        raise SystemExit(f'no wording here to draw the screenshots with: {err}')


for _lang, _drawn in STRINGS.items():
    _catalog = _messages(_lang)
    for _key in FROM_CATALOG.values():
        if _key not in _catalog:
            raise SystemExit(f'{_lang} has no message named {_key}, which the '
                             f'screenshots draw')
    for _name, _key in FROM_CATALOG.items():
        _drawn[_name] = _catalog[_key]
    # The arrow the mock points at the overlay with, and the name of the thing
    # it points at.
    _drawn['overlay_note'] = f'↓ {_catalog["showGainOverlay"]}'


def screenshot_popup(lang, out_dir):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), PAGE_BG)
    draw = ImageDraw.Draw(img)

    px, pw = 160, 320
    py, ph = 20, 368
    rr(draw, [px, py, px + pw, py + ph], 10, POPUP_BG)

    # Header
    draw.text((px + 16, py + 12), s['name'], fill=TEAL, font=FONT_TITLE)
    draw_gear(draw, (px + pw - 19, py + 20), HINT)
    draw.line([(px, py + 39), (px + pw, py + 39)], fill=BORDER)

    # Info section
    iy = py + 39
    info_height = 126
    rr(draw, [px, iy, px + pw, iy + info_height], 0, INFO_BG)
    channel_y = iy + 20

    # Measurement reset button. It keeps its width; the channel name shrinks.
    reset_width = RESET_BUTTON_HEIGHT
    reset_x = px + pw - 16 - reset_width
    reset_y = iy + 9

    # Channel name + LIVE badge share the width left of the button
    name = fit_text(draw, s['channel'], FONT_BOLD, reset_x - 8 - 34 - 8 - (px + 16))
    draw.text((px + 16, channel_y), name, fill=WHITE, font=FONT_BOLD)
    cl = draw.textlength(name, font=FONT_BOLD)
    bx = px + 16 + cl + 8
    assert bx + 34 <= reset_x - 8, f'{lang}: LIVE badge overlaps the reset button'
    rr(draw, [bx, iy + 19, bx + 34, iy + 35], 3, LIVE_RED)
    draw.text((bx + 6, iy + 21), s['live'], fill=WHITE, font=FONT_XS)
    draw.rounded_rectangle(
        [reset_x, reset_y, reset_x + reset_width - 1,
         reset_y + RESET_BUTTON_HEIGHT - 1],
        radius=6,
        fill=RESET_BG,
        outline=RESET_BORDER,
        width=1,
    )
    draw_reset_icon(draw, reset_x + 9, reset_y + 9, 17, TEAL)

    # Cards
    cards = [
        ('INTEGRATED', '-14.0', 'LUFS', TEAL),
        ('SUGGESTED', '63', '%', YELLOW),
        ('CURRENT', '63', '%', PINK),
    ]
    cw, gap = 92, 5
    cx = px + 16
    cy = iy + 58
    for label, val, unit, color in cards:
        rr(draw, [cx, cy, cx + cw, cy + 52], 6, CARD_BG)
        draw.text((cx + 9, cy + 8), label, fill=GRAY, font=FONT_XS)
        draw.text((cx + 9, cy + 22), val, fill=color, font=FONT_VAL)
        vw = draw.textlength(val, font=FONT_VAL)
        draw.text((cx + 9 + vw + 2, cy + 28), unit, fill=GRAY, font=FONT_SM)
        cx += cw + gap
    draw.line([(px, iy + info_height), (px + pw, iy + info_height)], fill=BORDER)

    # Auto-follow switch (ON)
    auto_y = iy + info_height
    draw.text((px + 16, auto_y + 14), s['auto_label'], fill=CC, font=FONT_BOLD)
    switch_x = px + pw - 52
    rr(draw, [switch_x, auto_y + 10, switch_x + 36, auto_y + 30], 10, SWITCH_ON)
    draw.ellipse([switch_x + 19, auto_y + 13, switch_x + 33, auto_y + 27], fill=TEAL)
    draw.line([(px, auto_y + 44), (px + pw, auto_y + 44)], fill=BORDER)

    # Apply button is disabled while Auto-follow is enabled.
    ay = auto_y + 54
    rr(draw, [px + 16, ay, px + 172, ay + 32], 6, BORDER)
    tw = draw.textlength(s['apply'], font=FONT_BOLD)
    draw.text((px + 16 + (156 - tw) / 2, ay + 8), s['apply'], fill=DIM2, font=FONT_BOLD)
    draw.multiline_text((px + 182, ay + 4), s['auto_hint'], fill=HINT, font=FONT_XS, spacing=1)
    draw.line([(px, ay + 44), (px + pw, ay + 44)], fill=BORDER)

    # Manual volume
    my = ay + 56
    draw.text((px + 16, my), s['manual'], fill=DIM2, font=FONT_SM)
    sy = my + 22
    track_l, track_r = px + 16, px + pw - 58
    draw.rounded_rectangle([track_l, sy + 4, track_r, sy + 10], radius=3, fill=BORDER)
    thumb_x = int(track_l + (track_r - track_l) * 0.63)
    draw.rounded_rectangle([track_l, sy + 4, thumb_x, sy + 10], radius=3, fill=DIM3)
    draw.ellipse([thumb_x - 8, sy - 1, thumb_x + 8, sy + 15], fill=DIM2, outline=POPUP_BG, width=2)
    draw.text((px + pw - 48, sy - 1), '63%', fill=DIM2, font=FONT_BOLD)

    # Presets
    presets = ['0%', '50%', '100%', '200%', '400%', 'MAX']
    bw = (pw - 32 - 5 * 4) / 6
    bx = px + 16
    by = sy + 24
    for p in presets:
        rr(draw, [bx, by, bx + bw, by + 20], 4, BORDER)
        ptw = draw.textlength(p, font=FONT_PRESET)
        draw.text((bx + (bw - ptw) / 2, by + 4), p, fill=DIM2, font=FONT_PRESET)
        bx += bw + 4

    img.save(os.path.join(out_dir, f'popup_{lang}.png'))


def screenshot_settings(lang, out_dir):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), PAGE_BG)
    draw = ImageDraw.Draw(img)

    draw.text((30, 22), s['name'], fill=TEAL, font=FONT_XL)

    # Settings section
    sx, sw = 24, 592
    sy = SETTINGS_TOP
    # As tall as the rows it holds, so declaring one more moves the section
    # below rather than drawing over it.
    sh = FIRST_ROW + (len(SETTING_ROWS) - 1) * ROW_HEIGHT + CARD_BELOW_LAST
    # The canvas is a fixed 640x400 and nothing clips to it, so a row too many
    # is drawn off the bottom edge and saved at exit 0. A margin under the last
    # card is not held here: the height moves a whole row at a time, so no
    # number of rows lands inside one.
    if sheet_height() > H:
        raise SystemExit(
            f'{len(SETTING_ROWS)} settings rows, the last of them '
            f'{SETTING_ROWS[-1][0]}, need {sheet_height()} px '
            f'of the {H} the sheet has')
    rr(draw, [sx, sy, sx + sw, sy + sh], 10, POPUP_BG)
    draw.text((sx + 20, sy + 14), s['settings'], fill=GRAY, font=FONT_SM)

    def paint_range(y, at, value, thumb=TEAL):
        tl, tr = sx + sw - 230, sx + sw - 95
        draw.rounded_rectangle([tl, y + 6, tr, y + 10], radius=2, fill=BORDER)
        tx = int(tl + (tr - tl) * at)
        draw.ellipse([tx - 8, y, tx + 8, y + 16], fill=thumb, outline=POPUP_BG, width=2)
        draw.text((sx + sw - 85, y), value, fill=TEAL, font=FONT_BOLD)

    # One switch, wherever it is drawn: the knob is on the right only when the
    # switch is on. Drawn twice, the unlabelled one kept its knob on the right
    # whatever it was given, and only a row drawn off would have shown it.
    def switch(x, top, on):
        rr(draw, [x, top, x + 36, top + 20], 10, SWITCH_ON if on else BORDER)
        knob_x = x + (19 if on else 3)
        draw.ellipse([knob_x, top + 3, knob_x + 14, top + 17],
                     fill=TEAL if on else GRAY)

    def paint_toggle(y, switches):
        for name, back, on in switches:
            gx = sx + sw - back
            if name is None:
                switch(gx, y - 1, on)
                continue
            draw.text((gx, y), s[name].upper(), fill=GRAY, font=FONT_XS)
            switch(gx + 30, y - 3, on)

    def paint_buttons(y, at, names):
        gx = sx + sw - at
        for index, (name, dx, picked) in enumerate(names):
            left = gx + index * 36
            rr(draw, [left, y - 2, left + 36, y + 18], 6, TEAL if picked else INFO_BG)
            draw.text((left + dx, y + 1), name, fill=POPUP_BG if picked else HINT,
                      font=FONT_BOLD)

    # The control a row declares is the control it draws: the name picks the
    # painter, so a row declaring one the drawing has not got stops the run
    # rather than leaving the old one under the new name.
    painters = {'range': paint_range, 'toggle': paint_toggle, 'buttons': paint_buttons}

    ry = sy + FIRST_ROW
    for index, (label, desc, control, params) in enumerate(SETTING_ROWS):
        draw.text((sx + 20, ry), s[label], fill=CC, font=FONT)
        draw.text((sx + 20, ry + 18), s[desc], fill=HINT, font=FONT_SM)
        paint = painters.get(control)
        if paint is None:
            raise SystemExit(f'no way to draw a {control} on the {label} row')
        paint(ry, **params)
        if index < len(SETTING_ROWS) - 1:
            draw.line([(sx + 20, ry + 31), (sx + sw - 20, ry + 31)], fill=BORDER)
            ry += ROW_HEIGHT

    # Saved Channels section
    cy = sy + sh + CARD_TO_CHANNELS
    ch = CHANNELS_HEIGHT
    rr(draw, [sx, cy, sx + sw, cy + ch], 10, POPUP_BG)
    draw.text((sx + 20, cy + 14), s['saved'], fill=GRAY, font=FONT_SM)

    # Header row: CHANNEL | Live | VOD
    hy = cy + 31
    col_live, col_vod = sx + 370, sx + 465
    draw.text((sx + 20, hy), s['col_channel'], fill=HINT, font=FONT_SM)
    for cxh, t in ((col_live, s['type_live'].upper()), (col_vod, s['type_vod'].upper())):
        draw.text((cxh, hy), t, fill=HINT, font=FONT_SM)
    draw.line([(sx + 20, hy + 18), (sx + sw - 20, hy + 18)], fill=BORDER)

    ry = hy + 23
    delete_x = sx + sw - 36
    for name, live, vod in s['channels']:
        draw.text((sx + 20, ry), name, fill=TEAL, font=FONT)
        for cxh, v in ((col_live, live), (col_vod, vod)):
            color = TEAL if v.startswith(s['auto']) else (PINK if v != '—' else HINT)
            draw.text((cxh, ry), v, fill=color, font=FONT_BOLD)
            end = cxh + draw.textlength(v, font=FONT_BOLD)
            limit = delete_x if cxh == col_vod else col_vod
            assert end + 8 <= limit, f'{lang}: {v!r} runs into the next column'
        draw.text((delete_x, ry - 2), '×', fill=HINT, font=FONT_LG)
        ry += 23

    img.save(os.path.join(out_dir, f'settings_{lang}.png'))


def screenshot_overlay(lang, out_dir):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), (24, 24, 24))
    draw = ImageDraw.Draw(img)

    # Video area
    draw.rectangle([0, 0, W, H - 52], fill=(18, 18, 18))
    draw.text((W // 2 - 70, H // 2 - 50), '▶  Twitch Player', fill=(58, 58, 58), font=FONT_LG)

    # Top: stream title + channel + LIVE + viewers
    draw.text((20, 18), s['stream_title'], fill=WHITE, font=FONT_LG)
    draw.text((20, 46), s['channel'], fill=PURPLE, font=FONT_BOLD)
    cl = draw.textlength(s['channel'], font=FONT_BOLD)
    lx = 20 + cl + 10
    draw.ellipse([lx, 49, lx + 8, 57], fill=LIVE_RED)
    draw.text((lx + 13, 46), s['live'], fill=LIVE_RED, font=FONT_BOLD)
    draw.ellipse([lx + 52, 49, lx + 58, 55], fill=(173, 173, 173))
    draw.text((lx + 64, 46), s['viewers'], fill=(173, 173, 173), font=FONT_SM)

    # Bottom control bar
    bar_y = H - 52
    draw.rectangle([0, bar_y, W, H], fill=(12, 12, 12))
    # thin progress (live = full purple)
    draw.rectangle([0, bar_y, W, bar_y + 3], fill=BORDER)
    draw.rectangle([0, bar_y, W, bar_y + 3], fill=PURPLE)

    cy = bar_y + 26
    # play
    draw.polygon([(20, cy - 8), (20, cy + 8), (34, cy)], fill=WHITE)
    # volume icon + bar
    vx = 56
    draw.rectangle([vx, cy - 5, vx + 4, cy + 5], fill=WHITE)
    draw.polygon([(vx + 4, cy - 5), (vx + 12, cy - 11), (vx + 12, cy + 11), (vx + 4, cy + 5)], fill=WHITE)
    draw.arc([vx + 14, cy - 8, vx + 26, cy + 8], -60, 60, fill=WHITE, width=2)
    bx0, bx1 = vx + 36, vx + 96
    draw.rounded_rectangle([bx0, cy - 1, bx1, cy + 1], radius=1, fill=(100, 100, 100))
    fill_x = int(bx0 + (bx1 - bx0) * 0.6)
    draw.rounded_rectangle([bx0, cy - 1, fill_x, cy + 1], radius=1, fill=WHITE)
    draw.ellipse([fill_x - 5, cy - 5, fill_x + 5, cy + 5], fill=WHITE)
    # Gain overlay (the feature)
    gx = bx1 + 12
    draw.text((gx, cy - 8), '63%', fill=TEAL, font=FONT_BOLD)
    # annotation
    draw.text((gx - 6, cy - 48), s['overlay_note'], fill=TEAL, font=FONT_BOLD)

    # right controls
    draw_gear(draw, (W - 62, cy), WHITE, radius=PLAYER_GEAR_RADIUS)
    draw_fullscreen(draw, (W - 34, cy), WHITE)

    img.save(os.path.join(out_dir, f'overlay_{lang}.png'))


def verify_icons():
    """Confirm the drawing helpers put lines down, at the sizes production uses.

    A check that reads the source alone says nothing once a body is emptied, so
    every run draws onto a small canvas and holds the shapes to their contract.
    What is looked at is that the teeth, the ring and the four corner arms are
    there, not where exactly they landed. The sizes are the constants
    production draws with: checking at another size lets through a change that
    draws nothing at the real one.
    """
    bg, fg, box = (0, 0, 0), (255, 255, 255), 40
    center = box / 2

    def canvas():
        img = Image.new('RGB', (box, box), bg)
        return img, ImageDraw.Draw(img)

    def ray(px, angle, radii):
        return any(px[int(center + math.cos(angle) * r),
                      int(center + math.sin(angle) * r)] != bg for r in radii)

    for radius in (HEADER_GEAR_RADIUS, PLAYER_GEAR_RADIUS):
        img, draw = canvas()
        draw_gear(draw, (center, center), fg, radius=radius)
        px = img.load()
        for step in range(8):
            angle = math.pi * step / 4
            # The band the teeth reach and the ring does not.
            assert ray(px, angle, (radius + 2, radius + 3)), \
                f'draw_gear(radius={radius}): tooth {step} is not drawn'
            # The band between two teeth, where the teeth do not reach and only
            # the ring is left.
            assert ray(px, angle + math.pi / 8, (radius - 1, radius)), \
                f'draw_gear(radius={radius}): the ring is missing beside tooth {step}'
        assert px[int(center), int(center)] != bg, \
            f'draw_gear(radius={radius}): the hub is not drawn'

    img, draw = canvas()
    draw_fullscreen(draw, (center, center), fg, size=FULLSCREEN_SIZE)
    px = img.load()
    half = FULLSCREEN_SIZE // 2
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = int(center + half * sx), int(center + half * sy)
            # Off the point the two arms share, so each is looked at on its own.
            assert any(px[x - k * sx, y] != bg for k in (2, 3)), \
                f'draw_fullscreen: the horizontal arm at corner ({sx}, {sy}) is not drawn'
            assert any(px[x, y - k * sy] != bg for k in (2, 3)), \
                f'draw_fullscreen: the vertical arm at corner ({sx}, {sy}) is not drawn'


class Refused(Exception):
    """The filesystem turned something down. What it was is in the message.

    Cannot be read, cannot be drawn into, cannot be written, cannot be put
    back: four different things, said in four different messages. Whoever
    catches this prints it and does not sort it again.
    """


def reason(err):
    """What the exception says. An OSError made from a message has no strerror."""
    return getattr(err, 'strerror', None) or err


def named_by(err, fallback):
    """The name that was turned down, or the one handed over where it is no image.

    The name of the staging directory is whatever this run happened to pick,
    and it is not handed to the reader.
    """
    where = getattr(err, 'filename', None)
    return where if where and where.lower().endswith('.png') else fallback


def state_of(path):
    """What the name held before the replacement: (kind, where a link points).

    exists reads through a link, so a link pointing nowhere looks like nothing
    at all and the rollback goes to remove it. copy2 follows a link too, so
    what lands in the copy is the content it points at, and putting that back
    leaves a plain file. lstat tells the two apart.
    """
    if not os.path.lexists(path):
        return ('absent', None)
    if os.path.islink(path):
        return ('link', os.readlink(path))
    return ('file', None)


# A name that could not be put back, said in the words of what it was before:
# "the previous image" is only true of a name that had one.
LEFT_AS = {
    'file': 'the previous image cannot be put back',
    'link': 'the previous link cannot be put back',
    'absent': "this run's image cannot be taken back out",
}


def clear_away(backup):
    """Take the copy away. Returns what it could not do, or None."""
    try:
        shutil.rmtree(backup)
    except OSError as err:
        return f'{shown(backup)} is left behind ({reason(err)})'
    return None


def replace_all(staging, out_dir):
    """Replace out_dir with everything in staging; one failure puts it all back.

    Returns (the names replaced, what could not be cleared away or None).
    Drawing all six can finish and the replacement still stop partway, since it
    is six moves: what stands there then is some of this run's images beside
    the rest of the previous ones. A copy of what is about to be overwritten is
    taken first, so it can go back.
    """
    names = sorted(os.listdir(staging))
    os.makedirs(out_dir, exist_ok=True)
    backup = tempfile.mkdtemp(dir=out_dir)
    keep = False
    try:
        before = {}
        for name in names:
            here = os.path.join(out_dir, name)
            kind, target = state_of(here)
            before[name] = (kind, target)
            if kind == 'link' and os.path.isdir(here):
                # shutil.move puts the file *inside* a link that points at a
                # directory. An image made in there while the committed name
                # keeps the previous one is not an answer.
                raise Refused(f'{shown(here)}: a link to a directory ({target})')
            if kind == 'file':
                try:
                    shutil.copy2(here, os.path.join(backup, name))
                except OSError as err:
                    # Reading the image and writing the copy are the one call,
                    # so which of the two refused is not known here. Both are
                    # named, and nothing has been moved yet.
                    raise Refused(f'{shown(here)} cannot be copied to '
                                  f'{shown(backup)} ({reason(err)})') from err
            elif kind == 'link':
                # A link goes into the copy as a link. Where putting it back is
                # refused, the only thing holding where it pointed is this
                # run's own before.
                try:
                    os.symlink(target, os.path.join(backup, name))
                except OSError as err:
                    raise Refused(f'{shown(here)} cannot be copied to '
                                  f'{shown(backup)} ({reason(err)})') from err
        # The name is written down before the move is attempted: interrupted
        # right after a move, a list built afterwards leaves that name out of
        # what goes back.
        attempted = []
        left = []
        try:
            for name in names:
                attempted.append(name)
                shutil.move(os.path.join(staging, name), os.path.join(out_dir, name))
        except BaseException as err:
            for name in attempted:
                # Every name is tried to the end. Raising here leaves the names
                # after it holding this run's image, and says nothing about
                # which ones they are.
                kind, target = before[name]
                try:
                    if kind == 'file':
                        shutil.copy2(os.path.join(backup, name), os.path.join(out_dir, name))
                    else:
                        if os.path.lexists(os.path.join(out_dir, name)):
                            os.remove(os.path.join(out_dir, name))
                        if kind == 'link':
                            os.symlink(target, os.path.join(out_dir, name))
                except OSError as sweeping:
                    left.append((name, kind, reason(sweeping)))
            if left:
                # Only a name that had something has anything in the copy. If
                # all that is left are names that had nothing, the copy holds
                # nothing anyone can use.
                keep = any(kind != 'absent' for _, kind, _ in left)
                lines = []
                for name, kind, why in left:
                    # A name that was a link is said with where it pointed: not
                    # everyone can read the copy, and the link in there points
                    # beside the copy rather than beside the image.
                    was = f' -> {before[name][1]}' if kind == 'link' else ''
                    lines.append(f'{name}{was}: {LEFT_AS[kind]} ({why})')
                told = '\n'.join(lines)
                if keep:
                    told += f'\nwhat was there is kept in {shown(backup)}'
                raise Refused(
                    f'replacing {shown(named_by(err, out_dir))} stopped partway'
                    f' ({reason(err)})\n{told}') from err
            raise
    except BaseException:
        # The way out of a refusal. The copy is either named in what was said
        # (keep) or this run's own litter.
        if not keep:
            litter = clear_away(backup)
            if litter is not None:
                print(litter, file=sys.stderr)
        raise
    # What could not be cleared away goes into the caller's answer. Exit 0 says
    # this run left no copy of its own behind, and says nothing about whatever
    # else was already in the committed directory (--check counts .png files
    # only). The copy is named and filled by this run, so one that outlives it
    # has nobody else to report it.
    return names, None if keep else clear_away(backup)


def shown(path):
    """Relative inside the repository, as it stands outside it."""
    try:
        inside = os.path.commonpath([ROOT, os.path.abspath(path)]) == ROOT
    except ValueError:
        # Windows: a path on another drive shares nothing with ROOT, and
        # commonpath raises.
        inside = False
    return os.path.relpath(path, ROOT) if inside else os.path.abspath(path)


def draw_all(target):
    """Draw the six into target."""
    for lang in ('ja', 'en'):
        screenshot_popup(lang, target)
        screenshot_settings(lang, target)
        screenshot_overlay(lang, target)
    return sorted(os.listdir(target))


# All six are drawn in a staging directory before anything moves into the
# committed one. The layout asserts fire on the second image as readily as on
# the first, so drawing straight into the committed directory would leave one
# new image beside five old ones. The staging directory sits next to the
# committed one so that each move is a rename within the one filesystem.
def refused_to_write(named, why):
    """Say it could not be written, and answer whoever is being answered.

    --out was handed its destination, so a refusal there is the answer for
    arguments (2); the committed directory is this run failing to finish (1).
    Which one it is follows what was handed over rather than where the run
    landed — someone who passed the committed directory to --out is still
    reading back the argument they wrote.
    """
    print(why, file=sys.stderr)
    if not named:
        return 1
    print(USAGE, file=sys.stderr)
    return 2


def main(out_dir=OUT_DIR, named=False):
    verify_icons()
    bad = not named and not_a_directory(out_dir)
    if bad:
        # Writing through a link would report the committed directory for bytes
        # that landed outside the tree, so only that destination is asked here
        # (--out has cannot_hold_images looking at what it was handed).
        print(f'{bad[0]}: {bad[1]}', file=sys.stderr)
        print(f'Make {bad[0]} a directory again, then draw them.', file=sys.stderr)
        return 1
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as err:
        # The shape of the path was walked before this. What is left is what the
        # filesystem says, and that is either the argument being wrong (--out)
        # or this run failing to finish (the committed directory).
        return refused_to_write(named, f'{shown(out_dir)} cannot be made ({reason(err)})')
    try:
        with tempfile.TemporaryDirectory(dir=out_dir) as staging:
            try:
                draw_all(staging)
            except OSError as err:
                # What is drawn into is the staging directory inside the
                # destination, so the destination is what gets named. The
                # staging name is not handed to the reader.
                raise Refused(f'{shown(out_dir)} cannot be drawn into ({reason(err)})') from err
            written, litter = replace_all(staging, out_dir)
            for name in written:
                print(f'Generated {os.path.join(shown(out_dir), name)}')
            if litter is not None:
                # The six are written. What kept the run from finishing is that
                # it could not take back what it had left behind.
                raise Refused(litter)
    except Refused as err:
        # What was turned down is said where it was turned down, and is not
        # said again here.
        return refused_to_write(named, str(err))
    except OSError as err:
        # What is left is making the staging directory and removing it. A
        # traceback here would be exit 1, which is the answer for images that
        # differ.
        return refused_to_write(named, f'{shown(out_dir)} cannot be written ({reason(err)})')
    return 0


def is_directory(path):
    """Whether the name itself is a directory. A link counts as a link.

    os.path.isdir reads through a link, which drops a .png pointing at a
    directory out of the listing the way an interrupted run's staging is.
    """
    return stat.S_ISDIR(os.lstat(path).st_mode)


def header_size(kinds):
    """The size IHDR claims, or None where there is no IHDR."""
    for kind, _, first in kinds:
        if kind == 'IHDR':
            return int.from_bytes(first[0:4], 'big'), int.from_bytes(first[4:8], 'big')
    return None


def not_a_directory(path):
    """The first name from ROOT to path that is not a directory, and why.

    lstat answers for the last name in a path only, so swapping docs for a link
    lets everything under it pass whatever is looked at. git records the link
    and nothing below it — the same shape as the committed directory, or its
    parent, having gone.
    """
    at = ROOT
    for part in os.path.relpath(path, ROOT).split(os.sep):
        at = os.path.join(at, part)
        if not os.path.lexists(at):
            # Nothing here is the "none of them are committed" case, which is
            # reported image by image.
            return None
        mode = os.lstat(at).st_mode
        if stat.S_ISLNK(mode):
            return (os.path.relpath(at, ROOT),
                    f'a symbolic link (points at {os.readlink(at)})')
        if not stat.S_ISDIR(mode):
            return os.path.relpath(at, ROOT), 'not a directory'
    return None


def not_a_plain_file(path):
    """Why the committed name is not a file of its own, if it is not.

    Generating writes plain files. os.path.exists, Image.open and open all read
    through a link, so a link holding the same bytes matches down to the
    pixels — while what git records for it is the path it names, not an image.
    """
    mode = os.lstat(path).st_mode
    if stat.S_ISREG(mode):
        return None
    if stat.S_ISLNK(mode):
        return f'a symbolic link (points at {os.readlink(path)})'
    return 'not a file'


def pixel_stream_fault(stream, pending, unpacked, cap, saw_idat, spare_after):
    """Where the scanline stream does not line up with the end of the IDATs."""
    if not saw_idat:
        return None
    if pending or (cap is not None and unpacked >= cap):
        return 'more to unpack after the scanlines'
    if not stream.eof:
        return 'the IDAT stream does not end'
    spare = len(stream.unused_data) + spare_after
    if spare:
        return f'{spare} bytes after the end of the IDAT stream'
    return None


def png_shape(path, expected=None, block=1 << 16):
    """The chunks in order, the unpacked scanline length, and what does not read.

    The chunks come back as (kind, digest of the body, first 16 bytes); IDAT
    carries no body — pixels are compared as pixels, and how they were packed
    is not asked.

    expected is the drawn image's scanline length. Given one, unpacking stops
    there; it is left out only when measuring the image this run just wrote.

    A decoder decides the format from the content and passes over a broken tail
    and a chunk it does not know without a word, so a difference that reaches
    neither the pixels nor the size is left here. How many IDATs there are is
    the compressor's business, so a run of them folds into one entry, and what
    is looked at instead is that their bodies are exactly one zlib stream
    (bytes grow behind a count that has been folded away).

    The file is read block bytes at a time. The CRC, the digests and the
    unpacking all carry on from where they were, so however many bytes the
    committed file holds, what is held here is that one block — the size of
    what is read does not set the size of what is held.
    """
    kinds, unpacked, saw_idat, spare_after = [], 0, False, 0
    stream = zlib.decompressobj()
    cap = None if expected is None else expected + 1
    pending = b''
    with open(path, 'rb') as handle:
        size = os.fstat(handle.fileno()).st_size
        if handle.read(8) != b'\x89PNG\r\n\x1a\n':
            return [], 0, 'not a PNG'
        at = 8
        while True:
            head = handle.read(8)
            if len(head) < 8:
                return kinds, unpacked, 'no IEND'
            length = int.from_bytes(head[:4], 'big')
            raw = head[4:8]
            kind = raw.decode('ascii', 'replace')
            # A type is four letters, and a lowercase third one is the reserved
            # bit, which the spec has given no meaning. Either one reads as a
            # file and is not a PNG.
            if not all(0x41 <= byte <= 0x5a or 0x61 <= byte <= 0x7a for byte in raw):
                return kinds, unpacked, f'a chunk type at byte {at} that is not four letters ({raw!r})'
            if raw[2] & 0x20:
                return kinds, unpacked, f'{kind} has the reserved bit set'
            crc, digest, first = zlib.crc32(raw), hashlib.sha256(), b''
            left = length
            while left:
                piece = handle.read(min(block, left))
                if not piece:
                    return kinds, unpacked, f'{kind} runs past the end of the file'
                left -= len(piece)
                crc = zlib.crc32(piece, crc)
                if kind != 'IDAT':
                    digest.update(piece)
                    first += piece[:16 - len(first)]
                    continue
                saw_idat = True
                if stream.eof:
                    # The stream is over. What follows is counted, not handed
                    # over: zlib would keep appending it to unused_data, and the
                    # size of the committed file would become the size of this
                    # run.
                    spare_after += len(piece)
                    continue
                room = None if cap is None else cap - unpacked
                if room is not None and room <= 0:
                    return kinds, unpacked, 'more to unpack after the scanlines'
                try:
                    out = (stream.decompress(pending + piece) if room is None
                           else stream.decompress(pending + piece, room))
                except zlib.error as err:
                    return kinds, unpacked, f'IDAT does not read as a zlib stream ({err})'
                unpacked += len(out)
                pending = stream.unconsumed_tail
            tail = handle.read(4)
            if len(tail) < 4:
                return kinds, unpacked, f'{kind} runs past the end of the file'
            if crc & 0xffffffff != int.from_bytes(tail, 'big'):
                return kinds, unpacked, f'{kind} does not match its CRC'
            if kind == 'IDAT':
                if kinds[-1:] != [('IDAT', None, b'')]:
                    kinds.append((kind, None, b''))
            else:
                # Everything but the pixels is matched against what was drawn,
                # body and all: IHDR's compression method, say, changes without
                # the decoder saying anything.
                kinds.append((kind, digest.digest(), first))
            at += 12 + length
            if kind == 'IEND':
                if length:
                    return kinds, unpacked, f'IEND is {length} bytes long (the spec gives it none)'
                spare = pixel_stream_fault(stream, pending, unpacked, cap, saw_idat, spare_after)
                if spare:
                    return kinds, unpacked, spare
                trailing = size - at
                return kinds, unpacked, f'{trailing} bytes after IEND' if trailing else None


def check():
    """Compare the six redrawn images with the committed pixels. Writes nothing."""
    here = os.path.relpath(OUT_DIR, ROOT)
    bad = not_a_directory(OUT_DIR)
    if bad:
        # Stop before drawing: with this wrong, whatever the six below pass
        # means nothing.
        print(f'{bad[0]}: {bad[1]}', file=sys.stderr)
        print(f'Make {bad[0]} a directory again, then run '
              f'`python3 {os.path.basename(__file__)}`.', file=sys.stderr)
        return 1
    verify_icons()
    stale = []
    with tempfile.TemporaryDirectory() as fresh:
        drawn = set(draw_all(fresh))
        for name in sorted(drawn):
            tracked = os.path.join(OUT_DIR, name)
            if not os.path.lexists(tracked):
                stale.append(f'{name}: not committed')
                continue
            # lexists, so that a link with nothing at the end of it is named as
            # a link rather than as a name nobody has committed.
            kind = not_a_plain_file(tracked)
            if kind:
                stale.append(f'{name}: {kind}')
                continue
            # RGBA: dropping to RGB would call an image that differs only in its
            # alpha the same one. What this run just drew is opened outside the
            # guard — a failure there is this run's, not the committed file's.
            new = Image.open(os.path.join(fresh, name)).convert('RGBA')
            drawn_kinds, drawn_pixels, drawn_fault = png_shape(os.path.join(fresh, name))
            if drawn_fault:
                raise SystemExit(f'what this run drew for {name} is not a PNG: {drawn_fault}')
            # Everything so far reads the bytes here and hands the committed
            # file to no decoder. Handed over first, the run would end where
            # pillow gives up (the limit on unpacking a text chunk, say), and
            # the images after it and the scan for files nothing draws never
            # happen.
            try:
                kinds, _, fault = png_shape(tracked, drawn_pixels)
            except OSError as err:
                # A file this process cannot open is this image's answer.
                # Stopping on the first one takes the rest of the comparison
                # and the scan for files nothing draws with it.
                stale.append(f'{name}: the file cannot be read ({err})')
                continue
            if fault:
                # A decoder decides the format from the content and passes over
                # a missing IEND and the bytes after it without a word, so
                # neither one reaches the pixels or the size.
                stale.append(f'{name}: {fault}')
                continue
            here_kinds = [kind for kind, _, _ in kinds]
            drawn_only = [kind for kind, _, _ in drawn_kinds]
            if here_kinds != drawn_only:
                # A chunk it does not know, a second IHDR, the chunks that drive
                # an animation: a decoder skips them or hands back the first
                # frame, so the pixels match while the file has more in it. The
                # order to hold to comes from what is drawn.
                stale.append(f'{name}: a different sequence of chunks '
                             f'({" ".join(here_kinds)} / the code draws {" ".join(drawn_only)})')
                continue
            if header_size(kinds) != header_size(drawn_kinds):
                # The size is in IHDR, which is read here rather than asked of a
                # decoder, so a header claiming an enormous size is turned down
                # before anything makes room for it.
                stale.append(f'{name}: a different size '
                             f'({header_size(kinds)} → {header_size(drawn_kinds)})')
                continue
            changed = [kind for (kind, body, _), (_, drawn_body, _) in zip(kinds, drawn_kinds)
                       if body != drawn_body]
            if changed:
                # The same order still leaves the bodies free to differ: pillow
                # reads a rewritten compression method in IHDR without a word,
                # so it reaches neither the pixels nor the size.
                stale.append(f'{name}: the body of {" ".join(changed)} differs from '
                             'what the code draws')
                continue
            try:
                old = Image.open(tracked).convert('RGBA')
            except OSError as err:
                # Past every check above the content can still be broken (a
                # scanline filter, say). Stopping on the first one takes the
                # rest of the comparison and the scan for files nothing draws
                # with it.
                stale.append(f'{name}: cannot be read as an image ({err})')
                continue
            if new.tobytes() != old.tobytes():
                # Pixels as bytes. difference().getbbox() looks at alpha alone
                # once there is an alpha channel, and answers None for a colour
                # that changed under an alpha that did not.
                stale.append(f'{name}: differs from what the code draws now')
    # Only .png files are counted: what is drawn is PNGs, and whatever else is
    # in the directory (a .DS_Store, the staging an interrupted run leaves)
    # is not a committed image.
    try:
        tracked_now = sorted(name for name in os.listdir(OUT_DIR)
                             if name.lower().endswith('.png')
                             and not is_directory(os.path.join(OUT_DIR, name))
                             ) if os.path.isdir(OUT_DIR) else []
    except OSError as err:
        # Which files are there is half of what this run answers, and it is not
        # a difference between images.
        print(f'{here}: cannot be read ({err.strerror})', file=sys.stderr)
        return 1
    # A name that differs only in case is not one nothing draws: on a
    # case-insensitive filesystem it passes the pixel comparison, so what is
    # asked for is a rename rather than a deletion.
    by_spelling = {name.lower(): name for name in drawn}
    present = set(tracked_now)
    orphans, spellings = [], {}
    for name in tracked_now:
        if name in drawn:
            continue
        drawn_as = by_spelling.get(name.lower())
        # With the right spelling beside it, this is not a name to fix but a
        # spare file (a case-sensitive filesystem holds both at once).
        if drawn_as and drawn_as not in present:
            spellings.setdefault(drawn_as, []).append(name)
        else:
            orphans.append(f'{here}/{name}')
    # Where two or more claim one name, which to keep is not something this can
    # know — renaming them in turn drops the second onto the first.
    misspelled = [(names[0], drawn_as) for drawn_as, names in sorted(spellings.items())
                  if len(names) == 1]
    contested = [(sorted(names), drawn_as) for drawn_as, names in sorted(spellings.items())
                 if len(names) > 1]

    for line in stale:
        print(line, file=sys.stderr)
    if stale:
        print(f'Run `python3 {os.path.basename(__file__)}` and commit the result.',
              file=sys.stderr)
    for path in orphans:
        print(f'{path}: drawn by nothing', file=sys.stderr)
    if orphans:
        # Generating touches the six it draws and nothing else, so these have to
        # go by hand.
        print('Delete: ' + ' '.join(orphans), file=sys.stderr)
    for name, drawn_as in misspelled:
        print(f'{here}/{name}: spelled differently (the code draws {drawn_as})',
              file=sys.stderr)
    if misspelled:
        print('Rename: ' + ' '.join(f'{here}/{name} → {drawn_as}'
                                    for name, drawn_as in misspelled), file=sys.stderr)
    for names, drawn_as in contested:
        for name in names:
            print(f'{here}/{name}: one of {len(names)} files claiming the name {drawn_as}',
                  file=sys.stderr)
        print(f'Keep one as {drawn_as} and delete the rest: '
              + ' '.join(f'{here}/{name}' for name in names), file=sys.stderr)
    if stale or orphans or misspelled:
        return 1
    print(f'{len(drawn)} screenshots match the code that draws them.')
    return 0


USAGE = f'usage: {os.path.basename(__file__)} [--check] [--out <dir>]'


def path_parts(rest, sep=os.sep, altsep=os.altsep):
    """The names in a path. Windows separates with / as well (pass splitdrive'd)."""
    if altsep:
        rest = rest.replace(altsep, sep)
    return [part for part in rest.split(sep) if part]


def walk_for_a_place(path):
    """Walk the names as given; the first one that is not a directory, if any."""
    drive, rest = os.path.splitdrive(path)
    at = drive + os.sep
    for part in path_parts(rest):
        at = os.path.join(at, part)
        if not os.path.lexists(at):
            # Everything from here on is created.
            return None
        if not os.path.isdir(at):
            return at
    return None


def where_it_lands(path):
    """Where the kernel arrives, with the last name left as written.

    A link on the way is followed — `link/..` is the parent of what the link
    points into, not the directory the link sits in. The last name is left
    alone so that a link pointing nowhere is not swapped for what it names.
    """
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))


def cannot_hold_images(path):
    """What stands in the way of --out writing there, if anything.

    The names are walked as given: abspath folds `afile/..` away first, and the
    file in the middle never reaches the check. A name that is not there yet is
    created, so the walk stops where the path stops existing. lexists, not
    exists: a link that points nowhere is invisible to the second and reaches
    os.makedirs all the same.

    Where the kernel lands is walked too. A `..` after a name that is not there
    yet walks back onto one that is, as in `missing/../afile`, and walking the
    names alone steps over it. For a path with a link in it the folded text and
    the place it lands are two different places, so the realpath the write goes
    through is the one looked at.
    """
    return walk_for_a_place(path) or walk_for_a_place(where_it_lands(path))


def out_dir_from(args):
    """(where to write, whether --out named it). No --out is docs/screenshots.

    A near miss of an argument does not fall through to a write: `--chek`, meant
    to read only, overwriting the committed images erases on the spot the
    staleness it was called to find.
    """
    target = None
    checking = False
    rest = list(args)
    while rest:
        arg = rest.pop(0)
        if arg == '--check':
            checking = True
            continue
        if arg == '--out':
            # A value that looks like a flag is a missing value, not a
            # directory: `--out --chek` used to create one called --chek.
            if not rest or not rest[0] or rest[0].startswith('-'):
                print(f'--out needs a directory to write into\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            if target is not None:
                # Told twice and taking the second drops the first without
                # saying anything about it.
                print(f'--out takes one destination\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            given = rest.pop(0)
            # The check is applied to the path before it is folded. Where to
            # write can be the folded one — `directory/../ok` is where the
            # kernel lands too.
            blocked = cannot_hold_images(given if os.path.isabs(given)
                                         else os.path.join(os.getcwd(), given))
            # Where to write is where the kernel lands: abspath folds `link/..`
            # by the text and would write beside the link while the check read
            # what it points into.
            target = where_it_lands(given if os.path.isabs(given)
                                    else os.path.join(os.getcwd(), given))
            if blocked:
                # A destination that cannot become a directory is the argument
                # being wrong, not the images differing. Unchecked, the
                # traceback from os.makedirs is exit 1, which is the answer for
                # images that differ.
                print(f'--out has nowhere to write: {blocked} is not a directory\n{USAGE}',
                      file=sys.stderr)
                sys.exit(2)
            continue
        print(f'unknown argument: {arg}\n{USAGE}', file=sys.stderr)
        sys.exit(2)
    if checking and target is not None:
        # --check compares the committed images and writes nothing, so a
        # destination given alongside it would be dropped without saying so.
        print(f'--check compares the committed images and writes nothing, '
              f'so --out has nowhere to go\n{USAGE}', file=sys.stderr)
        sys.exit(2)
    return (OUT_DIR, False) if target is None else (target, True)


if __name__ == '__main__':
    # Every argument is read before the branch, so that a --out handed over
    # alongside --check, and a near miss of one, do not pass through to the
    # drawing.
    destination, was_named = out_dir_from(sys.argv[1:])
    if CANNOT_DRAW is not None:
        print(CANNOT_DRAW, file=sys.stderr)
        sys.exit(UNAVAILABLE)
    if '--check' in sys.argv[1:]:
        sys.exit(check())
    sys.exit(main(destination, was_named))
