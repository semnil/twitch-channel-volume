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

`kForSampleRate`'s shortcut for the rate the coefficients were designed at.
Measured: `redesignBiquad(K_PRE_48K, 48000, 48000)` is a bilinear round trip
that gives back the input doubles, so the shortcut and the redesign are the same
numbers.

- `page-bridge.js:62` a guard is dropped ×1 — if (Math.abs(sr - REF_RATE) < 1) return { pre: K_PRE_48K, rlb: K_RLB_48K

The balanced tree's empty-node exits. `treeHeight` and `treeCount` answer 0 for
a node that is not there, and a walk that reaches one returns what the guard
returns, so the exits save the walk rather than change it.

- `page-bridge.js:187` a guard is dropped ×1 — if (!node) return null;
- `page-bridge.js:224` a guard is dropped ×1 — if (!node) return null;
- `page-bridge.js:229` a guard is dropped ×1 — if (!node.left) return node.right;

The gate's empty-set exits. An empty mean is `NaN` and `msToLufs(NaN)` is
`-Infinity`, which is the value the guards return; `removeTreeValue` on a value
the tree does not hold is a no-op.

- `page-bridge.js:332` a guard is dropped ×1 — if (list.length === 0) return -Infinity;
- `page-bridge.js:344` a guard is dropped ×1 — if (absoluteGatedCount === 0) return { lufs: -Infinity, windows: 0 };
- `page-bridge.js:348` a guard is dropped ×1 — if (gated.count === 0) return { lufs: -Infinity, windows: 0 };
- `page-bridge.js:374` a guard is always taken ×1 — if (ms >= ABSOLUTE_GATE_MEAN_SQUARE) {

`buildMeasurementChain`'s three-way check. Its one caller is inside
`if (workletReady)`, it is called once per attach, and `sourceNode` is assigned
two lines before the call — every clause is backstopped.

- `page-bridge.js:463` a guard is dropped ×1 — if (!workletReady || workletNode || !sourceNode) return;
- `page-bridge.js:463` || becomes && ×2 — ||

The attach loop's exits. `attach` re-reads `attachedVideo` after the context
await and returns there; the tick stops the loop at its own end either way;
`clearInterval(null)` is a no-op; and `attach` is only ever called with an
element `findVideo` returned, which is never the one already held.

- `page-bridge.js:602` a guard body is dropped ×1 — if (attachedVideo) {
- `page-bridge.js:631` a guard is always taken ×1 — if (attachTimer) {
- `page-bridge.js:646` a guard is dropped ×1 — if (!video || attachedVideo === video) return;
- `page-bridge.js:646` || becomes && ×1 — ||

The block trim. `blocksToLufs` reads the tail, so what the trim drops is never
read, and with a short list the splice count is negative and removes nothing.

- `page-bridge.js:719` a guard body is dropped ×1 — if (blocks.length > Math.max(MOMENTARY_BLOCKS, SHORT_BLOCKS) * 4) {
- `page-bridge.js:719` a guard is always taken ×1 — if (blocks.length > Math.max(MOMENTARY_BLOCKS, SHORT_BLOCKS) * 4) {

`applyEffectiveGain`'s check. `createContext` assigns the gain and the context
together and clears both together, so a gain without a context is not a state
the bridge has.

- `page-bridge.js:795` || becomes && ×1 — ||

`adStartRollbackBlocks`'s three-way check. `adBreakStartMedia` is only set by a
cue, which is what sets `adCueSeen`, and a break only opens while
`playerBreakActive` has a finite playhead. Neither mutant's discriminating state
is reachable.

- `page-bridge.js:832` || becomes && ×2 — ||

`setDomAdActive`'s dedup and `syncAdElementGains`' context check.
`updateAdState` opens with `if (wanted === adActive) return`, so the repeat one
saves is a no-op; and the chain list is empty whenever there is no context.

- `page-bridge.js:903` a guard is dropped ×1 — if (domAdActive === !!active) return;
- `page-bridge.js:1003` a guard is dropped ×1 — if (!ctx) return;

`currentContentIdentity`'s clip and live branches. Its one reader asks
`requestIdentity?.kind === 'vod'`, so every other kind is the same answer.

- `page-bridge.js:1035` && becomes || ×1 — &&
- `page-bridge.js:1035` === becomes !== ×1 — ===
- `page-bridge.js:1035` a guard body is dropped ×1 — if (segs.length >= 3 && segs[1] === 'clip') {
- `page-bridge.js:1035` a guard is always taken ×1 — if (segs.length >= 3 && segs[1] === 'clip') {
- `page-bridge.js:1038` && becomes || ×1 — &&
- `page-bridge.js:1038` === becomes !== ×1 — ===
- `page-bridge.js:1038` a guard body is dropped ×1 — if (url.hostname === 'clips.twitch.tv' && segs[0]) {
- `page-bridge.js:1038` a guard is always taken ×1 — if (url.hostname === 'clips.twitch.tv' && segs[0]) {
- `page-bridge.js:1041` === becomes !== ×1 — ===
- `page-bridge.js:1041` a guard is dropped ×1 — if (segs.length === 1) return { kind: 'live', id: segs[0].toLowerCase()

The dropped await on `ensureContext` in `resume`. `createContext` assigns `ctx`
before its first await, so the resume that follows has it.

- `page-bridge.js:1139` an await is dropped ×1 — await

## content.js

The store helpers' opening checks. `sendChannelMutation` opens with the same
runtime check, and every caller of these already holds `currentChannel.id`.

- `content.js:156` a guard body is dropped ×1 — if (!channelId || !isContextValid() || !Number.isFinite(lufs)) {
- `content.js:156` || becomes && ×2 — ||
- `content.js:175` a guard body is dropped ×1 — if (!channelId || !isContextValid() || !Number.isFinite(autoGain)) {
- `content.js:175` || becomes && ×2 — ||
- `content.js:199` a guard is dropped ×1 — if (!fromId || !toId || fromId === toId) return Promise.resolve();
- `content.js:199` || becomes && ×2 — ||

The url `channelMetadata` puts on a mutation. Measured against the store: a
merge whose channel names only the login comes back holding `name` and `url` all
the same, because the store fills both from the login it was given.

- `content.js:331` || becomes && ×1 — ||

`acceptOwner`'s provisional-id check. A provisional id is `login:<name>` or
`vod-owner:<id>` and a confirmed one is numeric, so the second clause is never
false; the first is only false on a clip, which `ownerMatchesTwitchContent`
refuses two lines up.

- `content.js:337` && becomes || ×1 — &&
- `content.js:337` a guard is always taken ×1 — if (provisionalId && provisionalId !== confirmedId) {

The three dropped awaits on `resolveChannel`. It holds no await of its own, so
its promise is already settled when it is returned.

- `content.js:359` an await is dropped ×1 — await
- `content.js:622` an await is dropped ×1 — await
- `content.js:911` an await is dropped ×1 — await

`reapplyForCurrentChannel`'s "no channel here" exit and its staleness check. The
path below the exit loads nothing for an empty id, resolves the gain to 1.0 with
no entry and applies that, which is what the body does; and the revision beside
the staleness check is bumped by every channel change, so it answers first.

- `content.js:403` a guard body is dropped ×1 — if (!ch.id || ch.kind === 'none') {
- `content.js:403` || becomes && ×1 — ||
- `content.js:413` || becomes && ×1 — ||

`handleBridgeMessage`'s runtime check. Each case reaches a guard of its own —
the storage helpers above — and the rest only post to the page.

- `content.js:445` a guard is dropped ×1 — if (!isContextValid()) return;

The cached entry an Auto save and a measurement reset rewrite. What the mutants
differ on is the other kind's `autoGainRef` and `lastLufs`, and `lastMeasuredAt`
— content.js reads `lastLufs` only at `currentChannel.kind`, `lastMeasuredAt`
nowhere, and the entry is reloaded before another kind is read.

- `content.js:798` || becomes && ×1 — ||
- `content.js:850` a guard is always taken ×1 — if (currentChannelEntry) {
- `content.js:852` || becomes && ×1 — ||

## channel-store.js

`expandLegacyGain`'s hasOwnProperty check. Without it the legacy gain is
`undefined`, `Number.isFinite(undefined)` is false, and `delete entry.gain` on a
key that is not there is a no-op — the same object comes back.

- `channel-store.js:67` a guard is dropped ×1 — if (!Object.prototype.hasOwnProperty.call(entry, 'gain')) return entry;

`withoutClipFields`'s type checks. A non-object spreads to something whose clip
fields are absent and whose key count does not change, so `dropped` stays false
and the entry it was given comes back; and `__fieldVersions` is one of
`ROW_SHARED_VALUE_FIELDS`, so `holdsNoValue` answers false for the copy and the
row is written back unchanged.

- `channel-store.js:120` a guard is dropped ×1 — if (!entry || typeof entry !== 'object') return entry;
- `channel-store.js:120` || becomes && ×1 — ||
- `channel-store.js:144` && becomes || ×1 — &&
- `channel-store.js:147` a guard is always taken ×1 — if (Object.keys(kept).length !== Object.keys(versions).length) {

`cloneEntry`'s deep copy of the version map. `setFieldVersion` replaces that
object rather than writing into it, and no other writer touches it in place, so
the copy has nothing to protect.

- `channel-store.js:162` === becomes !== ×1 — ===
- `channel-store.js:162` a guard body is dropped ×1 — if (entry?.[FIELD_VERSIONS_FIELD] && typeof entry[FIELD_VERSIONS_FIELD]

`resolveStoredAlias`'s cycle check. **This one is not equivalent: the mutant
does not terminate.** A suite carrying it never reports green — the sweep stops
it at its own timeout rather than passing it — so it is named here to be
accounted for, not because the code cannot tell the difference.

- `channel-store.js:521` && becomes || ×1 — &&

The alias rebuild after a write. `clearChannels` leaves no rows, so the rebuild
its check guards finds no targets.

- `channel-store.js:599` a guard is always taken ×1 — if (resolvedMutation.operation !== 'clearChannels') {

## popup.js

`setAutoApplyLoudness`'s gain check. The branch above it throws on `!res?.ok`,
so a response that reaches this line carries the gain content.js answers with.

- `popup.js:362` a guard is always taken ×1 — if (Number.isFinite(res.gain)) {

The `await refresh()` ending `applyMeasured`, `setGain` and
`setAutoApplyLoudness`. All three are called from click handlers that discard
the promise, so nothing observes when they settle.

- `popup.js:316` an await is dropped ×1 — await
- `popup.js:334` an await is dropped ×1 — await
- `popup.js:366` an await is dropped ×1 — await

## utils.js

`calcGain`'s finite check and `gatedIntegratedLufs`'s three empty-set checks.
Measured by computing the unguarded path beside the guarded one: `calcGain`
reaches `if (!Number.isFinite(gain)) return 1.0` three lines down, and an empty
mean is `NaN`, which `meanSquareToLufs` answers `-Infinity` for. Checked against
`[]`, `[0, -1, NaN]` and a set below the absolute gate — guarded and unguarded
agree on every one.

- `utils.js:115` a guard is dropped ×1 — if (!Number.isFinite(measuredLufs)) return 1.0;
- `utils.js:287` a guard is dropped ×1 — if (valid.length === 0) return -Infinity;
- `utils.js:290` a guard is dropped ×1 — if (passAbs.length === 0) return -Infinity;
- `utils.js:295` a guard is dropped ×1 — if (passRel.length === 0) return -Infinity;

## options.js

The default-Auto toggle's and the unit buttons' readiness checks.
`updateSettings` opens with the same one, so the mutant reaches it and stops
there.

- `options.js:262` a guard is dropped ×1 — if (!settingsReady) return;
- `options.js:275` a guard is dropped ×1 — if (!settingsReady) return;
