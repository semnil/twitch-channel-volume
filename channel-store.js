// channel-store.js — Serialized channelVolumes mutations for the service worker.

const CHANNEL_MUTATION_MESSAGE = '__twitch_channel_volume_channel_mutation__';
const CHANNEL_MUTATION_KINDS = new Set(['live', 'vod']);
const CHANNEL_ALIASES_KEY = 'channelVolumeAliases';
const CHANNEL_SEQUENCE_KEY = 'channelVolumeSequence';
const FIELD_VERSIONS_FIELD = '__fieldVersions';
const LEGACY_PROVISIONAL_WRITES_FIELD = '__provisionalWrites';

// What the caller sent cannot be applied. Sending it again produces the same
// answer. settings-store.js mirrors this helper under its own name: the
// service worker runs both scripts in one global.
function invalidChannelMutation(message) {
  const error = new TypeError(message);
  error.reason = 'invalid-mutation';
  return error;
}

// What is on file cannot carry the mutation. The caller sent nothing wrong,
// and retrying puts the same data through the same state.
function storedStateInvalid(error) {
  error.reason = 'stored-state-invalid';
  return error;
}

function storeGainFieldForKind(kind) {
  if (kind === 'vod') return 'gainVod';
  return 'gainLive';
}

// The keys of an entry's gains, one per kind.
const STORE_GAIN_FIELDS = [...CHANNEL_MUTATION_KINDS].map(storeGainFieldForKind);

function storeAutoFieldForKind(kind) {
  if (kind === 'vod') return 'autoApplyLoudnessVod';
  return 'autoApplyLoudnessLive';
}

// The keys of an entry's Auto flags, one per kind.
const STORE_AUTO_FIELDS = [...CHANNEL_MUTATION_KINDS].map(storeAutoFieldForKind);

function storeAutoGainFieldForKind(kind) {
  if (kind === 'vod') return 'autoGainVod';
  return 'autoGainLive';
}

function assertChannelId(value, field = 'channelId') {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidChannelMutation(`${field} must be a non-empty string`);
  }
}

// The ids a row is written under: a Twitch user id, and the provisional
// login: / vod-owner: id the channel goes by until that is known.
const WRITABLE_CHANNEL_ID = /^(?:\d+|login:.+|vod-owner:.+)$/;

function assertWritableChannelId(value, field = 'channelId') {
  assertChannelId(value, field);
  if (!WRITABLE_CHANNEL_ID.test(value)) {
    throw invalidChannelMutation(`${field} is not a channel id the extension writes`);
  }
}

// The name a row the store makes starts with: the sender's where it is text,
// the id otherwise.
function fallbackRowName(channel, channelId) {
  return typeof channel?.name === 'string' && channel.name ? channel.name : channelId;
}

function assertKind(kind) {
  if (!CHANNEL_MUTATION_KINDS.has(kind)) {
    throw invalidChannelMutation('kind must be live or vod');
  }
}

function validSequence(sequence) {
  return Number.isSafeInteger(sequence) && sequence > 0;
}

// Whether two stored values hold the same data, whatever order their keys
// were written in.
function sameStoredValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) && sameStoredValue(a[key], b[key]));
}

function copyMetadata(entry, channel, channelId) {
  if (!channel || typeof channel !== 'object') return;
  applyEntryName(entry, channelId, channel.name, false);
  for (const field of ['login', 'url']) {
    if (typeof channel[field] === 'string' && channel[field]) {
      entry[field] = channel[field];
    }
  }
}

// Clips are left to the player, so the fields a previous version stored for
// Clip are dropped the next time the store is written.
const CLIP_ENTRY_FIELDS = ['gainClip', 'autoGainClip', 'autoApplyLoudnessClip'];
const CLIP_KIND_CONTAINERS = ['lastLufs', 'lastLufsRef', 'lastLufsWindows', 'autoGainRef'];
const CLIP_VERSION_FIELDS = [...CLIP_ENTRY_FIELDS, 'lastLufs.clip'];
const CLIP_PROVISIONAL_PREFIX = 'clip-owner:';
// What a row exists for. The name, the login and the URL describe a channel
// but are not something the viewer set or the extension measured.
const ROW_SHARED_VALUE_FIELDS = [
  'lastLufs', 'lastLufsRef', 'lastLufsWindows', 'autoGainRef', 'lastMeasuredAt',
  'gain', 'autoApplyLoudness', FIELD_VERSIONS_FIELD
];

