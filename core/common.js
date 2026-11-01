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
// Whether the gain is shown beside the player's volume where the settings hold
// no choice.
const DEFAULT_SHOW_GAIN_OVERLAY = true;
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

// A write refused for what its message asks, before storage is read: answered
// as 'invalid-mutation' rather than as a storage failure.
class WriteRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriteRefused';
    this.reason = 'invalid-mutation';
  }
}

// The write table holds as an own property under the name type carries after
// prefix, or null.
function tableWrite(table, prefix, type) {
  if (typeof type !== 'string' || !type.startsWith(prefix)) return null;
  const name = type.slice(prefix.length);
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null;
}

// The runtime message listener of a worker that makes the writes other
// contexts ask for. route(msg) gives the write msg asks for as
// { write, label, failed }, or null where it asks for none. The write runs
// with msg, and the fields of what it resolves to are answered with ok: true.
// A rejection is answered with ok: false and the reason it names, or failed
// where it names none (a storage failure), and logged under prefix and label.
// A message that asks for no write is left unanswered, so another context's
// listener can answer it, and is logged unless its type is one of
// ignoredTypes.
function createWriteListener({ route, prefix, ignoredTypes = [] }) {
  return (msg, _sender, sendResponse) => {
    const target = route(msg);
    if (!target) {
      if (!ignoredTypes.includes(msg?.type)) console.warn(`${prefix} unknown message type`, msg?.type);
      return false;
    }
    Promise.resolve()
      .then(() => target.write(msg))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => {
        const named = typeof err?.reason === 'string' ? err.reason : '';
        if (named === 'invalid-mutation') {
          console.error(`${prefix} ${target.label} rejected as invalid`, err);
        } else if (named === 'stored-state-invalid') {
          console.error(`${prefix} ${target.label} blocked by the stored state`, err);
        } else {
          console.error(`${prefix} ${target.label} failed`, err);
        }
        sendResponse({ ok: false, reason: named || target.failed });
      });
    return true;
  };
}

// Asks the worker for the write message describes and resolves with its
// answer once the write has landed. A write the worker turns down rejects with
// the reason it answered, and one it confirms with no ok and no reason (or
// does not answer) with 'write not confirmed'.
async function requestWrite(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.reason || 'write not confirmed');
  return response;
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
  return clampGain(gain);
}

// How often, at most, Auto sets the gain from a level that moves while it
// plays. Each time, the gain is the one gainForLevel gives for the level.
const AUTO_FOLLOW_INTERVAL_MS = 1000;

// Whether gain is one a channel write may store: a finite number within the
// gain range.
function isStorableGain(gain) {
  return Number.isFinite(gain) && gain >= MIN_GAIN && gain <= MAX_GAIN;
}

// gain held to the gain range.
function clampGain(gain) {
  return Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain));
}

// Whether entry has one of slots, the keys of its gains per type, as a key of
// its own.
function hasTypedGain(entry, slots) {
  return slots.some((slot) => Object.prototype.hasOwnProperty.call(entry, slot));
}

// The gain entry holds for slot: a finite number stored there; or, in an entry
// an earlier version wrote with one gain for every type and no slot of slots,
// that gain where it is a finite number; null otherwise. A gain of the earlier
// form beside a slot of slots is not read.
function storedGain(entry, slot, slots) {
  if (!entry || typeof entry !== 'object') return null;
  const value = hasTypedGain(entry, slots) ? entry[slot] : entry.gain;
  return Number.isFinite(value) ? value : null;
}

// Turns an entry an earlier version wrote with one gain for every type into one
// with a gain per type, in place, ahead of a write to it: where it has no slot
// of slots and that gain is a finite number, every slot takes it. The gain of
// the earlier form is removed either way.
function expandLegacyGain(entry, slots) {
  if (!Object.prototype.hasOwnProperty.call(entry, 'gain')) return entry;
  if (!hasTypedGain(entry, slots) && Number.isFinite(entry.gain)) {
    for (const slot of slots) entry[slot] = entry.gain;
  }
  delete entry.gain;
  return entry;
}

// Whether key can name a row of a stored map in a delete: non-empty text.
function isRowKey(key) {
  return typeof key === 'string' && key.length > 0;
}

// A stored row's label: its name where the name is non-empty text, its key
// otherwise.
function rowLabel(key, entry) {
  return typeof entry.name === 'string' && entry.name ? entry.name : key;
}

