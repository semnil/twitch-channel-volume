# セキュリティ監査

## 対象

LUFS の索引更新、保存済み LUFS による計測初期化、測定値リセット、page-bridge のコマンド受信を対象とする。

## 結果

| 項目 | 実装 | 検証方法 |
|---|---|---|
| 権限 | `manifest.json` は `storage` と `twitch.tv` のみを要求する | `node test.js` の manifest とプライバシーポリシーの一致テスト |
| コマンド入力 | page-bridge は MAIN world でページとイベントを共有し、init を含む全コマンドをページが送れる。AudioWorklet モジュール URL はコマンドから取らず、page-bridge 自身のスタックフレームが示す拡張 origin から組み立てる。origin を取れないときはモジュールを読み込まない | `node test.js` の page bridge init テスト (別拡張 origin・非拡張 origin・読込済みの差し替え・origin 不明時) |
| リセット対象 | popup が表示中のチャンネル ID と種別を送り、content script が現在値との完全一致を検証する | チャンネル ID・種別が不一致の要求は `channel mismatch` で拒否 |
| 保存値 | Service Worker の単一キューで対象種別の `lastLufs` と `lastLufsRef` を削除し、gain・Auto 設定・`autoGainRef`・他種別の LUFS を維持する | `node test.js` の mutation・競合テスト |
| 競合 | リセット要求前の保存を完了してから削除し、削除処理中に到着した計測値は保存しない。リセット送信前に page-bridge が算出したブロックは計測世代番号で破棄する | 保存待ちを挿入した content script テスト、旧世代の計測を投入した content script / page bridge テスト |
| 入力値 | 保存済み LUFS は有限値の場合だけ計算初期値に使い、絶対ゲート未満の値は Integrated に寄与しない | NaN、Infinity、文字列、ゲート境界の page bridge テスト |
| 失敗時 | 保存値の削除に失敗した場合は実行中の計測を初期化せず、popup にローカライズ済みエラーを表示する | 保存失敗を注入した content script テスト |
