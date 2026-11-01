# Mutants this suite lets through, and why each one is equivalent

`sweep.mjs` turns each source into mutants and runs the suite against every one.
A mutant the suite still passes is either a gap in the tests or a change the
code cannot be told apart from — this file names the second kind, one entry per
mutant, with what was measured about it.

Entries are read back by `node tools/mutation/sweep.mjs --verify`, which the
suite runs: an entry naming a site the code no longer has is a reason nobody can
check, which is what a list like this turns into if it is only prose. The
format is `- ``file:line`` label ×N — <the text the rule matched>`, where N is
how many of that group are equivalent — fewer than the line carries where one
of a line's two `===` is equivalent and the other is killed. The text is part
of what is matched because a line number on its own moves onto whatever takes
that line, and a reason measured for one guard would go on standing for a
different guard nobody has measured. Every list item in this file is read as
an entry, so a bullet that is not one — or one that has lost a backtick, a
`×N`, or the `-` at the margin — is refused by name rather than passed over as
prose. What `--verify` cannot see is an entry whose mutant the suite has come
to kill: the site is still there, so only a sweep of that file finds it, by what
it does not find standing.

## page-bridge.js

`buildMeasurementChain`'s three-way check. Its one caller is inside
`if (workletReady)`, it is called once per attach, and `sourceNode` is assigned
two lines before the call — every clause is backstopped.

- `page-bridge.js:183` a guard is dropped ×1 — if (!workletReady || workletNode || !sourceNode) return;
- `page-bridge.js:183` || becomes && ×2 — ||

The attach loop's exits. `attach` re-reads `attachedVideo` after the context
await and returns there; the tick stops the loop at its own end either way;
`clearInterval(null)` is a no-op; and `attach` is only ever called with an
element `findVideo` returned, which is never the one already held.

