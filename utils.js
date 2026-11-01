// utils.js — Shared constants and utilities for Twitch Channel Volume

const SETTINGS_MUTATION_MESSAGE = '__twitch_channel_volume_settings_mutation__';
const CHANNEL_VOLUMES_KEY = 'channelVolumes';
const CHANNEL_ALIASES_KEY = 'channelVolumeAliases';
const CHANNEL_SEQUENCE_KEY = 'channelVolumeSequence';
const DEFAULT_AD_GAIN_DB = -6;
// Saved LUFS carrying this reference was measured with the player volume
// divided out, so it is comparable across volume settings.
const LUFS_REFERENCE_VOLUME_1 = 'volume1';

function dbToGain(db) { return Math.pow(10, db / 20); }

function gainFieldForKind(kind) {
  if (kind === 'vod') return 'gainVod';
  return 'gainLive';
}

// The keys of an entry's gains per kind.
const GAIN_SLOTS = ['gainLive', 'gainVod'];

function extractGainForKind(entry, kind) {
  return storedGain(entry, gainFieldForKind(kind), GAIN_SLOTS);
}

function autoGainFieldForKind(kind) {
  if (kind === 'vod') return 'autoGainVod';
  return 'autoGainLive';
}

function extractAutoGainForKind(entry, kind) {
  if (!entry) return null;
  const gain = entry[autoGainFieldForKind(kind)];
  return Number.isFinite(gain) ? gain : null;
}

function extractAutoDisplayGain(entry, kind) {
  return referencedAutoGainForKind(entry, kind) ?? extractGainForKind(entry, kind);
}

function autoApplyFieldForKind(kind) {
  if (kind === 'vod') return 'autoApplyLoudnessVod';
  return 'autoApplyLoudnessLive';
}

function autoApplyDefaultFieldForKind(kind) {
  return autoApplyFieldForKind(kind) + 'Default';
}

// A saved manual gain is an implicit per-channel choice. Global Auto defaults
// only apply to a channel/type with neither an Auto choice nor a manual gain.
function resolveAutoApplySetting(entry, kind, defaultValue) {
  return autoFlagFor(entry, autoApplyFieldForKind(kind), defaultValue,
    extractGainForKind(entry, kind) !== null);
}

// A saved Auto gain was computed from a measurement. Without the reference the
// player volume behind that measurement is unknown, so it is not applied.
function referencedAutoGainForKind(entry, kind) {
  if (entry?.autoGainRef?.[kind] !== LUFS_REFERENCE_VOLUME_1) return null;
  return extractAutoGainForKind(entry, kind);
}

function resolvePreferredGain(entry, kind, defaultAuto, measuredLufs, targetLufs) {
  const autoApply = resolveAutoApplySetting(entry, kind, defaultAuto);
  const manualGain = extractGainForKind(entry, kind);
  const gain = autoApply && Number.isFinite(measuredLufs)
    ? calcGain(measuredLufs, targetLufs)
    : (autoApply ? referencedAutoGainForKind(entry, kind) : null) ?? manualGain ?? 1.0;
  return { autoApply, gain };
}

function calcGain(measuredLufs, targetLufs) {
  if (!Number.isFinite(measuredLufs)) return 1.0;
  return gainForLevel(measuredLufs, targetLufs);
}

// Without a gated measurement there is nothing that justifies a boost, so the
// suggestion stays at unity.
function suggestedGain(integratedLufs, targetLufs) {
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(targetLufs)) return 1.0;
  return calcGain(integratedLufs, targetLufs);
}

// URL classification ----------------------------------------------------

const TWITCH_RESERVED_PATHS = new Set([
  'directory', 'subscriptions', 'inventory', 'wallet', 'drops',
  'settings', 'friends', 'following', 'p', 'jobs', 'turbo',
  'videos', 'login', 'signup', 'search'
]);

