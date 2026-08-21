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

test('unpacked extension tree contains no Chrome-reserved filenames', () => {
  const forbidden = [];
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const nextRelative = path.join(relative, entry.name);
      const allowedLocaleDirectory = nextRelative === '_locales';
      if ((entry.name.startsWith('_') && !allowedLocaleDirectory) || entry.name.endsWith('.pyc')) {
        forbidden.push(nextRelative);
        continue;
      }
      if (entry.isDirectory()) walk(path.join(directory, entry.name), nextRelative);
    }
  }
  walk(__dirname);
  assert.deepEqual(forbidden, []);
});

async function flushTasks(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createContentHarness({
  autoApply = false,
  autoGain,
  href = 'https://www.twitch.tv/videos/100',
  channelVolumes,
  deferInitialStorageGet = false,
  deferChannelMutationOperation = '',
  failChannelMutationOperation = ''
} = {}) {
  const listeners = {};
  const storageListeners = [];
  const commands = [];
  const warnings = [];
  let runtimeMessageListener;
  let runtimeId = 'test-extension';
  let failNextStorageGet = false;
  let initialStorageGetDeferred = deferInitialStorageGet;
  let channelMutationDeferred = !!deferChannelMutationOperation;
  let failingChannelMutationOperation = failChannelMutationOperation;
  let resolveInitialStorageGet;
  let pendingStorageGetDeferred = false;
  let resolvePendingStorageGet;
  let resolveChannelMutation;
  let currentTimeMs = 10_000;
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
  class HarnessDate extends Date {
    static now() { return currentTimeMs; }
  }
  const history = {
    pushState(_state, _unused, url) {
      if (url) location.href = new URL(url, location.href).href;
    },
    replaceState(_state, _unused, url) {
      if (url) location.href = new URL(url, location.href).href;
    }
  };
  const chrome = {
    runtime: {
      get id() { return runtimeId; },
      getURL(filename) { return `chrome-extension://test/${filename}`; },
      async sendMessage(message) {
        const mutation = message?.mutation;
        if (mutation) {
          if (mutation.operation === failingChannelMutationOperation) {
            failingChannelMutationOperation = '';
            return { ok: false, reason: 'storage-update-failed' };
          }
          if (channelMutationDeferred &&
              mutation.operation === deferChannelMutationOperation) {
            channelMutationDeferred = false;
            await new Promise((resolve) => { resolveChannelMutation = resolve; });
          }
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
          if (initialStorageGetDeferred) {
            initialStorageGetDeferred = false;
            return new Promise((resolve) => {
              resolveInitialStorageGet = () => resolve(readStoredKeys(stored, keys));
            });
          }
          if (pendingStorageGetDeferred) {
            pendingStorageGetDeferred = false;
            return new Promise((resolve) => {
              resolvePendingStorageGet = () => resolve(readStoredKeys(stored, keys));
            });
          }
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
    console: {
      warn(...args) { warnings.push(args); },
      error() {},
      info() {}
    },
    Date: HarnessDate,
    document,
    history,
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
    warnings,
    async dispatchMessage(data) {
      await Promise.all((listeners.message || []).map((listener) => listener({ source: window, data })));
    },
    async dispatchStorage(changes) {
      for (const listener of storageListeners) listener(changes);
      await flushTasks();
    },
    async navigate(href) {
      history.pushState({}, '', href);
      await flushTasks(8);
    },
    failNextStorageGet() {
      failNextStorageGet = true;
    },
    deferNextStorageGet() {
      pendingStorageGetDeferred = true;
    },
    async releaseStorageGet() {
      assert.ok(resolvePendingStorageGet, 'storage read is not pending');
      resolvePendingStorageGet();
      resolvePendingStorageGet = null;
      await flushTasks(8);
    },
    invalidateRuntime() {
      runtimeId = '';
    },
    advanceTime(ms) {
      currentTimeMs += ms;
    },
    releaseInitialStorageGet() {
      assert.ok(resolveInitialStorageGet, 'initial storage read is not pending');
      resolveInitialStorageGet();
      resolveInitialStorageGet = null;
    },
    releaseChannelMutation() {
      assert.ok(resolveChannelMutation, 'channel mutation is not pending');
      resolveChannelMutation();
      resolveChannelMutation = null;
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
  const video = {
    src: 'https://example.test/video',
    readyState: 4,
    clientWidth: 1920,
    clientHeight: 1080,
    isConnected: true
  };
  let measurementPort;
  let resolveFetch;
  const audioNode = () => ({
    connect() {},
    disconnect() {}
  });
  class AudioWorkletNode {
    constructor() {
      measurementPort = { onmessage: null };
      this.port = measurementPort;
    }
    connect() {}
    disconnect() {}
  }
  class AudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    createGain() {
      return {
        ...audioNode(),
        gain: { value: 1, setTargetAtTime() {} }
      };
    }
    createIIRFilter() { return audioNode(); }
    createMediaElementSource() { return audioNode(); }
    async resume() {}
  }
  const window = {
    AudioContext,
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
    AudioWorkletNode,
    clearInterval() {},
    console: { warn() {}, error() {}, info() {} },
    document: {
      querySelectorAll(selector) { return selector === 'video' ? [video] : []; }
    },
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
  const dispatchCommand = async (cmd, data = {}) => {
    const pending = (listeners.message || []).map((listener) => listener({
      source: window,
      data: {
        type: '__twitch_channel_volume_cmd__',
        cmd,
        ...data
      }
    }));
    await Promise.all(pending);
    await flushTasks();
  };
  return {
    location,
    messages,
    fetch: (...args) => window.fetch(...args),
    resolveFetch(response) { resolveFetch(response); },
    async startMeasurement() {
      await dispatchCommand('init', {
        workletUrl: 'chrome-extension://test/audio-worklet.js'
      });
      await dispatchCommand('attach');
      assert.equal(typeof measurementPort?.onmessage, 'function');
    },
    dispatchCommand,
    emitMeasurementBlock(ms) {
      measurementPort.onmessage({ data: { ms } });
    }
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
  const optionsSource = fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8');
  assert.match(optionsSource, /const url = twitchUrlForId\(id, entry\);/);
  assert.doesNotMatch(optionsSource, /entry\.url\s*\|\|\s*twitchUrlForId/);
});

test('live owner resolution merges a duplicate VOD row into one canonical channel', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/fixture_channel',
    channelVolumes: {
      'login:fixture_channel': {
        name: 'Fixture_Channel',
        gainLive: 0.7,
        url: 'https://www.twitch.tv/fixture_channel'
      },
      '123456789': {
        name: 'Fixture_Channel',
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

test('owner resolution during initial settings load migrates and applies the saved Live gain', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/fixture_channel',
    deferInitialStorageGet: true,
    channelVolumes: {
      'login:fixture_channel': {
        name: 'Fixture_Channel',
        gainLive: 0.7,
        url: 'https://www.twitch.tv/fixture_channel'
      }
    }
  });

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '123456789',
    login: 'fixture_channel',
    displayName: 'Fixture_Channel',
    source: 'user',
    contentKind: 'live',
    contentId: 'fixture_channel'
  });

  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['login:fixture_channel'], undefined);
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['123456789'].gainLive, 0.7);
  let state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.channel.id, '123456789');
  assert.equal(state.gain, 0.7);

  harness.releaseInitialStorageGet();
  await flushTasks();
  state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.channel.id, '123456789');
  assert.equal(state.gain, 0.7);
});

