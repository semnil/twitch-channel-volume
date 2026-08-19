// test.js — Pure utility tests. Run with `node test.js`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const u = require('./utils.js');
const channelStore = require('./channel-store.js');
const settingsStore = require('./settings-store.js');

function readStoredKeys(stored, keys) {
  const requested = Array.isArray(keys) ? keys : [keys];
  const result = {};
  for (const key of requested) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) {
      result[key] = structuredClone(stored[key]);
    }
  }
  return result;
}

async function flushTasks(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createContentHarness({
  autoApply = false,
  autoGain,
  href = 'https://www.twitch.tv/videos/100',
  channelVolumes
} = {}) {
  const listeners = {};
  const storageListeners = [];
  const commands = [];
  let runtimeMessageListener;
  let failNextStorageGet = false;
  const location = { href };
  const stored = {
    [u.SETTINGS_KEY]: {
      targetLufs: -18,
      adGainDb: -6,
      displayUnit: '%',
      showGainOverlay: true
    },
    [u.CHANNEL_VOLUMES_KEY]: channelVolumes || {
      'vod-owner:100': {
        name: '100',
        gainVod: 0.5,
        autoApplyLoudnessVod: autoApply,
        ...(Number.isFinite(autoGain) ? { autoGainVod: autoGain } : {})
      }
    },
    [u.CHANNEL_ALIASES_KEY]: {}
  };
  const window = {
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    postMessage(message) {
      commands.push(structuredClone(message));
    }
  };
  const document = {
    documentElement: {},
    querySelector() { return null; },
    addEventListener() {},
    contains() { return false; }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL(filename) { return `chrome-extension://test/${filename}`; },
      async sendMessage(message) {
        const mutation = message?.mutation;
        if (mutation) {
          stored[u.CHANNEL_VOLUMES_KEY] = channelStore.applyChannelVolumesMutation(
            stored[u.CHANNEL_VOLUMES_KEY],
            mutation,
            1234
          );
        }
        return { ok: true };
      },
      onMessage: { addListener(listener) { runtimeMessageListener = listener; } }
    },
    storage: {
      local: {
        async get(keys) {
          if (failNextStorageGet) {
            failNextStorageGet = false;
            throw new Error('injected storage read failure');
          }
          return readStoredKeys(stored, keys);
        }
      },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); }
      }
    }
  };
  const context = vm.createContext({
    ...u,
    chrome,
    console: { warn() {}, error() {}, info() {} },
    document,
    history: { pushState() {}, replaceState() {} },
    location,
    MutationObserver,
    queueMicrotask,
    setInterval() { return 1; },
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    URL,
    window
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8'),
    context,
    { filename: 'content.js' }
  );

  return {
    commands,
    stored,
    async dispatchMessage(data) {
      await Promise.all((listeners.message || []).map((listener) => listener({ source: window, data })));
    },
    async dispatchStorage(changes) {
      for (const listener of storageListeners) listener(changes);
      await flushTasks();
    },
    failNextStorageGet() {
      failNextStorageGet = true;
    },
    dispatchRuntime(request) {
      return new Promise((resolve) => {
        let responded = false;
        const keepOpen = runtimeMessageListener(request, {}, (response) => {
          responded = true;
          resolve(response);
        });
        if (keepOpen !== true && !responded) resolve(undefined);
      });
    }
  };
}

function createPageBridgeHarness() {
  const messages = [];
  const listeners = {};
  const location = { href: 'https://www.twitch.tv/videos/100' };
  let resolveFetch;
  const window = {
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    fetch() {
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    postMessage(message) {
      messages.push(structuredClone(message));
    }
  };
  const context = vm.createContext({
    AudioWorkletNode: class {},
    clearInterval() {},
    console: { warn() {}, error() {}, info() {} },
    document: { querySelectorAll() { return []; } },
    location,
    setInterval() { return 1; },
    URL,
    window
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'page-bridge.js'), 'utf8'),
    context,
    { filename: 'page-bridge.js' }
  );
  return {
    location,
    messages,
    fetch: (...args) => window.fetch(...args),
    resolveFetch(response) { resolveFetch(response); }
  };
}

test('calcGain: target equals measured → unity gain', () => {
  assert.equal(u.calcGain(-18, -18).toFixed(6), '1.000000');
});

test('calcGain: -23 LUFS measured against -18 target → +5 dB', () => {
  const g = u.calcGain(-23, -18);
  assert.ok(Math.abs(g - Math.pow(10, 5 / 20)) < 1e-9);
});

test('calcGain: clamps to [0, 6]', () => {
  assert.equal(u.calcGain(-60, -18), 6);
  assert.equal(u.calcGain(0, -18), Math.pow(10, -18 / 20));
  assert.equal(u.calcGain(-Infinity, -18), 1.0);
  assert.equal(u.calcGain(NaN, -18), 1.0);
});

test('gainToDb / dbToGain are inverses (within 1-decimal rounding)', () => {
  const g = 1.5;
  const db = Number(u.gainToDb(g));
  // gainToDb formats to one decimal place; round-trip tolerance ~0.012
  assert.ok(Math.abs(u.dbToGain(db) - g) < 0.02);
});

test('gainToPercent / percentToGain are inverses', () => {
  assert.equal(u.gainToPercent(1.0), 100);
  assert.equal(u.percentToGain(150), 1.5);
});

test('formatAutoGain shows the last applied Auto gain', () => {
  assert.equal(u.formatAutoGain(0.7, '%'), 'Auto (70%)');
  assert.equal(u.formatAutoGain(null, '%'), 'Auto (100%)');
  assert.equal(u.formatAutoGain(0.5, 'dB', '自動'), '自動 (-6.0 dB)');
});