- `page-bridge.js:310` a guard body is dropped ×1 — if (attachedVideo) {
- `page-bridge.js:339` a guard is always taken ×1 — if (attachTimer) {
- `page-bridge.js:354` a guard is dropped ×1 — if (!video || attachedVideo === video) return;
- `page-bridge.js:354` || becomes && ×1 — ||

`applyEffectiveGain`'s check. `createContext` assigns the gain and the context
together and clears both together, so a gain without a context is not a state
the bridge has.

- `page-bridge.js:496` || becomes && ×1 — ||

`adStartRollbackBlocks`'s three-way check. `adBreakStartMedia` is only set by a
cue, which is what sets `adCueSeen`, and a break only opens while
`playerBreakActive` has a finite playhead. Neither mutant's discriminating state
is reachable.

- `page-bridge.js:533` || becomes && ×2 — ||

`setDomAdActive`'s dedup and `syncAdElementGains`' context check.
`updateAdState` opens with `if (wanted === adActive) return`, so the repeat one
saves is a no-op; and the chain list is empty whenever there is no context.

- `page-bridge.js:594` a guard is dropped ×1 — if (domAdActive === !!active) return;
- `page-bridge.js:694` a guard is dropped ×1 — if (!ctx) return;

The dropped await on `ensureContext` in `resume`. `createContext` assigns `ctx`
before its first await, so the resume that follows has it.

- `page-bridge.js:856` an await is dropped ×1 — await

## content.js

The store helpers' opening checks. `sendChannelMutation` opens with the same
runtime check, and every caller of these already holds `currentChannel.id`.

- `content.js:164` a guard body is dropped ×1 — if (!channelId || !isContextValid() || !Number.isFinite(lufs)) {
- `content.js:164` || becomes && ×2 — ||
- `content.js:184` a guard body is dropped ×1 — if (!channelId || !isContextValid() || !Number.isFinite(autoGain)) {
- `content.js:184` || becomes && ×2 — ||
- `content.js:208` a guard is dropped ×1 — if (!fromId || !toId || fromId === toId) return Promise.resolve();
- `content.js:208` || becomes && ×2 — ||

The url `channelMetadata` puts on a mutation. Measured against the store: a
merge whose channel names only the login comes back holding `name` and `url` all
the same, because the store fills both from the login it was given.

- `content.js:351` || becomes && ×1 — ||

`acceptOwner`'s provisional-id check. A provisional id is `login:<name>` or
`vod-owner:<id>` and a confirmed one is numeric, so the second clause is never
false; the first is only false on a clip, which `ownerMatchesTwitchContent`
refuses at the top of `acceptOwner`.

- `content.js:357` && becomes || ×1 — &&
- `content.js:357` a guard is always taken ×1 — if (provisionalId && provisionalId !== confirmedId) {

The three dropped awaits on `resolveChannel`. It holds no await of its own, so
its promise is already settled when it is returned.

- `content.js:379` an await is dropped ×1 — await
- `content.js:685` an await is dropped ×1 — await
- `content.js:1055` an await is dropped ×1 — await

`reapplyForCurrentChannel`'s "no channel here" exit and its staleness check. The
path below the exit loads nothing for an empty id, resolves the gain to 1.0 with
no entry and applies that, which is what the body does; and the revision beside
the staleness check is bumped by every channel change, so it answers first.

- `content.js:421` a guard body is dropped ×1 — if (!ch.id || ch.kind === 'none') {
- `content.js:421` || becomes && ×1 — ||
- `content.js:432` || becomes && ×1 — ||

The `true` that exit returns. Of the callers, only a settings change reads
what the reapply returns, and its Auto save stops at
`currentAutoApplyLoudness`, which the exit has just set to false.

- `content.js:427` true becomes false ×1 — return true;

`handleBridgeMessage`'s runtime check. Each case reaches a guard of its own —
the storage helpers above — and the rest only post to the page.

- `content.js:478` a guard is dropped ×1 — if (!isContextValid()) return;

The cached entry an Auto save and a measurement reset rewrite. What the mutants
differ on is the other kind's `autoGainRef` and `lastLufs`, and `lastMeasuredAt`
— content.js reads `lastLufs` only at `currentChannel.kind`, `lastMeasuredAt`
nowhere, and the entry is reloaded before another kind is read.

- `content.js:942` || becomes && ×1 — ||
- `content.js:994` a guard is always taken ×1 — if (currentChannelEntry) {
- `content.js:996` || becomes && ×1 — ||

## channel-store.js

`withoutClipFields`'s type checks. A non-object spreads to something whose clip
fields are absent and whose key count does not change, so `dropped` stays false
and the entry it was given comes back; and `__fieldVersions` is one of
`ROW_SHARED_VALUE_FIELDS`, so `holdsNoValue` answers false for the copy and the
row is written back unchanged.

- `channel-store.js:131` a guard is dropped ×1 — if (!entry || typeof entry !== 'object') return entry;
- `channel-store.js:131` || becomes && ×1 — ||
- `channel-store.js:155` && becomes || ×1 — &&
- `channel-store.js:158` a guard is always taken ×1 — if (Object.keys(kept).length !== Object.keys(versions).length) {

`cloneEntry`'s deep copy of the version map. `setFieldVersion` replaces that
object rather than writing into it, and no other writer touches it in place, so
the copy has nothing to protect.

- `channel-store.js:173` === becomes !== ×1 — ===
- `channel-store.js:173` a guard body is dropped ×1 — if (entry?.[FIELD_VERSIONS_FIELD] && typeof entry[FIELD_VERSIONS_FIELD]

`resolveStoredAlias`'s cycle check. **This one is not equivalent: the mutant
does not terminate.** A suite carrying it never reports green — the sweep stops
it at its own timeout rather than passing it — so it is named here to be
accounted for, not because the code cannot tell the difference.

- `channel-store.js:544` && becomes || ×1 — &&

The alias rebuild after a write. `clearChannels` leaves no rows, so the rebuild
its check guards finds no targets.

- `channel-store.js:638` a guard is always taken ×1 — if (resolvedMutation.operation !== 'clearChannels') {

## popup.js

`setAutoApplyLoudness`'s gain check. The branch above it throws on `!res?.ok`,
so a response that reaches this line carries the gain content.js answers with.

- `popup.js:344` a guard is always taken ×1 — if (Number.isFinite(res.gain)) {

The `await refresh()` ending `applyMeasured`, `setGain` and
`setAutoApplyLoudness`. All three are called from click handlers that discard
the promise, so nothing observes when they settle.

- `popup.js:290` an await is dropped ×1 — await
- `popup.js:308` an await is dropped ×1 — await
- `popup.js:348` an await is dropped ×1 — await


## utils.js

`calcGain`'s finite check. Measured by computing the unguarded path beside the
guarded one: `calcGain` reaches `if (!Number.isFinite(gain)) return 1.0` in
`gainForLevel` (`core/common.js`), and guarded and unguarded agree.

- `utils.js:74` a guard is dropped ×1 — if (!Number.isFinite(measuredLufs)) return 1.0;

## options.js

The default-Auto toggle's and the unit buttons' readiness checks.
`updateSettings` opens with the same one, so the mutant reaches it and stops
there.

- `options.js:255` a guard is dropped ×1 — if (!settingsReady) return;
- `options.js:268` a guard is dropped ×1 — if (!settingsReady) return;