test('invalidated content script stops a queued owner migration without reporting a failure', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/fixture_channel',
    deferChannelMutationOperation: 'saveMeasurement',
    channelVolumes: {
      'login:fixture_channel': {
        name: 'Fixture_Channel',
        gainLive: 0.7,
        url: 'https://www.twitch.tv/fixture_channel'
      }
    }
  });
  await flushTasks();

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -21,
    shortTerm: -21,
    integrated: -21
  });
  await flushTasks();
  const ownerPromise = harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '123456789',
    login: 'fixture_channel',
    displayName: 'Fixture_Channel',
    source: 'user',
    contentKind: 'live',
    contentId: 'fixture_channel'
  });
  await flushTasks();

  harness.invalidateRuntime();
  harness.releaseChannelMutation();
  await ownerPromise;
  await flushTasks();

  assert.ok(harness.stored[u.CHANNEL_VOLUMES_KEY]['login:fixture_channel']);
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['123456789'], undefined);
  assert.equal(
    harness.warnings.some(([message]) =>
      message === '[TCV] provisional channel migration failed'
    ),
    false
  );

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '123456789',
    login: 'fixture_channel',
    displayName: 'Fixture_Channel',
    source: 'user',
    contentKind: 'live',
    contentId: 'fixture_channel'
  });
  assert.equal(harness.warnings.length, 0);
});

test('active content script reports an owner migration storage failure', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/fixture_channel',
    failChannelMutationOperation: 'mergeChannelIds',
    channelVolumes: {
      'login:fixture_channel': {
        name: 'Fixture_Channel',
        gainLive: 0.7,
        url: 'https://www.twitch.tv/fixture_channel'
      }
    }
  });
  await flushTasks();

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '123456789',
    login: 'fixture_channel',
    displayName: 'Fixture_Channel',
    source: 'user',
    contentKind: 'live',
    contentId: 'fixture_channel'
  });

  assert.ok(harness.stored[u.CHANNEL_VOLUMES_KEY]['login:fixture_channel']);
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['123456789'], undefined);
  assert.equal(
    harness.warnings.some(([message]) =>
      message === '[TCV] provisional channel migration failed'
    ),
    true
  );
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

