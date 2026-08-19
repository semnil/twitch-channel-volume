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
├── attach loop (scheduleAttach): video 出現を 1s 間隔でリトライ + DOM detach 検出で再 attach
├── buildMeasurementChain: worklet ロードが attach より遅れた場合は後付けで接続
├── Fetch hook:
│   ├── usher.ttvnw.net / *.m3u8 → EXT-X-DATERANGE をパースし CM 区間検出
│   └── gql.twitch.tv → user.id / video.owner.id / clip.broadcaster.id と
│       リクエスト時点の content kind/id を抽出
├── GainNode は ad active 時に baseline * adGainOffset (dB → gain) を適用
└── postMessage (`__twitch_channel_volume__`) → content.js

content.js (ISOLATED world content script, document_idle)
├── postMessage listener: page-bridge.js から LUFS / owner / manifest-ad を受信
├── URL 分類 (classifyTwitchUrl): live / vod / clip / none
├── Channel resolution:
│   ├── live: URL の login 名 (`login:<name>`) / GraphQL user.id 解決後は数値 ID
│   ├── vod: GraphQL owner.id (`<numeric>`) / fallback `vod-owner:<videoId>`
│   └── clip: GraphQL broadcaster.id / fallback `clip-owner:<slug>`
├── owner 応答を現在の login / videoId / clip slug と照合し、仮 ID の設定を数値 ID へマージ
├── 保存済み gain の自動適用 (Live/VOD/Clip 種別ごとに別管理)
├── LUFS 自動追従: チャンネル × Live/VOD/Clip 別の Auto 設定が ON の間、
│   Integrated LUFS 更新ごとに Target LUFS との差から baseline gain を再計算
├── Gain overlay: `.volume-slider__slider-container` の **次の兄弟** として span を挿入。 mute wrapper と slider container はプレイヤーコントロール内の flex 行に並ぶ sibling 構造のため、 slider container の右隣に span が並ぶ。 表示/非表示は親 `[data-a-target="player-controls"][data-a-visible]` の切り替えに自動追従する (= プレイヤーコントロール内に埋め込んでいるため)。 gain ≠ 1.0 時のみ、表示は `%` 固定 / displayUnit に依存しない
├── DOM ad detection fallback (`[data-a-target="video-ad-countdown"]`)
├── SPA navigation: history.pushState/replaceState hook + popstate + MutationObserver
├── channelVolumes の更新は Service Worker の単一キューへ委譲し、onChanged でクロスタブ同期
├── popup/options からの chrome.tabs.sendMessage を `getState` / `setGain` / `setAutoApplyLoudness` / `resume` / `deleteChannel` で処理
└── Storage
    ├── autoLoudnessSettings: { targetLufs, adGainDb, displayUnit, showGainOverlay,
    │     autoApplyLoudnessLiveDefault, autoApplyLoudnessVodDefault, autoApplyLoudnessClipDefault }
    ├── channelVolumes: { [channelId]: { name, gainLive, gainVod, gainClip,
          autoGainLive, autoGainVod, autoGainClip,
          autoApplyLoudnessLive, autoApplyLoudnessVod, autoApplyLoudnessClip,
          url, lastLufs, lastMeasuredAt, __fieldVersions } }
    ├── channelVolumeAliases: { [loginOrContentProvisionalId]: canonicalOwnerId }
    └── channelVolumeSequence: フィールド更新順序の永続カウンタ

audio-worklet.js (page context, loaded by page-bridge.js)
└── KMeanSquareProcessor: blockSec (default 0.1) ごとに L²+R² 平均を port.postMessage

channel-store.js (service worker helper)
├── channelVolumes の全 read-modify-write を単一キューで直列化
├── gain / Auto / LUFS / delete / clear mutation を検証して適用
├── 仮 ID → 数値 owner ID の alias を永続化し、全 mutation で正準 ID を解決
│   (alias 転送時は仮 ID 側の name / login / url を適用しない)
├── 同じ login の Live 行と数値 owner 行を統合し、URL をチャンネル URL へ正規化
└── フィールド単位の永続更新番号で仮 ID と確定 ID をマージ

