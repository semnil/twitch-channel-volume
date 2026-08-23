// background.js — Service worker. Owns the single serialized writer for the
// aggregate channelVolumes key and initializes default settings on install.

importScripts('channel-store.js', 'settings-store.js');

const channelStore = globalThis.TCVChannelStore;
const settingsStore = globalThis.TCVSettingsStore;
const writeChannelVolumes = channelStore.createChannelVolumesWriter(
  chrome.storage.local,
  'channelVolumes'
);
const writeSettings = settingsStore.createSettingsWriter(chrome.storage.local);

// The stores refuse a malformed mutation with a TypeError, and the storage
// area fails with everything else. Only the second is about storage.
function refusedMutation(error) {
  return error instanceof TypeError;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === channelStore.CHANNEL_MUTATION_MESSAGE) {
    writeChannelVolumes(message.mutation).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      if (refusedMutation(error)) {
        console.error('[TCV] channelVolumes mutation rejected as invalid', error);
        sendResponse({ ok: false, reason: 'invalid-mutation' });
        return;
      }
      console.error('[TCV] channelVolumes mutation failed', error);
      sendResponse({ ok: false, reason: 'storage-update-failed' });
    });
  } else if (message?.type === settingsStore.SETTINGS_MUTATION_MESSAGE) {
    writeSettings(message.mutation).then((settings) => {
      sendResponse({ ok: true, settings });
    }).catch((error) => {
      if (refusedMutation(error)) {
        console.error('[TCV] settings mutation rejected as invalid', error);
        sendResponse({ ok: false, reason: 'invalid-mutation' });
        return;
      }
      console.error('[TCV] settings mutation failed', error);
      sendResponse({ ok: false, reason: 'settings-update-failed' });
    });
  } else {
    return false;
  }
  // Keep the service worker and response channel alive through the queued
  // read-modify-write operation.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  writeChannelVolumes({ operation: 'normalizeChannels' }).catch((error) => {
    console.error('[TCV] stored channel normalization failed', error);
  });
  writeSettings({
    operation: 'initializeSettings',
    defaults: {
      targetLufs: -18,
      adGainDb: -6,
      displayUnit: '%',
      showGainOverlay: true,
      autoApplyLoudnessLiveDefault: false,
      autoApplyLoudnessVodDefault: false,
      autoApplyLoudnessClipDefault: false
    }
  }).catch((error) => {
    console.error('[TCV] default settings initialization failed', error);
  });
});
