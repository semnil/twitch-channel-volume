# twitch-channel-volume

Twitch チャンネルごとの音量を BS.1770 LUFS リアルタイム計測に基づき自動調整する Chrome 拡張機能 (MV3)。
Twitch には YouTube の `loudnessDb` のような API が存在しないため、再生中の `<video>` 要素を Web Audio API で実測する。
CM 区間はプレイヤーがページへ post する cue で検出し、cue の来ない media では DOM に現れる CM 表示へ戻る。本編とは別ゲインを適用する。

## Architecture

```
page-bridge.js (MAIN world content script, document_start)
├── AudioContext / MediaElementSource / GainNode を所有
├── K-weighting IIRFilter (pre-filter high-shelf + RLB high-pass, BS.1770-4)
├── AudioWorklet (k-mean-square) で 100ms ブロックごとの MS を集計
│   ├── ブロックは受信時に video.volume の 2 乗で割り、音量 1.0 基準へ揃える
│   ├── Momentary: 直近 4 ブロック (400ms) の MS 平均 → LUFS
│   ├── Short-term: 直近 30 ブロック (3s) の MS 平均 → LUFS
│   └── Integrated: 直近 4 ブロック (400ms) の MS 平均を 100ms ごとに 1 件のゲーティング窓として投入し、保存済みの種別別 LUFS をそれが測られた窓数 (最低 300 窓 = 30 秒、上限 1800 窓 = 3 分) 分の初期サンプルに、1 時間リングバッファ + 平衡木で絶対ゲート (-70 LUFS) と相対ゲート (-10 LU) を O(log n) 更新
│       LUFS と一緒に、その値が立つ窓数 (相対ゲートを通った窓のうち、シードの分はそれが名乗ってきた窓数として数える) を通知する
├── 境界スキップ: CM 終了・音量変更のあと、ゲーティング窓が境界を離れるまでの 4 窓を Integrated から除外
├── CM ゲート: 再生位置が cue の `startTime` 以降 `endTime` 未満の間 Integrated へ積まない。
│   cue を 1 つも受け取っていない間は DOM 指標が立っている間
├── CM 開始ロールバック: cue を受けた時点の経過 (再生位置 − cue の `startTime`) から
│   1 + 経過/0.1 窓を取り消す。cue が無く DOM 指標だけのときは 5 窓
│   (リセット以降に積んだ窓のみ。リングバッファが溢れた後も行う)。
│   取り消す区間に境界スキップで積まなかった窓が入っていれば、その数だけ引く
├── 計測世代 (measurement epoch): resetMeasurement で受け取った番号を保持し、以降の lufs 通知へ付与
├── attach loop (scheduleAttach): video 出現を 1s 間隔でリトライ。DOM から消えた video を
│   検出したら経路を切って自分でループを再開する
├── attach できなかった要素を保持し、ページに残っている間は attached に takenElsewhere を載せる
├── buildMeasurementChain: attach 時に接続する (attach は worklet ロードの結果が出てから走る)
├── Fetch hook (GraphQL のみ):
│   └── gql.twitch.tv → user.id / video.owner.id / clip.broadcaster.id と
│       リクエスト時点の content kind/id を抽出
├── Worker hook: `Worker` を包んで message リスナーを足すだけ。worker はページが
│   渡した引数のまま生成する
│   └── プレイヤーが投げる CM の cue (`rollType` と media 時刻の `startTime` / `endTime`) を読む。
│       受理するのは再生位置がその区間 (開始 1 秒前から終了まで) に入っている cue だけ
│       (CM 中はもう 1 つのプレイヤーが別の時間軸で自分の CM を cue する)
│   └── cue が pod の最後の creative だと言っていない限り (`podPosition` < `podCount` - 1、
│       または値が読めない)、次の cue が届くまで 0.4 秒だけ CM を閉じずに保つ
├── CM 要素: 本編要素が停止したまま別要素が鳴っているとき (VOD の CM で観測) は、その
│   要素にも GainNode を挟み baseline * adGainOffset * (本編 volume / 当該 volume) を適用
├── GainNode は ad active 時に baseline * adGainOffset (dB → gain) を適用
└── postMessage (`__twitch_channel_volume__`) → content.js

content.js (ISOLATED world content script, document_idle)
├── postMessage listener: page-bridge.js から LUFS / owner / CM 状態 / attach 結果を受信
├── attach 結果の保持: attach-failed で audioUnavailable と cause (element-taken /
│   audio-context)、attached は takenElsewhere (他が握る要素がまだページにある) と
│   measuring (計測経路の有無) で audioUnavailable / measurementUnavailable を決める。
│   bridge 再読込時は解除して attach を送り直す
├── audioUnavailable の間は lufs 通知を破棄し (別要素の計測値を保存・Auto 適用しない)、
│   ゲインオーバーレイを外し、手動ゲイン・Auto 設定・測定値リセットの mutation を拒否する。
│   解除された時点で計測を初期化する (bridge の窓に別要素のブロックが残っているため)
├── URL 分類 (classifyTwitchUrl): live / vod / clip / none
├── Channel resolution:
│   ├── live: URL の login 名 (`login:<name>`) / GraphQL user.id 解決後は数値 ID
│   ├── vod: GraphQL owner.id (`<numeric>`) / fallback `vod-owner:<videoId>`
│   └── clip: GraphQL broadcaster.id / fallback `clip-owner:<slug>`
├── owner 応答を現在の login / videoId / clip slug と照合し、仮 ID の設定を数値 ID へマージ
├── 保存済み gain の自動適用 (Live/VOD/Clip 種別ごとに別管理)
├── LUFS 自動追従: チャンネル × Live/VOD/Clip 別の Auto 設定が ON の間、
│   popup の表示周期と同じく 1 秒以上空けて Target LUFS との差から baseline gain を再計算
├── Gain overlay: `.volume-slider__slider-container` の **次の兄弟** として span を挿入。 mute wrapper と slider container はプレイヤーコントロール内の flex 行に並ぶ sibling 構造のため、 slider container の右隣に span が並ぶ。 表示/非表示は親 `[data-a-target="player-controls"][data-a-visible]` の切り替えに自動追従する (= プレイヤーコントロール内に埋め込んでいるため)。 gain ≠ 1.0 かつ音声経路がある間のみ、表示は `%` 固定 / displayUnit に依存しない
├── 保存済み LUFS による計測の初期化は、起動時・SPA 遷移時に加えて owner ID 解決後にも行う。再初期化の要否は alias 解決後のチャンネル ID と種別で判定する。
│   保存済みの窓数 (`lastLufsWindows`) を一緒に渡し、bridge がシードの重みに使う。窓数を持たない保存値 (拡張更新前) は bridge 側の最低値で重み付けする
├── 計測リセットは世代番号を進めて送り、それより古い世代の lufs 通知は破棄する
├── SPA 遷移では `mediaChanged` を先に送り、`requestedAdActive` を落として bridge 側と
│   揃える。**最後に DOM を読んだ時点で出ていた** CM 指標の要素を控え、その要素そのものは
│   新 media の指標として扱わない (別の要素が出たらそれは新 media のもの。要素が DOM を
│   離れたら控えを外す)。遷移を処理した直後に DOM を読み直すため、遷移と同じ batch で
│   入った指標もその場で通知される
│   (計測リセットは同一 media でも起きるため、cue の破棄はこちらだけが行う)
├── DOM ad detection (`[data-a-target="video-ad-countdown"]` / `[data-test-selector="ad-banner-default-text"]`)
│   は cue を 1 つも受け取っていない media でだけ ad gain を駆動する
├── SPA navigation: history.pushState/replaceState hook + popstate + MutationObserver
├── channelVolumes の更新は Service Worker の単一キューへ委譲し、onChanged でクロスタブ同期
├── popup/options からの chrome.tabs.sendMessage を `getState` / `setGain` / `setAutoApplyLoudness` / `resetMeasurement` / `resume` / `deleteChannel` で処理
└── Storage
    ├── autoLoudnessSettings: { targetLufs, adGainDb, displayUnit, showGainOverlay,
    │     autoApplyLoudnessLiveDefault, autoApplyLoudnessVodDefault, autoApplyLoudnessClipDefault }
    ├── channelVolumes: { [channelId]: { name, login, gainLive, gainVod, gainClip,
          autoGainLive, autoGainVod, autoGainClip,
          autoApplyLoudnessLive, autoApplyLoudnessVod, autoApplyLoudnessClip,
          url, lastLufs, lastLufsRef, lastLufsWindows, autoGainRef, lastMeasuredAt, __fieldVersions } }
    ├── channelVolumeAliases: { [loginOrContentProvisionalId]: canonicalOwnerId }
    └── channelVolumeSequence: フィールド更新順序の永続カウンタ

audio-worklet.js (page context, loaded by page-bridge.js)
└── KMeanSquareProcessor: blockSec (default 0.1) ごとに L²+R² 平均を port.postMessage

channel-store.js (service worker helper)
├── channelVolumes の全 read-modify-write を単一キューで直列化
├── gain / Auto / LUFS / delete / clear mutation を検証して適用
├── 測定値リセットは対象種別の lastLufs と、それを説明する lastLufsRef / lastLufsWindows だけを削除し (autoGainRef は残る)、更新番号付きの削除状態として ID 統合後も維持
├── 仮 ID → 数値 owner ID の alias を永続化し、全 mutation で正準 ID を解決
│   (alias 転送時は仮 ID 側の name / login / url を適用しない)
├── 同じ login の Live 行と数値 owner 行を統合し、URL をチャンネル URL へ正規化
└── フィールド単位の永続更新番号で仮 ID と確定 ID をマージ

settings-store.js (service worker helper)
├── autoLoudnessSettings のフィールド単位 mutation を検証
└── 全 read-modify-write を単一キューで直列化し、設定タブ間の上書きを防止

utils.js (shared, popup/options + content.js + test.js。page-bridge.js は MAIN world で読み込まれないため自前の定数を持つ)
├── Constants: SETTINGS_KEY, SETTINGS_MUTATION_MESSAGE, CHANNEL_VOLUMES_KEY, CHANNEL_ALIASES_KEY,
│              CHANNEL_SEQUENCE_KEY, DEFAULT_TARGET_LUFS, DEFAULT_AD_GAIN_DB,
│              DEFAULT_AUTO_APPLY_LOUDNESS, LUFS_REFERENCE_VOLUME_1,
│              ABSOLUTE_GATE_LUFS, RELATIVE_GATE_LU, DISPLAY_UPDATE_INTERVAL_MS,
│              MIN_GAIN, MAX_GAIN
├── Gain utilities: gainToPercent, percentToGain, gainToDb, dbToGain, formatGain, calcGain,
│                  suggestedGain, resolveAutoApplySetting, resolvePreferredGain
├── URL classification: classifyTwitchUrl (TWITCH_RESERVED_PATHS 除外)
├── BS.1770: K_PRE_48K / K_RLB_48K 係数 + redesignBiquad (任意 sample rate 対応)
├── LUFS: meanSquareToLufs, gatedIntegratedLufs (absolute + relative gating)
├── i18n: msg()
└── HTML escape: esc()

popup.html / popup.js
├── Channel name + kind badge (Live/VOD/Clip) + CM 検出 badge
├── チャンネル行のアイコンボタン (36×36) で現在種別の保存済み LUFS と実行中の計測を初期化。ラベルは視覚的に隠して読み上げ名に使い、title で hover 表示する
├── チャンネル名は行幅に合わせて切り詰めるため、全文を title に持たせる
├── 3 カード 1 行グリッド: Integrated LUFS / Suggested gain / Current gain (姉妹拡張と共通レイアウト)
│   ├── Suggested gain は target との差分から算出 (ゲート通過値が無い間は 100%)
│   ├── Suggested / Current の表示は displayUnit (% / dB) に追従
│   └── 単位 (LUFS / dB / %) は setCardValue で <span class="unit"> に分離して灰色小文字表示
├── Auto OFF 時の適用ボタンは Suggested gain を displayUnit で表示し、Auto ON 時は Current と Manual Volume を適用中 gain へ同期
├── Auto ON で Integrated をまだ取れていない間は Fallback バッジを出す
├── 現在視聴中の種別に対するチャンネル別「LUFS 自動追従」トグル
├── Auto 保存失敗時はローカライズ済みエラーを表示して最新状態を再取得
├── Auto 保存中は Apply / Manual 操作を無効化し、content 側でも手動 gain mutation を拒否
├── audioUnavailable / measurementUnavailable の間はチャンネル行の下に理由と対処を出す
│   (文言は cause 別に 3 種: 要素を他に握られた / AudioContext を作れない / 計測経路のみ不可)
│   (チャンネル未解決のページでは出さない)。audioUnavailable では Apply / Manual /
│   Auto トグル / 測定値リセットを無効化し、3 カードを unknown 表示にする。
│   ゲイン保存の失敗表示はこの通知より優先し、ヒント行は空にする
├── Manual slider (slider 自体は 0–600%, 表示値は displayUnit 追従) + 6 プリセット (0/50/100/200/400/MAX)
└── SETTINGS_KEY を初期ロード + storage.onChanged で options の単位切替に即時反応

options.html / options.js
├── Target LUFS スライダー (-30 ~ -6 LUFS, default -18)
├── 全チャンネルの LUFS 自動追従既定値 (Live / VOD / Clip 別、default OFF)
├── CM Gain スライダー (-24 ~ +6 dB, default -6 dB)
├── 表示単位 (% / dB)
├── ゲインオーバーレイ表示 ON/OFF トグル (default ON)
├── Saved Channels テーブル (Live / VOD / Clip 3列、Auto 時は最後に適用した Auto gain、削除可)
├── 初期設定の読込完了まで全設定操作と全削除を無効化
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
3. 「測定値をリセット」は現在種別の保存済み LUFS を削除して実行中の計測をゼロから再開する。再開後の計測値は従来どおり保存される
4. Auto が OFF の種別では「チャンネルに適用」または Manual Volume で従来どおり保存
5. CM 区間は CM Gain (default -6 dB) が追加で適用される
6. Manual Volume スライダーで任意のゲインに変更も可

## File overview

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. permissions: storage. host: twitch.tv |
| `page-bridge.js` | MAIN world. AudioContext + LUFS + fetch hook (GraphQL) + Worker hook (CM の cue) + CM 要素へのゲイン |
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
| `pack.py` | Chrome Web Store 用 zip 生成 (manifest からの参照グラフで選択、`--list` で選択結果のみ出力) |
| `PRIVACY_POLICY.md` / `PRIVACY_POLICY_JA.md` | プライバシーポリシー (審査・README リンク用, EN/JA) |
| `docs/security-audit.md` | セキュリティ監査レポート |
| `test.js` | ユニットテスト (`node test.js`) — utils と store に加え、content.js / page-bridge.js / popup.js / options.js / background.js を VM 上の harness で走らせる |

## Key design decisions

- **自前 LUFS 計測**: Twitch は loudness API を提供しないため、Web Audio API で BS.1770-4 K-weighting + ゲーテッド integrated LUFS を計測。yt-channel-volume の loudnessDb 受動取得と対称な能動計測モデル
- **AudioWorklet (not ScriptProcessor)**: ScriptProcessor は deprecated。100ms 単位の L²+R² 累積を Worklet スレッドで実行し、main thread で window 形成
- **K-weighting フィルタ係数**: BS.1770-4 規格の 48kHz 係数をベースに、AudioContext.sampleRate が 48k 以外の場合は bilinear 逆変換 → 再 bilinear で再設計 (redesignBiquad)
- **Integrated LUFS の索引更新**: 現在のチャンネルと種別に保存された LUFS を、その値が立つ窓数分 (下限・上限は「計測のセッション跨ぎ」) の初期サンプルとして復元する。直近 1 時間のブロックをリングバッファに保持し、絶対ゲート通過値を部分木の合計・件数付き平衡木へ格納する。絶対ゲート後の平均から相対ゲート -10 LU を毎回求め、しきい値以上の合計・件数を O(log n) で取得するため、入力順序に依存せず二段ゲートを維持する。CM 区間中は Integrated 統計に含めない (本編の代表値が CM で汚染されないため)
- **計測のセッション跨ぎ**: 保存済み LUFS は、それが立つ窓数 (`lastLufsWindows`) と一緒に保存し、次の計測はその件数分の窓としてシードする。1 窓としてシードすると新しい音声が毎秒 10 窓入って 1 秒で押し流し、Auto が本編 0.4 秒ぶんの Integrated からゲインを決めることになる。窓数の下限は 300 窓 (30 秒)、上限は 1800 窓 (3 分)。上限をリングバッファと同じ 1 時間に置くと、シードは同一値の点質量なので相対ゲートがその値に固定され、配信側が本当にレベルを下げたときに 20 分以上 Integrated が動かない。3 分なら同じ長さの視聴でシードと同じ重みに達する。窓数を持たない保存値 (拡張更新前) と読めない窓数は下限で重み付けする。報告する窓数は相対ゲートを通った窓だけを数え、シードの分はそれが名乗ってきた窓数で置き換える。下限の嵩上げ分を測ったことにせず、ゲートが外した窓と、リングバッファが追い出した窓も数えないため。どの窓がシードのものかは水準ではなくゲーティング窓の連番で判別する (索引は水準をキーにするので、シードと同じ水準の音声はシードと同じ節点に入る)
- **GainNode, not HTMLMediaElement.volume**: volume は 1.0 でクリップする。GainNode で 0.0–6.0 (0–600%) を提供
- **MAIN world + ISOLATED world 分離**: Twitch の CSP は inline script を禁止するため、AudioContext と fetch hook は page-bridge.js (MAIN world, document_start) で実行
- **Channel ID 戦略**: 
  - Live は owner 応答前のみ URL の login (`login:<name>`) を使用し、GraphQL `user.id` 解決後は VOD / Clip と同じ数値 ID へ統合
  - VOD / Clip は GraphQL レスポンスの `owner.id` / `broadcaster.id` (数値、不変)。フォールバックは `vod-owner:<videoId>` / `clip-owner:<slug>`
  - 数値 ID を取得できない間だけ種別固有の仮 ID を使い、取得後は永続 alias で正準化する
- **仮 ID → 確定 ID 遷移**: page-bridge が GraphQL リクエスト時点の content kind/id を owner イベントへ付与。content.js は現在 URL と一致した応答だけを受理し、初期設定の読込中でも `login:<name>` / `vod-owner:<videoId>` / `clip-owner:<slug>` を Service Worker 内で数値 ID へマージしてから currentChannel を切り替える。各 gain / Auto / LUFS フィールドは単一ライターが採番した更新順序で競合解決し、別タブの最新保存も維持する。仮 ID の正準 ID 対応は Storage に永続化し、content の読取と Worker の書込の両方で解決する
- **Saved Channels のチャンネル不変条件**: 数値 owner ID と login が対応する場合は 1 行へ統合し、保存・表示するリンクは常に `https://www.twitch.tv/<login>` とする。既存の Live/VOD 重複行は拡張更新時の正規化 mutation で移行する
- **channelVolumes 単一ライター**: aggregate key の read-modify-write は background.js → channel-store.js のキューだけが実行。content scripts と options は mutation message を送り、複数タブの LUFS キャッシュ保存と Auto/手動設定保存が古い全体オブジェクトで互いを上書きしないようにする
- **設定のフィールド単位保存**: options は初期ロード完了後に操作を有効化し、変更した設定フィールドだけを background.js → settings-store.js の単一キューへ送る。複数の設定タブが異なる項目を古い表示状態から変更しても、`autoLoudnessSettings` 全体を置換せず最新値へマージする
- **保存済みの値を反映してから画面を出す**: popup / options は `body.initializing` で読み込み中の画面を隠し、i18n の適用と保存済み設定の描画が終わってから外す (options は読込が失敗しても外す — 出ない画面は操作もできない)。初期化中はトグルスイッチと単位切替の遷移を無効にする。遷移は値を書いた時点で走り始めるので、残りが画面上で動いて「表示してから更新された」ように見える。読込が失敗した画面は読めなかったもの (保存済み設定) を名乗り、チャンネル一覧については何も答えない — 「保存済みチャンネルなし」はチャンネルを数えた描画まで出さず、全削除は無効のまま
- **CM 区間検出**: 独立した 2 つの指標を使う
  - プレイヤーの cue: メディアエンジンは worker で動き、再生する CM ごとに cue をページへ post する。`Worker` コンストラクタを包んで message リスナーを足し、`rollType` と `startTime` / `endTime` を持つ cue を読む。この 2 つは attach している要素の media 時刻で、CM の終わりと一致する。CM 中はプレイヤーがもう 1 つ動いて自分の CM を別の時間軸で cue するため、再生位置がその区間に入っている cue だけを受け取る。**受理の範囲と CM 判定は別**で、受理は開始 1 秒前から、CM 中の判定は開始以降 — 早く届いた cue が本編に CM Gain を掛けない。CM を通り過ぎたら区間を捨てるので、再生位置が戻っても同じ CM は開かない
  - cue の保持期間: cue は media と要素に属する。計測リセット (popup の操作や owner ID 確定でも走る) では捨てず、次の 2 つでだけ捨てる。**どちらも「その事象が無効にするものを全部」捨てる** — 片側だけ消すと、cue も DOM 指標も効かない状態や、前の media の指標が新しい media の CM として残る状態になる
    - 要素の差し替え: cue の時刻と「この media は cue されるか」(`adCueSeen`) の両方
    - `mediaChanged` (SPA 遷移): 上に加えて DOM 指標の状態。content.js 側も `requestedAdActive` を落として bridge と揃え、さらに **遷移の時点で出ている CM 指標の要素を控え、その要素そのものは新 media の指標として扱わない**。遷移の瞬間はまだ旧プレイヤーがページにあり、その間に別の DOM 変化が起きると observer が旧指標を新 media の CM として報告してしまうため。真偽値ではなく要素で持つのは、MutationObserver が旧要素の除去と新要素の追加を 1 回の callback にまとめることがあり、その場合「指標が消えた瞬間」を観測できないため。控えた要素が DOM を離れたら外す (同じ要素が置き直されたら新 media のものとして受け取る)
      控えるのは **最後に DOM を読んだ時点で出ていた要素** で、遷移の時点でページを読み直さない。読み直す実装は「いつ読むか」がページ側の処理順と競合する (同じタスクでプレイヤーが差し替わる・ページ側の popstate リスナーが先に動く・同一 URL の History 呼び出しが混ざる) ため、読む時点を持たない形にしてある。DOM を読むのは常に遷移の処理より前なので、そこに出ていた指標は旧 media のものになる。これを成り立たせる要素が 3 つある:
      - `pushState` / `replaceState` のフックは URL を動かす前に DOM を読み直す (まだ観測されていない指標が旧 media のものとして控えられる)
      - 遷移を見る MutationObserver を CM 指標の observer より先に登録する (遷移を運ぶ batch は、新 media に対して読まれる)
      - 遷移の処理の最後に DOM を読み直す (遷移と同じ batch で入った指標が、次の DOM 変化を待たずに通知される)
  - pod の途切れ: 1 回の CM に複数の creative が入ると、前の creative の終わりと次の cue の間に再生位置が進む。cue が pod の最後の creative だと言っている (`podPosition` >= `podCount` - 1) ときだけ終わりで閉じ、それ以外 (途中を示す、または値が読めない) は次の cue を 0.4 秒だけ待つ。来なければそこで閉じる
  - DOM: `[data-a-target="video-ad-countdown"]` / `[data-test-selector="ad-banner-default-text"]` の有無