// Names entry, the stored row for id, from the name a write carries. A name
// that is no text, is empty, or is the id itself (a sender gives the id before
// it knows the name) leaves the row's name as it is; a row with no name takes
// the id where nameNewRow says so.
function applyEntryName(entry, id, name, nameNewRow = true) {
  if (typeof name === 'string' && name && name !== id) entry.name = name;
  else if (nameNewRow && !entry.name) entry.name = id;
}

// Turns an entry an earlier version wrote with one Auto flag for every type
// into one with a flag per type, in place, ahead of a write: each of fields
// the entry has no flag for takes the earlier flag, and the earlier flag is
// removed.
function expandLegacyAutoFlag(entry, fields) {
  if (!Object.prototype.hasOwnProperty.call(entry, 'autoApplyLoudness')) return entry;
  const legacy = !!entry.autoApplyLoudness;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) entry[field] = legacy;
  }
  delete entry.autoApplyLoudness;
  return entry;
}

// Whether Auto is on for the type whose flag is field: the entry's own flag,
// else the flag an earlier version kept for every type, else off where
// storedGainTurnsOff (the caller's rule that a gain stored without a flag is a
// choice of its own), else defaultValue.
function autoFlagFor(entry, field, defaultValue, storedGainTurnsOff) {
  if (!entry || typeof entry !== 'object') return !!defaultValue;
  if (Object.prototype.hasOwnProperty.call(entry, field)) return !!entry[field];
  if (Object.prototype.hasOwnProperty.call(entry, 'autoApplyLoudness')) return !!entry.autoApplyLoudness;
  if (storedGainTurnsOff) return false;
  return !!defaultValue;
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
// hold: a value key, not a repeat, pressed while no value key is down, so a
// key already down that is pressed again stays in the hold it is in. release
// answers whether a keyup ends it: the last value key down let go of. Any
// other key, and a repeat, change nothing.
function createSliderKeys() {
  const down = new Set();
  return {
    press(event) {
      if (event.repeat || !SLIDER_VALUE_KEYS.has(event.key)) return false;
      const begins = down.size === 0;
      down.add(event.key);
      return begins;
    },
    release(event) {
      return down.delete(event.key) && down.size === 0;
    },
    clear() { down.clear(); }
  };
}

// Holds a settings page's slider to one write per gesture, and answers
// whether a key or the pointer is held on it. A key held on it (the value keys
// createSliderKeys counts) or a drag with the primary button moves the label
// alone (drawLabel); the gesture writes the value once (save): at the keyup of
// the last value key where a key moved the value, at a drag's change, or at a
// blur of the slider or the window that ends the gesture, where Chrome fires a
// drag's change ahead of that blur. A key hold that moved nothing, a drag let
// go of on the value it began on and a blur that ends a gesture draw the
// stored value (current) again; a press of the pointer while a key is held
// leaves the key's hold and its value as they are. After that blur the
// slider's input and change move nothing until the next press of the pointer
// or of a value key, and the change draws the stored value; a drag the browser
// cancels ends the same way, without a write. A drag's release is taken on
// the slider, which holds the pointer it was pressed with.
function holdSettingsSlider(slider, { current, drawLabel, save }) {
  const keys = createSliderKeys();
  let keyHeld = false;
  let keyMoved = false;
  let pointerHeld = false;
  let pointerStart = null;
  let gestureEnded = false;
  const drawStored = () => {
    slider.value = String(current());
    drawLabel(current());
  };
  // Whether a key was held.
  const endKeyHold = () => {
    if (!keyHeld) return false;
    keyHeld = false;
    const moved = keyMoved;
    keyMoved = false;
    if (moved) save(Number(slider.value));
    else drawStored();
    return true;
  };
  const endGestureOnBlur = () => {
    keys.clear();
    if (!endKeyHold() && !pointerHeld) return;
    drawStored();
    pointerHeld = false;
    gestureEnded = true;
  };
  slider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pointerHeld = true;
    pointerStart = Number(slider.value);
    gestureEnded = false;
  });
  // A key held through the press keeps the value it moved to for its keyup.
  const releasePointer = () => {
    if (pointerHeld && !keyHeld && Number(slider.value) === pointerStart) drawStored();
    pointerHeld = false;
  };
  slider.addEventListener('pointerup', releasePointer);
  // A drag the browser takes away writes nothing: the stored value is drawn
  // and the gesture ends, so the change Chrome fires later moves nothing. A
  // key held through it stays held.
  slider.addEventListener('pointercancel', () => {
    pointerHeld = false;
    if (keyHeld) return;
    drawStored();
    gestureEnded = true;
  });
  slider.addEventListener('keydown', (event) => {
    if (!keys.press(event)) return;
    gestureEnded = false;
    keyHeld = true;
  });
  slider.addEventListener('keyup', (event) => {
    if (keys.release(event)) endKeyHold();
  });
  slider.addEventListener('blur', endGestureOnBlur);
  window.addEventListener('blur', endGestureOnBlur);
  slider.addEventListener('input', () => {
    if (gestureEnded) return;
    if (keyHeld) keyMoved = true;
    drawLabel(Number(slider.value));
  });
  slider.addEventListener('change', () => {
    if (gestureEnded) {
      drawStored();
      return;
    }
    if (keyHeld) return;
    save(Number(slider.value));
  });
  return () => keyHeld || pointerHeld;
}