settings-store.js (service worker helper)
├── autoLoudnessSettings のフィールド単位 mutation を検証
└── 全 read-modify-write を単一キューで直列化し、設定タブ間の上書きを防止

utils.js (shared, popup/options + page-bridge + content.js + test.js)
├── Constants: SETTINGS_KEY, CHANNEL_VOLUMES_KEY, CHANNEL_ALIASES_KEY,
│              CHANNEL_SEQUENCE_KEY, DEFAULT_TARGET_LUFS, DEFAULT_AD_GAIN_DB,
│              DEFAULT_AUTO_APPLY_LOUDNESS,
│              ABSOLUTE_GATE_LUFS, RELATIVE_GATE_LU, MIN_GAIN, MAX_GAIN
├── Gain utilities: gainToPercent, percentToGain, gainToDb, dbToGain, formatGain, calcGain,
│                  resolveAutoApplySetting, resolvePreferredGain
├── URL classification: classifyTwitchUrl (TWITCH_RESERVED_PATHS 除外)
├── HLS parsing: parseDateRange, isAdDateRange, parseAdRangesFromManifest
├── BS.1770: K_PRE_48K / K_RLB_48K 係数 + redesignBiquad (任意 sample rate 対応)
├── LUFS: meanSquareToLufs, gatedIntegratedLufs (absolute + relative gating)
├── i18n: msg()
└── HTML escape: esc()

popup.html / popup.js
├── Channel name + kind badge (Live/VOD/Clip) + CM 検出 badge
├── 3 カード 1 行グリッド: Integrated LUFS / Suggested gain / Current gain (姉妹拡張と共通レイアウト)
│   ├── Suggested gain は target との差分から算出 (integrated 優先 / short-term フォールバック)
│   ├── Suggested / Current の表示は displayUnit (% / dB) に追従
│   └── 単位 (LUFS / dB / %) は setCardValue で <span class="unit"> に分離して灰色小文字表示
├── 現在視聴中の種別に対するチャンネル別「LUFS 自動追従」トグル
├── Auto 保存失敗時はローカライズ済みエラーを表示して最新状態を再取得
├── Manual slider (slider 自体は 0–600%, 表示値は displayUnit 追従) + 6 プリセット (0/50/100/200/400/MAX)
└── SETTINGS_KEY を初期ロード + storage.onChanged で options の単位切替に即時反応