function holdsNoValue(entry) {
  for (const kind of CHANNEL_MUTATION_KINDS) {
    for (const field of [
      storeGainFieldForKind(kind),
      storeAutoFieldForKind(kind),
      storeAutoGainFieldForKind(kind)
    ]) {
      if (Object.prototype.hasOwnProperty.call(entry, field)) return false;
    }
  }
  for (const field of ROW_SHARED_VALUE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entry, field)) return false;
  }
  return true;
}

function withoutClipFields(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const next = { ...entry };
  const hadLastLufs = Object.prototype.hasOwnProperty.call(next, 'lastLufs');
  let dropped = false;
  for (const field of CLIP_ENTRY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
    delete next[field];
    dropped = true;
  }
  for (const field of CLIP_KIND_CONTAINERS) {
    const container = next[field];
    if (!container || typeof container !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(container, 'clip')) continue;
    const kept = { ...container };
    delete kept.clip;
    if (Object.keys(kept).length) next[field] = kept;
    else delete next[field];
    dropped = true;
  }
  // The time of the measurement goes with the measurement.
  if (hadLastLufs && !Object.prototype.hasOwnProperty.call(next, 'lastLufs')) {
    delete next.lastMeasuredAt;
  }
  const versions = next[FIELD_VERSIONS_FIELD];
  if (versions && typeof versions === 'object') {
    const kept = { ...versions };
    for (const field of CLIP_VERSION_FIELDS) delete kept[field];
    if (Object.keys(kept).length !== Object.keys(versions).length) {
      if (Object.keys(kept).length) next[FIELD_VERSIONS_FIELD] = kept;
      else delete next[FIELD_VERSIONS_FIELD];
      dropped = true;
    }
  }
  return dropped ? next : entry;
}

function cloneEntry(entry, fallbackName) {
  const cloned = { ...(entry || { name: fallbackName }) };
  if (entry?.lastLufs) cloned.lastLufs = { ...entry.lastLufs };
  if (entry?.lastLufsRef) cloned.lastLufsRef = { ...entry.lastLufsRef };
  if (entry?.lastLufsWindows) cloned.lastLufsWindows = { ...entry.lastLufsWindows };
  if (entry?.autoGainRef) cloned.autoGainRef = { ...entry.autoGainRef };
  if (entry?.[FIELD_VERSIONS_FIELD] && typeof entry[FIELD_VERSIONS_FIELD] === 'object') {
    cloned[FIELD_VERSIONS_FIELD] = { ...entry[FIELD_VERSIONS_FIELD] };
  }
  delete cloned[LEGACY_PROVISIONAL_WRITES_FIELD];
  return expandLegacyAutoFlag(expandLegacyGain(cloned, STORE_GAIN_FIELDS), STORE_AUTO_FIELDS);
}

function normalizeLogin(value) {
  if (typeof value !== 'string') return '';
  const login = value.trim().toLowerCase();
  return /^[a-z0-9_]+$/.test(login) ? login : '';
}

function knownLoginTargets(all) {
  const idsByLogin = new Map();
  for (const [id, entry] of Object.entries(all)) {
    if (!/^\d+$/.test(id)) continue;
    const explicitLogin = normalizeLogin(entry?.login);
    const nameLogin = normalizeLogin(entry?.name);
    const login = explicitLogin || (
      nameLogin && Object.prototype.hasOwnProperty.call(all, `login:${nameLogin}`)
        ? nameLogin
        : ''
    );
    if (!login) continue;
    const ids = idsByLogin.get(login) || [];
    ids.push(id);
    idsByLogin.set(login, ids);
  }
  return [...idsByLogin.entries()]
    .filter(([, ids]) => ids.length === 1)
    .map(([login, ids]) => ({ login, fromId: `login:${login}`, toId: ids[0] }));
}