function classifyTwitchUrl(href) {
  let url;
  try { url = new URL(href); } catch (_) { return { kind: 'none' }; }
  const host = url.hostname;
  const segs = url.pathname.split('/').filter(Boolean);

  if (host === 'clips.twitch.tv' && segs.length >= 1) {
    return { kind: 'clip', slug: segs[0] };
  }
  if (host.endsWith('twitch.tv')) {
    if (segs[0] === 'videos' && segs[1]) {
      return { kind: 'vod', videoId: segs[1] };
    }
    if (segs.length >= 3 && segs[1] === 'clip') {
      return { kind: 'clip', slug: segs[2], login: segs[0].toLowerCase() };
    }
    if (segs.length === 1 && !TWITCH_RESERVED_PATHS.has(segs[0])) {
      return { kind: 'live', login: segs[0].toLowerCase() };
    }
  }
  return { kind: 'none' };
}

// The owner event can be posted by any script in the page's own world as well
// as by the bridge. It names a channel only with a Twitch user id, a string of
// digits, and a content id that is text.
function ownerMatchesTwitchContent(owner, classified) {
  if (typeof owner?.userId !== 'string' || !/^\d+$/.test(owner.userId) ||
      typeof owner.contentId !== 'string' || !owner.contentId ||
      owner.contentKind !== classified?.kind) {
    return false;
  }
  if (classified.kind === 'live') {
    return owner.source === 'user' &&
      owner.contentId.toLowerCase() === classified.login;
  }
  if (classified.kind === 'vod') {
    return owner.source === 'video' && owner.contentId === String(classified.videoId);
  }
  return false;
}

function provisionalChannelIdForContent(classified) {
  if (classified?.kind === 'live' && classified.login) {
    return `login:${classified.login}`;
  }
  if (classified?.kind === 'vod') return `vod-owner:${classified.videoId}`;
  return '';
}

function resolveChannelIdAlias(channelId, aliases) {
  if (typeof channelId !== 'string' || !aliases || typeof aliases !== 'object') {
    return channelId;
  }
  let resolved = channelId;
  const visited = new Set();
  while (!visited.has(resolved)) {
    visited.add(resolved);
    const next = aliases[resolved];
    if (typeof next !== 'string' || next.length === 0 || next === resolved) {
      return resolved;
    }
    resolved = next;
  }
  // A valid alias graph is acyclic. On corrupt/cyclic input, do not redirect
  // the caller to a path-dependent ID.
  return channelId;
}

function twitchChannelUrlForEntry(channelId, entry) {
  let login = typeof entry?.login === 'string' ? entry.login.trim().toLowerCase() : '';
  if (!login && typeof channelId === 'string' && channelId.startsWith('login:')) {
    login = channelId.slice('login:'.length).trim().toLowerCase();
  }
  return /^[a-z0-9_]+$/.test(login) ? `https://www.twitch.tv/${login}` : '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTINGS_KEY, SETTINGS_MUTATION_MESSAGE, isStoredSettingsObject, readSettings,
    CHANNEL_VOLUMES_KEY, CHANNEL_ALIASES_KEY, CHANNEL_SEQUENCE_KEY,
    DEFAULT_TARGET_LUFS, DEFAULT_AD_GAIN_DB,
    LUFS_REFERENCE_VOLUME_1,
    MIN_GAIN, MAX_GAIN,
    gainToPercent, percentToGain, gainToDb, dbToGain,
    formatGain, formatAutoGain, calcGain, suggestedGain,
    gainFieldForKind, extractGainForKind,
    autoGainFieldForKind, extractAutoGainForKind, extractAutoDisplayGain,
    autoApplyFieldForKind, autoApplyDefaultFieldForKind,
    resolveAutoApplySetting, resolvePreferredGain,
    TWITCH_RESERVED_PATHS, classifyTwitchUrl, ownerMatchesTwitchContent, provisionalChannelIdForContent,
    resolveChannelIdAlias, twitchChannelUrlForEntry,
    SLIDER_VALUE_KEYS, createSliderKeys,
    esc, msg
  };
}
