// test.js — Pure utility tests. Run with `node test.js`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
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

// Repo-root directories that hold session artifacts rather than extension
// files. pack.py keeps them out of the store package too.
const SCRATCH_DIRS = new Set(['work', '.claude']);

function withFixtureDir(prefix, body) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!fs.existsSync(dir), `${dir} was left behind`);
}

// This project's own rule, not the browser's: no underscore-prefixed name
// outside `_locales`, and no Python leftovers, anywhere in the tree the
// package is built from. Chrome refuses an unpacked extension only for an
// underscore name at the root and takes one deeper in, so the names below the
// root are reported here as junk in the tree rather than as a load failure.
function forbiddenNamesUnder(root) {
  const forbidden = [];
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const nextRelative = path.join(relative, entry.name);
      if (SCRATCH_DIRS.has(nextRelative)) continue;
      const allowedLocaleDirectory = nextRelative === '_locales';
      if ((entry.name.startsWith('_') && !allowedLocaleDirectory) || entry.name.endsWith('.pyc')) {
        forbidden.push(nextRelative);
        continue;
      }
      if (entry.isDirectory()) walk(path.join(directory, entry.name), nextRelative);
    }
  }
  walk(root);
  return forbidden;
}

test('extension tree keeps out underscore names and build leftovers', () => {
  assert.deepEqual(forbiddenNamesUnder(__dirname), []);
});

test('every packaged path is one the extension loads', () => {
  const listed = spawnSync('python3', ['-B', 'pack.py', '--list'], {
    cwd: __dirname,
    encoding: 'utf8'
  });
  assert.equal(listed.status, 0, listed.stderr);
  const packaged = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  assert.ok(packaged.includes('manifest.json'));
  assert.ok(!packaged.includes('test.js'));

  // Read independently of pack.py's own parsing: every packaged script or page
  // is named by the manifest, by a page the manifest names, or by the worker.
  const references = ['manifest.json', 'popup.html', 'options.html', 'background.js']
    .map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8'))
    .join('\n');
  for (const arcname of packaged) {
    const segments = arcname.split(path.sep);
    if (segments.length === 1) {
      if (arcname === 'manifest.json') continue;
      assert.match(arcname, /\.(js|html)$/, `${arcname} is not a script or a page`);
      assert.ok(references.includes(arcname), `${arcname} is packaged but nothing loads it`);
      continue;
    }
    const shipped =
      (segments[0] === 'icons' && segments.length === 2 && arcname.endsWith('.png')) ||
      (segments[0] === '_locales' && segments.length === 3 && segments[2] === 'messages.json');
    assert.ok(shipped, `${arcname} is not a path the extension loads`);
  }
});

test('the scratch roots are ignored at the root and no deeper', () => {
  const ignored = fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  for (const name of SCRATCH_DIRS) {
    // The walk above skips these by root path, so a directory of the same name
    // that the extension ships has to stay visible to git as well.
    assert.ok(ignored.includes(`/${name}/`), `${name} is ignored at the root`);
    assert.ok(!ignored.includes(`${name}/`), `${name} is not ignored deeper in the tree`);
  }
});

test('the forbidden-name walk skips the scratch roots and nothing else', () => {
  // Named here because the fixture below is built from this set: dropping an
  // entry would otherwise pass by leaving nothing to skip.
  assert.deepEqual([...SCRATCH_DIRS].sort(), ['.claude', 'work']);

  // The repo tree carries no scratch directory, so the skip is exercised on a
  // fixture: without one, removing it changes no result here.
  withFixtureDir('tcv-walk-', (fixture) => {
    const write = (relative) => {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'x');
    };
    write('manifest.json');
    write('_locales/ja/messages.json');
    for (const name of SCRATCH_DIRS) write(path.join(name, 'session', '_metadata', 'note.txt'));
    write('_stray/file.txt');
    write('icons/_cache/icon.png');
    write('__pycache__/pack.cpython-313.pyc');
    // The skip is by root path, not by name: a directory the extension ships
    // keeps its contents checked whatever it is called.
    write(path.join('icons', 'work', '_metadata', 'deep.txt'));

    assert.deepEqual(forbiddenNamesUnder(fixture).sort(), [
      '__pycache__',
      '_stray',
      path.join('icons', '_cache'),
      path.join('icons', 'work', '_metadata')
    ]);
  });
});

test('the store package carries only the files the extension loads', () => {
  // pack.py runs for real here: a declaration read out of its source would
  // still pass with the selection that uses it deleted.
  withFixtureDir('tcv-pack-', (fixture) => {
    const write = (relative, body = 'x') => {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    write('manifest.json', JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      content_scripts: [{ js: ['utils.js', 'content.js'] }],
      web_accessible_resources: [{ resources: ['audio-worklet.js'] }],
      background: { service_worker: 'background.js' },
      action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon16.png' } }
    }));
    write('utils.js');
    write('content.js');
    write('audio-worklet.js');
    write('background.js', "importScripts('channel-store.js');\n");
    write('channel-store.js');
    write('popup.html', '<script src="utils.js"></script>\n<script src="popup.js"></script>\n');
    write('popup.js');
    write('icons/icon16.png');
    write('_locales/ja/messages.json', '{}');

    // Nothing references these, whatever their extension says.
    write('review-probe.js');
    write('notes.html', '<p>notes</p>');
    write('.env', 'TOKEN=secret');
    write('review-notes.txt');
    write('README.md');
    write('gen_icons.py');
    write('test.js');
    write('twitch-channel-volume-1.0.0.zip');
    write('.git', 'gitdir: /elsewhere');
    write('icons/source.svg');
    write('_locales/ja/notes.txt');
    write('docs/security-audit.md');
    write('node_modules/_cache/index.js');
    fs.symlinkSync(path.join(fixture, 'content.js'), path.join(fixture, 'linked.js'));
    for (const name of SCRATCH_DIRS) write(path.join(name, 'session', '_metadata', 'note.txt'));
    fs.copyFileSync(path.join(__dirname, 'pack.py'), path.join(fixture, 'pack.py'));

    const listed = spawnSync('python3', ['-B', 'pack.py', '--list'], {
      cwd: fixture,
      encoding: 'utf8'
    });
    assert.equal(listed.status, 0, listed.stderr);
    const packaged = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(packaged.sort(), [
      '_locales/ja/messages.json',
      'audio-worklet.js',
      'background.js',
      'channel-store.js',
      'content.js',
      'icons/icon16.png',
      'manifest.json',
      'popup.html',
      'popup.js',
      'utils.js'
    ]);
  });
});

test('the store package refuses a reference that leaves it', () => {
  // A path that resolves outside the package would carry a file nobody
  // reviewed into the store zip under a name that looks local.
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const outside = fs.mkdtempSync(path.join(tmpRoot, 'tcv-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'SECRET');
  fs.writeFileSync(path.join(outside, 'messages.json'), '{}');

  const run = (build) => {
    let result;
    // The package sits one level down: a case that reaches outside it with ..
    // writes into its own parent, never into the shared temp root.
    withFixtureDir('tcv-escape-', (parent) => {
      const fixture = path.join(parent, 'package');
      fs.mkdirSync(fixture);
      fs.copyFileSync(path.join(__dirname, 'pack.py'), path.join(fixture, 'pack.py'));
      build(fixture);
      result = spawnSync('python3', ['-B', 'pack.py', '--list'], { cwd: fixture, encoding: 'utf8' });
    });
    return result;
  };
  const manifest = (references) => JSON.stringify({
    manifest_version: 3,
    version: '1.0.0',
    content_scripts: [{ js: references }]
  });

  try {
    // A symlinked parent directory: only the last name looks local.
    const throughParent = run((fixture) => {
      fs.writeFileSync(path.join(fixture, 'manifest.json'), manifest(['linked/secret.js']));
      fs.symlinkSync(outside, path.join(fixture, 'linked'));
    });
    assert.notEqual(throughParent.status, 0);
    assert.match(throughParent.stderr, /linked\/secret\.js/);

    const climbing = run((fixture) => {
      fs.writeFileSync(path.join(fixture, 'manifest.json'), manifest(['../secret.js']));
      const sibling = path.join(path.dirname(fixture), 'secret.js');
      // The climb has to land inside this case's own directory.
      assert.ok(sibling.startsWith(fs.realpathSync(tmpRoot) + path.sep));
      assert.notEqual(path.dirname(sibling), fs.realpathSync(tmpRoot));
      fs.writeFileSync(sibling, 'SIBLING');
    });
    assert.notEqual(climbing.status, 0);

    // Absolute and pointing at a path with no link anywhere in it: the only
    // thing standing between it and the zip is the rule against absolute paths.
    assert.equal(fs.realpathSync(outside), outside);
    const absolute = run((fixture) => {
      fs.writeFileSync(
        path.join(fixture, 'manifest.json'),
        manifest([path.join(outside, 'secret.js')])
      );
    });
    assert.notEqual(absolute.status, 0);
    assert.match(absolute.stderr, /secret\.js/);

    // The locale directories are listed rather than referenced, and one of
    // them can be a link just as easily.
    const linkedLocaleDir = run((fixture) => {
      fs.writeFileSync(path.join(fixture, 'manifest.json'), manifest([]));
      fs.mkdirSync(path.join(fixture, '_locales'));
      fs.symlinkSync(outside, path.join(fixture, '_locales', 'ja'));
    });
    assert.notEqual(linkedLocaleDir.status, 0);
    assert.match(linkedLocaleDir.stderr, /_locales\/ja\/messages\.json/);

    const linkedLocaleRoot = run((fixture) => {
      fs.writeFileSync(path.join(fixture, 'manifest.json'), manifest([]));
      fs.symlinkSync(outside, path.join(fixture, '_locales'));
    });
    assert.notEqual(linkedLocaleRoot.status, 0);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the store package refuses a reference it cannot pack', () => {
  withFixtureDir('tcv-pack-missing-', (fixture) => {
    fs.writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      content_scripts: [{ js: ['content.js'] }]
    }));
    fs.copyFileSync(path.join(__dirname, 'pack.py'), path.join(fixture, 'pack.py'));

    // A zip built around a missing file is a broken extension, not a smaller one.
    const missing = spawnSync('python3', ['-B', 'pack.py', '--list'], {
      cwd: fixture,
      encoding: 'utf8'
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /content\.js/);

    // A referenced symlink resolves outside the package: it is not packed
    // silently in place of the file it points at.
    fs.writeFileSync(path.join(fixture, 'elsewhere.js'), '//');
    fs.symlinkSync(path.join(fixture, 'elsewhere.js'), path.join(fixture, 'content.js'));
    const linked = spawnSync('python3', ['-B', 'pack.py', '--list'], {
      cwd: fixture,
      encoding: 'utf8'
    });
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /content\.js/);

    // The locale files are found rather than referenced, and get the same rule.
    fs.unlinkSync(path.join(fixture, 'content.js'));
    fs.writeFileSync(path.join(fixture, 'content.js'), '//');
    fs.mkdirSync(path.join(fixture, '_locales', 'ja'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'messages-elsewhere.json'), '{}');
    fs.symlinkSync(
      path.join(fixture, 'messages-elsewhere.json'),
      path.join(fixture, '_locales', 'ja', 'messages.json')
    );
    const linkedLocale = spawnSync('python3', ['-B', 'pack.py', '--list'], {
      cwd: fixture,
      encoding: 'utf8'
    });
    assert.notEqual(linkedLocale.status, 0);
    assert.match(linkedLocale.stderr, /messages\.json/);
  });
});

async function flushTasks(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function cssRule(css, selector) {
  const escaped = selector.replace(/[.:]/g, (c) => '\\' + c);
  const rule = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}', 's'));
  assert.ok(rule, `${selector} rule is still declared`);
  return rule[1];
}

function cssColor(css, selector, property) {
  // `border-color` also ends in "color:", so require a non-hyphen before it.
  const pattern = property === 'color'
    ? /(?:^|[^-])color:\s*#([0-9a-f]{3,6})/i
    : /background(?:-color)?:\s*#([0-9a-f]{3,6})/i;
  const hex = cssRule(css, selector).match(pattern);
  assert.ok(hex, `${selector} still declares ${property}`);
  const full = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function contrastRatio(fg, bg) {
  const luminance = (rgb) => rgb
    .map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4)))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  return (Math.max(luminance(fg), luminance(bg)) + 0.05) /
    (Math.min(luminance(fg), luminance(bg)) + 0.05);
}

