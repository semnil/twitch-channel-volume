# Suspended-context decisions

> 日本語版は [suspended-context.ja.md](suspended-context.ja.md) を参照してください.

Closed decisions about what the extension does while its `AudioContext` is suspended. The rules in force are in `CLAUDE.md`, "When the AudioContext is suspended". Both decisions below are limits that were seen and left; their reasons are in [#41](https://github.com/semnil/twitch-channel-volume/pull/41), "Not covered here".

## The element is taken while the context is suspended

- **Decision** (2026-08-30): `attach()` calls `createMediaElementSource` without looking at the context's state, while `attachAdElement()` refuses unless the state is `running`. The two paths are left deciding the same operation differently. Making `attach()` wait was raised in review and is correct as far as it goes; it was not taken ([#41](https://github.com/semnil/twitch-channel-volume/pull/41)).
- **Reason**: `createMediaElementSource` can be called once per element, so an `attach()` that waits for the context to run gives another extension that takes the same element the seconds until the viewer's first gesture. How that race falls is not known.
- **Reopen when**: the race is known. In a browser profile that also has an extension taking the same element, compare whether this extension's attach succeeds with the wait and without it.

## The display is left as it is while the context is suspended

- **Decision** (2026-08-30): between the page load and the viewer's first gesture, the popup and the gain overlay show a gain that is not yet in the audio path. This is left as it is, although the comment on `updateGainOverlay` in `content.js` says the badge reports the gain the player runs at ([#41](https://github.com/semnil/twitch-channel-volume/pull/41)).
- **Reason**: closing it takes one more popup notice, worded in both locales, and whether to show the viewer that the extension is waiting for a gesture is a decision about the interface rather than the repair of a defect. #41 shortened the stretch: any gesture ends it, where only a click did.
