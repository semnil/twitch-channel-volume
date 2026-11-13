# Clip decisions

> 日本語版は [clip.ja.md](clip.ja.md) を参照してください.

Closed decisions about Twitch clips. The rules in force are in `AGENTS.md`: "Media another origin serves" and "A clip is not volume-adjusted" under "Key design decisions", and the clip fields under "Development notes".

## A clip is left to the player

- **Decision** (2026-08-30): a clip plays through the player's own audio path. The extension takes no clip element, keeps no gain, Auto setting or measurement for a clip, and resolves no channel for it ([#42](https://github.com/semnil/twitch-channel-volume/pull/42)).
- **Reason**: `AGENTS.md`, "Media another origin serves" and "A clip is not volume-adjusted".
- **Rejected**:
  - Asking for the clip in CORS mode by setting `crossorigin` on the element. The clip then does not load (`AGENTS.md`, "Media another origin serves").
  - Making the clip same-origin: the page fetches the clip afresh (`fetch(url, { cache: 'reload' })`), wraps the answer in a `Blob` and puts that in the element's `src`. A blob the page made belongs to the page's own origin, which puts the clip within reach of Web Audio. It was not taken: the clip is downloaded twice, and the extension would be replacing a `src` that Twitch's player manages. What it does on a long clip, across a quality switch and across a seek is not known.
- **Reopen when**: a clip's gain or Auto is asked for again. The work starts from the three unknowns of the blob approach above. The weight of a clip's seed starts from "A clip's stored level outlasted the clip carrying it" in [#41](https://github.com/semnil/twitch-channel-volume/pull/41): a shorter floor does not bind, because the weight is the larger of the floor and the stored window count, so what a clip needs is a cap; and dropping the seed for clips was turned down for what it does to a clip's opening seconds. The Clip column, the Clip default and the stored clip fields that #42 removed come back with it.
- **A clip that is still silent**: `createMediaElementSource` can be called once per element, and an element that has been taken does not give its audio back to the player, so this version leaving a clip alone says nothing about any other script on the page. Where a clip is silent with this version loaded, the first thing to look for is a second copy of the extension on the same page: an older version from the store beside an unpacked one, or the script of a version that was reloaded without the page being reloaded (`page-bridge.js` runs in the MAIN world at `document_start`, so the old script stays in the page). In the page's Console, `[TCV] worklet module loaded` printed twice says two copies are running, and `[TCV] attached to video` on a clip page says one of them took the element, which this version does not print for a clip's element.
- **Harm record**: the first fix for a clip that played in silence went to the suspended `AudioContext` ([#41](https://github.com/semnil/twitch-channel-volume/pull/41)) and did not bring the sound back: the silence came from the source node of an element whose media another origin serves. A silent element is looked at for that first.

## What an earlier version stored for a clip is deleted with the fields

- **Decision** (2026-08-31): the next write of `channel-store.js` drops the clip fields, and deletes with them a row that held nothing else and the `clip-owner:<slug>` alias. Deleting stored rows is a destructive operation, and it was approved explicitly as one ([#42](https://github.com/semnil/twitch-channel-volume/pull/42)). What counts as a row holding no value is in `AGENTS.md`, "Development notes".

## The cross-origin refusal is logged at info, by its cause

- **Decision** (2026-08-30): `content.js` logs `[TCV] player audio unavailable` at info where the cause is `cross-origin`, and at warn for every other cause ([#42](https://github.com/semnil/twitch-channel-volume/pull/42)).
- **Reason**: Chrome collects a content script's warnings as errors of the extension. Each clip that was opened logged the warning, and it was reported as a defect. `cross-origin` is the one cause that leaves the viewer nothing to do.
- **Rejected**: deciding by the kind of page (`kind === 'clip'`). On an SPA navigation `content.js` sends `attach` before it resolves the channel and the kind of the new URL, so a condition on the kind races the refusal it is meant to classify.

## A `data:` URL is read as cross-origin, and that is left

- **Decision** (2026-08-31): `mediaReach` in `page-bridge.js` reads an element whose media is a `data:` URL as served by another origin, so the element is left to the player. This is not changed.
- **Reason**: the code assumes Twitch gives a `<video>` no `data:` URL, so the case does not arise. Where it did, the error falls on the safe side: the element is not taken, and the player's audio stays as it is.
