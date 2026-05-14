# twitch-channel-volume

Twitch チャンネルごとの音量を BS.1770 LUFS リアルタイム計測に基づき自動調整する Chrome 拡張機能 (MV3)。
Twitch には YouTube の `loudnessDb` のような API が存在しないため、再生中の `<video>` 要素を Web Audio API で実測する。
CM 区間は HLS マニフェストの `EXT-X-DATERANGE CLASS="twitch-stitched-ad"` で検出し、本編とは別ゲインを適用する。

## Architecture

```
page-bridge.js (MAIN world content script, document_start)
├── AudioContext / MediaElementSource / GainNode を所有
├── K-weighting IIRFilter (pre-filter high-shelf + RLB high-pass, BS.1770-4)
├── AudioWorklet (k-mean-square) で 100ms ブロックごとの MS を集計
│   ├── Momentary: 直近 4 ブロック (400ms) の MS 平均 → LUFS
│   ├── Short-term: 直近 30 ブロック (3s) の MS 平均 → LUFS
│   └── Integrated: 絶対ゲート (-70 LUFS) + 相対ゲート (-10 LU) の BS.1770 規格
├── Fetch hook:
│   ├── usher.ttvnw.net / *.m3u8 → EXT-X-DATERANGE をパースし CM 区間検出
│   └── gql.twitch.tv → user.id / video.owner.id / clip.broadcaster.id を抽出
├── GainNode は ad active 時に baseline * adGainOffset (dB → gain) を適用
└── postMessage (`__twitch_channel_volume__`) → content.js

content.js (ISOLATED world content script, document_idle)
├── postMessage listener: page-bridge.js から LUFS / owner / manifest-ad を受信
├── URL 分類 (classifyTwitchUrl): live / vod / clip / none
├── Channel resolution:
│   ├── live: URL の login 名 (`login:<name>`)
│   ├── vod: GraphQL owner.id (`<numeric>`) / fallback `vod-owner:<videoId>`
│   └── clip: GraphQL broadcaster.id / fallback `clip-owner:<slug>`
├── 保存済み gain の自動適用 (Live/VOD/Clip 種別ごとに別管理)
├── DOM ad detection fallback (`[data-a-target="video-ad-countdown"]`)
├── SPA navigation: history.pushState/replaceState hook + popstate + MutationObserver
├── chrome.storage.onChanged でクロスタブ同期
├── popup/options からの chrome.tabs.sendMessage を `getState` / `setGain` / `applyMeasured` で処理
└── Storage
    ├── autoLoudnessSettings: { targetLufs, adGainDb, displayUnit, showGainOverlay }
    └── channelVolumes: { [channelId]: { name, gainLive, gainVod, gainClip, url, lastLufs, lastMeasuredAt } }

audio-worklet.js (page context, loaded by page-bridge.js)
└── KMeanSquareProcessor: blockSec (default 0.1) ごとに L²+R² 平均を port.postMessage

utils.js (shared, popup/options + page-bridge + content.js + test.js)
├── Constants: SETTINGS_KEY, CHANNEL_VOLUMES_KEY, DEFAULT_TARGET_LUFS, DEFAULT_AD_GAIN_DB,
│              ABSOLUTE_GATE_LUFS, RELATIVE_GATE_LU, MIN_GAIN, MAX_GAIN
├── Gain utilities: gainToPercent, percentToGain, gainToDb, dbToGain, formatGain, calcGain
├── URL classification: classifyTwitchUrl (TWITCH_RESERVED_PATHS 除外)
├── HLS parsing: parseDateRange, isAdDateRange, parseAdRangesFromManifest
├── BS.1770: K_PRE_48K / K_RLB_48K 係数 + redesignBiquad (任意 sample rate 対応)
├── LUFS: meanSquareToLufs, gatedIntegratedLufs (absolute + relative gating)
├── i18n: msg()
└── HTML escape: esc()

popup.html / popup.js
├── Channel name + kind badge (Live/VOD/Clip)
├── Momentary / Short-term / Integrated LUFS 表示
├── Suggested gain (target との差分から算出, displayUnit に追従)
├── Current gain + manual slider (slider 自体は 0–600%, 表示値は displayUnit 追従)
├── SETTINGS_KEY を初期ロード + storage.onChanged で options の単位切替に即時反応
└── CM 検出中フラグ

options.html / options.js
├── Target LUFS スライダー (-30 ~ -6 LUFS, default -18)
├── CM Gain スライダー (-24 ~ +6 dB, default -6 dB)
├── 表示単位 (% / dB)
├── Saved Channels テーブル (Live / VOD / Clip 3列、削除可)
└── storage.onChanged で同期
```