function assertContrastFloor(css, pairs, floor) {
  for (const [selector, panel] of pairs) {
    const ratio = contrastRatio(
      cssColor(css, selector, 'color'),
      cssColor(css, panel, 'background')
    );
    assert.ok(ratio >= floor, `${selector} on ${panel} contrast ${ratio.toFixed(2)} < ${floor}`);
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
        ...(Number.isFinite(autoGain)
          ? { autoGainVod: autoGain, autoGainRef: { vod: u.LUFS_REFERENCE_VOLUME_1 } }
          : {})
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
  // Indicator elements have identity: a route change has to tell the one the
  // page is leaving from the one that replaces it.
  let adNodes = [];
  let lastRemovedAdNode = null;
  let pushStateEffect = null;
  const makeAdNode = () => ({ isConnected: true });
  const observerCallbacks = [];
  // The player's volume row: the gain badge is inserted next to the slider.
  const volumeRow = {
    children: new Set(),
    removeChild(node) {
      volumeRow.children.delete(node);
      node.parentNode = null;
      node.previousElementSibling = null;
    }
  };
  const sliderContainer = {
    parentElement: volumeRow,
    insertAdjacentElement(position, node) {
      assert.equal(position, 'afterend');
      volumeRow.children.add(node);
      node.parentNode = volumeRow;
      node.previousElementSibling = sliderContainer;
    }
  };
  const document = {
    documentElement: {},
    querySelector(selector) {
      const text = String(selector);
      if (text.includes('video-ad-countdown')) return adNodes[0] || null;
      if (text.includes('volume-slider__slider-container')) return sliderContainer;
      return null;
    },
    querySelectorAll(selector) {
      return String(selector).includes('video-ad-countdown') ? adNodes.slice() : [];
    },
    createElement() {
      return { style: { cssText: '' }, textContent: '', parentNode: null, previousElementSibling: null };
    },
    addEventListener() {},
    contains(node) { return volumeRow.children.has(node); }
  };
  class MutationObserver {
    constructor(callback) { observerCallbacks.push(callback); }
    observe() {}
  }
  class HarnessDate extends Date {
    static now() { return currentTimeMs; }
  }
  const history = {
    pushState(_state, _unused, url) {
      if (url) location.href = new URL(url, location.href).href;
      // What the page can do in the same task as the route change, before the
      // extension's microtask gets its turn.
      const effect = pushStateEffect;
      pushStateEffect = null;
      if (effect) effect();
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
    setAdNodePresent(present) {
      for (const node of adNodes) node.isConnected = false;
      if (adNodes.length) lastRemovedAdNode = adNodes[0];
      adNodes = present ? [makeAdNode()] : [];
    },
    replaceAdNode() {
      // What one observer callback can carry: the old element out, a new one in.
      for (const node of adNodes) node.isConnected = false;
      if (adNodes.length) lastRemovedAdNode = adNodes[0];
      adNodes = [makeAdNode()];
    },
    // The player shows a countdown and a banner at once part-way through an ad.
    addAdNode() {
      adNodes.push(makeAdNode());
    },
    reuseAdNode() {
      // A framework can put the element it took out back, rather than build one.
      assert.ok(lastRemovedAdNode, 'no indicator has been taken out');
      lastRemovedAdNode.isConnected = true;
      adNodes = [lastRemovedAdNode];
    },
    gainBadgeText() {
      const [badge] = volumeRow.children;
      return badge ? badge.textContent : null;
    },
    gainBadgeCount() { return volumeRow.children.size; },
    mutate() { for (const callback of observerCallbacks) callback([]); },
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
    async navigate(href, duringPushState) {
      pushStateEffect = duringPushState || null;
      history.pushState({}, '', href);
      await flushTasks(8);
    },
    // A route change the extension does not hook, so only the observer sees it.
    setHref(href) {
      location.href = new URL(href, location.href).href;
    },
    async replaceState(href) {
      history.replaceState({}, '', href);
      await flushTasks(8);
    },
    // A back or forward step. `beforeListener` stands for a listener of the
    // page's own, registered ahead of the extension's.
    async popstate(href, beforeListener) {
      location.href = new URL(href, location.href).href;
      if (beforeListener) beforeListener();
      for (const listener of listeners.popstate || []) listener();
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

function stubElement(id) {
  const classes = new Set();
  const listeners = {};
  const element = {
    id,
    listeners,
    disabled: false,
    checked: false,
    value: '',
    title: '',
    textContent: '',
    offsetWidth: 0,
    style: {},
    attributes: {},
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    },
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
    get innerHTML() { return element.textContent; },
    set innerHTML(value) { element.textContent = String(value); },
    appendChild(node) {
      element.textContent += node.textContent || '';
      return node;
    },
    // The stub holds text, never child nodes, so a lookup inside it finds none.
    querySelectorAll() { return []; },
    getAttribute(name) { return name in element.attributes ? element.attributes[name] : null; },
    setAttribute(name, value) { element.attributes[name] = value; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); }
  };
  return element;
}


function createOptionsHarness({
  settings = {},
  channelVolumes = {},
  deferStorage = false,
  failStorage = false,
  failMutation = false
} = {}) {
  const messages = JSON.parse(
    fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json'), 'utf8')
  );
  const elements = new Map();
  const unitButtons = ['%', 'dB'].map((unit) => {
    const button = stubElement(`unit-${unit}`);
    button.setAttribute('data-unit', unit);
    return button;
  });
  const i18nNodes = i18nKeysInOrder(
    fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8')
  ).map((key) => {
    const node = stubElement('');
    node.setAttribute('data-i18n', key);
    return node;
  });
  const sent = [];
  const stored = {
    [u.SETTINGS_KEY]: { targetLufs: -18, adGainDb: -6, displayUnit: '%', showGainOverlay: true, ...settings },
    [u.CHANNEL_VOLUMES_KEY]: channelVolumes
  };

  function element(id) {
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  }

  const body = stubElement('body');
  // What options.html ships. The page stays hidden until the load renders, the
  // error line stays out of the layout, the channel table and its empty-list
  // message stay out until the render that counts the channels, and the overlay
  // toggle carries the default the settings are installed with. Each one is the
  // value a write has to move, so a test that reads it is falsifiable.
  body.className = 'initializing';
  element('settingsError').className = 'settings-error hidden';
  element('emptyMsg').style.display = 'none';
  element('select:.channel-table').style.display = 'none';
  element('overlayToggle').checked = true;
  const document = {
    body,
    getElementById: element,
    createElement: () => stubElement(''),
    createTextNode: (text) => ({ textContent: text }),
    querySelector: (selector) => element('select:' + selector),
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return i18nNodes;
      if (selector === '#unitToggle button') return unitButtons;
      return [];
    }
  };

  const storageListeners = [];
  const timers = [];
  let resolveStorageGet = null;
  const storageGate = deferStorage
    ? new Promise((resolve) => { resolveStorageGet = resolve; })
    : Promise.resolve();

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          await storageGate;
          if (failStorage) throw new Error('storage unavailable');
          return readStoredKeys(stored, keys);
        }
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    runtime: {
      async sendMessage(message) {
        sent.push(structuredClone(message));
        if (failMutation) throw new Error('service worker unavailable');
        return { ok: true };
      }
    }
  };

  const context = vm.createContext({
    ...u,
    msg: (key, substitutions) => {
      assert.ok(messages[key], `msg('${key}') has no message`);
      const text = messages[key].message;
      return substitutions && substitutions.length ? text.replace('$VALUE$', substitutions[0]) : text;
    },
    chrome,
    document,
    // utils.js escapes by writing the text into an element and reading its
    // markup back; the stub has no serializer, so the harness escapes the
    // characters that one would.
    esc: (value) => String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    console: { warn() {}, error() {}, info() {} },
    requestAnimationFrame(callback) { callback(); },
    // Held, not run: the page arms one to end a load that never answers, and
    // a stub that fires it at once ends every load in the suite.
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    structuredClone
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8'),
    context,
    { filename: 'options.js' }
  );

  return {
    el: element,
    body,
    i18nNodes,
    unitButtons,
    sent,
    timers,
    fireTimers() {
      for (const timer of timers.splice(0)) timer.callback();
    },
    fireStorageChanged(changes) {
      for (const listener of storageListeners) listener(changes);
    },
    releaseStorage() {
      assert.ok(resolveStorageGet, 'the storage read is not pending');
      resolveStorageGet();
      resolveStorageGet = null;
    },
    message: (key) => (messages[key] ? messages[key].message : key)
  };
}

function createPopupHarness({
  state = {},
  displayUnit = '%',
  deferAutoSave = false,
  failGainSave = false
} = {}) {
  const messages = JSON.parse(
    fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json'), 'utf8')
  );
  const elements = new Map();
  const presetButtons = [];
  const sent = [];
  const intervals = [];
  let resolveAutoSave;
  let currentState = {
    channel: { id: '123', name: 'somechannel', kind: 'live', url: 'https://www.twitch.tv/somechannel' },
    lufs: { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity },
    hasSavedMeasurement: false,
    gain: 1.5,
    adActive: false,
    audioUnavailable: false,
    measurementUnavailable: false,
    targetLufs: -18,
    adGainDb: -6,
    autoApplyLoudness: false,
    ...state
  };

  function element(id) {
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  }

  for (const percent of [0, 50, 100, 200, 400, 600]) {
    const button = stubElement(`preset-${percent}`);
    button.setAttribute('data-gain', String(percent));
    presetButtons.push(button);
  }

  const i18nNodes = i18nKeysInOrder(
    fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8')
  ).map((key) => {
    const node = stubElement('');
    node.setAttribute('data-i18n', key);
    return node;
  });

  const document = {
    body: stubElement('body'),
    getElementById: element,
    createElement: () => stubElement(''),
    createTextNode: (text) => ({ textContent: text }),
    querySelectorAll(selector) {
      if (selector === '.presets button') return presetButtons;
      if (selector === '[data-i18n]') return i18nNodes;
      return [];
    }
  };

  const chrome = {
    tabs: {
      async query() { return [{ id: 1, url: 'https://www.twitch.tv/somechannel' }]; },
      async sendMessage(_tabId, request) {
        sent.push(structuredClone(request));
        if (request.cmd === 'getState') return structuredClone(currentState);
        if (request.cmd === 'setGain' && failGainSave) {
          return { ok: false, reason: 'storage update failed' };
        }
        if (request.cmd === 'setAutoApplyLoudness') {
          if (deferAutoSave) await new Promise((resolve) => { resolveAutoSave = resolve; });
          currentState = { ...currentState, autoApplyLoudness: !!request.enabled };
          return { ok: true, autoApplyLoudness: !!request.enabled, gain: currentState.gain };
        }
        return { ok: true };
      }
    },
    storage: {
      local: { async get() { return { [u.SETTINGS_KEY]: { displayUnit } }; } },
      onChanged: { addListener() {} }
    },
    runtime: { openOptionsPage() {} }
  };

  const context = vm.createContext({
    ...u,
    msg: (key, substitutions) => {
      // A key the locale does not declare reaches the viewer as its own name.
      // Refusing it here covers every path these tests run, including the ones
      // no static scan can name.
      assert.ok(messages[key], `msg('${key}') has no message`);
      const text = messages[key].message;
      return substitutions && substitutions.length
        ? text.replace('$VALUE$', substitutions[0])
        : text;
    },
    chrome,
    document,
    console: { warn() {}, error() {}, info() {} },
    requestAnimationFrame(callback) { callback(); },
    setInterval(callback) { return intervals.push(callback); },
    structuredClone
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'),
    context,
    { filename: 'popup.js' }
  );

  return {
    el: element,
    presets: presetButtons,
    i18nNodes,
    sent,
    message: (key, substitutions) => {
      const text = messages[key] ? messages[key].message : key;
      return substitutions && substitutions.length
        ? text.replace('$VALUE$', substitutions[0])
        : text;
    },
    setState(next) { currentState = { ...currentState, ...next }; },
    async poll() {
      for (const callback of intervals) await callback();
      await flushTasks(8);
    },
    async fire(id, type) {
      for (const listener of element(id).listeners[type] || []) await listener({ target: element(id) });
      await flushTasks(8);
    },
    async firePreset(index, type) {
      for (const listener of presetButtons[index].listeners[type] || []) await listener({ target: presetButtons[index] });
      await flushTasks(8);
    },
    async releaseAutoSave() {
      assert.ok(resolveAutoSave, 'auto save is not pending');
      resolveAutoSave();
      resolveAutoSave = null;
      await flushTasks(8);
    }
  };
}

// BS.1770-4 gates 400ms blocks overlapping by 75%: one window per 100ms
// sub-block, formed from the four most recent sub-blocks.
function gatingWindows(subBlocks) {
  const windows = [];
  for (let i = 3; i < subBlocks.length; i++) {
    windows.push((subBlocks[i - 3] + subBlocks[i - 2] + subBlocks[i - 1] + subBlocks[i]) / 4);
  }
  return windows;
}

// Entering an ad removes up to this many of the most recent windows: the DOM
// marker appears after the ad's first audio.
const AD_START_ROLLBACK = 5;
const ROLLBACK_LOG_SAMPLES = 8;

function assertLufsClose(actual, expected) {
  if (expected === -Infinity) assert.equal(actual, -Infinity);
  else assert.ok(Math.abs(actual - expected) < 1e-12);
}

function expectedIntegrated(subBlocks, seedMeanSquare) {
  const values = gatingWindows(subBlocks);
  if (seedMeanSquare !== undefined) values.unshift(seedMeanSquare);
  return u.gatedIntegratedLufs(values);
}

// Saved measurements carry the reference they were taken at.
function measured(lastLufs, windows) {
  return {
    lastLufs,
    lastLufsRef: Object.fromEntries(
      Object.keys(lastLufs).map((kind) => [kind, u.LUFS_REFERENCE_VOLUME_1])
    ),
    ...(windows === undefined ? {} : {
      lastLufsWindows: Object.fromEntries(
        Object.keys(lastLufs).map((kind) => [kind, windows])
      )
    })
  };
}

const BRIDGE_SCRIPT_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page-bridge.js';

function createPageBridgeHarness({
  scriptUrl = BRIDGE_SCRIPT_URL,
  mediaElementSourceTaken = false,
  extraFreeVideo = false,
  audioContextThrows = false,
  workletLoadFails = false,
  deferWorkletLoad = false,
  frozenWorker = false
} = {}) {
  const messages = [];
  // Real ids: a loop that was cancelled has to stop running here too, or a
  // bridge that gave up looks the same as one that keeps trying.
  const timers = new Map();
  let nextTimerId = 0;
  let contextThrows = audioContextThrows;
  const logs = [];
  const workletModules = [];
  const listeners = {};
  const location = { href: 'https://www.twitch.tv/videos/100' };
  const videos = [];
  const makeVideo = (props = {}) => {
    const listeners = {};
    return {
      src: 'https://example.test/video',
      readyState: 4,
      clientWidth: 1920,
      clientHeight: 1080,
      isConnected: true,
      volume: 1,
      muted: false,
      paused: false,
      currentTime: 0,
      buffered: { length: 0, start() { return 0; }, end() { return 0; } },
      listeners,
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
      ...props
    };
  };
  const fire = (element, type) => {
    for (const fn of element.listeners[type] || []) fn();
  };
  let video = makeVideo();
  videos.push(video);
  const freeVideo = makeVideo({
    src: 'https://example.test/free-video',
    clientWidth: 320,
    clientHeight: 180
  });
  if (extraFreeVideo) videos.push(freeVideo);
  const workerCalls = [];
  const workerListeners = [];
  class TestWorker {
    constructor(url, options) { workerCalls.push({ url, options }); }
    addEventListener(type, listener) { workerListeners.push({ type, listener }); }
  }
  let measurementPort;
  const fetchCalls = [];
  const pendingFetches = [];
  let resolveWorkletLoad;
  let mediaSourceCalls = 0;
  let gainNode;
  const audioNode = () => ({
    connect() {},
    disconnect() { this.disconnected = true; }
  });
  const gainNodes = [];
  const sourcedElements = [];
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
      if (contextThrows) throw new DOMException('too many contexts', 'NotSupportedError');
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = {
        addModule: async (url) => {
          if (deferWorkletLoad) await new Promise((resolve) => { resolveWorkletLoad = resolve; });
          if (workletLoadFails) throw new Error('worklet module blocked');
          workletModules.push(url);
        }
      };
    }
    createGain() {
      const node = {
        ...audioNode(),
        gain: {
          value: 1,
          setTargetAtTime(value) { node.gain.value = value; }
        }
      };
      // The first gain of a context is the output gain; the measurement chain
      // builds a silent one after it.
      if (!this.outputGain) {
        this.outputGain = node;
        gainNode = node;
      }
      gainNodes.push(node);
      return node;
    }
    createIIRFilter() { return audioNode(); }
    createMediaElementSource(element) {
      mediaSourceCalls += 1;
      // What Chrome throws once another AudioContext holds the element.
      if (mediaElementSourceTaken && element === video) {
        throw new DOMException('HTMLMediaElement already connected', 'InvalidStateError');
      }
      sourcedElements.push(element);
      return audioNode();
    }
    async resume() {}
  }
  const window = {
    AudioContext,
    Worker: TestWorker,
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    fetch(...args) {
      fetchCalls.push(args);
      return new Promise((resolve) => { pendingFetches.push(resolve); });
    },
    postMessage(message) {
      messages.push(structuredClone(message));
    }
  };
  if (frozenWorker) {
    Object.defineProperty(window, 'Worker', { value: TestWorker, writable: false, configurable: false });
  }
  const context = vm.createContext({
    AudioWorkletNode,
    clearInterval(id) { timers.delete(id); },
    console: { warn() {}, error() {}, info(...args) { logs.push(args); } },
    document: {
      querySelectorAll(selector) { return selector === 'video' ? videos : []; }
    },
    DOMException,
    location,
    setInterval(callback) {
      nextTimerId += 1;
      timers.set(nextTimerId, callback);
      return nextTimerId;
    },
    URL,
    window
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'page-bridge.js'), 'utf8'),
    context,
    { filename: scriptUrl }
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
    logs,
    workletModules,
    fetch: (...args) => window.fetch(...args),
    fetchCalls,
    resolveFetch(response) {
      assert.ok(pendingFetches.length, 'no request is waiting for a response');
      for (const resolve of pendingFetches.splice(0)) resolve(response);
    },
    async startMeasurement() {
      await dispatchCommand('init');
      await dispatchCommand('attach');
      assert.equal(typeof measurementPort?.onmessage, 'function');
    },
    dispatchCommand,
    async runTimers() {
      for (const callback of [...timers.values()]) await callback();
      await flushTasks();
    },
    disconnectTakenVideo() { video.isConnected = false; },
    allowAudioContext() { contextThrows = false; },
    mediaSourceCalls() { return mediaSourceCalls; },
    gainValue() { return gainNode ? gainNode.gain.value : null; },
    async releaseWorkletLoad() {
      assert.ok(resolveWorkletLoad, 'the worklet load is not pending');
      resolveWorkletLoad();
      resolveWorkletLoad = null;
      await flushTasks(8);
    },
    emitMeasurementBlock(ms) {
      measurementPort.onmessage({ data: { ms } });
    },
    setVolume(value) {
      video.volume = value;
      fire(video, 'volumechange');
    },
    setMuted(value) {
      video.muted = value;
      fire(video, 'volumechange');
    },
    setPlayhead(currentTime) {
      video.currentTime = currentTime;
    },
    createWorker(url, options) { return new context.window.Worker(url, options); },
    workerCalls,
    workerListeners,
    gainNodes,
    sourcedElements,
    videos,
    emitPlayerCue(cue) {
      // The cue reaches the bridge through the worker the player creates.
      if (!workerListeners.length) new context.window.Worker('blob:https://www.twitch.tv/player');
      for (const entry of workerListeners) {
        if (entry.type === 'message') entry.listener({ data: { arg: cue } });
      }
    },
    setPaused(value) { video.paused = value; },
    currentVideo: () => video,
    addVideo(props = {}) {
      const extra = makeVideo({ src: 'https://ads.example/creative.mp4', ...props });
      videos.push(extra);
      return extra;
    },
    removeVideo(element) {
      element.isConnected = false;
      videos.splice(videos.indexOf(element), 1);
    },
    async replaceVideo() {
      // A replacement is a different element, which is why a source can be made
      // for it at all.
      const next = makeVideo({ volume: video.volume, muted: video.muted });
      video.isConnected = false;
      videos.splice(videos.indexOf(video), 1, next);
      video = next;
      await dispatchCommand('attach');
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

test('resolvePreferredGain ignores an Auto gain measured at an unknown volume', () => {
  const entry = { autoApplyLoudnessLive: true, autoGainLive: 2.5 };
  assert.equal(u.resolvePreferredGain(entry, 'live', false, -Infinity, -18).gain, 1.0);

  const referenced = { ...entry, autoGainRef: { live: u.LUFS_REFERENCE_VOLUME_1 } };
  assert.equal(u.resolvePreferredGain(referenced, 'live', false, -Infinity, -18).gain, 2.5);

  // A running measurement always wins over the saved value.
  const live = u.resolvePreferredGain(referenced, 'live', false, -23, -18).gain;
  assert.ok(Math.abs(live - u.calcGain(-23, -18)) < 1e-12);

  // The viewer's own manual gain is still honoured when no Auto gain applies.
  const manual = { ...entry, gainLive: 2.0 };
  assert.equal(u.resolvePreferredGain(manual, 'live', false, -Infinity, -18).gain, 2.0);
});

// Where the localized strings are checked, and what each check is worth.
//
// Reading JavaScript well enough to name every call site needs a parser, and
// a hand-written one keeps meeting the language: comments, then strings,
// templates and regular expressions, then `x.msg(`, `of`, a local named msg.
// So the checks below do not try. The two that have to be right are decided
// by running the pages, and the text search that remains is only asked
// whether a translation is mentioned at all.

// Raw text and escapable raw text: what is inside is characters, not markup.
// (HTML parsing spec, tokenizer: RAWTEXT, RCDATA and PLAINTEXT states.) The
// pages are held to the first two by the test below; the rest are listed so
// that a page which grows one is read the way a browser reads it.
const RAW_TEXT_ELEMENTS = [
  'script', 'style', 'textarea', 'title', 'iframe', 'xmp',
  'noembed', 'noframes', 'noscript'
];
// PLAINTEXT has no end tag: everything after it is text, to end of file.
// ASCII whitespace, which is what separates the parts of a tag. JavaScript's
// \s is wider — a no-break space is whitespace to it and text to a browser.
const HTML_SPACE = '\\t\\n\\f\\r ';
const IS_HTML_SPACE = /[\t\n\f\r ]/;
const IS_HTML_SPACE_RUN = /[\t\n\f\r ]+/;

function htmlMarkup(source) {
  let markup = source.replace(/<!--[\s\S]*?--!?>/g, '');
  for (const name of RAW_TEXT_ELEMENTS) {
    // The name ends where a browser ends it, and the end tag closes on
    // whitespace or a slash as well as on `>`, carrying attributes that are
    // read and thrown away. (HTML parsing spec, tokenizer: end tag open state.)
    markup = markup.replace(
      new RegExp(
        `<${name}(?=[${HTML_SPACE}/>])[\\s\\S]*?</${name}(?=[${HTML_SPACE}/>])[^>]*>`,
        'gi'
      ),
      ''
    );
  }
  // An opener with no end tag the browser accepts — a stray one, or one
  // closed with something that is not ASCII whitespace — turns the rest of the
  // document into text, exactly as PLAINTEXT does.
  for (const name of [...RAW_TEXT_ELEMENTS, 'plaintext']) {
    const opener = markup.search(new RegExp(`<${name}(?=[${HTML_SPACE}/>])`, 'i'));
    if (opener !== -1) markup = markup.slice(0, opener);
  }
  return markup;
}

function htmlStartTags(markup) {
  const tags = [];
  for (let i = 0; i < markup.length; i++) {
    if (markup[i] !== '<' || !/[a-zA-Z]/.test(markup[i + 1] || '')) continue;
    let quote = '';
    let j = i + 1;
    for (; j < markup.length; j++) {
      const character = markup[j];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    tags.push({ text: markup.slice(i, j), after: j + 1 });
    i = j;
  }
  return tags;
}

// A start tag handed over one attribute at a time, the way the tokenizer
// hands them over: a name, then a value that is text. Searching the tag for
// something that looks like an attribute reads a value again as markup, and an
// attribute spelled inside another one's value then counts as one of its own.
function tagAttributes(tag) {
  const attributes = [];
  const seen = new Set();
  const space = (character) => character !== undefined && IS_HTML_SPACE.test(character);
  let i = 1;
  while (i < tag.length && !space(tag[i]) && !'/>'.includes(tag[i])) i++;
  while (i < tag.length) {
    while (i < tag.length && (space(tag[i]) || tag[i] === '/')) i++;
    const nameStart = i;
    while (i < tag.length && !space(tag[i]) && !'/=>'.includes(tag[i])) i++;
    if (i === nameStart) break;
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < tag.length && space(tag[i])) i++;
    let value = '';
    if (tag[i] === '=') {
      i++;
      while (i < tag.length && space(tag[i])) i++;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, i + 1);
        value = tag.slice(i + 1, end === -1 ? tag.length : end);
        i = end === -1 ? tag.length : end + 1;
      } else {
        const valueStart = i;
        while (i < tag.length && !space(tag[i]) && tag[i] !== '>') i++;
        value = tag.slice(valueStart, i);
      }
    }
    // A repeated name is dropped, the way the tokenizer drops it, so the page
    // and this scan read the same attribute.
    if (seen.has(name)) continue;
    seen.add(name);
    attributes.push([name, value]);
  }
  return attributes;
}

// Each element the page marks, in document order: the key, what names the
// element in the page, and whether it holds text alone. What is left over the
// count check below still catches: a mention in a comment, in raw text, or
// anywhere that is not a start tag leaves the counts apart rather than being
// passed over.
function i18nElementsInOrder(source) {
  const markup = htmlMarkup(source);
  const marked = [];
  for (const { text, after } of htmlStartTags(markup)) {
    const attributes = tagAttributes(text);
    const key = attributes.find(([name]) => name === 'data-i18n');
    if (!key) continue;
    const named = new Map(attributes);
    const tag = text.slice(1).split(/[\t\n\f\r /]/)[0].toLowerCase();
    // applyI18n writes textContent, so anything an element holds besides text
    // is removed when the page is localized. It holds text alone when the
    // first tag inside it is its own end tag.
    const inside = markup.slice(after);
    const child = inside.indexOf('<');
    marked.push({
      key: key[1],
      tag,
      id: named.get('id') || '',
      classes: (named.get('class') || '').split(IS_HTML_SPACE_RUN).filter(Boolean),
      textOnly: child !== -1 && new RegExp(`^</${tag}(?=[${HTML_SPACE}/>])`, 'i').test(inside.slice(child))
    });
  }
  return marked;
}

function i18nKeysInOrder(source) {
  return i18nElementsInOrder(source).map((element) => element.key);
}

// The manifest names a message as the whole value of a field.
function manifestMessageKeys(source) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      const match = /^__MSG_([A-Za-z0-9_]+)__$/.exec(value);
      if (match) found.add(match[1]);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(JSON.parse(source));
  return found;
}

// Whatever the package carries can read a message, so the files come from the
// same selection rather than a list that has to be remembered.
function packagedSources() {
  const listed = spawnSync('python3', ['-B', 'pack.py', '--list'], {
    cwd: __dirname,
    encoding: 'utf8'
  });
  assert.equal(listed.status, 0, listed.stderr);
  const packaged = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(packaged.includes('manifest.json') && packaged.includes('popup.js'), packaged.join(' '));
  return packaged;
}

test('the extractor reads a page the way a browser does', () => {
  // Each expectation below is what Chrome 151 puts in the DOM for the same
  // markup, read back with --dump-dom.
  const keys = (html) => i18nKeysInOrder(html);

  // An attribute value is text. `_` is a name a browser accepts, and what it
  // holds never becomes an attribute of its own.
  assert.deepEqual(keys(`<h2 _='data-i18n="settings"'>Settings</h2>`), []);
  assert.deepEqual(keys('<h2 data-i18n="settings">Settings</h2>'), ['settings']);

  // An end tag ends on whitespace, and may carry attributes that are dropped.
  assert.deepEqual(keys('<title><x data-i18n="a"></title ><h2>H</h2>'), []);
  assert.deepEqual(keys('<title><x data-i18n="a"></title foo=bar><h2 data-i18n="b">B</h2>'), ['b']);
  assert.deepEqual(keys('<title><x data-i18n="a"></title><h2 data-i18n="b">B</h2>'), ['b']);

  // The name of a raw text element ends where the browser ends it: a longer
  // name is an element of its own, and the next real end tag is not its.
  assert.deepEqual(keys('<titles data-i18n="e">E</titles>'), ['e']);
  assert.deepEqual(
    keys('<titles data-i18n="e">E</titles><title>x</title><h2 data-i18n="f">F</h2>'),
    ['e', 'f']
  );

  // A tag name is not an attribute, however it is spelled.
  assert.deepEqual(keys('<data-i18n="x">y<h2 data-i18n="g">G</h2>'), ['g']);

  // A value with no quotes is still a value.
  assert.deepEqual(keys('<h2 data-i18n=c>C</h2><h2 data-i18n=d >D</h2>'), ['c', 'd']);
});

test('the pages stay inside the markup the extractor reads', () => {
  for (const name of ['popup.html', 'options.html']) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    // Raw text swallows what follows it. The extractor is written around the
    // raw text elements the pages do use - <title>, <style> and <script> - so
    // no other one belongs in them.
    for (const element of ['textarea', 'iframe', 'xmp', 'noembed', 'noframes', 'noscript', 'plaintext']) {
      assert.doesNotMatch(source, new RegExp(`<${element}\\b`, 'i'), `${name} uses <${element}>`);
    }
    // A comment ends on `--!>` as well as on `-->`, and template content is a
    // fragment that querySelectorAll never reaches. The pages need neither, so
    // they are refused rather than read two ways.
    assert.doesNotMatch(source, /<!--/, `${name} carries an HTML comment`);
    assert.doesNotMatch(source, /<template\b/i, `${name} uses <template>`);
    // The raw-text elements the pages do use close the plain way. A browser
    // also closes them on `</title >`, and closes them on nothing at all if
    // what follows the name is not ASCII whitespace.
    for (const closing of source.matchAll(/<\/(script|style|title)/gi)) {
      const after = source[closing.index + closing[0].length];
      assert.equal(after, '>', `${name} closes <${closing[1]}> with ${JSON.stringify(after)}`);
    }
    // Every mention is the attribute itself, spelled the way the extractor
    // reads it: lower case, quoted, inside a start tag.
    for (const mention of source.matchAll(/data-i18n/gi)) {
      const spelling = source.slice(mention.index, mention.index + 'data-i18n="'.length);
      assert.equal(spelling, 'data-i18n="', `${name} spells an attribute as ${spelling}`);
    }
  }
});

test('every data-i18n in the pages is one the extractor reads', () => {
  // The extractor handles quoted attributes in start tags. Anything else
  // spelling `data-i18n` — unquoted, inside raw text, split across a tag it
  // cannot see — leaves the counts apart, and this fails rather than passing
  // the attribute over.
  for (const name of ['popup.html', 'options.html']) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const mentions = (source.match(/data-i18n/gi) || []).length;
    assert.equal(i18nKeysInOrder(source).length, mentions, `${name} spells data-i18n somewhere the extractor does not read`);
  }
});

test('the pages mark the elements they are meant to mark', () => {
  // A snapshot of the key and the element that carries it — tag, id, and the
  // class tokens kept apart, since the page reads them apart. An attribute
  // that disappears, moves onto another element or gains a different key
  // changes this list. Keeping it here is what makes the extractor's blind
  // spots fail instead of pass.
  const marked = (name) =>
    i18nElementsInOrder(fs.readFileSync(path.join(__dirname, name), 'utf8'))
      .map(({ key, tag, id, classes }) => [key, tag, id, classes]);

  assert.deepEqual(marked('popup.html'), [
    ['channelNotDetected', 'div', 'channelName', ['channel-name', 'empty']],
    ['adDetected', 'span', 'adFlag', ['ad-badge', 'hidden']],
    ['resetMeasurement', 'span', '', ['sr-only']],
    ['resetMeasurementFailed', 'div', 'resetMeasurementError', ['reset-measurement-error', 'hidden']],
    ['audioUnavailable', 'div', 'audioError', ['audio-error', 'hidden']],
    ['labelIntegrated', 'div', '', ['label']],
    ['labelSuggested', 'div', '', ['label']],
    ['labelCurrent', 'span', '', []],
    ['labelFallback', 'span', 'fallbackBadge', ['fallback-badge', 'hidden']],
    ['autoApplyLoudness', 'div', 'autoApplyLabel', ['auto-label']],
    ['autoSaveFailed', 'div', 'autoError', ['auto-error', 'hidden']],
    ['applyToChannel', 'button', 'applyBtn', ['apply-btn']],
    ['hintNoLufs', 'span', 'applyHint', ['apply-hint']],
    ['manualVolume', 'span', '', ['label']]
  ]);

  assert.deepEqual(marked('options.html'), [
    ['settings', 'h2', '', []],
    ['settingsSaveFailed', 'div', 'settingsError', ['settings-error', 'hidden']],
    ['targetLufs', 'div', '', ['setting-label']],
    ['targetLufsDesc', 'div', '', ['setting-desc']],
    ['allChannelsAutoApply', 'div', 'allChannelsAutoLabel', ['setting-label']],
    ['allChannelsAutoApplyDesc', 'div', '', ['setting-desc']],
    ['typeLive', 'span', 'defaultAutoLiveLabel', ['type-switch-label']],
    ['typeVod', 'span', 'defaultAutoVodLabel', ['type-switch-label']],
    ['typeClip', 'span', 'defaultAutoClipLabel', ['type-switch-label']],
    ['adGain', 'div', '', ['setting-label']],
    ['adGainDesc', 'div', '', ['setting-desc']],
    ['displayUnit', 'div', '', ['setting-label']],
    ['displayUnitDesc', 'div', '', ['setting-desc']],
    ['showGainOverlay', 'div', '', ['setting-label']],
    ['showGainOverlayDesc', 'div', '', ['setting-desc']],
    ['savedChannels', 'h2', '', []],
    ['clearAll', 'button', 'clearAllBtn', ['clear-all-btn']],
    ['colChannel', 'th', '', []],
    ['typeLive', 'th', '', ['right']],
    ['typeVod', 'th', '', ['right']],
    ['typeClip', 'th', '', ['right']],
    ['noSavedChannels', 'div', 'emptyMsg', ['empty-msg']]
  ]);
});

