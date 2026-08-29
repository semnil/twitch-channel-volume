# twitch-channel-volume

Chrome extension (MV3) that automatically adjusts the volume of each Twitch channel from a real-time BS.1770 LUFS measurement.
Twitch has no API like YouTube's `loudnessDb`, so the playing `<video>` element is measured directly with the Web Audio API.
Ad breaks are detected from the cues the player posts to the page, falling back to the ad indicator in the DOM on media that receive no cue. A separate gain is applied to them.

## Architecture

```
page-bridge.js (MAIN world content script, document_start)
├── Owns the AudioContext / MediaElementSource / GainNode
├── K-weighting IIRFilter (pre-filter high-shelf + RLB high-pass, BS.1770-4)
├── AudioWorklet (k-mean-square) accumulates the MS of each 100ms block
│   ├── Each block is divided by video.volume squared on arrival, normalising it to volume 1.0
│   ├── Momentary: MS average of the last 4 blocks (400ms) → LUFS
│   ├── Short-term: MS average of the last 30 blocks (3s) → LUFS
│   └── Integrated: the MS average of the last 4 blocks (400ms) is submitted every 100ms as one gating window; the stored per-kind LUFS enters as initial samples worth the window count it was measured over (floor 300 windows = 30 seconds, cap 1800 windows = 3 minutes); a 1-hour ring buffer + balanced tree updates the absolute gate (-70 LUFS) and the relative gate (-10 LU) in O(log n)
│       Reported alongside the LUFS is the window count the value stands on (windows that passed the relative gate, with the seed counted as the window count it declared)
├── Boundary skip: after an ad ends or the volume changes, the 4 windows it takes for the gating window to clear the boundary are excluded from Integrated
├── Ad gate: nothing is added to Integrated while the playback position is at or past the cue's `startTime` and before its `endTime`.
│   While no cue has been received at all, the gate follows the DOM indicator instead
├── Ad-start rollback: from the elapsed time when the cue arrives (playback position −
│   the cue's `startTime`), 1 + elapsed/0.1 windows are withdrawn; with no cue and only the
│   DOM indicator, 5 windows (windows added since the last reset only; done after the ring
│   buffer has overflowed too). Windows the boundary skip never added are subtracted from that count
├── Measurement epoch: the number received with resetMeasurement is held and stamped on later lufs notifications
├── attach loop (scheduleAttach): retries for a video at 1s intervals. On detecting a video that
│   left the DOM, it tears the chain down and restarts the loop itself
├── Holds the element it could not attach to, and sets takenElsewhere on attached while that element remains in the page
├── buildMeasurementChain: connected at attach time (attach runs after the worklet load has resolved)
├── Fetch hook (GraphQL only):
│   └── gql.twitch.tv → extracts user.id / video.owner.id / clip.broadcaster.id plus the
│       content kind/id current at request time
├── Worker hook: wraps `Worker` only to add a message listener. The worker is constructed
│   with the arguments the page passed
│   └── Reads the ad cues the player posts (`rollType` and `startTime` / `endTime` in media time).
│       Only a cue whose span (from 1 second before the start to the end) contains the playback
│       position is accepted (during an ad a second player cues its own ads on another timeline)
│   └── Unless the cue says it is the last creative of the pod (`podPosition` < `podCount` - 1,
│       or the value is unreadable), the ad is held open for 0.4 seconds waiting for the next cue
├── Ad element: when the main element stays paused while another element sounds (observed on VOD
│   ads), a GainNode is inserted there too, applying baseline * adGainOffset * (main volume / its volume)
├── While an ad is active the GainNode applies baseline * adGainOffset (dB → gain)
└── postMessage (`__twitch_channel_volume__`) → content.js

content.js (ISOLATED world content script, document_idle)
├── postMessage listener: receives LUFS / owner / ad state / attach results from page-bridge.js
├── Attach-result state: attach-failed sets audioUnavailable and a cause (element-taken /
│   audio-context); attached decides audioUnavailable / measurementUnavailable from takenElsewhere
│   (an element held by someone else is still in the page) and measuring (whether a measurement
│   chain exists). On a bridge reload the state is cleared and attach is sent again
├── While audioUnavailable, lufs notifications are discarded (another element's reading is neither
│   stored nor applied by Auto), the gain overlay is removed, and manual-gain, Auto-setting and
│   measurement-reset mutations are refused. Measurement is reset the moment it clears
│   (the bridge's windows still hold blocks from the other element)
├── URL classification (classifyTwitchUrl): live / vod / clip / none
├── Channel resolution:
│   ├── live: the login name from the URL (`login:<name>`) / the numeric ID once GraphQL user.id resolves
│   ├── vod: GraphQL owner.id (`<numeric>`) / fallback `vod-owner:<videoId>`
│   └── clip: GraphQL broadcaster.id / fallback `clip-owner:<slug>`
├── Matches the owner response against the current login / videoId / clip slug and merges the provisional ID's settings into the numeric ID
├── Automatic application of the stored gain (managed separately per Live/VOD/Clip kind)
├── LUFS auto-follow: while the per-channel × Live/VOD/Clip Auto setting is on, the baseline gain is
│   recomputed from the distance to Target LUFS, no more often than the popup's display period (1 second)
├── Gain overlay: a span is inserted as the **next sibling** of `.volume-slider__slider-container`. The mute wrapper and the slider container are siblings in a flex row inside the player controls, so the span sits directly to the right of the slider container. Visibility follows the parent `[data-a-target="player-controls"][data-a-visible]` toggle by itself (it is embedded inside the player controls). Shown only while gain ≠ 1.0 and an audio chain exists; the display is fixed to `%` and does not follow displayUnit
├── Measurement is seeded from the stored LUFS at startup, on SPA navigation and also once the owner ID resolves. Whether a re-seed is needed is decided from the channel ID after alias resolution and the kind.
│   The stored window count (`lastLufsWindows`) is passed with it and the bridge uses it as the seed's weight. A stored value with no window count (from before the extension update) is weighted at the bridge's floor
├── A measurement reset advances the epoch number before it is sent, and lufs notifications from an older epoch are discarded
├── On SPA navigation `mediaChanged` is sent first and `requestedAdActive` is cleared to stay aligned
│   with the bridge. The ad-indicator element present **at the last DOM read** is noted, and that
│   element itself is not treated as an indicator for the new media (a different element that appears
│   belongs to the new media; the note is dropped once the element leaves the DOM). The DOM is re-read
│   right after the navigation is handled, so an indicator that arrived in the same batch is reported there and then
│   (a measurement reset also happens within one media, so only this path discards cues)
├── DOM ad detection (`[data-a-target="video-ad-countdown"]` / `[data-test-selector="ad-banner-default-text"]`)
│   drives the ad gain only on media that have received no cue at all
├── SPA navigation: history.pushState/replaceState hook + popstate + MutationObserver
├── channelVolumes updates are delegated to the Service Worker's single queue, with cross-tab sync through onChanged
├── Handles chrome.tabs.sendMessage from the popup as `getState` / `setGain` / `setAutoApplyLoudness` / `resetMeasurement` / `resume`, and answers an unknown cmd with `unknown command` (options sends delete and clear-all straight to the Service Worker)
└── Storage
    ├── autoLoudnessSettings: { targetLufs, adGainDb, displayUnit, showGainOverlay,
    │     autoApplyLoudnessLiveDefault, autoApplyLoudnessVodDefault, autoApplyLoudnessClipDefault }
    ├── channelVolumes: { [channelId]: { name, login, gainLive, gainVod, gainClip,
          autoGainLive, autoGainVod, autoGainClip,
          autoApplyLoudnessLive, autoApplyLoudnessVod, autoApplyLoudnessClip,
          url, lastLufs, lastLufsRef, lastLufsWindows, autoGainRef, lastMeasuredAt, __fieldVersions } }
    ├── channelVolumeAliases: { [loginOrContentProvisionalId]: canonicalOwnerId }
    └── channelVolumeSequence: persistent counter for the field update order

audio-worklet.js (page context, loaded by page-bridge.js)
└── KMeanSquareProcessor: port.postMessage of the L²+R² average every blockSec (default 0.1)

channel-store.js (service worker helper)
├── Serialises the read-modify-write of channelVolumes through a single queue
├── Validates and applies gain / Auto / LUFS / delete / clear mutations
├── A measurement reset deletes only the lastLufs of the target kind and the lastLufsRef / lastLufsWindows that describe it (autoGainRef stays), and keeps the deletion as a state carrying an update number, so it survives ID merging
├── Persists the alias from a provisional ID to the numeric owner ID and resolves the canonical ID in every mutation
│   (name / login / url from the provisional side are not applied when the alias is forwarded)
├── Merges a Live row and a numeric owner row that share a login, and normalises the URL to the channel URL
└── Merges provisional and confirmed IDs by per-field persistent update numbers

settings-store.js (service worker helper)
├── Validates per-field mutations of autoLoudnessSettings
└── Serialises the read-modify-write through a single queue, preventing settings tabs from overwriting each other

utils.js (shared, popup/options + content.js + test.js. It is not loaded in the MAIN world, so page-bridge.js carries its own constants)
├── Constants: SETTINGS_KEY, SETTINGS_MUTATION_MESSAGE, CHANNEL_VOLUMES_KEY, CHANNEL_ALIASES_KEY,
│              CHANNEL_SEQUENCE_KEY, DEFAULT_TARGET_LUFS, DEFAULT_AD_GAIN_DB,
│              DEFAULT_AUTO_APPLY_LOUDNESS, LUFS_REFERENCE_VOLUME_1,
│              ABSOLUTE_GATE_LUFS, RELATIVE_GATE_LU, DISPLAY_UPDATE_INTERVAL_MS,
│              MIN_GAIN, MAX_GAIN
├── Gain utilities: gainToPercent, percentToGain, gainToDb, dbToGain, formatGain, calcGain,
│                  suggestedGain, resolveAutoApplySetting, resolvePreferredGain
├── URL classification: classifyTwitchUrl (TWITCH_RESERVED_PATHS excluded)
├── BS.1770: K_PRE_48K / K_RLB_48K coefficients + redesignBiquad (any sample rate)
├── LUFS: meanSquareToLufs, gatedIntegratedLufs (absolute + relative gating)
├── i18n: msg()
└── HTML escape: esc()

popup.html / popup.js
├── Channel name + kind badge (Live/VOD/Clip) + ad-detected badge
├── An icon button (36×36) on the channel row clears the stored LUFS for the current kind and the running measurement. Its label is visually hidden and used as the accessible name, with title for the hover text
├── The channel name is truncated to the row width, so the full text is carried in title
├── One-row grid of three cards: Integrated LUFS / Suggested gain / Current gain (layout shared with the sibling extensions)
│   ├── Suggested gain is computed from the distance to the target (100% while no gated value exists)
│   ├── The Suggested / Current display follows displayUnit (% / dB)
│   └── setCardValue splits the unit (LUFS / dB / %) into a <span class="unit"> shown small and grey
├── With Auto off, the apply button shows the Suggested gain in displayUnit; with Auto on, Current and Manual Volume are synced to the gain in force
├── While Auto is on and no Integrated value has been obtained yet, a Fallback badge is shown
├── Per-channel "Auto-follow LUFS" toggle for the kind currently being watched
├── A failed Auto save shows a localised error and re-fetches the latest state
├── While an Auto save is in flight, Apply / Manual controls are disabled, and content.js refuses manual gain mutations as well
├── While audioUnavailable / measurementUnavailable, the reason and the remedy are shown under the
│   channel row (three wordings, one per cause: the element is held elsewhere / the AudioContext
│   could not be created / the measurement path alone is unavailable)
│   (nothing is shown on a page with no resolved channel). Under audioUnavailable, Apply / Manual /
│   the Auto toggle / measurement reset are disabled and the three cards show unknown.
│   A gain-save failure takes precedence over this notice, and the hint row is left empty
├── Manual slider (the slider itself is 0–600%, the displayed value follows displayUnit) + 6 presets (0/50/100/200/400/MAX)
└── Loads SETTINGS_KEY at startup and reacts immediately to a unit change in options through storage.onChanged

options.html / options.js
├── Target LUFS slider (-30 to -6 LUFS, default -18)
├── Default LUFS auto-follow for all channels (separate for Live / VOD / Clip, default OFF)
├── Ad gain slider (-24 to +6 dB, default -6 dB)
├── Display unit (% / dB)
├── Gain overlay on/off toggle (default ON)
├── Saved Channels table (three Live / VOD / Clip columns, the last applied Auto gain while Auto is on, deletable)
├── Every settings control and deletion (clear all, the row ×) is disabled until the initial settings load completes
└── Saves only the item that changed through the Service Worker's settings mutation, synced through storage.onChanged
```