options.html / options.js
├── Target LUFS スライダー (-30 ~ -6 LUFS, default -18)
├── 全チャンネルの LUFS 自動追従既定値 (Live / VOD / Clip 別、default OFF)
├── CM Gain スライダー (-24 ~ +6 dB, default -6 dB)
├── 表示単位 (% / dB)
├── ゲインオーバーレイ表示 ON/OFF トグル (default ON)
├── Saved Channels テーブル (Live / VOD / Clip 3列、Auto 時は最後に適用した Auto gain、削除可)
├── 初期設定の読込完了まで全設定操作を無効化
└── 各項目だけを Service Worker の設定 mutation で保存し、storage.onChanged で同期
```

## i18n

- `_locales/ja/messages.json` — デフォルト日本語
- `_locales/en/messages.json` — 英語
- manifest の name/description は `__MSG_` 参照
- popup/options の UI 文字列は `data-i18n` 属性 + `chrome.i18n.getMessage`

## User workflow

1. 配信または VOD を開く → ポップアップで現在種別の「LUFS 自動追従」を ON
2. Integrated LUFS の測定値が更新されるたび、Target LUFS に対応するゲインへ自動追従
3. Auto が OFF の種別では「チャンネルに適用」または Manual Volume で従来どおり保存
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
| `background.js` | Service worker (install defaults + channelVolumes / settings 単一ライター) |
| `channel-store.js` | channelVolumes mutation・直列化・仮 ID マージ |
| `settings-store.js` | autoLoudnessSettings のフィールド mutation・直列化 |
| `_locales/` | i18n (ja, en) |
| `icons/` | 16/48/128 px PNG (Twitch purple 3-bar meter) |
| `gen_icons.py` | アイコン生成 (Python Pillow) |
| `gen_screenshots.py` | ストア審査用スクリーンショット生成 (PIL 直接描画, 640×400 ja/en) |
| `pack.py` | Chrome Web Store 用 zip 生成 |
| `PRIVACY_POLICY.md` / `PRIVACY_POLICY_JA.md` | プライバシーポリシー (審査・README リンク用, EN/JA) |
| `test.js` | ユニットテスト (`node test.js`) — utils 全般 |

## Key design decisions

- **自前 LUFS 計測**: Twitch は loudness API を提供しないため、Web Audio API で BS.1770-4 K-weighting + ゲーテッド integrated LUFS を計測。yt-channel-volume の loudnessDb 受動取得と対称な能動計測モデル
- **AudioWorklet (not ScriptProcessor)**: ScriptProcessor は deprecated。100ms 単位の L²+R² 累積を Worklet スレッドで実行し、main thread で window 形成
- **K-weighting フィルタ係数**: BS.1770-4 規格の 48kHz 係数をベースに、AudioContext.sampleRate が 48k 以外の場合は bilinear 逆変換 → 再 bilinear で再設計 (redesignBiquad)
- **Integrated LUFS gating**: 絶対ゲート -70 LUFS + 相対ゲート -10 LU の 2 段ゲーティングを `gatedIntegratedLufs` で実装。CM 区間中は integrated 統計に含めない (本編の代表値が CM で汚染されないため)
- **GainNode, not HTMLMediaElement.volume**: volume は 1.0 でクリップする。GainNode で 0.0–6.0 (0–600%) を提供
- **MAIN world + ISOLATED world 分離**: Twitch の CSP は inline script を禁止するため、AudioContext と fetch hook は page-bridge.js (MAIN world, document_start) で実行
- **Channel ID 戦略**: 
  - Live は owner 応答前のみ URL の login (`login:<name>`) を使用し、GraphQL `user.id` 解決後は VOD / Clip と同じ数値 ID へ統合
  - VOD / Clip は GraphQL レスポンスの `owner.id` / `broadcaster.id` (数値、不変)。フォールバックは `vod-owner:<videoId>` / `clip-owner:<slug>`
  - 数値 ID を取得できない間だけ種別固有の仮 ID を使い、取得後は永続 alias で正準化する
- **仮 ID → 確定 ID 遷移**: page-bridge が GraphQL リクエスト時点の content kind/id を owner イベントへ付与。content.js は現在 URL と一致した応答だけを受理し、`login:<name>` / `vod-owner:<videoId>` / `clip-owner:<slug>` を Service Worker 内で数値 ID へマージしてから currentChannel を切り替える。各 gain / Auto / LUFS フィールドは単一ライターが採番した更新順序で競合解決し、別タブの最新保存も維持する。仮 ID の正準 ID 対応は Storage に永続化し、content の読取と Worker の書込の両方で解決する
- **Saved Channels のチャンネル不変条件**: 数値 owner ID と login が対応する場合は 1 行へ統合し、保存・表示するリンクは常に `https://www.twitch.tv/<login>` とする。既存の Live/VOD 重複行は拡張更新時の正規化 mutation で移行する
- **channelVolumes 単一ライター**: aggregate key の read-modify-write は background.js → channel-store.js のキューだけが実行。content scripts と options は mutation message を送り、複数タブの LUFS キャッシュ保存と Auto/手動設定保存が古い全体オブジェクトで互いを上書きしないようにする
- **設定のフィールド単位保存**: options は初期ロード完了後に操作を有効化し、変更した設定フィールドだけを background.js → settings-store.js の単一キューへ送る。複数の設定タブが異なる項目を古い表示状態から変更しても、`autoLoudnessSettings` 全体を置換せず最新値へマージする
- **CM 区間検出 (HLS 経路)**: usher.ttvnw.net / *.m3u8 を fetch hook で傍受し `EXT-X-DATERANGE CLASS="twitch-stitched-ad"` をパース。Streamlink の Twitch plugin と同等の判定ロジック
- **CM 区間検出 (DOM 経路)**: `[data-a-target="video-ad-countdown"]` の存在で判定するフォールバック。HLS 取得が間に合わない preroll で有効
- **CM 中の挙動**: GainNode に baseline × adGainOffset (dB → gain) を適用。Integrated 計測は CM 中スキップして本編の値を保持
- **createMediaElementSource**: `<video>` に対し 1 回のみ呼び出し可能。他拡張 (FrankerFaceZ Compressor 等) が先に取ると失敗する。失敗した video は `WeakSet` で除外し、他の video にフォールバック。`attach-failed` イベントを post して content 側で診断可能
- **attach のリトライ**: video 要素は document_start 時点では存在しないため、`scheduleAttach()` で 1s 間隔のループ。`clearStaleAttachment()` が DOM から消えた video を検出して再 attach を許可 (Twitch SPA で video が入れ替わるケース対応)。SPA navigation 時にも content.js が `attach` を再送
- **measurement chain の後付け**: `audioWorklet.addModule()` が attach より遅れた場合に備え、`buildMeasurementChain()` を分離。worklet ロード完了時に既に attached なら計測経路を後から接続
- **SPA navigation**: history.pushState/replaceState フック + popstate + MutationObserver の 3 段構え。URL 変更で resetMeasurement + 種別判定再実行 + attach 再送
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