test('auto-apply fields are independent for Live, VOD, and Clip', () => {
  assert.equal(u.autoApplyFieldForKind('live'), 'autoApplyLoudnessLive');
  assert.equal(u.autoApplyFieldForKind('vod'), 'autoApplyLoudnessVod');
  assert.equal(u.autoApplyFieldForKind('clip'), 'autoApplyLoudnessClip');
  assert.equal(
    u.autoApplyDefaultFieldForKind('vod'),
    'autoApplyLoudnessVodDefault'
  );
  assert.equal(u.autoGainFieldForKind('live'), 'autoGainLive');
  assert.equal(u.autoGainFieldForKind('vod'), 'autoGainVod');
  assert.equal(u.autoGainFieldForKind('clip'), 'autoGainClip');
});

test('Saved Channels prefers the last Auto gain without overwriting the manual fallback', () => {
  const entry = { gainVod: 0.5, autoGainVod: 0.8 };
  assert.equal(u.extractGainForKind(entry, 'vod'), 0.5);
  assert.equal(u.extractAutoGainForKind(entry, 'vod'), 0.8);
  assert.equal(u.extractAutoDisplayGain(entry, 'vod'), 0.8);
  assert.equal(u.extractAutoDisplayGain({ gainVod: 0.5 }, 'vod'), 0.5);
  assert.equal(u.formatAutoGain(u.extractAutoDisplayGain(entry, 'vod'), 'dB'), 'Auto (-1.9 dB)');
  const optionsSource = fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8');
  assert.match(optionsSource, /formatAutoGain\(\s*extractAutoDisplayGain\(entry, kind\)/s);
});

test('resolveAutoApplySetting prioritizes explicit choice, manual gain, then default', () => {
  assert.equal(
    u.resolveAutoApplySetting({ autoApplyLoudnessLive: true, gainLive: 0.5 }, 'live', false),
    true
  );
  assert.equal(
    u.resolveAutoApplySetting({ autoApplyLoudnessVod: false }, 'vod', true),
    false
  );
  assert.equal(u.resolveAutoApplySetting({ gainClip: 0.8 }, 'clip', true), false);
  assert.equal(u.resolveAutoApplySetting({ gainLive: 0.8 }, 'vod', true), true);
  assert.equal(u.resolveAutoApplySetting({ name: 'Unconfigured' }, 'clip', true), true);
  assert.equal(u.resolveAutoApplySetting(null, 'live', false), false);
});

test('resolvePreferredGain follows current LUFS only when Auto is enabled', () => {
  const auto = u.resolvePreferredGain(
    { autoApplyLoudnessVod: true, gainVod: 0.5 },
    'vod',
    false,
    -23,
    -18
  );
  assert.equal(auto.autoApply, true);
  assert.ok(Math.abs(auto.gain - Math.pow(10, 5 / 20)) < 1e-9);

  const waiting = u.resolvePreferredGain(
    { autoApplyLoudnessVod: true, gainVod: 0.5, autoGainVod: 0.8 },
    'vod',
    false,
    -Infinity,
    -18
  );
  assert.deepEqual(waiting, { autoApply: true, gain: 0.8 });

  const waitingWithoutAutoGain = u.resolvePreferredGain(
    { autoApplyLoudnessVod: true, gainVod: 0.5 },
    'vod',
    false,
    -Infinity,
    -18
  );
  assert.deepEqual(waitingWithoutAutoGain, { autoApply: true, gain: 0.5 });

  const manual = u.resolvePreferredGain({ gainLive: 0.7 }, 'live', true, -23, -18);
  assert.deepEqual(manual, { autoApply: false, gain: 0.7 });
});

test('extractGainForKind does not leak a typed gain across media kinds', () => {
  assert.equal(u.extractGainForKind({ gainLive: 0.8 }, 'vod'), null);
  assert.equal(u.extractGainForKind({ gain: 0.6 }, 'clip'), 0.6);
});

test('classifyTwitchUrl: live channel', () => {
  const c = u.classifyTwitchUrl('https://www.twitch.tv/fixture_channel');
  assert.deepEqual(c, { kind: 'live', login: 'fixture_channel' });
});

test('classifyTwitchUrl: VOD', () => {
  const c = u.classifyTwitchUrl('https://www.twitch.tv/videos/2770346335');
  assert.deepEqual(c, { kind: 'vod', videoId: '2770346335' });
});

test('classifyTwitchUrl: clip on clips subdomain', () => {
  const c = u.classifyTwitchUrl('https://clips.twitch.tv/SomeClipSlug');
  assert.deepEqual(c, { kind: 'clip', slug: 'SomeClipSlug' });
});

test('classifyTwitchUrl: clip on channel path', () => {
  const c = u.classifyTwitchUrl('https://www.twitch.tv/fixture_channel/clip/AbcDef');
  assert.deepEqual(c, { kind: 'clip', slug: 'AbcDef', login: 'fixture_channel' });
});

test('classifyTwitchUrl: reserved path is not a channel', () => {
  assert.equal(u.classifyTwitchUrl('https://www.twitch.tv/directory').kind, 'none');
  assert.equal(u.classifyTwitchUrl('https://www.twitch.tv/settings').kind, 'none');
});

test('classifyTwitchUrl: bare twitch.tv → none', () => {
  assert.equal(u.classifyTwitchUrl('https://www.twitch.tv/').kind, 'none');
});

test('owner metadata is accepted only for the current Twitch content', () => {
  const live = u.classifyTwitchUrl('https://www.twitch.tv/fixture_channel');
  const vod = u.classifyTwitchUrl('https://www.twitch.tv/videos/2770346335');
  assert.equal(u.ownerMatchesTwitchContent({
    userId: '123', source: 'video', contentKind: 'vod', contentId: '2770346335'
  }, vod), true);
  assert.equal(u.ownerMatchesTwitchContent({
    userId: '123', source: 'video', contentKind: 'vod', contentId: 'stale-video'
  }, vod), false);
  assert.equal(u.ownerMatchesTwitchContent({
    userId: '123', source: 'video', contentKind: 'vod', contentId: ''
  }, vod), false);

  const clip = u.classifyTwitchUrl('https://clips.twitch.tv/SomeClipSlug');
  assert.equal(u.ownerMatchesTwitchContent({
    userId: '456', source: 'clip', contentKind: 'clip', contentId: 'SomeClipSlug'
  }, clip), true);
  assert.equal(u.provisionalChannelIdForContent(vod), 'vod-owner:2770346335');
  assert.equal(u.provisionalChannelIdForContent(clip), 'clip-owner:SomeClipSlug');
  assert.equal(u.provisionalChannelIdForContent(live), 'login:fixture_channel');
});

test('Saved Channels links only to the canonical channel URL', () => {
  assert.equal(u.twitchChannelUrlForEntry('123456789', {
    login: 'Fixture_Channel',
    url: 'https://www.twitch.tv/videos/111222333'
  }), 'https://www.twitch.tv/fixture_channel');
  assert.equal(u.twitchChannelUrlForEntry('login:Fixture_Channel', {
    url: 'https://www.twitch.tv/videos/111222333'
  }), 'https://www.twitch.tv/fixture_channel');
  assert.equal(u.twitchChannelUrlForEntry('123456789', {
    url: 'https://www.twitch.tv/videos/111222333'
  }), '');
});

test('live owner resolution merges a duplicate VOD row into one canonical channel', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/fixture_channel',
    channelVolumes: {
      'login:fixture_channel': {
        name: 'Fixture Channel',
        gainLive: 0.7,
        url: 'https://www.twitch.tv/fixture_channel'
      },
      '123456789': {
        name: 'Fixture Channel',
        login: 'fixture_channel',
        gainVod: 0.8,
        url: 'https://www.twitch.tv/videos/111222333'
      }
    }
  });
  await flushTasks();
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '123456789',
    login: 'fixture_channel',
    displayName: 'Fixture Channel',
    source: 'user',
    contentKind: 'live',
    contentId: 'fixture_channel'
  });

  const channels = harness.stored[u.CHANNEL_VOLUMES_KEY];
  assert.equal(channels['login:fixture_channel'], undefined);
  assert.equal(channels['123456789'].gainLive, 0.7);
  assert.equal(channels['123456789'].gainVod, 0.8);
  assert.equal(channels['123456789'].login, 'fixture_channel');
  assert.equal(channels['123456789'].url, 'https://www.twitch.tv/fixture_channel');

  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.channel.id, '123456789');
  assert.equal(state.channel.url, 'https://www.twitch.tv/fixture_channel');
});

