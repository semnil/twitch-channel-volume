# セキュリティ監査

## 対象

LUFS の索引更新、保存済み LUFS による計測初期化、測定値リセット、page-bridge からの attach 結果通知を対象とする。

## 結果

| 項目 | 実装 | 検証方法 |
|---|---|---|
| 権限 | `manifest.json` は `storage` と `twitch.tv` のみを要求する | `node test.js` の manifest とプライバシーポリシーの一致テスト |
| リセット対象 | popup が表示中のチャンネル ID と種別を送り、content script が現在値との完全一致を検証する | チャンネル ID・種別が不一致の要求は `channel mismatch` で拒否 |
| 保存値 | Service Worker の単一キューで対象種別の `lastLufs` と `lastLufsRef` を削除し、gain・Auto 設定・`autoGainRef`・他種別の LUFS を維持する | `node test.js` の mutation・競合テスト |
| 競合 | リセット要求前の保存を完了してから削除し、削除処理中に到着した計測値は保存しない。リセット送信前に page-bridge が算出したブロックは計測世代番号で破棄する | 保存待ちを挿入した content script テスト、旧世代の計測を投入した content script / page bridge テスト |
| 入力値 | 保存済み LUFS は有限値の場合だけ計算初期値に使い、絶対ゲート未満の値は Integrated に寄与しない | NaN、Infinity、文字列、ゲート境界の page bridge テスト |
| 失敗時 | 保存値の削除に失敗した場合は実行中の計測を初期化せず、popup にローカライズ済みエラーを表示する | 保存失敗を注入した content script テスト |
| ページ由来の通知 | `attach-failed` / `attached` は真偽状態としてのみ扱い、付随する `reason` 文字列は console 診断にだけ出し、UI へも Storage へも渡さない。popup が出す文言は `_locales` の固定メッセージ | `attach-failed` / `attached` を投入した content script テスト、popup を実行して文言と無効化を検査するテスト、両ロケールの文言テスト |
| 無効な状態での書き込み | 音声経路が無い間は手動ゲイン・Auto 設定・測定値リセットの mutation を content script が拒否する (popup 側の無効化はポーリング周期の窓があるため) | `attach-failed` 後に `setGain` / `setAutoApplyLoudness` / `resetMeasurement` を送り、応答と保存値を検査するテスト |
| 別要素の計測値 | 音声経路が無い間に届いた lufs は保存にも Auto 追従にも使わない。復帰時は計測を初期化する | `attach-failed` 後に lufs を投入し、保存値と `setGain` の不発を検査するテスト |
| パッケージの内容 | zip に入るのは manifest から参照が辿れるファイルと `_locales/<locale>/messages.json` だけで、参照されないファイル (`.env`・メモ・未参照の `.js` / `.html`) は選択されない。参照先が欠けている場合と、絶対パス・`..`・シンボリックリンク (末尾の名前と親ディレクトリの両方) で実体がパッケージ外を指す場合は生成を失敗させる | `pack.py --list` を fixture ツリーで実行し、選択結果と 5 種の境界外参照の失敗を検査するテスト |
