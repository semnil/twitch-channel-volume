"""Generate Chrome Web Store screenshot mockups (640x400), ja + en.

PIL 直接描画。popup / settings / overlay の 3 シーンを ja/en で出力する。
配色・UI 文字列は popup.html / options.html / _locales の実値に一致させる。

`--check` は一時ディレクトリへ描き直し、追跡物をバイトで確かめてから画素比較する。
書き込まない。差があれば exit 1、この環境では描けない (Pillow / 書体が無い) なら exit 3。
`--out <dir>` は docs/screenshots ではなくそのディレクトリへ書く。知らない引数と
値の無い `--out` は exit 2 で、どちらも何も描かない。名指しされた行き先へ書けない
ときも exit 2 (引数なしの追跡先へ書けないときは exit 1)。
"""
import hashlib
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
    # Pillow は raqm があればそちらを選び、入っている環境と入っていない環境で
    # 字の置き方が変わる。追跡中の画像と比べるので、ここで固定する。
    BASIC_LAYOUT = ImageFont.Layout.BASIC
except (AttributeError, ImportError) as err:
    # ここでは終わらせない。引数の間違いは引数の答え (exit 2) を返すべきで、
    # 描けないこと (exit 3) に置き換わってはいけない。
    CANNOT_DRAW = f'{err}. Pillow を入れると描ける。'
else:
    CANNOT_DRAW = None

W, H = 640, 400

ROOT = os.path.dirname(os.path.abspath(__file__))
# 拡張機能には同梱しない資料用の画像なので docs/ 側に置く。実行した
# ディレクトリではなくこのファイルの位置から解決する。
OUT_DIR = os.path.join(ROOT, 'docs', 'screenshots')

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
HINT = (153, 153, 153)    # #999 popup の淡色テキスト
DIM2 = (85, 85, 85)       # #555
DIM3 = (68, 68, 68)       # #444
BORDER = (42, 42, 74)     # #2a2a4a
LIVE_RED = (233, 25, 22)  # #e91916
PURPLE = (145, 71, 255)   # #9147ff Twitch / clip badge
SWITCH_ON = (27, 58, 75)  # #1b3a4b
RESET_BORDER = (50, 119, 129)  # rgba(78, 205, 196, 0.5) on INFO_BG
RESET_BG = (25, 43, 70)        # rgba(78, 205, 196, 0.06) on INFO_BG
RESET_BUTTON_HEIGHT = 36
HEADER_GEAR_RADIUS = 6      # popup ヘッダーの設定アイコン
PLAYER_GEAR_RADIUS = 5      # プレイヤー操作列の設定アイコン
FULLSCREEN_SIZE = 12        # プレイヤー操作列の全画面アイコン


# 追跡している画像はこの 2 書体で描いたもの。別の書体で描くと 6 枚とも
# バイト列が変わるため、候補から選ばずこの 2 つだけを使い、無ければ止める。
# リポジトリに置いてあるので、CI の runner も同じ字形で描ける。
FONT_DIR = os.path.join(ROOT, 'tools', 'fonts')
FONT_REGULAR_FILE = os.path.join(FONT_DIR, 'MPLUS1p-Regular.ttf')
FONT_BOLD_FILE = os.path.join(FONT_DIR, 'MPLUS1p-Bold.ttf')


def _font(size, bold=False):
    path = FONT_BOLD_FILE if bold else FONT_REGULAR_FILE
    try:
        return ImageFont.truetype(path, size, layout_engine=BASIC_LAYOUT)
    except OSError as err:
        # どちらの書体で失敗したかは、投げられたものには入っていない。
        raise OSError(err.errno or 0, str(err), path) from err


# 書体を解決するのは Pillow がある環境だけ。読めない書体も持ち帰るだけにして、
# 引数を読んでから描けないと答える (引数の間違いは exit 2 のまま)。
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
        CANNOT_DRAW = (f'{os.path.relpath(err.filename, ROOT)} が読めない ({err.strerror})。'
                       'docs/screenshots/ の画像はこの書体で描いたもので、別の書体で'
                       '生成すると 6 枚とも差し替わる。')


def draw_gear(draw, center, color, radius=HEADER_GEAR_RADIUS):
    """歯車を描く。PIL の既定フォントに U+2699 のグリフが無く豆腐になるため。"""
    cx, cy = center
    for step in range(8):
        angle = math.pi * step / 4
        inner = (cx + math.cos(angle) * radius, cy + math.sin(angle) * radius)
        outer = (cx + math.cos(angle) * (radius + 3), cy + math.sin(angle) * (radius + 3))
        draw.line([inner, outer], fill=color, width=2)
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], outline=color, width=2)
    draw.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=color)


def draw_fullscreen(draw, center, color, size=FULLSCREEN_SIZE):
    """全画面アイコンを描く。U+26F6 も同じ理由で豆腐になる。"""
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
    """popup.html の SVG (24 単位 viewBox) と同じ形の回転矢印を描く。"""
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

