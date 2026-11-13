# twitch-channel-volume

Chrome extension (MV3) that balances the volume of each Twitch channel to a target loudness (Target LUFS) from a real-time BS.1770 LUFS measurement, and remembers a gain per channel.
Twitch has no API like YouTube's `loudnessDb`, so the playing `<video>` element is measured directly with the Web Audio API.
Ad breaks are detected from the cues the player posts to the page, falling back to the ad indicator in the DOM on media that receive no cue. A separate gain is applied to them.

## Documents

What the code does and why is in the documents below, each with a Japanese counterpart (`<name>.ja.md`). This file keeps what has to be run, kept together or left alone. Open the document before the change it is named for.

- Before changing what a script does, which world it runs in or what it sends to another, read `docs/architecture.md`: the diagram at its top and the section named after the file (`page-bridge.js`, `content.js`, `audio-worklet.js`, `channel-store.js`, `settings-store.js`, `core/common.js`, `core/loudness.js`, `utils.js`, `popup.html / popup.js`, `options.html / options.js`). The storage keys and their shape are under `content.js`, "Storage"
- Before changing a catalog under `_locales/`, a `data-i18n` key or `<html lang>`, read `docs/architecture.md`, "i18n"
- What the viewer does with the extension, step by step, is in `docs/architecture.md`, "User workflow"
- Before changing `gen_screenshots.py` or what it writes into `docs/screenshots/` (its arguments, its exit codes, what `--check` compares, how it replaces and restores the tracked images), read `docs/architecture.md`, "The screenshot generator and its output"
- Before changing the code a decision is about, read its entry in `docs/design.md`. The entries, by the words in bold that open them:
  - The measurement: "Own LUFS measurement", "AudioWorklet (not ScriptProcessor)", "The measurement is shared", "K-weighting filter coefficients", "Indexed Integrated LUFS updates", "Measurement across sessions", "Cancelling the player volume", "The reference a stored value carries", "The epoch number of a measurement reset", "Where the measurement chain is connected", "When only the measurement path is down", "Readings while there is no audio path"
  - The gain: "An Auto gain is the one the Integrated value asks for", "GainNode, not HTMLMediaElement.volume", "Suggested gain while there is no reading", "Separate gain per Live/VOD", "NaN/Infinity guard", "A gesture is made against a state, and applies to that state alone"
  - Ads: "Ad-break detection", "Choosing between the two signals", "The ad element", "Behaviour during an ad"
  - Channels and storage: "Channel ID strategy", "Provisional ID → confirmed ID transition", "Saved Channels channel invariant", "Single writer for channelVolumes", "With Chrome sync on the settings sync across the user's Chromes; channel data does not", "Per-field settings saves", "Show the screen after the stored values are in it"
  - The page, the element and the context: "MAIN world / ISOLATED world split", "A page fetch nothing handles", "createMediaElementSource", "Media another origin serves", "A clip is not volume-adjusted", "When the AudioContext is suspended", "When the AudioContext cannot be created", "Attach retries", "SPA navigation", "Twitch reserved paths", "CSP"
  - The package: "Reserved names", "Packaging selects by reference graph"
- Before changing a stored field, what is done with a field an earlier version left, what the popup polls, or a `[TCV]` log line, read `docs/development.md`. To find out from the logs what happened, read its notes "Diagnosing the measurement pipeline", "Diagnosing ad boundaries and volume changes" and "Diagnosing a failed action", which name each log line and the DevTools it appears in
- Before reopening something that was decided, read the record under `docs/decisions/` (`clip.md`, `error-list.md`, `measurement.md`, `packaging.md`, `screenshots.md`, `suspended-context.md`)
- For whether an event changes the gain or writes to storage, read `docs/gain-change-and-save.md`

## Rules the design sets

Each rule names the entry of `docs/design.md` that gives its reason.