test('the pages mark only elements that hold text', () => {
  // applyI18n assigns textContent, so a key on an element that holds other
  // elements removes them the moment the page is localized. The snapshot above
  // names the element; this is what makes carrying a key illegal there.
  for (const name of ['popup.html', 'options.html']) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    for (const { key, tag, textOnly } of i18nElementsInOrder(source)) {
      assert.ok(textOnly, `${name} marks ${key} on <${tag}>, which holds more than text`);
    }
  }
});

test('both pages localize every element their markup marks', async () => {
  // What applyI18n does with the key it reads at runtime is only visible by
  // running it: the harness msg refuses a key the locale does not declare.
  for (const [label, harness] of [
    ['popup', createPopupHarness()],
    ['options', createOptionsHarness()]
  ]) {
    await flushTasks(8);
    const nodes = harness.i18nNodes;
    assert.ok(nodes.length > 5, `${label} marks elements for translation`);
    for (const node of nodes) {
      const key = node.getAttribute('data-i18n');
      assert.equal(node.textContent, harness.message(key), `${label} ${key}`);
    }
  }
});

test('no message is declared that nothing mentions, and both locales agree', () => {
  const ja = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/en/messages.json'), 'utf8'));
  assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort());

  const mentioned = new Set();
  for (const name of packagedSources()) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    if (name.endsWith('.json')) {
      for (const key of manifestMessageKeys(source)) mentioned.add(key);
      continue;
    }
    if (name.endsWith('.html')) {
      for (const key of i18nKeysInOrder(source)) mentioned.add(key);
      continue;
    }
    // Over-approximating on purpose: a quoted mention counts, wherever it is.
    // A key nothing mentions is dead for certain; whether every mention is a
    // live call is what running the pages answers.
    for (const key of Object.keys(ja)) {
      if (source.includes(`'${key}'`)) mentioned.add(key);
    }
  }

  assert.deepEqual(Object.keys(ja).filter((key) => !mentioned.has(key)), []);
});

test('privacy policies list exactly the manifest permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  // The audit report cites this test for what the extension asks for.
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['*://*.twitch.tv/*']);
  const hosts = new Set(
    manifest.host_permissions.map((pattern) => pattern.replace(/^\*:\/\/\*?\.?/, '').replace(/\/\*$/, ''))
  );
  for (const file of ['PRIVACY_POLICY.md', 'PRIVACY_POLICY_JA.md']) {
    const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const declared = new Set(
      [...text.matchAll(/\*\*host_permissions\*\* \(`([^`]+)`\)/g)].map((m) => m[1])
    );
    assert.deepEqual([...declared].sort(), [...hosts].sort(), `${file} host rows`);
  }
});

test('the page is given the worklet module and nothing else', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  // The audit report cites this test for what the extension exposes to the page.
  assert.deepEqual(
    manifest.web_accessible_resources.flatMap((entry) => entry.resources),
    ['audio-worklet.js']
  );
  assert.deepEqual(
    manifest.web_accessible_resources.flatMap((entry) => entry.matches).sort(),
    ['*://*.twitch.tv/*', '*://clips.twitch.tv/*']
  );
});

test('suggestedGain stays at unity until a gated measurement exists', () => {
  assert.equal(u.suggestedGain(-Infinity, -18), 1.0);
  assert.equal(u.suggestedGain(NaN, -18), 1.0);
  assert.equal(u.suggestedGain(undefined, -18), 1.0);
  assert.equal(u.suggestedGain(-23, undefined), 1.0);
  assert.ok(Math.abs(u.suggestedGain(-23, -18) - u.calcGain(-23, -18)) < 1e-12);
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

test('Saved Channels shows the gain that would be applied', () => {
  const referenced = {
    gainVod: 0.5, autoGainVod: 0.8, autoGainRef: { vod: u.LUFS_REFERENCE_VOLUME_1 }
  };
  assert.equal(u.extractGainForKind(referenced, 'vod'), 0.5);
  assert.equal(u.extractAutoGainForKind(referenced, 'vod'), 0.8);
  assert.equal(u.extractAutoDisplayGain(referenced, 'vod'), 0.8);
  assert.equal(u.extractAutoDisplayGain({ gainVod: 0.5 }, 'vod'), 0.5);

  // An Auto gain measured at an unknown volume is not applied, so the table
  // must not offer it: display and resolvePreferredGain answer the same.
  const unreferenced = { autoApplyLoudnessVod: true, gainVod: 0.5, autoGainVod: 0.8 };
  assert.equal(u.extractAutoDisplayGain(unreferenced, 'vod'), 0.5);
  assert.equal(
    u.resolvePreferredGain(unreferenced, 'vod', false, -Infinity, -18).gain,
    u.extractAutoDisplayGain(unreferenced, 'vod')
  );
  assert.equal(u.formatAutoGain(u.extractAutoDisplayGain(referenced, 'vod'), 'dB'), 'Auto (-1.9 dB)');
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
    {
      autoApplyLoudnessVod: true,
      gainVod: 0.5,
      autoGainVod: 0.8,
      autoGainRef: { vod: u.LUFS_REFERENCE_VOLUME_1 }
    },
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
        ...measured({ live: -17, vod: -21, clip: -19 })
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

test('content reports the player audio the bridge could not attach to', async () => {
  const harness = createContentHarness();
  await flushTasks();

  let state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, false);

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    reason: 'InvalidStateError: HTMLMediaElement already connected'
  });
  state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, true);

  // The bridge falls back to another video, so a later attach clears it.
  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'attached' });
  state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, false);

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    reason: 'InvalidStateError: HTMLMediaElement already connected'
  });
  // A restarted bridge attaches from scratch and reports its own failure.
  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'loaded' });
  state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, false);
});

const ATTACH_FAILED = {
  type: '__twitch_channel_volume__',
  event: 'attach-failed',
  reason: 'InvalidStateError: HTMLMediaElement already connected'
};

test('content keeps the audio notice through the messages that do not answer it', async () => {
  const harness = createContentHarness();
  await flushTasks();
  await harness.dispatchMessage(ATTACH_FAILED);

  // A measurement or an ad marker says nothing about the audio path.
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -23,
    shortTerm: -23,
    integrated: -23
  });
  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'ad', active: true });
  assert.equal((await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailable, true);

  // An SPA navigation that keeps the same <video> gets no second report from
  // the bridge, so clearing here would drop the notice for good.
  await harness.navigate('https://www.twitch.tv/videos/200');
  assert.equal((await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailable, true);
  assert.equal(harness.gainBadgeText(), null);
});

test('content asks a restarted bridge to attach before it drops the notice', async () => {
  const harness = createContentHarness();
  await flushTasks();
  await harness.dispatchMessage(ATTACH_FAILED);
  harness.commands.length = 0;

  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'loaded' });
  await flushTasks(8);

  assert.equal(harness.commands.filter((command) => command.cmd === 'attach').length, 1);
  assert.equal((await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailable, false);
});

test('content holds the notice when the bridge attaches past a held element', async () => {
  const harness = createContentHarness();
  await flushTasks();
  await harness.dispatchMessage(ATTACH_FAILED);

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attached',
    measuring: true,
    takenElsewhere: true
  });

  assert.equal((await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailable, true);
  assert.equal(harness.gainBadgeText(), null);
});

test('content reports a measurement chain that never came up', async () => {
  const harness = createContentHarness();
  await flushTasks();

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attached',
    measuring: false,
    takenElsewhere: false
  });
  let state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.measurementUnavailable, true);
  assert.equal(state.audioUnavailable, false);
  // Gain reaches the player on this path, so the badge stands.
  assert.equal(harness.gainBadgeText(), '50%');

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attached',
    measuring: true,
    takenElsewhere: false
  });
  state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.measurementUnavailable, false);
  assert.equal(harness.gainBadgeCount(), 1);
});

test('content drops the stalled-measurement notice when the audio path goes', async () => {
  const harness = createContentHarness();
  await flushTasks();
  const attachedWithoutMeasurement = {
    type: '__twitch_channel_volume__',
    event: 'attached',
    measuring: false,
    takenElsewhere: false
  };

  await harness.dispatchMessage(attachedWithoutMeasurement);
  assert.equal((await harness.dispatchRuntime({ cmd: 'getState' })).measurementUnavailable, true);

  await harness.dispatchMessage(ATTACH_FAILED);
  let state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, true);
  // One notice at a time: the audio path is the reason the measurement stopped.
  assert.equal(state.measurementUnavailable, false);

  await harness.dispatchMessage(attachedWithoutMeasurement);
  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'loaded' });
  await flushTasks(8);
  state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.measurementUnavailable, false);
});

test('content ignores measurements taken while the player audio is out of reach', async () => {
  const harness = createContentHarness({ autoApply: true, autoGain: 0.8 });
  await flushTasks();
  await harness.dispatchMessage(ATTACH_FAILED);
  harness.commands.length = 0;

  // Whatever element the bridge reached, it is not the one the viewer hears.
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -14,
    shortTerm: -14,
    integrated: -14
  });
  await flushTasks(8);

  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.lufs.integrated, -Infinity);
  assert.equal(harness.commands.some((command) => command.cmd === 'setGain'), false);
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].lastLufs, undefined);
});

test('content restarts the measurement when the audio path comes back', async () => {
  const harness = createContentHarness();
  await flushTasks();
  await harness.dispatchMessage(ATTACH_FAILED);
  harness.commands.length = 0;

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attached',
    measuring: true,
    takenElsewhere: false
  });
  await flushTasks(8);
  // The bridge's window still holds blocks from the element it fell back to.
  assert.equal(harness.commands.filter((command) => command.cmd === 'resetMeasurement').length, 1);

  harness.commands.length = 0;
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attached',
    measuring: true,
    takenElsewhere: false
  });
  await flushTasks(8);
  // Only the recovery restarts it; a repeated report is not a new attachment.
  assert.equal(harness.commands.filter((command) => command.cmd === 'resetMeasurement').length, 0);
});

test('content refuses a measurement reset while the player audio is unavailable', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      'vod-owner:100': { name: '100', gainVod: 0.5, ...measured({ vod: -21 }) }
    }
  });
  await flushTasks();
  const { channel } = await harness.dispatchRuntime({ cmd: 'getState' });
  await harness.dispatchMessage(ATTACH_FAILED);

  const response = await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: channel.id,
    kind: channel.kind
  });
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'audio unavailable');
  // The saved level survives: nothing could rebuild it from here.
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].lastLufs.vod, -21);
});

test('content passes on which failure the bridge reported', async () => {
  const harness = createContentHarness();
  await flushTasks();

  await harness.dispatchMessage(ATTACH_FAILED);
  assert.equal(
    (await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailableCause,
    'element-taken'
  );

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    cause: 'audio-context',
    reason: 'audio context unavailable'
  });
  assert.equal(
    (await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailableCause,
    'audio-context'
  );
});

test('content refuses gain and Auto writes while the player audio is unavailable', async () => {
  const harness = createContentHarness();
  await flushTasks();
  const { channel } = await harness.dispatchRuntime({ cmd: 'getState' });
  await harness.dispatchMessage(ATTACH_FAILED);

  const gainResponse = await harness.dispatchRuntime({ cmd: 'setGain', gain: 4 });
  assert.equal(gainResponse.ok, false);
  assert.equal(gainResponse.reason, 'audio unavailable');
  const autoResponse = await harness.dispatchRuntime({
    cmd: 'setAutoApplyLoudness',
    channelId: channel.id,
    kind: channel.kind,
    enabled: true
  });
  assert.equal(autoResponse.ok, false);
  assert.equal(autoResponse.reason, 'audio unavailable');
  const stored = harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'];
  assert.equal(stored.gainVod, 0.5);
  assert.equal(stored.autoApplyLoudnessVod, false);
});

test('content leaves the badge off when the failure precedes the saved gain', async () => {
  const harness = createContentHarness({ deferInitialStorageGet: true });
  await harness.dispatchMessage(ATTACH_FAILED);
  harness.releaseInitialStorageGet();
  await flushTasks(8);

  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, true);
  // The saved gain is applied to the node; only its badge is withheld.
  assert.equal(state.gain, 0.5);
  assert.equal(harness.gainBadgeText(), null);
});

test('content requests one ad state change per transition', async () => {
  const harness = createContentHarness();
  await flushTasks();
  harness.commands.length = 0;

  // The bridge echo has not arrived yet, and chat keeps the observer firing.
  harness.setAdNodePresent(true);
  harness.mutate();
  harness.mutate();
  harness.mutate();
  let requests = harness.commands.filter((command) => command.cmd === 'setAdActive');
  assert.deepEqual(requests, [{ type: '__twitch_channel_volume_cmd__', cmd: 'setAdActive', active: true }]);

  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'ad', active: true });
  harness.mutate();
  assert.equal(harness.commands.filter((command) => command.cmd === 'setAdActive').length, 1);

  harness.commands.length = 0;
  harness.setAdNodePresent(false);
  harness.mutate();
  harness.mutate();
  requests = harness.commands.filter((command) => command.cmd === 'setAdActive');
  assert.deepEqual(requests, [{ type: '__twitch_channel_volume_cmd__', cmd: 'setAdActive', active: false }]);
});

test('content stores a measurement the next session can seed from', async () => {
  const harness = createContentHarness();
  await flushTasks();
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'lufs',
    momentary: -21,
    shortTerm: -21,
    integrated: -21,
    integratedWindows: 1800
  });
  await flushTasks();
  const saved = harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'];
  assert.equal(saved.lastLufs.vod, -21);
  assert.equal(saved.lastLufsRef.vod, u.LUFS_REFERENCE_VOLUME_1);
  assert.equal(saved.lastLufsWindows.vod, 1800);

  // What was written is what the next session reads back as a seed, weight
  // included: without it the first second of the new session outweighs it.
  const next = createContentHarness({ channelVolumes: structuredClone(harness.stored[u.CHANNEL_VOLUMES_KEY]) });
  await flushTasks();
  const resets = next.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(resets.at(-1).initialIntegratedLufs, -21);
  assert.equal(resets.at(-1).initialIntegratedWindows, 1800);
});

test('content leaves the seed unweighed where the count was never stored', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      // Saved before the window count was stored alongside the measurement.
      // The count another kind carries is not this kind's.
      'vod-owner:100': {
        name: '100',
        lastLufs: { vod: -21 },
        lastLufsRef: { vod: u.LUFS_REFERENCE_VOLUME_1 },
        lastLufsWindows: { live: 900 }
      }
    }
  });
  await flushTasks();

  const resets = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(resets.at(-1).initialIntegratedLufs, -21);
  assert.equal(resets.at(-1).initialIntegratedWindows, undefined);
});

test('content ignores a window count the bridge cannot have measured', async () => {
  for (const integratedWindows of [NaN, -5, 0, 1.5, '600', Infinity, undefined]) {
    const harness = createContentHarness();
    await flushTasks();
    await harness.dispatchMessage({
      type: '__twitch_channel_volume__',
      event: 'lufs',
      momentary: -21,
      shortTerm: -21,
      integrated: -21,
      integratedWindows
    });
    await flushTasks();

    const saved = harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'];
    // The measurement is still worth keeping; only its weight is unknown.
    assert.equal(saved.lastLufs.vod, -21, String(integratedWindows));
    assert.equal(saved.lastLufsWindows, undefined, String(integratedWindows));
  }
});

test('content drops the window count with the measurement it described', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      'vod-owner:100': {
        name: '100',
        autoApplyLoudnessVod: true,
        lastLufs: { vod: -21 },
        lastLufsRef: { vod: u.LUFS_REFERENCE_VOLUME_1 },
        lastLufsWindows: { vod: 1800 }
      }
    }
  });
  await flushTasks();
  harness.commands.length = 0;

  const response = await harness.dispatchRuntime({
    cmd: 'resetMeasurement',
    channelId: 'vod-owner:100',
    kind: 'vod'
  });

  assert.equal(response.ok, true);
  assert.equal(harness.stored[u.CHANNEL_VOLUMES_KEY]['vod-owner:100'].lastLufsWindows, undefined);
  const resets = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(resets.length, 1);
  assert.equal(resets[0].initialIntegratedLufs, undefined);
  assert.equal(resets[0].initialIntegratedWindows, undefined);
});

test('content does not seed from a measurement taken at an unknown volume', async () => {
  const harness = createContentHarness({
    channelVolumes: {
      // Saved before measurements were referenced to volume 1.0.
      'vod-owner:100': { name: '100', lastLufs: { vod: -21 } }
    }
  });
  await flushTasks();

  const resetCommands = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(resetCommands.length, 1);
  assert.equal(resetCommands[0].initialIntegratedLufs, undefined);
  // The value is still there to reset.
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.hasSavedMeasurement, true);
});

test('channel store records what an Auto gain was measured against', async () => {
  for (const kind of ['live', 'vod', 'clip']) {
    let stored = { channelVolumes: {} };
    const storage = {
      async get(keys) { return readStoredKeys(stored, keys); },
      async set(update) { stored = { ...stored, ...structuredClone(update) }; }
    };
    const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
    await write({
      operation: 'saveAutoGain', channelId: 'login:test', kind, autoGain: 2.5,
      reference: u.LUFS_REFERENCE_VOLUME_1
    });
    const entry = stored.channelVolumes['login:test'];
    assert.equal(entry.autoGainRef[kind], u.LUFS_REFERENCE_VOLUME_1);
    assert.equal(u.resolvePreferredGain(entry, kind, true, -Infinity, -18).gain, 2.5);

    let fresh = { channelVolumes: {} };
    const freshStorage = {
      async get(keys) { return readStoredKeys(fresh, keys); },
      async set(update) { fresh = { ...fresh, ...structuredClone(update) }; }
    };
    const writeFresh = channelStore.createChannelVolumesWriter(freshStorage, 'channelVolumes', () => 100);
    await writeFresh({
      operation: 'saveAuto', channelId: 'login:test', kind, enabled: true, autoGain: 1.5,
      reference: u.LUFS_REFERENCE_VOLUME_1
    });
    const enabled = fresh.channelVolumes['login:test'];
    assert.equal(enabled.autoGainRef[kind], u.LUFS_REFERENCE_VOLUME_1);
    assert.equal(u.resolvePreferredGain(enabled, kind, false, -Infinity, -18).gain, 1.5);

    await write({ operation: 'clearMeasurement', channelId: 'login:test', kind });
    assert.equal(stored.channelVolumes['login:test'].autoGainRef[kind], u.LUFS_REFERENCE_VOLUME_1);
  }
});

test('channel store rejects a reference it cannot store', async () => {
  let stored = { channelVolumes: {} };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
  for (const reference of [42, {}, 'x'.repeat(33)]) {
    await assert.rejects(() => write({
      operation: 'saveMeasurement', channelId: 'login:test', kind: 'live', lufs: -19, reference
    }));
  }
  assert.equal(stored.channelVolumes['login:test'], undefined);
});

test('channel store merges an Auto gain and its reference together', async () => {
  // A login row normalizes into the numeric one on the next write, so this uses
  // a VOD provisional id to reach the merge itself.
  const merge = async (seed, writes) => {
    let stored = { channelVolumes: structuredClone(seed) };
    const storage = {
      async get(keys) { return readStoredKeys(stored, keys); },
      async set(update) { stored = { ...stored, ...structuredClone(update) }; }
    };
    const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
    for (const mutation of writes) await write(mutation);
    await write({
      operation: 'mergeChannelIds', fromId: 'vod-owner:100', toId: '777', kind: 'vod',
      channel: { name: 'X' }
    });
    return stored.channelVolumes['777'];
  };
  const seed = { 777: { name: 'X' }, 'vod-owner:100': { name: 'X' } };

  // A measurement written on the other row cannot vouch for a gain that was
  // saved before references existed.
  const borrowed = await merge(
    { 777: { name: 'X', autoGainVod: 1.5 }, 'vod-owner:100': { name: 'X' } },
    [{
      operation: 'saveMeasurement', channelId: 'vod-owner:100', kind: 'vod', lufs: -18,
      reference: u.LUFS_REFERENCE_VOLUME_1
    }]
  );
  assert.equal(borrowed.autoGainVod, 1.5);
  assert.equal(borrowed.autoGainRef, undefined);
  assert.equal(u.resolvePreferredGain(borrowed, 'vod', true, -Infinity, -18).gain, 1.0);

  // Nor can an unreferenced measurement strip a gain that has its own.
  const kept = await merge(seed, [
    {
      operation: 'saveAutoGain', channelId: '777', kind: 'vod', autoGain: 2.5,
      reference: u.LUFS_REFERENCE_VOLUME_1
    },
    { operation: 'saveMeasurement', channelId: 'vod-owner:100', kind: 'vod', lufs: -21 }
  ]);
  assert.equal(kept.autoGainVod, 2.5);
  assert.equal(kept.autoGainRef.vod, u.LUFS_REFERENCE_VOLUME_1);
  assert.equal(u.resolvePreferredGain(kept, 'vod', true, -Infinity, -18).gain, 2.5);

  // When the newer gain is the unreferenced one, the reference goes with the
  // value it described rather than staying on the row.
  const replaced = await merge(seed, [
    {
      operation: 'saveAutoGain', channelId: '777', kind: 'vod', autoGain: 2.5,
      reference: u.LUFS_REFERENCE_VOLUME_1
    },
    { operation: 'saveAutoGain', channelId: 'vod-owner:100', kind: 'vod', autoGain: 1.5 }
  ]);
  assert.equal(replaced.autoGainVod, 1.5);
  assert.equal(replaced.autoGainRef, undefined);
  assert.equal(u.resolvePreferredGain(replaced, 'vod', true, -Infinity, -18).gain, 1.0);
});

test('channel store references an Auto gain saved with its measurement', async () => {
  for (const kind of ['live', 'vod', 'clip']) {
    let stored = { channelVolumes: {} };
    const storage = {
      async get(keys) { return readStoredKeys(stored, keys); },
      async set(update) { stored = { ...stored, ...structuredClone(update) }; }
    };
    const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
    // Auto writes the gain alongside the measurement that produced it.
    await write({
      operation: 'saveMeasurement', channelId: 'login:test', kind, lufs: -23, autoGain: 1.778,
      reference: u.LUFS_REFERENCE_VOLUME_1
    });
    const entry = stored.channelVolumes['login:test'];
    assert.equal(entry.lastLufsRef[kind], u.LUFS_REFERENCE_VOLUME_1);
    assert.equal(entry.autoGainRef[kind], u.LUFS_REFERENCE_VOLUME_1);
    assert.equal(u.resolvePreferredGain(entry, kind, true, -Infinity, -18).gain, 1.778);
  }
});

test('channel store carries the reference onto the surviving row either way', async () => {
  const build = async (lastId, lastReferenced) => {
    let stored = { channelVolumes: { 'login:test': { name: 'Test' }, 777: { name: 'Test' } } };
    const storage = {
      async get(keys) { return readStoredKeys(stored, keys); },
      async set(update) { stored = { ...stored, ...structuredClone(update) }; }
    };
    const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
    const firstId = lastId === '777' ? 'login:test' : '777';
    await write({
      operation: 'saveMeasurement', channelId: firstId, kind: 'live', lufs: -19,
      ...(lastReferenced ? {} : { reference: u.LUFS_REFERENCE_VOLUME_1 })
    });
    await write({
      operation: 'saveMeasurement', channelId: lastId, kind: 'live', lufs: -23,
      ...(lastReferenced ? { reference: u.LUFS_REFERENCE_VOLUME_1 } : {})
    });
    await write({
      operation: 'mergeChannelIds', fromId: 'login:test', toId: '777', kind: 'live',
      channel: { name: 'Test', login: 'test' }
    });
    return stored.channelVolumes['777'];
  };

  // A reference that outlived its value still travels with the winning row.
  {
    let stored = { channelVolumes: { 'login:test': { name: 'Test' } } };
    const storage = {
      async get(keys) { return readStoredKeys(stored, keys); },
      async set(update) { stored = { ...stored, ...structuredClone(update) }; }
    };
    const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
    await write({
      operation: 'saveMeasurement', channelId: 'login:test', kind: 'live', lufs: -19,
      reference: u.LUFS_REFERENCE_VOLUME_1
    });
    await write({
      operation: 'saveAutoGain', channelId: 'login:test', kind: 'live', autoGain: 2.5,
      reference: u.LUFS_REFERENCE_VOLUME_1
    });
    await write({ operation: 'clearMeasurement', channelId: 'login:test', kind: 'live' });
    await write({
      operation: 'mergeChannelIds', fromId: 'login:test', toId: '777', kind: 'live',
      channel: { name: 'Test', login: 'test' }
    });
    const merged = stored.channelVolumes['777'];
    assert.equal(merged.lastLufs, undefined);
    assert.equal(merged.autoGainRef.live, u.LUFS_REFERENCE_VOLUME_1);
    assert.equal(u.resolvePreferredGain(merged, 'live', true, -Infinity, -18).gain, 2.5);
  }

  // The later write wins the merge; its reference, or its lack of one, wins too.
  for (const lastId of ['login:test', '777']) {
    const referenced = await build(lastId, true);
    assert.equal(referenced.lastLufs.live, -23);
    assert.equal(referenced.lastLufsRef.live, u.LUFS_REFERENCE_VOLUME_1);

    const unreferenced = await build(lastId, false);
    assert.equal(unreferenced.lastLufs.live, -23);
    assert.equal(unreferenced.lastLufsRef, undefined);
  }
});

test('channel store keeps the measurement reference with the value it describes', async () => {
  let stored = { channelVolumes: {} };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
  await write({
    operation: 'saveMeasurement', channelId: 'login:test', kind: 'live', lufs: -19,
    reference: u.LUFS_REFERENCE_VOLUME_1, channel: { name: 'Test' }
  });
  assert.equal(stored.channelVolumes['login:test'].lastLufsRef.live, u.LUFS_REFERENCE_VOLUME_1);

  await write({
    operation: 'mergeChannelIds', fromId: 'login:test', toId: '777', kind: 'live',
    channel: { name: 'Test', login: 'test' }
  });
  assert.equal(stored.channelVolumes['777'].lastLufs.live, -19);
  assert.equal(stored.channelVolumes['777'].lastLufsRef.live, u.LUFS_REFERENCE_VOLUME_1);

  // A reset drops the measurement and keeps the reference: the Auto gain it
  // vouches for is still on file and still applied.
  await write({
    operation: 'saveAutoGain', channelId: '777', kind: 'live', autoGain: 2.5,
    reference: u.LUFS_REFERENCE_VOLUME_1
  });
  await write({ operation: 'clearMeasurement', channelId: '777', kind: 'live' });
  const afterReset = stored.channelVolumes['777'];
  assert.equal(afterReset.lastLufs, undefined);
  assert.equal(afterReset.lastLufsRef, undefined);
  assert.equal(afterReset.autoGainRef.live, u.LUFS_REFERENCE_VOLUME_1);
  assert.equal(afterReset.autoGainLive, 2.5);
  assert.equal(u.resolvePreferredGain(afterReset, 'live', true, -Infinity, -18).gain, 2.5);

  // A writer that names no reference drops the measurement's, so the value it
  // wrote is not taken for a volume-referenced one. The Auto gain keeps its own.
  await write({
    operation: 'saveMeasurement', channelId: '777', kind: 'live', lufs: -21
  });
  const unreferencedMeasurement = stored.channelVolumes['777'];
  assert.equal(unreferencedMeasurement.lastLufs.live, -21);
  assert.equal(unreferencedMeasurement.lastLufsRef, undefined);
  assert.equal(unreferencedMeasurement.autoGainRef.live, u.LUFS_REFERENCE_VOLUME_1);
  assert.equal(
    u.resolvePreferredGain(unreferencedMeasurement, 'live', true, -Infinity, -18).gain,
    2.5
  );
});

test('channel store keeps the window count with the value it was measured over', async () => {
  let stored = { channelVolumes: {} };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
  await write({
    operation: 'saveMeasurement', channelId: 'login:test', kind: 'live', lufs: -19,
    reference: u.LUFS_REFERENCE_VOLUME_1, windows: 1800, channel: { name: 'Test' }
  });
  assert.equal(stored.channelVolumes['login:test'].lastLufsWindows.live, 1800);

  await write({
    operation: 'mergeChannelIds', fromId: 'login:test', toId: '777', kind: 'live',
    channel: { name: 'Test', login: 'test' }
  });
  assert.equal(stored.channelVolumes['777'].lastLufsWindows.live, 1800);

  // A writer that names no count measured without one, so the one on file goes
  // with the value it described.
  await write({
    operation: 'saveMeasurement', channelId: '777', kind: 'vod', lufs: -20,
    reference: u.LUFS_REFERENCE_VOLUME_1, windows: 600
  });
  await write({
    operation: 'saveMeasurement', channelId: '777', kind: 'live', lufs: -21,
    reference: u.LUFS_REFERENCE_VOLUME_1
  });
  assert.equal(stored.channelVolumes['777'].lastLufsWindows.live, undefined);
  assert.equal(stored.channelVolumes['777'].lastLufsWindows.vod, 600);

  // A reset takes the count with the measurement it stood behind.
  await write({ operation: 'clearMeasurement', channelId: '777', kind: 'vod' });
  assert.equal(stored.channelVolumes['777'].lastLufsWindows, undefined);
});

test('channel store keeps the window count of the value that wins an id merge', async () => {
  for (const lastWriter of ['login:test', '777']) {
    let stored = { channelVolumes: {} };
    const storage = {
      async get(keys) { return readStoredKeys(stored, keys); },
      async set(update) { stored = { ...stored, ...structuredClone(update) }; }
    };
    const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
    const writes = [
      ['login:test', -19, 1800],
      ['777', -25, 300]
    ];
    // The later write wins the field, and its count and reference go with it.
    if (lastWriter === 'login:test') writes.reverse();
    for (const [channelId, lufs, windows] of writes) {
      await write({
        operation: 'saveMeasurement', channelId, kind: 'live', lufs, windows,
        reference: u.LUFS_REFERENCE_VOLUME_1, channel: { name: 'Test' }
      });
    }
    await write({
      operation: 'mergeChannelIds', fromId: 'login:test', toId: '777', kind: 'live',
      channel: { name: 'Test', login: 'test' }
    });

    const merged = stored.channelVolumes['777'];
    const [, winnerLufs, winnerWindows] = writes[1];
    assert.equal(merged.lastLufs.live, winnerLufs, lastWriter);
    assert.equal(merged.lastLufsWindows.live, winnerWindows, lastWriter);
    assert.equal(merged.lastLufsRef.live, u.LUFS_REFERENCE_VOLUME_1, lastWriter);
  }
});

test('channel store refuses a window count that is not a positive integer', async () => {
  for (const windows of [0, -1, 1.5, '600', NaN, Infinity, null]) {
    assert.throws(() => channelStore.applyChannelVolumesMutation({}, {
      operation: 'saveMeasurement', channelId: '777', kind: 'live', lufs: -19,
      reference: u.LUFS_REFERENCE_VOLUME_1, windows
    }), TypeError, `windows: ${String(windows)}`);
  }
});

test('content seeds the measurement once the owner ID resolves', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/videos/100',
    channelVolumes: { '777': { name: 'Streamer', ...measured({ vod: -16 }, 900) } }
  });
  await flushTasks();

  // A first-visit VOD has no alias, so the startup seed finds nothing.
  const startup = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.equal(startup.length, 1);
  assert.equal(startup[0].initialIntegratedLufs, undefined);
  assert.equal(startup[0].initialIntegratedWindows, undefined);
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
  // The weight travels with every seed, not only the one sent at startup.
  assert.equal(afterOwner[0].initialIntegratedWindows, 900);
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.channel.id, '777');
});

test('content keeps the running measurement when the owner resolves the same channel', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/streamer',
    channelVolumes: { '777': { name: 'Streamer', ...measured({ live: -16 }) } }
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
    'vod-owner:100': { name: '100', ...measured({ vod: -21 }) },
    'vod-owner:200': { name: '200', ...measured({ vod: -19 }) }
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
    '777': { name: 'Streamer', ...measured({ live: -16, vod: -23 }) }
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

test('the fetch hook hands back the response the page asked for', async () => {
  const harness = createPageBridgeHarness();
  harness.messages.length = 0;
  let cloned = 0;
  const plainInit = { method: 'GET', headers: {} };
  const untouched = harness.fetch('https://www.twitch.tv/api/something', plainInit);
  // The page's request goes out once, with the arguments the page gave.
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].length, 2);
  assert.equal(harness.fetchCalls[0][0], 'https://www.twitch.tv/api/something');
  assert.equal(harness.fetchCalls[0][1], plainInit);
  const plain = {
    clone() {
      cloned++;
      return { async json() { return {}; } };
    }
  };
  harness.resolveFetch(plain);
  // A response the hook has no interest in is neither read nor replaced.
  assert.equal(await untouched, plain);
  await flushTasks();
  assert.equal(cloned, 0);
  assert.deepEqual(harness.messages.filter((message) => message.event === 'owner'), []);

  const gqlInit = { method: 'POST', body: '{"operationName":"StreamMetadata"}' };
  const read = harness.fetch('https://gql.twitch.tv/gql', gqlInit);
  // The one it reads goes out once too, and not again to read it.
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.fetchCalls[1].length, 2);
  assert.equal(harness.fetchCalls[1][0], 'https://gql.twitch.tv/gql');
  assert.equal(harness.fetchCalls[1][1], gqlInit);
  const answered = {
    clone() {
      return {
        async json() {
          return { data: { user: { id: '123', login: 'owner', displayName: 'Owner' } } };
        }
      };
    }
  };
  harness.resolveFetch(answered);
  // The one it does read reaches the page as the very same response.
  assert.equal(await read, answered);
  await flushTasks();
  assert.equal(harness.messages.filter((message) => message.event === 'owner').length, 1);
  assert.equal(harness.fetchCalls.length, 2);
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
  assert.ok(
    source.indexOf('setSettingsControlsDisabled(true);') <
      source.indexOf('Promise.race([loadAll()'),
    'the controls are disabled before the load is started'
  );
  assert.doesNotMatch(source, /chrome\.storage\.local\.set\(\{\s*\[SETTINGS_KEY\]/);
});

// A control whose transition survives initialization animates from its markup
// default into its stored value after the page is already on screen. Only a
// universal rule covers every control, including ones added later.
function suppressesEveryTransition(html) {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  for (const rule of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/transition\s*:\s*none\s*!important/.test(rule[2])) continue;
    const selectors = rule[1].split(',').map((selector) => selector.trim().replace(/\s+/g, ' '));
    if (['*', '*::before', '*::after']
      .every((universal) => selectors.includes('body.initializing ' + universal))) return true;
  }
  return false;
}

function revealBody(source, name) {
  const start = source.indexOf(`function ${name}()`);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  return source.slice(open, i + 1);
}

test('both pages ship hidden and hold every transition until the values are written', () => {
  for (const [page, htmlName, sourceName, reveal, fn] of [
    ['options', 'options.html', 'options.js', /\.finally\(revealOptions\);/, 'revealOptions'],
    ['popup', 'popup.html', 'popup.js', /finally \{\s*revealPopup\(\);/, 'revealPopup']
  ]) {
    const html = fs.readFileSync(path.join(__dirname, htmlName), 'utf8');
    const source = fs.readFileSync(path.join(__dirname, sourceName), 'utf8');
    assert.match(html, /<body class="initializing">/, page);
    assert.match(html, /body\.initializing\s*\{[^}]*visibility:\s*hidden;/s, page);
    assert.ok(suppressesEveryTransition(html), `${page} stops every transition while initializing`);
    assert.match(source, reveal, `${page} reveals after the load settles either way`);

    const body = revealBody(source, fn);
    assert.ok(body, `${page} reveals from a named function`);
    const flush = body.indexOf('document.body.offsetWidth');
    const frame = body.indexOf('requestAnimationFrame(');
    const drop = body.indexOf("classList.remove('initializing')");
    // Dropping the class in the style pass that wrote the values leaves the
    // pre-write style as the starting point of every transition.
    assert.ok(
      flush > -1 && flush < frame && frame < drop,
      `${page} flushes the written values before dropping the class on the next frame`
    );
    assert.equal(
      (source.match(new RegExp(fn, 'g')) || []).length, 2,
      `${page} reveals from one place`
    );
  }
});

test('the options page offers no destructive action over a list it has not read', () => {
  const html = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
  // Both ship in the state the load leaves them in when it never runs: no
  // "no saved channels" claim, and no way to delete what it did not count.
  assert.match(html, /<button[^>]+id="clearAllBtn"[^>]*\bdisabled\b/);
  assert.match(html, /<div[^>]+id="emptyMsg"[^>]*style="display:none"/);
  // The column headers over no rows answer the same question the line does.
  assert.match(html, /<table class="channel-table" style="display:none">/);
  // A disabled control that looks live is a control the viewer will press.
  assert.match(html, /\.clear-all-btn:disabled\s*\{[^}]*opacity:\s*0\.45;/s);
  assert.match(html, /\.clear-all-btn:hover:not\(:disabled\)\s*\{/);
  assert.match(html, /\.ch-del:disabled\s*\{[^}]*opacity:\s*0\.45;/s);
  assert.match(html, /\.ch-del:hover:not\(:disabled\)\s*\{/);

  // The row button is written by the render, so the refusal is stated twice:
  // the markup it writes, and the handler the click reaches.
  const source = fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8');
  assert.match(source, /class="ch-del"[^`]*\$\{settingsReady \? '' : ' disabled'\}/);
  assert.match(source, /async function removeChannel\(id\) \{[^}]*if \(!settingsReady\) return;/);
  assert.match(source, /async function clearAll\(\) \{\s*if \(!settingsReady\) return;/);
});