test('content limits Auto gain updates to the popup display interval', async () => {
  const popupSource = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  assert.match(popupSource, /setInterval\(refresh, DISPLAY_UPDATE_INTERVAL_MS\);/);
  const harness = createContentHarness({ autoApply: true, autoGain: 0.8 });
  await flushTasks();
  harness.commands.length = 0;

  const emitIntegrated = (integrated) => harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: integrated,
    shortTerm: integrated,
    integrated
  });

  await emitIntegrated(-23);
  harness.advanceTime(u.DISPLAY_UPDATE_INTERVAL_MS - 1);
  await emitIntegrated(-22);
  let gains = harness.commands.filter((command) => command.cmd === 'setGain');
  assert.equal(gains.length, 1);
  assert.ok(Math.abs(gains[0].value - u.calcGain(-23, -18)) < 1e-9);

  harness.advanceTime(1);
  await emitIntegrated(-21);
  gains = harness.commands.filter((command) => command.cmd === 'setGain');
  assert.equal(gains.length, 2);
  assert.ok(Math.abs(gains[1].value - u.calcGain(-21, -18)) < 1e-9);

  // A clock that steps backwards must not stall Auto until it catches up.
  harness.advanceTime(-u.DISPLAY_UPDATE_INTERVAL_MS);
  await emitIntegrated(-20);
  gains = harness.commands.filter((command) => command.cmd === 'setGain');
  assert.equal(gains.length, 3);
  assert.ok(Math.abs(gains[2].value - u.calcGain(-20, -18)) < 1e-9);
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

test('content seeds measurement with the saved LUFS for the current media kind', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      'vod-owner:100': {
        name: '100',
        gainVod: 0.5,
        lastLufs: { live: -17, vod: -21, clip: -19 }
      }
    }
  });
  await flushTasks();

  const resetCommands = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(resetCommands.length, 1);
  assert.equal(resetCommands[0].initialIntegratedLufs, -21);
  const resetIndex = harness.commands.indexOf(resetCommands[0]);
  const attachIndex = harness.commands.findIndex((command) => command.cmd === 'attach');
  assert.ok(resetIndex < attachIndex);
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.hasSavedMeasurement, true);
});

test('content seeds the measurement once the owner ID resolves', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/videos/100',
    channelVolumes: { '777': { name: 'Streamer', lastLufs: { vod: -16 } } }
  });
  await flushTasks();

  // A first-visit VOD has no alias, so the startup seed finds nothing.
  const startup = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(startup.length, 1);
  assert.equal(startup[0].initialIntegratedLufs, undefined);
  harness.commands.length = 0;

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '777',
    login: 'streamer',
    displayName: 'Streamer',
    source: 'video',
    contentKind: 'vod',
    contentId: '100'
  });
  await flushTasks();

  const afterOwner = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(afterOwner.length, 1);
  assert.equal(afterOwner[0].initialIntegratedLufs, -16);
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.channel.id, '777');
});

test('content keeps the running measurement when the owner resolves the same channel', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/streamer',
    channelVolumes: { '777': { name: 'Streamer', lastLufs: { live: -16 } } }
  });
  harness.stored[u.CHANNEL_ALIASES_KEY] = { 'login:streamer': '777' };
  await flushTasks();

  const startup = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(startup.length, 1);
  assert.equal(startup[0].initialIntegratedLufs, -16);
  harness.commands.length = 0;

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '777',
    login: 'streamer',
    displayName: 'Streamer',
    source: 'user',
    contentKind: 'live',
    contentId: 'streamer'
  });
  await flushTasks();

  assert.equal(
    harness.commands.some((command) => command.cmd === 'resetMeasurement'),
    false
  );

  // The tab overwrites the stored LUFS while measuring, so a later owner event
  // must not read this tab's own save as a reason to restart.
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -16.2,
    shortTerm: -16.2,
    integrated: -16.2
  });
  await flushTasks();
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['777'].lastLufs.live, -16.2);

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '777',
    login: 'streamer',
    displayName: 'Streamer',
    source: 'user',
    contentKind: 'live',
    contentId: 'streamer'
  });
  await flushTasks();
  assert.equal(
    harness.commands.some((command) => command.cmd === 'resetMeasurement'),
    false
  );
});

test('content clears the saved and active measurement for the current media kind', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      'vod-owner:100': {
        name: '100',
        gainVod: 0.5,
        autoGainVod: 0.75,
        autoApplyLoudnessVod: true,
        lastLufs: { live: -17, vod: -21 }
      }
    }
  });
  await flushTasks();
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -23,
    shortTerm: -23,
    integrated: -23
  });
  await flushTasks();
  const autoGainBeforeReset =
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].autoGainVod;
  harness.commands.length = 0;

  const response = await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:100',
    kind: 'vod'
  });

  assert.equal(response.ok, true);
  const stored = harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'];
  assert.deepEqual(stored.lastLufs, { live: -17 });
  assert.equal(stored.gainVod, 0.5);
  assert.equal(stored.autoGainVod, autoGainBeforeReset);
  assert.equal(stored.autoApplyLoudnessVod, true);
  const resetCommands = harness.commands
    .filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(resetCommands.length, 1);
  assert.equal(resetCommands[0].initialIntegratedLufs, undefined);
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.lufs.integrated, -Infinity);
  assert.equal(state.hasSavedMeasurement, false);

  await flushTasks();
  harness.commands.length = 0;
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -22,
    shortTerm: -22,
    integrated: -22
  });
  const gains = harness.commands.filter((command) => command.cmd === 'setGain');
  assert.equal(gains.length, 1);
  assert.ok(Math.abs(gains[0].value - u.calcGain(-22, -18)) < 1e-9);
});

