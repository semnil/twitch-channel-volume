"""Generate Chrome Web Store screenshot mockups (640x400), ja + en.

PIL 直接描画。popup / settings / overlay の 3 シーンを ja/en で出力する。
配色・UI 文字列は popup.html / options.html / _locales の実値に一致させる。

`--check` は一時ディレクトリへ描き直して追跡中の画像と画素比較し、書き込まない。
差があれば exit 1、この環境では描けない (Pillow / 書体が無い) なら exit 3。
`--out <dir>` は docs/screenshots ではなくそのディレクトリへ書く。知らない引数と
値の無い `--out` は exit 2 で、どちらも何も描かない。
"""
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
    print(f'{err}. Pillow を入れると描ける。', file=sys.stderr)
    sys.exit(UNAVAILABLE)

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
    except OSError:
        print(f'{os.path.relpath(path, ROOT)} が読めない。docs/screenshots/ の画像は'
              'この書体で描いたもので、別の書体で生成すると 6 枚とも差し替わる。',
              file=sys.stderr)
        sys.exit(UNAVAILABLE)


FONT = _font(13)
FONT_SM = _font(11)
FONT_LG = _font(18)
FONT_TITLE = _font(15, bold=True)
FONT_BOLD = _font(13, bold=True)
FONT_VAL = _font(17, bold=True)
FONT_XL = _font(20, bold=True)
FONT_XS = _font(9)
FONT_PRESET = _font(11, bold=True)


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


def replace_all(staging, out_dir):
    """staging の全ファイルで out_dir を置き換える。1 つでも失敗したら元へ戻す。

    描画が最後まで通っても置換は 6 回に分かれるため、途中で止まると新しい
    ものと前回のものが並ぶ。戻せるように、上書きする分を先に控える。
    """
    names = sorted(os.listdir(staging))
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out_dir) as backup:
        saved = [n for n in names if os.path.exists(os.path.join(out_dir, n))]
        for name in saved:
            shutil.copy2(os.path.join(out_dir, name), os.path.join(backup, name))
        # 名前は移動を試みる前に控える。移動し終えた直後に割り込まれると、
        # 後から控える形では戻す対象から漏れる。
        attempted = []
        try:
            for name in names:
                attempted.append(name)
                shutil.move(os.path.join(staging, name), os.path.join(out_dir, name))
        except BaseException:
            for name in attempted:
                if name in saved:
                    shutil.copy2(os.path.join(backup, name), os.path.join(out_dir, name))
                elif os.path.exists(os.path.join(out_dir, name)):
                    os.remove(os.path.join(out_dir, name))
            raise
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
def main(out_dir=OUT_DIR):
    verify_icons()
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out_dir) as staging:
        draw_all(staging)
        for name in replace_all(staging, out_dir):
            print(f'Generated {os.path.join(shown(out_dir), name)}')


def is_directory(path):
    """それ自体がディレクトリか。リンクはリンクとして数える。

    os.path.isdir はリンクの先を見るので、ディレクトリを指す .png リンクが
    「中断した走行の作業ディレクトリ」と同じ扱いで一覧から落ちる。
    """
    return stat.S_ISDIR(os.lstat(path).st_mode)


def header_size(kinds):
    """IHDR が名乗る大きさ。IHDR が無ければ None。"""
    for kind, body in kinds:
        if kind == 'IHDR':
            return int.from_bytes(body[8:12], 'big'), int.from_bytes(body[12:16], 'big')
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


def unpack_pixels(pixels, cap):
    """IDAT が運ぶ zlib ストリームを展開した長さと、通らないところ (無ければ None)。

    デコーダは走査線が揃った時点で読むのをやめるので、その後ろは圧縮の内側でも
    外側でも増やし放題で、画素にも大きさにも出ない。展開は cap バイトで止める
    — 追跡物が言うだけの大きさをこちらが確保する筋合いはない。cap が None の
    ときだけ最後まで展開する (自分が今書いた 1 枚を測るときに使う)。
    """
    if not pixels:
        return 0, None
    packed = b''.join(pixels)
    stream = zlib.decompressobj()
    try:
        unpacked = stream.decompress(packed) if cap is None else stream.decompress(packed, cap)
    except zlib.error as err:
        return 0, f'IDAT が zlib ストリームとして読めない ({err})'
    if stream.unconsumed_tail or (cap is not None and len(unpacked) >= cap):
        return len(unpacked), '走査線の後ろに展開されるものがまだある'
    if not stream.eof:
        return len(unpacked), 'IDAT の zlib ストリームが終わっていない'
    if stream.unused_data:
        return len(unpacked), f'IDAT に zlib ストリームの後ろが {len(stream.unused_data)} バイトある'
    return len(unpacked), None


