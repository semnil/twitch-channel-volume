// background.js — Service worker. Owns the single serialized writer for the
// aggregate channelVolumes key and initializes default settings on install.

importScripts('channel-store.js');

const channelStore = globalThis.TCVChannelStore;
const writeChannelVolumes = channelStore.createChannelVolumesWriter(
  chrome.storage.local,
  'channelVolumes'
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== channelStore.CHANNEL_MUTATION_MESSAGE) return false;

  writeChannelVolumes(message.mutation).then(() => {
    sendResponse({ ok: true });
  }).catch((error) => {
    console.error('[TCV] channelVolumes mutation failed', error);
    sendResponse({ ok: false, reason: 'storage-update-failed' });
  });
  // Keep the service worker and response channel alive through the queued
  // read-modify-write operation.
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('autoLoudnessSettings');
  if (!data.autoLoudnessSettings) {
    await chrome.storage.local.set({
      autoLoudnessSettings: {
        targetLufs: -18,
        adGainDb: -6,
        displayUnit: '%',
        showGainOverlay: true,
        autoApplyLoudnessLiveDefault: false,
        autoApplyLoudnessVodDefault: false,
        autoApplyLoudnessClipDefault: false
      }
    });
  }
});