test('content Auto mode follows LUFS and recalculates when the target changes', async () => {
  const harness = createContentHarness({ autoApply: true, autoGain: 0.8 });
  await flushTasks();
  let gains = harness.commands.filter((command) => command.cmd === 'setGain');
  assert.equal(gains.at(-1).value, 0.8);
  harness.commands.length = 0;

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -23,
    shortTerm: -23,
    integrated: -23
  });
  gains = harness.commands.filter((command) => command.cmd === 'setGain');
  assert.equal(gains.length, 1);
  assert.ok(Math.abs(gains[0].value - u.calcGain(-23, -18)) < 1e-9);
  await flushTasks();
  assert.ok(Math.abs(
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].autoGainVod -
      u.calcGain(-23, -18)
  ) < 1e-9);
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].gainVod, 0.5);

  harness.commands.length = 0;
  harness.stored[u.SETTINGS_KEY] = {
    ...harness.stored[u.SETTINGS_KEY],
    targetLufs: -20
  };
  await harness.dispatchStorage({
    [u.SETTINGS_KEY]: { newValue: structuredClone(harness.stored[u.SETTINGS_KEY]) }
  });
  gains = harness.commands.filter((command) => command.cmd === 'setGain');
  assert.equal(gains.length, 1);
  assert.ok(Math.abs(gains[0].value - u.calcGain(-23, -20)) < 1e-9);
  assert.ok(Math.abs(
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].autoGainVod -
      u.calcGain(-23, -20)
  ) < 1e-9);
});

test('content manual mode does not follow incoming LUFS measurements', async () => {
  const harness = createContentHarness({ autoApply: false });
  await flushTasks();
  harness.commands.length = 0;

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -23,
    shortTerm: -23,
    integrated: -23
  });
  assert.equal(harness.commands.some((command) => command.cmd === 'setGain'), false);
});

test('Auto save remains successful when only the follow-up storage read fails', async () => {
  const harness = createContentHarness({ autoApply: false });
  await flushTasks();
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -23,
    shortTerm: -23,
    integrated: -23
  });
  harness.commands.length = 0;
  harness.failNextStorageGet();

  const response = await harness.dispatchRuntime({
    cmd: 'setAutoApplyLoudness',
    channelId: 'vod-owner:100',
    kind: 'vod',
    enabled: true
  });

  assert.equal(response.ok, true);
  assert.equal(response.autoApplyLoudness, true);
  assert.ok(Math.abs(response.gain - u.calcGain(-23, -18)) < 1e-9);
  assert.equal(
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].autoApplyLoudnessVod,
    true
  );
  assert.ok(Math.abs(
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].autoGainVod -
      u.calcGain(-23, -18)
  ) < 1e-9);
});

