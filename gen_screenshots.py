"""Generate Chrome Web Store screenshot mockups (640x400), ja + en.

PIL 直接描画。popup / settings / overlay の 3 シーンを ja/en で出力する。
配色・UI 文字列は popup.html / options.html / _locales の実値に一致させる。
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 640, 400

# ── Colors (popup.html / options.html の実値) ───────────────────────
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
DIM2 = (85, 85, 85)       # #555
DIM3 = (68, 68, 68)       # #444
BORDER = (42, 42, 74)     # #2a2a4a
LIVE_RED = (233, 25, 22)  # #e91916
PURPLE = (145, 71, 255)   # #9147ff Twitch / clip badge
SWITCH_ON = (27, 58, 75)  # #1b3a4b


def _font(size, bold=False):
    cands = (
        ['meiryob.ttc', 'C:/Windows/Fonts/meiryob.ttc',
         '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
         '/System/Library/Fonts/Supplemental/Arial Unicode.ttf']
        if bold else
        ['meiryo.ttc', 'C:/Windows/Fonts/meiryo.ttc',
         '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
         '/System/Library/Fonts/Supplemental/Arial Unicode.ttf']
    )
    for c in cands:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default()


FONT = _font(13)
FONT_SM = _font(11)
FONT_LG = _font(18)
FONT_TITLE = _font(15, bold=True)
FONT_BOLD = _font(13, bold=True)
FONT_VAL = _font(17, bold=True)
FONT_XL = _font(20, bold=True)
FONT_XS = _font(9)
FONT_PRESET = _font(11, bold=True)


def rr(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


# ── Localized strings ────────────────────────────────────────────────

STRINGS = {
    'ja': {
        'channel': 'サンプル配信ch.',
        'live': 'LIVE',
        'apply': '63% をチャンネルに適用',
        'manual': 'MANUAL VOLUME',
        'settings': 'SETTINGS',
        'target_label': 'Target LUFS',
        'target_desc': '計測ラウドネスから算出するゲインの基準値',
        'adgain_label': 'CM Gain',
        'adgain_desc': 'CM 区間で適用する追加ゲイン (dB)',
        'unit_label': '表示単位',
        'unit_desc': 'ゲイン値の表示形式',
        'overlay_label': 'ゲイン表示',
        'overlay_desc': 'プレイヤーの音量バー横に適用中のゲインを表示',
        'saved': 'SAVED CHANNELS',
        'col_channel': 'CHANNEL',
        'channels': [
            ('Game Stream TV', '63%', '80%', '—'),
            ('雑談ラジオ', '120%', '—', '95%'),
            ('Music Box', '55%', '70%', '—'),
        ],
        'stream_title': '【雑談】ゲーム配信のあとに少しだけ',
        'viewers': '1,234 人が視聴中',
        'overlay_note': '↑ ゲイン表示',
    },
    'en': {
        'channel': 'Sample Stream',
        'live': 'LIVE',
        'apply': 'Apply 63% to channel',
        'manual': 'MANUAL VOLUME',
        'settings': 'SETTINGS',
        'target_label': 'Target LUFS',
        'target_desc': 'Reference loudness used to compute gain from measurement',
        'adgain_label': 'Ad gain',
        'adgain_desc': 'Extra gain applied during ad breaks (dB)',
        'unit_label': 'Display unit',
        'unit_desc': 'Gain display format',
        'overlay_label': 'Show gain overlay',
        'overlay_desc': 'Display current gain next to the player volume bar',
        'saved': 'SAVED CHANNELS',
        'col_channel': 'CHANNEL',
        'channels': [
            ('Game Stream TV', '63%', '80%', '—'),
            ('Talk Radio', '120%', '—', '95%'),
            ('Music Box', '55%', '70%', '—'),
        ],
        'stream_title': 'Just chatting after the game',
        'viewers': '1,234 watching',
        'overlay_note': '↑ Gain overlay',
    },
}


def screenshot_popup(lang):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), PAGE_BG)
    draw = ImageDraw.Draw(img)

    px, pw = 160, 320
    py, ph = 30, 326
    rr(draw, [px, py, px + pw, py + ph], 10, POPUP_BG)

    # Header
    draw.text((px + 16, py + 12), 'Twitch Channel Volume', fill=TEAL, font=FONT_TITLE)
    draw.text((px + pw - 28, py + 11), '⚙', fill=GRAY, font=FONT_LG)
    draw.line([(px, py + 39), (px + pw, py + 39)], fill=BORDER)

    # Info section
    iy = py + 39
    rr(draw, [px, iy, px + pw, iy + 108], 0, INFO_BG)
    draw.text((px + 16, iy + 12), s['channel'], fill=WHITE, font=FONT_BOLD)
    # LIVE badge
    cl = draw.textlength(s['channel'], font=FONT_BOLD)
    bx = px + 16 + cl + 8
    rr(draw, [bx, iy + 11, bx + 34, iy + 27], 3, LIVE_RED)
    draw.text((bx + 6, iy + 13), s['live'], fill=WHITE, font=FONT_XS)

    # Cards
    cards = [
        ('INTEGRATED', '-14.0', 'LUFS', TEAL),
        ('SUGGESTED', '63', '%', YELLOW),
        ('CURRENT', '63', '%', PINK),
    ]
    cw, gap = 92, 5
    cx = px + 16
    cy = iy + 40
    for label, val, unit, color in cards:
        rr(draw, [cx, cy, cx + cw, cy + 52], 6, CARD_BG)
        draw.text((cx + 9, cy + 8), label, fill=GRAY, font=FONT_XS)
        draw.text((cx + 9, cy + 22), val, fill=color, font=FONT_VAL)
        vw = draw.textlength(val, font=FONT_VAL)
        draw.text((cx + 9 + vw + 2, cy + 28), unit, fill=GRAY, font=FONT_SM)
        cx += cw + gap
    draw.line([(px, iy + 108), (px + pw, iy + 108)], fill=BORDER)

    # Apply button (full width)
    ay = iy + 120
    rr(draw, [px + 16, ay, px + pw - 16, ay + 32], 6, TEAL)
    tw = draw.textlength(s['apply'], font=FONT_BOLD)
    draw.text((px + (pw - tw) / 2, ay + 8), s['apply'], fill=POPUP_BG, font=FONT_BOLD)
    draw.line([(px, ay + 44), (px + pw, ay + 44)], fill=BORDER)

    # Manual volume
    my = ay + 56
    draw.text((px + 16, my), s['manual'], fill=GRAY, font=FONT_SM)
    sy = my + 22
    track_l, track_r = px + 16, px + pw - 58
    draw.rounded_rectangle([track_l, sy + 4, track_r, sy + 10], radius=3, fill=BORDER)
    thumb_x = int(track_l + (track_r - track_l) * 0.63)
    draw.rounded_rectangle([track_l, sy + 4, thumb_x, sy + 10], radius=3, fill=PINK)
    draw.ellipse([thumb_x - 8, sy - 1, thumb_x + 8, sy + 15], fill=PINK, outline=POPUP_BG, width=2)
    draw.text((px + pw - 48, sy - 1), '63%', fill=PINK, font=FONT_BOLD)

    # Presets
    presets = ['0%', '50%', '100%', '200%', '400%', 'MAX']
    bw = (pw - 32 - 5 * 4) / 6
    bx = px + 16
    by = sy + 24
    for p in presets:
        rr(draw, [bx, by, bx + bw, by + 20], 4, BORDER)
        ptw = draw.textlength(p, font=FONT_PRESET)
        draw.text((bx + (bw - ptw) / 2, by + 4), p, fill=(170, 170, 170), font=FONT_PRESET)
        bx += bw + 4

    img.save(f'screenshots/popup_{lang}.png')
    print(f'Generated screenshots/popup_{lang}.png')


def screenshot_settings(lang):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), PAGE_BG)
    draw = ImageDraw.Draw(img)

    draw.text((30, 22), 'Twitch Channel Volume', fill=TEAL, font=FONT_XL)

    # Settings section
    sx, sw = 24, 592
    sy = 50
    sh = 186
    rr(draw, [sx, sy, sx + sw, sy + sh], 10, POPUP_BG)
    draw.text((sx + 20, sy + 14), s['settings'], fill=GRAY, font=FONT_SM)

    def row(y, label, desc, draw_control):
        draw.text((sx + 20, y), label, fill=CC, font=FONT)
        draw.text((sx + 20, y + 18), desc, fill=DIM, font=FONT_SM)
        draw_control(y)

    def slider(y, frac, value, thumb=TEAL):
        tl, tr = sx + sw - 230, sx + sw - 95
        draw.rounded_rectangle([tl, y + 6, tr, y + 10], radius=2, fill=BORDER)
        tx = int(tl + (tr - tl) * frac)
        draw.ellipse([tx - 8, y, tx + 8, y + 16], fill=thumb, outline=POPUP_BG, width=2)
        draw.text((sx + sw - 85, y), value, fill=TEAL, font=FONT_BOLD)

    ry = sy + 36
    # Target LUFS: -30..-6, value -18 -> frac (−18−(−30))/24 = 0.5
    row(ry, s['target_label'], s['target_desc'], lambda y: slider(y, 0.5, '-18 LUFS'))
    draw.line([(sx + 20, ry + 34), (sx + sw - 20, ry + 34)], fill=BORDER)
    ry += 40
    # CM Gain: -24..6, value -6 -> frac (−6−(−24))/30 = 0.6
    row(ry, s['adgain_label'], s['adgain_desc'], lambda y: slider(y, 0.6, '-6 dB'))
    draw.line([(sx + 20, ry + 34), (sx + sw - 20, ry + 34)], fill=BORDER)
    ry += 40

    # Display unit toggle
    def unit_toggle(y):
        gx = sx + sw - 95
        rr(draw, [gx, y - 2, gx + 36, y + 18], 6, TEAL)
        draw.text((gx + 13, y + 1), '%', fill=POPUP_BG, font=FONT_BOLD)
        rr(draw, [gx + 36, y - 2, gx + 72, y + 18], 6, INFO_BG)
        draw.text((gx + 47, y + 1), 'dB', fill=GRAY, font=FONT_BOLD)
    row(ry, s['unit_label'], s['unit_desc'], unit_toggle)
    draw.line([(sx + 20, ry + 34), (sx + sw - 20, ry + 34)], fill=BORDER)
    ry += 40

    # Gain overlay switch (ON)
    def switch_on(y):
        gx = sx + sw - 56
        rr(draw, [gx, y - 1, gx + 36, y + 19], 10, SWITCH_ON)
        draw.ellipse([gx + 19, y + 2, gx + 33, y + 16], fill=TEAL)
    row(ry, s['overlay_label'], s['overlay_desc'], switch_on)

    # Saved Channels section
    cy = sy + sh + 16
    ch = 144
    rr(draw, [sx, cy, sx + sw, cy + ch], 10, POPUP_BG)
    draw.text((sx + 20, cy + 14), s['saved'], fill=GRAY, font=FONT_SM)

    # Header row: CHANNEL | Live | VOD | Clip
    hy = cy + 36
    col_live, col_vod, col_clip = sx + 330, sx + 420, sx + 510
    draw.text((sx + 20, hy), s['col_channel'], fill=DIM, font=FONT_SM)
    for cxh, t in ((col_live, 'LIVE'), (col_vod, 'VOD'), (col_clip, 'CLIP')):
        draw.text((cxh, hy), t, fill=DIM, font=FONT_SM)
    draw.line([(sx + 20, hy + 18), (sx + sw - 20, hy + 18)], fill=BORDER)

    ry = hy + 26
    for name, live, vod, clip in s['channels']:
        draw.text((sx + 20, ry), name, fill=TEAL, font=FONT)
        for cxh, v in ((col_live, live), (col_vod, vod), (col_clip, clip)):
            draw.text((cxh, ry), v, fill=PINK if v != '—' else DIM3, font=FONT_BOLD)
        draw.text((sx + sw - 36, ry - 2), '×', fill=DIM2, font=FONT_LG)
        ry += 30

    img.save(f'screenshots/settings_{lang}.png')
    print(f'Generated screenshots/settings_{lang}.png')


def screenshot_overlay(lang):
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
    draw.text((W - 70, cy - 8), '⚙  ⛶', fill=WHITE, font=FONT)

    img.save(f'screenshots/overlay_{lang}.png')
    print(f'Generated screenshots/overlay_{lang}.png')


def main():
    os.makedirs('screenshots', exist_ok=True)
    for lang in ('ja', 'en'):
        screenshot_popup(lang)
        screenshot_settings(lang)
        screenshot_overlay(lang)


if __name__ == '__main__':
    main()
