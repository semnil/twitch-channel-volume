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

// Whether a stored settings value is one a reader takes: an object, neither
// null nor an array.
function isStoredSettingsObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The settings, from sync first. A profile an earlier version wrote holds them
// in local until the service worker moves them, and that copy stands in until
// then. The move writes sync before it removes local, so the two reads can
// straddle it: sync read empty, then local read after the move cleared it. A
// local read that finds nothing is followed by a second read of sync, which
// then holds what the move put there. {} where neither area holds a settings
// object.
async function readSettings(storage = chrome.storage, key = SETTINGS_KEY) {
  const synced = (await storage.sync.get(key))[key];
  if (isStoredSettingsObject(synced)) return synced;
  const local = (await storage.local.get(key))[key];
  if (isStoredSettingsObject(local)) return local;
  const moved = (await storage.sync.get(key))[key];
  return isStoredSettingsObject(moved) ? moved : {};
}

// Moves settings an earlier version kept in local to sync. Settings another
// Chrome the user is signed in to already put in sync, with Chrome sync on, are
// the ones every such Chrome reads, so they stay and the local copy goes. Sync
// is written before local is removed, so a reader always finds one of the two.
// keep gives what of local's settings is written to sync. Answers whether
// local held anything under key.
async function moveSettingsToSync(storage = chrome.storage, key = SETTINGS_KEY, keep = (settings) => settings) {
  const local = (await storage.local.get(key))[key];
  if (local === undefined) return false;
  const synced = (await storage.sync.get(key))[key];
  if (!isStoredSettingsObject(synced) && isStoredSettingsObject(local)) {
    await storage.sync.set({ [key]: keep(local) });
  }
  await storage.local.remove(key);
  return true;
}

// The check a table of settings checks gives for field, where the table has
// one of its own: null for any other name, Object.prototype's among them.
function settingCheck(checks, field) {
  return Object.prototype.hasOwnProperty.call(checks, field) ? checks[field] : null;
}

// Whether next holds the fields stored holds, each with the same value.
function sameStoredSettings(next, stored) {
  if (!isStoredSettingsObject(stored)) return false;
  const fields = Object.keys(next);
  return fields.length === Object.keys(stored).length && fields.every((field) =>
    Object.prototype.hasOwnProperty.call(stored, field) && next[field] === stored[field]);
}

// Writes into sync what change answers for the settings as readSettings finds
// them, so a write made before the move carries local's settings with it. A
// change that leaves the settings read as they were writes nothing where sync
// holds settings: what was read was sync's, or sync has taken settings since,
// which a write of the read would put back. Read from local alone, they are
// written, which carries them into sync. Answers the settings written, or
// found written. The caller runs this on its settings queue; change gets a copy
// it may change, and a throw from it writes nothing.
async function writeSettingsChange(change, storage = chrome.storage, key = SETTINGS_KEY) {
  const current = await readSettings(storage, key);
  const next = change({ ...current });
  if (sameStoredSettings(next, current) &&
      isStoredSettingsObject((await storage.sync.get(key))[key])) {
    return next;
  }
  await storage.sync.set({ [key]: next });
  return next;
}

// A queue that runs the work handed to it one after the other: each starts
// once the one before it has ended, resolved or rejected. What it answers
// settles as the work does.
function createSerialQueue() {
  let last = Promise.resolve();
  return (work) => {
    const task = last.then(work);
    last = task.catch(() => {});
    return task;
  };
}

// A writer of the map kept in chrome.storage.local under key, on a queue of
// its own, so a write reads what the one before it left. Each write reads the
// map, hands it to mutate to change in place, and writes it back where mutate
// changed it; extraKeys, where given, are written alongside, whatever mutate
// did. A context that can no longer reach the runtime writes nothing.
function createStoredMapWriter(key) {
  const queue = createSerialQueue();
  return (mutate, extraKeys) => queue(async () => {
    if (!isContextValid()) return;
    const data = await chrome.storage.local.get(key);
    const map = data[key] || {};
    const before = JSON.stringify(map);
    mutate(map);
    if (JSON.stringify(map) === before && !extraKeys) return;
    await chrome.storage.local.set({ [key]: map, ...extraKeys });
  });
}

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