STRINGS = {
    'ja': {
        'channel': 'サンプル配信ch.',
        'live': 'LIVE',
        'apply': 'チャンネルに適用',
        'auto_label': 'LUFS 自動追従',
        'auto_hint': 'この種別は自動追従が\n有効です',
        'manual': 'MANUAL VOLUME',
        'settings': 'SETTINGS',
        'target_label': 'Target LUFS',
        'target_desc': '計測ラウドネスから算出するゲインの基準値',
        'auto_defaults_label': '全チャンネルの LUFS 自動追従',
        'auto_defaults_desc': '個別設定も手動ゲインもない種別の既定値',
        'adgain_label': 'CM Gain',
        'adgain_desc': 'CM 区間で適用する追加ゲイン (dB)',
        'unit_label': '表示単位',
        'unit_desc': 'ゲイン値の表示形式',
        'overlay_label': 'ゲイン表示',
        'overlay_desc': 'プレイヤーの音量バー横に適用中のゲインを表示',
        'saved': 'SAVED CHANNELS',
        'col_channel': 'CHANNEL',
        'channels': [
            ('Game Stream TV', 'Auto (63%)', '80%', '—'),
            ('雑談ラジオ', '120%', '—', 'Auto (95%)'),
            ('Music Box', 'Auto (55%)', '70%', '—'),
        ],
        'stream_title': '【雑談】ゲーム配信のあとに少しだけ',
        'viewers': '1,234 人が視聴中',
        'overlay_note': '↓ ゲイン表示',
    },
    'en': {
        'channel': 'Sample Stream',
        'live': 'LIVE',
        'apply': 'Apply to channel',
        'auto_label': 'Auto-follow LUFS',
        'auto_hint': 'Auto-follow is enabled\nfor this type',
        'manual': 'MANUAL VOLUME',
        'settings': 'SETTINGS',
        'target_label': 'Target LUFS',
        'target_desc': 'Reference loudness used to compute gain from measurement',
        'auto_defaults_label': 'Auto-follow LUFS for all channels',
        'auto_defaults_desc': 'Default for types without an individual setting or manual gain',
        'adgain_label': 'Ad gain',
        'adgain_desc': 'Extra gain applied during ad breaks (dB)',
        'unit_label': 'Display unit',
        'unit_desc': 'Gain display format',
        'overlay_label': 'Show gain overlay',
        'overlay_desc': 'Display current gain next to the player volume bar',
        'saved': 'SAVED CHANNELS',
        'col_channel': 'CHANNEL',
        'channels': [
            ('Game Stream TV', 'Auto (63%)', '80%', '—'),
            ('Talk Radio', '120%', '—', 'Auto (95%)'),
            ('Music Box', 'Auto (55%)', '70%', '—'),
        ],
        'stream_title': 'Just chatting after the game',
        'viewers': '1,234 watching',
        'overlay_note': '↓ Gain overlay',
    },
}


