// settings-store.js — Serialized field-level settings mutations for the service worker.

// The worker loads settings-area.js ahead of this script; the tests load this
// one as a module, which brings its own.
const settingsArea = typeof module !== 'undefined' && module.exports
  ? require('./settings-area.js')
  : globalThis.TCVSettingsArea;

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

// An earlier version kept the settings in local. Where local still holds them
// they go to sync, less the fields withoutRemovedSettings drops, unless sync
// already holds settings — another computer got there first, and what it
// uploaded is what every computer reads from now on — and the local copy is
// removed either way. Sync is written before local is removed, so a reader
// always finds one of them. Once local holds nothing this is one read, which is
// why the worker can ask for it at every start.
async function moveSettingsToSync(storage, storageKey) {
  const local = (await storage.local.get(storageKey))[storageKey];
  if (local === undefined) return false;
  const synced = (await storage.sync.get(storageKey))[storageKey];
  if (!settingsArea.isStoredSettingsObject(synced) &&
      settingsArea.isStoredSettingsObject(local)) {
    await storage.sync.set({ [storageKey]: withoutRemovedSettings(local) });
  }
  await storage.local.remove(storageKey);
  return true;
}

// `storage` is chrome.storage itself: the writes go to sync, and the read goes
// through readStoredSettings, so a write made before the move carries the local
// values with it instead of starting sync from an empty object.
function createSettingsWriter(storage, storageKey = SETTINGS_STORE_KEY) {
  let queue = Promise.resolve();

  function enqueue(work) {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  }

  function enqueueSettingsMutation(mutation) {
    return enqueue(async () => {
      const current = await settingsArea.readStoredSettings(storage, storageKey);
      const next = applySettingsMutation(current, mutation);
      await storage.sync.set({ [storageKey]: next });
      return next;
    });
  }
  // On the same queue as the mutations, so a write and the move cannot read the
  // two areas in between each other's steps.
  enqueueSettingsMutation.moveToSync = () =>
    enqueue(() => moveSettingsToSync(storage, storageKey));
  return enqueueSettingsMutation;
}

const TCV_SETTINGS_STORE = {
  SETTINGS_MUTATION_MESSAGE,
  SETTINGS_STORE_KEY,
  applySettingsMutation,
  moveSettingsToSync,
  createSettingsWriter
};

if (typeof globalThis !== 'undefined') globalThis.TCVSettingsStore = TCV_SETTINGS_STORE;
if (typeof module !== 'undefined' && module.exports) module.exports = TCV_SETTINGS_STORE;
