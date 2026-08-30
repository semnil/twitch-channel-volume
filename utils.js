// utils.js — Shared constants and utilities for Twitch Channel Volume

const SETTINGS_KEY = 'autoLoudnessSettings';
const SETTINGS_MUTATION_MESSAGE = '__twitch_channel_volume_settings_mutation__';
const CHANNEL_VOLUMES_KEY = 'channelVolumes';
const CHANNEL_ALIASES_KEY = 'channelVolumeAliases';
const CHANNEL_SEQUENCE_KEY = 'channelVolumeSequence';
const DEFAULT_TARGET_LUFS = -18;
const DEFAULT_AD_GAIN_DB = -6;
const DEFAULT_AUTO_APPLY_LOUDNESS = false;
// Saved LUFS carrying this reference was measured with the player volume
// divided out, so it is comparable across volume settings.
const LUFS_REFERENCE_VOLUME_1 = 'volume1';

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const DISPLAY_UPDATE_INTERVAL_MS = 1000;
const MIN_GAIN = 0;
const MAX_GAIN = 6;

function gainToPercent(gain) { return Math.round(gain * 100); }
function percentToGain(pct) { return pct / 100; }

function gainToDb(gain) {
  if (gain <= 0) return '-Inf';
  return (20 * Math.log10(gain)).toFixed(1);
}

function dbToGain(db) { return Math.pow(10, db / 20); }

function msg(key, substitutions) {
  if (typeof chrome === 'undefined' || !chrome?.i18n) return key;
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function formatGain(gain, displayUnit) {
  if (displayUnit === 'dB') return { text: gainToDb(gain), unit: ' dB' };
  return { text: String(gainToPercent(gain)), unit: '%' };
}

function formatAutoGain(gain, displayUnit, autoLabel = 'Auto') {
  const formatted = formatGain(Number.isFinite(gain) ? gain : 1.0, displayUnit);
  return `${autoLabel} (${formatted.text}${formatted.unit})`;
}

function gainFieldForKind(kind) {
  if (kind === 'vod') return 'gainVod';
  return 'gainLive';
}

function extractGainForKind(entry, kind) {
  if (!entry) return null;
  const typedGain = entry[gainFieldForKind(kind)];
  if (Number.isFinite(typedGain)) return typedGain;
  return Number.isFinite(entry.gain) ? entry.gain : null;
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

function resolveAutoApplySetting(entry, kind, defaultValue) {
  if (!entry) return !!defaultValue;
  const autoKey = autoApplyFieldForKind(kind);
  if (Object.prototype.hasOwnProperty.call(entry, autoKey)) return !!entry[autoKey];
  // Read compatibility for a possible early all-types implementation.
  if (Object.prototype.hasOwnProperty.call(entry, 'autoApplyLoudness')) {
    return !!entry.autoApplyLoudness;
  }

  // A saved manual gain is an implicit per-channel choice. Global Auto
  // defaults only apply to a channel/type with neither an Auto choice nor a
  // manual gain.
  if (extractGainForKind(entry, kind) !== null) return false;
  return !!defaultValue;
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
  const compensationDb = targetLufs - measuredLufs;
  const gain = Math.pow(10, compensationDb / 20);
  if (!Number.isFinite(gain)) return 1.0;
  return Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain));
}

// Without a gated measurement there is nothing that justifies a boost, so the
// suggestion stays at unity.
function suggestedGain(integratedLufs, targetLufs) {
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(targetLufs)) return 1.0;
  return calcGain(integratedLufs, targetLufs);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
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

