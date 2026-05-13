// utils.js — Shared constants and utilities for Twitch Channel Volume

const SETTINGS_KEY = 'autoLoudnessSettings';
const CHANNEL_VOLUMES_KEY = 'channelVolumes';
const DEFAULT_TARGET_LUFS = -18;
const DEFAULT_AD_GAIN_DB = -6;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const MOMENTARY_WINDOW_SEC = 0.4;
const SHORT_TERM_WINDOW_SEC = 3.0;
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

function calcGain(measuredLufs, targetLufs) {
  if (!Number.isFinite(measuredLufs)) return 1.0;
  const compensationDb = targetLufs - measuredLufs;
  const gain = Math.pow(10, compensationDb / 20);
  if (!Number.isFinite(gain)) return 1.0;
  return Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain));
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

// HLS EXT-X-DATERANGE parsing ------------------------------------------

function parseDateRange(line) {
  if (!line.startsWith('#EXT-X-DATERANGE:')) return null;
  const body = line.slice('#EXT-X-DATERANGE:'.length);
  const attrs = {};
  // Attribute list: KEY=VALUE pairs; values may be quoted strings.
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return attrs;
}

function isAdDateRange(attrs) {
  if (!attrs) return false;
  if (attrs.CLASS === 'twitch-stitched-ad') return true;
  if (typeof attrs.ID === 'string' && attrs.ID.startsWith('stitched-ad-')) return true;
  return false;
}

function parseAdRangesFromManifest(text) {
  const ranges = [];
  if (typeof text !== 'string') return ranges;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-DATERANGE:')) continue;
    const a = parseDateRange(line);
    if (!isAdDateRange(a)) continue;
    const start = a['START-DATE'] ? Date.parse(a['START-DATE']) : NaN;
    const dur = a.DURATION ? Number(a.DURATION) : NaN;
    ranges.push({
      id: a.ID || '',
      commercialId: a['X-TV-TWITCH-AD-COMMERCIAL-ID'] || '',
      rollType: a['X-TV-TWITCH-AD-ROLL-TYPE'] || '',
      startMs: Number.isFinite(start) ? start : null,
      durationSec: Number.isFinite(dur) ? dur : null
    });
  }
  return ranges;
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
    SETTINGS_KEY, CHANNEL_VOLUMES_KEY,
    DEFAULT_TARGET_LUFS, DEFAULT_AD_GAIN_DB,
    ABSOLUTE_GATE_LUFS, RELATIVE_GATE_LU,
    MOMENTARY_WINDOW_SEC, SHORT_TERM_WINDOW_SEC,
    MIN_GAIN, MAX_GAIN,
    gainToPercent, percentToGain, gainToDb, dbToGain,
    formatGain, calcGain,
    classifyTwitchUrl,
    parseDateRange, isAdDateRange, parseAdRangesFromManifest,
    kWeightingForSampleRate, redesignBiquad,
    K_PRE_48K, K_RLB_48K,
    meanSquareToLufs, gatedIntegratedLufs
  };
}