def png_shape(path, expected=None):
    """PNG のチャンクの並び、展開した走査線の長さ、通らないところ (無ければ None)。

    並びは (型, そのチャンクのバイト列) の列。IDAT だけはバイト列を持たない —
    画素は画素として比べ、圧縮のされ方は問わない。

    expected は「描いた側の走査線の長さ」。渡されたときはそこまでしか展開せず、
    一致も要求する。渡されないのは自分が今書いた 1 枚を測るときだけ。

    デコーダは中身で形式を決め、壊れた末尾も知らないチャンクも黙って許すので、
    画素・大きさ・フレーム数のどれにも出ない違いがここに残る。IDAT の本数は
    圧縮器の刻み方で決まるので 1 つに畳み、代わりに IDAT の中身が zlib
    ストリーム 1 本ちょうどであることを見る (畳んだ本数の裏でバイトが増える)。
    """
    data = open(path, 'rb').read()
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return [], 0, 'PNG ではない'
    kinds, pixels = [], []
    at = 8
    while at + 8 <= len(data):
        length = int.from_bytes(data[at:at + 4], 'big')
        raw = data[at + 4:at + 8]
        kind = raw.decode('ascii', 'replace')
        end = at + 12 + length
        # 型は英字 4 文字で、3 文字目の小文字 (予約ビット 1) は仕様が使い道を
        # 決めていない。どちらも「読めるが PNG ではない」形。
        if not all(0x41 <= byte <= 0x5a or 0x61 <= byte <= 0x7a for byte in raw):
            return kinds, 0, f'{at} バイト目のチャンク型が英字 4 文字ではない ({raw!r})'
        if raw[2] & 0x20:
            return kinds, 0, f'{kind} チャンクの予約ビットが 1'
        if end > len(data):
            return kinds, 0, f'{kind} チャンクがファイルの外へ出ている'
        if zlib.crc32(data[at + 4:end - 4]) & 0xffffffff != int.from_bytes(data[end - 4:end], 'big'):
            return kinds, 0, f'{kind} チャンクの CRC が合わない'
        if kind == 'IDAT':
            pixels.append(data[at + 8:end - 4])
            if kinds[-1:] != [('IDAT', None)]:
                kinds.append((kind, None))
        else:
            # 画素以外は描いた側と 1 バイト単位で突き合わせる。IHDR の
            # 圧縮方式のように、デコーダが読み飛ばしても中身は変わる。
            kinds.append((kind, data[at:end]))
        if kind == 'IEND':
            if length:
                return kinds, 0, f'IEND の長さが {length} (0 のはず)'
            unpacked, spare = unpack_pixels(pixels, None if expected is None else expected + 1)
            if spare:
                return kinds, unpacked, spare
            trailing = len(data) - end
            return kinds, unpacked, f'IEND の後ろに {trailing} バイトある' if trailing else None
        at = end
    return kinds, 0, 'IEND が無い'


def check():
    """描き直した 6 枚と追跡中の画像を画素で比べる。書き込みはしない。"""
    verify_icons()
    stale = []
    with tempfile.TemporaryDirectory() as fresh:
        drawn = set(draw_all(fresh))
        for name in sorted(drawn):
            tracked = os.path.join(OUT_DIR, name)
            if not os.path.exists(tracked):
                stale.append(f'{name}: 追跡されていない')
                continue
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
            kinds, _, fault = png_shape(tracked, drawn_pixels)
            if fault:
                # デコーダは中身で形式を決め、IEND の欠落や後ろのバイトを
                # 黙って許すので、画素にも大きさにも出てこない。
                stale.append(f'{name}: {fault}')
                continue
            here_kinds = [kind for kind, _ in kinds]
            drawn_only = [kind for kind, _ in drawn_kinds]
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
            changed = [kind for (kind, body), (_, drawn_body) in zip(kinds, drawn_kinds)
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
    here = os.path.relpath(OUT_DIR, ROOT)
    # 描くのは png だけなので、それ以外 (.DS_Store, 中断した走行が残す作業
    # ディレクトリ) を追跡物として数えない。
    tracked_now = sorted(name for name in os.listdir(OUT_DIR)
                         if name.lower().endswith('.png')
                         and not is_directory(os.path.join(OUT_DIR, name))
                         ) if os.path.isdir(OUT_DIR) else []
    # 綴りだけ違う名前は「誰も描いていない」ではない。ケース非依存の
    # ファイルシステムでは画素比較を通ってしまうので、消せとは言わずに
    # 名前を直せと言う。
    by_spelling = {name.lower(): name for name in drawn}
    present = set(tracked_now)
    orphans, misspelled = [], []
    for name in tracked_now:
        if name in drawn:
            continue
        drawn_as = by_spelling.get(name.lower())
        # 正しい綴りのファイルが隣にあるなら、これは名前の問題ではなく余りの
        # 1 枚 (ケースを区別する FS では両方が並んで存在しうる)。
        if drawn_as and drawn_as not in present:
            misspelled.append((name, drawn_as))
        else:
            orphans.append(f'{here}/{name}')

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
    if stale or orphans or misspelled:
        return 1
    print(f'{len(drawn)} 枚ともいま描くものと同じ。')
    return 0


USAGE = f'usage: {os.path.basename(__file__)} [--check] [--out <dir>]'


def out_dir_from(args):
    """--out の次の引数。無ければ docs/screenshots。

    綴りを外した引数は書き込みへ落とさない。読むだけのつもりの `--chek` が
    追跡画像の上書きになると、確かめたかった古さがその場で消える。
    """
    target = OUT_DIR
    rest = list(args)
    while rest:
        arg = rest.pop(0)
        if arg == '--check':
            continue
        if arg == '--out':
            if not rest or not rest[0]:
                print(f'--out には書き込み先のディレクトリが要る\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            target = os.path.abspath(rest.pop(0))
            continue
        print(f'知らない引数: {arg}\n{USAGE}', file=sys.stderr)
        sys.exit(2)
    return target


if __name__ == '__main__':
    # 引数は分岐の前に全部見る。--check と一緒に渡された --out や、綴り違いを
    # 描画側へ素通ししないため。
    destination = out_dir_from(sys.argv[1:])
    if '--check' in sys.argv[1:]:
        sys.exit(check())
    main(destination)