- `channelVolumes`, `channelVolumeAliases` and `channelVolumeSequence` are written by the background.js → channel-store.js queue alone, and `autoLoudnessSettings` by the background.js → settings-store.js queue alone. A page or a content script sends a mutation message and writes none of them ("Single writer for channelVolumes", "Per-field settings saves")
- The scripts `background.js` pulls in with `importScripts` (core/common.js, channel-store.js, settings-store.js) share one global, so top-level names must not collide (`node test.js` cross-checks the declarations in those files) ("Single writer for channelVolumes")
- Settings are read through `readSettings`. An `onChanged` listener takes `autoLoudnessSettings` from the `sync` area alone and the channel keys from the `local` area alone. Nothing writes settings on install, and nothing but a discrete gesture in options and the move to sync writes them ("With Chrome sync on the settings sync across the user's Chromes; channel data does not")
- The initial values in the markup of popup / options are kept equal to the defaults `renderSettings` falls back to (`node test.js` checks the two against each other) ("Show the screen after the stored values are in it")
- `TWITCH_RESERVED_PATHS` in `utils.js` and its mirror in `page-bridge.js` change together ("A page fetch nothing handles")
- `SETTING_ROWS` in `gen_screenshots.py` and the rows `options.html` lays out change together; `node test.js` compares them (`docs/architecture.md`, "The screenshot generator and its output")
- Every answer content.js gives carries `appliesTo`, and a gesture the popup sends echoes it ("A gesture is made against a state, and applies to that state alone")
- A clip keeps no channel, no stored gain and no Auto setting, and makes no owner lookup ("A clip is not volume-adjusted")
- page-bridge.js takes no module URL from a message: it loads `<origin>/audio-worklet.js` from the extension origin it reads from its own stack frame ("CSP")
- Chrome collects a warning from a content script or the popup as an extension error. A line with nothing for the viewer to put right is logged at info ("Media another origin serves"; `docs/development.md`, "Diagnosing a failed action")
- Add no file or directory whose name begins with `_`: `node test.js` reports one at any depth of the tree the package is built from ("Reserved names")
- A file reaches the zip by being referenced from the manifest or from a file the manifest reaches; `python3 pack.py --list` prints the selection ("Packaging selects by reference graph")