function setFieldVersion(entry, field, sequence) {
  if (sequence === undefined) return;
  if (!validSequence(sequence)) {
    throw invalidChannelMutation('sequence must be a positive safe integer');
  }
  entry[FIELD_VERSIONS_FIELD] = {
    ...(entry[FIELD_VERSIONS_FIELD] || {}),
    [field]: sequence
  };
}

function fieldVersion(entry, field) {
  const sequence = entry?.[FIELD_VERSIONS_FIELD]?.[field];
  return validSequence(sequence) ? sequence : 0;
}

function copyNewerField(merged, mergedVersions, source, target, field) {
  return copyNewerFieldInner(merged, mergedVersions, source, target, field);
}

function copyNewerFieldInner(merged, mergedVersions, source, target, field) {
  const sourceHas = Object.prototype.hasOwnProperty.call(source, field);
  const targetHas = Object.prototype.hasOwnProperty.call(target, field);
  if (!sourceHas || (targetHas && fieldVersion(source, field) <= fieldVersion(target, field))) {
    return false;
  }
  merged[field] = source[field];
  const version = fieldVersion(source, field);
  if (version) mergedVersions[field] = version;
  else delete mergedVersions[field];
  return true;
}

// The reference belongs to the field it describes, so it moves with whichever
// side won that field rather than with the measurement's.
function copyNewerAutoGain(merged, mergedRef, mergedVersions, source, target, kind) {
  const field = storeAutoGainFieldForKind(kind);
  const sourceWon = copyNewerField(merged, mergedVersions, source, target, field) === true;
  const winnerRef = (sourceWon ? source.autoGainRef : target.autoGainRef) || {};
  if (Object.prototype.hasOwnProperty.call(merged, field) && winnerRef[kind] !== undefined) {
    mergedRef[kind] = winnerRef[kind];
  } else delete mergedRef[kind];
}

function copyNewerLufs(mergedLufs, mergedCompanions, mergedVersions, source, target, kind) {
  const sourceLufs = source.lastLufs || {};
  const targetLufs = target.lastLufs || {};
  const versionField = `lastLufs.${kind}`;
  const sourceHas = Object.prototype.hasOwnProperty.call(sourceLufs, kind);
  const targetHas = Object.prototype.hasOwnProperty.call(targetLufs, kind);
  const sourceVersion = fieldVersion(source, versionField);
  const targetVersion = fieldVersion(target, versionField);
  const sourceHasState = sourceHas || sourceVersion > 0;
  const targetHasState = targetHas || targetVersion > 0;
  if (!sourceHasState && !targetHasState) return;
  const sourceWins = sourceHasState &&
    (!targetHasState || sourceVersion > targetVersion);
  const winnerHasValue = sourceWins ? sourceHas : targetHas;
  const winnerValue = sourceWins ? sourceLufs[kind] : targetLufs[kind];
  const winnerVersion = sourceWins ? sourceVersion : targetVersion;
  if (winnerHasValue) mergedLufs[kind] = winnerValue;
  else delete mergedLufs[kind];
  // A companion describes this value, so it goes wherever the value goes.
  for (const [field, merged] of Object.entries(mergedCompanions)) {
    const winner = (sourceWins ? source[field] : target[field]) || {};
    if (winnerHasValue && winner[kind] !== undefined) merged[kind] = winner[kind];
    else delete merged[kind];
  }
  if (winnerVersion) mergedVersions[versionField] = winnerVersion;
  else delete mergedVersions[versionField];
}

// The per-kind maps that describe the measurement they were stored with: the
// player volume it was referenced to, and the windows it was measured over.
const MEASUREMENT_COMPANION_FIELDS = ['lastLufsRef', 'lastLufsWindows'];

function setMeasurementCompanion(entry, field, kind, value) {
  const companions = { ...(entry[field] || {}) };
  if (value === undefined) delete companions[kind];
  else companions[kind] = value;
  if (Object.keys(companions).length) entry[field] = companions;
  else delete entry[field];
}