## i18n

- `_locales/ja/messages.json` — デフォルト日本語
- `_locales/en/messages.json` — 英語
- manifest の name/description は `__MSG_` 参照
- popup/options の UI 文字列は `data-i18n` 属性 + `chrome.i18n.getMessage`

## User workflow

1. 配信または VOD を開く → 数秒〜数十秒で integrated LUFS が安定
2. 「チャンネルに適用」ボタン → 計測 LUFS と target LUFS の差分からゲイン算出・種別ごとに保存
3. 同チャンネルの他コンテンツ (Live ↔ VOD ↔ Clip) を開いても種別ごとの保存値が自動適用
4. CM 区間は CM Gain (default -6 dB) が追加で適用される
5. Manual Volume スライダーで任意のゲインに変更も可

## File overview

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. permissions: storage. host: twitch.tv, ttvnw.net |
| `page-bridge.js` | MAIN world. AudioContext + LUFS + fetch hook (HLS / GraphQL) |
| `audio-worklet.js` | K-weighted MS 累積 (100ms ブロック) |
| `content.js` | ISOLATED world. ゲイン管理、Channel resolution、Storage |
| `utils.js` | 共通定数・ユーティリティ (popup/options/test 共有) |
| `popup.html` / `popup.js` | Popup UI |
| `options.html` / `options.js` | 設定画面 |
| `background.js` | Service worker (install 時にデフォルト設定書き込み) |
| `_locales/` | i18n (ja, en) |
| `icons/` | 16/48/128 px PNG (Twitch purple 3-bar meter) |
| `gen_icons.py` | アイコン生成 (Python Pillow) |
| `pack.py` | Chrome Web Store 用 zip 生成 |
| `test.js` | ユニットテスト (`node test.js`) — utils 全般 |

## Key design decisions

- **自前 LUFS 計測**: Twitch は loudness API を提供しないため、Web Audio API で BS.1770-4 K-weighting + ゲーテッド integrated LUFS を計測。yt-channel-volume の loudnessDb 受動取得と対称な能動計測モデル
- **AudioWorklet (not ScriptProcessor)**: ScriptProcessor は deprecated。100ms 単位の L²+R² 累積を Worklet スレッドで実行し、main thread で window 形成
- **K-weighting フィルタ係数**: BS.1770-4 規格の 48kHz 係数をベースに、AudioContext.sampleRate が 48k 以外の場合は bilinear 逆変換 → 再 bilinear で再設計 (redesignBiquad)
- **Integrated LUFS gating**: 絶対ゲート -70 LUFS + 相対ゲート -10 LU の 2 段ゲーティングを `gatedIntegratedLufs` で実装。CM 区間中は integrated 統計に含めない (本編の代表値が CM で汚染されないため)
- **GainNode, not HTMLMediaElement.volume**: volume は 1.0 でクリップする。GainNode で 0.0–6.0 (0–600%) を提供
- **MAIN world + ISOLATED world 分離**: Twitch の CSP は inline script を禁止するため、AudioContext と fetch hook は page-bridge.js (MAIN world, document_start) で実行
- **Channel ID 戦略**: 
  - Live は URL の login (`login:<name>`)。Twitch login は改名可能だが Helix OAuth 不要で取得できる現実解
  - VOD / Clip は GraphQL レスポンスの `owner.id` / `broadcaster.id` (数値、不変)。フォールバックは `vod-owner:<videoId>` / `clip-owner:<slug>`
  - 将来的に Helix `Get Users` で login → user_id にマイグレーション可能な構造