def screenshot_popup(lang, out_dir):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), PAGE_BG)
    draw = ImageDraw.Draw(img)

    px, pw = 160, 320
    py, ph = 20, 368
    rr(draw, [px, py, px + pw, py + ph], 10, POPUP_BG)

    # Header
    draw.text((px + 16, py + 12), 'Twitch Channel Volume', fill=TEAL, font=FONT_TITLE)
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

    draw.text((30, 22), 'Twitch Channel Volume', fill=TEAL, font=FONT_XL)

    # Settings section
    sx, sw = 24, 592
    sy = 43
    sh = 218
    rr(draw, [sx, sy, sx + sw, sy + sh], 10, POPUP_BG)
    draw.text((sx + 20, sy + 14), s['settings'], fill=GRAY, font=FONT_SM)

    def row(y, label, desc, draw_control):
        draw.text((sx + 20, y), label, fill=CC, font=FONT)
        draw.text((sx + 20, y + 18), desc, fill=HINT, font=FONT_SM)
        draw_control(y)

    def slider(y, frac, value, thumb=TEAL):
        tl, tr = sx + sw - 230, sx + sw - 95
        draw.rounded_rectangle([tl, y + 6, tr, y + 10], radius=2, fill=BORDER)
        tx = int(tl + (tr - tl) * frac)
        draw.ellipse([tx - 8, y, tx + 8, y + 16], fill=thumb, outline=POPUP_BG, width=2)
        draw.text((sx + sw - 85, y), value, fill=TEAL, font=FONT_BOLD)

    ry = sy + 31
    # Target LUFS: -30..-6, value -18 -> frac (−18−(−30))/24 = 0.5
    row(ry, s['target_label'], s['target_desc'], lambda y: slider(y, 0.5, '-18 LUFS'))
    draw.line([(sx + 20, ry + 31), (sx + sw - 20, ry + 31)], fill=BORDER)
    ry += 36

    # Auto-follow defaults for Live / VOD / Clip.
    def type_switches(y):
        gx = sx + sw - 245
        states = (('LIVE', True), ('VOD', False), ('CLIP', True))
        for label, enabled in states:
            draw.text((gx, y), label, fill=GRAY, font=FONT_XS)
            track_x = gx + 30
            rr(draw, [track_x, y - 3, track_x + 36, y + 17], 10,
               SWITCH_ON if enabled else BORDER)
            knob_x = track_x + (19 if enabled else 3)
            draw.ellipse([knob_x, y, knob_x + 14, y + 14],
                         fill=TEAL if enabled else GRAY)
            gx += 78
    row(ry, s['auto_defaults_label'], s['auto_defaults_desc'], type_switches)
    draw.line([(sx + 20, ry + 31), (sx + sw - 20, ry + 31)], fill=BORDER)
    ry += 36

    # CM Gain: -24..6, value -6 -> frac (−6−(−24))/30 = 0.6
    row(ry, s['adgain_label'], s['adgain_desc'], lambda y: slider(y, 0.6, '-6 dB'))
    draw.line([(sx + 20, ry + 31), (sx + sw - 20, ry + 31)], fill=BORDER)
    ry += 36

    # Display unit toggle
    def unit_toggle(y):
        gx = sx + sw - 95
        rr(draw, [gx, y - 2, gx + 36, y + 18], 6, TEAL)
        draw.text((gx + 13, y + 1), '%', fill=POPUP_BG, font=FONT_BOLD)
        rr(draw, [gx + 36, y - 2, gx + 72, y + 18], 6, INFO_BG)
        draw.text((gx + 47, y + 1), 'dB', fill=HINT, font=FONT_BOLD)
    row(ry, s['unit_label'], s['unit_desc'], unit_toggle)
    draw.line([(sx + 20, ry + 31), (sx + sw - 20, ry + 31)], fill=BORDER)
    ry += 36

    # Gain overlay switch (ON)
    def switch_on(y):
        gx = sx + sw - 56
        rr(draw, [gx, y - 1, gx + 36, y + 19], 10, SWITCH_ON)
        draw.ellipse([gx + 19, y + 2, gx + 33, y + 16], fill=TEAL)
    row(ry, s['overlay_label'], s['overlay_desc'], switch_on)

    # Saved Channels section
    cy = sy + sh + 9
    ch = 126
    rr(draw, [sx, cy, sx + sw, cy + ch], 10, POPUP_BG)
    draw.text((sx + 20, cy + 14), s['saved'], fill=GRAY, font=FONT_SM)

    # Header row: CHANNEL | Live | VOD | Clip
    hy = cy + 31
    col_live, col_vod, col_clip = sx + 270, sx + 370, sx + 465
    draw.text((sx + 20, hy), s['col_channel'], fill=HINT, font=FONT_SM)
    for cxh, t in ((col_live, 'LIVE'), (col_vod, 'VOD'), (col_clip, 'CLIP')):
        draw.text((cxh, hy), t, fill=HINT, font=FONT_SM)
    draw.line([(sx + 20, hy + 18), (sx + sw - 20, hy + 18)], fill=BORDER)

    ry = hy + 23
    delete_x = sx + sw - 36
    for name, live, vod, clip in s['channels']:
        draw.text((sx + 20, ry), name, fill=TEAL, font=FONT)
        for cxh, v in ((col_live, live), (col_vod, vod), (col_clip, clip)):
            color = TEAL if v.startswith('Auto') else (PINK if v != '—' else HINT)
            draw.text((cxh, ry), v, fill=color, font=FONT_BOLD)
            end = cxh + draw.textlength(v, font=FONT_BOLD)
            limit = delete_x if cxh == col_clip else next(
                c for c in (col_vod, col_clip) if c > cxh)
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
    """描画ヘルパーが実際に線を置いていることを、production と同じ寸法で確かめる。

    ソース文字列だけの検査では本体が空になっても気付けないため、生成の
    たびに小さな canvas へ描いて形の契約を確かめる。座標そのものではなく
    歯・外周円・四隅のアームが在ることだけを見る。寸法は production と同じ
    定数を使う (別の寸法で確かめると、実寸だけ描かれない変更を見逃す)。
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
            # 歯先だけを見る帯。輪はここまで届かない。
            assert ray(px, angle, (radius + 2, radius + 3)), \
                f'draw_gear(radius={radius}): {step} 番目の歯が描かれていない'
            # 歯の間を見る帯。歯は届かないので外周円だけが残る。
            assert ray(px, angle + math.pi / 8, (radius - 1, radius)), \
                f'draw_gear(radius={radius}): 外周円が {step} 番目の歯の隣で欠けている'
        assert px[int(center), int(center)] != bg, \
            f'draw_gear(radius={radius}): 軸が描かれていない'

    img, draw = canvas()
    draw_fullscreen(draw, (center, center), fg, size=FULLSCREEN_SIZE)
    px = img.load()
    half = FULLSCREEN_SIZE // 2
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = int(center + half * sx), int(center + half * sy)
            # 角の共有点を避け、水平と垂直のアームを別々に見る。
            assert any(px[x - k * sx, y] != bg for k in (2, 3)), \
                f'draw_fullscreen: 角 ({sx}, {sy}) の水平アームが描かれていない'
            assert any(px[x, y - k * sy] != bg for k in (2, 3)), \
                f'draw_fullscreen: 角 ({sx}, {sy}) の垂直アームが描かれていない'


class Refused(Exception):
    """ファイルシステムに断られた。何をしようとして断られたかは文面が持つ。

    読めない・描けない・書けない・戻せない、は別のことなので別の文面で言う。
    受け取る側は印字するだけで、分類し直さない。
    """


def reason(err):
    """例外が言っていること。文面だけの OSError には strerror が無い。"""
    return getattr(err, 'strerror', None) or err


def named_by(err, fallback):
    """断られた名前。画像でなければ渡された名前で言う。

    この走行がたまたま選んだ作業用ディレクトリの名前を、読む人へ渡さない。
    """
    where = getattr(err, 'filename', None)
    return where if where and where.lower().endswith('.png') else fallback


def state_of(path):
    """置換前の姿。(種別, リンクの指し先)。

    exists はリンクの先を読むので、行き先の無いリンクが「無い」に見え、戻す側
    はそれを消しに行く。copy2 はリンクを辿るので、控えに入るのは指し先の中身
    で、戻すと通常ファイルになる。どちらも lstat なら分かれる。
    """
    if not os.path.lexists(path):
        return ('absent', None)
    if os.path.islink(path):
        return ('link', os.readlink(path))
    return ('file', None)


# 戻せなかった名前を、それが前は何だったかで言い分ける。「前回の画像」は前に
# 画像があった名前にしか当てはまらない。
LEFT_AS = {
    'file': '前回の画像へ戻せない',
    'link': '前回のリンクへ戻せない',
    'absent': 'この走行の画像を取り除けない',
}


def replace_all(staging, out_dir):
    """staging の全ファイルで out_dir を置き換える。1 つでも失敗したら元へ戻す。

    描画が最後まで通っても置換は 6 回に分かれるため、途中で止まると新しい
    ものと前回のものが並ぶ。戻せるように、上書きする分を先に控える。
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
                # shutil.move はディレクトリを指すリンクの「中へ」置く。指し先
                # の中に画像を作って追跡先は前回のまま、では答えにならない。
                raise Refused(f'{shown(here)}: ディレクトリを指すリンク ({target})')
            if kind == 'file':
                try:
                    shutil.copy2(here, os.path.join(backup, name))
                except OSError as err:
                    # copy2 は読んで書く 1 回の呼び出しなので、どちらの端が断った
                    # かはここでは分からない。両端を名指しする。まだ 1 枚も動か
                    # していない。
                    raise Refused(f'{shown(here)} の控えを {shown(backup)} に'
                                  f'作れない ({reason(err)})') from err
            elif kind == 'link':
                # リンクも控えへリンクとして置く。戻すのを断られると、指し先を
                # 持っているのはこの走行の中の before だけになる。
                try:
                    os.symlink(target, os.path.join(backup, name))
                except OSError as err:
                    raise Refused(f'{shown(here)} の控えを {shown(backup)} に'
                                  f'作れない ({reason(err)})') from err
        # 名前は移動を試みる前に控える。移動し終えた直後に割り込まれると、
        # 後から控える形では戻す対象から漏れる。
        attempted = []
        left = []
        try:
            for name in names:
                attempted.append(name)
                shutil.move(os.path.join(staging, name), os.path.join(out_dir, name))
        except BaseException as err:
            for name in attempted:
                # 1 つ戻せなくても残りは最後まで試す。ここで送出すると、その先
                # の名前が新しいまま残り、しかも何が残ったかを誰も言わない。
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
                # 控えに入っているのは前があった名前だけ。前が無かった名前しか
                # 残らなかったなら、控えには誰の役にも立つものが無い。
                keep = any(kind != 'absent' for _, kind, _ in left)
                lines = []
                for name, kind, why in left:
                    # リンクだった名前は指し先ごと言う。控えを読める人ばかりでは
                    # ないし、読めても指し先は控えの隣を指す形で入っている。
                    was = f' -> {before[name][1]}' if kind == 'link' else ''
                    lines.append(f'{name}{was}: {LEFT_AS[kind]} ({why})')
                told = '\n'.join(lines)
                if keep:
                    told += f'\n控えは {shown(backup)} にある'
                raise Refused(
                    f'{shown(named_by(err, out_dir))} の置き換えが途中で止まった'
                    f' ({reason(err)})\n{told}') from err
            raise
    finally:
        if not keep:
            try:
                shutil.rmtree(backup)
            except OSError as err:
                # 消せなくても走行の答えは変わらない。残ったことだけ言う。
                print(f'{shown(backup)} が残った ({reason(err)})', file=sys.stderr)
    return names


