# Security audit

> 日本語版: [../ja/security-audit.md](../ja/security-audit.md)

## Scope

The LUFS index update, measurement seeding from a saved LUFS, measurement reset, the commands page-bridge receives and the attach results it reports, the GraphQL responses read through the wrapper around the page's `fetch`, the ad cues taken from the player's worker, the gain applied to an ad element, and the extension resources exposed to the page.

## Results

| Item | Implementation | Verification |
|---|---|---|
| Permissions | `manifest.json` asks for `storage` and `twitch.tv` and nothing else | The `node test.js` test that matches the manifest against the privacy policies |
| Command input | page-bridge shares the MAIN world and its events with the page, so the page can send every command, `init` included. The AudioWorklet module URL is not taken from the command; it is built from the extension origin that page-bridge's own stack frame names. When that origin cannot be read, no module is loaded | The `node test.js` page bridge init tests (another extension's origin, a non-extension origin, swapping a module already loaded, an origin that cannot be named) |
| Reset target | The popup sends the channel ID and media kind it is displaying, and the content script checks them for an exact match against the current values | The `node test.js` test `content rejects a measurement reset for a different channel or media kind`, which sends both mismatches and reads back `channel mismatch` |
| Stored values | A single Service Worker queue deletes `lastLufs` for the target media kind along with the `lastLufsRef` / `lastLufsWindows` that describe it, and keeps the gain, the Auto setting, `autoGainRef`, and the LUFS of the other media kinds | The `node test.js` mutation and concurrency tests |
| Concurrency | The deletion runs only once a save issued before the reset request has finished, and a measurement arriving while the deletion is in flight is not stored. Blocks that page-bridge computed before the reset was sent are discarded on the measurement epoch number | A content script test with a pending save inserted, and content script / page bridge tests fed a measurement from an earlier epoch |
| Input values | A saved LUFS seeds the computation only when it is finite, and a value below the absolute gate does not contribute to Integrated. The window count that weighs the seed is capped at 1800 windows (3 minutes), and a value that is not a positive integer is treated as the floor. Only a positive integer reaches storage as a window count | page bridge tests for NaN, Infinity, a string, and the gate boundary; a page bridge test feeding in a seed over the cap; channel store tests sending window counts of 0, a negative, a fraction, and a string |
| On failure | When deleting the stored value fails, the running measurement is left alone and the popup shows a localized error | A content script test with a storage failure injected |
| Notices from the page | `attach-failed` / `attached` are handled as boolean state only; the `reason` string riding with them goes to the console diagnostics and reaches neither the UI nor storage. The text the popup shows is a fixed message from `_locales` | A content script test fed `attach-failed` / `attached`, a test that runs the popup and checks its text and its disabling, and a test of the text in both locales |
| Writes in an invalid state | While there is no audio path, the content script refuses the manual gain, Auto setting, and measurement reset mutations (the popup's own disabling leaves a window the width of the polling interval) | A test that sends `setGain` / `setAutoApplyLoudness` / `resetMeasurement` after `attach-failed` and checks the response and the stored value |
| The page's fetch | `window.fetch` is wrapped, and only a response whose URL contains `gql.twitch.tv` is read through `clone()`. The response reaches the page unaltered, and the extension issues no request of its own | The `node test.js` fetch hook tests (exactly one call carrying the original arguments per `fetch` the page makes, a URL outside the scope passing straight through, response identity) |
| Resources exposed to the page | `web_accessible_resources` exposes `audio-worklet.js` alone, to `*.twitch.tv` / `clips.twitch.tv`. The URL it loads is built from the extension origin that page-bridge's own stack frame names | The `node test.js` manifest test and page bridge init test |
| Measurements from another element | A `lufs` message arriving while there is no audio path is used neither for storage nor for Auto following. The measurement is reset once the path comes back | A test that feeds `lufs` after `attach-failed` and checks the stored value and that no `setGain` follows |
| Package contents | The zip holds only the files the manifest reaches by reference plus `_locales/<locale>/messages.json`; a file nothing references (`.env`, notes, an unreferenced `.js` / `.html`) is not selected. A missing reference target, and a path whose real location leaves the package through an absolute path, `..`, or a symlink (both the last name and a parent directory), fail the build | Tests that run `pack.py --list` over a fixture tree and check the selection and the failure for each form of an out-of-bounds reference (an absolute path, `..`, a trailing symlink, a symlinked parent directory, a missing target) |

## The player's worker and ad elements

| Item | Implementation | Verification |
|---|---|---|
| What is done to the worker | The `Worker` constructor is wrapped only to add a message listener; the worker is created from the arguments the page passed (URL, options) as they stand. The worker's script is not read | The `node test.js` worker hook test matches the identity of the arguments and the listener count |
| On failure | The wrapping is guarded, including the case where `window.Worker` cannot be assigned to, and the measurement runs on when it fails. Ad detection then rests on the DOM indicator alone | Starting page bridge with a `Worker` that cannot be replaced |
| Values taken in | The only fields read from a cue are `rollType`, `startTime` / `endTime`, and `podPosition` / `podCount`. The ad ID, the advertiser, and tracking URLs are not touched | The payload the cue test passes in, and the mutation of the acceptance condition |
| Cues from the other player | During a break the page runs a second player, which posts cues on its own timeline. Only a cue whose interval holds the playhead is accepted | A test that feeds in a cue measured from the other player |
| Ad element | A `MediaElementSource` is created only when the content element is paused and another element is sounding. An element that is muted or at volume 0 is left untouched. When the break ends the gain returns to 1.0, and the chain is disconnected once the element leaves the DOM | The ad element tests (gain value, muted element, after the break, leaving the DOM) |
| What is measured | No measurement is taken from an ad element, and the attach loop does not select it either | A test that checks the attach loop steps past the ad element |
