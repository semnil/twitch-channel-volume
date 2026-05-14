// background.js — Service worker. Currently kept minimal: ensures default
// settings exist on install and provides a single hop for cross-frame
// scenarios that the popup may need in the future.

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('autoLoudnessSettings');
  if (!data.autoLoudnessSettings) {
    await chrome.storage.local.set({
      autoLoudnessSettings: {
        targetLufs: -18,
        adGainDb: -6,
        displayUnit: '%',
        showGainOverlay: true
      }
    });
  }
});