test('content ignores measurements while the reset storage mutation is pending', async () => {
  const harness = createContentHarness({
    deferChannelMutationOperation: 'clearMeasurement',
    channelVolumes: {
      'vod-owner:100': { name: '100', lastLufs: { vod: -21 } }
    }
  });
  await flushTasks();

  const resetPromise = harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:100',
    kind: 'vod'
  });
  await flushTasks();
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -15,
    shortTerm: -15,
    integrated: -15
  });
  harness.releaseChannelMutation();
  const response = await resetPromise;
  await flushTasks();

  assert.equal(response.ok, true);
  assert.equal(
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].lastLufs?.vod,
    undefined
  );
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.lufs.integrated, -Infinity);
});

test('content keeps the active measurement when resetting storage fails', async () => {
  const harness = createContentHarness({
    failChannelMutationOperation: 'clearMeasurement',
    channelVolumes: {
      'vod-owner:100': { name: '100', lastLufs: { vod: -21 } }
    }
  });
  await flushTasks();
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -19,
    shortTerm: -19,
    integrated: -19
  });
  harness.commands.length = 0;

  const response = await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:100',
    kind: 'vod'
  });

  assert.equal(response.ok, false);
  assert.equal(response.reason, 'storage update failed');
  assert.equal(
    harness.commands.some((command) => command.cmd === 'resetMeasurement'),
    false
  );
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.lufs.integrated, -19);
});

test('content rejects a measurement reset for a different channel or media kind', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      'vod-owner:100': { name: '100', lastLufs: { vod: -21 } }
    }
  });
  await flushTasks();
  harness.commands.length = 0;

  const wrongChannel = await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:200',
    kind: 'vod'
  });
  const wrongKind = await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:100',
    kind: 'live'
  });

  assert.equal(wrongChannel.ok, false);
  assert.equal(wrongChannel.reason, 'channel mismatch');
  assert.equal(wrongKind.ok, false);
  assert.equal(wrongKind.reason, 'channel mismatch');
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].lastLufs.vod, -21);
  assert.equal(
    harness.commands.some((command) => command.cmd === 'resetMeasurement'),
    false
  );
});

test('content drops a measurement produced before the reset it requested', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      'vod-owner:100': { name: '100', lastLufs: { vod: -21 } }
    }
  });
  await flushTasks();

  const response = await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:100',
    kind: 'vod'
  });
  await flushTasks();
  assert.equal(response.ok, true);

  const resetCommand = harness.commands
    .filter((command) => command.cmd === 'resetMeasurement').at(-1);
  assert.ok(Number.isFinite(resetCommand.epoch));

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    epoch: resetCommand.epoch - 1,
    momentary: -15,
    shortTerm: -15,
    integrated: -15
  });
  await flushTasks();

  assert.equal(
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].lastLufs?.vod,
    undefined
  );
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.lufs.integrated, -Infinity);
  assert.equal(state.hasSavedMeasurement, false);
});

test('content accepts a measurement stamped with the current reset epoch', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      'vod-owner:100': { name: '100', lastLufs: { vod: -21 } }
    }
  });
  await flushTasks();

  await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:100',
    kind: 'vod'
  });
  await flushTasks();
  const resetCommand = harness.commands
    .filter((command) => command.cmd === 'resetMeasurement').at(-1);

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    epoch: resetCommand.epoch,
    momentary: -15,
    shortTerm: -15,
    integrated: -15
  });
  await flushTasks();

  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.lufs.integrated, -15);
});

test('content reseeds from the new media entry only after SPA navigation', async () => {
  const channelVolumes = {
    'vod-owner:100': { name: '100', lastLufs: { vod: -21 } },
    'vod-owner:200': { name: '200', lastLufs: { vod: -19 } }
  };
  const harness = createContentHarness({ channelVolumes });
  await flushTasks();
  harness.commands.length = 0;

  await harness.dispatchStorage({
    [u.CHANNEL_VOLUMES_KEY]: { newValue: structuredClone(channelVolumes) }
  });
  assert.equal(
    harness.commands.some((command) => command.cmd === 'resetMeasurement'),
    false
  );

  await harness.navigate('https://www.twitch.tv/videos/200');
  const resetCommands = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(resetCommands.length, 2);
  assert.equal(resetCommands[0].initialIntegratedLufs, undefined);
  assert.equal(resetCommands[1].initialIntegratedLufs, -19);
});

test('content reseeds on a kind change when SPA navigation lost the reapply race', async () => {
  const channelVolumes = {
    '777': { name: 'Streamer', lastLufs: { live: -16, vod: -23 } }
  };
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/streamer',
    channelVolumes
  });
  harness.stored[u.CHANNEL_ALIASES_KEY] = { 'login:streamer': '777' };
  await flushTasks();
  const startup = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(startup.length, 1);
  assert.equal(startup[0].initialIntegratedLufs, -16);
  harness.commands.length = 0;

  // Navigate to the same owner's VOD, but hold the reapply read open and let a
  // storage change start a second reapply. The first one then loses the
  // revision race and returns false, so navigation never reseeds.
  harness.deferNextStorageGet();
  const navigation = harness.navigate('https://www.twitch.tv/videos/100');
  await flushTasks();
  await harness.dispatchStorage({
    [u.CHANNEL_VOLUMES_KEY]: { newValue: structuredClone(channelVolumes) }
  });
  await harness.releaseStorageGet();
  await navigation;

  // Only the unconditional reset from onNavigate ran: the reapply that would
  // have reseeded lost the race, so the seeded target is still the live one.
  const duringNavigation = harness.commands
    .filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(duringNavigation.length, 1);
  assert.equal(duringNavigation[0].initialIntegratedLufs, undefined);
  harness.commands.length = 0;

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '777',
    login: 'streamer',
    displayName: 'Streamer',
    source: 'video',
    contentKind: 'vod',
    contentId: '100'
  });
  await flushTasks();

  // Same canonical channel as before the navigation; only the kind changed.
  const afterOwner = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(afterOwner.length, 1);
  assert.equal(afterOwner[0].initialIntegratedLufs, -23);
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

