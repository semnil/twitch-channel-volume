// core/common.js — The helpers the channel-volume extensions share, loaded as
// a classic script ahead of each extension's own scripts in the content
// script, the popup, the options page and the service worker. Every name here
// is a top-level declaration the scripts after it read.

// The key the settings object is stored under: in chrome.storage.sync, and in
// chrome.storage.local in a profile whose settings have not been moved yet.
const SETTINGS_KEY = 'autoLoudnessSettings';
// The Target LUFS where the settings hold none.
const DEFAULT_TARGET_LUFS = -18;
// The range of Target LUFS a setting takes.
const MIN_TARGET_LUFS = -30;
const MAX_TARGET_LUFS = -6;
// The range of a gain: 0 is silence, 6 is 600%.
const MIN_GAIN = 0;
const MAX_GAIN = 6;

// Whether this context can still reach the extension's runtime: false once the
// extension has been reloaded or removed under it.
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

// Gain is a linear factor: 1 is 100% and 0 dB.
function gainToPercent(gain) { return Math.round(gain * 100); }
function percentToGain(pct) { return pct / 100; }

function gainToDb(gain) {
  if (gain <= 0) return '-Inf';
  return (20 * Math.log10(gain)).toFixed(1);
}

// The catalog's text for key, or the key itself where the catalog has none or
// there is no chrome.i18n to ask.
function msg(key, substitutions) {
  if (typeof chrome === 'undefined' || !chrome?.i18n) return key;
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// The gain as the text and unit the display unit setting shows it in.
function formatGain(gain, displayUnit) {
  if (displayUnit === 'dB') return { text: gainToDb(gain), unit: ' dB' };
  return { text: String(gainToPercent(gain)), unit: '%' };
}

// The gain that takes audio playing at levelLufs to targetLufs, within the
// gain range. 1 where that gain is not a finite number.
function gainForLevel(levelLufs, targetLufs) {
  const gain = Math.pow(10, (targetLufs - levelLufs) / 20);
  if (!Number.isFinite(gain)) return 1.0;
  return Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain));
}

// The label of a row's Auto gain on the settings page: the stored gain in the
// display unit, or a dash where the row holds no gain.
function formatAutoGain(gain, displayUnit, autoLabel = 'Auto') {
  if (!Number.isFinite(gain)) return `${autoLabel} (—)`;
  const formatted = formatGain(gain, displayUnit);
  return `${autoLabel} (${formatted.text}${formatted.unit})`;
}

// The keys that move a range input's value. A key hold on a slider is made of
// these alone; any other key takes no part in it.
const SLIDER_VALUE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'
]);

function isSliderMoveKey(key) {
  return SLIDER_VALUE_KEYS.has(key);
}

// The value keys down on one slider. press answers whether a keydown begins a
// hold: a value key, not a repeat, pressed with no other value key down.
// release answers whether a keyup ends it: the last value key down let go of.
// Any other key, and a repeat, change nothing.
function createSliderKeys() {
  const down = new Set();
  return {
    press(event) {
      if (event.repeat || !SLIDER_VALUE_KEYS.has(event.key)) return false;
      down.add(event.key);
      return down.size === 1;
    },
    release(event) {
      return down.delete(event.key) && down.size === 0;
    },
    clear() { down.clear(); }
  };
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  // Serialising a text node leaves both quotes alone, and every caller puts the
  // result inside a quoted attribute as well as between tags.
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