# Python 構文検査 (__pycache__ を生成しない)
python3 -B -c "import ast,pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('.').glob('*.py')]"

# Package for Chrome Web Store
python3 pack.py
```

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- unpacked extension のルートでは `python3 -m py_compile` を実行しない。Chrome が拒否する `__pycache__` を生成するため、Python 構文検査は上記の AST parse を使う。`node test.js` は `_locales` 以外の underscore 始まりのパスも検出する
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy) — content.js sends `resume` on first click capture
- BS.1770 reference is 48 kHz. Chrome の AudioContext は通常 48000 だが、サンプルレート変動には redesignBiquad で対応
- Storage keys: `autoLoudnessSettings` (target LUFS, ad gain, display unit, kind 別 Auto 既定値), `channelVolumes` (per-channel saved gains + kind 別 Auto + lastLufs cache), `channelVolumeAliases` (仮 ID → 正準 ID), `channelVolumeSequence` (永続更新番号)
- Storage format: `channelVolumes.{id}` = `{ name, gainLive, gainVod, gainClip, autoApplyLoudnessLive, autoApplyLoudnessVod, autoApplyLoudnessClip, url, lastLufs: { live, vod, clip }, lastMeasuredAt, __fieldVersions }`
- 旧形式 `{ gain }` 単一ゲインは extractGainForKind で自動マイグレーション
- HLS 経路の CM 検出は Streamlink twitch.py の判定 (`CLASS="twitch-stitched-ad"` または `ID` が `stitched-ad-` で始まる) と同等
- popup は 1 秒毎に getState をポーリングし LUFS / Suggested / Current カードを更新。Manual slider は**通常のポーリングでは更新しない**。初回表示・「チャンネルに適用」・Auto 切替・表示単位変更・ユーザー操作時だけ同期する。計測自体は popup の開閉に依存せず、Twitch ページが開いている限り常時走る
- 拡張機能の再ロードで chrome.runtime が無効化された場合、popup は `reloadPageNeeded` を表示して F5 を促す
- 計測パイプラインの診断: DevTools Console で `[TCV]` ログを確認。`waiting for <video>` → `attached to video` → `measurement chain ready` → `first measurement block received` の順に出る。`createMediaElementSource failed` で止まる場合は他拡張競合 (技術的限界)

## Existing extensions (reference)

| 拡張機能 | 方式 | 永続化 | 備考 |
|---------|------|--------|------|
| Volume Sound Normalizer Pro | DynamicsCompressor + GainNode (LUFS 計測なし) | YT/Twitch channelId | AudioNode 配線の参考 |
| TwitchPerChannelAudio | React internal mediaPlayerInstance.setVolume() | login 名 | React fiber アクセス例 (壊れやすい) |
| FrankerFaceZ Compressor | グローバル DynamicsCompressor | グローバル | per-channel ではない |
| Hearably Twitch Volume Booster | MSE intercept + multiband compressor | タブ単位 | クローズドソース |

本プロジェクトは「Twitch 公式 API に頼らず自前 LUFS 計測 + 種別別永続化 + HLS-DATERANGE ベース CM 検知」を組み合わせ、既存実装が触れていない領域を狙う。
