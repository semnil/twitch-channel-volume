# Measurement decisions

> 日本語版は [measurement.ja.md](measurement.ja.md) を参照してください.

Closed decisions about the loudness measurement that are this extension's own. How the measurement works is in `CLAUDE.md`, "Key design decisions". The weight the seed is given — the floor and the cap — is decided for the shared meter and recorded in channel-volume-core, [docs/decisions/measurement.md](https://github.com/semnil/channel-volume-core/blob/main/docs/decisions/measurement.md).

## The popup does not tell a seeded value from a measured one

- **Decision** (2026-08-23): the popup shows the Integrated value the same way whether it still stands on the seed or on audio measured since the page opened. Nothing on the popup says that the value shown is still the one from the previous session.
- **Reason**: the measurement is seeded from the stored LUFS, so the Integrated value is finite from the moment the seed goes in. On a channel that has a stored value, the Fallback badge — shown while Auto is on and no Integrated value has been obtained — therefore has practically no moment in which to appear. Whether to add a display that tells the two apart was put as a question, and the answer was to leave them undistinguished.