test('GraphQL owner fallback keeps the request-time VOD identity across navigation', async () => {
  const harness = createPageBridgeHarness();
  harness.messages.length = 0;
  harness.fetch('https://gql.twitch.tv/gql');
  harness.location.href = 'https://www.twitch.tv/videos/200';
  harness.resolveFetch({
    clone() {
      return {
        async json() {
          return {
            data: {
              video: {
                owner: { id: '123', login: 'owner', displayName: 'Owner' }
              },
              clip: {
                slug: 'DirectClip',
                broadcaster: { id: '123', login: 'owner', displayName: 'Owner' }
              }
            }
          };
        }
      };
    }
  });
  await flushTasks();

  const owners = harness.messages.filter((message) => message.event === 'owner');
  assert.equal(owners.length, 2);
  assert.equal(owners[0].contentKind, 'vod');
  assert.equal(owners[0].contentId, '100');
  assert.equal(owners[1].contentKind, 'clip');
  assert.equal(owners[1].contentId, 'DirectClip');
});

test('channel aliases resolve persisted direct and chained canonical IDs', () => {
  assert.equal(u.CHANNEL_ALIASES_KEY, channelStore.CHANNEL_ALIASES_KEY);
  assert.equal(u.CHANNEL_SEQUENCE_KEY, channelStore.CHANNEL_SEQUENCE_KEY);
  const aliases = {
    'vod-owner:2770346335': 'owner-alias',
    'owner-alias': '123456'
  };
  assert.equal(u.resolveChannelIdAlias('vod-owner:2770346335', aliases), '123456');
  assert.equal(u.resolveChannelIdAlias('123456', aliases), '123456');
  assert.equal(u.resolveChannelIdAlias('cycle-a', {
    'cycle-a': 'cycle-b', 'cycle-b': 'cycle-a'
  }), 'cycle-a');
});

test('legacy Live and VOD rows normalize to one numeric channel and channel URL', async () => {
  let stored = {
    channelVolumes: {
      'login:fixture_channel': {
        name: 'Fixture Channel',
        gainLive: 0.7,
        autoApplyLoudnessLive: true,
        url: 'https://www.twitch.tv/fixture_channel'
      },
      '123456789': {
        name: 'Fixture Channel',
        login: 'fixture_channel',
        gainVod: 0.8,
        autoApplyLoudnessVod: false,
        url: 'https://www.twitch.tv/videos/111222333'
      }
    }
  };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage);

  await write({ operation: 'normalizeChannels' });

  assert.equal(stored.channelVolumes['login:fixture_channel'], undefined);
  assert.equal(stored.channelVolumes['123456789'].gainLive, 0.7);
  assert.equal(stored.channelVolumes['123456789'].gainVod, 0.8);
  assert.equal(stored.channelVolumes['123456789'].autoApplyLoudnessLive, true);
  assert.equal(stored.channelVolumes['123456789'].autoApplyLoudnessVod, false);
  assert.equal(stored.channelVolumes['123456789'].url, 'https://www.twitch.tv/fixture_channel');
  assert.equal(stored.channelVolumeAliases['login:fixture_channel'], '123456789');
});

test('provisional channel migration keeps confirmed data over stale provisional conflicts', () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  const initial = {
    [provisionalId]: {
      name: 'Temporary',
      gainVod: 0.5,
      autoGainVod: 0.6,
      autoApplyLoudnessVod: true,
      lastLufs: { vod: -20 },
      lastMeasuredAt: 100
    },
    [confirmedId]: {
      name: 'Confirmed',
      gainLive: 0.8,
      gainVod: 0.8,
      autoGainVod: 0.8,
      autoApplyLoudnessVod: false,
      lastLufs: { live: -18, vod: -17 },
      lastMeasuredAt: 200
    }
  };
  const result = channelStore.applyChannelVolumesMutation(initial, {
    operation: 'mergeChannelIds',
    fromId: provisionalId,
    toId: confirmedId,
    kind: 'vod',
    channel: { name: 'Broadcaster', login: 'broadcaster', url: 'https://www.twitch.tv/videos/2770346335' }
  });

  assert.equal(result[provisionalId], undefined);
  assert.equal(result[confirmedId].autoApplyLoudnessVod, false);
  assert.equal(result[confirmedId].gainVod, 0.8);
  assert.equal(result[confirmedId].autoGainVod, 0.8);
  assert.equal(result[confirmedId].gainLive, 0.8);
  assert.deepEqual(result[confirmedId].lastLufs, { vod: -17, live: -18 });
  assert.equal(result[confirmedId].name, 'Broadcaster');
});

test('provisional channel migration uses field update order across tabs', () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  let state = {
    [provisionalId]: {
      name: 'Temporary',
      gainVod: 0.5,
      autoApplyLoudnessVod: false,
      lastLufs: { vod: -24 }
    },
    [confirmedId]: {
      name: 'Confirmed',
      gainVod: 0.8,
      autoApplyLoudnessVod: false,
      lastLufs: { vod: -17 },
      __fieldVersions: {
        gainVod: 1,
        autoApplyLoudnessVod: 2,
        'lastLufs.vod': 3
      }
    }
  };
  state = channelStore.applyChannelVolumesMutation(state, {
    operation: 'saveGain', channelId: provisionalId, kind: 'vod', gain: 0.6, sequence: 4
  });
  state = channelStore.applyChannelVolumesMutation(state, {
    operation: 'saveAuto', channelId: provisionalId, kind: 'vod', enabled: true, sequence: 5
  }, 300);
  state = channelStore.applyChannelVolumesMutation(state, {
    operation: 'saveMeasurement', channelId: provisionalId, kind: 'vod',
    lufs: -20, autoGain: 0.9, sequence: 6
  }, 300);
  state = channelStore.applyChannelVolumesMutation(state, {
    operation: 'mergeChannelIds', fromId: provisionalId, toId: confirmedId, kind: 'vod'
  });

  assert.equal(state[provisionalId], undefined);
  assert.equal(state[confirmedId].gainVod, 0.6);
  assert.equal(state[confirmedId].autoApplyLoudnessVod, true);
  assert.equal(state[confirmedId].autoGainVod, 0.9);
  assert.equal(state[confirmedId].lastLufs.vod, -20);
  assert.deepEqual(state[confirmedId].__fieldVersions, {
    gainVod: 4,
    autoApplyLoudnessVod: 5,
    'lastLufs.vod': 6,
    autoGainVod: 6
  });
});