## File overview

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. permissions: storage. host: twitch.tv |
| `page-bridge.js` | MAIN world. AudioContext + LUFS (through `core/loudness.js`) + fetch hook (GraphQL) + Worker hook (ad cues) + gain on the ad element |
| `audio-worklet.js` | K-weighted MS accumulation (100ms blocks); shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#worklet)) |
| `content.js` | ISOLATED world. Gain management, channel resolution, storage |
| `utils.js` | Shared constants and utilities (content.js/popup/options/test) |
| `popup.html` / `popup.js` | Popup UI |
| `options.html` / `options.js` | Settings page |
| `background.js` | Service worker (single writer for channelVolumes / settings + the move of the settings from local to sync at every start; writes no settings on install) |
| `channel-store.js` | channelVolumes mutations, serialisation, provisional-ID merging |
| `settings-store.js` | Per-field mutations of autoLoudnessSettings, serialisation, the move to sync |
| `_locales/` | i18n (ja, en) |
| `icons/` | 16/48/128 px PNG (Twitch purple 3-bar meter) |
| `gen_icons.py` | Draws the icons in the colours and with the mark `core.json`'s `icon` names; shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#package)) |
| `gen_screenshots.py` | Screenshot generation (drawn directly with PIL, 640×400 ja/en → `docs/screenshots/`). What it reads, what `--check` compares, what it refuses and its exit codes are in `docs/architecture.md`, "The screenshot generator and its output" |
| `pack.py` | Builds the zip for the Chrome Web Store from what the extension loads; `--list` prints the selection only. Shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#package)) |
| `PRIVACY_POLICY.md` / `PRIVACY_POLICY_JA.md` | Privacy policy (for review and the README link, EN/JA) |
| `docs/screenshots/` | Output of `gen_screenshots.py`. Used by the README and by the store listing (not bundled into the extension). What is tracked is drawn with the M PLUS 1p faces in `tools/fonts/`. CI redraws with `--check` and compares pixels. How the six images are replaced and restored is in `docs/architecture.md`, "The screenshot generator and its output" |
| `tools/check-tag.sh` | Refuses a Release run on a tag that names no release; shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#release)) |
| `tools/tag-plan.sh` | The release tag a commit on main asks for, which `tag-release.yaml` pushes, so merging a version bump is the release; shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#release)) |
| `tools/verify-version.sh` | Holds a release tag to the manifest's version; shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#release)) |
| `tools/fonts/` | The M PLUS 1p faces used for drawing (Regular / Bold) and OFL.txt. Taken from `ofl/mplus1p` in google/fonts (commit `66a36c8`). Kept in the repository so that CI and each machine produce the same pixels |
| `test.js` | Unit tests (`node test.js`) — utils and the stores, plus content.js / page-bridge.js (with `core/loudness.js` loaded ahead of it, as the manifest loads them) / popup.js / options.js / background.js run in a VM harness. The meter and the worklet are tested in channel-volume-core; the bridge's cases read what it posts against an oracle over arrays. The harnesses keep `chrome.storage.sync` and `chrome.storage.local` apart and name the area of every change they fire, as Chrome does |
| `tools/mutation/` | `sweep.mjs`, `bail.mjs` and `sweep-all.sh` are shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#mutation)). `fast-suite.sh` is this repository's: `node test.js` without the packaging surface, whose slow cases shell out to python; it excludes on the case name, so it is used with `MUTATE_CONFIRM="node test.js"` and never on its own. `equivalents.md` is this repository's own: every mutant the suite lets through and what was measured about each, held to the code by `sweep.mjs --verify`, which `test.js` runs. A failed test prints `✖ <name>` from the spec reporter or `not ok <n> - <name>` from the TAP reporter, whichever the Node running it writes to a pipe, the line given to `bail.mjs`; node:test writes a test's line only once the event loop runs again, so a failure followed by tests that hold the loop (a `spawnSync`, a synchronous loop) reaches `bail.mjs` with the first test after them that waits on something |
| `tools/coverage/` | `v8-to-lcov.mjs` is shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#coverage)). CI runs `test.js` under `NODE_V8_COVERAGE` and uploads to Codecov the report of the JS files `pack.py --list` ships but those under `core/` and `audio-worklet.js`; a failed upload fails the Test check on a pull request and leaves it green on a push to main |
| `core/common.js` | The code shared with the sibling extensions, loaded ahead of `utils.js` wherever `utils.js` loads; what each part does is in [channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#shared-code) |
| `core/loudness.js` | The loudness measurement shared with the sibling extensions, loaded ahead of `page-bridge.js` in the MAIN world; what each part does is in [channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#loudness) |
| `core.json` | Names this extension to [semnil/channel-volume-core](https://github.com/semnil/channel-volume-core#corejson): the groups of shared files it takes, the commit its copies come from, the zip's name and the icon. Nothing the extension loads refers to it, so the package never carries it |
| `tools/check-shared.sh` | Compares the shared files with the commit `core.json` locks; the Test check runs it, and a copy that differs fails it. Shared ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#check-shared)) |


## Shared files

`core/common.js`, `core/loudness.js`, `audio-worklet.js`, `pack.py`, `gen_icons.py`, `tools/mutation/sweep.mjs`, `tools/mutation/bail.mjs`, `tools/mutation/sweep-all.sh`, `tools/coverage/v8-to-lcov.mjs`, `tools/check-shared.sh`, the release scripts (`tools/check-tag.sh`, `tools/tag-plan.sh`, `tools/verify-version.sh`), every workflow under `.github/workflows`, `.github/tests/`, `.github/CODEOWNERS`, `.github/FUNDING.yml`, the issue templates and `.gitattributes` (which checks every one of them out with LF line endings) are copies of the files under `shared/` in [semnil/channel-volume-core](https://github.com/semnil/channel-volume-core), at the commit `core.json` locks. What each of them does is in that repository's [docs/shared-files.md](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md). They are changed there, with their tests, and copied here with that repository's `sync.mjs`. The Test check fails a copy that differs from the locked commit. Dependabot runs there as well, so this repository has no `dependabot.yml`. Once a day, and when run by hand, the Sync Core workflow (`.github/workflows/sync-core.yaml`) opens or updates the pull request from `sync/channel-volume-core` that takes channel-volume-core's `main` where it has moved past the locked commit, with a GitHub App's token; its job is skipped while the repository has no `SYNC_APP_CLIENT_ID` variable (channel-volume-core's README, "Setting up the sync").

## Commands

```sh
# Load as unpacked extension
# chrome://extensions → Developer mode → Load unpacked → select this folder

# Regenerate icons
python3 gen_icons.py

# Regenerate store screenshots (writes into docs/screenshots/, which the README points at)
python3 gen_screenshots.py

# Check whether the tracked images match what is drawn now (writes nothing; the command CI runs)
python3 gen_screenshots.py --check

# Run tests
node test.js

# Sweep one source for mutants the suite lets through, in a worktree rather than
# the checkout being worked in (the MUTATE_* settings: channel-volume-core's
# docs/shared-files.md, "The mutation sweep")
MUTATE_CONFIRM="node test.js" node tools/mutation/sweep.mjs <worktree> content.js \
  node tools/mutation/bail.mjs '^(✖|not ok) ' sh tools/mutation/fast-suite.sh

# The same sweep in two worktrees at once, half of the mutants each
MUTATE_SHARD=0/2 MUTATE_CONFIRM="node test.js" node tools/mutation/sweep.mjs <worktree-a> content.js \
  node tools/mutation/bail.mjs '^(✖|not ok) ' sh tools/mutation/fast-suite.sh
MUTATE_SHARD=1/2 MUTATE_CONFIRM="node test.js" node tools/mutation/sweep.mjs <worktree-b> content.js \
  node tools/mutation/bail.mjs '^(✖|not ok) ' sh tools/mutation/fast-suite.sh

# Every source, one at a time, into one report (MUTATE_SHARD passes through to
# each sweep, so two of these in two worktrees split every file between them)
MUTATE_CONFIRM="node test.js" sh tools/mutation/sweep-all.sh <worktree> <report> \
  "node tools/mutation/bail.mjs '^(✖|not ok) ' sh tools/mutation/fast-suite.sh" utils.js content.js page-bridge.js

# Ask whether equivalents.md still names sites the code has (no suite is run)
node tools/mutation/sweep.mjs --verify

# The coverage report CI uploads, made locally (<dir> is any empty directory)
NODE_V8_COVERAGE=<dir> node test.js
# (core/ and audio-worklet.js are left out: channel-volume-core's own suite covers the shared code)
node tools/coverage/v8-to-lcov.mjs <dir> coverage.lcov $(python3 -B pack.py --list | grep '\.js$' | grep -v -e '^core/' -e '^audio-worklet\.js$')

# Python syntax check (leaves no __pycache__ behind)
python3 -B -c "import ast,pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('.').glob('*.py')]"

# Compare the shared files with the commit core.json locks (fetches it from GitHub)
bash tools/check-shared.sh

# Package for Chrome Web Store
python3 pack.py

# List the files that get bundled (writes no zip)
python3 pack.py --list
```

## Conventions

- **Override of the global CLAUDE.md's 「ドキュメント」 language rule**: documentation is maintained in English and Japanese, English first: `README.md` / `README.ja.md` at the root, `docs/<name>.md` / `docs/<name>.ja.md` under `docs`
- `PRIVACY_POLICY.md` keeps its name because the Chrome Web Store listing links to it by path. `PRIVACY_POLICY_JA.md` keeps its name because the README pair and the English policy point at it
- A change that adds a stored field brings `PRIVACY_POLICY.md` and `PRIVACY_POLICY_JA.md` up to date in the same change. `node test.js` holds the permission rows of the two policies to the manifest, and nothing holds their list of what is stored
- `AGENTS.md` is English only and has no Japanese counterpart
- Closed decisions, with their reasons and what would reopen them, are in `docs/decisions/<subject>.md`, each with a `<subject>.ja.md` that keeps the English headings. What is decided for every extension that takes the shared files is recorded in [channel-volume-core](https://github.com/semnil/channel-volume-core) and not repeated here: what polling may write to a control the viewer operates (its `AGENTS.md`), the look the extensions share and the colour of muted text (its `docs/decisions/ui.md`), which documents have no Japanese counterpart and which headings a Japanese decision record has (its `docs/decisions/documentation.md`), and the weight of the measurement's seed (its `docs/decisions/measurement.md`)
- Commit messages follow Conventional Commits

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- Do not run `python3 -m py_compile` at the root of the unpacked extension. It generates the `__pycache__` Chrome refuses, so use the AST parse above for the Python syntax check (the range `node test.js` scans is in `docs/design.md`, "Reserved names")
- `popup.html` / `options.html` stay in a shape the i18n extractor can read: no HTML comments, `<template>`, `<textarea>` / `<iframe>` / `<xmp>` / `<noembed>` / `<noframes>` / `<noscript>` / `<plaintext>`; the raw text elements the pages do use — `<title>` / `<style>` / `<script>` — are closed with `>` directly after the name (a form where the name continues, such as `</titles>`, is a different element and swallows what follows without closing the raw text); `data-i18n` is written lowercase and quoted; and an element carrying the attribute holds its own key and no other text — `applyI18n` (core/common.js) assigns the catalog's message to `textContent` before the body loses `initializing`, and the key itself where the catalog has none, so wording written into the markup would be read by nobody and drift unseen. The mapping from a key to the element carrying it (tag name, `id`, `class` tokens) is pinned by a snapshot in `node test.js`
- The options and popup harnesses in `test.js` load `core/common.js` into their VM context ahead of the page's own script, as the pages do, and then put their own `msg` over the one it declares (the options harness its own `esc` as well). A case that needs a function of `core/common.js` that touches the DOM or `chrome` has it from that load
- The stored format, the fields an earlier version left, what the popup polls and the `[TCV]` log lines to diagnose from are in `docs/development.md`