test('content rejects Manual gain changes while an Auto mutation is pending', async () => {
  const harness = createContentHarness({
    autoApply: false,
    deferChannelMutationOperation: 'saveAuto'
  });
  await flushTasks();

  const autoResponsePromise = harness.dispatchRuntime({
    cmd: 'setAutoApplyLoudness',
    channelId: 'vod-owner:100',
    kind: 'vod',
    enabled: true
  });
  await flushTasks();

  const manualResponse = await harness.dispatchRuntime({ cmd: 'setGain', gain: 1.2 });
  assert.equal(manualResponse.ok, false);
  assert.equal(manualResponse.reason, 'auto update pending');
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].gainVod, 0.5);

  harness.releaseChannelMutation();
  const autoResponse = await autoResponsePromise;
  assert.equal(autoResponse.ok, true);
  assert.equal(autoResponse.autoApplyLoudness, true);
  assert.equal(
    harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].autoApplyLoudnessVod,
    true
  );
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].gainVod, 0.5);
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
        name: 'Fixture_Channel',
        gainLive: 0.7,
        autoApplyLoudnessLive: true,
        url: 'https://www.twitch.tv/fixture_channel'
      },
      '123456789': {
        name: 'Fixture_Channel',
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

test('clearing a measurement preserves the other media kinds and channel settings', () => {
  const state = channelStore.applyChannelVolumesMutation({
    '123456': {
      name: 'Broadcaster',
      gainVod: 0.8,
      autoGainVod: 0.9,
      autoApplyLoudnessVod: true,
      lastLufs: { live: -18, vod: -17, clip: -16 },
      lastMeasuredAt: 200,
      __fieldVersions: { 'lastLufs.vod': 4 }
    }
  }, {
    operation: 'clearMeasurement',
    channelId: '123456',
    kind: 'vod',
    sequence: 9
  });

  assert.deepEqual(state['123456'].lastLufs, { live: -18, clip: -16 });
  assert.equal(state['123456'].lastMeasuredAt, 200);
  assert.equal(state['123456'].gainVod, 0.8);
  assert.equal(state['123456'].autoGainVod, 0.9);
  assert.equal(state['123456'].autoApplyLoudnessVod, true);
  assert.equal(state['123456'].__fieldVersions['lastLufs.vod'], 9);
});

test('a newer cleared provisional measurement is not restored during owner merge', () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  const state = channelStore.applyChannelVolumesMutation({
    [provisionalId]: {
      __fieldVersions: { 'lastLufs.vod': 8 }
    },
    [confirmedId]: {
      lastLufs: { vod: -17 },
      lastMeasuredAt: 200,
      __fieldVersions: { 'lastLufs.vod': 3 }
    }
  }, {
    operation: 'mergeChannelIds',
    fromId: provisionalId,
    toId: confirmedId,
    kind: 'vod'
  });

  assert.equal(state[confirmedId].lastLufs, undefined);
  assert.equal(state[confirmedId].lastMeasuredAt, undefined);
  assert.equal(state[confirmedId].__fieldVersions['lastLufs.vod'], 8);
});

test('a newer canonical measurement tombstone removes an older provisional value', () => {
  const provisionalId = 'vod-owner:2770346335';
  const confirmedId = '123456';
  const state = channelStore.applyChannelVolumesMutation({
    [provisionalId]: {
      lastLufs: { vod: -20 },
      __fieldVersions: { 'lastLufs.vod': 3 }
    },
    [confirmedId]: {
      __fieldVersions: { 'lastLufs.vod': 8 }
    }
  }, {
    operation: 'mergeChannelIds',
    fromId: provisionalId,
    toId: confirmedId,
    kind: 'vod'
  });

  assert.equal(state[confirmedId].lastLufs, undefined);
  assert.equal(state[confirmedId].__fieldVersions['lastLufs.vod'], 8);
});