// A writer that names no reference drops the one on file: the numbers it just
// wrote were produced without it.
function applyMeasurementReference(entry, mutation, field) {
  if (mutation.reference !== undefined &&
      (typeof mutation.reference !== 'string' || mutation.reference.length > 32)) {
    throw invalidChannelMutation('reference must be a short string');
  }
  setMeasurementCompanion(entry, field, mutation.kind, mutation.reference);
}

// The window count follows the same rule: a writer that names none measured
// without one.
function applyMeasurementWindows(entry, mutation) {
  if (mutation.windows !== undefined &&
      !(Number.isSafeInteger(mutation.windows) && mutation.windows > 0)) {
    throw invalidChannelMutation('windows must be a positive safe integer');
  }
  setMeasurementCompanion(entry, 'lastLufsWindows', mutation.kind, mutation.windows);
}

function mergeProvisionalEntry(all, mutation) {
  const { fromId, toId, kind, channel } = mutation;
  assertWritableChannelId(fromId, 'fromId');
  assertWritableChannelId(toId, 'toId');
  assertKind(kind);
  if (fromId === toId || !all[fromId]) return;

  const source = cloneEntry(all[fromId], fromId);
  const target = cloneEntry(all[toId], fallbackRowName(channel, toId));
  const merged = { ...source, ...target };
  const mergedVersions = {
    ...(source[FIELD_VERSIONS_FIELD] || {}),
    ...(target[FIELD_VERSIONS_FIELD] || {})
  };

  // Legacy conflicts (no version) keep the confirmed-ID value. Once the
  // single writer has assigned versions, the later field update wins no
  // matter which tab issued it.
  const mergedAutoRef = { ...(source.autoGainRef || {}), ...(target.autoGainRef || {}) };
  for (const mergeKind of CHANNEL_MUTATION_KINDS) {
    copyNewerField(merged, mergedVersions, source, target, storeGainFieldForKind(mergeKind));
    copyNewerField(merged, mergedVersions, source, target, storeAutoFieldForKind(mergeKind));
    copyNewerAutoGain(merged, mergedAutoRef, mergedVersions, source, target, mergeKind);
  }
  if (Object.keys(mergedAutoRef).length) merged.autoGainRef = mergedAutoRef;
  else delete merged.autoGainRef;

  const sourceLufs = source.lastLufs || {};
  const targetLufs = target.lastLufs || {};
  const mergedLufs = { ...sourceLufs, ...targetLufs };
  const mergedCompanions = {};
  for (const field of MEASUREMENT_COMPANION_FIELDS) {
    mergedCompanions[field] = { ...(source[field] || {}), ...(target[field] || {}) };
  }
  for (const mergeKind of CHANNEL_MUTATION_KINDS) {
    copyNewerLufs(mergedLufs, mergedCompanions, mergedVersions, source, target, mergeKind);
  }
  if (Object.keys(mergedLufs).length) merged.lastLufs = mergedLufs;
  else delete merged.lastLufs;
  for (const [field, companions] of Object.entries(mergedCompanions)) {
    if (Object.keys(companions).length) merged[field] = companions;
    else delete merged[field];
  }
  if (Object.keys(mergedVersions).length) merged[FIELD_VERSIONS_FIELD] = mergedVersions;
  else delete merged[FIELD_VERSIONS_FIELD];
  if (Object.keys(mergedLufs).length &&
      (Number.isFinite(source.lastMeasuredAt) || Number.isFinite(target.lastMeasuredAt))) {
    merged.lastMeasuredAt = Math.max(
      Number.isFinite(source.lastMeasuredAt) ? source.lastMeasuredAt : 0,
      Number.isFinite(target.lastMeasuredAt) ? target.lastMeasuredAt : 0
    );
  } else delete merged.lastMeasuredAt;
  copyMetadata(merged, channel, toId);
  all[toId] = merged;
  delete all[fromId];
}