## i18n

- `_locales/ja/messages.json` — Japanese, the default
- `_locales/en/messages.json` — English
- The manifest's name/description use `__MSG_` references
- The popup/options UI strings use the `data-i18n` attribute + `chrome.i18n.getMessage`

## User workflow

1. Open a stream or a VOD → turn on "Auto-follow LUFS" for the current kind in the popup
2. Each time the Integrated LUFS reading updates, the gain follows the one that matches Target LUFS
3. "Reset measurement" deletes the stored LUFS for the current kind and restarts the running measurement from zero. Readings taken after the restart are stored as before
4. For a kind with Auto off, "Apply to channel" or Manual Volume stores the gain as before
5. During an ad break the Ad gain (default -6 dB) is applied on top
6. The Manual Volume slider can set any gain

## File overview

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. permissions: storage. host: twitch.tv |
| `page-bridge.js` | MAIN world. AudioContext + LUFS + fetch hook (GraphQL) + Worker hook (ad cues) + gain on the ad element |
| `audio-worklet.js` | K-weighted MS accumulation (100ms blocks) |
| `content.js` | ISOLATED world. Gain management, channel resolution, storage |
| `utils.js` | Shared constants and utilities (popup/options/test) |
| `popup.html` / `popup.js` | Popup UI |
| `options.html` / `options.js` | Settings page |
| `background.js` | Service worker (install defaults + single writer for channelVolumes / settings) |
| `channel-store.js` | channelVolumes mutations, serialisation, provisional-ID merging |
| `settings-store.js` | Per-field mutations of autoLoudnessSettings, serialisation |
| `_locales/` | i18n (ja, en) |
| `icons/` | 16/48/128 px PNG (Twitch purple 3-bar meter) |
| `gen_icons.py` | Icon generation (Python Pillow) |
| `gen_screenshots.py` | Screenshot generation (drawn directly with PIL, 640×400 ja/en → `docs/screenshots/`). `--check` writes nothing and looks, in order, at each component of the path to the tracked file and whether the image is a regular file → PNG structure (signature, chunks, the IDAT zlib stream) → chunk order → IHDR dimensions → the bytes outside IDAT → RGBA pixels (the decoder comes last). A difference is exit 1, an environment that cannot draw is exit 3. `--out <dir>` replaces the destination. An unknown argument, `--check` and `--out` given together (in either order), a repeated `--out`, a value shaped like a flag, and a destination that cannot become a directory (an existing non-directory, a link with no target, a non-directory parent) are refused with exit 2. An argument mistake is answered before a Pillow or typeface load failure (the import and the typeface resolution themselves happen at module load; the failure is carried forward and exits 3 after argument parsing) so that `--chek` does not overwrite. If any component of the path to the tracked file is not a real directory, neither drawing nor `--check` does anything and it exits 1. A refusal from the filesystem is not a traceback either — a destination named with `--out` is exit 2 (even when it is the tracked location), and the tracked location with no argument is exit 1. Each place that refused is named separately (the backup could not be read / the working directory could not be drawn into / the destination could not be written) |
| `pack.py` | Builds the Chrome Web Store zip (selection follows the reference graph from the manifest; `--list` prints the selection only) |
| `PRIVACY_POLICY.md` / `PRIVACY_POLICY_JA.md` | Privacy policy (for review and the README link, EN/JA) |
| `docs/en/security-audit.md` / `docs/ja/security-audit.md` | Security audit report (EN/JA) |
| `docs/screenshots/` | Output of `gen_screenshots.py`. Used by the README and by the store listing (not bundled into the extension). What is tracked is drawn with the M PLUS 1p faces in `tools/fonts/`. The generator uses those two faces and stops when they are absent (drawing with a different face would replace every one of the six images). The six are drawn to completion in a working directory before being moved, and if one move fails the tracked names are restored to what they were (regular file / link / absent) all the way back, so a stop during drawing or during replacement leaves the tracked files as they were. When the drawn name is a link pointing at a directory, the move would land inside it, so the replacement is refused first. Regular files are copied into the backup and links are placed as links (if one cannot be placed, nothing is moved and the two ends are named — the image and the backup — since copy2 is a single call that reads and writes and the caller cannot tell which end refused). When the restore itself is refused, the name that could not be restored and what was there before it (including a link's target) are stated, and if a name that had something before still exists the backup is kept and its location named (a name that had nothing before is deleted). A backup that could not be cleaned up does not exit 0 (exit 0 says only that this run left no backup behind, and says nothing about a non-PNG that was already there — `--check` counts only .png). CI redraws with `--check` and compares pixels |
| `tools/fonts/` | The M PLUS 1p faces used for drawing (Regular / Bold) and OFL.txt. Taken from `ofl/mplus1p` in google/fonts (commit `66a36c8`). Kept in the repository so that CI and each machine produce the same pixels |
| `test.js` | Unit tests (`node test.js`) — utils and the stores, plus content.js / page-bridge.js / popup.js / options.js / background.js run in a VM harness |

## Key design decisions

- **Own LUFS measurement**: Twitch provides no loudness API, so BS.1770-4 K-weighting + gated integrated LUFS are measured with the Web Audio API. An active measurement model, symmetric to yt-channel-volume's passive read of loudnessDb
- **AudioWorklet (not ScriptProcessor)**: ScriptProcessor is deprecated. The L²+R² accumulation over 100ms units runs on the worklet thread, and the windows are formed on the main thread
- **K-weighting filter coefficients**: based on the 48kHz coefficients of BS.1770-4; when AudioContext.sampleRate is not 48k, the filters are redesigned by an inverse bilinear transform followed by a fresh bilinear transform (redesignBiquad)
- **Indexed Integrated LUFS updates**: the LUFS stored for the current channel and kind is restored as initial samples worth the window count the value stands on (the floor and the cap are in "Measurement across sessions"). The last hour of blocks is held in a ring buffer, and values that pass the absolute gate are stored in a balanced tree carrying subtree sums and counts. The relative gate of -10 LU is derived from the post-absolute-gate mean each time, and the sum and count at or above the threshold are obtained in O(log n), so the two-stage gate holds regardless of input order. An ad break is left out of the Integrated statistics (so an ad does not contaminate the programme's representative value)
- **Measurement across sessions**: the stored LUFS is saved together with the window count it stands on (`lastLufsWindows`), and the next measurement is seeded with that many windows. Seeded as a single window, new audio arriving at 10 windows per second washes it away within a second, and Auto would set the gain from an Integrated value covering 0.4 seconds of the programme. The floor is 300 windows (30 seconds) and the cap is 1800 windows (3 minutes). With the cap at the ring buffer's own hour, the seed is a point mass at one value, so the relative gate pins to that value and the Integrated value would not move for over 20 minutes after the broadcaster genuinely lowers their level. At 3 minutes, watching for the same length of time reaches the seed's weight. A stored value with no window count (from before the extension update), and a window count that cannot be read, are weighted at the floor. The reported window count counts only windows that passed the relative gate, and the seed's share is replaced by the window count it arrived with — the padding up to the floor is not reported as measured, and windows the gate dropped and windows the ring buffer evicted are left uncounted. Which windows belong to the seed is decided from the gating window's sequence number rather than from its level (the index is keyed on level, so audio at the seed's level lands on the seed's node)
- **GainNode, not HTMLMediaElement.volume**: volume clips at 1.0. The GainNode provides 0.0–6.0 (0–600%)
- **MAIN world / ISOLATED world split**: Twitch's CSP forbids inline script, so the AudioContext and the fetch hook run in page-bridge.js (MAIN world, document_start)
- **Channel ID strategy**: 
  - Live uses the login from the URL (`login:<name>`) only before the owner response arrives, and merges into the same numeric ID as VOD / Clip once GraphQL `user.id` resolves
  - VOD / Clip use `owner.id` / `broadcaster.id` from the GraphQL response (numeric, immutable). The fallbacks are `vod-owner:<videoId>` / `clip-owner:<slug>`
  - A kind-specific provisional ID is used only while the numeric ID is unavailable, and a persistent alias canonicalises it afterwards
- **Provisional ID → confirmed ID transition**: page-bridge stamps the owner event with the content kind/id current at the time of the GraphQL request. content.js accepts only a response matching the current URL, and — even while the initial settings load is still running — merges `login:<name>` / `vod-owner:<videoId>` / `clip-owner:<slug>` into the numeric ID inside the Service Worker before switching currentChannel. Each gain / Auto / LUFS field resolves conflicts by the update order the single writer assigns, so the newest save from another tab survives. The provisional-to-canonical ID mapping is persisted in storage and resolved on content's reads and on the Worker's writes alike
- **Saved Channels channel invariant**: where a numeric owner ID and a login correspond, they are merged into one row, and the link stored and shown is always `https://www.twitch.tv/<login>`. Existing duplicate Live/VOD rows are migrated by a normalisation mutation on extension update
- **Single writer for channelVolumes**: the read-modify-write of the aggregate key is performed by the background.js → channel-store.js queue alone. Content scripts and options send mutation messages, so that LUFS cache saves from several tabs and Auto/manual setting saves do not overwrite each other with a stale whole object. Failures fall into three reasons. **An exception the store itself threw states a `reason`**: input from the caller that cannot be applied is `invalid-mutation`, and stored state that cannot carry the mutation (an alias cycle, an exhausted update number) is `stored-state-invalid`. A reject with no such statement is treated as coming from storage and returns `storage-update-failed` / `settings-update-failed` (the exception type does not separate them — `TypeError` is thrown by input validation and by a stored-state anomaly alike). A message with an unknown `type` gets no response, and the `type` that arrived is logged (responding would steal the response of a listener added later). The two scripts `background.js` pulls in with `importScripts` share one global, so top-level names must not collide (`node test.js` cross-checks the declarations in the two files)
- **Per-field settings saves**: options enables its controls once the initial load completes and sends only the settings field that changed to the background.js → settings-store.js queue. When several settings tabs change different items from a stale view, `autoLoudnessSettings` is merged into the newest value instead of being replaced entire
- **Show the screen after the stored values are in it**: popup / options hide the loading screen with `body.initializing` and remove it once i18n has been applied and the stored settings have been rendered (options removes it even when the load fails — a screen that never appears cannot be operated either). During initialisation, `transition: none !important` on `body.initializing *` (and `::before` / `::after`) stops every transition — enumerating selectors misses a control someone forgot to list, and without `!important` an individual selector wins on specificity. A transition starts running the moment its value is written, so the rest animates on screen and reads as "shown first, updated afterwards". A screen whose load failed names what it could not read (the stored settings). It answers about the channel list only when it could read that list, and two things count as having read it: the initial read, and a change notification (which carries the list itself). Until one of them arrives, neither "No saved channels" nor the channel table is shown as it stands in the markup. A change notification arriving after the failure is settled is not taken (it would put another tab's write onto a screen that is asking for a reload). A notification that arrived before then is already on screen and stays. Destructive actions (clear all, the row ×) become enabled only when the load succeeded, and the handler also refuses a mutation coming from an incomplete load. The load has a 3-second deadline, after which the screen is shown as if the load had failed (so a load that never settles does not leave the screen hidden). A read arriving after the deadline is not put on screen. What is on screen until the load writes to it is the markup's values, so the markup's initial values are kept equal to the defaults background.js installs (`node test.js` checks the two against each other)
- **Ad-break detection**: two independent signals are used
  - The player's cue: the media engine runs in a worker and posts a cue to the page for each ad it plays. The `Worker` constructor is wrapped to add a message listener, and cues carrying `rollType` and `startTime` / `endTime` are read. Those two are in the media time of the attached element and coincide with the end of the ad. During an ad a second player runs and cues its own ads on another timeline, so only a cue whose span contains the playback position is taken. **The acceptance window and the ad verdict are separate**: acceptance starts 1 second before the start, the in-ad verdict at the start — so a cue that arrives early does not put the Ad gain on the programme. The span is discarded once the ad is passed, so the same ad does not reopen when the playback position moves back
  - How long a cue is held: a cue belongs to a media and an element. A measurement reset (which also runs on a popup action or when the owner ID is confirmed) does not discard it; two events do. **Each of them discards everything that event invalidates** — clearing one side alone leaves a state where neither the cue nor the DOM indicator has any effect, or one where the previous media's indicator survives as the new media's ad
    - Element replacement: the cue times and whether this media is cued at all (`adCueSeen`)
    - `mediaChanged` (SPA navigation): the above plus the state of the DOM indicator. content.js clears `requestedAdActive` as well to stay aligned with the bridge, and further **notes the ad-indicator element present at the moment of the navigation, and does not treat that element itself as an indicator for the new media**. At the instant of the navigation the old player is still in the page, and another DOM change during that time would have the observer report the old indicator as the new media's ad. It is held as an element rather than a boolean because MutationObserver sometimes folds the removal of the old element and the addition of the new one into one callback, and then the moment the indicator disappeared is not observable. The note is dropped once the element leaves the DOM (the same element put back is taken as belonging to the new media)
      What is noted is **the element present at the last DOM read**, and the page is not re-read at the moment of the navigation. An implementation that re-reads has its "when to read" racing the page's own ordering (the player is replaced in the same task, the page's own popstate listener runs first, History calls on the same URL are mixed in), so the design has no read moment at all. The DOM is always read before the navigation is handled, so an indicator present there belongs to the old media. Three pieces make that hold:
      - The `pushState` / `replaceState` hooks re-read the DOM before the URL moves (an indicator not yet observed is noted as belonging to the old media)
      - The MutationObserver watching for navigation is registered before the ad-indicator observer (the batch carrying the navigation is read against the new media)
      - The DOM is re-read at the end of handling the navigation (an indicator that arrived in the same batch is reported without waiting for the next DOM change)
  - Gaps within a pod: when one ad break holds several creatives, the playback position advances between the end of one creative and the next cue. The break is closed at its end only when the cue says it is the pod's last creative (`podPosition` >= `podCount` - 1); otherwise (it indicates a middle position, or the value cannot be read) the next cue is awaited for 0.4 seconds. If none arrives, the break closes there
  - DOM: the presence of `[data-a-target="video-ad-countdown"]` / `[data-test-selector="ad-banner-default-text"]`
- **Choosing between the two signals**: a cue arrives at practically the same time as the ad's first audio, and marks the end of the ad exactly. The DOM indicator appears later than the ad's first audio and can stay in the DOM after the ad. So a media that has received even one cue opens and closes on cues alone, and a media that receives no cue (a client-side ad on a VOD) falls back to the DOM indicator
- **The ad element**: an ad on a VOD plays in a separate `<video>` while the main element stays paused, and that element ignores the main element's volume and sounds at its own. When the main element is paused and another element is sounding, a `MediaElementSource` + `GainNode` is inserted on that element too and `baseline * adGainOffset * (main volume / that element's volume)` is applied. The gain returns to 1.0 when the ad ends, and the chain is detached once the element leaves the DOM. No measurement is taken from this element
- **Behaviour during an ad**: baseline × adGainOffset (dB → gain) is applied to the GainNode. Integrated measurement is skipped during the ad, holding the programme's value. The block at the moment the ad ends can contain ad audio, so after the ad the 4 windows it takes for the gating window to leave the ad are excluded from Integrated as well. On the ad-start side the DOM marker appears later than the ad's first audio, so the last 5 windows (0.5 seconds) are withdrawn at detection time. If the withdrawn span contains windows the boundary skip already excluded, that count is subtracted from the number withdrawn — a window that was never added cannot be withdrawn, and passing the requested number through would delete a programme window instead. The number of windows withdrawn matches the marker delay that was observed — deleting programme windows too takes that level out of the gate's population and moves the Integrated value
- **Cancelling the player volume**: the measurement tap sits directly after `sourceNode`, and Twitch's player volume (`video.volume`) applies upstream of it. Each block's MS is divided by volume², keeping the Integrated LUFS referenced to volume 1.0. Lowering the slider does not raise the computed gain. A gating window that straddles a volume change is excluded by the same mechanism as an ad boundary
- **The reference a stored value carries**: only a value taken against volume 1.0 carries a reference name. The stored LUFS merges with `lastLufsRef` and the stored Auto gain with `autoGainRef`, each by its own field's update number (sharing one number would swap the value/reference pairs during ID merging). The window count `lastLufsWindows` belongs to the LUFS side like `lastLufsRef`, and the one from the side whose value won is kept. A value with no reference (stored before the extension update) is not used as an initial measurement sample, and an Auto gain with no reference is not applied at startup. A manual gain is the viewer's own setting and is applied as before
- **Suggested gain while there is no reading**: while no gated value exists, `suggestedGain` returns 1.0 and suggests no gain increase
- **createMediaElementSource**: callable once per `<video>`. It fails when another extension (FrankerFaceZ Compressor and the like) took it first. A video that failed is excluded through a `WeakSet` and the attach falls back to another video. On a video that could not be attached the GainNode is outside the player's audio path too, so content.js receives `attach-failed`, shows the reason and the remedy in the popup, and withdraws the display of the gain in force (the overlay). Even when the fallback attach succeeds, the audio keeps sounding through the held element for as long as it remains in the page, so the notice is kept up through `takenElsewhere` on `attached`
- **When the AudioContext cannot be created**: a failed attempt is not cached, and the next attach builds it again. The failure notice is sent once, when the state changes (not on every retry). `cause: 'audio-context'` distinguishes it from a conflict with another extension, and the popup shows a different wording asking for a reload
- **Readings while there is no audio path**: a lufs arriving after `attach-failed` or during `takenElsewhere` is not from the element the viewer is hearing, so it is discarded (neither stored nor followed by Auto). Measurement is reset at the moment it recovers — the bridge's ring buffer still holds blocks from the other element
- **When only the measurement path is down**: the GainNode is in the path even when the worklet fails to load or connect, so `measuring: false` on `attached` reports that measurement alone is unavailable, and a different wording states that volume control still works
- **Attach retries**: the video element does not exist at document_start, so `scheduleAttach()` loops at 1s intervals. `clearStaleAttachment()` detects a video that left the DOM and allows a re-attach (for the case where Twitch's SPA swaps the video). content.js also sends `attach` again on SPA navigation
- **Where the measurement chain is connected**: `attach()` awaits `ensureContext()`, and that await covers the resolution of `audioWorklet.addModule()`, so whether the worklet is available is settled by attach time. An attach whose load failed reports `measuring: false`, and no measurement path is added to that attachment afterwards
- **SPA navigation**: three layers — the history.pushState/replaceState hooks + popstate + MutationObserver. A URL change triggers resetMeasurement + a fresh kind classification + another `attach`
- **The epoch number of a measurement reset**: content.js advances the epoch number each time it sends resetMeasurement, and page-bridge stamps that number on the lufs notifications that follow. content.js discards a notification older than the current epoch, so a block page-bridge computed before the reset was sent does not revive the stored LUFS
- **Separate gain per Live/VOD/Clip**: a stream's sound changes with the time of day, so each kind is managed separately. The gain of a past VOD on the same channel is not copied onto the current Live
- **Twitch reserved paths**: `/directory`, `/settings`, `/videos`, `/p`, `/jobs` and the like are excluded through TWITCH_RESERVED_PATHS so they are not misread as a live channel
- **Reserved names**: what Chrome refuses under "Load unpacked" is a name beginning with `_` directly at the root, while `_metadata` and the like in a subdirectory do load (`_locales` is allowed even at the root). The scan in `test.js` is stricter: within the tree the package is built from (the repository minus `.git` / `node_modules` and the root-level `work/` / `.claude/`), it reports such a name at any depth. `docs/` and other directories that stay out of the zip are covered too
- **Packaging selects by reference graph**: `pack.py` selects what the manifest reaches (the js and css of content_scripts / web_accessible_resources / service_worker / options_page and options_ui.page / action.default_popup / icons and action.default_icon), plus the `<script src>` and the `<link href>` css of those HTML files, a worker's `importScripts`, and `_locales/<locale>/messages.json` — nothing else. A file nothing references stays out whatever its extension. Paths go through a single resolver, and an absolute path, a `..`, or a symlink (including one on an intermediate directory) whose target leaves the package is made to fail (neither a broken zip nor a zip carrying an outside file is produced silently)
- **CSP**: the AudioWorklet module is exposed through web_accessible_resources. page-bridge shares the window with the page's own scripts in the MAIN world, and the page can send it any command including init, so it takes no module URL: it reads the extension origin from its own stack frame and loads `<origin>/audio-worklet.js`. With no origin available it loads no module
- **NaN/Infinity guard**: a reading of infinity or NaN falls back to gain 1.0

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

# Python syntax check (leaves no __pycache__ behind)
python3 -B -c "import ast,pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('.').glob('*.py')]"

# Package for Chrome Web Store
python3 pack.py

# List the files that get bundled (writes no zip)
python3 pack.py --list
```

## Conventions

- Documentation is maintained in English and Japanese, English first: `README.md` / `README.ja.md` at the root, `docs/en/` / `docs/ja/` under `docs`. Both members of a pair carry the same headings in the same order
- `PRIVACY_POLICY.md` and `PRIVACY_POLICY_JA.md` keep those names. The Chrome Web Store listing links to `PRIVACY_POLICY.md` by path
- `CLAUDE.md` is English only and has no Japanese counterpart
- Commits: **subject and body entirely in English** (Conventional Commits). **PR title and body entirely in English as well**, matching the repository's default language. The global CLAUDE.md rule about Japanese bodies does not apply to this project
- Issue templates are one English set, with a note at the top saying Japanese is welcome

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- Do not run `python3 -m py_compile` at the root of the unpacked extension. It generates the `__pycache__` Chrome refuses, so use the AST parse above for the Python syntax check (the range `node test.js` scans is in "Reserved names")
- `popup.html` / `options.html` stay in a shape the i18n extractor can read: no HTML comments, `<template>`, `<textarea>` / `<iframe>` / `<xmp>` / `<noembed>` / `<noframes>` / `<noscript>` / `<plaintext>`; the raw text elements the pages do use — `<title>` / `<style>` / `<script>` — are closed with `>` directly after the name (a form where the name continues, such as `</titles>`, is a different element and swallows what follows without closing the raw text); `data-i18n` is written lowercase and quoted; and an element carrying the attribute holds text alone (`applyI18n` assigns to `textContent`). The mapping from a key to the element carrying it (tag name, `id`, `class` tokens) is pinned by a snapshot in `node test.js`
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy) — content.js sends `resume` on first click capture
- BS.1770 reference is 48 kHz. Chrome's AudioContext is normally 48000, and a varying sample rate is handled by redesignBiquad
- Storage keys: `autoLoudnessSettings` (target LUFS, ad gain, display unit, per-kind Auto defaults), `channelVolumes` (per-channel saved gains + per-kind Auto + the lastLufs cache and its window count), `channelVolumeAliases` (provisional ID → canonical ID), `channelVolumeSequence` (persistent update number)
- Storage format: `channelVolumes.{id}` = `{ name, login, gainLive, gainVod, gainClip, autoGainLive, autoGainVod, autoGainClip, autoApplyLoudnessLive, autoApplyLoudnessVod, autoApplyLoudnessClip, url, lastLufs: { live, vod, clip }, lastLufsRef: { live, vod, clip }, lastLufsWindows: { live, vod, clip }, autoGainRef: { live, vod, clip }, lastMeasuredAt, __fieldVersions }`
- The legacy single fields are expanded and deleted by channel-store.js at write time (`gain` → `expandLegacyGain`, `autoApplyLoudness` → `expandLegacyAuto`). On the read side, `extractGainForKind` is a fallback for reading an entry before expansion, and writes nothing back
- The popup polls getState every `DISPLAY_UPDATE_INTERVAL_MS` and updates the LUFS / Suggested / Current cards. The Auto gain updates at that period at most. The Manual slider syncs to the gain in force only while Auto is on, and the ordinary polling with Auto off leaves it alone. With Auto off it syncs on the first display, on "Apply to channel", on an Auto toggle, on a display-unit change and on user input. The measurement itself does not depend on the popup being open, and runs for as long as a Twitch page is open
- When reloading the extension invalidates chrome.runtime, the popup shows `reloadPageNeeded` and asks for F5
- Diagnosing the measurement pipeline: read the `[TCV]` logs in the DevTools Console. They appear in the order `waiting for <video>` → `attached to video` → `measurement chain ready` → `first measurement block received`. Stopping at `createMediaElementSource failed` is a conflict with another extension (a technical limit). That state surfaces in the popup notice and in `getState`'s audioUnavailable. Later retries print `no attachable <video>; the player audio is held elsewhere` (`waiting for <video>` appears only when the element itself is absent). `audio context unavailable` / `audio context resume failed` / `audio context stayed <state> after resume` diagnose the same path
- Diagnosing ad boundaries and volume changes: follow these in the Console — `[TCV] ad detected in DOM` (the DOM detection and `video.currentTime`), `[TCV] ad cue from the player` (the cue's `rollType`, the span in media time, the playback position when it arrived, the position within the pod), `[TCV] ad element attached` (that element's volume and the main volume when the ad element was connected), `[TCV] gate boundary` / `[TCV] gate resumed` (the reason for the boundary, volume, muted, playback position, the number of windows excluded and the LUFS of the last 4 windows), `[TCV] ad start rollback` (the number of windows requested, the number subtracted for overlapping the boundary skip, the number withdrawn and the LUFS of each — `exhausted` says whether the requested number of windows could be walked back, and false means the start of measurement is near and the span stops there). A skip cut short for another reason carries its exclusion count up to that point into `superseded` / `droppedBefore` on the next `gate boundary`
- Diagnosing a failed action: a failure is left named, on the screen it happened on. The page side (the Console of the Twitch tab) has `[TCV] failed to save gain` (which names the channel it tried to save, not the one on screen after a navigation) / `[TCV] failed to save Auto setting` / `[TCV] failed to reset measurement`, plus the terminal handlers' `[TCV] failed to handle a bridge message` / `[TCV] failed to handle a route change` / `[TCV] failed to start up` / `[TCV] unknown command`. The popup side (the popup's DevTools) has `[TCV] suggested gain request failed` / `[TCV] gain request failed` / `[TCV] Auto setting request failed` / `[TCV] measurement reset request failed`, carrying the reason content.js returned. The options side (the settings page's DevTools) has `[TCV] failed to delete the channel` / `[TCV] failed to clear the saved channels`. The Service Worker side (the extension's Service Worker DevTools) has `[TCV] channelVolumes mutation failed` / `[TCV] settings mutation failed` (from storage), `[TCV] channelVolumes mutation rejected as invalid` / `[TCV] settings mutation rejected as invalid` (the caller's input), `[TCV] channelVolumes mutation blocked by the stored state` / `[TCV] settings mutation blocked by the stored state` (the stored state), and `[TCV] unknown message type`

## Existing extensions (reference)

| Extension | Approach | Persistence | Notes |
|---------|------|--------|------|
| Volume Sound Normalizer Pro | DynamicsCompressor + GainNode (no LUFS measurement) | YT/Twitch channelId | Reference for AudioNode wiring |
| TwitchPerChannelAudio | React internal mediaPlayerInstance.setVolume() | login name | Example of React fiber access (fragile) |
| FrankerFaceZ Compressor | Global DynamicsCompressor | Global | Not per-channel |
| Hearably Twitch Volume Booster | MSE intercept + multiband compressor | Per tab | Closed source |

This project combines its own LUFS measurement without relying on an official Twitch API, per-kind persistence, and a separate gain during ad breaks, targeting an area the existing implementations do not cover.
