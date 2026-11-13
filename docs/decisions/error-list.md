# Error-list decisions

> 日本語版は [error-list.ja.md](error-list.ja.md) を参照してください.

Closed decisions about what reaches the list of errors Chrome keeps for the extension. The rules in force are in `docs/design.md`, "A page fetch nothing handles", and in `docs/development.md`, "Diagnosing a failed action".

## The Worker wrapper carries no suppression

- **Decision** (2026-09-13): the `Worker` wrapper in `page-bridge.js` adds nothing that keeps a failed `new Worker` out of the extension's error list. A constructor that throws through the wrapper throws to the page as it would without it.
- **Reason**: an error thrown through the wrapper carries a `page-bridge.js` line, so on a page that does not prevent the default of its own errors Chrome records it against the extension. The decision rests on twitch.tv preventing that default itself, which keeps the entry out of the list there. The failure it was weighed against was provoked on purpose, by handing the constructor a script URL that cannot load; nothing shows that ordinary viewing produces one. The `unhandledrejection` listener beside the fetch wrapper was added as insurance against the site ceasing to prevent the default, and the Worker wrapper is not given the same insurance.
- **Reopen when**: a `new Worker` that fails through the wrapper on a real Twitch page turns out not to have its default prevented by the page, or a Worker failure is reported in the extension's error list. The probe that raised the case no longer exists, so answering the first means building one that raises the same case again and running it against the real page.