function normalizeKnownChannelEntries(all) {
  for (const { login, fromId, toId } of knownLoginTargets(all)) {
    const source = all[fromId];
    const target = cloneEntry(all[toId], login);
    const name = target.name && target.name !== toId
      ? target.name
      : (source?.name && source.name !== fromId ? source.name : login);
    const channel = {
      name,
      login,
      url: `https://www.twitch.tv/${login}`
    };
    all[toId] = target;
    if (source) {
      mergeProvisionalEntry(all, {
        operation: 'mergeChannelIds',
        fromId,
        toId,
        kind: 'live',
        channel
      });
    } else {
      copyMetadata(target, channel, toId);
    }
  }
  for (const [id, entry] of Object.entries(all)) {
    const kept = withoutClipFields(entry);
    if (kept === entry) continue;
    // A row left holding nothing but the name of the channel was a row for the
    // clip alone, and the clip is not something this keeps a row for.
    if (holdsNoValue(kept)) delete all[id];
    else all[id] = kept;
  }
  return all;
}

function applyChannelVolumesMutation(currentValue, mutation, now = Date.now()) {
  if (!mutation || typeof mutation !== 'object') {
    throw invalidChannelMutation('mutation must be an object');
  }
  const all = { ...(currentValue || {}) };

  switch (mutation.operation) {
    case 'saveGain': {
      assertWritableChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (!isStorableGain(mutation.gain)) {
        throw invalidChannelMutation('gain must be finite and within [0, 6]');
      }
      const entry = cloneEntry(all[mutation.channelId], fallbackRowName(mutation.channel, mutation.channelId));
      copyMetadata(entry, mutation.channel, mutation.channelId);
      entry[storeGainFieldForKind(mutation.kind)] = mutation.gain;
      setFieldVersion(entry, storeGainFieldForKind(mutation.kind), mutation.sequence);
      all[mutation.channelId] = entry;
      break;
    }
    case 'saveAuto': {
      assertWritableChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (typeof mutation.enabled !== 'boolean') {
        throw invalidChannelMutation('enabled must be a boolean');
      }
      const entry = cloneEntry(all[mutation.channelId], fallbackRowName(mutation.channel, mutation.channelId));
      copyMetadata(entry, mutation.channel, mutation.channelId);
      entry[storeAutoFieldForKind(mutation.kind)] = mutation.enabled;
      setFieldVersion(entry, storeAutoFieldForKind(mutation.kind), mutation.sequence);
      if (mutation.autoGain !== undefined) {
        if (!isStorableGain(mutation.autoGain)) {
          throw invalidChannelMutation('autoGain must be finite and within [0, 6]');
        }
        entry[storeAutoGainFieldForKind(mutation.kind)] = mutation.autoGain;
        setFieldVersion(entry, storeAutoGainFieldForKind(mutation.kind), mutation.sequence);
        applyMeasurementReference(entry, mutation, 'autoGainRef');
      }
      all[mutation.channelId] = entry;
      break;
    }
    case 'saveMeasurement': {
      assertWritableChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (!Number.isFinite(mutation.lufs)) throw invalidChannelMutation('lufs must be finite');
      const entry = cloneEntry(all[mutation.channelId], fallbackRowName(mutation.channel, mutation.channelId));
      copyMetadata(entry, mutation.channel, mutation.channelId);
      entry.lastLufs = { ...(entry.lastLufs || {}), [mutation.kind]: mutation.lufs };
      applyMeasurementReference(entry, mutation, 'lastLufsRef');
      applyMeasurementWindows(entry, mutation);
      entry.lastMeasuredAt = now;
      setFieldVersion(entry, `lastLufs.${mutation.kind}`, mutation.sequence);
      if (mutation.autoGain !== undefined) {
        if (!isStorableGain(mutation.autoGain)) {
          throw invalidChannelMutation('autoGain must be finite and within [0, 6]');
        }
        entry[storeAutoGainFieldForKind(mutation.kind)] = mutation.autoGain;
        setFieldVersion(entry, storeAutoGainFieldForKind(mutation.kind), mutation.sequence);
        applyMeasurementReference(entry, mutation, 'autoGainRef');
      }
      all[mutation.channelId] = entry;
      break;
    }
    case 'clearMeasurement': {
      assertWritableChannelId(mutation.channelId);
      assertKind(mutation.kind);
      const entry = cloneEntry(all[mutation.channelId], mutation.channelId);
      const lastLufs = { ...(entry.lastLufs || {}) };
      delete lastLufs[mutation.kind];
      // What described the measurement goes with it; the Auto gain keeps its
      // own reference.
      for (const field of MEASUREMENT_COMPANION_FIELDS) {
        setMeasurementCompanion(entry, field, mutation.kind, undefined);
      }
      if (Object.keys(lastLufs).length) entry.lastLufs = lastLufs;
      else {
        delete entry.lastLufs;
        delete entry.lastMeasuredAt;
      }
      setFieldVersion(entry, `lastLufs.${mutation.kind}`, mutation.sequence);
      all[mutation.channelId] = entry;
      break;
    }
    case 'saveAutoGain': {
      assertWritableChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (!isStorableGain(mutation.autoGain)) {
        throw invalidChannelMutation('autoGain must be finite and within [0, 6]');
      }
      const entry = cloneEntry(all[mutation.channelId], fallbackRowName(mutation.channel, mutation.channelId));
      copyMetadata(entry, mutation.channel, mutation.channelId);
      entry[storeAutoGainFieldForKind(mutation.kind)] = mutation.autoGain;
      setFieldVersion(entry, storeAutoGainFieldForKind(mutation.kind), mutation.sequence);
      applyMeasurementReference(entry, mutation, 'autoGainRef');
      all[mutation.channelId] = entry;
      break;
    }
    case 'mergeChannelIds':
      mergeProvisionalEntry(all, mutation);
      break;
    case 'normalizeChannels':
      break;
    case 'deleteChannel':
      assertChannelId(mutation.channelId);
      delete all[mutation.channelId];
      break;
    case 'clearChannels':
      return {};
    default:
      throw invalidChannelMutation('unknown channelVolumes mutation');
  }

  return normalizeKnownChannelEntries(all);
}