function ownerMatchesTwitchContent(owner, classified) {
  if (!owner?.userId || !owner.contentId || owner.contentKind !== classified?.kind) {
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

// K-weighting IIR coefficients (BS.1770-4, normalized for 48 kHz) -----

const K_PRE_48K = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [1.0, -1.69065929318241, 0.73248077421585]
};
const K_RLB_48K = {
  b: [1.0, -2.0, 1.0],
  a: [1.0, -1.99004745483398, 0.99007225036621]
};

// Bilinear-transform coefficients to a target sample rate.
// Reference filter is defined at fs0 = 48000 Hz; the (b, a) pairs are
// re-derived analytically for arbitrary fs. Implements the same approach
// as ffmpeg's loudnorm: extract pole/zero parameters via Z-domain analysis
// at 48 kHz, then re-generate at fs.
function kWeightingForSampleRate(sampleRate) {
  const sr = Number(sampleRate) || 48000;
  if (Math.abs(sr - 48000) < 1) return { pre: K_PRE_48K, rlb: K_RLB_48K };
  return {
    pre: redesignBiquad(K_PRE_48K, 48000, sr),
    rlb: redesignBiquad(K_RLB_48K, 48000, sr)
  };
}

// Re-design biquad: convert (b, a) defined at fs0 to fs by inverse bilinear
// then re-bilinear at fs. This preserves the analog response shape.
function redesignBiquad(coef, fs0, fs) {
  const K0 = 2 * fs0;
  const { b, a } = coef;
  // Inverse bilinear to s-domain (Tustin): z = (K0 + s) / (K0 - s)
  // Numerator/denominator in s: solve polynomial substitution.
  // For a biquad H(z) = (b0 + b1 z^-1 + b2 z^-2) / (a0 + a1 z^-1 + a2 z^-2),
  // analog form H(s) = (B0 + B1 s + B2 s^2) / (A0 + A1 s + A2 s^2).
  const [b0, b1, b2] = b;
  const [a0, a1, a2] = a;
  const B0 = b0 + b1 + b2;
  const B1 = 2 * (b0 - b2) / K0;
  const B2 = (b0 - b1 + b2) / (K0 * K0);
  const A0 = a0 + a1 + a2;
  const A1 = 2 * (a0 - a2) / K0;
  const A2 = (a0 - a1 + a2) / (K0 * K0);
  const K = 2 * fs;
  const K2 = K * K;
  const denom = A0 + A1 * K + A2 * K2;
  return {
    b: [
      (B0 + B1 * K + B2 * K2) / denom,
      (2 * B0 - 2 * B2 * K2) / denom,
      (B0 - B1 * K + B2 * K2) / denom
    ],
    a: [
      1.0,
      (2 * A0 - 2 * A2 * K2) / denom,
      (A0 - A1 * K + A2 * K2) / denom
    ]
  };
}

function meanSquareToLufs(meanSquare) {
  if (!Number.isFinite(meanSquare) || meanSquare <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(meanSquare);
}

// Integrated loudness (BS.1770 gated): given an array of momentary MS
// values (each representing a 400ms block, 75% overlapped), apply the
// absolute gate at -70 LUFS and the relative gate at -10 LU below the
// ungated mean.
function gatedIntegratedLufs(blockMs) {
  const valid = blockMs.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (valid.length === 0) return -Infinity;
  const absGateMs = Math.pow(10, (ABSOLUTE_GATE_LUFS + 0.691) / 10);
  const passAbs = valid.filter((ms) => ms >= absGateMs);
  if (passAbs.length === 0) return -Infinity;
  const meanAbs = passAbs.reduce((s, v) => s + v, 0) / passAbs.length;
  const relGateLufs = meanSquareToLufs(meanAbs) + RELATIVE_GATE_LU;
  const relGateMs = Math.pow(10, (relGateLufs + 0.691) / 10);
  const passRel = passAbs.filter((ms) => ms >= relGateMs);
  if (passRel.length === 0) return -Infinity;
  const meanRel = passRel.reduce((s, v) => s + v, 0) / passRel.length;
  return meanSquareToLufs(meanRel);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTINGS_KEY, SETTINGS_MUTATION_MESSAGE,
    CHANNEL_VOLUMES_KEY, CHANNEL_ALIASES_KEY, CHANNEL_SEQUENCE_KEY,
    DEFAULT_TARGET_LUFS, DEFAULT_AD_GAIN_DB, DEFAULT_AUTO_APPLY_LOUDNESS,
    ABSOLUTE_GATE_LUFS, RELATIVE_GATE_LU, LUFS_REFERENCE_VOLUME_1,
    DISPLAY_UPDATE_INTERVAL_MS,
    MIN_GAIN, MAX_GAIN,
    gainToPercent, percentToGain, gainToDb, dbToGain,
    formatGain, formatAutoGain, calcGain, suggestedGain,
    gainFieldForKind, extractGainForKind,
    autoGainFieldForKind, extractAutoGainForKind, extractAutoDisplayGain,
    autoApplyFieldForKind, autoApplyDefaultFieldForKind,
    resolveAutoApplySetting, resolvePreferredGain,
    classifyTwitchUrl, ownerMatchesTwitchContent, provisionalChannelIdForContent,
    resolveChannelIdAlias, twitchChannelUrlForEntry,
    kWeightingForSampleRate, redesignBiquad,
    K_PRE_48K, K_RLB_48K,
    meanSquareToLufs, gatedIntegratedLufs
  };
}