test('clearing a measurement without a stored row still blocks a later merge', () => {
  // Another tab may hold the provisional row while this one, already on the
  // canonical ID, has nothing stored yet. The clear has to leave a tombstone or
  // the provisional value comes back when the rows merge.
  let state = channelStore.applyChannelVolumesMutation({
    'vod-owner:100': { lastLufs: { vod: -20 }, __fieldVersions: { 'lastLufs.vod': 3 } }
  }, {
    operation: 'clearMeasurement',
    channelId: '777',
    kind: 'vod',
    sequence: 8
  });
  assert.equal(state['777'].lastLufs, undefined);
  assert.equal(state['777'].__fieldVersions['lastLufs.vod'], 8);

  state = channelStore.applyChannelVolumesMutation(state, {
    operation: 'mergeChannelIds',
    fromId: 'vod-owner:100',
    toId: '777',
    kind: 'vod'
  });
  assert.equal(state['777'].lastLufs, undefined);
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

test('service-worker writer orders measurement clearing after a queued save', async () => {
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
      operation: 'saveMeasurement', channelId: 'login:test', kind: 'live', lufs: -19
    }),
    write({
      operation: 'clearMeasurement', channelId: 'login:test', kind: 'live'
    })
  ]);

  const entry = stored.channelVolumes['login:test'];
  assert.equal(entry.lastLufs, undefined);
  assert.equal(entry.lastMeasuredAt, undefined);
  assert.equal(entry.__fieldVersions['lastLufs.live'], 2);
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
      'login:fixture_channel': { name: 'Fixture_Channel', gainLive: 0.7 },
      '123456789': {
        name: 'Fixture_Channel',
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
  assert.match(source, /loadAll\(\)[\s\S]*operation:\s*'normalizeChannels'/);
  assert.match(source, /setSettingsControlsDisabled\(true\);\s*loadAll\(\)/s);
  assert.doesNotMatch(source, /chrome\.storage\.local\.set\(\{\s*\[SETTINGS_KEY\]/);
});

test('popup disables Manual and Apply controls while an Auto update is pending', () => {
  const source = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  assert.match(
    source,
    /const manualDisabled = currentAutoApplyLoudness \|\| autoUpdatePending;/
  );
  assert.match(source, /if \(autoUpdatePending\) \$\('applyBtn'\)\.disabled = true;/);
  assert.match(
    source,
    /async function applyMeasured\(\) \{\s*if \(autoUpdatePending \|\|/s
  );
  assert.match(source, /async function setGain\(percent\) \{\s*if \(autoUpdatePending\) return;/s);
  assert.match(
    source,
    /autoUpdatePending = true;\s*syncInteractionDisabledState\(\);/s
  );
});

test('popup keeps Auto gain displays synchronized and labels apply in the display unit', () => {
  const source = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  assert.match(source, /if \(currentAutoApplyLoudness \|\| !sliderSynced\) \{/);
  assert.match(
    source,
    /msg\('applyToChannelWithValue', \[formatGainText\(lastSuggestedGain\)\]\)/
  );

  const ja = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json')));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/en/messages.json')));
  // The button saves the gain, so its label stays an apply action.
  assert.equal(ja.applyToChannelWithValue.message, '$VALUE$ をチャンネルに適用');
  assert.equal(en.applyToChannelWithValue.message, 'Apply $VALUE$ to channel');
});

test('popup exposes the selected channel-row measurement reset control', () => {
  const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  assert.match(
    html,
    /<button[^>]+id="resetMeasurementBtn"[^>]*\bdisabled\b[^>]*>[\s\S]*?<svg[^>]+aria-hidden="true"/s
  );
  // Icon-only control: square hit target, accessible name from a visually hidden label.
  assert.match(
    html,
    /\.reset-measurement-btn\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s
  );
  assert.match(
    html,
    /<span class="sr-only" data-i18n="resetMeasurement">[^<]+<\/span>/
  );
  assert.match(html, /\.reset-measurement-btn \.sr-only\s*\{[^}]*clip-path:\s*inset\(50%\);/s);
  assert.match(html, /\.reset-measurement-btn:focus-visible\s*\{/);

  // WCAG 2.1 SC 1.4.11: the control boundary against the panel background.
  const alpha = Number(
    html.match(/\.reset-measurement-btn\s*\{[^}]*border:\s*1px solid rgba\(78, 205, 196, ([\d.]+)\)/s)[1]
  );
  const panel = [0x16, 0x21, 0x3e];
  const border = [78, 205, 196].map((c, i) => c * alpha + panel[i] * (1 - alpha));
  const luminance = (rgb) => rgb
    .map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4)))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (luminance(border) + 0.05) / (luminance(panel) + 0.05);
  assert.ok(contrast >= 3, `reset button border contrast ${contrast.toFixed(3)} < 3`);

  const source = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  assert.match(source, /\$\('resetMeasurementBtn'\)\.title = msg\('resetMeasurement'\);/);
  assert.match(source, /nameEl\.title = nameEl\.textContent;/);
  assert.match(source, /cmd:\s*'resetMeasurement'/);
  assert.match(source, /channelId:\s*currentChannel\.id/);
  assert.match(source, /kind:\s*currentChannel\.kind/);
  assert.match(source, /hasIntegrated \|\| !!state\.hasSavedMeasurement/);
  assert.match(source, /measurementResetPending = true;\s*syncInteractionDisabledState\(\);/s);

  const ja = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json')));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/en/messages.json')));
  assert.equal(ja.resetMeasurement.message, '測定値をリセット');
  assert.equal(en.resetMeasurement.message, 'Reset measurement');
});