// How often a popup's gain slider sends its preview again while it is held.
const PREVIEW_KEEP_ALIVE_MS = 1000;

// Holds a popup's gain slider to one save per gesture, and has it heard while
// it moves. A gesture begins at a press of the primary button or of a value
// key (createSliderKeys) on the slider, or at an input or a change while none
// is in progress (begin). Each input draws the value and, where canPreview
// holds, sends it as a preview; while the pointer or a key stays held after a
// preview not yet saved, the preview is sent again every
// PREVIEW_KEEP_ALIVE_MS. A drag saves at its change. A key hold saves once,
// at the keyup of the last value key held, where a key moved the value, and a
// press of the pointer during it leaves it held; the press stays the gesture
// it was once the key has saved, and its change saves what it moved to after
// the key, and nothing where it moved nothing more. A blur of the slider or
// of the window ends the gesture, a key hold saving there where a key moved
// the value; after it the slider's input and change send nothing until the
// next press, and the change puts the thumb back to the value it held at the
// blur. A drag the browser cancels ends the same way with no save and draws
// nothing: the tab puts the gain it holds back once the previews stop, and
// the popup draws what the tab then says (cancel, where given, is told). The release is taken on the
// slider, which holds the pointer it was pressed with. Answers whether a key
// or the pointer is held.
function holdPopupSlider(slider, { begin, draw, canPreview, preview, save, cancel }) {
  const keys = createSliderKeys();
  let keyHeld = false;
  let keyMoved = false;
  let pointerHeld = false;
  let inGesture = false;
  let gestureEnded = false;
  let valueAtEnd = '';
  // An input since the gesture's last save, and a save made while the pointer
  // was held that no input has followed.
  let unsaved = false;
  let savedHeld = false;
  let previewUnsaved = false;
  let keepAliveSet = false;
  const value = () => Number(slider.value);
  const beginGesture = () => {
    inGesture = true;
    gestureEnded = false;
    unsaved = false;
    savedHeld = false;
    begin();
  };
  // A press of the pointer still held goes on as the same gesture.
  const saveValue = () => {
    unsaved = false;
    previewUnsaved = false;
    savedHeld = pointerHeld;
    if (!pointerHeld) inGesture = false;
    save(value());
  };
  const endGesture = () => {
    inGesture = false;
    gestureEnded = true;
    valueAtEnd = slider.value;
  };
  const keepPreviewAlive = () => {
    if (keepAliveSet) return;
    keepAliveSet = true;
    setTimeout(() => {
      keepAliveSet = false;
      if (!(pointerHeld || keyHeld) || !previewUnsaved || !canPreview()) return;
      preview(value());
      keepPreviewAlive();
    }, PREVIEW_KEEP_ALIVE_MS);
  };
  // Whether a key was held.
  const endKeyHold = () => {
    if (!keyHeld) return false;
    keyHeld = false;
    const moved = keyMoved;
    keyMoved = false;
    if (moved) saveValue();
    return true;
  };
  const endGestureOnBlur = () => {
    keys.clear();
    if (!endKeyHold() && !pointerHeld) return;
    pointerHeld = false;
    endGesture();
  };
  slider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pointerHeld = true;
    if (!keyHeld) beginGesture();
  });
  slider.addEventListener('pointerup', () => {
    pointerHeld = false;
    if (!keyHeld && !unsaved) inGesture = false;
  });
  // A key held through it stays held, and keeps the value it moved to.
  slider.addEventListener('pointercancel', () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    if (keyHeld) return;
    endGesture();
    if (cancel) cancel();
  });
  slider.addEventListener('keydown', (event) => {
    if (!keys.press(event)) return;
    if (!pointerHeld) beginGesture();
    keyHeld = true;
    keyMoved = false;
  });
  slider.addEventListener('keyup', (event) => {
    if (keys.release(event)) endKeyHold();
  });
  slider.addEventListener('blur', endGestureOnBlur);
  window.addEventListener('blur', endGestureOnBlur);
  slider.addEventListener('input', () => {
    if (gestureEnded) return;
    if (!inGesture) beginGesture();
    if (keyHeld) keyMoved = true;
    unsaved = true;
    savedHeld = false;
    draw(value());
    if (!canPreview()) return;
    preview(value());
    previewUnsaved = true;
    keepPreviewAlive();
  });
  slider.addEventListener('change', () => {
    if (gestureEnded) {
      slider.value = valueAtEnd;
      return;
    }
    if (keyHeld) return;
    // The release after a save with no input since moves nothing of its own,
    // whatever was drawn on the slider meanwhile.
    if (savedHeld && !unsaved) {
      savedHeld = false;
      return;
    }
    if (!inGesture) beginGesture();
    saveValue();
  });
  return () => keyHeld || pointerHeld;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  // Serialising a text node leaves both quotes alone, and every caller puts the
  // result inside a quoted attribute as well as between tags.
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Fills each element of the page that names a catalog message in its
// data-i18n with that message, the key itself where the catalog has none, and
// declares the page's language as the catalog's pageLanguage.
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = msg(el.getAttribute('data-i18n'));
  });
  document.documentElement.lang = msg('pageLanguage');
}