def shown(path):
    """リポジトリの中なら相対、外ならそのまま。"""
    try:
        inside = os.path.commonpath([ROOT, os.path.abspath(path)]) == ROOT
    except ValueError:
        # Windows: ドライブが違うと共通部分が無く ValueError になる。
        inside = False
    return os.path.relpath(path, ROOT) if inside else os.path.abspath(path)


def draw_all(target):
    """6 枚を target へ描く。"""
    for lang in ('ja', 'en'):
        screenshot_popup(lang, target)
        screenshot_settings(lang, target)
        screenshot_overlay(lang, target)
    return sorted(os.listdir(target))


# 全 6 枚を作業ディレクトリで描き切ってから追跡先へ移す。レイアウトの assert は
# 2 枚目以降でも落ちるため、追跡先へ直に書くと新しい 1 枚と古い 5 枚が残る。
# 作業ディレクトリを追跡先の隣に置くのは、移動が同一ファイルシステム内の
# rename になるようにするため。
def refused_to_write(named, why):
    """書けなかったと言って、行き先に応じた終了コードを返す。

    --out は行き先を名指しで渡されているので引数の答え (2)、追跡先はこの走行
    が終われなかったこと (1)。決めるのは名指しされたかどうかで、行き着いた先
    ではない — --out に追跡先を渡した人が読むのも、自分が書いた引数の答え。
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
        # 書いた先を追跡先の名前で報告してしまうため、追跡先へ書くときだけ見る
        # (--out の行き先は cannot_hold_images が引数として見ている)。
        print(f'{bad[0]}: {bad[1]}', file=sys.stderr)
        print(f'{bad[0]} をディレクトリに戻してから描き直す。', file=sys.stderr)
        return 1
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as err:
        # パスの形はここまでで見た。残るのはファイルシステムの答えで、それは
        # 引数の間違い (--out) か、この走行が終われなかったこと (追跡先) か。
        return refused_to_write(named, f'{shown(out_dir)} を作れない ({reason(err)})')
    try:
        with tempfile.TemporaryDirectory(dir=out_dir) as staging:
            try:
                draw_all(staging)
            except OSError as err:
                # 描き先は行き先の中の作業ディレクトリなので、名指しするのは
                # 行き先の側。読む人には作業用の名前を渡さない。
                raise Refused(f'{shown(out_dir)} へ描けない ({reason(err)})') from err
            for name in replace_all(staging, out_dir):
                print(f'Generated {os.path.join(shown(out_dir), name)}')
    except Refused as err:
        # 何をしようとして断られたかは断った側が言う。ここで言い直さない。
        return refused_to_write(named, str(err))
    except OSError as err:
        # 残るのは作業ディレクトリを作る・消すの 2 つ。traceback は exit 1
        # (= 画像に差がある) になってしまう。
        return refused_to_write(named, f'{shown(out_dir)} へ書けない ({reason(err)})')
    return 0


def is_directory(path):
    """それ自体がディレクトリか。リンクはリンクとして数える。

    os.path.isdir はリンクの先を見るので、ディレクトリを指す .png リンクが
    「中断した走行の作業ディレクトリ」と同じ扱いで一覧から落ちる。
    """
    return stat.S_ISDIR(os.lstat(path).st_mode)


def header_size(kinds):
    """IHDR が名乗る大きさ。IHDR が無ければ None。"""
    for kind, _, first in kinds:
        if kind == 'IHDR':
            return int.from_bytes(first[0:4], 'big'), int.from_bytes(first[4:8], 'big')
    return None


def not_a_directory(path):
    """ROOT から path までにディレクトリでない成分があれば (その相対パス, 理由)。

    lstat が答えるのは最後の名前についてだけなので、途中の docs をリンクへ
    差し替えると、その下は何を見ても通る。git はリンクより下を追跡しない —
    追跡先ごと、あるいはその親ごと消えたのと同じ形になる。
    """
    at = ROOT
    for part in os.path.relpath(path, ROOT).split(os.sep):
        at = os.path.join(at, part)
        if not os.path.lexists(at):
            # 無いのは「1 枚も追跡していない」で、画像ごとに報告される。
            return None
        mode = os.lstat(at).st_mode
        if stat.S_ISLNK(mode):
            return (os.path.relpath(at, ROOT),
                    f'シンボリックリンク ({os.readlink(at)} を指している)')
        if not stat.S_ISDIR(mode):
            return os.path.relpath(at, ROOT), 'ディレクトリではない'
    return None


def not_a_plain_file(path):
    """追跡物がファイルそのものでないところ。無ければ None。

    生成は通常ファイルしか書かない。開く側の os.path.exists / Image.open /
    open はどれもリンクの先を読むので、中身が同じリンクは画素まで一致する。
    git が記録するのはリンクの行き先で、画像ではない。
    """
    mode = os.lstat(path).st_mode
    if stat.S_ISREG(mode):
        return None
    if stat.S_ISLNK(mode):
        return f'シンボリックリンク ({os.readlink(path)} を指している)'
    return 'ファイルではない'


def pixel_stream_fault(stream, pending, unpacked, cap, saw_idat, spare_after):
    """走査線の zlib ストリームが、IDAT の終わりと噛み合わないところ。"""
    if not saw_idat:
        return None
    if pending or (cap is not None and unpacked >= cap):
        return '走査線の後ろに展開されるものがまだある'
    if not stream.eof:
        return 'IDAT の zlib ストリームが終わっていない'
    spare = len(stream.unused_data) + spare_after
    if spare:
        return f'IDAT に zlib ストリームの後ろが {spare} バイトある'
    return None


def png_shape(path, expected=None, block=1 << 16):
    """PNG のチャンクの並び、展開した走査線の長さ、通らないところ (無ければ None)。

    並びは (型, 中身のダイジェスト, 先頭 16 バイト) の列。IDAT だけは中身を
    持たない — 画素は画素として比べ、圧縮のされ方は問わない。

    expected は「描いた側の走査線の長さ」。渡されたときはそこまでしか展開しない。
    渡されないのは自分が今書いた 1 枚を測るときだけ。

    デコーダは中身で形式を決め、壊れた末尾も知らないチャンクも黙って許すので、
    画素・大きさのどちらにも出ない違いがここに残る。IDAT の本数は圧縮器の
    刻み方で決まるので 1 つに畳み、代わりに IDAT の中身が zlib ストリーム
    1 本ちょうどであることを見る (畳んだ本数の裏でバイトが増える)。

    ファイルは block バイトずつ読む。CRC もダイジェストも展開も継ぎ足しで
    進むので、追跡物が何バイトあってもこちらが抱えるのはその 1 ブロック分
    — 大きさを追跡物に決めさせない。
    """
    kinds, unpacked, saw_idat, spare_after = [], 0, False, 0
    stream = zlib.decompressobj()
    cap = None if expected is None else expected + 1
    pending = b''
    with open(path, 'rb') as handle:
        size = os.fstat(handle.fileno()).st_size
        if handle.read(8) != b'\x89PNG\r\n\x1a\n':
            return [], 0, 'PNG ではない'
        at = 8
        while True:
            head = handle.read(8)
            if len(head) < 8:
                return kinds, unpacked, 'IEND が無い'
            length = int.from_bytes(head[:4], 'big')
            raw = head[4:8]
            kind = raw.decode('ascii', 'replace')
            # 型は英字 4 文字で、3 文字目の小文字 (予約ビット 1) は仕様が使い道を
            # 決めていない。どちらも「読めるが PNG ではない」形。
            if not all(0x41 <= byte <= 0x5a or 0x61 <= byte <= 0x7a for byte in raw):
                return kinds, unpacked, f'{at} バイト目のチャンク型が英字 4 文字ではない ({raw!r})'
            if raw[2] & 0x20:
                return kinds, unpacked, f'{kind} チャンクの予約ビットが 1'
            crc, digest, first = zlib.crc32(raw), hashlib.sha256(), b''
            left = length
            while left:
                piece = handle.read(min(block, left))
                if not piece:
                    return kinds, unpacked, f'{kind} チャンクがファイルの外へ出ている'
                left -= len(piece)
                crc = zlib.crc32(piece, crc)
                if kind != 'IDAT':
                    digest.update(piece)
                    first += piece[:16 - len(first)]
                    continue
                saw_idat = True
                if stream.eof:
                    # ストリームは終わっている。ここから先は数えるだけで渡さない
                    # — 渡すと zlib が unused_data に継ぎ足し続け、追跡物の
                    # 大きさがそのままこちらのメモリになる。
                    spare_after += len(piece)
                    continue
                room = None if cap is None else cap - unpacked
                if room is not None and room <= 0:
                    return kinds, unpacked, '走査線の後ろに展開されるものがまだある'
                try:
                    out = (stream.decompress(pending + piece) if room is None
                           else stream.decompress(pending + piece, room))
                except zlib.error as err:
                    return kinds, unpacked, f'IDAT が zlib ストリームとして読めない ({err})'
                unpacked += len(out)
                pending = stream.unconsumed_tail
            tail = handle.read(4)
            if len(tail) < 4:
                return kinds, unpacked, f'{kind} チャンクがファイルの外へ出ている'
            if crc & 0xffffffff != int.from_bytes(tail, 'big'):
                return kinds, unpacked, f'{kind} チャンクの CRC が合わない'
            if kind == 'IDAT':
                if kinds[-1:] != [('IDAT', None, b'')]:
                    kinds.append((kind, None, b''))
            else:
                # 画素以外は描いた側と中身ごと突き合わせる。IHDR の圧縮方式の
                # ように、デコーダが読み飛ばしても中身は変わる。
                kinds.append((kind, digest.digest(), first))
            at += 12 + length
            if kind == 'IEND':
                if length:
                    return kinds, unpacked, f'IEND の長さが {length} (0 のはず)'
                spare = pixel_stream_fault(stream, pending, unpacked, cap, saw_idat, spare_after)
                if spare:
                    return kinds, unpacked, spare
                trailing = size - at
                return kinds, unpacked, f'IEND の後ろに {trailing} バイトある' if trailing else None


def check():
    """描き直した 6 枚と追跡中の画像を画素で比べる。書き込みはしない。"""
    here = os.path.relpath(OUT_DIR, ROOT)
    bad = not_a_directory(OUT_DIR)
    if bad:
        # 描く前に止める。ここが違うと、下の 6 枚が何を通ろうと意味が無い。
        print(f'{bad[0]}: {bad[1]}', file=sys.stderr)
        print(f'{bad[0]} をディレクトリに戻してから '
              f'`python3 {os.path.basename(__file__)}` で描き直す。', file=sys.stderr)
        return 1
    verify_icons()
    stale = []
    with tempfile.TemporaryDirectory() as fresh:
        drawn = set(draw_all(fresh))
        for name in sorted(drawn):
            tracked = os.path.join(OUT_DIR, name)
            if not os.path.lexists(tracked):
                stale.append(f'{name}: 追跡されていない')
                continue
            # lexists で見るのは、行き先の無いリンクを「誰も追跡していない名前」
            # ではなくリンクとして名乗らせるため。
            kind = not_a_plain_file(tracked)
            if kind:
                stale.append(f'{name}: {kind}')
                continue
            # RGBA で比べる。RGB へ落とすと、色をそのままに alpha だけ
            # 変えられた画像が「同じ」になる。いま描いた側は guard の外で開く。
            # そこで失敗するのはこの走行の側の失敗で、追跡物の話ではない。
            new = Image.open(os.path.join(fresh, name)).convert('RGBA')
            drawn_kinds, drawn_pixels, drawn_fault = png_shape(os.path.join(fresh, name))
            if drawn_fault:
                raise SystemExit(f'いま描いた {name} が PNG として通らない: {drawn_fault}')
            # ここまでは自分でバイトを読むだけで、追跡物をデコーダに渡さない。
            # 渡してから見ると、Pillow が付き合いきれないと言った時点 (テキスト
            # チャンクの展開上限など) で走行ごと止まり、後ろの画像も orphan の
            # 報告も出ない。
            try:
                kinds, _, fault = png_shape(tracked, drawn_pixels)
            except OSError as err:
                # 読めないものは「いま描くもの」ではない。1 枚で止めると残りの
                # 比較も orphan の報告も出ない。
                stale.append(f'{name}: ファイルを読めない ({err})')
                continue
            if fault:
                # デコーダは中身で形式を決め、IEND の欠落や後ろのバイトを
                # 黙って許すので、画素にも大きさにも出てこない。
                stale.append(f'{name}: {fault}')
                continue
            here_kinds = [kind for kind, _, _ in kinds]
            drawn_only = [kind for kind, _, _ in drawn_kinds]
            if here_kinds != drawn_only:
                # 知らないチャンクも 2 つ目の IHDR も APNG の制御チャンクも
                # デコーダは読み飛ばすか 1 枚目だけ返すので、画素は一致した
                # まま中身が増える。並びは描いた側から採る。
                stale.append(f'{name}: チャンクの並びが違う '
                             f'({" ".join(here_kinds)} / 描くのは {" ".join(drawn_only)})')
                continue
            if header_size(kinds) != header_size(drawn_kinds):
                # 大きさは IHDR に書いてある。デコーダに聞く前に読めるので、
                # 巨大を名乗るヘッダをここで止められる。
                stale.append(f'{name}: 大きさが違う '
                             f'({header_size(kinds)} → {header_size(drawn_kinds)})')
                continue
            changed = [kind for (kind, body, _), (_, drawn_body, _) in zip(kinds, drawn_kinds)
                       if body != drawn_body]
            if changed:
                # 並びが同じでも中身は違いうる。IHDR の圧縮方式を書き換えても
                # Pillow は何も言わずに読むので、画素にも大きさにも出ない。
                stale.append(f'{name}: {" ".join(changed)} チャンクの中身が描くものと違う')
                continue
            try:
                old = Image.open(tracked).convert('RGBA')
            except OSError as err:
                # ここまでを通っても中身は壊れうる (走査線のフィルタ等)。1 枚で
                # 止めると残りの比較も orphan の報告も出ない。
                stale.append(f'{name}: 画像として読めない ({err})')
                continue
            if new.tobytes() != old.tobytes():
                # 画素をそのまま比べる。difference().getbbox() は既定で alpha
                # だけを見るので、色が違っても alpha が同じなら None を返す。
                stale.append(f'{name}: いま描くものと違う')
    # 描くのは png だけなので、それ以外 (.DS_Store, 中断した走行が残す作業
    # ディレクトリ) を追跡物として数えない。
    try:
        tracked_now = sorted(name for name in os.listdir(OUT_DIR)
                             if name.lower().endswith('.png')
                             and not is_directory(os.path.join(OUT_DIR, name))
                             ) if os.path.isdir(OUT_DIR) else []
    except OSError as err:
        # 何が置いてあるかはこの走行の答えの半分で、画像の差ではない。
        print(f'{here}: 読めない ({err.strerror})', file=sys.stderr)
        return 1
    # 綴りだけ違う名前は「誰も描いていない」ではない。ケース非依存の
    # ファイルシステムでは画素比較を通ってしまうので、消せとは言わずに
    # 名前を直せと言う。
    by_spelling = {name.lower(): name for name in drawn}
    present = set(tracked_now)
    orphans, spellings = [], {}
    for name in tracked_now:
        if name in drawn:
            continue
        drawn_as = by_spelling.get(name.lower())
        # 正しい綴りのファイルが隣にあるなら、これは名前の問題ではなく余りの
        # 1 枚 (ケースを区別する FS では両方が並んで存在しうる)。
        if drawn_as and drawn_as not in present:
            spellings.setdefault(drawn_as, []).append(name)
        else:
            orphans.append(f'{here}/{name}')
    # 同じ 1 枚を名乗るものが 2 つ以上あるなら、どれを直すかはこちらでは決まらない
    # — 順に直させると 2 つ目が 1 つ目の上に落ちる。
    misspelled = [(names[0], drawn_as) for drawn_as, names in sorted(spellings.items())
                  if len(names) == 1]
    contested = [(sorted(names), drawn_as) for drawn_as, names in sorted(spellings.items())
                 if len(names) > 1]

    for line in stale:
        print(line, file=sys.stderr)
    if stale:
        print(f'`python3 {os.path.basename(__file__)}` で描き直してコミットする。', file=sys.stderr)
    for path in orphans:
        print(f'{path}: 誰も描いていない', file=sys.stderr)
    if orphans:
        # 生成は自分が描く 6 枚しか触らないので、これは手で消すしかない。
        print('削除する: ' + ' '.join(orphans), file=sys.stderr)
    for name, drawn_as in misspelled:
        print(f'{here}/{name}: 綴りが違う ({drawn_as} として描いている)', file=sys.stderr)
    if misspelled:
        print('名前を直す: ' + ' '.join(f'{here}/{name} → {drawn_as}'
                                    for name, drawn_as in misspelled), file=sys.stderr)
    for names, drawn_as in contested:
        for name in names:
            print(f'{here}/{name}: {drawn_as} を名乗るものが {len(names)} つある', file=sys.stderr)
        print(f'1 つだけ {drawn_as} に直して残りを消す: '
              + ' '.join(f'{here}/{name}' for name in names), file=sys.stderr)
    if stale or orphans or misspelled:
        return 1
    print(f'{len(drawn)} 枚ともいま描くものと同じ。')
    return 0


USAGE = f'usage: {os.path.basename(__file__)} [--check] [--out <dir>]'


def path_parts(rest, sep=os.sep, altsep=os.altsep):
    """パスの成分。Windows は / も区切りに数える (splitdrive 済みを渡す)。"""
    if altsep:
        rest = rest.replace(altsep, sep)
    return [part for part in rest.split(sep) if part]


def walk_for_a_place(path):
    """渡された成分のまま辿り、ディレクトリでない名前があればそれ。"""
    drive, rest = os.path.splitdrive(path)
    at = drive + os.sep
    for part in path_parts(rest):
        at = os.path.join(at, part)
        if not os.path.lexists(at):
            # ここから先は作られる。
            return None
        if not os.path.isdir(at):
            return at
    return None


def where_it_lands(path):
    """OS が行き着く先。終端の名前だけはそのまま残す。

    途中のリンクは辿る (`link/..` はリンクの先の親で、字句で畳んだ隣ではない)。
    終端を辿らないのは、行き先の無いリンクをその指し先へすり替えないため。
    """
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))


def cannot_hold_images(path):
    """--out の行き先になれないところ。無ければ None。

    渡された成分のまま辿る。abspath は `norm-file/..` を先に畳むので、
    途中の非ディレクトリが検査に出てこない。まだ無い名前は作られるので、
    既にあるところまでを見る。lexists で見るのは、行き先の無いリンクが
    exists に映らないまま os.makedirs へ届くため。

    OS が行き着く先も見る。`missing/../afile` のように、まだ無い名前の後ろの
    `..` が既にある名前へ戻ることがあり、辿るだけではそこを跨いでしまう。
    リンクを含むパスは字句で畳んだ先と行き着く先が別なので、書き込みと同じ
    realpath を見る。
    """
    return walk_for_a_place(path) or walk_for_a_place(where_it_lands(path))


def out_dir_from(args):
    """(書き込み先, --out で名指しされたか)。無ければ docs/screenshots。

    綴りを外した引数は書き込みへ落とさない。読むだけのつもりの `--chek` が
    追跡画像の上書きになると、確かめたかった古さがその場で消える。
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
            # フラグの形をした値は値ではない。`--out --chek` は `--chek` と
            # いうディレクトリを作っていた。
            if not rest or not rest[0] or rest[0].startswith('-'):
                print(f'--out には書き込み先のディレクトリが要る\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            if target is not None:
                # 2 つ言われて後ろを採ると、先に名指しされた行き先が診断も
                # 無く消える。
                print(f'--out は 1 つだけ\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            given = rest.pop(0)
            # 検査は畳む前のパスに当てる。書き込み先は畳んだものでよい —
            # `directory/../ok` は OS も同じところへ行き着く。
            blocked = cannot_hold_images(given if os.path.isabs(given)
                                         else os.path.join(os.getcwd(), given))
            # 書き込み先は OS が行き着く先。abspath は `link/..` を字句で畳んで
            # しまい、リンクの隣へ書きながら検査はリンクの先を見ることになる。
            target = where_it_lands(given if os.path.isabs(given)
                                    else os.path.join(os.getcwd(), given))
            if blocked:
                # 行き先がディレクトリになれないのは引数の間違いで、画像の差では
                # ない。ここで見ないと os.makedirs の traceback が exit 1 に
                # なり、「差がある」と同じ答えになる。
                print(f'--out の行き先がディレクトリではない: {blocked}\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            continue
        print(f'知らない引数: {arg}\n{USAGE}', file=sys.stderr)
        sys.exit(2)
    if checking and target is not None:
        # --check は追跡中の画像と比べるだけで書かないので、渡された行き先は
        # 黙って捨てられる。
        print(f'--check は追跡中の画像と比べるだけで書き込まない。--out の行き先が無い\n{USAGE}',
              file=sys.stderr)
        sys.exit(2)
    return (OUT_DIR, False) if target is None else (target, True)


if __name__ == '__main__':
    # 引数は分岐の前に全部見る。--check と一緒に渡された --out や、綴り違いを
    # 描画側へ素通ししないため。
    destination, was_named = out_dir_from(sys.argv[1:])
    if CANNOT_DRAW is not None:
        print(CANNOT_DRAW, file=sys.stderr)
        sys.exit(UNAVAILABLE)
    if '--check' in sys.argv[1:]:
        sys.exit(check())
    sys.exit(main(destination, was_named))