test('provisional channel migration keeps a later confirmed field update', () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  let state = {
    [provisionalId]: {
      gainVod: 0.6,
      autoGainVod: 0.7,
      __fieldVersions: { gainVod: 4, autoGainVod: 5 }
    },
    [confirmedId]: {
      gainVod: 0.8,
      autoGainVod: 0.9,
      __fieldVersions: { gainVod: 7, autoGainVod: 8 }
    }
  };
  state = channelStore.applyChannelVolumesMutation(state, {
    operation: 'mergeChannelIds', fromId: provisionalId, toId: confirmedId, kind: 'vod'
  });

  assert.equal(state[provisionalId], undefined);
  assert.equal(state[confirmedId].gainVod, 0.8);
  assert.equal(state[confirmedId].autoGainVod, 0.9);
  assert.equal(state[confirmedId].__fieldVersions.gainVod, 7);
  assert.equal(state[confirmedId].__fieldVersions.autoGainVod, 8);
});

test('service-worker writer serializes concurrent Auto and LUFS mutations', async () => {
  let stored = { channelVolumes: {} };
  const storage = {
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      return readStoredKeys(stored, keys);
    },
    async set(update) {
      await new Promise((resolve) => setImmediate(resolve));
      stored = { ...stored, ...structuredClone(update) };
    }
  };
  const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 1234);

  await Promise.all([
    write({
      operation: 'saveAuto', channelId: 'login:test', kind: 'live', enabled: true,
      channel: { name: 'Test' }
    }),
    write({
      operation: 'saveMeasurement', channelId: 'login:test', kind: 'live', lufs: -19,
      autoGain: 0.75,
      channel: { name: 'Test' }
    })
  ]);

  assert.equal(stored.channelVolumes['login:test'].autoApplyLoudnessLive, true);
  assert.equal(stored.channelVolumes['login:test'].name, 'Test');
  assert.equal(stored.channelVolumes['login:test'].lastLufs.live, -19);
  assert.equal(stored.channelVolumes['login:test'].lastMeasuredAt, 1234);
  assert.equal(stored.channelVolumes['login:test'].autoGainLive, 0.75);
  assert.equal(stored.channelVolumes['login:test'].__fieldVersions.autoApplyLoudnessLive, 1);
  assert.equal(stored.channelVolumes['login:test'].__fieldVersions['lastLufs.live'], 2);
  assert.equal(stored.channelVolumes['login:test'].__fieldVersions.autoGainLive, 2);
  assert.equal(stored.channelVolumeSequence, 2);
});

test('service-worker writer preserves a newer provisional setting saved by another tab', async () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  let stored = {
    channelVolumes: {
      [provisionalId]: { name: 'Temporary' },
      [confirmedId]: {
        name: 'Confirmed', gainVod: 0.8, autoApplyLoudnessVod: false
      }
    }
  };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage);

  await write({ operation: 'saveGain', channelId: provisionalId, kind: 'vod', gain: 0.6 });
  await write({ operation: 'saveAuto', channelId: provisionalId, kind: 'vod', enabled: true });
  await write({
    operation: 'mergeChannelIds', fromId: provisionalId, toId: confirmedId, kind: 'vod'
  });

  assert.equal(stored.channelVolumes[provisionalId], undefined);
  assert.equal(stored.channelVolumes[confirmedId].gainVod, 0.6);
  assert.equal(stored.channelVolumes[confirmedId].autoApplyLoudnessVod, true);
  assert.equal(stored.channelVolumeAliases[provisionalId], confirmedId);
});

test('service-worker writer redirects a queued provisional-ID mutation after merge', async () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  let stored = {
    channelVolumes: {
      [provisionalId]: { name: 'Temporary', autoApplyLoudnessVod: false },
      [confirmedId]: { name: 'Confirmed', autoApplyLoudnessVod: false }
    }
  };
  const storage = {
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      return readStoredKeys(stored, keys);
    },
    async set(update) {
      await new Promise((resolve) => setImmediate(resolve));
      stored = { ...stored, ...structuredClone(update) };
    }
  };
  const write = channelStore.createChannelVolumesWriter(storage);

  await Promise.all([
    write({
      operation: 'mergeChannelIds', fromId: provisionalId, toId: confirmedId,
      kind: 'vod'
    }),
    write({
      operation: 'saveAuto', channelId: provisionalId, kind: 'vod', enabled: true
    })
  ]);

  assert.equal(stored.channelVolumes[provisionalId], undefined);
  assert.equal(stored.channelVolumes[confirmedId].autoApplyLoudnessVod, true);
  assert.equal(stored.channelVolumeAliases[provisionalId], confirmedId);
});

