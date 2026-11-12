# Clip decisions

> For the English version, see [clip.md](clip.md).

Twitch のクリップについて閉じた判断。今有効な規則は `CLAUDE.md` にある。「Key design decisions」の「Media another origin serves」と「A clip is not volume-adjusted」、「Development notes」のクリップの項目。

## A clip is left to the player

- **決定** (2026-08-30): クリップは、プレイヤー自身の音声の経路で鳴らす。拡張機能はクリップの要素を取らず、クリップにはゲイン・Auto の設定・計測値を持たず、チャンネルも解決しない ([#42](https://github.com/semnil/twitch-channel-volume/pull/42))。
- **理由**: `CLAUDE.md` の「Media another origin serves」と「A clip is not volume-adjusted」。
- **却下した案**:
  - 要素に `crossorigin` を付けて、クリップを CORS モードで取りに行く。こうするとクリップが読み込まれない (`CLAUDE.md` の「Media another origin serves」)。
  - クリップを同じオリジンのものにする。ページからクリップを取り直し (`fetch(url, { cache: 'reload' })`)、応答を `Blob` にして要素の `src` に入れる。ページが作った blob はページ自身のオリジンに属するので、Web Audio がクリップの音を扱える。採らなかった理由は、クリップを 2 回ダウンロードすることと、Twitch のプレイヤーが管理している `src` を拡張機能が差し替えることになること。長いクリップ、画質の切り替え、シークでどう動くかは分かっていない。
- **覆す条件**: クリップのゲインや Auto がもう一度求められたとき。作業は、上の blob の案で分かっていない 3 点から始める。クリップの種の重みは、[#41](https://github.com/semnil/twitch-channel-volume/pull/41) の「A clip's stored level outlasted the clip carrying it」から始める。重みは下限と保存した窓の数の大きい方なので、下限を短くしても効かず、クリップに要るのは上限。クリップで種を外す案は、クリップの冒頭の数秒で起きることを理由に採らなかった。#42 が外した Clip の列・Clip の既定値・保存したクリップの項目も、一緒に戻すことになる。
- **それでもクリップが無音のとき**: `createMediaElementSource` は 1 つの要素につき 1 回しか呼べず、取られた要素の音はプレイヤーへ戻らない。そのため、この版がクリップを取らないことは、ページのほかのスクリプトについて何も保証しない。この版を読み込んでいてクリップが無音なら、最初に、同じページで拡張機能の写しがもう 1 つ動いていないかを見る。ストアから入れた古い版が、手元から読み込んだ版と並んでいる場合と、拡張機能だけを読み込み直してページを読み込み直していない場合がある (`page-bridge.js` は MAIN world で `document_start` に動くので、古いスクリプトがページに残る)。ページのコンソールに `[TCV] worklet module loaded` が 2 回出ていれば写しが 2 つ動いていて、クリップのページに `[TCV] attached to video` が出ていれば、どちらかが要素を取っている。この版は、クリップの要素についてこの行を出さない。
- **実害の記録**: 無音で再生されるクリップへの最初の修正は、止まっている `AudioContext` を対象にした ([#41](https://github.com/semnil/twitch-channel-volume/pull/41))。それでは音は戻らなかった。無音の原因は、別のオリジンが配るメディアを持つ要素の source node の側にあった。無音の要素を見たときは、最初にこの点を見る。

## What an earlier version stored for a clip is deleted with the fields

- **決定** (2026-08-31): `channel-store.js` は次に書くときにクリップの項目を落とし、ほかに何も持たない行と `clip-owner:<slug>` の別名も一緒に消す。保存済みの行を消すのは破壊的な操作で、破壊的な操作として明示の承認を得た ([#42](https://github.com/semnil/twitch-channel-volume/pull/42))。値を持たない行の決め方は `CLAUDE.md` の「Development notes」にある。

## The cross-origin refusal is logged at info, by its cause

- **決定** (2026-08-30): `content.js` は、`[TCV] player audio unavailable` を、原因が `cross-origin` のときは info で、ほかの原因のときは warn でログに出す ([#42](https://github.com/semnil/twitch-channel-volume/pull/42))。
- **理由**: Chrome は content script の warn を拡張機能のエラーとして集める。クリップを開くたびに warn が出て、不具合として報告された。`cross-origin` は、視聴者にできることが無いただ 1 つの原因。
- **却下した案**: ページの種別 (`kind === 'clip'`) で分ける。SPA 遷移では、`content.js` は新しい URL のチャンネルと種別を決める前に `attach` を送るので、種別を条件にすると、分けたい拒否と順番を争う。

## A `data:` URL is read as cross-origin, and that is left

- **決定** (2026-08-31): `page-bridge.js` の `mediaReach` は、メディアが `data:` の URL の要素を、別のオリジンが配るものと読む。そのため、その要素はプレイヤーに任される。これは変えない。
- **理由**: コードは、Twitch が `<video>` に `data:` の URL を渡さないことを前提にしていて、この場合は起きない。起きたとしても、誤りは安全な側に倒れる。要素は取られず、プレイヤーの音はそのまま鳴る。