- **2 つの指標の使い分け**: cue は CM の最初の音声とほぼ同時に届き、CM の終わりも正確に示す。DOM 指標は CM の最初の音声より遅れて現れ、CM 後も DOM に残ることがある。したがって cue を 1 つでも受け取った media では cue だけで開閉し、cue の来ない media (VOD のクライアント側挿入の CM) では DOM 指標へ戻る
- **CM 要素**: VOD の CM は本編要素を停止させたまま別の `<video>` で再生され、その要素は本編要素の volume を無視して自前の volume で鳴る。本編要素が停止していて別の要素が鳴っているときは、その要素にも `MediaElementSource` + `GainNode` を挟み、`baseline * adGainOffset * (本編 volume / 当該要素の volume)` を掛ける。CM が終わればゲインを 1.0 へ戻し、要素が DOM から消えたら切り離す。計測はこの要素からは採らない
- **CM 中の挙動**: GainNode に baseline × adGainOffset (dB → gain) を適用。Integrated 計測は CM 中スキップして本編の値を保持。CM 終了時点のブロックは CM 音声を含みうるため、CM 明けはゲーティング窓が CM を離れるまでの 4 窓も Integrated から除外する。CM 開始側は DOM マーカーが CM の最初の音声より遅れて現れるため、検出時点で直近 5 窓 (0.5 秒) を取り消す。取り消す区間に境界スキップで既に除外した窓が入っていれば、その数だけ取り消す数から引く — 積んでいない窓は取り消せず、要求した数をそのまま渡すと代わりに本編の窓が消える。取り消す窓数は観測できたマーカーの遅れに合わせる — 本編の窓まで消すと、その水準がゲートの母集団から抜けて Integrated が動く
- **プレイヤー音量の相殺**: 計測タップは `sourceNode` 直後で、Twitch のプレイヤー音量 (`video.volume`) はその上流に掛かる。ブロックの MS を volume² で割り、Integrated LUFS を常に音量 1.0 基準にする。視聴者がスライダーを下げても算出ゲインは上がらない。音量変更を跨ぐゲーティング窓は CM 境界と同じ仕組みで除外する
- **保存済み値の基準**: 音量 1.0 基準で測った値だけが基準名を持つ。保存済み LUFS は `lastLufsRef`、保存済み Auto gain は `autoGainRef` と、それぞれ自分のフィールドの更新番号でマージされる (共用すると ID 統合で値と基準の組が入れ替わる)。窓数 `lastLufsWindows` も `lastLufsRef` と同じく LUFS 側に属し、その値が勝った側のものが残る。基準の無い値 (拡張更新前の保存) は計測の初期サンプルに使わず、基準の無い Auto gain も起動時に適用しない。手動ゲインは視聴者自身の設定なので従来どおり適用する
- **計測値が無い間の Suggested gain**: ゲート通過値が 1 つも無い間は `suggestedGain` が 1.0 を返し、ゲインを上げる提案をしない
- **createMediaElementSource**: `<video>` に対し 1 回のみ呼び出し可能。他拡張 (FrankerFaceZ Compressor 等) が先に取ると失敗する。失敗した video は `WeakSet` で除外し、他の video にフォールバック。attach できなかった video では GainNode もプレイヤーの音声経路に入らないため、`attach-failed` を content.js が受けて popup に理由と対処を表示し、適用中ゲインの表示 (オーバーレイ) を取り下げる。フォールバック先へ attach できても、握られた要素がページに残る限り音量はその要素で鳴り続けるため、`attached` の `takenElsewhere` で通知を維持する
- **AudioContext を作れない場合**: 生成が失敗した試行はキャッシュせず、次の attach で作り直す。失敗の通知は状態が変わったときだけ 1 回送る (リトライごとには送らない)。`cause: 'audio-context'` を付けて他拡張との競合と区別し、popup は再読み込みを促す別文言を出す
- **音声経路が無い間の計測値**: `attach-failed` 後や `takenElsewhere` の間に届く lufs は、視聴者が聞いている要素のものではないため破棄する (保存も Auto 追従もしない)。復帰した時点で計測を初期化する — bridge のリングバッファには別要素のブロックが残っている
- **計測経路だけ落ちた場合**: worklet の読込・接続に失敗しても GainNode は経路内にあるため、`attached` の `measuring: false` で計測のみ不可と伝え、音量調整が効く旨を含む別の文言を出す
- **attach のリトライ**: video 要素は document_start 時点では存在しないため、`scheduleAttach()` で 1s 間隔のループ。`clearStaleAttachment()` が DOM から消えた video を検出して再 attach を許可 (Twitch SPA で video が入れ替わるケース対応)。SPA navigation 時にも content.js が `attach` を再送
- **measurement chain の接続点**: `attach()` は `ensureContext()` を await し、その await が `audioWorklet.addModule()` の解決まで含むため、attach 時点で worklet の可否は確定している。読込に失敗した attach は `measuring: false` を報告し、以降その attachment に計測経路は付かない
- **SPA navigation**: history.pushState/replaceState フック + popstate + MutationObserver の 3 段構え。URL 変更で resetMeasurement + 種別判定再実行 + attach 再送
- **計測リセットの世代番号**: content.js は resetMeasurement を送るたびに世代番号を進め、page-bridge はその番号を以降の lufs 通知へ付与する。content.js は現在の世代より古い通知を破棄するため、リセット送信前に page-bridge が算出したブロックが保存済み LUFS を復活させない
- **Live/VOD/Clip 別ゲイン**: 配信は時間帯で音作りが変わるため種別ごとに別管理。同チャンネルの過去 VOD のゲインを現 Live にコピーしない
- **Twitch reserved paths**: `/directory`, `/settings`, `/videos`, `/p`, `/jobs` 等は live channel として誤検出しないよう TWITCH_RESERVED_PATHS で除外
- **予約名の扱い**: Chrome が「パッケージ化されていない拡張機能を読み込む」で拒否するのはルート直下の `_` 始まりの名前だけで、下位ディレクトリの `_metadata` 等は読み込めてしまう (`_locales` はルートでも許される)。`test.js` の走査はそれより厳しく、パッケージを組む元のツリー (リポジトリから `.git` / `node_modules` とルート直下の `work/` / `.claude/` を除いた範囲) であれば深さに関わらず報告する。zip に入らない `docs/` 等も対象に含む
- **パッケージの選択は参照グラフ**: `pack.py` は manifest から辿れるもの (content_scripts の js と css / web_accessible_resources / service_worker / options_page と options_ui.page / action.default_popup / icons と action.default_icon) と、その HTML の `<script src>` と `<link href>` の css・worker の `importScripts`、および `_locales/<locale>/messages.json` だけを選ぶ。参照されないファイルは拡張子に関わらず入らない。パスは 1 箇所の resolver を通し、絶対パス・`..`・途中のディレクトリを含むシンボリックリンクで実体がパッケージ外へ出るものは失敗させる (壊れた zip も、外部ファイルを同梱した zip も黙って作らない)
- **CSP 対応**: AudioWorklet モジュールは web_accessible_resources で公開する。page-bridge は MAIN world でページ自身のスクリプトと window を共有し、init も含む全コマンドをページが送れるため、モジュール URL を受け取らず自分のスタックフレームから拡張 origin を取り、`<origin>/audio-worklet.js` を読み込む。origin を取れないときはモジュールを読み込まない
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

