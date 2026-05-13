# Twitch Channel Volume

Chrome extension (MV3) that auto-balances per-channel volume on Twitch using real-time **ITU-R BS.1770 LUFS** measurement of the playing audio. Separate gain is applied during ad breaks.

Twitch does not publish any loudness metadata (no `loudnessDb`-equivalent API, no HLS audio metadata), so the extension measures the playing `<video>` directly via Web Audio API and persists the resulting gain per channel × media kind (Live / VOD / Clip).

## Features

- **Real-time LUFS metering**: Momentary (400 ms), Short-term (3 s), Integrated (BS.1770 gated)
- **Per-channel auto gain**: Save gain per Live / VOD / Clip kind; applied automatically on revisit
- **Ad-break handling**: Detects `EXT-X-DATERANGE CLASS="twitch-stitched-ad"` in HLS manifests and `[data-a-target="video-ad-countdown"]` in the DOM; applies a separate gain offset during ads
- **0–600 % gain range** via Web Audio `GainNode` (HTML5 `video.volume` would cap at 1.0)
- **No external dependencies** — pure JavaScript, no bundler

## How it works

```
<video>
  ├─→ MediaElementSource ─→ GainNode ─→ destination          (playback)
  └─→ MediaElementSource ─→ K-pre ─→ K-RLB ─→ AudioWorklet   (measurement)
                                              │
                                              └─→ port.postMessage
                                                  (per 100 ms mean-square)
```

The measurement path applies the BS.1770-4 K-weighting (high-shelf pre-filter + RLB high-pass), accumulates mean-square in an AudioWorklet, and the main thread aggregates 400 ms momentary, 3 s short-term, and gated integrated LUFS in real time.

## Install (developer mode)

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select this folder

## Usage

1. Open a Twitch stream, VOD, or clip
2. Wait a few seconds for integrated LUFS to stabilize
3. Click the extension icon → **Apply to channel**
4. The computed gain is saved per channel × kind and re-applied on revisit
5. Use the manual slider (0–600 %) for one-off adjustments
6. Ad break gain is configurable in Settings (default −6 dB)

## Settings

- **Target LUFS**: Reference loudness used to compute gain (default −18 LUFS, range −30 to −6)
- **CM Gain**: Extra gain applied during ad breaks (default −6 dB)
- **Display unit**: % or dB
- **Saved channels**: Table view with delete / clear-all

## Development

```sh
# Run tests
node test.js

# Regenerate icons (requires Pillow)
python3 gen_icons.py

# Build Chrome Web Store zip
python3 pack.py
```

## Why not just use a compressor?

A static compressor (like FrankerFaceZ's option) clips loud peaks but does nothing about *median loudness drift* across channels. This extension targets a constant integrated loudness across channels, the way YouTube does for VODs — except Twitch refuses to do it server-side.

## Background

- Twitch does **not** perform loudness normalization on either streams or ads
- Loudness varies wildly between channels (often 20 + dB)
- California SB 576 (enforcement 2026-07-01) may force changes for ads
- Other major platforms normalize: YouTube (-14 LUFS), Spotify (-14 LUFS), Apple Music (-16 LUFS)

## License

MIT
