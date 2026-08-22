# Privacy Policy — Twitch Channel Volume

[日本語版はこちら (Japanese)](PRIVACY_POLICY_JA.md)

Last updated: 2026-08-22

## Overview

Twitch Channel Volume is a Chrome extension that remembers and auto-applies volume (gain) settings per Twitch channel. It measures the playing audio with the ITU-R BS.1770 loudness standard and adjusts volume automatically based on a target LUFS. This privacy policy explains what data the extension handles, how it is used, and where it is stored.

## Data Collected and Purpose

### Channel Volume Settings

- **What**: Twitch channel identifiers (the numeric owner ID / broadcaster ID once the page has provided it; the login name, video ID or clip slug until then), display names, page URLs, the gain values you set per kind (Live / VOD / Clip), and a cache of the most recent loudness measurement with the time it was taken. Alongside these, the extension keeps the mapping from a provisional identifier to the numeric one and a counter that orders field updates.
- **Purpose**: Used to automatically apply your preferred volume when you open a stream, VOD, or clip from a saved channel.
- **Storage**: Saved locally in `chrome.storage.local` on your device. Never transmitted to any external server.

### Extension Preferences

- **What**: Target LUFS level, ad-break gain (dB), display unit (% or dB), gain overlay toggle, and the auto-follow default for each kind (Live / VOD / Clip).
- **Purpose**: Customize the extension's behavior according to your preferences.
- **Storage**: Saved locally in `chrome.storage.local` on your device.

### Loudness Measurement of Playing Audio

- **What**: Momentary / Short-term / Integrated LUFS values computed from the playing `<video>` element via the Web Audio API.
- **Purpose**: Display loudness information and calculate the suggested gain.
- **Storage**: No audio waveform or audio data is stored. The Momentary and Short-term values are held in memory only while the page is open. The Integrated value is saved without any action from you: while a channel is identified, its most recent value is written to that channel's settings for the kind you are watching, at most once every five seconds, along with the time it was taken and — while auto-follow is on for that kind — the gain it produced. "Apply to channel" saves a gain; it is not what saves the measurement.

### Twitch Page Data (read-only)

- **What**: GraphQL responses issued by Twitch itself (to obtain the channel's owner ID / broadcaster ID, login name and display name), the ad cues the player posts to its own page (to learn when an ad break starts and ends), and the presence of the player's ad indicator in the page.
- **Purpose**: Obtain a persistent channel identifier, name the channel in the popup and the settings page, and detect ad breaks.
- **Storage**: GraphQL responses and ad cues are not stored. Only the required values are extracted and used: the channel's numeric ID, its login name and display name, the identifier of the content the request was made for (login name for a live channel, video ID for a VOD, slug for a clip), and the start, end, roll type (pre-roll / mid-roll) and the position and count within the pod of an ad break. The numeric ID is the key a channel's settings are kept under, and the display name, the login name and the channel URL built from it are saved in them. The content identifier is saved as well: it stands in as that key until the numeric ID arrives, and once it arrives it stays in the map that points it at the numeric one. What never leaves memory is the ad break itself — its start, end, roll type and pod position are used while the page is open and are not written to storage. Ad identifiers, advertiser names and tracking URLs carried by a cue are not read.

## Data NOT Collected

- The extension does **not** collect browsing history, analytics, or telemetry.
- The extension does **not** track which pages you visit on Twitch or any other site.
- The extension does **not** record or transmit audio or video data itself.
- The extension developer does **not** receive, store, or have access to any of your data.
- No data is sold, shared with third parties, or used for advertising.

## Where Data Is Sent

Nowhere. This extension makes **no external network requests**. GraphQL responses are only read from the traffic that the Twitch page itself issues; the extension does not initiate any new outbound transmission. All data remains on your device.

## Data Storage and Security

- All settings are stored in `chrome.storage.local`, which is accessible only to this extension.
- No data is synced across devices or stored in the cloud.
- Uninstalling the extension removes all locally stored data.

## Permissions

| Permission | Reason |
|---|---|
| **storage** | Save channel volume settings and user preferences locally |
| **host_permissions** (`twitch.tv`) | Inject content scripts on Twitch pages to measure the playing audio and control volume via the Web Audio API |

## Remote Code

This extension does **not** use remote code. All JavaScript is bundled locally within the extension package. The `page-bridge.js` content script runs in the page's main world (`"world": "MAIN"`) to control the AudioContext and read Twitch page data — this is local code, not remotely fetched.

To hear the player's ad cues, `page-bridge.js` wraps the page's `Worker` constructor and adds a message listener to each
worker the page creates. The worker itself is created from the argument the page passed; no worker script is read,
modified or replaced, and no code is fetched from any server.

## Single Purpose

This extension has a single purpose: **measure, remember, and auto-apply per-channel volume settings on Twitch** using ITU-R BS.1770 loudness measurement and the Web Audio API.

## Third-Party Dependencies

None. The extension contains no external libraries, SDKs, CDNs, or analytics tools.

## Changes to This Policy

Updates will be posted to this page with a revised date. Continued use of the extension after changes constitutes acceptance.

## Contact

If you have questions about this privacy policy, please open an [issue](https://github.com/semnil/twitch-channel-volume/issues) on the GitHub repository.