- **CM 区間検出 (HLS 経路)**: usher.ttvnw.net / *.m3u8 を fetch hook で傍受し `EXT-X-DATERANGE CLASS="twitch-stitched-ad"` をパース。Streamlink の Twitch plugin と同等の判定ロジック
- **CM 区間検出 (DOM 経路)**: `[data-a-target="video-ad-countdown"]` の存在で判定するフォールバック。HLS 取得が間に合わない preroll で有効
- **CM 中の挙動**: GainNode に baseline × adGainOffset (dB → gain) を適用。Integrated 計測は CM 中スキップして本編の値を保持
- **createMediaElementSource**: `<video>` に対し 1 回のみ呼び出し可能。他拡張 (FrankerFaceZ Compressor 等) が先に取ると失敗する。失敗時は警告ログのみ
- **SPA navigation**: history.pushState/replaceState フック + popstate + MutationObserver の 3 段構え。URL 変更で resetMeasurement + 種別判定再実行
- **Live/VOD/Clip 別ゲイン**: 配信は時間帯で音作りが変わるため種別ごとに別管理。同チャンネルの過去 VOD のゲインを現 Live にコピーしない
- **Twitch reserved paths**: `/directory`, `/settings`, `/videos`, `/p`, `/jobs` 等は live channel として誤検出しないよう TWITCH_RESERVED_PATHS で除外
- **CSP 対応**: AudioWorklet モジュールは web_accessible_resources で公開し、content.js が chrome.runtime.getURL で解決して page-bridge に渡す
- **NaN/Infinity ガード**: 計測値が無限大・NaN の場合は gain 1.0 にフォールバック

## Commands

```sh
# Load as unpacked extension
# chrome://extensions → Developer mode → Load unpacked → select this folder

# Regenerate icons
python3 gen_icons.py

# Run tests
node test.js

# Package for Chrome Web Store
python3 pack.py
```

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy) — content.js sends `resume` on first click capture
- BS.1770 reference is 48 kHz. Chrome の AudioContext は通常 48000 だが、サンプルレート変動には redesignBiquad で対応
- Storage keys: `autoLoudnessSettings` (target LUFS, ad gain, display unit), `channelVolumes` (per-channel saved gains + lastLufs cache)
- Storage format: `channelVolumes.{id}` = `{ name, gainLive, gainVod, gainClip, url, lastLufs: { live, vod, clip }, lastMeasuredAt }`
- 旧形式 `{ gain }` 単一ゲインは extractGainForKind で自動マイグレーション
- HLS 経路の CM 検出は Streamlink twitch.py の判定 (`CLASS="twitch-stitched-ad"` または `ID` が `stitched-ad-` で始まる) と同等
- popup は 1 秒毎に getState をポーリングし LUFS 表示を更新
- 拡張機能の再ロードで chrome.runtime が無効化された場合、popup は `reloadPageNeeded` を表示して F5 を促す

## Existing extensions (reference)

| 拡張機能 | 方式 | 永続化 | 備考 |
|---------|------|--------|------|
| Volume Sound Normalizer Pro | DynamicsCompressor + GainNode (LUFS 計測なし) | YT/Twitch channelId | AudioNode 配線の参考 |
| TwitchPerChannelAudio | React internal mediaPlayerInstance.setVolume() | login 名 | React fiber アクセス例 (壊れやすい) |
| FrankerFaceZ Compressor | グローバル DynamicsCompressor | グローバル | per-channel ではない |
| Hearably Twitch Volume Booster | MSE intercept + multiband compressor | タブ単位 | クローズドソース |

本プロジェクトは「Twitch 公式 API に頼らず自前 LUFS 計測 + 種別別永続化 + HLS-DATERANGE ベース CM 検知」を組み合わせ、既存実装が触れていない領域を狙う。
