# Screenshot decisions

> 日本語版は [screenshots.ja.md](screenshots.ja.md) を参照してください.

Closed decisions about the images under `docs/screenshots/` and the generator that draws them. What the generator does is in `AGENTS.md`, "File overview" (`gen_screenshots.py`, `docs/screenshots/`, `tools/fonts/`).

## The screenshots are tracked

- **Decision** (2026-08-23): the six images under `docs/screenshots/` — the popup, the settings page and the overlay, in English and in Japanese — are tracked. They are drawn with the typefaces the repository carries, moved into place only once the last of them is drawn, put back when a move stops part-way, and compared with what the code draws, pixel by pixel, in CI ([#19](https://github.com/semnil/twitch-channel-volume/pull/19), [#23](https://github.com/semnil/twitch-channel-volume/pull/23)).

## The two generator tests that fail without Pillow are left as they are

- **Decision** (2026-10-20): where `python3` has no Pillow, the generator tests in `test.js` that carry `generatorSkip` skip themselves, and two tests that do not carry it fail: `a settings row too many is refused, not drawn off the sheet` and `an argument that is wrong is answered before the faces are needed`. The two are left as they are. A development machine installs the Pillow that CI installs (`pillow==12.2.0` in `.github/workflows/ci.yaml`); with it in place, `node test.js` skips no test.
- **History**: the two failures are in the verification of [#71](https://github.com/semnil/twitch-channel-volume/pull/71), which ran on a machine without Pillow.