// Shows a page that ships with body.initializing: the layout takes what was
// written while transitions are off, and the class comes off on the next frame.
function revealPage() {
  void document.body.offsetWidth;
  requestAnimationFrame(() => {
    document.body.classList.remove('initializing');
  });
}

// How long a page's first load may take before the page is shown as one whose
// load did not arrive.
const PAGE_LOAD_TIMEOUT_MS = 3000;

// Runs a page's first load. load() reads and draws what the page shows;
// onLoaded runs once it lands, and onFailed with the error where it rejects,
// where onLoaded throws, or where it has not settled within
// PAGE_LOAD_TIMEOUT_MS. The page is shown (revealPage) once one of them has
// run.
function runPageLoad(load, { onLoaded, onFailed }) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('page load timed out')), PAGE_LOAD_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve().then(load), deadline])
    .then(onLoaded)
    .catch(onFailed)
    .finally(() => {
      clearTimeout(timer);
      revealPage();
    });
}

// The gain as one text in the display unit, its number and its unit together.
function formatGainText(gain, displayUnit) {
  const formatted = formatGain(gain, displayUnit);
  return formatted.text + formatted.unit;
}

// A popup card's value: text, then unitText in a span.unit where there is one.
// The card's classes become 'value' and classes.
function setCardValue(el, text, unitText, classes) {
  el.className = 'value' + (classes ? ' ' + classes : '');
  el.textContent = text;
  if (unitText) {
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = unitText;
    el.appendChild(unit);
  }
}

// A popup card with no value: '---', with classes and 'unknown'.
function setUnknown(el, classes) {
  setCardValue(el, '---', null, classes ? classes + ' unknown' : 'unknown');
}

// The popup's owner line: the owner's name, or the catalog's text for
// missingKey in the empty class where there is none. The full text is the
// title as well, for a row too narrow to show it.
function drawOwnerName(el, name, missingKey) {
  el.textContent = name || msg(missingKey);
  el.classList.toggle('empty', !name);
  el.title = el.textContent;
}

// The settings page's #settingsError line: shown with the catalog's text for
// key, or hidden.
function showSettingsError(visible, key = 'settingsSaveFailed') {
  const line = document.getElementById('settingsError');
  if (visible) line.textContent = msg(key);
  line.classList.toggle('hidden', !visible);
}

// A settings control's save on the settings page. Nothing is written before
// loaded() holds. write() makes the save; where it lands, the error line is
// taken down. Where it does not, the page goes back to what the settings hold
// and says so: read() is drawn with apply() unless a settings change came
// while it was out (revision() moved), redraw() runs after, and the line
// reads settingsSaveFailed, or settingsLoadFailed where the read fails as
// well. Resolves with whether the save landed.
async function saveSettingOrRestore(write, { loaded, read, apply, revision, redraw = () => {}, prefix = '' }) {
  if (!loaded()) return false;
  try {
    await write();
    showSettingsError(false);
    return true;
  } catch (err) {
    const at = revision();
    let key = 'settingsSaveFailed';
    try {
      const settings = await read();
      if (at === revision()) apply(settings);
      redraw();
    } catch (readErr) {
      key = 'settingsLoadFailed';
      console.error(`${prefix} settings not read back after a failed save`, readErr);
    }
    showSettingsError(true, key);
    console.error(`${prefix} setting not saved`, err);
    return false;
  }
}

