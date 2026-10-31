// background.js — Service worker. Owns the single serialized writer for the
// aggregate channelVolumes key (local) and for the settings (sync). Nothing is
// written to the settings on install: a reader that finds none takes the
// defaults, and with Chrome sync on, a Chrome the user has newly signed in to
// would otherwise write them into sync before Chrome sync has brought it the
// settings the account already holds.

importScripts('core/common.js', 'channel-store.js', 'settings-store.js');

const channelStore = globalThis.TCVChannelStore;
const settingsStore = globalThis.TCVSettingsStore;
const writeChannelVolumes = channelStore.createChannelVolumesWriter(
  chrome.storage.local,
  'channelVolumes'
);
const writeSettings = settingsStore.createSettingsWriter(chrome.storage);

// Asked at every start rather than on install alone, so a move that failed is
// made again at the next start. Once local holds no settings it is one read.
writeSettings.moveToSync().catch((error) => {
  console.error('[TCV] failed to move the settings to sync', error);
});

// The stores name the rejections they raise themselves (invalid-mutation,
// stored-state-invalid); a rejection with no name came from the storage area.
// Any other message is named and left alone, since answering it would take
// the response away from a listener added later.
chrome.runtime.onMessage.addListener(createWriteListener({
  prefix: '[TCV]',
  route: (message) => {
    if (message?.type === channelStore.CHANNEL_MUTATION_MESSAGE) {
      return {
        write: (m) => writeChannelVolumes(m.mutation).then(() => undefined),
        label: 'channelVolumes mutation',
        failed: 'storage-update-failed'
      };
    }
    if (message?.type === settingsStore.SETTINGS_MUTATION_MESSAGE) {
      return {
        write: (m) => writeSettings(m.mutation).then((settings) => ({ settings })),
        label: 'settings mutation',
        failed: 'settings-update-failed'
      };
    }
    return null;
  }
}));

chrome.runtime.onInstalled.addListener(() => {
  writeChannelVolumes({ operation: 'normalizeChannels' }).catch((error) => {
    console.error('[TCV] stored channel normalization failed', error);
  });
});
