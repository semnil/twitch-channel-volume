// channel-store.js — Serialized channelVolumes mutations for the service worker.

const CHANNEL_MUTATION_MESSAGE = '__twitch_channel_volume_channel_mutation__';
const CHANNEL_MUTATION_KINDS = new Set(['live', 'vod', 'clip']);
const CHANNEL_ALIASES_KEY = 'channelVolumeAliases';
const CHANNEL_SEQUENCE_KEY = 'channelVolumeSequence';
const FIELD_VERSIONS_FIELD = '__fieldVersions';
const LEGACY_PROVISIONAL_WRITES_FIELD = '__provisionalWrites';

function storeGainFieldForKind(kind) {
  if (kind === 'vod') return 'gainVod';
  if (kind === 'clip') return 'gainClip';
  return 'gainLive';
}

function storeAutoFieldForKind(kind) {
  if (kind === 'vod') return 'autoApplyLoudnessVod';
  if (kind === 'clip') return 'autoApplyLoudnessClip';
  return 'autoApplyLoudnessLive';
}

function storeAutoGainFieldForKind(kind) {
  if (kind === 'vod') return 'autoGainVod';
  if (kind === 'clip') return 'autoGainClip';
  return 'autoGainLive';
}

function assertChannelId(value, field = 'channelId') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertKind(kind) {
  if (!CHANNEL_MUTATION_KINDS.has(kind)) {
    throw new TypeError('kind must be live, vod, or clip');
  }
}

function validSequence(sequence) {
  return Number.isSafeInteger(sequence) && sequence > 0;
}

function copyMetadata(entry, channel) {
  if (!channel || typeof channel !== 'object') return;
  for (const field of ['name', 'login', 'url']) {
    if (typeof channel[field] === 'string' && channel[field]) {
      entry[field] = channel[field];
    }
  }
}

function expandLegacyGain(entry) {
  if (!Object.prototype.hasOwnProperty.call(entry, 'gain')) return entry;
  const legacyGain = entry.gain;
  for (const kind of CHANNEL_MUTATION_KINDS) {
    const field = storeGainFieldForKind(kind);
    if (!Number.isFinite(entry[field]) && Number.isFinite(legacyGain)) {
      entry[field] = legacyGain;
    }
  }
  delete entry.gain;
  return entry;
}

function expandLegacyAuto(entry) {
  if (!Object.prototype.hasOwnProperty.call(entry, 'autoApplyLoudness')) return entry;
  const legacyAuto = !!entry.autoApplyLoudness;
  for (const kind of CHANNEL_MUTATION_KINDS) {
    const field = storeAutoFieldForKind(kind);
    if (!Object.prototype.hasOwnProperty.call(entry, field)) entry[field] = legacyAuto;
  }
  delete entry.autoApplyLoudness;
  return entry;
}

function cloneEntry(entry, fallbackName) {
  const cloned = { ...(entry || { name: fallbackName }) };
  if (entry?.lastLufs) cloned.lastLufs = { ...entry.lastLufs };
  if (entry?.[FIELD_VERSIONS_FIELD] && typeof entry[FIELD_VERSIONS_FIELD] === 'object') {
    cloned[FIELD_VERSIONS_FIELD] = { ...entry[FIELD_VERSIONS_FIELD] };
  }
  delete cloned[LEGACY_PROVISIONAL_WRITES_FIELD];
  return expandLegacyAuto(expandLegacyGain(cloned));
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
    const login = normalizeLogin(entry?.login);
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
  if (!validSequence(sequence)) throw new TypeError('sequence must be a positive safe integer');
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
  const sourceHas = Object.prototype.hasOwnProperty.call(source, field);
  const targetHas = Object.prototype.hasOwnProperty.call(target, field);
  if (!sourceHas || (targetHas && fieldVersion(source, field) <= fieldVersion(target, field))) {
    return;
  }
  merged[field] = source[field];
  const version = fieldVersion(source, field);
  if (version) mergedVersions[field] = version;
  else delete mergedVersions[field];
}

function copyNewerLufs(mergedLufs, mergedVersions, source, target, kind) {
  const sourceLufs = source.lastLufs || {};
  const targetLufs = target.lastLufs || {};
  const versionField = `lastLufs.${kind}`;
  const sourceHas = Object.prototype.hasOwnProperty.call(sourceLufs, kind);
  const targetHas = Object.prototype.hasOwnProperty.call(targetLufs, kind);
  if (!sourceHas ||
      (targetHas && fieldVersion(source, versionField) <= fieldVersion(target, versionField))) {
    return;
  }
  mergedLufs[kind] = sourceLufs[kind];
  const version = fieldVersion(source, versionField);
  if (version) mergedVersions[versionField] = version;
  else delete mergedVersions[versionField];
}