// How often the popup asks its tab for the state while it is open.
const STATE_POLL_INTERVAL_MS = 1000;

// Asks the popup's tab for the state while the popup is open: first() at once,
// then refresh() every STATE_POLL_INTERVAL_MS, whether or not an earlier ask
// has been answered. Resolves once first() has.
async function pollTabState(refresh, first = refresh) {
  setInterval(refresh, STATE_POLL_INTERVAL_MS);
  await first();
}

// Whether the popup's tab is on host or a subdomain of it, read from the host
// name of the tab's URL. A tab whose URL the popup cannot read is on none.
function isSiteTab(tab, host) {
  let hostname;
  try {
    hostname = new URL(tab.url).hostname;
  } catch (_) {
    return false;
  }
  return hostname === host || hostname.endsWith('.' + host);
}

// The popup's status line, which stands in for the whole screen where the
// popup has nothing to act on: shown with the catalog's text for key and main
// hidden, or hidden and main shown.
function showPopupStatus(line, main, key) {
  line.textContent = msg(key);
  line.classList.remove('hidden');
  main.classList.add('hidden');
}

function hidePopupStatus(line, main) {
  line.classList.add('hidden');
  main.classList.remove('hidden');
}

// The popup's preset buttons, each naming its percent in data-vol. A click,
// where allow holds, draws that percent on the slider, the slider's value and
// the current card in the display unit, then hands pick the percent and its
// gain.
function bindPresets(buttons, { slider, valueEl, currentEl, unit, allow = () => true, pick }) {
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      if (!allow()) return;
      const percent = Number(btn.dataset.vol);
      const gain = percentToGain(percent);
      const f = formatGain(gain, unit());
      slider.value = String(percent);
      valueEl.textContent = f.text + f.unit;
      setCardValue(currentEl, f.text, f.unit, 'current');
      pick(percent, gain);
    });
  }
}

// The popup's display unit, followed while the popup is open: a change to the
// settings in sync hands onChange the unit it names. The function returned
// reads the unit, and resolves with null where a change came while the read
// was out, which then stands over what the read found.
function followDisplayUnit(onChange, storage = chrome.storage, key = SETTINGS_KEY) {
  let revision = 0;
  storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes[key]) return;
    revision++;
    onChange((changes[key].newValue || {}).displayUnit || '%');
  });
  return async () => {
    const started = revision;
    const settings = await readSettings(storage, key);
    return started === revision ? settings.displayUnit || '%' : null;
  };
}

// Sends message to the content script of the popup's tab, and resolves with
// its answer. A popup that holds no tab sends nothing and rejects.
function sendTabMessage(tabId, message) {
  if (!tabId) return Promise.reject(new Error('no tab'));
  return chrome.tabs.sendMessage(tabId, message);
}

// The popup's notice that the gain a gesture asked to save is not saved
// (gainSaveFailed). The answer to the latest save sent for the owner shown
// raises it where the answer is not ok, whether the tab refused the gesture
// or could not save it, and takes it down where it is ok; the answer to an
// earlier save, to one sent for another owner than the one shown, and to one
// answered once another owner is shown, leave it as it is. The popup coming
// to show another owner takes it down.
function createSaveNotice() {
  let raised = false;
  let owner = '';
  let sent = 0;
  return {
    raised: () => raised,
    // Called as a save goes out, with the owner it is for (the owner shown
    // where it names none). Answers the function that save's answer is handed
    // to (none where no answer came), which answers whether the answer is ok.
    // A save for another owner than the one shown leaves the notice, and the
    // saves for the owner shown, as they are.
    send(sentFor = owner) {
      if (sentFor !== owner) return (answer) => !!answer?.ok;
      const save = ++sent;
      return (answer) => {
        const ok = !!answer?.ok;
        if (save === sent && sentFor === owner) raised = !ok;
        return ok;
      };
    },
    // The owner the popup shows, as a key; '' where it shows none, which
    // leaves the notice as it is.
    showOwner(key) {
      if (!key) return;
      if (owner && key !== owner) raised = false;
      owner = key;
    },
    // Puts the notice in hint while it is raised, in the error colour.
    // Whether it did.
    draw(hint) {
      hint.classList.toggle('error', raised);
      if (raised) hint.textContent = msg('gainSaveFailed');
      return raised;
    }
  };
}
