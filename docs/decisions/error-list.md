# Error-list decisions

> 日本語版は [error-list.ja.md](error-list.ja.md) を参照してください.

Closed decisions about what reaches the list of errors Chrome keeps for the extension. The rules in force are in `docs/design.md`, "A page fetch nothing handles", and in `docs/development.md`, "Diagnosing a failed action".

## The Worker wrapper carries no suppression

- **Decision** (2026-09-13): the `Worker` wrapper in `page-bridge.js` adds nothing that keeps a failed `new Worker` out of the extension's error list. A constructor that throws through the wrapper throws to the page as it would without it.
- **Reason**: an error thrown through the wrapper carries a `page-bridge.js` line, so on a page that does not prevent the default of its own errors Chrome records it against the extension. The decision rests on twitch.tv preventing that default itself, which keeps the entry out of the list there. The failure it was weighed against was provoked on purpose, by handing the constructor a script URL that cannot load; nothing shows that ordinary viewing produces one. The `unhandledrejection` listener beside the fetch wrapper was added as insurance against the site ceasing to prevent the default, and the Worker wrapper is not given the same insurance.
- **Reopen when**: a `new Worker` that fails through the wrapper on a real Twitch page turns out not to have its default prevented by the page, or a Worker failure is reported in the extension's error list. The probe that raised the case no longer exists, so answering the first means building one that raises the same case again and running it against the real page.

## The one "Receiving end does not exist" report stays unexplained

- **Decision** (2026-11-14): the single report of `Could not establish connection. Receiving end does not exist.` from the measurement save, which [#66](https://github.com/semnil/twitch-channel-volume/pull/66) answered by keeping a failure the next block clears out of the error list, keeps its trigger unidentified, and nothing further is changed for it.
- **Reason**: the message comes from a send that reaches no `onMessage` listener; #66 produced it only that way (an extension id that is not installed, and a worker that registers no listener). The lifecycle events #66 tried each resolved or gave a different message, and its stand-in for a sleeping machine was every Chrome process stopped and resumed. A real sleep was then observed on 2026-11-14: with a live channel page open and the extension running, the Mac slept for about five minutes. After it woke, the extension's error list had gained no entry and the page console held no line from the extension; the lines there came from Twitch's player (failed fetches while asleep, then playback resuming) and from the page itself.
- **Reopen when**: the message is reported again — read the entry's occurrences count and stack in the error list — or a sleep and wake leaves an entry in the extension's error list.
