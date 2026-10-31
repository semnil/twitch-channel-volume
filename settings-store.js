// settings-store.js — Serialized field-level settings mutations for the service worker.

const SETTINGS_MUTATION_MESSAGE = '__twitch_channel_volume_settings_mutation__';
const SETTINGS_STORE_KEY = 'autoLoudnessSettings';

// Mirrors invalidChannelMutation in channel-store.js: what the caller sent
// cannot be applied, as opposed to a failure of the storage area. The names
// differ because the service worker runs both scripts in one global.
function invalidSettingsMutation(message) {
  const error = new TypeError(message);
  error.reason = 'invalid-mutation';
  return error;
}

const SETTINGS_VALIDATORS = {
  targetLufs: (value) => Number.isFinite(value) && value >= MIN_TARGET_LUFS && value <= MAX_TARGET_LUFS,
  adGainDb: (value) => Number.isFinite(value) && value >= -24 && value <= 6,
  displayUnit: (value) => value === '%' || value === 'dB',
  showGainOverlay: (value) => typeof value === 'boolean',
  autoApplyLoudnessLiveDefault: (value) => typeof value === 'boolean',
  autoApplyLoudnessVodDefault: (value) => typeof value === 'boolean'
};

function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw invalidSettingsMutation('settings patch must be an object');
  }
  const entries = Object.entries(patch);
  if (entries.length === 0) throw invalidSettingsMutation('settings patch must not be empty');
  for (const [field, value] of entries) {
    const validate = settingCheck(SETTINGS_VALIDATORS, field);
    if (!validate) throw invalidSettingsMutation(`unknown settings field: ${field}`);
    if (!validate(value)) throw invalidSettingsMutation(`invalid settings value: ${field}`);
  }
  return { ...patch };
}

// A setting kept for a kind the extension no longer has is dropped the next
// time the settings are written, and when the move takes them out of local.
const REMOVED_SETTINGS_FIELDS = ['autoApplyLoudnessClipDefault'];

function withoutRemovedSettings(settings) {
  let dropped = false;
  const kept = { ...settings };
  for (const field of REMOVED_SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(kept, field)) continue;
    delete kept[field];
    dropped = true;
  }
  return dropped ? kept : settings;
}

function applySettingsMutation(currentValue, mutation) {
  if (!mutation || typeof mutation !== 'object') {
    throw invalidSettingsMutation('settings mutation must be an object');
  }
  const current = currentValue && typeof currentValue === 'object'
    ? { ...currentValue }
    : {};
  if (mutation.operation === 'patchSettings') {
    return withoutRemovedSettings({ ...current, ...validateSettingsPatch(mutation.patch) });
  }
  throw invalidSettingsMutation('unknown settings mutation');
}

// `storage` is chrome.storage itself: the writes go to sync, and the read goes
// through readSettings, so a write made before the move carries the local
// values with it instead of starting sync from an empty object.
function createSettingsWriter(storage, storageKey = SETTINGS_STORE_KEY) {
  const enqueue = createSerialQueue();

  function enqueueSettingsMutation(mutation) {
    return enqueue(() =>
      writeSettingsChange((current) => applySettingsMutation(current, mutation), storage, storageKey));
  }
  // On the same queue as the mutations, so a write and the move cannot read the
  // two areas in between each other's steps.
  enqueueSettingsMutation.moveToSync = () =>
    enqueue(() => moveSettingsToSync(storage, storageKey, withoutRemovedSettings));
  return enqueueSettingsMutation;
}

const TCV_SETTINGS_STORE = {
  SETTINGS_MUTATION_MESSAGE,
  SETTINGS_STORE_KEY,
  applySettingsMutation,
  createSettingsWriter
};

if (typeof globalThis !== 'undefined') globalThis.TCVSettingsStore = TCV_SETTINGS_STORE;
if (typeof module !== 'undefined' && module.exports) module.exports = TCV_SETTINGS_STORE;