test('persisted alias redirects writes after the service-worker writer is recreated', async () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  let stored = {
    channelVolumes: {
      [provisionalId]: { name: 'Temporary' },
      [confirmedId]: { name: 'Confirmed', gainVod: 0.8 }
    }
  };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const firstWriter = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
  await firstWriter({
    operation: 'mergeChannelIds', fromId: provisionalId, toId: confirmedId, kind: 'vod',
    channel: { name: 'Owner', login: 'owner', url: 'https://www.twitch.tv/videos/2770346335' }
  });

  const restartedWriter = channelStore.createChannelVolumesWriter(
    storage, 'channelVolumes', () => 200
  );
  await restartedWriter({
    operation: 'saveMeasurement', channelId: provisionalId, kind: 'vod', lufs: -19,
    autoGain: 0.9,
    channel: { name: 'v1', url: 'https://www.twitch.tv/videos/2770346335' }
  });

  assert.equal(stored.channelVolumes[provisionalId], undefined);
  assert.equal(stored.channelVolumes[confirmedId].gainVod, 0.8);
  assert.equal(stored.channelVolumes[confirmedId].autoGainVod, 0.9);
  assert.equal(stored.channelVolumes[confirmedId].lastLufs.vod, -19);
  assert.equal(stored.channelVolumes[confirmedId].lastMeasuredAt, 200);
  assert.equal(stored.channelVolumes[confirmedId].name, 'Owner');
  assert.equal(stored.channelVolumes[confirmedId].login, 'owner');
  assert.equal(stored.channelVolumeAliases[provisionalId], confirmedId);
});

test('queued provisional measurement cannot overwrite canonical owner metadata', async () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  let stored = {
    channelVolumes: {
      [provisionalId]: { name: 'v1' },
      [confirmedId]: { name: 'Previous owner name', gainVod: 0.8 }
    }
  };
  const storage = {
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      return readStoredKeys(stored, keys);
    },
    async set(update) {
      await new Promise((resolve) => setImmediate(resolve));
      stored = { ...stored, ...structuredClone(update) };
    }
  };
  const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 300);

  await Promise.all([
    write({
      operation: 'mergeChannelIds', fromId: provisionalId, toId: confirmedId, kind: 'vod',
      channel: { name: 'Owner', login: 'owner' }
    }),
    write({
      operation: 'saveMeasurement', channelId: provisionalId, kind: 'vod', lufs: -18,
      autoGain: 0.9,
      channel: { name: 'v1', url: 'https://www.twitch.tv/videos/2770346335' }
    })
  ]);

  assert.equal(stored.channelVolumes[provisionalId], undefined);
  assert.equal(stored.channelVolumes[confirmedId].lastLufs.vod, -18);
  assert.equal(stored.channelVolumes[confirmedId].autoGainVod, 0.9);
  assert.equal(stored.channelVolumes[confirmedId].name, 'Owner');
  assert.equal(stored.channelVolumes[confirmedId].login, 'owner');
});

test('field sequence resumes above persisted entry versions after writer recreation', async () => {
  let stored = {
    channelVolumes: {
      'login:test': {
        autoApplyLoudnessLive: true,
        __fieldVersions: { autoApplyLoudnessLive: 7 }
      }
    }
  };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const restartedWriter = channelStore.createChannelVolumesWriter(storage);
  await restartedWriter({
    operation: 'saveGain', channelId: 'login:test', kind: 'live', gain: 0.7
  });

  assert.equal(stored.channelVolumeSequence, 8);
  assert.equal(stored.channelVolumes['login:test'].__fieldVersions.gainLive, 8);
});

test('Auto gain mutations validate range and advance the persistent field sequence', async () => {
  assert.throws(() => channelStore.applyChannelVolumesMutation({}, {
    operation: 'saveAutoGain', channelId: 'login:test', kind: 'live', autoGain: -0.01
  }), /autoGain/);
  assert.throws(() => channelStore.applyChannelVolumesMutation({}, {
    operation: 'saveMeasurement', channelId: 'login:test', kind: 'live',
    lufs: -18, autoGain: 6.01
  }), /autoGain/);
  assert.throws(() => channelStore.applyChannelVolumesMutation({}, {
    operation: 'saveAuto', channelId: 'login:test', kind: 'live',
    enabled: true, autoGain: NaN
  }), /autoGain/);

  let stored = { channelVolumes: {}, channelVolumeSequence: 4 };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage);
  await write({
    operation: 'saveAutoGain', channelId: 'login:test', kind: 'live', autoGain: 0.7
  });

  assert.equal(stored.channelVolumeSequence, 5);
  assert.equal(stored.channelVolumes['login:test'].autoGainLive, 0.7);
  assert.equal(stored.channelVolumes['login:test'].__fieldVersions.autoGainLive, 5);
});

test('clearing channels clears aliases without moving the sequence backward', async () => {
  let stored = {
    channelVolumes: { '123456': { gainVod: 0.8 } },
    channelVolumeAliases: { 'vod-owner:2770346335': '123456' },
    channelVolumeSequence: 9
  };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage);
  await write({ operation: 'clearChannels' });

  assert.deepEqual(stored.channelVolumes, {});
  assert.deepEqual(stored.channelVolumeAliases, {});
  assert.equal(stored.channelVolumeSequence, 9);
});

test('service-worker writer recovers after a failed storage update', async () => {
  let stored = { channelVolumes: {} };
  let failNextSet = true;
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) {
      if (failNextSet) {
        failNextSet = false;
        throw new Error('injected storage failure');
      }
      stored = { ...stored, ...structuredClone(update) };
    }
  };
  const write = channelStore.createChannelVolumesWriter(storage);
  await assert.rejects(write({
    operation: 'saveAuto', channelId: 'login:test', kind: 'live', enabled: true
  }), /injected storage failure/);
  await write({
    operation: 'saveAuto', channelId: 'login:test', kind: 'live', enabled: false
  });
  assert.equal(stored.channelVolumes['login:test'].autoApplyLoudnessLive, false);
});

