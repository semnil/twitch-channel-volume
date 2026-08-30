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
  targetLufs: (value) => Number.isFinite(value) && value >= -30 && value <= -6,
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
    const validate = SETTINGS_VALIDATORS[field];
    if (!validate) throw invalidSettingsMutation(`unknown settings field: ${field}`);
    if (!validate(value)) throw invalidSettingsMutation(`invalid settings value: ${field}`);
  }
  return { ...patch };
}

// A setting kept for a kind the extension no longer has is dropped the next
// time the settings are written.
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
  if (mutation.operation === 'initializeSettings') {
    if (Object.keys(current).length > 0) return withoutRemovedSettings(current);
    return validateSettingsPatch(mutation.defaults);
  }
  throw invalidSettingsMutation('unknown settings mutation');
}

function createSettingsWriter(storageArea, storageKey = SETTINGS_STORE_KEY) {
  let queue = Promise.resolve();

  return function enqueueSettingsMutation(mutation) {
    const task = queue.then(async () => {
      const data = await storageArea.get(storageKey);
      const next = applySettingsMutation(data[storageKey], mutation);
      await storageArea.set({ [storageKey]: next });
      return next;
    });
    queue = task.catch(() => {});
    return task;
  };
}

const TCV_SETTINGS_STORE = {
  SETTINGS_MUTATION_MESSAGE,
  SETTINGS_STORE_KEY,
  applySettingsMutation,
  createSettingsWriter
};

if (typeof globalThis !== 'undefined') globalThis.TCVSettingsStore = TCV_SETTINGS_STORE;
if (typeof module !== 'undefined' && module.exports) module.exports = TCV_SETTINGS_STORE;
