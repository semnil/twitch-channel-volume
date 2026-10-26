// settings-area.js — Where autoLoudnessSettings is kept, for every context that
// reads it: the service worker, content.js, the popup and the options page.
//
// The settings name no channel, so they live in chrome.storage.sync and Chrome
// sync carries them to every computer the profile is signed in on. Channel data
// stays in chrome.storage.local: it grows with every channel watched, and sync
// holds 100 KB in all and 8 KB an item.

// What a stored settings value has to be for a reader to take it.
function isStoredSettingsObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Sync first. A profile an earlier version wrote holds the settings in local
// until the service worker moves them, and that copy stands in until then. The
// move writes sync before it removes local, so one of the two always answers.
async function readStoredSettings(storage, key) {
  const synced = (await storage.sync.get(key))[key];
  if (isStoredSettingsObject(synced)) return synced;
  const local = (await storage.local.get(key))[key];
  return isStoredSettingsObject(local) ? local : undefined;
}

const TCV_SETTINGS_AREA = { isStoredSettingsObject, readStoredSettings };

if (typeof globalThis !== 'undefined') globalThis.TCVSettingsArea = TCV_SETTINGS_AREA;
if (typeof module !== 'undefined' && module.exports) module.exports = TCV_SETTINGS_AREA;
