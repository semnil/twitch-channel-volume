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

// The stores name the rejections they raise themselves. A rejection with no
// name came from the storage area, and only that one is worth retrying.
function namedFailure(error) {
  return typeof error?.reason === 'string' ? error.reason : '';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === channelStore.CHANNEL_MUTATION_MESSAGE) {
    writeChannelVolumes(message.mutation).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      const named = namedFailure(error);
      if (named === 'invalid-mutation') {
        console.error('[TCV] channelVolumes mutation rejected as invalid', error);
      } else if (named === 'stored-state-invalid') {
        console.error('[TCV] channelVolumes mutation blocked by the stored state', error);
      } else {
        console.error('[TCV] channelVolumes mutation failed', error);
      }
      sendResponse({ ok: false, reason: named || 'storage-update-failed' });
    });
  } else if (message?.type === settingsStore.SETTINGS_MUTATION_MESSAGE) {
    writeSettings(message.mutation).then((settings) => {
      sendResponse({ ok: true, settings });
    }).catch((error) => {
      const named = namedFailure(error);
      if (named === 'invalid-mutation') {
        console.error('[TCV] settings mutation rejected as invalid', error);
      } else if (named === 'stored-state-invalid') {
        console.error('[TCV] settings mutation blocked by the stored state', error);
      } else {
        console.error('[TCV] settings mutation failed', error);
      }
      sendResponse({ ok: false, reason: named || 'settings-update-failed' });
    });
  } else {
    // Answering here would take the response away from a listener added later,
    // so the message is named and left alone.
    console.warn('[TCV] unknown message type', message?.type);
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
