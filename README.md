# Twitch Channel Volume

Chrome extension (MV3) that auto-balances per-channel volume on Twitch using real-time **ITU-R BS.1770 LUFS** measurement of the playing audio. Separate gain is applied during ad breaks.

Twitch does not publish any loudness metadata (no `loudnessDb`-equivalent API, no HLS audio metadata), so the extension measures the playing `<video>` directly via Web Audio API and persists the resulting gain per channel × media kind (Live / VOD / Clip).

## Features

- **Real-time LUFS metering**: Momentary (400 ms), Short-term (3 s), Integrated (BS.1770 absolute and relative gates with indexed updates)
- **Per-channel LUFS auto-follow**: Optional Live / VOD / Clip controls continuously follow the measured Integrated LUFS and Target LUFS
- **Measurement reset**: Discards the current media kind's measurement history and restarts it from zero. The stored value tracks the restarted measurement from its first block onward; saved gains are unchanged
- **Per-channel manual gain**: Save gain per Live / VOD / Clip kind; applied automatically on revisit and used while Auto is waiting for measurement
- **Global Auto defaults**: Independent Live / VOD / Clip defaults apply only when a channel kind has neither an explicit Auto choice nor a manual gain
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

The measurement path applies the BS.1770-4 K-weighting (high-shelf pre-filter + RLB high-pass) and accumulates mean-square in an AudioWorklet. The main thread aggregates 400 ms momentary and 3 s short-term LUFS. Integrated LUFS starts from the saved value for the current channel and media kind. A one-hour ring buffer and balanced energy index preserve the absolute and relative two-stage gate while updating each block in logarithmic time instead of rescanning the retained history.

## Install (developer mode)

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select this folder

## Usage

1. Open a Twitch stream, VOD, or clip
2. Click the extension icon and enable **Auto-follow LUFS** for the current kind
3. The gain follows the current Integrated LUFS toward Target LUFS as measurement stabilizes
4. Use **Reset measurement** to discard the current kind's measurement history and restart it from zero
5. Alternatively, leave Auto off and click **Apply to channel** to save the current suggested gain
6. Use the manual slider (0–600 %) while Auto is off
7. Ad break gain is configurable in Settings (default −6 dB)

## Settings

- **Target LUFS**: Reference loudness used to compute gain (default −18 LUFS, range −30 to −6)
- **Auto-follow defaults**: Independent defaults for Live / VOD / Clip (all off by default)
- **CM Gain**: Extra gain applied during ad breaks (default −6 dB)
- **Display unit**: % or dB
- **Saved channels**: Table view showing the last applied Auto gain, with delete / clear-all

## Development

```sh
# Run tests
node test.js

# Check Python syntax without creating Chrome-reserved __pycache__
python3 -B -c "import ast,pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('.').glob('*.py')]"

# Regenerate icons (requires Pillow)
python3 gen_icons.py

# Build Chrome Web Store zip
python3 pack.py
```

Do not run `python3 -m py_compile` in the unpacked extension directory: it creates
`__pycache__`, which Chrome rejects. `node test.js` also checks the complete tree
for reserved underscore-prefixed paths before loading the extension.

## Why not just use a compressor?

A static compressor (like FrankerFaceZ's option) clips loud peaks but does nothing about *median loudness drift* across channels. This extension targets a constant integrated loudness across channels, the way YouTube does for VODs — except Twitch refuses to do it server-side.

## Background

- Twitch does **not** perform loudness normalization on either streams or ads
- Loudness varies wildly between channels (often 20 + dB)
- California SB 576 (enforcement 2026-07-01) may force changes for ads
- Other major platforms normalize: YouTube (-14 LUFS), Spotify (-14 LUFS), Apple Music (-16 LUFS)

## Privacy

- No external network requests; all data stays on your device in `chrome.storage.local`
- Audio/video data itself is never recorded or transmitted — only computed LUFS values and your gain settings are kept
- See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) ([日本語](PRIVACY_POLICY_JA.md)) for details

## License

MIT