# 同梱されるファイルだけを確認する (zip は書かない)
python3 pack.py --list
```

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- unpacked extension のルートでは `python3 -m py_compile` を実行しない。Chrome が拒否する `__pycache__` を生成するため、Python 構文検査は上記の AST parse を使う (`node test.js` が走査する範囲は「予約名の扱い」節)
- `popup.html` / `options.html` は i18n 抽出器が読める形に限る: HTML コメント・`<template>`・`<textarea>` / `<iframe>` / `<xmp>` / `<noembed>` / `<noframes>` / `<noscript>` / `<plaintext>` を置かず、ページが使う raw text 要素 `<title>` / `<style>` / `<script>` は名前の直後に `>` を置いて閉じ (`</titles>` のように名前が続く形は別要素で、raw text を閉じずに以降を飲み込む)、`data-i18n` は小文字 + 引用符付きで書き、属性を載せる要素はテキストだけを持つ (`applyI18n` が `textContent` を代入するため)。キーとそれを載せた要素 (タグ名・`id`・`class` トークン) の対応は `node test.js` がスナップショットで固定する
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy) — content.js sends `resume` on first click capture
- BS.1770 reference is 48 kHz. Chrome の AudioContext は通常 48000 だが、サンプルレート変動には redesignBiquad で対応
- Storage keys: `autoLoudnessSettings` (target LUFS, ad gain, display unit, kind 別 Auto 既定値), `channelVolumes` (per-channel saved gains + kind 別 Auto + lastLufs cache と測定窓数), `channelVolumeAliases` (仮 ID → 正準 ID), `channelVolumeSequence` (永続更新番号)
- Storage format: `channelVolumes.{id}` = `{ name, login, gainLive, gainVod, gainClip, autoGainLive, autoGainVod, autoGainClip, autoApplyLoudnessLive, autoApplyLoudnessVod, autoApplyLoudnessClip, url, lastLufs: { live, vod, clip }, lastLufsRef: { live, vod, clip }, lastLufsWindows: { live, vod, clip }, autoGainRef: { live, vod, clip }, lastMeasuredAt, __fieldVersions }`
- 旧形式の単一フィールドは channel-store.js が書き込み時に展開して削除する (`gain` → `expandLegacyGain`、`autoApplyLoudness` → `expandLegacyAuto`)。読み取り側の `extractGainForKind` は展開前のエントリを読むためのフォールバックで、書き戻さない
- popup は `DISPLAY_UPDATE_INTERVAL_MS` ごとに getState をポーリングし LUFS / Suggested / Current カードを更新。Auto gain も同じ周期を上限として更新する。Manual slider は Auto ON の間だけ適用中 gain へ同期し、Auto OFF の通常ポーリングでは更新しない。Auto OFF では初回表示・「チャンネルに適用」・Auto 切替・表示単位変更・ユーザー操作時だけ同期する。計測自体は popup の開閉に依存せず、Twitch ページが開いている限り常時走る
- 拡張機能の再ロードで chrome.runtime が無効化された場合、popup は `reloadPageNeeded` を表示して F5 を促す
- 計測パイプラインの診断: DevTools Console で `[TCV]` ログを確認。`waiting for <video>` → `attached to video` → `measurement chain ready` → `first measurement block received` の順に出る。`createMediaElementSource failed` で止まる場合は他拡張競合 (技術的限界)。この状態は popup の通知と `getState` の audioUnavailable に出る。以降のリトライは `no attachable <video>; the player audio is held elsewhere` を出す (`waiting for <video>` は要素そのものが無いときだけ)。`audio context unavailable` / `audio context resume failed` / `audio context stayed <state> after resume` も同じ経路の診断
- CM 境界・音量変更の診断: `[TCV] ad detected in DOM` (DOM 検出と `video.currentTime`)、`[TCV] ad cue from the player` (cue の `rollType`・media 時刻の区間・受け取った時点の再生位置・pod 内の位置)、`[TCV] ad element attached` (CM 要素へ繋いだときの当該 volume と本編 volume)、`[TCV] gate boundary` / `[TCV] gate resumed` (境界の理由・volume・muted・再生位置と、除外した窓数・直近 4 窓の LUFS)、`[TCV] ad start rollback` (要求した窓数・境界スキップと重なって引いた窓数・取り消した窓数と各窓の LUFS。`exhausted` は要求した窓数だけ遡れたかで、偽なら計測開始が近く区間がそこで止まっている) を Console で追う。別の理由で打ち切られた skip はその時点までの除外数を次の `gate boundary` の `superseded` / `droppedBefore` に載せる

## Existing extensions (reference)

| 拡張機能 | 方式 | 永続化 | 備考 |
|---------|------|--------|------|
| Volume Sound Normalizer Pro | DynamicsCompressor + GainNode (LUFS 計測なし) | YT/Twitch channelId | AudioNode 配線の参考 |
| TwitchPerChannelAudio | React internal mediaPlayerInstance.setVolume() | login 名 | React fiber アクセス例 (壊れやすい) |
| FrankerFaceZ Compressor | グローバル DynamicsCompressor | グローバル | per-channel ではない |
| Hearably Twitch Volume Booster | MSE intercept + multiband compressor | タブ単位 | クローズドソース |

本プロジェクトは「Twitch 公式 API に頼らず自前 LUFS 計測 + 種別別永続化 + CM 区間の別ゲイン」を組み合わせ、既存実装が触れていない領域を狙う。