function maxStoredSequence(all) {
  let maximum = 0;
  for (const entry of Object.values(all || {})) {
    for (const sequence of Object.values(entry?.[FIELD_VERSIONS_FIELD] || {})) {
      if (validSequence(sequence)) maximum = Math.max(maximum, sequence);
    }
  }
  return maximum;
}

function resolveStoredAlias(channelId, aliases) {
  let resolved = channelId;
  const visited = new Set();
  while (typeof resolved === 'string' && !visited.has(resolved)) {
    visited.add(resolved);
    const next = aliases[resolved];
    if (typeof next !== 'string' || next.length === 0 || next === resolved) return resolved;
    resolved = next;
  }
  throw storedStateInvalid(new TypeError('channel alias cycle detected'));
}

// Every id whose alias leads to `channelId`, directly or through another alias.
// The walk ends on the first pass that finds no id it had not found before.
function aliasesLeadingTo(channelId, aliases) {
  const leading = new Set([channelId]);
  for (let found = 0; found < leading.size;) {
    found = leading.size;
    for (const [fromId, toId] of Object.entries(aliases)) {
      if (leading.has(toId)) {
        leading.add(fromId);
      }
    }
  }
  leading.delete(channelId);
  return [...leading];
}

function resolveMutation(mutation, aliases) {
  const resolved = { ...mutation };
  delete resolved.sequence;
  if (typeof mutation.channelId === 'string') {
    resolved.channelId = resolveStoredAlias(mutation.channelId, aliases);
    if (resolved.channelId !== mutation.channelId) {
      // The value mutation still belongs to the canonical channel, but name,
      // login, and URL captured while the sender knew only the provisional ID
      // are not authoritative after alias resolution.
      delete resolved.channel;
    }
  }
  if (mutation.operation === 'mergeChannelIds') {
    const existingTarget = resolveStoredAlias(mutation.fromId, aliases);
    const requestedTarget = resolveStoredAlias(mutation.toId, aliases);
    // Once a provisional ID is canonicalized, a contradictory later owner
    // response must not merge one confirmed owner into another.
    resolved.fromId = existingTarget;
    resolved.toId = existingTarget !== mutation.fromId
      ? existingTarget
      : requestedTarget;
  }
  return resolved;
}