test('the options markup ships the defaults the extension installs', () => {
  // Until the load writes to them, the controls hold what the markup gives
  // them, and a load that fails leaves them there for good.
  const html = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
  const background = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  const start = background.indexOf("operation: 'initializeSettings'");
  const installed = background.slice(start, background.indexOf('}', background.indexOf('defaults: {', start)));
  const installedValue = (field) => {
    const match = installed.match(new RegExp(`${field}:\\s*([^,\\n]+)`));
    assert.ok(match, `${field} is still installed`);
    return match[1].trim();
  };
  const tag = (id) => {
    const match = html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`));
    assert.ok(match, `${id} is still an input`);
    return match[0];
  };

  assert.equal(installedValue('targetLufs'), String(u.DEFAULT_TARGET_LUFS));
  assert.equal(installedValue('adGainDb'), String(u.DEFAULT_AD_GAIN_DB));
  assert.equal(installedValue('displayUnit'), "'%'");
  assert.equal(installedValue('showGainOverlay'), 'true');
  assert.match(tag('targetLufs'), new RegExp(`value="${u.DEFAULT_TARGET_LUFS}"`));
  assert.match(tag('adGainDb'), new RegExp(`value="${u.DEFAULT_AD_GAIN_DB}"`));
  assert.match(tag('overlayToggle'), /\bchecked\b/);
  assert.match(html, /<button data-unit="%" class="active"/);
  for (const kind of ['Live', 'Vod', 'Clip']) {
    assert.equal(
      installedValue(`autoApplyLoudness${kind}Default`),
      String(u.DEFAULT_AUTO_APPLY_LOUDNESS),
      kind
    );
    assert.doesNotMatch(tag(`defaultAuto${kind}Toggle`), /\bchecked\b/, kind);
  }
});

test('options put the stored values on their controls before showing the page', async () => {
  const harness = createOptionsHarness({
    settings: {
      targetLufs: -24,
      adGainDb: -12,
      displayUnit: 'dB',
      showGainOverlay: false,
      autoApplyLoudnessLiveDefault: true,
      autoApplyLoudnessVodDefault: true,
      autoApplyLoudnessClipDefault: true
    },
    channelVolumes: { 123: { name: 'somechannel', login: 'somechannel', gainLive: 1.5 } },
    deferStorage: true
  });
  await flushTasks(8);
  assert.ok(harness.body.classList.contains('initializing'), 'hidden while the read is pending');
  assert.equal(harness.el('targetLufsValue').textContent, '');

  harness.releaseStorage();
  await flushTasks(8);
  // Every control the render writes, so a write that stops happening is seen.
  assert.equal(harness.el('targetLufs').value, '-24');
  assert.equal(harness.el('targetLufsValue').textContent, '-24 LUFS');
  assert.equal(harness.el('adGainDb').value, '-12');
  assert.equal(harness.el('adGainValue').textContent, '-12 dB');
  assert.equal(harness.el('overlayToggle').checked, false);
  for (const kind of ['Live', 'Vod', 'Clip']) {
    assert.equal(harness.el(`defaultAuto${kind}Toggle`).checked, true, kind);
  }
  assert.deepEqual(
    harness.unitButtons.map((button) => button.classList.contains('active')),
    [false, true],
    'the stored unit is the selected one'
  );
  assert.ok(harness.el('channelsBody').textContent.includes('somechannel'));
  assert.doesNotMatch(harness.el('channelsBody').textContent, /class="ch-del"[^>]*\bdisabled\b/);
  assert.equal(harness.el('select:.channel-table').style.display, '');
  assert.equal(harness.el('emptyMsg').style.display, 'none');
  assert.equal(harness.el('targetLufs').disabled, false);
  assert.equal(harness.el('clearAllBtn').disabled, false);
  assert.equal(harness.body.classList.contains('initializing'), false);
});

test('options show the page even when the load that fills it fails', async () => {
  const harness = createOptionsHarness({ failStorage: true });
  await flushTasks(8);
  // Revealing only on success leaves the viewer looking at a blank window.
  assert.equal(harness.body.classList.contains('initializing'), false);
  assert.equal(harness.el('targetLufs').disabled, true);
  assert.equal(harness.el('settingsError').classList.contains('hidden'), false);
  // The values on screen are the markup defaults, and nothing was saved.
  assert.equal(harness.el('settingsError').textContent, harness.message('settingsLoadFailed'));
  // Deleting every channel is offered over a list that was never read, and the
  // page must not answer how many are saved either.
  assert.equal(harness.el('clearAllBtn').disabled, true);
  assert.equal(harness.el('emptyMsg').style.display, 'none');
  assert.equal(harness.el('select:.channel-table').style.display, 'none');
});

test('the failed-read message describes the read, not the values on screen', async () => {
  // A change that lands while the read is still out is rendered before the read
  // fails, so the screen can hold a stored value under the failure message.
  const harness = createOptionsHarness({ deferStorage: true, failStorage: true });
  await flushTasks(8);
  harness.fireStorageChanged({ [u.SETTINGS_KEY]: { newValue: { targetLufs: -24 } } });
  await flushTasks(4);
  harness.releaseStorage();
  await flushTasks(8);
  assert.equal(harness.el('targetLufsValue').textContent, '-24 LUFS');
  assert.equal(harness.el('settingsError').textContent, harness.message('settingsLoadFailed'));
  // The change carried no channels, so the page still has none to answer with.
  assert.equal(harness.el('emptyMsg').style.display, 'none');
  assert.equal(harness.el('select:.channel-table').style.display, 'none');
  assert.equal(harness.el('clearAllBtn').disabled, true);

  const ja = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json')));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/en/messages.json')));
  assert.equal(ja.settingsLoadFailed.message, '保存済みの設定を読み込めませんでした。ページを再読み込みしてください');
  assert.equal(en.settingsLoadFailed.message, 'Could not load the saved settings. Please reload the page.');
});

test('a channel change that lands during the read is what the page shows', async () => {
  const harness = createOptionsHarness({
    channelVolumes: { 123: { name: 'stalechannel', login: 'stalechannel', gainLive: 1.5 } },
    deferStorage: true
  });
  await flushTasks(8);
  harness.fireStorageChanged({
    [u.CHANNEL_VOLUMES_KEY]: {
      newValue: { 456: { name: 'freshchannel', login: 'freshchannel', gainLive: 2 } }
    }
  });
  await flushTasks(4);
  assert.ok(harness.el('channelsBody').textContent.includes('freshchannel'));
  assert.equal(harness.el('select:.channel-table').style.display, '');

  harness.releaseStorage();
  await flushTasks(8);
  // The read was issued before the change was written, so what it returns is
  // the older list and may not replace what the change already put up.
  assert.ok(harness.el('channelsBody').textContent.includes('freshchannel'));
  assert.ok(!harness.el('channelsBody').textContent.includes('stalechannel'));
});

test('a channel change that arrived before the read failed stays on the page', async () => {
  const harness = createOptionsHarness({ deferStorage: true, failStorage: true });
  await flushTasks(8);
  harness.fireStorageChanged({
    [u.CHANNEL_VOLUMES_KEY]: {
      newValue: { 456: { name: 'freshchannel', login: 'freshchannel', gainLive: 2 } }
    }
  });
  await flushTasks(4);
  harness.releaseStorage();
  await flushTasks(8);
  // The change carried the list itself, so the page has read it. What failed is
  // the settings read, and it does not take the list back off the screen.
  assert.ok(harness.el('channelsBody').textContent.includes('freshchannel'));
  assert.equal(harness.el('select:.channel-table').style.display, '');
  assert.equal(harness.el('emptyMsg').style.display, 'none');
  assert.equal(harness.el('settingsError').textContent, harness.message('settingsLoadFailed'));
  // It is still a page asking to be reloaded, so it offers nothing destructive:
  // neither the button that empties the list nor the one on the row.
  assert.equal(harness.el('clearAllBtn').disabled, true);
  assert.match(harness.el('channelsBody').textContent, /class="ch-del"[^>]*\bdisabled\b/);
});

test('a load that never answers ends the same way a failed one does', async () => {
  const harness = createOptionsHarness({
    settings: { targetLufs: -24 },
    channelVolumes: { 123: { name: 'somechannel', login: 'somechannel', gainLive: 1.5 } },
    deferStorage: true
  });
  await flushTasks(8);
  assert.ok(harness.body.classList.contains('initializing'), 'hidden while the read is out');
  assert.deepEqual(harness.timers.map((timer) => timer.delay), [3000]);

  harness.fireTimers();
  await flushTasks(8);
  // The page is shown as one whose load did not arrive: the markup values, the
  // failure message, and nothing offered that acts on what it never read.
  assert.equal(harness.body.classList.contains('initializing'), false);
  assert.equal(harness.el('settingsError').textContent, harness.message('settingsLoadFailed'));
  assert.equal(harness.el('targetLufsValue').textContent, '');
  assert.equal(harness.el('targetLufs').disabled, true);
  assert.equal(harness.el('clearAllBtn').disabled, true);
  assert.equal(harness.el('emptyMsg').style.display, 'none');
  assert.equal(harness.el('select:.channel-table').style.display, 'none');

  harness.releaseStorage();
  await flushTasks(8);
  // The read arriving afterwards does not fill the page in behind that.
  assert.equal(harness.el('targetLufsValue').textContent, '');
  assert.equal(harness.el('channelsBody').textContent, '');
  assert.equal(harness.el('targetLufs').disabled, true);
});

test('a page that could not read keeps what another tab writes off its screen', async () => {
  const harness = createOptionsHarness({ failStorage: true });
  await flushTasks(8);

  harness.fireStorageChanged({
    [u.SETTINGS_KEY]: { newValue: { targetLufs: -24, displayUnit: 'dB', showGainOverlay: false } }
  });
  await flushTasks(4);
  // The message asks for the page to be reloaded, so nothing that arrives in
  // the meantime is put on it: a settings write from another tab carries no
  // channels, and its values would stand on a page whose read never landed.
  assert.equal(harness.el('targetLufsValue').textContent, '');
  assert.equal(harness.el('settingsError').textContent, harness.message('settingsLoadFailed'));
  assert.equal(harness.el('emptyMsg').style.display, 'none');
  assert.equal(harness.el('select:.channel-table').style.display, 'none');
  assert.equal(harness.el('clearAllBtn').disabled, true);
});

test('options fill and show the page when the channel normalization fails', async () => {
  const harness = createOptionsHarness({
    settings: { targetLufs: -24 },
    failMutation: true
  });
  await flushTasks(8);
  assert.deepEqual(harness.sent.map((message) => message.mutation.operation), ['normalizeChannels']);
  // The settings read does not depend on it, so the page carries the stored
  // values rather than staying hidden behind a service worker that is gone.
  assert.equal(harness.body.classList.contains('initializing'), false);
  assert.equal(harness.el('targetLufsValue').textContent, '-24 LUFS');
  assert.equal(harness.el('targetLufs').disabled, false);
});

test('popup disables Manual and Apply controls while an Auto update is pending', () => {
  const source = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  // Each condition is asserted on its own: a snapshot of the whole expression
  // stops holding the moment another condition joins it.
  assert.match(
    source,
    /const manualDisabled = [^;]*\bautoUpdatePending\b[^;]*;/
  );
  assert.match(
    source,
    /const manualDisabled = [^;]*\bcurrentAutoApplyLoudness\b[^;]*;/
  );
  assert.match(source, /if \(autoUpdatePending\) \$\('applyBtn'\)\.disabled = true;/);
  assert.match(
    source,
    /async function applyMeasured\(\) \{\s*if \(autoUpdatePending \|\|/s
  );
  assert.match(
    source,
    /async function setGain\(percent\) \{\s*if \(autoUpdatePending[^)]*\) return;/s
  );
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

test('popup keeps the apply label on one line and owns the Current card once', () => {
  const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  // The hint caps the row width, so a wrapping label grows the section instead
  // of the button taking room from the hint.
  assert.match(html, /\.apply-btn\s*\{[^}]*white-space:\s*nowrap;/s);
  // A wider hint pushes its own text to a third line, which moves the section
  // height; 9px keeps it at two lines next to the one-line label.
  assert.match(html, /\.apply-hint\s*\{[^}]*font-size:\s*9px;/s);

  // WCAG 2.1 SC 1.4.3: muted text against the panel it sits on. Both sides are
  // read from the stylesheet so a background change cannot pass unnoticed.
  const MUTED = [
    ['.settings-link', 'body'],
    ['.channel-name.empty', '.info-section'],
    ['.reset-measurement-btn:disabled', '.info-section'],
    ['.apply-hint', 'body'],
    ['.loudness-card .value.unknown', '.loudness-card'],
    ['.status-msg', 'body']
  ];
  assertContrastFloor(html, MUTED, 4.5);

  const source = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  const start = source.indexOf('const actualGain =');
  const body = source.slice(start, source.indexOf('syncInteractionDisabledState();', start));
  assert.ok(start > -1 && body.length > 0);
  // Exactly one of the two paths writes the card: syncSlider, or the else arm.
  assert.match(body, /syncSlider\(actualGain\);/);
  assert.match(body, /\} else \{[\s\S]*setCardValue\(\$\('current'\)/);
  assert.equal((body.match(/setCardValue\(\$\('current'\)/g) || []).length, 1);
  assert.match(source, /function syncSlider\(gain\) \{[\s\S]*?setCardValue\(\$\('current'\)/);
});

test('options keeps muted text above the AA contrast floor', () => {
  const html = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
  assertContrastFloor(html, [
    ['.setting-row .setting-desc', '.section'],
    ['.channel-table th', '.section'],
    ['.empty-msg', '.section'],
    ['.ch-del', '.section'],
    ['.ch-vol.empty', '.section'],
    ['.toggle-group button', '.toggle-group button']
  ], 4.5);
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

test('popup declares the player audio notice with its localized text', () => {
  const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  assert.match(
    html,
    /<div id="audioError" class="audio-error hidden" role="status" data-i18n="audioUnavailable">[^<]+<\/div>/
  );
  // WCAG 2.1 SC 1.4.3: the notice sits on the info panel.
  assertContrastFloor(html, [['.audio-error', '.info-section']], 4.5);

  const ja = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json')));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '_locales/en/messages.json')));
  for (const [locale, messages] of [['ja', ja], ['en', en]]) {
    for (const key of ['audioUnavailable', 'audioContextUnavailable', 'measurementUnavailable']) {
      assert.ok(messages[key]?.message, `${locale} declares ${key}`);
    }
  }
});

test('popup states unavailable player audio and locks what would not reach it', async () => {
  const harness = createPopupHarness({
    state: {
      audioUnavailable: true,
      hasSavedMeasurement: true,
      lufs: { momentary: -21, shortTerm: -21, integrated: -21 }
    }
  });
  await flushTasks(8);

  assert.equal(harness.el('audioError').classList.contains('hidden'), false);
  assert.equal(harness.el('audioError').textContent, harness.message('audioUnavailable'));
  // The notice carries the reason, so the hint does not repeat it.
  assert.equal(harness.el('applyHint').textContent, '');
  assert.equal(harness.el('applyBtn').disabled, true);
  assert.equal(harness.el('manualSlider').disabled, true);
  assert.equal(harness.el('manualSection').classList.contains('disabled'), true);
  assert.deepEqual(harness.presets.map((button) => button.disabled), [true, true, true, true, true, true]);
  assert.equal(harness.el('autoApplyToggle').disabled, true);
  // Resetting would drop the saved measurement with nothing able to rebuild it.
  assert.equal(harness.el('resetMeasurementBtn').disabled, true);
  // The saved gain is a setting here, not the level the player runs at, and
  // the measurement stopped where it stopped.
  assert.ok(harness.el('current').className.includes('unknown'));
  assert.ok(harness.el('integrated').className.includes('unknown'));
  assert.ok(harness.el('suggested').className.includes('unknown'));
  // The label offers a gain the viewer would not hear applied.
  assert.equal(harness.el('applyBtn').textContent, harness.message('applyToChannel'));
});

test('popup sends nothing from the controls it locked', async () => {
  const harness = createPopupHarness({
    state: {
      audioUnavailable: true,
      hasSavedMeasurement: true,
      lufs: { momentary: -21, shortTerm: -21, integrated: -21 }
    }
  });
  await flushTasks(8);
  harness.sent.length = 0;

  // The DOM attribute is one poll behind the state, so each handler is driven
  // directly here.
  await harness.fire('applyBtn', 'click');
  await harness.firePreset(3, 'click');
  await harness.fire('manualSlider', 'change');
  await harness.fire('resetMeasurementBtn', 'click');

  assert.deepEqual(harness.sent.filter((request) => request.cmd !== 'getState'), []);
});

test('popup restores its controls when the bridge attaches', async () => {
  const harness = createPopupHarness({
    state: { audioUnavailable: true, hasSavedMeasurement: true }
  });
  await flushTasks(8);
  assert.equal(harness.el('manualSlider').disabled, true);

  harness.setState({
    audioUnavailable: false,
    lufs: { momentary: -21, shortTerm: -21, integrated: -21 }
  });
  await harness.poll();

  assert.equal(harness.el('audioError').classList.contains('hidden'), true);
  assert.equal(harness.el('manualSlider').disabled, false);
  assert.equal(harness.el('autoApplyToggle').disabled, false);
  assert.equal(harness.el('resetMeasurementBtn').disabled, false);
  assert.equal(harness.el('applyBtn').disabled, false);
  assert.ok(!harness.el('current').className.includes('unknown'));
});

test('popup names the failure it was told about', async () => {
  const harness = createPopupHarness({
    state: { audioUnavailable: true, audioUnavailableCause: 'audio-context' }
  });
  await flushTasks(8);
  assert.equal(
    harness.el('audioError').textContent,
    harness.message('audioContextUnavailable')
  );

  harness.setState({ audioUnavailableCause: 'element-taken' });
  await harness.poll();
  assert.equal(harness.el('audioError').textContent, harness.message('audioUnavailable'));
});

test('popup separates a stalled measurement from unreachable audio', async () => {
  const harness = createPopupHarness({ state: { measurementUnavailable: true } });
  await flushTasks(8);

  assert.equal(harness.el('audioError').classList.contains('hidden'), false);
  assert.equal(harness.el('audioError').textContent, harness.message('measurementUnavailable'));
  // The hint would otherwise keep announcing the measurement that stalled.
  assert.equal(harness.el('applyHint').textContent, '');
  // Gain still reaches the player on this path, so Manual stays usable.
  assert.equal(harness.el('manualSlider').disabled, false);
  assert.equal(harness.el('applyBtn').disabled, true);
  assert.ok(!harness.el('current').className.includes('unknown'));
});

test('popup keeps both notices off a page with no channel', async () => {
  const harness = createPopupHarness({
    state: { audioUnavailable: true, channel: { id: '', kind: 'none' } }
  });
  await flushTasks(8);

  assert.equal(harness.el('audioError').classList.contains('hidden'), true);
  assert.equal(harness.el('applyHint').textContent, harness.message('channelNotDetected'));
});

test('popup keeps a failed save visible while the audio notice stands', async () => {
  const harness = createPopupHarness({
    failGainSave: true,
    state: { lufs: { momentary: -21, shortTerm: -21, integrated: -21 } }
  });
  await flushTasks(8);

  await harness.firePreset(3, 'click');
  assert.equal(harness.el('applyHint').textContent, harness.message('gainSaveFailed'));

  harness.setState({ audioUnavailable: true });
  await harness.poll();
  // The viewer's own last action still reads back, and Apply stays out of reach.
  assert.equal(harness.el('applyHint').textContent, harness.message('gainSaveFailed'));
  assert.equal(harness.el('applyBtn').disabled, true);
  assert.equal(harness.el('audioError').classList.contains('hidden'), false);
});

test('popup turns the Auto toggle down while the player audio is unavailable', async () => {
  const harness = createPopupHarness({ state: { audioUnavailable: true } });
  await flushTasks(8);

  harness.el('autoApplyToggle').checked = true;
  await harness.fire('autoApplyToggle', 'change');

  assert.equal(harness.sent.some((request) => request.cmd === 'setAutoApplyLoudness'), false);
  assert.equal(harness.el('autoApplyToggle').checked, false);
});

test('popup disables Manual while an Auto save is in flight', async () => {
  const harness = createPopupHarness({
    deferAutoSave: true,
    state: { lufs: { momentary: -21, shortTerm: -21, integrated: -21 } }
  });
  await flushTasks(8);
  assert.equal(harness.el('manualSlider').disabled, false);

  harness.el('autoApplyToggle').checked = true;
  const pending = harness.fire('autoApplyToggle', 'change');
  await flushTasks(4);
  assert.equal(harness.el('manualSlider').disabled, true);
  assert.equal(harness.el('applyBtn').disabled, true);
  assert.deepEqual(harness.presets.map((button) => button.disabled), [true, true, true, true, true, true]);

  await harness.releaseAutoSave();
  await pending;
  assert.equal(harness.el('manualSlider').disabled, true, 'Auto ON keeps Manual disabled');
});

test('popup offers Apply only once a measurement exists', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  // The suggestion is unity without a measurement, so its finiteness cannot be
  // what enables the button: applying it would overwrite a saved manual gain.
  assert.doesNotMatch(source, /Number\.isFinite\(lastSuggestedGain\) && ch\.id/);

  const harness = createPopupHarness();
  await flushTasks(8);
  assert.equal(harness.el('applyBtn').disabled, true);
  assert.equal(harness.el('applyHint').textContent, harness.message('hintNoLufs'));

  harness.setState({ lufs: { momentary: -21, shortTerm: -21, integrated: -21 } });
  await harness.poll();
  assert.equal(harness.el('applyBtn').disabled, false);
  const suggested = u.formatGain(u.suggestedGain(-21, -18), '%');
  assert.ok(
    harness.el('applyBtn').textContent.includes(suggested.text + suggested.unit),
    harness.el('applyBtn').textContent
  );
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

// Importing the module resolves the font, so this answers both of the things
// the run below needs: Pillow, and the one face the generator will accept.
const generatorImport = spawnSync('python3', ['-B', '-c',
  "import importlib.util, sys;" +
  "spec = importlib.util.spec_from_file_location('g', 'gen_screenshots.py');" +
  "m = importlib.util.module_from_spec(spec);" +
  "spec.loader.exec_module(m)"
], { cwd: __dirname, encoding: 'utf8' });
// The generator answers 3 where it cannot draw — no Pillow, no face — and that
// is the only reading that means "not here". Anything else is the generator
// itself being broken, which the runs below are there to catch, so they run.
const generatorReason = (generatorImport.stderr || '').trim().split('\n').pop() || 'python3 failed';
const generatorSkip = generatorImport.error || generatorImport.status === 3
  ? 'gen_screenshots.py cannot draw here: ' + generatorReason
  : false;

test('gen_screenshots.py imports, or says it cannot draw here', () => {
  assert.ok(generatorImport.error === undefined || generatorSkip,
    'python3 could not be run: ' + generatorReason);
  assert.ok([0, 3].includes(generatorImport.status),
    `importing gen_screenshots.py exited ${generatorImport.status}: ${generatorReason}`);
});

// Drawing all six before replacing any is only half of it: the replacement is
// six moves, and a run that stops among them leaves some of the tracked images
// from this run and the rest from the last one.
const INJECT_MOVE_FAILURE = [
  'import hashlib, importlib.util, os, shutil, sys, tempfile',
  'fail_at = int(sys.argv[1])',
  'when = sys.argv[2]',
  "seeded = sys.argv[3] == '1'",
  'repo = os.getcwd()',
  'def digests(d):',
  "    return {n: hashlib.sha256(open(os.path.join(d, n), 'rb').read()).hexdigest()",
  '            for n in sorted(os.listdir(d))}',
  'with tempfile.TemporaryDirectory() as sandbox:',
  "    script = os.path.join(sandbox, 'gen_screenshots.py')",
  "    source = open(os.path.join(repo, 'gen_screenshots.py'), encoding='utf-8').read()",
  '    # The run has to draw something other than what is on disk, or a partial',
  '    # replacement cannot be told from a finished one.',
  "    source = source.replace('WHITE = (255, 255, 255)', 'WHITE = (254, 254, 254)', 1)",
  "    open(script, 'w', encoding='utf-8').write(source)",
  '    # The faces are resolved beside the script, so the copy needs them too.',
  "    shutil.copytree(os.path.join(repo, 'tools'), os.path.join(sandbox, 'tools'))",
  "    out = os.path.join(sandbox, 'docs', 'screenshots')",
  '    os.makedirs(out)',
  "    tracked = os.path.join(repo, 'docs', 'screenshots')",
  '    if seeded:',
  '        for name in os.listdir(tracked):',
  '            shutil.copy2(os.path.join(tracked, name), os.path.join(out, name))',
  '    before = digests(out)',
  "    spec = importlib.util.spec_from_file_location('gen_under_test', script)",
  '    gen = importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(gen)',
  "    calls = {'n': 0}",
  '    real_move = shutil.move',
  '    def flaky_move(src, dst, *a, **k):',
  "        calls['n'] += 1",
  "        hit = calls['n'] == fail_at",
  "        if hit and when == 'before':",
  "            raise OSError('injected before the move')",
  '        result = real_move(src, dst, *a, **k)',
  '        if hit:',
  '            # The rename is done and the caller has not recorded it yet.',
  "            raise KeyboardInterrupt('interrupted after the move')",
  '        return result',
  '    gen.shutil.move = flaky_move',
  '    try:',
  '        gen.main()',
  '    except BaseException as error:',
  '        escaped = str(error)',
  '    else:',
  "        print('the injected failure never fired')",
  '        raise SystemExit(2)',
  '    gen.shutil.move = real_move',
  '    after = digests(out)',
  '    # The interrupted move renamed in one mode and not in the other.',
  "    done = calls['n'] - 1 if when == 'before' else calls['n']",
  '    changed = [n for n in before if before[n] != after.get(n)]',
  '    added = [n for n in after if n not in before]',
  "    print('%s move %d: moves completed %d, changed %d, added %d'",
  '          % (when, fail_at, done, len(changed), len(added)))',
  '    if done < 1:',
  "        print('nothing had been moved, so the run proves nothing')",
  '        raise SystemExit(3)',
  '    # A rollback that raises on its own way out buries what actually failed.',
  "    if 'injected' not in escaped and 'interrupted' not in escaped:",
  "        print('the failure that escaped was not the injected one: ' + escaped)",
  '        raise SystemExit(4)',
  '    raise SystemExit(1 if changed or added else 0)'
].join('\n');

test('store screenshot generator leaves the tracked images alone when a replacement fails',
  { skip: generatorSkip }, () => {
    // 'before' needs an earlier move to have landed; 'after' lands the one it
    // interrupts, so the first is already worth injecting into.
    for (const [when, positions] of [['before', ['2', '4', '6']], ['after', ['1', '2', '4', '6']]]) {
      for (const failAt of positions) {
        // Once with the six already there, once on a first run with nothing to
        // restore - rollback removes what it put down instead of copying back.
        for (const seeded of ['1', '0']) {
          const run = spawnSync('python3',
            ['-B', '-c', INJECT_MOVE_FAILURE, failAt, when, seeded],
            { cwd: __dirname, encoding: 'utf8' });
          const report = (run.stdout || '').trim();
          assert.equal(run.status, 0, when + ' move ' + failAt +
            (seeded === '1' ? ' over the tracked six' : ' on a first run') +
            ': ' + report + (run.stderr || ''));
        }
      }
    }
  });

// The images the generator writes are tracked and the README shows three of
// them, so where it writes, what it draws with, and when it replaces them are
// all part of what the repository carries. CI draws them too and compares the
// pixels, which is what the shape asserted here has to hold up under.
test('store screenshot generator writes the tracked directory, and only whole', () => {
  const source = fs.readFileSync(path.join(__dirname, 'gen_screenshots.py'), 'utf8');

  // Resolved from the script rather than the caller, so the destination does
  // not follow whoever ran it.
  assert.match(source, /^ROOT = os\.path\.dirname\(os\.path\.abspath\(__file__\)\)$/m);
  assert.match(source, /^OUT_DIR = os\.path\.join\(ROOT, 'docs', 'screenshots'\)$/m);

  const saves = [...source.matchAll(/^\s*img\.save\((.+)\)$/gm)].map((match) => match[1]);
  assert.equal(saves.length, 3);
  for (const argument of saves) {
    // Scenes write to the directory they are handed, so a run that fails part
    // way through leaves the tracked files as they were.
    assert.match(argument, /^os\.path\.join\(out_dir, /, argument);
    assert.ok(!argument.includes('OUT_DIR'), argument);
  }
  // Beside the destination, so each move is a rename within one filesystem.
  assert.match(source, /with tempfile\.TemporaryDirectory\(dir=out_dir\) as staging:/);
  // main hands the staging directory over rather than moving anything itself.
  assert.match(source, /for name in replace_all\(staging, out_dir\):/);
  const replaceAll = source.slice(source.indexOf('def replace_all('), source.indexOf('def main('));
  assert.match(replaceAll, /except BaseException:/);
  // Recorded before the move is attempted: a run interrupted once the rename
  // has happened still has that name to put back.
  assert.ok(replaceAll.indexOf('attempted.append(name)') <
    replaceAll.indexOf('shutil.move('), 'the name is recorded before the move');
  assert.match(replaceAll, /shutil\.copy2\(os\.path\.join\(backup, name\), os\.path\.join\(out_dir, name\)\)/);
  assert.match(replaceAll, /os\.remove\(os\.path\.join\(out_dir, name\)\)/);
  assert.match(replaceAll, /raise$/m);

  // One named face per weight, carried in the repository: a fallback chain
  // would redraw all six wherever a different font resolved first, and a face
  // outside the repository puts the machine that ran it into the images.
  const faces = [...source.matchAll(/^FONT_(?:REGULAR|BOLD)_FILE = os\.path\.join\(FONT_DIR, '(.+)'\)$/gm)]
    .map((m) => m[1]);
  assert.equal(faces.length, 2);
  assert.deepEqual([...new Set(faces)].length, 2);
  const fontDir = source.match(/^FONT_DIR = os\.path\.join\(ROOT, '([^']+)', '([^']+)'\)$/m);
  assert.ok(fontDir, 'FONT_DIR is resolved from the repository root');
  for (const face of faces) {
    assert.ok(fs.existsSync(path.join(__dirname, fontDir[1], fontDir[2], face)),
      `${fontDir[1]}/${fontDir[2]}/${face} is the face the tracked images were drawn with`);
  }
  // Pillow picks raqm where it is installed and places the strings differently,
  // so the runner and this machine would disagree on every image.
  assert.match(source, /^\s*BASIC_LAYOUT = ImageFont\.Layout\.BASIC$/m);
  assert.match(source, /layout_engine=BASIC_LAYOUT/);
  // The reading that means "not here" — the suite skips on it, so its value is
  // part of the contract.
  assert.match(source, /^UNAVAILABLE = 3$/m);
  assert.match(source, /sys\.exit\(UNAVAILABLE\)/);
  assert.ok(!source.includes('ImageFont.load_default()'), 'no silent fallback face');
});

// Only the run itself answers whether the tracked images are the ones this
// code draws; the shape above cannot. CI installs Pillow and runs the same
// command as its own step.
test('tracked store screenshots are what the generator draws', { skip: generatorSkip }, () => {
  const run = spawnSync('python3', ['-B', 'gen_screenshots.py', '--check'],
    { cwd: __dirname, encoding: 'utf8' });
  assert.equal(run.status, 0,
    ((run.stdout || '') + (run.stderr || '')).trim() || 'gen_screenshots.py --check failed');
});

// A run over a matching tree says nothing about what --check rejects, so the
// runs below hand it trees it has to turn down. Each gets its own copy: the
// script, the faces it resolves beside itself, and the six images.
function screenshotSandbox() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tcv-shots-'));
  fs.copyFileSync(path.join(__dirname, 'gen_screenshots.py'),
    path.join(sandbox, 'gen_screenshots.py'));
  fs.cpSync(path.join(__dirname, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.cpSync(path.join(__dirname, 'docs/screenshots'), path.join(sandbox, 'docs/screenshots'),
    { recursive: true });
  return sandbox;
}

function runCheck(sandbox) {
  return spawnSync('python3', ['-B', 'gen_screenshots.py', '--check'],
    { cwd: sandbox, encoding: 'utf8' });
}

test('--check turns down a tracked image that is not what the code draws',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      assert.equal(runCheck(sandbox).status, 0, 'the copy starts out matching');

      // One pixel, one channel: the smallest difference the comparison has to
      // see, and the one a tolerance would swallow first.
      const target = path.join(sandbox, 'docs/screenshots/popup_ja.png');
      const flip = spawnSync('python3', ['-B', '-c',
        'import sys; from PIL import Image;' +
        'i = Image.open(sys.argv[1]).convert("RGB");' +
        'p = i.getpixel((320, 200));' +
        'i.putpixel((320, 200), (p[0] ^ 1, p[1], p[2]));' +
        'i.save(sys.argv[1])', target], { encoding: 'utf8' });
      assert.equal(flip.status, 0, 'the probe rewrote one pixel: ' + (flip.stderr || ''));

      const run = runCheck(sandbox);
      assert.equal(run.status, 1, 'a changed pixel is reported: ' + (run.stderr || run.stdout));
      assert.match(run.stderr, /popup_ja\.png/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check turns down a tracked image changed only in its alpha',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      const target = path.join(sandbox, 'docs/screenshots/popup_ja.png');
      // The three colour channels stay where they were, so a comparison that
      // drops alpha sees two identical images.
      assert.equal(spawnSync('python3', ['-B', '-c',
        'import sys; from PIL import Image;' +
        'i = Image.open(sys.argv[1]).convert("RGBA");' +
        'r, g, b, _ = i.getpixel((320, 200));' +
        'i.putpixel((320, 200), (r, g, b, 0));' +
        'i.save(sys.argv[1])', target], { encoding: 'utf8' }).status, 0,
      'the probe made one pixel transparent');

      const run = runCheck(sandbox);
      assert.equal(run.status, 1, 'a transparent pixel is reported: ' + (run.stderr || run.stdout));
      assert.match(run.stderr, /popup_ja\.png/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check turns down a size the code no longer draws', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    const target = path.join(sandbox, 'docs/screenshots/settings_en.png');
    // Cropping keeps every pixel the comparison would overlay, so only a size
    // of its own can catch it.
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import sys; from PIL import Image;' +
      'Image.open(sys.argv[1]).crop((0, 0, 320, 200)).save(sys.argv[1])', target],
    { encoding: 'utf8' }).status, 0, 'the probe cropped the image');

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'a cropped image is reported: ' + (run.stderr || run.stdout));
    // Named as a size rather than as a difference: every pixel that survived
    // the crop still matches, and reading "違う" would send the reader looking
    // for the wrong thing.
    assert.match(run.stderr, /settings_en\.png: 大きさが違う/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check names a tracked image nothing draws, and leaves the rest alone',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      fs.copyFileSync(path.join(sandbox, 'docs/screenshots/popup_ja.png'),
        path.join(sandbox, 'docs/screenshots/popup_de.png'));
      const run = runCheck(sandbox);
      assert.equal(run.status, 1, 'an image nothing draws is reported');
      assert.match(run.stderr, /popup_de\.png/);

      // What macOS and an interrupted run leave behind are not tracked images.
      fs.rmSync(path.join(sandbox, 'docs/screenshots/popup_de.png'));
      fs.writeFileSync(path.join(sandbox, 'docs/screenshots/.DS_Store'), '');
      fs.mkdirSync(path.join(sandbox, 'docs/screenshots/tmpabc123'));
      const after = runCheck(sandbox);
      assert.equal(after.status, 0,
        'neither .DS_Store nor a leftover staging directory is a tracked image: ' +
        (after.stderr || after.stdout));
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check says it cannot draw here rather than passing', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    fs.rmSync(path.join(sandbox, 'tools'), { recursive: true });
    const run = runCheck(sandbox);
    assert.equal(run.status, 3, 'a missing face is 3, not 0 and not 1');
    assert.match(run.stderr, /MPLUS1p-Regular\.ttf/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--out writes where it is told, and nowhere else', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  const before = fs.readdirSync(path.join(sandbox, 'docs/screenshots')).sort()
    .map((name) => [name, fs.readFileSync(path.join(sandbox, 'docs/screenshots', name))]);
  try {
    const elsewhere = path.join(sandbox, 'elsewhere');
    const run = spawnSync('python3', ['-B', 'gen_screenshots.py', '--out', elsewhere],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(run.status, 0, (run.stderr || '') + (run.stdout || ''));
    assert.deepEqual(fs.readdirSync(elsewhere).sort(), before.map(([name]) => name));
    for (const [name, bytes] of before) {
      assert.ok(bytes.equals(fs.readFileSync(path.join(sandbox, 'docs/screenshots', name))),
        `${name} in the tracked directory is untouched`);
    }

    // The one word that decides between reading and rewriting is not matched
    // loosely: a near miss is an argument error, not a redraw.
    const typo = spawnSync('python3', ['-B', 'gen_screenshots.py', '--chek'],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(typo.status, 2, 'an unknown argument is refused: ' + (typo.stderr || ''));
    for (const [name, bytes] of before) {
      assert.ok(bytes.equals(fs.readFileSync(path.join(sandbox, 'docs/screenshots', name))),
        `${name} is untouched by the refused run`);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('CI uploads the screenshots the runner drew, not the ones it checked out', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '.github/workflows/ci.yaml'), 'utf8');
  assert.match(workflow, /run: python3 gen_screenshots\.py --check/);
  const redrawInto = workflow.match(/gen_screenshots\.py --out (.+)/);
  const uploads = workflow.match(/path: (.+)\n\s+if-no-files-found/);
  assert.ok(redrawInto && uploads, 'the redraw and the upload each name a directory');
  const dir = (text) => text.trim().replace(/\/$/, '');
  assert.equal(dir(uploads[1]), dir(redrawInto[1]), 'the upload takes the directory that was redrawn');
  assert.ok(!redrawInto[1].includes('docs/screenshots'),
    'the redraw does not write over the tracked images');
  // A condition without a status function is treated as success-only, so it
  // would never run after the step it answers to has failed.
  assert.match(workflow, /if: failure\(\) && steps\.screenshots\.conclusion == 'failure'/);
  assert.match(workflow, /if: failure\(\) && steps\.redraw\.conclusion == 'success'/);
  // A condition on a step id that no step carries is never true, and the job is
  // already red by then, so nothing points it out.
  for (const [, id] of workflow.matchAll(/steps\.(\w+)\.conclusion/g)) {
    assert.match(workflow, new RegExp(`^\\s+id: ${id}$`, 'm'), `a step carries id: ${id}`);
  }
  // Uploading nothing is the case worth failing on: it means the redraw wrote
  // somewhere else.
  assert.match(workflow, /if-no-files-found: error/);
});

test('CI has Pillow before it runs the suite that needs it', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '.github/workflows/ci.yaml'), 'utf8');
  const installed = workflow.indexOf('pip install pillow==');
  const suite = workflow.indexOf('run: node test.js');
  assert.ok(installed > -1 && suite > -1, 'the workflow installs pillow and runs the suite');
  // The runs that hand the generator a tree it has to turn down skip
  // themselves where it cannot draw, and a skipped run holds nothing.
  assert.ok(installed < suite, 'pillow is installed before node test.js');
});

test('store screenshot generator mirrors the stylesheet muted colors', () => {
  const source = fs.readFileSync(path.join(__dirname, 'gen_screenshots.py'), 'utf8');
  const popup = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  const options = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
  const constant = (name) => {
    const match = source.match(new RegExp(`^${name} = \\((\\d+), (\\d+), (\\d+)\\)`, 'm'));
    assert.ok(match, `${name} is still declared`);
    return match.slice(1, 4).map(Number);
  };

  // The mock stands in for the real UI, so its fills track the stylesheets.
  assert.deepEqual(constant('HINT'), cssColor(popup, '.apply-hint', 'color'));
  assert.deepEqual(constant('HINT'), cssColor(options, '.setting-row .setting-desc', 'color'));
  assert.deepEqual(constant('HINT'), cssColor(options, '.toggle-group button', 'color'));
  assert.deepEqual(constant('GRAY'), cssColor(popup, '.loudness-card .label', 'color'));
  assert.deepEqual(constant('HINT'), cssColor(popup, '.settings-link', 'color'));

  // Every muted site the mock draws uses that colour.
  for (const call of [
    /s\['auto_hint'\], fill=HINT/,
    /draw\.text\(\(sx \+ 20, y \+ 18\), desc, fill=HINT/,
    /s\['col_channel'\], fill=HINT/,
    /draw\.text\(\(cxh, hy\), t, fill=HINT/,
    /v != '—' else HINT\)/,
    /'×', fill=HINT/,
    /'dB', fill=HINT/
  ]) {
    assert.match(source, call);
  }
  // The header gear is drawn as a glyph today and as strokes once #5 lands.
  assert.ok(
    /'⚙', fill=HINT/.test(source) ||
      /draw_gear\(draw, \(px \+ pw - 19, py \+ 20\), HINT\)/.test(source),
    'the popup header gear uses the stylesheet muted colour'
  );
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

test('content withdraws the gain badge while the player audio is unavailable', async () => {
  const harness = createContentHarness();
  await flushTasks();
  // The saved VOD gain for the harness channel.
  assert.equal(harness.gainBadgeText(), '50%');

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    reason: 'InvalidStateError: HTMLMediaElement already connected'
  });
  assert.equal(harness.gainBadgeText(), null);

  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'attached' });
  assert.equal(harness.gainBadgeText(), '50%');
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

test('store screenshot generator draws icons the bundled font lacks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'gen_screenshots.py'), 'utf8');
  // U+2699 and U+26F6 have no glyph in the fonts gen_screenshots.py loads, so
  // drawing them as text produces a tofu box in the store images.
  for (const glyph of ['\u2699', '\u26F6']) {
    assert.ok(!source.includes(glyph), `gen_screenshots.py still draws U+${glyph.codePointAt(0).toString(16).toUpperCase()} as text`);
  }
  assert.match(source, /def draw_gear\(/);
  assert.match(source, /def draw_fullscreen\(/);
  // The colour is the stylesheet's business; this test only asserts it is drawn.
  assert.match(source, /draw_gear\(draw, \(px \+ pw - 19, py \+ 20\), \w+\)/);
  assert.match(source, /draw_gear\(draw, \(W - 62, cy\), WHITE, radius=PLAYER_GEAR_RADIUS\)/);
  assert.match(source, /draw_fullscreen\(draw, \(W - 34, cy\), WHITE\)/);
  // The self-check has to run at the sizes production draws at, so both read
  // the same constants.
  for (const name of ['HEADER_GEAR_RADIUS', 'PLAYER_GEAR_RADIUS', 'FULLSCREEN_SIZE']) {
    assert.match(source, new RegExp(`^${name} = \\d+`, 'm'));
    assert.ok(
      new RegExp(`(?:radius|size)=${name}\\b`).test(source),
      `${name} is used as a drawing default or argument`
    );
  }

  // Source strings cannot tell an empty helper from a drawing one, so the
  // generator checks its own output; keep that check wired into every run.
  assert.match(source, /def verify_icons\(\):/);
  // ... and at those constants, not a size of its own choosing.
  const check = source.slice(source.indexOf('def verify_icons():'), source.indexOf('def draw_all('));
  assert.match(check, /for radius in \(HEADER_GEAR_RADIUS, PLAYER_GEAR_RADIUS\):/);
  assert.match(check, /size=FULLSCREEN_SIZE/);
  assert.match(source, /def main\(out_dir=OUT_DIR\):\n    verify_icons\(\)/);
  // --check draws the same six, so it runs the same self-check first.
  assert.match(source, /def check\(\):\n    """[^"]*"""\n    verify_icons\(\)/);
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

test('page bridge loads the worklet module from its own origin', async () => {
  const harness = createPageBridgeHarness();
  const own = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/audio-worklet.js';

  // page-bridge.js runs in the page's own world, so any script in the page can
  // send an init command, including one carrying another extension's module.
  await harness.dispatchCommand('init', {
    workletUrl: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/audio-worklet.js'
  });
  await harness.dispatchCommand('init', { workletUrl: 'https://ad.example/audio-worklet.js' });
  assert.deepEqual(harness.workletModules, [own]);

  // The forged commands must not cost the extension its own measurement.
  await harness.dispatchCommand('attach');
  harness.emitMeasurementBlock(0.05);
  assert.equal(typeof harness.messages.at(-1).integrated, 'number');

  // A later forged command cannot swap the module that is already loaded.
  await harness.dispatchCommand('init', {
    workletUrl: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/audio-worklet.js'
  });
  assert.deepEqual(harness.workletModules, [own]);
});

test('page bridge loads no module when it cannot name its own origin', async () => {
  const harness = createPageBridgeHarness({ scriptUrl: 'https://www.twitch.tv/inline-script.js' });

  await harness.dispatchCommand('init', {
    workletUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/audio-worklet.js'
  });
  await harness.dispatchCommand('attach');
  assert.deepEqual(harness.workletModules, []);
});

test('page bridge Integrated LUFS is invariant to gating window order', async () => {
  async function measure(blocks) {
    const harness = createPageBridgeHarness();
    await harness.startMeasurement();
    harness.messages.length = 0;
    for (const ms of blocks) harness.emitMeasurementBlock(ms);
    return harness.messages.at(-1).integrated;
  }

  // Spaced far enough apart that no window holds both loud sub-blocks, so
  // swapping them reorders the windows without changing the set.
  const quiet = 0.02;
  const forwardBlocks = [quiet, quiet, quiet, 1.0, quiet, quiet, quiet, 0.09, quiet, quiet, quiet];
  const reverseBlocks = [quiet, quiet, quiet, 0.09, quiet, quiet, quiet, 1.0, quiet, quiet, quiet];
  const sorted = (list) => gatingWindows(list).slice().sort((a, b) => a - b);
  assert.deepEqual(sorted(forwardBlocks), sorted(reverseBlocks));

  const forward = await measure(forwardBlocks);
  const reverse = await measure(reverseBlocks);
  const expected = expectedIntegrated(forwardBlocks);

  assert.ok(Math.abs(forward - expected) < 1e-12);
  assert.ok(Math.abs(reverse - expected) < 1e-12);
  assert.ok(Math.abs(forward - reverse) < 1e-12);
});

test('page bridge maintains the two-stage Integrated LUFS gate incrementally', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;

  const blocks = [0.01, 1.0, 0.001, 0.02, 0.5, 0.03, 0.04, 0.02, 0.05, 0.03, 0.02, 0.06];
  for (const ms of blocks) harness.emitMeasurementBlock(ms);

  const measurements = harness.messages.filter((message) => message.event === 'lufs');
  assert.equal(measurements.length, blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    assertLufsClose(measurements[i].integrated, expectedIntegrated(blocks.slice(0, i + 1)));
  }
  // Entering an ad rolls back the windows appended just before the marker.
  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(1.0);
  const kept = gatingWindows(blocks).slice(0, -AD_START_ROLLBACK);
  const expected = u.gatedIntegratedLufs(kept);
  assertLufsClose(harness.messages.at(-1).integrated, expected);

  await harness.dispatchCommand('setAdActive', { active: false });
  await harness.dispatchCommand('resetMeasurement');
  // Windows spanning the end of the ad stay out even across a reset: the
  // first three sub-blocks form no window, then four windows are dropped.
  for (let i = 0; i < 7; i++) harness.emitMeasurementBlock(0.25);
  assert.equal(harness.messages.at(-1).integrated, -Infinity);
  harness.emitMeasurementBlock(0.25);
  assert.equal(harness.messages.at(-1).integrated, u.meanSquareToLufs(0.25));
});

test('page bridge drops exactly the windows that span the end of an ad', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;

  // Long enough that the ad-start rollback cannot take every window.
  const content = Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.0005);
  for (const ms of content) harness.emitMeasurementBlock(ms);
  assert.ok(Number.isFinite(expectedIntegrated(content)));

  await harness.dispatchCommand('setAdActive', { active: true });
  const kept = gatingWindows(content).slice(0, -AD_START_ROLLBACK);
  assert.ok(kept.length > 0);
  const beforeAd = u.gatedIntegratedLufs(kept);
  harness.emitMeasurementBlock(1.0);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - beforeAd) < 1e-12);

  // The ad ends part-way through the next sub-block, so every window still
  // holding pre-boundary audio stays out.
  await harness.dispatchCommand('setAdActive', { active: false });
  for (let i = 0; i < 4; i++) {
    harness.emitMeasurementBlock(1.0);
    assert.ok(Math.abs(harness.messages.at(-1).integrated - beforeAd) < 1e-12);
  }

  // The fifth window is clear of the boundary and counts again.
  harness.emitMeasurementBlock(1.0);
  const expected = u.gatedIntegratedLufs([...kept, 1.0]);
  assert.ok(Math.abs(expected - beforeAd) > 0.1);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - expected) < 1e-12);
});

test('page bridge removes the windows appended before an ad was detected', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;

  const quietBlocks = 60;
  const adBlocks = 5;
  // A ramp, so removing a different number of windows lands somewhere else.
  const content = Array.from({ length: quietBlocks }, (_, i) => 0.01 + i * 0.0004);
  for (const ms of content) harness.emitMeasurementBlock(ms);
  const beforeAd = harness.messages.at(-1).integrated;

  // The ad's first audio reaches the gate before its DOM marker appears.
  for (let i = 0; i < adBlocks; i++) harness.emitMeasurementBlock(1.0);
  assert.ok(harness.messages.at(-1).integrated > beforeAd + 1);

  harness.logs.length = 0;
  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(1.0);
  // The cap leaves the oldest windows, which never saw the ad.
  const emittedAll = [...content, ...Array(adBlocks).fill(1.0)];
  const kept = gatingWindows(emittedAll).slice(0, -AD_START_ROLLBACK);
  assert.equal(kept.length, gatingWindows(emittedAll).length - AD_START_ROLLBACK);
  assertLufsClose(harness.messages.at(-1).integrated, u.gatedIntegratedLufs(kept));

  // The removed windows are reported so their level can be read.
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1].removed, AD_START_ROLLBACK);
  assert.equal(rollback[0][1].exhausted, true);
  // Oldest first, and the values are the windows that were actually removed.
  const removedWindows = gatingWindows(emittedAll)
    .slice(-AD_START_ROLLBACK)
    .map((window) => Number(u.meanSquareToLufs(window).toFixed(2)));
  // The log object comes from the script's realm, so copy before comparing.
  assert.deepEqual(Array.from(rollback[0][1].windowLufs), removedWindows);

  // Nothing is removed twice, and the seeded sample is never removed.
  const seeded = createPageBridgeHarness();
  await seeded.startMeasurement();
  await seeded.dispatchCommand('resetMeasurement', { initialIntegratedLufs: -20 });
  seeded.messages.length = 0;
  for (let i = 0; i < 4; i++) seeded.emitMeasurementBlock(1.0);
  await seeded.dispatchCommand('setAdActive', { active: true });
  seeded.emitMeasurementBlock(1.0);
  assert.ok(Math.abs(seeded.messages.at(-1).integrated - (-20)) < 1e-12);
});

test('page bridge starts a fresh gating window after the video is replaced', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;

  // Three sub-blocks of the old element: not a window yet.
  for (let i = 0; i < 3; i++) harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.at(-1).integrated, -Infinity);

  await harness.replaceVideo();
  for (let i = 0; i < 3; i++) harness.emitMeasurementBlock(0.01);
  assert.equal(harness.messages.at(-1).integrated, -Infinity);

  harness.emitMeasurementBlock(0.01);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - u.meanSquareToLufs(0.01)) < 1e-12);
});

test('page bridge does not take the recent content level out with the ad', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const ms = (lufs) => Math.pow(10, (lufs + 0.691) / 10);
  const emitted = [
    ...Array(60).fill(ms(-30)),
    ...Array(50).fill(ms(-15)),
    ...Array(AD_START_ROLLBACK).fill(ms(-10))
  ];
  for (const value of emitted) harness.emitMeasurementBlock(value);

  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(ms(-10));

  // Only the windows holding ad audio go. Reaching further back would take the
  // content that set the gate's population with them.
  const expected = u.gatedIntegratedLufs(gatingWindows(emitted).slice(0, -AD_START_ROLLBACK));
  assert.ok(expected > -20, 'the recent loud content drives the result');
  assertLufsClose(harness.messages.at(-1).integrated, expected);
});

test('page bridge rolls back after the ring buffer has started evicting', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const quiet = 0.01;
  const ringWindows = 60 * 60 * 10;
  for (let i = 0; i < ringWindows + 3; i++) harness.emitMeasurementBlock(quiet);
  harness.messages.length = 0;

  for (let i = 0; i < AD_START_ROLLBACK; i++) harness.emitMeasurementBlock(1.0);
  const contaminated = harness.messages.at(-1).integrated;
  assert.ok(contaminated > u.meanSquareToLufs(quiet) + 0.03);

  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(1.0);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - u.meanSquareToLufs(quiet)) < 1e-12);
});

test('page bridge counts rollback budget from the last reset only', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  for (let i = 0; i < 20; i++) harness.emitMeasurementBlock(0.5);

  await harness.dispatchCommand('resetMeasurement', { initialIntegratedLufs: -20 });
  harness.messages.length = 0;
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(1.0);

  harness.logs.length = 0;
  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(1.0);
  // One window existed since the reset; the seeded sample is not one of them.
  assert.ok(Math.abs(harness.messages.at(-1).integrated - (-20)) < 1e-12);

  // The span stops at the first window there is, so it never reaches as far
  // back as the budget asked for.
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1].requested, AD_START_ROLLBACK);
  assert.equal(rollback[0][1].removed, 1);
  assert.equal(rollback[0][1].exhausted, false);
});

test('page bridge rolls back once per ad, not once per detection', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  for (let i = 0; i < 20; i++) harness.emitMeasurementBlock(0.01);
  harness.messages.length = 0;
  harness.logs.length = 0;

  await harness.dispatchCommand('setAdActive', { active: true });
  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(1.0);
  const rollbacks = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollbacks.length, 1);
});

test('page bridge removes a window sitting exactly on the absolute gate', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const atGate = Math.pow(10, (-70 + 0.691) / 10);
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(atGate);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - (-70)) < 1e-12);

  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(atGate);
  // Removed from the index as well as the ring, or it haunts the gate forever.
  assert.equal(harness.messages.at(-1).integrated, -Infinity);
});

test('page bridge keeps a zero player volume out of the measurement', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.setVolume(0);
  for (let i = 0; i < 8; i++) harness.emitMeasurementBlock(0.01);

  // Dividing by a zero volume would put Infinity in the index, where it stays:
  // every later value reads back as -Infinity.
  harness.setVolume(1);
  for (let i = 0; i < 8; i++) harness.emitMeasurementBlock(0.01);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - u.meanSquareToLufs(0.01)) < 1e-9);
});

test('page bridge holds the boundary skip open across an ad', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.01);
  harness.setVolume(0.5);
  harness.logs.length = 0;

  await harness.dispatchCommand('setAdActive', { active: true });
  for (let i = 0; i < 6; i++) harness.emitMeasurementBlock(0.01);
  assert.equal(harness.logs.filter((e) => e[0] === '[TCV] gate resumed').length, 0);
});

test('page bridge restarts the skip count when a boundary re-arms', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.01);
  harness.setVolume(0.5);
  harness.logs.length = 0;

  harness.emitMeasurementBlock(0.01);
  harness.emitMeasurementBlock(0.01);
  harness.setVolume(0.4);
  for (let i = 0; i < 3; i++) harness.emitMeasurementBlock(0.01);
  assert.equal(harness.logs.filter((e) => e[0] === '[TCV] gate resumed').length, 0);
  harness.emitMeasurementBlock(0.01);
  const resumed = harness.logs.filter((e) => e[0] === '[TCV] gate resumed');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0][1].dropped, 6);
});

test('page bridge references the measurement to player volume 1.0', async () => {
  const harness = createPageBridgeHarness();
  harness.setVolume(0.5);
  await harness.startMeasurement();
  harness.messages.length = 0;

  const ms = 0.01;
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(ms);
  // Halving the player volume quarters the tapped mean square, so the
  // reported value is the same as at volume 1.0.
  assert.ok(Math.abs(harness.messages.at(-1).integrated - u.meanSquareToLufs(ms / 0.25)) < 1e-12);
  assert.ok(Math.abs(harness.messages.at(-1).momentary - u.meanSquareToLufs(ms / 0.25)) < 1e-12);
});

test('page bridge reports a boundary once, not once per volume step', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.01);
  harness.logs.length = 0;

  // A drag down the slider fires volumechange per step.
  for (let step = 100; step >= 90; step--) harness.setVolume(step / 100);
  const arms = harness.logs.filter((entry) => entry[0] === '[TCV] gate boundary');
  assert.equal(arms.length, 1);
  assert.equal(arms[0][1].reason, 'volume');

  for (let i = 0; i < 3; i++) harness.emitMeasurementBlock(0.01);
  assert.equal(harness.logs.filter((e) => e[0] === '[TCV] gate resumed').length, 0);
  harness.emitMeasurementBlock(0.01);
  const resumed = harness.logs.filter((entry) => entry[0] === '[TCV] gate resumed');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0][1].dropped, 4);
  assert.equal(resumed[0][1].windowLufs.length, 4);

  // A different boundary is still reported while a skip is armed, and carries
  // what the skip it replaced had dropped so far.
  harness.setVolume(0.5);
  harness.emitMeasurementBlock(0.01);
  harness.logs.length = 0;
  await harness.dispatchCommand('setAdActive', { active: true });
  await harness.dispatchCommand('setAdActive', { active: false });
  const adArms = harness.logs.filter((entry) => entry[0] === '[TCV] gate boundary');
  assert.equal(adArms.length, 1);
  assert.equal(adArms[0][1].reason, 'ad-end');
  assert.equal(adArms[0][1].superseded, 'volume');
  assert.equal(adArms[0][1].droppedBefore, 1);
});

test('page bridge ignores a volumechange that repeats the current value', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.01);
  harness.logs.length = 0;

  const armCount = () => harness.logs.filter((e) => e[0] === '[TCV] gate boundary').length;

  harness.setVolume(0.5);
  assert.equal(armCount(), 1);
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.01);
  assert.equal(harness.logs.filter((e) => e[0] === '[TCV] gate resumed').length, 1);
  harness.logs.length = 0;

  // The player rewriting the value it already had leaves the signal alone.
  harness.setVolume(0.5);
  harness.setVolume(0.5);
  assert.equal(armCount(), 0);
  harness.emitMeasurementBlock(0.01);
  assert.equal(harness.logs.filter((e) => e[0] === '[TCV] gate resumed').length, 0);

  // Muting changes the tapped signal without changing the volume value.
  harness.setMuted(true);
  assert.equal(armCount(), 1);
});

test('page bridge drops the windows that span a volume change', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;

  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.01);
  const beforeChange = harness.messages.at(-1).integrated;
  assert.ok(Math.abs(beforeChange - u.meanSquareToLufs(0.01)) < 1e-12);

  harness.setVolume(0.5);
  for (let i = 0; i < 4; i++) {
    harness.emitMeasurementBlock(0.01);
    assert.ok(Math.abs(harness.messages.at(-1).integrated - beforeChange) < 1e-12);
  }

  harness.emitMeasurementBlock(0.01);
  const expected = u.gatedIntegratedLufs([0.01, 0.04]);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - expected) < 1e-12);
});

test('page bridge applies the Integrated absolute boundary and re-evaluates the relative gate', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const absoluteGateMeanSquare = Math.pow(10, (-70 + 0.691) / 10);

  // A window one ULP below the absolute gate is excluded; NaN never reaches it.
  harness.emitMeasurementBlock(NaN);
  for (let i = 0; i < 4; i++) {
    harness.emitMeasurementBlock(absoluteGateMeanSquare * (1 - 1e-6));
  }
  let measurements = harness.messages.filter((message) => message.event === 'lufs');
  assert.equal(measurements.length, 4);
  assert.equal(measurements.at(-1).integrated, -Infinity);

  // A window exactly at the gate is kept.
  await harness.dispatchCommand('resetMeasurement');
  harness.messages.length = 0;
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(absoluteGateMeanSquare);
  assert.ok(Math.abs(harness.messages.at(-1).integrated - (-70)) < 1e-12);

  await harness.dispatchCommand('resetMeasurement');
  harness.messages.length = 0;
  const relativeBlocks = [1.0, 1.0, 1.0, 1.0, 0.1, 0.1, 0.1, 0.1, 0.055, 0.055, 0.055, 0.055];
  for (const ms of relativeBlocks) harness.emitMeasurementBlock(ms);

  measurements = harness.messages.filter((message) => message.event === 'lufs');
  for (let i = 0; i < relativeBlocks.length; i++) {
    assertLufsClose(measurements[i].integrated, expectedIntegrated(relativeBlocks.slice(0, i + 1)));
  }
  // The relative gate moved as the quiet windows arrived: the last window sits
  // below it and is excluded from the reported value.
  const windows = gatingWindows(relativeBlocks);
  assert.ok(u.gatedIntegratedLufs(windows) > u.meanSquareToLufs(windows.at(-1)));
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
    const expected = expectedIntegrated(blocks);
    if (expected === -Infinity) assert.equal(actual, -Infinity);
    else assert.ok(Math.abs(actual - expected) < 1e-10);
  }
});

test('page bridge indexed gate evicts the oldest block at the retained-window limit', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const maximumWindows = 60 * 60 * 10;
  const emitted = [];
  let randomState = 0x87654321;

  for (let i = 0; i < 128; i++) {
    randomState = (Math.imul(randomState, 1103515245) + 12345) >>> 0;
    const ms = 0.01 + randomState / 0xffffffff;
    emitted.push(ms);
    harness.emitMeasurementBlock(ms);
  }
  for (let i = 0; i < maximumWindows; i++) {
    const ms = 0.01 + i / maximumWindows;
    emitted.push(ms);
    harness.emitMeasurementBlock(ms);
    if (harness.messages.length > 1000) harness.messages.length = 0;
  }

  const actual = harness.messages.at(-1).integrated;
  const expected = u.gatedIntegratedLufs(gatingWindows(emitted).slice(-maximumWindows));
  assert.ok(Math.abs(actual - expected) < 1e-10);
});

// A seed that weighs one window is outweighed by the first second of the new
// session, which is what moved the Auto gain off the level it was applying.
test('page bridge weighs a saved LUFS by the windows it was measured over', async () => {
  const savedLufs = -20;
  const nextMeanSquare = 0.1;
  const savedMeanSquare = Math.pow(10, (savedLufs + 0.691) / 10);

  // [count stored with the value, windows the seed weighs, windows reported back]
  for (const [savedWindows, expectedSeed, expectedReported] of [
    [undefined, 300, 1], [1, 300, 2], [299, 300, 300], [300, 300, 301],
    [1200, 1200, 1201], [1800, 1800, 1800], [36000, 1800, 1800]
  ]) {
    const harness = createPageBridgeHarness();
    await harness.startMeasurement();
    harness.messages.length = 0;
    await harness.dispatchCommand('resetMeasurement', {
      initialIntegratedLufs: savedLufs,
      ...(savedWindows === undefined ? {} : { initialIntegratedWindows: savedWindows })
    });
    for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(nextMeanSquare);

    const expected = u.meanSquareToLufs(
      (savedMeanSquare * expectedSeed + nextMeanSquare) / (expectedSeed + 1)
    );
    const posted = harness.messages.at(-1);
    assert.ok(Math.abs(posted.integrated - expected) < 1e-12, `seed of ${savedWindows}`);
    // The floor is not a measurement, so it is not reported as one.
    assert.equal(posted.integratedWindows, expectedReported, `seed of ${savedWindows}`);
  }
});

test('page bridge ignores a saved window count it cannot read', async () => {
  const savedLufs = -20;
  const savedMeanSquare = Math.pow(10, (savedLufs + 0.691) / 10);
  const expected = u.meanSquareToLufs((savedMeanSquare * 300 + 0.1) / 301);

  for (const initialIntegratedWindows of [NaN, -5, 0, 1.5, '600', Infinity, null, {}]) {
    const harness = createPageBridgeHarness();
    await harness.startMeasurement();
    harness.messages.length = 0;
    await harness.dispatchCommand('resetMeasurement', {
      initialIntegratedLufs: savedLufs,
      initialIntegratedWindows
    });
    for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.1);

    const posted = harness.messages.at(-1);
    // A count that says nothing leaves the seed at the floor, still seeded.
    assert.ok(Math.abs(posted.integrated - expected) < 1e-12, String(initialIntegratedWindows));
    assert.equal(posted.integratedWindows, 1, String(initialIntegratedWindows));
  }
});

// Without the cap the seed loop runs once per claimed window, so a count this
// size does not come back at all.
test('page bridge holds the seed to what a seed may weigh', { timeout: 5000 }, async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  await harness.dispatchCommand('resetMeasurement', {
    initialIntegratedLufs: -20,
    initialIntegratedWindows: Number.MAX_SAFE_INTEGER
  });
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.1);

  const savedMeanSquare = Math.pow(10, (-20 + 0.691) / 10);
  const capped = 3 * 60 * 10;
  const expected = u.meanSquareToLufs((savedMeanSquare * capped + 0.1) / (capped + 1));
  assert.ok(Math.abs(harness.messages.at(-1).integrated - expected) < 1e-12);
  assert.equal(harness.messages.at(-1).integratedWindows, capped);
});

test('page bridge lets new windows displace a seed at the cap', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const capped = 3 * 60 * 10;
  // Within the relative gate of the audio that follows, so the seed stays in
  // the value and the count stays at what it came in with.
  await harness.dispatchCommand('resetMeasurement', {
    initialIntegratedLufs: -12,
    initialIntegratedWindows: capped
  });
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.5);
  const first = harness.messages.at(-1).integrated;
  for (let i = 0; i < 20; i++) harness.emitMeasurementBlock(0.5);
  const later = harness.messages.at(-1);

  assert.equal(later.integratedWindows, capped);
  assert.ok(later.integrated > first, `${later.integrated} vs ${first}`);
});

// The index keys on the level, so audio holding the level the seed sits at
// lands on the seed's own key. Which entries are the seed's is a matter of
// where they came from, not of what they are worth.
test('page bridge counts audio that holds the level the seed sits at', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const level = Math.pow(10, (-18 + 0.691) / 10);
  await harness.dispatchCommand('resetMeasurement', {
    initialIntegratedLufs: -18,
    initialIntegratedWindows: 100
  });

  // Sixty seconds of it: 597 windows, each landing on the seed's key.
  for (let i = 0; i < 600; i++) harness.emitMeasurementBlock(level);

  const posted = harness.messages.at(-1);
  assert.ok(Math.abs(posted.integrated - u.meanSquareToLufs(level)) < 1e-12);
  assert.equal(posted.integratedWindows, 100 + 597);
});

// The ring evicts what it can no longer hold, and silence evicts without
// putting anything in the index in return. What the value stands on shrinks
// with it, and a count kept alongside the index rather than read from it does
// not.
test('page bridge reports what the index holds after the ring turns over', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const ring = 60 * 60 * 10;
  const loud = Math.pow(10, (-18 + 0.691) / 10);
  // A claim under the floor again, so what the ring gives back is visible in
  // the count rather than cancelling against the claim.
  await harness.dispatchCommand('resetMeasurement', {
    initialIntegratedLufs: -18,
    initialIntegratedWindows: 100
  });

  for (let i = 0; i < ring; i++) harness.emitMeasurementBlock(loud);
  harness.messages.length = 0;
  // Silence reaches the ring but not the index, so it pushes the index empty.
  for (let i = 0; i < ring; i++) harness.emitMeasurementBlock(0);
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(loud);

  assert.equal(harness.messages.at(-1).integratedWindows, 4);
});

// A seed the relative gate leaves out carried none of the value, so it is not
// part of what the value stands on either.
test('page bridge stops counting a seed the relative gate left out', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  const seedMeanSquare = Math.pow(10, (-33 + 0.691) / 10);
  const loudMeanSquare = Math.pow(10, (-18 + 0.691) / 10);
  // A claim under the floor, so the seed's own entries outnumber what it says
  // the value stands on: what the gate does with them is then visible.
  await harness.dispatchCommand('resetMeasurement', {
    initialIntegratedLufs: -33,
    initialIntegratedWindows: 100
  });

  // While the seed still holds the gate up, it is inside the value.
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(loudMeanSquare);
  assert.equal(harness.messages.at(-1).integratedWindows, 101);

  // Thirty seconds of audio 15 dB above it puts the seed under the gate.
  for (let i = 0; i < 296; i++) harness.emitMeasurementBlock(loudMeanSquare);
  const posted = harness.messages.at(-1);
  assert.ok(Math.abs(posted.integrated - u.meanSquareToLufs(loudMeanSquare)) < 1e-12);
  assert.equal(posted.integratedWindows, 297);
  assert.ok(seedMeanSquare < loudMeanSquare);
});

test('page bridge counts the windows behind the value it posts', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.messages.length = 0;
  // Three blocks make no gating window, so nothing stands behind Integrated.
  for (let i = 0; i < 3; i++) harness.emitMeasurementBlock(0.1);
  assert.equal(harness.messages.at(-1).integrated, -Infinity);
  assert.equal(harness.messages.at(-1).integratedWindows, 0);

  for (let i = 0; i < 10; i++) harness.emitMeasurementBlock(0.1);
  assert.equal(harness.messages.at(-1).integratedWindows, 10);

  // Windows under the absolute gate are not among them: of the 8 that silence
  // makes, the 3 still holding audio from the blocks before it are counted.
  for (let i = 0; i < 8; i++) harness.emitMeasurementBlock(0);
  assert.equal(harness.messages.at(-1).integratedWindows, 13);
});

test('page bridge keeps an ad rollback out of the windows a seed stands for', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  await harness.dispatchCommand('resetMeasurement', {
    initialIntegratedLufs: -20,
    initialIntegratedWindows: 400
  });
  for (let i = 0; i < 6; i++) harness.emitMeasurementBlock(0.1);
  assert.equal(harness.messages.at(-1).integratedWindows, 403);

  // The DOM indicator asks for 5 windows back; this session has appended 3.
  await harness.dispatchCommand('setAdActive', { active: true });
  harness.emitMeasurementBlock(0.1);
  assert.equal(harness.messages.at(-1).integratedWindows, 400);
});

test('page bridge keeps retrying past a held element and reports it is still there', async () => {
  const harness = createPageBridgeHarness({ mediaElementSourceTaken: true, extraFreeVideo: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');
  const failures = harness.messages.filter((message) => message.event === 'attach-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].cause, 'element-taken');
  assert.equal(harness.messages.some((message) => message.event === 'attached'), false);

  // The retry loop is still armed, so the next tick reaches the free element.
  await harness.runTimers();
  const attached = harness.messages.filter((message) => message.event === 'attached');
  assert.equal(attached.length, 1);
  // The held element is still on the page and still the one being listened to.
  assert.equal(attached[0].takenElsewhere, true);
  assert.equal(attached[0].measuring, true);
});

test('page bridge stops naming a held element once it leaves the page', async () => {
  const harness = createPageBridgeHarness({ mediaElementSourceTaken: true, extraFreeVideo: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');
  harness.disconnectTakenVideo();

  await harness.runTimers();
  const attached = harness.messages.filter((message) => message.event === 'attached');
  assert.equal(attached.length, 1);
  assert.equal(attached[0].takenElsewhere, false);
});

test('page bridge reports an attach whose measurement chain never came up', async () => {
  const harness = createPageBridgeHarness({ workletLoadFails: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  const attached = harness.messages.filter((message) => message.event === 'attached');
  assert.equal(attached.length, 1);
  // Gain reaches the player; only the measurement path is missing.
  assert.equal(attached[0].measuring, false);
  assert.equal(attached[0].takenElsewhere, false);
});

test('page bridge attaches again after the player element is replaced', async () => {
  const harness = createPageBridgeHarness({ extraFreeVideo: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');
  assert.equal(harness.messages.filter((message) => message.event === 'attached').length, 1);

  // Twitch swaps the element on a quality change with no navigation, and the
  // attach loop stopped itself when the first attach succeeded.
  harness.disconnectTakenVideo();
  await harness.runTimers();

  assert.equal(harness.messages.filter((message) => message.event === 'attached').length, 2);
});

test('page bridge reports a context it could not create and builds a new one after', async () => {
  const harness = createPageBridgeHarness({ audioContextThrows: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  const failures = harness.messages.filter((message) => message.event === 'attach-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'audio context unavailable');
  // A context that would not start is not another script holding the element.
  assert.equal(failures[0].cause, 'audio-context');
  // One report per state, not one per retry.
  await harness.runTimers();
  assert.equal(harness.messages.filter((message) => message.event === 'attach-failed').length, 1);

  harness.allowAudioContext();
  await harness.runTimers();
  const attached = harness.messages.filter((message) => message.event === 'attached');
  assert.equal(attached.length, 1);
  assert.equal(attached[0].measuring, true);
});

test('page bridge takes the element once when two attach ticks overlap', async () => {
  const harness = createPageBridgeHarness({ deferWorkletLoad: true });
  const init = harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');
  // A second tick enters while the first is still waiting for the context.
  // Both are parked inside attach(), so neither call can be awaited yet.
  const secondTick = harness.runTimers();
  await flushTasks(4);
  assert.equal(harness.messages.some((message) => message.event === 'attached'), false);

  await harness.releaseWorkletLoad();
  await Promise.all([init, secondTick]);

  // Taking the same element twice throws, and the throw is the extension's own
  // doing: reporting it would lock the popup for the rest of the session.
  assert.equal(harness.mediaSourceCalls(), 1);
  assert.equal(harness.messages.filter((message) => message.event === 'attached').length, 1);
  assert.deepEqual(harness.messages.filter((message) => message.event === 'attach-failed'), []);
});

test('page bridge withdraws the held-element report once that element is gone', async () => {
  const harness = createPageBridgeHarness({ mediaElementSourceTaken: true, extraFreeVideo: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');
  await harness.runTimers();
  let attached = harness.messages.filter((message) => message.event === 'attached');
  assert.equal(attached.length, 1);
  assert.equal(attached[0].takenElsewhere, true);

  // The page drops the held element; nothing stands between the gain node and
  // the player any more.
  harness.disconnectTakenVideo();
  await harness.runTimers();

  attached = harness.messages.filter((message) => message.event === 'attached');
  assert.equal(attached.length, 2);
  assert.equal(attached[1].takenElsewhere, false);
  // Level-triggered, not a per-sweep repost.
  await harness.runTimers();
  assert.equal(harness.messages.filter((message) => message.event === 'attached').length, 2);
});

test('page bridge builds a retried context at the gain the ad calls for', async () => {
  const harness = createPageBridgeHarness({ audioContextThrows: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');
  assert.equal(harness.gainValue(), null);

  await harness.dispatchCommand('setGain', { value: 0.5 });
  await harness.dispatchCommand('setAdGain', { value: 0.5 });
  await harness.dispatchCommand('setAdActive', { active: true });

  harness.allowAudioContext();
  await harness.runTimers();
  assert.equal(harness.gainValue(), 0.25);
});

test('page bridge reports a taken media element once and stays silent after', async () => {
  const harness = createPageBridgeHarness({ mediaElementSourceTaken: true });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  assert.equal(harness.messages.filter((message) => message.event === 'attach-failed').length, 1);
  assert.equal(harness.messages.some((message) => message.event === 'attached'), false);

  // The retry loop skips the element it already failed on. content.js therefore
  // holds the reported state until an attach succeeds, including across SPA
  // navigation that keeps the same <video>.
  harness.messages.length = 0;
  await harness.runTimers();
  await harness.dispatchCommand('attach');
  await harness.runTimers();
  assert.deepEqual(harness.messages, []);

  // Positive control: the same drive on a free element does report an attach.
  const available = createPageBridgeHarness();
  await available.dispatchCommand('init');
  available.messages.length = 0;
  await available.dispatchCommand('attach');
  await available.runTimers();
  assert.equal(available.messages.some((message) => message.event === 'attached'), true);
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
    for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.25);
    assert.equal(harness.messages.at(-1).integrated, u.meanSquareToLufs(0.25));
  }

  const boundaryHarness = createPageBridgeHarness();
  await boundaryHarness.startMeasurement();
  boundaryHarness.messages.length = 0;
  await boundaryHarness.dispatchCommand('resetMeasurement', { initialIntegratedLufs: -70 });
  for (let i = 0; i < 4; i++) boundaryHarness.emitMeasurementBlock(0);
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

test('page bridge listens to the workers the page creates', () => {
  const harness = createPageBridgeHarness();
  const url = 'blob:https://www.twitch.tv/player';
  const options = { type: 'classic', name: 'media' };
  harness.createWorker(url, options);
  // The worker is created from what the page passed, untouched.
  assert.deepEqual(harness.workerCalls.at(-1), { url, options });
  assert.equal(harness.workerListeners.filter((entry) => entry.type === 'message').length, 1);
});

test('page bridge takes the break from the cue the player posts', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const content = Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.0004);
  for (const ms of content) harness.emitMeasurementBlock(ms);
  harness.setPlayhead(100);

  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, true);
  // The cue arrived with the ad's first audio, so one window held it.
  const kept = gatingWindows(content).slice(0, -1);
  const duringAd = u.gatedIntegratedLufs(kept);
  for (let i = 0; i < 20; i++) harness.emitMeasurementBlock(1.0);
  assertLufsClose(harness.messages.at(-1).integrated, duringAd);

  // The break runs until the playhead passes the end the cue gave.
  harness.setPlayhead(115.1);
  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, true);

  harness.logs.length = 0;
  harness.setPlayhead(115.3);
  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, false);
  const arms = harness.logs.filter((entry) => entry[0] === '[TCV] gate boundary');
  assert.equal(arms.length, 1);
  assert.equal(arms[0][1].reason, 'ad-end');
});

test('page bridge ignores a cue whose break does not hold the playhead', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.setPlayhead(304.69);
  harness.messages.length = 0;

  // The page runs a second player during a break and cues its ads on its own
  // clock; those bounds are nowhere near this element's playhead.
  harness.emitPlayerCue({ rollType: 'midroll', startTime: 11.966, endTime: 42.201, duration: 30.235 });
  assert.equal(harness.messages.filter((message) => message.event === 'ad').length, 0);

  // Nothing was accepted, so the indicator is still what decides.
  await harness.dispatchCommand('setAdActive', { active: true });
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, true);
});

test('page bridge removes the windows appended between the ad and its cue', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const content = Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.0004);
  for (const ms of content) harness.emitMeasurementBlock(ms);

  // The ad has been playing for 0.35 s when its cue arrives.
  harness.setPlayhead(100.35);
  harness.logs.length = 0;
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1].requested, 4);
  assert.equal(rollback[0][1].removed, 4);
  harness.emitMeasurementBlock(1.0);
  const kept = gatingWindows(content).slice(0, -4);
  assertLufsClose(harness.messages.at(-1).integrated, u.gatedIntegratedLufs(kept));
});

test('page bridge asks the rollback only for the windows the gate took', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  // A short measurement, where taking four windows instead of one leaves the
  // gate with the quietest window alone.
  const content = [0.0001, 0.0001, 0.0001, 0.0001, 0.1, 0.1, 0.1, 0.1];
  for (const ms of content) harness.emitMeasurementBlock(ms);
  const windows = gatingWindows(content);
  assert.equal(windows.length, 5);

  // Muting arms a boundary skip, and the ad's first audio lands inside it, so
  // three of the windows the rollback spans were never appended.
  harness.setMuted(true);
  for (let i = 0; i < 3; i++) harness.emitMeasurementBlock(1.0);

  harness.setPlayhead(100.35);
  harness.logs.length = 0;
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1].requested, 4);
  assert.equal(rollback[0][1].skipped, 3);
  assert.equal(rollback[0][1].removed, 1);

  harness.emitMeasurementBlock(1.0);
  const kept = u.gatedIntegratedLufs(windows.slice(0, -1));
  const overRemoved = u.gatedIntegratedLufs(windows.slice(0, -4));
  assert.ok(kept - overRemoved > 10, `${kept} vs ${overRemoved}`);
  assertLufsClose(harness.messages.at(-1).integrated, kept);
});

test('page bridge counts only the skipped windows the rollback reaches', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const content = [0.0001, 0.0001, 0.0001, 0.0001, 0.1, 0.1, 0.1, 0.1];
  for (const ms of content) harness.emitMeasurementBlock(ms);
  const windows = gatingWindows(content);

  // The skip runs out four windows before the cue arrives, so the two windows
  // the rollback spans are ad audio that was appended.
  harness.setMuted(true);
  for (let i = 0; i < 6; i++) harness.emitMeasurementBlock(1.0);

  harness.setPlayhead(100.15);
  harness.logs.length = 0;
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1].requested, 2);
  assert.equal(rollback[0][1].skipped, 0);
  assert.equal(rollback[0][1].removed, 2);

  harness.emitMeasurementBlock(1.0);
  const kept = u.gatedIntegratedLufs(windows);
  const adLeftIn = u.gatedIntegratedLufs([...windows, 1.0]);
  assert.ok(adLeftIn - kept > 3, `${kept} vs ${adLeftIn}`);
  assertLufsClose(harness.messages.at(-1).integrated, kept);
});

test('page bridge counts a span it fully covered even with nothing to remove', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const content = [0.0001, 0.0001, 0.0001, 0.0001, 0.1, 0.1, 0.1, 0.1];
  for (const ms of content) harness.emitMeasurementBlock(ms);
  const windows = gatingWindows(content);

  // Muting drops every window the rollback is about to span, so there is
  // nothing left in the ring for it to take.
  harness.setMuted(true);
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(1.0);

  harness.setPlayhead(100.35);
  harness.logs.length = 0;
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1].requested, 4);
  assert.equal(rollback[0][1].skipped, 4);
  assert.equal(rollback[0][1].removed, 0);
  // The span reached its first window; removing none of them is the answer,
  // not a removal that stopped short.
  assert.equal(rollback[0][1].exhausted, true);

  harness.emitMeasurementBlock(1.0);
  assertLufsClose(harness.messages.at(-1).integrated, u.gatedIntegratedLufs(windows));
});

// A slider drag re-arms the boundary skip on every block, so every window over
// the drag is dropped rather than appended, and the cue that follows names a
// break that started where the drag did.
async function draggedThroughAdStart(dragged) {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const content = [0.000001, 0.000001, 0.000001, 0.000001, 1, 1, 1, 1];
  for (const ms of content) harness.emitMeasurementBlock(ms);
  for (let i = 0; i < dragged; i++) {
    // A repeat of the value it already had does not re-arm the skip.
    harness.setVolume(1 - (i % 8 + 1) / 100);
    harness.emitMeasurementBlock(1.0);
  }

  harness.setPlayhead(100 + dragged * 0.1 + 0.01);
  harness.logs.length = 0;
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 200, duration: 100,
    podPosition: 0, podCount: 1
  });
  harness.emitMeasurementBlock(1.0);
  return { harness, windows: gatingWindows(content) };
}

test('page bridge counts every window a long drag kept out of the ring', async () => {
  // However long the drag, the rollback takes only the window the ad's own
  // audio reached. The two lengths straddle the size a bounded record of the
  // dropped windows holds, where the oldest of them is the one that goes
  // missing and a content window is taken in its place.
  for (const dragged of [64, 65]) {
    const where = `over ${dragged} windows`;
    const { harness, windows } = await draggedThroughAdStart(dragged);
    const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
    assert.equal(rollback.length, 1, where);
    assert.equal(rollback[0][1].requested, dragged + 1, where);
    assert.equal(rollback[0][1].skipped, dragged, where);
    assert.equal(rollback[0][1].removed, 1, where);

    // Only the window the ad's own audio reached goes; the one before it is
    // the level the gate's population rests on.
    const kept = u.gatedIntegratedLufs(windows.slice(0, -1));
    const overRemoved = u.gatedIntegratedLufs(windows.slice(0, -2));
    assert.ok(kept - overRemoved > 1, `${kept} vs ${overRemoved}`);
    assertLufsClose(harness.messages.at(-1).integrated, kept);
  }
});

test('page bridge extends a break when the next creative is cued', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  for (let i = 0; i < 40; i++) harness.emitMeasurementBlock(0.01);
  harness.setPlayhead(300);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 299.967, endTime: 315.184, duration: 15.217,
    podPosition: 0, podCount: 2
  });

  harness.logs.length = 0;
  harness.setPlayhead(315.39);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 315.238, endTime: 346.47, duration: 31.232,
    podPosition: 1, podCount: 2
  });
  // The break did not restart, so nothing is rolled back a second time.
  assert.equal(harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback').length, 0);
  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, true);

  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, true);
  harness.setPlayhead(346.5);
  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, false);
});

test('page bridge only ever moves the end of a break forward', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(300);

  // The pod and the creative it starts with are both cued at the same moment.
  harness.emitPlayerCue({ rollType: 'midroll', startTime: 300, endTime: 346.47, duration: 46.47 });
  harness.emitPlayerCue({ rollType: 'midroll', startTime: 300, endTime: 315.18, duration: 15.18 });

  harness.setPlayhead(320);
  harness.emitMeasurementBlock(0.01);
  assert.equal(adState().active, true);
});

test('page bridge takes a cue only from a message that names a roll type', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.setPlayhead(100);
  harness.messages.length = 0;

  // Other player messages carry a start and an end without cueing an ad.
  harness.emitPlayerCue({ startTime: 90, endTime: 200 });
  assert.equal(harness.messages.filter((message) => message.event === 'ad').length, 0);
});

test('page bridge ends the break by the cue even when the indicator stays', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.setPlayhead(100);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  await harness.dispatchCommand('setAdActive', { active: true });
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, true);

  // The indicator is never taken out of the page; the cue still ends the break.
  harness.setPlayhead(115.3);
  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, false);
});

test('page bridge applies the ad gain to the element a client-side ad plays in', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  await harness.dispatchCommand('setGain', { value: 2 });
  await harness.dispatchCommand('setAdGain', { value: 0.5 });
  harness.setVolume(0.5);
  const before = harness.gainNodes.length;

  // The measured element pauses and the ad plays in its own element, at its own
  // volume rather than the player's.
  harness.setPaused(true);
  const silent = harness.addVideo({ volume: 1, muted: true });
  const adVideo = harness.addVideo({ volume: 1 });
  await harness.dispatchCommand('setAdActive', { active: true });

  assert.ok(harness.sourcedElements.includes(adVideo));
  // An element with nothing to hear is left where it is.
  assert.equal(harness.sourcedElements.includes(silent), false);
  assert.equal(harness.gainNodes.length, before + 1);
  const node = harness.gainNodes.at(-1);
  // 2 (channel) x 0.5 (ad) x 0.5/1 (the player's volume against the element's).
  assert.ok(Math.abs(node.gain.value - 0.5) < 1e-9, `gain ${node.gain.value}`);

  // The break ends and the element is handed back untouched.
  await harness.dispatchCommand('setAdActive', { active: false });
  assert.ok(Math.abs(node.gain.value - 1) < 1e-9);

  // Once it leaves the page the chain goes with it.
  harness.removeVideo(adVideo);
  harness.emitMeasurementBlock(0.01);
  assert.equal(node.disconnected, true);
});

test('page bridge leaves another element alone while the measured one plays', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const before = harness.gainNodes.length;

  // A stitched ad stays in the element already attached, and the page shows a
  // muted preview of the stream beside it.
  const preview = harness.addVideo({ volume: 1, muted: true });
  const other = harness.addVideo({ volume: 1 });
  harness.setPlayhead(100);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  harness.emitMeasurementBlock(0.01);

  assert.equal(harness.sourcedElements.includes(preview), false);
  assert.equal(harness.sourcedElements.includes(other), false);
  assert.equal(harness.gainNodes.length, before);
});

test('page bridge does not measure an element it holds for an ad', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.setPaused(true);
  const adVideo = harness.addVideo({ volume: 1 });
  await harness.dispatchCommand('setAdActive', { active: true });
  assert.ok(harness.sourcedElements.includes(adVideo));

  // The player swaps its element while the ad element is still on the page.
  harness.removeVideo(harness.currentVideo());
  harness.addVideo({ src: 'https://example.test/next', volume: 0.25 });
  harness.logs.length = 0;
  await harness.dispatchCommand('attach');
  const attached = harness.logs.filter((entry) => entry[0] === '[TCV] attached to video');
  assert.equal(attached.length, 1);
  // The volume says which element it took: the ad element is at 1.
  assert.equal(attached[0][1].volume, 0.25);
});

test('page bridge measures on when the Worker constructor cannot be wrapped', async () => {
  const harness = createPageBridgeHarness({ frozenWorker: true });
  await harness.startMeasurement();
  harness.createWorker('blob:https://www.twitch.tv/player');
  assert.equal(harness.workerListeners.length, 0);

  // No cue can arrive, so the indicator is what decides, and the measurement
  // runs as it always did.
  for (let i = 0; i < 4; i++) harness.emitMeasurementBlock(0.25);
  assertLufsClose(harness.messages.at(-1).integrated, u.meanSquareToLufs(0.25));
  await harness.dispatchCommand('setAdActive', { active: true });
  assert.equal(harness.messages.filter((message) => message.event === 'ad').at(-1).active, true);
});

test('page bridge keeps the break the player cued across a measurement reset', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(100);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  assert.equal(adState().active, true);

  // The popup can reset the measurement, and an owner id can resolve, in the
  // middle of a break on the same media.
  await harness.dispatchCommand('resetMeasurement');
  assert.equal(adState().active, true);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);

  harness.setPlayhead(115.3);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, false);
});

test('page bridge drops the cued break when the media changes', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(100);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  assert.equal(adState().active, true);

  await harness.dispatchCommand('mediaChanged');
  assert.equal(adState().active, false);

  // The next media may be a VOD, whose ads are cued nowhere, so the indicator
  // is the only signal again and it carries its own delay.
  for (let i = 0; i < 60; i++) harness.emitMeasurementBlock(0.01 + i * 0.0004);
  harness.logs.length = 0;
  await harness.dispatchCommand('setAdActive', { active: true });
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback[0][1].requested, AD_START_ROLLBACK);
});

test('page bridge does not open the break before the cue says it starts', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  const content = Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.0004);
  for (const ms of content) harness.emitMeasurementBlock(ms);

  // A cue can name a break the playhead has not reached yet.
  harness.setPlayhead(99.5);
  harness.logs.length = 0;
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  assert.equal(harness.messages.filter((message) => message.event === 'ad').length, 0);
  harness.emitMeasurementBlock(1.0);
  assert.equal(harness.messages.filter((message) => message.event === 'ad').length, 0);
  assert.equal(harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback').length, 0);

  // It opens where the cue said it would, and takes out only the window that
  // spans the start.
  harness.setPlayhead(100.05);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);
  const rollback = harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback');
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1].requested, 1);
});

test('page bridge does not reopen a finished break when the playhead moves back', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(100);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  harness.setPlayhead(115.3);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, false);

  harness.setPlayhead(50);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, false);

  // Nor when it moves back into the range the break had.
  harness.setPlayhead(110);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, false);
});

test('page bridge keeps the start of the break the first cue gave', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(100);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  assert.equal(adState().active, true);

  // The next creative of the pod can be cued just before it starts.
  harness.setPlayhead(109.5);
  harness.emitPlayerCue({ rollType: 'midroll', startTime: 110, endTime: 130, duration: 20 });
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);
});

test('page bridge lets the indicator speak again after the element is replaced', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(100);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 100, endTime: 115.2, duration: 15.2,
    podPosition: 0, podCount: 1
  });
  assert.equal(adState().active, true);

  // A new element carries a timeline nothing has cued against yet.
  await harness.replaceVideo();
  assert.equal(adState().active, false);
  await harness.dispatchCommand('setAdActive', { active: true });
  assert.equal(adState().active, true);
});

test('page bridge does not carry the indicator of the old media into the new one', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  await harness.dispatchCommand('setAdActive', { active: true });
  assert.equal(adState().active, true);

  // The indicator can still be in the page when the next media starts.
  await harness.dispatchCommand('mediaChanged');
  assert.equal(adState().active, false);
});

test('page bridge holds the break across the gap between two creatives', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(300);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 299.967, endTime: 315.184, duration: 15.217,
    podPosition: 0, podCount: 2
  });
  assert.equal(adState().active, true);

  // A measurement block lands between the end of the first creative and the cue
  // for the next one.
  harness.setPlayhead(315.2);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);

  harness.logs.length = 0;
  harness.setPlayhead(315.39);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 315.238, endTime: 346.47, duration: 31.232,
    podPosition: 1, podCount: 2
  });
  // The break never ended, so nothing is rolled back a second time.
  assert.equal(harness.logs.filter((entry) => entry[0] === '[TCV] ad start rollback').length, 0);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);

  // The last creative of the pod does end it.
  harness.setPlayhead(346.5);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, false);
});

test('page bridge ends a pod of one at the end its cue gave', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(0);
  harness.emitPlayerCue({
    rollType: 'preroll', startTime: 0, endTime: 15.217, duration: 15.217,
    podPosition: 0, podCount: 1
  });
  assert.equal(adState().active, true);

  harness.setPlayhead(15.3);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, false);
});

test('page bridge does not wait forever for a creative that is never cued', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(300);
  harness.emitPlayerCue({
    rollType: 'midroll', startTime: 299.967, endTime: 315.184, duration: 15.217,
    podPosition: 0, podCount: 2
  });

  harness.setPlayhead(315.3);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);

  // The next cue never comes; the break does not hang on it.
  harness.setPlayhead(315.7);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, false);
});

test('page bridge holds the break across a gap when the cue names no pod', async () => {
  const harness = createPageBridgeHarness();
  const adState = () => harness.messages.filter((message) => message.event === 'ad').at(-1);
  await harness.startMeasurement();
  harness.setPlayhead(300);
  // The cue carries no pod counters, so the pod is not known to be over.
  harness.emitPlayerCue({ rollType: 'midroll', startTime: 299.967, endTime: 315.184, duration: 15.217 });
  assert.equal(adState().active, true);

  harness.setPlayhead(315.2);
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);

  harness.setPlayhead(315.39);
  harness.emitPlayerCue({ rollType: 'midroll', startTime: 315.238, endTime: 346.47, duration: 31.232 });
  harness.emitMeasurementBlock(1.0);
  assert.equal(adState().active, true);
});

// Ad state asked for after the bridge was told the media changed - the part
// that speaks about the media now playing.
function afterMediaChanged(harness) {
  const start = harness.commands.findIndex((command) => command.cmd === 'mediaChanged');
  assert.ok(start >= 0, 'the media was never declared changed');
  return harness.commands
    .slice(start)
    .filter((command) => command.cmd === 'setAdActive')
    .map((command) => command.active);
}

test('content ignores the indicator of the old media until it clears', async () => {
  const harness = createContentHarness();
  const sent = () => harness.commands.filter((command) => command.cmd === 'setAdActive');
  await flushTasks();
  harness.setAdNodePresent(true);
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);

  harness.commands.length = 0;
  await harness.navigate('https://www.twitch.tv/videos/200');
  assert.deepEqual(sent(), []);

  // The player being left is still in the page, and something else in the page
  // changes before it goes.
  harness.mutate();
  assert.deepEqual(sent(), []);

  // It goes with that player, and the new media's own ad is what gets reported.
  harness.setAdNodePresent(false);
  harness.mutate();
  harness.setAdNodePresent(true);
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);
});

test('content takes the first ad of the new media when the old one showed none', async () => {
  const harness = createContentHarness();
  const sent = () => harness.commands.filter((command) => command.cmd === 'setAdActive');
  await flushTasks();

  // Nothing was playing an ad on the media that ends.
  await harness.navigate('https://www.twitch.tv/videos/200');
  harness.commands.length = 0;

  // The first change on the new media brings its own ad.
  harness.setAdNodePresent(true);
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);
});

test('content takes an indicator that replaced the old one in the same batch', async () => {
  const harness = createContentHarness();
  const sent = () => harness.commands.filter((command) => command.cmd === 'setAdActive');
  await flushTasks();
  harness.setAdNodePresent(true);
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);

  harness.commands.length = 0;
  await harness.navigate('https://www.twitch.tv/videos/200');
  assert.deepEqual(sent(), []);

  // The observer batches: the indicator of the media that ended goes and the
  // new one arrives between two callbacks, so the page is never seen without
  // one.
  harness.replaceAdNode();
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);
});

test('content takes an ad the page swaps in while the route is changing', async () => {
  const harness = createContentHarness();
  const sent = () => harness.commands.filter((command) => command.cmd === 'setAdActive');
  await flushTasks();
  harness.setAdNodePresent(true);
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);

  harness.commands.length = 0;
  // The page tears the old player down and builds the new one in the same task
  // as the route change, so the swap lands before the extension's microtask.
  await harness.navigate('https://www.twitch.tv/videos/200', () => harness.replaceAdNode());
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);
});

test('content does not hand the ad of the media that ended to the new one', async () => {
  const harness = createContentHarness();
  await flushTasks();

  harness.commands.length = 0;
  // The ad goes up and the route changes in the same task, so no observer
  // callback has run in between.
  harness.setAdNodePresent(true);
  await harness.navigate('https://www.twitch.tv/videos/200');
  assert.deepEqual(afterMediaChanged(harness), []);
  harness.mutate();
  assert.deepEqual(afterMediaChanged(harness), []);
});

test('content ignores every indicator the old media had, not just the first', async () => {
  const harness = createContentHarness();
  await flushTasks();
  harness.setAdNodePresent(true);
  harness.mutate();
  // A second indicator joins the first part-way through the ad.
  harness.addAdNode();
  harness.mutate();

  harness.commands.length = 0;
  await harness.navigate('https://www.twitch.tv/videos/200');
  harness.mutate();
  assert.deepEqual(afterMediaChanged(harness), []);
});

test('content takes an ad a step back put in the page before it was told', async () => {
  const harness = createContentHarness();
  await flushTasks();
  harness.setAdNodePresent(true);
  harness.mutate();

  harness.commands.length = 0;
  // A listener of the page's own runs first and has the new player up by the
  // time the extension hears about the step.
  await harness.popstate('https://www.twitch.tv/videos/200', () => harness.replaceAdNode());
  assert.deepEqual(afterMediaChanged(harness), [true]);
});

test('content takes an ad that arrives with a route change it did not hook', async () => {
  const harness = createContentHarness();
  await flushTasks();
  harness.setAdNodePresent(true);
  harness.mutate();

  // The route changes without pushState, and the swap reaches the observer in
  // the batch that carries it. Nothing else has to happen in the page.
  harness.commands.length = 0;
  harness.setHref('https://www.twitch.tv/videos/200');
  harness.replaceAdNode();
  harness.mutate();
  await flushTasks(8);
  assert.deepEqual(afterMediaChanged(harness), [true]);
});

test('content takes an indicator the page puts back after taking it out', async () => {
  const harness = createContentHarness();
  const sent = () => harness.commands.filter((command) => command.cmd === 'setAdActive');
  await flushTasks();
  harness.setAdNodePresent(true);
  harness.mutate();
  harness.commands.length = 0;
  await harness.navigate('https://www.twitch.tv/videos/200');

  harness.setAdNodePresent(false);
  harness.mutate();
  assert.deepEqual(sent(), []);

  // The new media's ad arrives in the element the page took out a moment ago.
  harness.reuseAdNode();
  harness.mutate();
  assert.deepEqual(sent().map((command) => command.active), [true]);
});
