# セキュリティ監査

## 対象

LUFS の索引更新、保存済み LUFS による計測初期化、測定値リセットを対象とする。

## 結果

| 項目 | 実装 | 検証方法 |
|---|---|---|
| 権限 | `manifest.json` の権限と接続先は変更しない | `git diff -- manifest.json` |
| リセット対象 | popup が表示中のチャンネル ID と種別を送り、content script が現在値との完全一致を検証する | チャンネル ID・種別が不一致の要求は `channel mismatch` で拒否 |
| 保存値 | Service Worker の単一キューで対象種別の `lastLufs` だけを削除し、gain・Auto 設定・他種別の LUFS を維持する | `node test.js` の mutation・競合テスト |
| 競合 | リセット要求前の保存を完了してから削除し、削除処理中に到着した計測値は保存しない | 保存待ちを挿入した content script テスト |
| 入力値 | 保存済み LUFS は有限値かつ絶対ゲート以上の場合だけ計算初期値に使う | NaN、Infinity、文字列、ゲート境界の page bridge テスト |
| 失敗時 | 保存値の削除に失敗した場合は実行中の計測を初期化せず、popup にローカライズ済みエラーを表示する | 保存失敗を注入した content script テスト |
