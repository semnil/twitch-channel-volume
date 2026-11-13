# Packaging decisions

> For the English version, see [packaging.md](packaging.md).

作業用のディレクトリと、ストア用のパッケージに入れるものについて閉じた判断。今有効な規則は `docs/design.ja.md` の「予約済みの名前」と「パッケージは参照のつながりで選ぶ」にある。

## `work/` and `.claude/` are ignored at the root only

- **決定** (2026-08-22): `.gitignore` は、作業用の 2 つのディレクトリを `/work/` と `/.claude/` の形 (ルート直下だけ) で書く。`node test.js` は、`/work/` の行か `/.claude/` の行が無いとき、または先頭のスラッシュの無い `work/` か `.claude/` の行があるときに落ちる ([#11](https://github.com/semnil/twitch-channel-volume/pull/11))。
- **経緯**: 同じ日に先にマージした [#9](https://github.com/semnil/twitch-channel-volume/pull/9) は、作業用のファイルが `git status` に出続けるように、`.gitignore` を変えなかった。#11 がその決定を置き換えた。2 行をもう一度外す提案は、後の決定に反する。

## The package is selected by reference graph

- **決定** (2026-08-22): `pack.py` は、manifest からたどれるものを zip に入れる。それまでは、除外の一覧に名前の無いものを入れていた ([#9](https://github.com/semnil/twitch-channel-volume/pull/9))。
