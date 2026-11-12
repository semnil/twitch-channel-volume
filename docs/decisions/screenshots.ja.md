# Screenshot decisions

> For the English version, see [screenshots.md](screenshots.md).

`docs/screenshots/` の画像と、それを描く生成器について閉じた判断。生成器のすることは `CLAUDE.md` の「File overview」(`gen_screenshots.py`・`docs/screenshots/`・`tools/fonts/`) にある。

## The screenshots are tracked

- **決定** (2026-08-23): `docs/screenshots/` の 6 枚の画像 (popup・設定ページ・オーバーレイを、英語と日本語で 1 枚ずつ) を git で追跡する。リポジトリが持つ書体で描き、最後の 1 枚を描き終えてから置き換え、置き換えが途中で止まったら元に戻し、CI でコードが描くものと画素ごとに比べる ([#19](https://github.com/semnil/twitch-channel-volume/pull/19)、[#23](https://github.com/semnil/twitch-channel-volume/pull/23))。

## The two generator tests that fail without Pillow are left as they are

- **決定** (2026-10-20): `python3` に Pillow が無い環境では、`test.js` の生成器のテストのうち `generatorSkip` の付いたものは自分で skip し、付いていない 2 件 (`a settings row too many is refused, not drawn off the sheet` と `an argument that is wrong is answered before the faces are needed`) は失敗する。この 2 件はそのままにする。開発機には、CI が入れるのと同じ Pillow (`.github/workflows/ci.yaml` の `pillow==12.2.0`) を入れる。入れた環境では、`node test.js` が skip するテストは無い。
- **経緯**: 2 件の失敗は、Pillow の無いマシンで流した [#71](https://github.com/semnil/twitch-channel-volume/pull/71) の検証に載っている。