test('settings writer preserves unrelated fields across concurrent tabs', async () => {
  let stored = {
    autoLoudnessSettings: {
      targetLufs: -18,
      displayUnit: '%',
      autoApplyLoudnessLiveDefault: true,
      autoApplyLoudnessVodDefault: true,
      autoApplyLoudnessClipDefault: false
    }
  };
  const storage = {
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      return readStoredKeys(stored, keys);
    },
    async set(update) {
      await new Promise((resolve) => setImmediate(resolve));
      stored = { ...stored, ...structuredClone(update) };
    }
  };
  const write = settingsStore.createSettingsWriter(storage);

  await Promise.all([
    write({ operation: 'patchSettings', patch: { displayUnit: 'dB' } }),
    write({
      operation: 'patchSettings',
      patch: { autoApplyLoudnessClipDefault: true }
    })
  ]);

  assert.deepEqual(stored.autoLoudnessSettings, {
    targetLufs: -18,
    displayUnit: 'dB',
    autoApplyLoudnessLiveDefault: true,
    autoApplyLoudnessVodDefault: true,
    autoApplyLoudnessClipDefault: true
  });
});

test('settings mutations reject unknown fields and invalid values', () => {
  assert.throws(() => settingsStore.applySettingsMutation({}, {
    operation: 'patchSettings', patch: { futureSetting: true }
  }), /unknown settings field/);
  assert.throws(() => settingsStore.applySettingsMutation({}, {
    operation: 'patchSettings', patch: { targetLufs: -31 }
  }), /invalid settings value/);
  assert.throws(() => settingsStore.applySettingsMutation({}, {
    operation: 'patchSettings', patch: {}
  }), /must not be empty/);
});

test('settings initialization preserves existing Auto defaults', () => {
  const existing = {
    targetLufs: -16,
    autoApplyLoudnessLiveDefault: true
  };
  const result = settingsStore.applySettingsMutation(existing, {
    operation: 'initializeSettings',
    defaults: {
      targetLufs: -18,
      autoApplyLoudnessLiveDefault: false
    }
  });
  assert.deepEqual(result, existing);
});

test('background mutation listener keeps async response open and reports failures', async () => {
  let stored = {
    channelVolumes: {
      'login:fixture_channel': { name: 'Fixture Channel', gainLive: 0.7 },
      '123456789': {
        name: 'Fixture Channel',
        login: 'fixture_channel',
        gainVod: 0.8,
        url: 'https://www.twitch.tv/videos/111222333'
      }
    },
    autoLoudnessSettings: {
      targetLufs: -18,
      displayUnit: '%',
      autoApplyLoudnessLiveDefault: true
    }
  };
  let failNextSet = false;
  let messageListener;
  let installedListener;
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) {
      if (failNextSet) {
        failNextSet = false;
        throw new Error('injected background failure');
      }
      stored = { ...stored, ...structuredClone(update) };
    }
  };
  const context = vm.createContext({
    console: { error() {} },
    chrome: {
      storage: { local: storage },
      runtime: {
        onMessage: { addListener(listener) { messageListener = listener; } },
        onInstalled: { addListener(listener) { installedListener = listener; } }
      }
    }
  });
  context.importScripts = (...filenames) => {
    for (const filename of filenames) {
      const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
      vm.runInContext(source, context, { filename });
    }
  };
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'),
    context,
    { filename: 'background.js' }
  );

  installedListener();
  await flushTasks();
  assert.equal(stored.channelVolumes['login:fixture_channel'], undefined);
  assert.equal(stored.channelVolumes['123456789'].gainLive, 0.7);
  assert.equal(stored.channelVolumes['123456789'].gainVod, 0.8);
  assert.equal(stored.channelVolumes['123456789'].url, 'https://www.twitch.tv/fixture_channel');

  const send = (mutation, type = channelStore.CHANNEL_MUTATION_MESSAGE) => new Promise((resolve) => {
    const keepOpen = messageListener({
      type,
      mutation
    }, {}, resolve);
    assert.equal(keepOpen, true);
  });

  const successResponse = await send({
    operation: 'saveAuto', channelId: 'login:test', kind: 'live', enabled: true
  });
  assert.equal(successResponse.ok, true);
  assert.equal(stored.channelVolumes['login:test'].autoApplyLoudnessLive, true);

  failNextSet = true;
  const failureResponse = await send({
    operation: 'saveAuto', channelId: 'login:test', kind: 'live', enabled: false
  });
  assert.equal(failureResponse.ok, false);
  assert.equal(failureResponse.reason, 'storage-update-failed');
  assert.equal(stored.channelVolumes['login:test'].autoApplyLoudnessLive, true);

  const settingsResponse = await send({
    operation: 'patchSettings', patch: { displayUnit: 'dB' }
  }, settingsStore.SETTINGS_MUTATION_MESSAGE);
  assert.equal(settingsResponse.ok, true);
  assert.equal(settingsResponse.settings.displayUnit, 'dB');
  assert.equal(stored.autoLoudnessSettings.autoApplyLoudnessLiveDefault, true);

  failNextSet = true;
  const settingsFailureResponse = await send({
    operation: 'patchSettings', patch: { autoApplyLoudnessLiveDefault: false }
  }, settingsStore.SETTINGS_MUTATION_MESSAGE);
  assert.equal(settingsFailureResponse.ok, false);
  assert.equal(settingsFailureResponse.reason, 'settings-update-failed');
  assert.equal(stored.autoLoudnessSettings.autoApplyLoudnessLiveDefault, true);
});

