# Privacy Policy — Twitch Channel Volume

[日本語版はこちら (Japanese)](PRIVACY_POLICY_JA.md)

Last updated: 2026-11-02

## Overview

Twitch Channel Volume is a Chrome extension that balances Twitch volume per channel to a target loudness. It measures the playing audio with the ITU-R BS.1770 loudness standard and, with auto-follow on, sets the volume (gain) to the one that brings the measured loudness to the target LUFS. It also remembers a volume for each channel and applies it when auto-follow is off. This privacy policy explains what data the extension handles, how it is used, and where it is stored.

## Data Collected and Purpose

### Channel Volume Settings

- **What**: Twitch channel identifiers (the numeric owner ID / broadcaster ID once the page has provided it; the login name or video ID until then), display names, channel URLs, the gain values you set per kind (Live / VOD), whether auto-follow is switched on for that channel in each of them, the gain auto-follow works out for each of them, and a cache of the most recent loudness measurement with the time it was taken, the number of measurement windows behind it, and a note that it is expressed as if the player's own volume were at full, and, for each kind, the time you last reset the measurement. Alongside these, the extension keeps the mapping from a provisional identifier to the numeric one and a counter that orders field updates. Once the page has provided a channel's numeric ID, the mapping holds an entry for the login name of every live channel you open and of every saved channel, and for the video ID of every VOD you open, whether or not anything is saved for that channel. Deleting a saved channel removes its entries from the mapping. The entries of a channel with nothing saved stay until Clear all on the settings page, which removes them all.
- **Purpose**: Used to automatically apply your preferred volume, or with auto-follow on the gain that brings the channel to the target loudness, when you open a stream or VOD from a saved channel, to start the next loudness measurement from the last one, and to keep a measurement taken before a reset from being saved again after it.
- **Storage**: Saved locally in `chrome.storage.local` on your device. Not synced to your other devices, and never transmitted to any external server.

### Extension Preferences

- **What**: Target LUFS level, ad-break gain (dB), display unit (% or dB), gain overlay toggle, and the auto-follow default for each kind (Live / VOD).
- **Purpose**: Customize the extension's behavior according to your preferences, and, when Chrome sync is turned on, keep it the same on every computer where you use the extension while signed in to Chrome with the same Google account.
- **Storage**: Saved in `chrome.storage.sync`. When Chrome sync is turned on, Chrome stores these preferences with your Google account and carries them to the other computers where you use the extension while signed in to Chrome with the same Google account; with Chrome sync off they stay on this device. They name no channel and no page you visited. The extension developer does not receive them.

### Loudness Measurement of Playing Audio

- **What**: Momentary / Short-term / Integrated LUFS values computed from the playing `<video>` element via the Web Audio API.
- **Purpose**: Display loudness information, calculate the suggested gain, and work out the gain auto-follow applies.
- **Storage**: No audio waveform or audio data is stored. The Momentary and Short-term values are held in memory only while the page is open. The Integrated value is saved without any action from you: while a channel is identified, its most recent value is written to that channel's settings for the kind you are watching, at most once every five seconds, along with the time it was taken, how many measurement windows the value rests on, and a note recording that the value is expressed as if the player's own volume control were at full (it is converted for you, whatever you have the control set to). While auto-follow is on for that kind, the gain the value produced and the same note for that gain are written with it. "Apply to channel" saves a gain; it is not what saves the measurement.

### Twitch Page Data (read-only)

- **What**: GraphQL responses issued by Twitch itself (to obtain the channel's owner ID / broadcaster ID, login name and display name), the ad cues the player posts to its own page (to learn when an ad break starts and ends), and the presence of the player's ad indicator in the page.
- **Purpose**: Obtain a persistent channel identifier, name the channel in the popup and the settings page, and detect ad breaks so that the ad-break gain applies during them.
- **Storage**: GraphQL responses and ad cues are not stored. Only the required values are extracted and used: the channel's numeric ID, its login name and display name, the identifier of the content the request was made for (login name for a live channel, video ID for a VOD), and the start, end, roll type (pre-roll / mid-roll) and the position and count within the pod of an ad break. The numeric ID is the key a channel's settings are kept under, and the display name, the login name and the channel URL built from it are saved in them. The content identifier is saved as well: it stands in as that key until the numeric ID arrives, and once it arrives it stays in the map that points it at the numeric one. What never leaves memory is the ad break itself — its start, end, roll type and pod position are used while the page is open and are not written to storage. Ad identifiers, advertiser names and tracking URLs carried by a cue are not read.

## Data NOT Collected

- The extension does **not** collect analytics or telemetry.
- The extension does **not** record the pages you visit on sites other than Twitch. The pages you open on Twitch are recorded only as far as the mapping under Channel Volume Settings goes: the login name of each live channel and the video ID of each VOD, each with the channel's numeric ID. The mapping holds no page title and no time of the visit.
- The extension does **not** record or transmit audio or video data itself.
- The extension developer does **not** receive, store, or have access to any of your data.
- No data is sold, shared with third parties, or used for advertising.

## Where Data Is Sent

Nowhere the extension sends it. This extension makes **no external network requests**. GraphQL responses are only read from the traffic that the Twitch page itself issues; the extension does not initiate any new outbound transmission. All data remains on your device, except the extension preferences described above, which Chrome sync — not the extension — carries between the computers where you are signed in to Chrome with the same Google account, when you have it turned on.

## Data Storage and Security

- Channel volume settings and loudness measurements are stored in `chrome.storage.local`, which is accessible only to this extension. They are not synced across devices or stored in the cloud.
- The extension preferences are stored in `chrome.storage.sync`, which is also accessible only to this extension. With Chrome sync turned on, Google stores them with your Google account under [Google's Privacy Policy](https://policies.google.com/privacy) and syncs them to the other computers where you are signed in to Chrome with the same Google account; the extension developer has no access to them.
- Uninstalling the extension removes the data it stored on that device.

## Permissions

| Permission | Reason |
|---|---|
| **storage** | Save channel volume settings locally, and user preferences in Chrome's synced storage |
| **host_permissions** (`twitch.tv`) | Inject content scripts on Twitch pages to measure the playing audio and control volume via the Web Audio API |

## Remote Code

This extension does **not** use remote code. All JavaScript is bundled locally within the extension package. The `page-bridge.js` content script runs in the page's main world (`"world": "MAIN"`) to control the AudioContext and read Twitch page data — this is local code, not remotely fetched.

To hear the player's ad cues, `page-bridge.js` wraps the page's `Worker` constructor and adds a message listener to each
worker the page creates. The worker itself is created from the argument the page passed; no worker script is read,
modified or replaced, and no code is fetched from any server.

## Single Purpose

This extension has a single purpose: **balance Twitch volume per channel to a target loudness, and remember each channel's volume**, using ITU-R BS.1770 loudness measurement of the playing audio and the Web Audio API.

## Third-Party Dependencies

None. The extension contains no external libraries, SDKs, CDNs, or analytics tools.

## Changes to This Policy

Updates will be posted to this page with a revised date. Continued use of the extension after changes constitutes acceptance.

## Contact

If you have questions about this privacy policy, please open an [issue](https://github.com/semnil/twitch-channel-volume/issues) on the GitHub repository.