test('popup re-enables its controls in the render that reports the reset result', () => {
  const source = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  const body = source.slice(
    source.indexOf('async function resetMeasurement()'),
    source.indexOf('async function refresh()')
  );
  const success = body.indexOf('await refresh();');
  const failure = body.indexOf('renderState(latestState)');
  const clearedOnSuccess = body.indexOf('measurementResetPending = false;');
  const clearedOnFailure = body.indexOf('measurementResetPending = false;', clearedOnSuccess + 1);
  assert.ok(success > -1 && failure > -1 && clearedOnSuccess > -1 && clearedOnFailure > -1);
  // syncInteractionDisabledState only disables, so a render that still sees the
  // pending flag leaves the Apply button stuck until the next poll.
  assert.ok(clearedOnSuccess < success, 'pending flag clears before the success render');
  assert.ok(clearedOnFailure < failure, 'pending flag clears before the failure render');
});

test('store popup screenshot generator matches the Auto-follow state', () => {
  const source = fs.readFileSync(path.join(__dirname, 'gen_screenshots.py'), 'utf8');
  assert.match(source, /'apply':\s*'チャンネルに適用'/);
  assert.match(source, /'apply':\s*'Apply to channel'/);
  assert.match(source, /\('CURRENT', '63', '%', PINK\)/);
  assert.match(source, /draw\.text\(\(px \+ pw - 48, sy - 1\), '63%'/);
  assert.match(source, /RESET_BUTTON_HEIGHT\s*=\s*36/);
  // The mock mirrors the icon-only control: square, unlabelled, never overlapping.
  assert.match(source, /reset_width = RESET_BUTTON_HEIGHT/);
  assert.match(source, /assert bx \+ 34 <= reset_x - 8/);
  assert.ok(!source.includes("'reset'"));
});

test('store popup reset icon follows the popup SVG geometry', () => {
  const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, 'gen_screenshots.py'), 'utf8');

  const arcPath = html.match(/M([\d.]+) ([\d.]+)a8 8 0 1 0 ([\d.]+)(-[\d.]+)L([\d.]+) ([\d.]+)/);
  const headPath = html.match(/M([\d.]+) ([\d.]+)v([\d.]+)h([\d.]+)/);
  assert.ok(arcPath && headPath, 'popup.html still declares the reset icon paths');
  const [sx, sy, dx, dy, hx, hy] = arcPath.slice(1).map(Number);
  const end = [sx + dx, sy + dy];
  const [mx, my, down, right] = headPath.slice(1).map(Number);
  const corner = [mx, my + down];

  const circle = source.match(/cx, cy, r = ([\d.]+), ([\d.]+), ([\d.]+)/).slice(1).map(Number);
  const [cx, cy, r] = circle;
  for (const point of [[sx, sy], end]) {
    const radius = Math.hypot(point[0] - cx, point[1] - cy);
    assert.ok(Math.abs(radius - r) < 0.05, `arc endpoint ${point} off the mock circle`);
  }

  const angle = (point) =>
    ((Math.atan2(point[1] - cy, point[0] - cx) * 180) / Math.PI + 360) % 360;
  const arcCall = source.match(/\n\s+([\d.]+), ([\d.]+), fill=color, width=width,/);
  assert.ok(arcCall, 'the mock draws the arc with explicit angles');
  assert.ok(Math.abs(Number(arcCall[1]) - angle(end)) < 0.2);
  assert.ok(Math.abs(Number(arcCall[2]) - angle([sx, sy])) < 0.2);

  assert.match(source, new RegExp(`arc_end = \\(${end[0]}, ${end[1]}\\)`));
  assert.match(source, new RegExp(`pt\\(${corner[0]}, ${corner[1]}\\)`));
  assert.match(source, new RegExp(`pt\\(${mx}, ${my}\\), pt\\(${corner[0]}, ${corner[1]}\\), pt\\(${mx + right}, ${corner[1]}\\)`));
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

test('page bridge Integrated LUFS is invariant to block input order', async () => {
  async function measure(blocks) {
    const harness = createPageBridgeHarness();
    await harness.startMeasurement();
    harness.messages.length = 0;
    for (const ms of blocks) harness.emitMeasurementBlock(ms);
    return harness.messages.at(-1).integrated;
  }

  const forward = await measure([1.0, 0.09]);
  const reverse = await measure([0.09, 1.0]);
  const expected = u.gatedIntegratedLufs([1.0, 0.09]);

  assert.ok(Math.abs(forward - expected) < 1e-12);
  assert.ok(Math.abs(reverse - expected) < 1e-12);
  assert.ok(Math.abs(forward - reverse) < 1e-12);
});

test('page bridge maintains the two-stage Integrated LUFS gate incrementally', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;

  const blocks = [0.01, 1.0, 0.001];
  for (const ms of blocks) harness.emitMeasurementBlock(ms);

  const measurements = harness.messages.filter((message) => message.event === 'lufs');
  assert.equal(measurements.length, 3);
  for (let i = 0; i < blocks.length; i++) {
    const expected = u.gatedIntegratedLufs(blocks.slice(0, i + 1));
    assert.ok(Math.abs(measurements[i].integrated - expected) < 1e-12);
  }
  const expected = u.gatedIntegratedLufs(blocks);

  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.at(-1).integrated, expected);

  await harness.dispatchCommand('setAdActive', { active: false });
  await harness.dispatchCommand('resetMeasurement');
  harness.emitMeasurementBlock(0.25);
  assert.equal(harness.messages.at(-1).integrated, u.meanSquareToLufs(0.25));
});