test('options disables settings until load and saves only field mutations', () => {
  const html = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
  for (const id of [
    'targetLufs',
    'adGainDb',
    'defaultAutoLiveToggle',
    'defaultAutoVodToggle',
    'defaultAutoClipToggle',
    'overlayToggle'
  ]) {
    assert.match(html, new RegExp(`<[^>]+id="${id}"[^>]*\\bdisabled\\b`), id);
  }
  assert.match(html, /<button[^>]+data-unit="%"[^>]*\bdisabled\b/);
  assert.match(html, /<button[^>]+data-unit="dB"[^>]*\bdisabled\b/);

  const source = fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8');
  assert.match(source, /type:\s*SETTINGS_MUTATION_MESSAGE/);
  assert.match(source, /operation:\s*'patchSettings',\s*patch/);
  assert.match(source, /setSettingsControlsDisabled\(true\);\s*loadAll\(\)/s);
  assert.doesNotMatch(source, /chrome\.storage\.local\.set\(\{\s*\[SETTINGS_KEY\]/);
});

test('Auto switches expose hit targets, keyboard focus, and reduced-motion behavior', () => {
  for (const filename of ['popup.html', 'options.html']) {
    const html = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.match(
      html,
      /\.toggle-switch\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s,
      `${filename} toggle hit target`
    );
    assert.match(
      html,
      /\.toggle-switch input\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
      `${filename} input fills the hit target`
    );
    assert.match(
      html,
      /\.toggle-switch input:focus-visible \+ \.switch-slider\s*\{/,
      `${filename} focus-visible style`
    );
    assert.match(
      html,
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.toggle-switch \.switch-slider[^}]*transition:\s*none;/s,
      `${filename} reduced-motion style`
    );
  }
});

test('content reads and observes the persisted channel alias key', () => {
  const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(
    source,
    /chrome\.storage\.local\.get\(\[CHANNEL_VOLUMES_KEY, CHANNEL_ALIASES_KEY\]\)/
  );
  assert.match(
    source,
    /changes\[CHANNEL_VOLUMES_KEY\] \|\| changes\[CHANNEL_ALIASES_KEY\]/
  );
});

test('parseDateRange: extracts attributes', () => {
  const line = '#EXT-X-DATERANGE:ID="stitched-ad-1234",CLASS="twitch-stitched-ad",START-DATE="2026-05-13T12:00:00.000Z",DURATION=30.0,X-TV-TWITCH-AD-COMMERCIAL-ID="abc",X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"';
  const a = u.parseDateRange(line);
  assert.equal(a.ID, 'stitched-ad-1234');
  assert.equal(a.CLASS, 'twitch-stitched-ad');
  assert.equal(a['START-DATE'], '2026-05-13T12:00:00.000Z');
  assert.equal(a.DURATION, '30.0');
  assert.equal(a['X-TV-TWITCH-AD-ROLL-TYPE'], 'MIDROLL');
});

test('isAdDateRange: by CLASS', () => {
  assert.equal(u.isAdDateRange({ CLASS: 'twitch-stitched-ad' }), true);
  assert.equal(u.isAdDateRange({ CLASS: 'timestamp' }), false);
});

test('isAdDateRange: by ID prefix', () => {
  assert.equal(u.isAdDateRange({ ID: 'stitched-ad-99' }), true);
  assert.equal(u.isAdDateRange({ ID: 'something-else' }), false);
});

test('parseAdRangesFromManifest: mixed manifest', () => {
  const m = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-DATERANGE:ID="timestamp-1",CLASS="timestamp",START-DATE="2026-05-13T12:00:00.000Z"
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-05-13T12:01:00.000Z",DURATION=30.0,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"
#EXTINF:2.0,
seg1.ts
`;
  const ranges = u.parseAdRangesFromManifest(m);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].id, 'stitched-ad-1');
  assert.equal(ranges[0].rollType, 'MIDROLL');
  assert.equal(ranges[0].durationSec, 30.0);
});

test('parseAdRangesFromManifest: empty input', () => {
  assert.deepEqual(u.parseAdRangesFromManifest(''), []);
  assert.deepEqual(u.parseAdRangesFromManifest(null), []);
});

test('meanSquareToLufs: known reference', () => {
  // -0.691 + 10 log10(1.0) = -0.691
  assert.ok(Math.abs(u.meanSquareToLufs(1.0) - (-0.691)) < 1e-6);
});

test('meanSquareToLufs: zero / negative → -Inf', () => {
  assert.equal(u.meanSquareToLufs(0), -Infinity);
  assert.equal(u.meanSquareToLufs(-0.5), -Infinity);
});

test('gatedIntegratedLufs: empty / all-silent → -Inf', () => {
  assert.equal(u.gatedIntegratedLufs([]), -Infinity);
  assert.equal(u.gatedIntegratedLufs([0, 0]), -Infinity);
});

test('gatedIntegratedLufs: constant signal close to single-block LUFS', () => {
  const ms = 1.0;
  const blocks = Array(50).fill(ms);
  const result = u.gatedIntegratedLufs(blocks);
  assert.ok(Math.abs(result - (-0.691)) < 1e-6);
});

test('kWeightingForSampleRate: returns 48kHz coefficients as-is', () => {
  const k = u.kWeightingForSampleRate(48000);
  assert.deepEqual(k.pre.b, u.K_PRE_48K.b);
  assert.deepEqual(k.pre.a, u.K_PRE_48K.a);
  assert.deepEqual(k.rlb.b, u.K_RLB_48K.b);
  assert.deepEqual(k.rlb.a, u.K_RLB_48K.a);
});

test('kWeightingForSampleRate: 44.1k DC gain matches 48k DC gain', () => {
  // K-weighting filters are normalized; DC gain should be near identical.
  const at48 = u.kWeightingForSampleRate(48000);
  const at441 = u.kWeightingForSampleRate(44100);
  const dcGain = ({ b, a }) => (b[0] + b[1] + b[2]) / (a[0] + a[1] + a[2]);
  const pre48 = dcGain(at48.pre);
  const pre441 = dcGain(at441.pre);
  assert.ok(Math.abs(pre48 - pre441) < 1e-3, `pre dc gain mismatch ${pre48} vs ${pre441}`);
  const rlb48 = dcGain(at48.rlb);
  const rlb441 = dcGain(at441.rlb);
  // RLB is a high-pass, DC gain is near zero for both
  assert.ok(Math.abs(rlb48 - rlb441) < 1e-3);
});
