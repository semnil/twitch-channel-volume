# Packaging decisions

> 日本語版は [packaging.ja.md](packaging.ja.md) を参照してください.

Closed decisions about the scratch directories and about what goes into the store package. The rules in force are in `CLAUDE.md`, "Reserved names" and "Packaging selects by reference graph".

## `work/` and `.claude/` are ignored at the root only

- **Decision** (2026-08-22): `.gitignore` names the two scratch directories as `/work/` and `/.claude/`, at the root only, and `node test.js` fails where the `/work/` line or the `/.claude/` line is missing, and where `work/` or `.claude/` is written without the leading slash ([#11](https://github.com/semnil/twitch-channel-volume/pull/11)).
- **History**: [#9](https://github.com/semnil/twitch-channel-volume/pull/9), merged earlier the same day, left `.gitignore` as it was so that the scratch stayed visible in `git status`. #11 replaced that decision. A proposal to take the two lines out again goes against the later of the two.

## The package is selected by reference graph

- **Decision** (2026-08-22): `pack.py` puts into the zip what the manifest reaches, where it used to take whatever an exclusion list did not name ([#9](https://github.com/semnil/twitch-channel-volume/pull/9)).
