# Suspended-context decisions

> For the English version, see [suspended-context.md](suspended-context.md).

拡張機能の `AudioContext` が止まっている (suspended) 間の動きについて閉じた判断。今有効な規則は `AGENTS.md` の「When the AudioContext is suspended」にある。下の 2 つは、分かった上で残した制限で、理由は [#41](https://github.com/semnil/twitch-channel-volume/pull/41) の「Not covered here」にある。

## The element is taken while the context is suspended

- **決定** (2026-08-30): `attach()` は AudioContext の状態を見ずに `createMediaElementSource` を呼び、`attachAdElement()` は状態が `running` でなければ断る。同じ操作を 2 つの経路が別々に判断している状態を、そのまま残す。`attach()` を待たせる案はレビューで挙がり、指摘としては正しいが、採らなかった ([#41](https://github.com/semnil/twitch-channel-volume/pull/41))。
- **理由**: `createMediaElementSource` は 1 つの要素につき 1 回しか呼べない。AudioContext が動くまで `attach()` を待たせると、同じ要素を取るほかの拡張機能に、視聴者の最初の操作までの数秒を明け渡す。この取り合いがどちらに転ぶかは分かっていない。
- **覆す条件**: 取り合いの結果が分かったとき。同じ要素を取る拡張機能も入れたブラウザのプロファイルで、待たせた場合と待たせない場合の、この拡張機能の attach の成否を比べる。

## The display is left as it is while the context is suspended

- **決定** (2026-08-30): ページの読み込みから視聴者の最初の操作までの間、popup とゲインのオーバーレイは、まだ音声の経路に入っていないゲインを表示する。`content.js` の `updateGainOverlay` のコメントは「バッジはプレイヤーが鳴っているゲインを表す」と書いているが、そのままにする ([#41](https://github.com/semnil/twitch-channel-volume/pull/41))。
- **理由**: 直すには popup のお知らせがもう 1 つと、2 つのロケールの文言が要る。操作を待っていることを視聴者に見せるかどうかは、不具合の修正ではなく画面の決定になる。#41 はこの時間を短くした。それまではクリックだけが終わらせていたが、どの操作でも終わる。