test('page bridge applies the Integrated absolute boundary and re-evaluates the relative gate', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const absoluteGateMeanSquare = Math.pow(10, (-70 + 0.691) / 10);

  harness.emitMeasurementBlock(NaN);
  harness.emitMeasurementBlock(absoluteGateMeanSquare * (1 - 1e-6));
  harness.emitMeasurementBlock(absoluteGateMeanSquare);

  let measurements = harness.messages.filter((message) => message.event === 'lufs');
  assert.equal(measurements.length, 2);
  assert.equal(measurements[0].integrated, -Infinity);
  assert.ok(Math.abs(measurements[1].integrated - (-70)) < 1e-12);

  await harness.dispatchCommand('resetMeasurement');
  harness.messages.length = 0;
  const relativeBlocks = [1.0, 0.1, 0.055 * (1 - 1e-6)];
  for (const ms of relativeBlocks) harness.emitMeasurementBlock(ms);

  measurements = harness.messages.filter((message) => message.event === 'lufs');
  for (let i = 0; i < relativeBlocks.length; i++) {
    const expected = u.gatedIntegratedLufs(relativeBlocks.slice(0, i + 1));
    assert.ok(Math.abs(measurements[i].integrated - expected) < 1e-12);
  }
});

test('page bridge indexed gate matches the array oracle across varied blocks', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const blocks = [];
  let randomState = 0x12345678;

  for (let i = 0; i < 200; i++) {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    const lufs = -80 + (randomState / 0xffffffff) * 80;
    const ms = Math.pow(10, (lufs + 0.691) / 10);
    blocks.push(ms);
    harness.emitMeasurementBlock(ms);
    const actual = harness.messages.at(-1).integrated;
    const expected = u.gatedIntegratedLufs(blocks);
    if (expected === -Infinity) assert.equal(actual, -Infinity);
    else assert.ok(Math.abs(actual - expected) < 1e-10);
  }
});

test('page bridge indexed gate evicts the oldest block at the retained-window limit', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const maximumBlocks = 60 * 60 * 10;
  const retainedBlocks = [];
  let randomState = 0x87654321;

  for (let i = 0; i < 128; i++) {
    randomState = (Math.imul(randomState, 1103515245) + 12345) >>> 0;
    harness.emitMeasurementBlock(0.01 + randomState / 0xffffffff);
  }
  for (let i = 0; i < maximumBlocks; i++) {
    const ms = 0.01 + i / maximumBlocks;
    retainedBlocks.push(ms);
    harness.emitMeasurementBlock(ms);
    if (harness.messages.length > 1000) harness.messages.length = 0;
  }

  const actual = harness.messages.at(-1).integrated;
  const expected = u.gatedIntegratedLufs(retainedBlocks);
  assert.ok(Math.abs(actual - expected) < 1e-10);
});

test('page bridge uses saved LUFS as the initial Integrated mean', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const savedLufs = -20;
  const nextMeanSquare = 0.1;

  await harness.dispatchCommand('resetMeasurement', {
    initialIntegratedLufs: savedLufs
  });
  harness.emitMeasurementBlock(nextMeanSquare);

  const savedMeanSquare = Math.pow(10, (savedLufs + 0.691) / 10);
  const expected = u.meanSquareToLufs((savedMeanSquare + nextMeanSquare) / 2);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - expected) < 1e-12);
});

test('page bridge stamps posted measurements with the reset epoch', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.emitMeasurementBlock(0.1);
  assert.equal(harness.messages.at(-1).epoch, 0);

  await harness.dispatchCommand('resetMeasurement', { epoch: 7 });
  harness.emitMeasurementBlock(0.1);
  assert.equal(harness.messages.at(-1).epoch, 7);

  await harness.dispatchCommand('resetMeasurement');
  harness.emitMeasurementBlock(0.1);
  assert.equal(harness.messages.at(-1).epoch, 7);
});

test('page bridge ignores invalid saved LUFS initial values', async () => {
  const invalidValues = [
    undefined, null, '-20', NaN, Infinity, -Infinity, -70 - 1e-6, Number.MAX_VALUE
  ];
  for (const initialIntegratedLufs of invalidValues) {
    const harness = createPageBridgeHarness();
    await harness.startMeasurement();
    harness.messages.length = 0;
    await harness.dispatchCommand('resetMeasurement', { initialIntegratedLufs });
    harness.emitMeasurementBlock(0.25);
    assert.equal(harness.messages.at(-1).integrated, u.meanSquareToLufs(0.25));
  }

  const boundaryHarness = createPageBridgeHarness();
  await boundaryHarness.startMeasurement();
  boundaryHarness.messages.length = 0;
  await boundaryHarness.dispatchCommand('resetMeasurement', { initialIntegratedLufs: -70 });
  boundaryHarness.emitMeasurementBlock(0);
  assert.ok(Math.abs(boundaryHarness.messages.at(-1).integrated - (-70)) < 1e-12);
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