function mutationNeedsSequence(operation) {
  return operation === 'saveGain' || operation === 'saveAuto' ||
    operation === 'saveMeasurement' || operation === 'clearMeasurement' ||
    operation === 'saveAutoGain';
}

function createChannelVolumesWriter(
  storageArea,
  storageKey = 'channelVolumes',
  clock = Date.now,
  aliasesKey = CHANNEL_ALIASES_KEY,
  sequenceKey = CHANNEL_SEQUENCE_KEY
) {
  const enqueue = createSerialQueue();

  return function enqueueChannelVolumesMutation(mutation) {
    const task = enqueue(async () => {
      const originalFromId = mutation?.operation === 'mergeChannelIds'
        ? mutation.fromId
        : '';
      const data = await storageArea.get([storageKey, aliasesKey, sequenceKey]);
      const current = data[storageKey] || {};
      const aliases = data[aliasesKey] && typeof data[aliasesKey] === 'object'
        ? { ...data[aliasesKey] }
        : {};
      let sequence = Math.max(
        validSequence(data[sequenceKey]) ? data[sequenceKey] : 0,
        maxStoredSequence(current)
      );
      const resolvedMutation = resolveMutation(mutation, aliases);
      if (mutationNeedsSequence(resolvedMutation.operation)) {
        if (sequence >= Number.MAX_SAFE_INTEGER) {
          throw storedStateInvalid(new RangeError('channel mutation sequence exhausted'));
        }
        resolvedMutation.sequence = ++sequence;
      }
      const next = applyChannelVolumesMutation(current, resolvedMutation, clock());
      if (resolvedMutation.operation === 'mergeChannelIds') {
        if (originalFromId !== resolvedMutation.toId) {
          aliases[originalFromId] = resolvedMutation.toId;
        }
      } else if (resolvedMutation.operation === 'clearChannels') {
        for (const id of Object.keys(aliases)) delete aliases[id];
      }
      if (resolvedMutation.operation !== 'clearChannels') {
        for (const { fromId, toId } of knownLoginTargets(next)) {
          aliases[fromId] = toId;
        }
      }
      // A row that is gone, and was not moved onto another id, takes every
      // name that led to it along: a deleted channel, and a row a clip was the
      // whole of.
      for (const id of Object.keys(current)) {
        if (!Object.prototype.hasOwnProperty.call(next, id) &&
            !Object.prototype.hasOwnProperty.call(aliases, id)) {
          for (const fromId of aliasesLeadingTo(id, aliases)) delete aliases[fromId];
        }
      }
      // A clip stood in under a name of its own until the numeric ID arrived.
      // Nothing is kept for a clip now, so the name points at nothing.
      for (const id of Object.keys(aliases)) {
        if (id.startsWith(CLIP_PROVISIONAL_PREFIX)) delete aliases[id];
      }
      // A write that would store what is on file already is left out.
      if (sameStoredValue(next, data[storageKey]) &&
          sameStoredValue(aliases, data[aliasesKey]) &&
          sequence === data[sequenceKey]) {
        return next;
      }
      await storageArea.set({
        [storageKey]: next,
        [aliasesKey]: aliases,
        [sequenceKey]: sequence
      });
      return next;
    });
    return task;
  };
}

const TCV_CHANNEL_STORE = {
  CHANNEL_MUTATION_MESSAGE,
  CHANNEL_ALIASES_KEY,
  CHANNEL_SEQUENCE_KEY,
  applyChannelVolumesMutation,
  createChannelVolumesWriter
};

if (typeof globalThis !== 'undefined') globalThis.TCVChannelStore = TCV_CHANNEL_STORE;
if (typeof module !== 'undefined' && module.exports) module.exports = TCV_CHANNEL_STORE;
