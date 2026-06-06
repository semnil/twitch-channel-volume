# Privacy Policy — Twitch Channel Volume

[日本語版はこちら (Japanese)](PRIVACY_POLICY_JA.md)

Last updated: 2026-06-06

## Overview

Twitch Channel Volume is a Chrome extension that remembers and auto-applies volume (gain) settings per Twitch channel. It measures the playing audio with the ITU-R BS.1770 loudness standard and adjusts volume automatically based on a target LUFS. This privacy policy explains what data the extension handles, how it is used, and where it is stored.

## Data Collected and Purpose

### Channel Volume Settings

- **What**: Twitch channel identifiers (login name for live, owner ID / broadcaster ID for VODs and clips), display names, page URLs, the gain values you set per kind (Live / VOD / Clip), and a cache of the most recent loudness measurement.
- **Purpose**: Used to automatically apply your preferred volume when you open a stream, VOD, or clip from a saved channel.
- **Storage**: Saved locally in `chrome.storage.local` on your device. Never transmitted to any external server.

### Extension Preferences

- **What**: Target LUFS level, ad-break gain (dB), display unit (% or dB), gain overlay toggle.
- **Purpose**: Customize the extension's behavior according to your preferences.
- **Storage**: Saved locally in `chrome.storage.local` on your device.

### Loudness Measurement of Playing Audio (in-memory only)

- **What**: Momentary / Short-term / Integrated LUFS values computed from the playing `<video>` element via the Web Audio API.
- **Purpose**: Display loudness information and calculate the suggested gain.
- **Storage**: No audio waveform or audio data is stored. Live LUFS values are held in memory only while the page is open; only the most recent value is saved as a setting when you click "Apply to channel."

### Twitch Page Data (read-only)

- **What**: HLS manifests issued by Twitch itself (to detect `EXT-X-DATERANGE` ad ranges) and GraphQL responses (to obtain a channel's owner ID / broadcaster ID).
- **Purpose**: Detect ad breaks and obtain a persistent channel identifier.
- **Storage**: Manifest bodies and GraphQL responses are not stored. Only the required values (ad-range info and channel IDs) are extracted and used.

## Data NOT Collected

- The extension does **not** collect browsing history, analytics, or telemetry.
- The extension does **not** track which pages you visit on Twitch or any other site.
- The extension does **not** record or transmit audio or video data itself.
- The extension developer does **not** receive, store, or have access to any of your data.
- No data is sold, shared with third parties, or used for advertising.

## Where Data Is Sent

Nowhere. This extension makes **no external network requests**. HLS manifests and GraphQL responses are only read from the traffic that the Twitch page itself issues; the extension does not initiate any new outbound transmission. All data remains on your device.

## Data Storage and Security

- All settings are stored in `chrome.storage.local`, which is accessible only to this extension.
- No data is synced across devices or stored in the cloud.
- Uninstalling the extension removes all locally stored data.

## Permissions

| Permission | Reason |
|---|---|
| **storage** | Save channel volume settings and user preferences locally |
| **host_permissions** (`twitch.tv`) | Inject content scripts on Twitch pages to measure the playing audio and control volume via the Web Audio API |
| **host_permissions** (`ttvnw.net`) | Read Twitch HLS manifests to detect ad breaks |

## Remote Code

This extension does **not** use remote code. All JavaScript is bundled locally within the extension package. The `page-bridge.js` content script runs in the page's main world (`"world": "MAIN"`) to control the AudioContext and read Twitch page data — this is local code, not remotely fetched.

## Single Purpose

This extension has a single purpose: **measure, remember, and auto-apply per-channel volume settings on Twitch** using ITU-R BS.1770 loudness measurement and the Web Audio API.

## Third-Party Dependencies

None. The extension contains no external libraries, SDKs, CDNs, or analytics tools.

## Changes to This Policy

Updates will be posted to this page with a revised date. Continued use of the extension after changes constitutes acceptance.

## Contact

If you have questions about this privacy policy, please open an [issue](https://github.com/semnil/twitch-channel-volume/issues) on the GitHub repository.