function mergeProvisionalEntry(all, mutation) {
  const { fromId, toId, kind, channel } = mutation;
  assertChannelId(fromId, 'fromId');
  assertChannelId(toId, 'toId');
  assertKind(kind);
  if (fromId === toId || !all[fromId]) return;

  const source = cloneEntry(all[fromId], fromId);
  const target = cloneEntry(all[toId], channel?.name || toId);
  const merged = { ...source, ...target };
  const mergedVersions = {
    ...(source[FIELD_VERSIONS_FIELD] || {}),
    ...(target[FIELD_VERSIONS_FIELD] || {})
  };

  // Legacy conflicts (no version) keep the confirmed-ID value. Once the
  // single writer has assigned versions, the later field update wins no
  // matter which tab issued it.
  for (const mergeKind of CHANNEL_MUTATION_KINDS) {
    copyNewerField(merged, mergedVersions, source, target, storeGainFieldForKind(mergeKind));
    copyNewerField(merged, mergedVersions, source, target, storeAutoFieldForKind(mergeKind));
    copyNewerField(merged, mergedVersions, source, target, storeAutoGainFieldForKind(mergeKind));
  }

  const sourceLufs = source.lastLufs || {};
  const targetLufs = target.lastLufs || {};
  const mergedLufs = { ...sourceLufs, ...targetLufs };
  for (const mergeKind of CHANNEL_MUTATION_KINDS) {
    copyNewerLufs(mergedLufs, mergedVersions, source, target, mergeKind);
  }
  if (Object.keys(mergedLufs).length) merged.lastLufs = mergedLufs;
  if (Object.keys(mergedVersions).length) merged[FIELD_VERSIONS_FIELD] = mergedVersions;
  else delete merged[FIELD_VERSIONS_FIELD];
  if (Number.isFinite(source.lastMeasuredAt) || Number.isFinite(target.lastMeasuredAt)) {
    merged.lastMeasuredAt = Math.max(
      Number.isFinite(source.lastMeasuredAt) ? source.lastMeasuredAt : 0,
      Number.isFinite(target.lastMeasuredAt) ? target.lastMeasuredAt : 0
    );
  }
  copyMetadata(merged, channel);
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
      copyMetadata(target, channel);
    }
  }
  return all;
}

function applyChannelVolumesMutation(currentValue, mutation, now = Date.now()) {
  if (!mutation || typeof mutation !== 'object') {
    throw new TypeError('mutation must be an object');
  }
  const all = { ...(currentValue || {}) };

  switch (mutation.operation) {
    case 'saveGain': {
      assertChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (!Number.isFinite(mutation.gain) || mutation.gain < 0 || mutation.gain > 6) {
        throw new TypeError('gain must be finite and within [0, 6]');
      }
      const entry = cloneEntry(all[mutation.channelId], mutation.channel?.name || mutation.channelId);
      copyMetadata(entry, mutation.channel);
      entry[storeGainFieldForKind(mutation.kind)] = mutation.gain;
      setFieldVersion(entry, storeGainFieldForKind(mutation.kind), mutation.sequence);
      all[mutation.channelId] = entry;
      break;
    }
    case 'saveAuto': {
      assertChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (typeof mutation.enabled !== 'boolean') {
        throw new TypeError('enabled must be a boolean');
      }
      const entry = cloneEntry(all[mutation.channelId], mutation.channel?.name || mutation.channelId);
      copyMetadata(entry, mutation.channel);
      entry[storeAutoFieldForKind(mutation.kind)] = mutation.enabled;
      setFieldVersion(entry, storeAutoFieldForKind(mutation.kind), mutation.sequence);
      if (mutation.autoGain !== undefined) {
        if (!Number.isFinite(mutation.autoGain) || mutation.autoGain < 0 || mutation.autoGain > 6) {
          throw new TypeError('autoGain must be finite and within [0, 6]');
        }
        entry[storeAutoGainFieldForKind(mutation.kind)] = mutation.autoGain;
        setFieldVersion(entry, storeAutoGainFieldForKind(mutation.kind), mutation.sequence);
      }
      all[mutation.channelId] = entry;
      break;
    }
    case 'saveMeasurement': {
      assertChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (!Number.isFinite(mutation.lufs)) throw new TypeError('lufs must be finite');
      const entry = cloneEntry(all[mutation.channelId], mutation.channel?.name || mutation.channelId);
      copyMetadata(entry, mutation.channel);
      entry.lastLufs = { ...(entry.lastLufs || {}), [mutation.kind]: mutation.lufs };
      entry.lastMeasuredAt = now;
      setFieldVersion(entry, `lastLufs.${mutation.kind}`, mutation.sequence);
      if (mutation.autoGain !== undefined) {
        if (!Number.isFinite(mutation.autoGain) || mutation.autoGain < 0 || mutation.autoGain > 6) {
          throw new TypeError('autoGain must be finite and within [0, 6]');
        }
        entry[storeAutoGainFieldForKind(mutation.kind)] = mutation.autoGain;
        setFieldVersion(entry, storeAutoGainFieldForKind(mutation.kind), mutation.sequence);
      }
      all[mutation.channelId] = entry;
      break;
    }
    case 'saveAutoGain': {
      assertChannelId(mutation.channelId);
      assertKind(mutation.kind);
      if (!Number.isFinite(mutation.autoGain) || mutation.autoGain < 0 || mutation.autoGain > 6) {
        throw new TypeError('autoGain must be finite and within [0, 6]');
      }
      const entry = cloneEntry(all[mutation.channelId], mutation.channel?.name || mutation.channelId);
      copyMetadata(entry, mutation.channel);
      entry[storeAutoGainFieldForKind(mutation.kind)] = mutation.autoGain;
      setFieldVersion(entry, storeAutoGainFieldForKind(mutation.kind), mutation.sequence);
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
      throw new TypeError('unknown channelVolumes mutation');
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
  throw new TypeError('channel alias cycle detected');
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
    operation === 'saveMeasurement' || operation === 'saveAutoGain';
}

function createChannelVolumesWriter(
  storageArea,
  storageKey = 'channelVolumes',
  clock = Date.now,
  aliasesKey = CHANNEL_ALIASES_KEY,
  sequenceKey = CHANNEL_SEQUENCE_KEY
) {
  let queue = Promise.resolve();

  return function enqueueChannelVolumesMutation(mutation) {
    const task = queue.then(async () => {
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
        if (sequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('channel mutation sequence exhausted');
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
      await storageArea.set({
        [storageKey]: next,
        [aliasesKey]: aliases,
        [sequenceKey]: sequence
      });
      return next;
    });
    // Keep the single-writer queue usable after one failed storage operation.
    queue = task.catch(() => {});
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
