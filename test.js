// test.js — Pure utility tests. Run with `node test.js`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
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

// Chrome reads a manifest and a catalog with a byte order mark and with
// comments, so this suite reads them that way too. Written as a scanner over
// characters rather than as pack.py's states, so the two agreeing is evidence.
const readJson = file => {
  const text = fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/^\uFEFF/, '');
  let out = '', i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      out += ch; i++;
      while (i < text.length) {
        if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        out += text[i];
        if (text[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const n = text.indexOf('*/', i + 2);
      assert.ok(n >= 0, `${file} closes every block comment it opens`);
      i = n < 0 ? text.length : n + 2;
      continue;
    }
    out += ch; i++;
  }
  return JSON.parse(out);
};

// What the archive holds, by name and by the digest of its bytes. Reading the
// bytes is the point: namelist() alone answers for the names only.
function heldInZip(dir, archive) {
  const read = spawnSync('python3', ['-c',
    'import hashlib, sys, zipfile\n'
    + 'held = zipfile.ZipFile(sys.argv[1])\n'
    + 'for name in held.namelist():\n'
    + '    print(name, hashlib.sha256(held.read(name)).hexdigest())',
    archive], { cwd: dir, encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  return read.stdout.trim().split('\n').filter(Boolean)
    .map((line) => line.split(' '));
}

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

const WINDOWS_PATH_HARNESS = [
    'import ntpath, os, builtins, types, importlib.util',
    'spec = importlib.util.spec_from_file_location("packmod", "pack.py")',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'real, real_open, real_os = os.path, builtins.open, os',
    'host = lambda p: p.replace(chr(92), "/")',
    'win = lambda p: p.replace("/", chr(92))',
    'class W:',
    '    isabs, normpath, join, dirname = ntpath.isabs, ntpath.normpath, ntpath.join, ntpath.dirname',
    '    realpath = staticmethod(lambda p: win(real.realpath(host(p))))',
    '    isfile = staticmethod(lambda p: real.isfile(host(p)))',
    '    isdir = staticmethod(lambda p: real.isdir(host(p)))',
    '    abspath = staticmethod(lambda p: win(real.abspath(host(p))))',
    'mod.os = types.SimpleNamespace(path=W, listdir=lambda p: real_os.listdir(host(p)),',
    '                               remove=real_os.remove, sep=chr(92))',
    'mod.open = lambda p, *a, **k: real_open(host(p), *a, **k)',
    'print(chr(10).join(arc for _f, arc in mod.selected_files(win(real.abspath(".")))))'
].join('\n');

function namesOnWindows(cwd, where) {
  const run = spawnSync('python3', ['-B', '-c', WINDOWS_PATH_HARNESS],
    { cwd, encoding: 'utf8' });
  if (run.error) {
    console.log(`  (windows path check skipped for ${where}: ${run.error.message})`);
    return null;
  }
  assert.equal(run.status, 0,
    `the windows path harness runs on ${where} — ${(run.stderr || '').trim()}`);
  const names = (run.stdout || '').trim().split('\n').filter(Boolean);
  const backslashed = names.filter((name) => name.includes('\\'));
  assert.deepEqual(backslashed, [],
    `every name inside ${where}'s package stays POSIX on Windows`);
  return names;
}

test('every packaged path is one the extension loads', () => {
  const listed = spawnSync('python3', ['-B', 'pack.py', '--list'], {
    cwd: __dirname,
    encoding: 'utf8'
  });
  assert.equal(listed.status, 0, listed.stderr);
  const packaged = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  assert.ok(packaged.includes('manifest.json'));
  assert.ok(!packaged.includes('test.js'));

  // What a copy carries although nothing in it loads them. pack.py names them
  // in DISTRIBUTION_FILES, and reading that list here holds the two together.
  const packSource = fs.readFileSync(path.join(__dirname, 'pack.py'), 'utf8');
  const declared = packSource.match(/^DISTRIBUTION_FILES = \(([^)]*)\)/m);
  assert.ok(declared, 'pack.py names what a copy carries in DISTRIBUTION_FILES');
  const distribution = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(distribution.includes('LICENSE'),
    'the licence text travels with the copies the licence covers');
  for (const name of distribution) {
    assert.ok(fs.existsSync(path.join(__dirname, name)), `${name} exists`);
    assert.ok(packaged.includes(name), `${name} is in the store package`);
  }

  // Read independently of pack.py's own parsing: every packaged script or page
  // is named by the manifest, by a page the manifest names, or by the worker.
  // Written the way pack.py writes it, this side would agree with it about a
  // spelling neither of them handles.
// The pages are read independently of pack.py. Written the way pack.py writes
// it, this side would agree with it about a spelling neither of them handles.
const PAGE_TAG = /<(script|link)\b([^>]*)>/gi;
const PAGE_ATTR = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const pageReferences = (text) => {
  const found = [];
  for (const [, tag, rest] of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(PAGE_TAG)) {
    const attributes = {};
    for (const [, name, quoted, single, bare] of rest.matchAll(PAGE_ATTR)) {
      attributes[name.toLowerCase()] = quoted ?? single ?? bare;
    }
    if (tag.toLowerCase() === 'script' && attributes.src) { found.push(attributes.src); }
    if (tag.toLowerCase() === 'link' && attributes.href
      && ((attributes.rel || '').toLowerCase().split(/\s+/).includes('stylesheet')
        || attributes.href.endsWith('.css'))) {
      found.push(attributes.href);
    }
  }
  return found;
};
  const manifest = readJson('manifest.json');
  // pack.py declares the keys it follows; this reads that declaration and
  // resolves every one of them itself. The two share the list of keys and
  // nothing else — the reading, the parsing and the spelling are separate here —
  // so a key added to the walk cannot leave this behind.
  const DECLARED_KINDS = new Set(['page', 'script', 'style', 'asset', 'named']);
  const declaredKeys = (() => {
    const source = fs.readFileSync(path.join(__dirname, 'pack.py'), 'utf8');
    const table = source.match(/^MANIFEST_REFERENCES = \(([\s\S]*?)^\)$/m);
    assert.ok(table, 'pack.py declares the keys it follows in MANIFEST_REFERENCES');
    const rows = Array.from(table[1].matchAll(/\(\(([^)]*)\),\s*'([a-z]+)'\)/g),
      ([, steps, kind]) => ({
        path: Array.from(steps.matchAll(/'([^']*)'/g), m => m[1]),
        kind
      }));
    assert.ok(rows.length > 0, 'the declared table holds keys');
    for (const { kind } of rows) {
      assert.ok(DECLARED_KINDS.has(kind),
        `pack.py walks a ${kind} and this test does not know that kind`);
    }
    return rows;
  })();
  const valuesAt = (value, steps) => {
    if (!steps.length) { return typeof value === 'string' ? [value] : []; }
    const [step, ...rest] = steps;
    const isObject = value !== null && typeof value === 'object';
    if (step === '*') {
      return isObject && !Array.isArray(value)
        ? Object.values(value).flatMap(held => valuesAt(held, rest)) : [];
    }
    if (step === '[]') {
      return Array.isArray(value) ? value.flatMap(held => valuesAt(held, rest)) : [];
    }
    return isObject && step in value ? valuesAt(value[step], rest) : [];
  };
  // A resource entry Chrome matches against the package names no one file.
  const A_PATTERN = /[*?]/;
  const BY_NAME = [['.html', 'page'], ['.js', 'script'], ['.css', 'style']];
  const kindOfName = name =>
    (BY_NAME.find(([suffix]) => name.endsWith(suffix)) || [null, 'asset'])[1];
  const namedByManifest = declaredKeys.flatMap(({ path, kind }) =>
    valuesAt(manifest, path)
      .filter(value => !A_PATTERN.test(value))
      .map(value => ({ value, kind: kind === 'named' ? kindOfName(value) : kind })));
  const importedBy = text => Array.from(
    text.matchAll(/importScripts\(([^)]*)\)/g),
    ([, call]) => Array.from(call.matchAll(/['"]([^'"]+)['"]/g), m => m[1])).flat();
  const styleReferences = text => Array.from(
    text.replace(/\/\*[\s\S]*?\*\//g, ' ')
      .matchAll(/(?:@import\s+(?:url\(\s*)?|url\(\s*)(["']?)([^"')\s;]+)\1/g),
    m => m[2]).filter(target => !/^(https?:|\/\/|data:|#)/.test(target)
      && !target.includes('__MSG_'));
  // What the extension loads, followed from the manifest through the files it
  // names, each of them parsed here rather than by pack.py.
  const referenced = new Set(['manifest.json']);
  {
    const pending = namedByManifest.slice();
    while (pending.length) {
      const { value, kind } = pending.shift();
      if (referenced.has(value)) { continue; }
      referenced.add(value);
      if (kind === 'asset' || !fs.existsSync(__dirname + '/' + value)) { continue; }
      const text = fs.readFileSync(__dirname + '/' + value, 'utf8');
      const base = value.includes('/') ? value.slice(0, value.lastIndexOf('/') + 1) : '';
      const found = kind === 'page' ? pageReferences(text)
        : kind === 'script' ? importedBy(text) : styleReferences(text);
      for (const reference of found) {
        pending.push({ value: base + reference, kind: kindOfName(reference) });
      }
    }
  }
  // Every file the manifest names is in the package, and everything in the
  // package is named. The first half is the one a forgotten key makes silent.
  // Read without the declared table: a string in the manifest that names a file
  // in the tree is a file the extension loads. A key left out of that table is
  // silent to every check that reads it, and this is what stays awake.
  const namesAFile = [];
  (function walkStrings(value) {
    if (typeof value === 'string') {
      if (/^[\w][\w./-]*$/.test(value) && fs.existsSync(__dirname + '/' + value)
        && fs.statSync(__dirname + '/' + value).isFile()) {
        namesAFile.push(value);
      }
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(walkStrings);
    }
  })(manifest);
  assert.ok(namesAFile.length > 0, 'the manifest names files that are in the tree');
  for (const value of namesAFile) {
    assert.ok(packaged.includes(value),
      `${value} is named by the manifest and must be packed`);
  }
  for (const { value } of namedByManifest) {
    assert.ok(packaged.includes(value),
      `${value} is named by the manifest and must be packed`);
    assert.ok(fs.existsSync(path.join(__dirname, value)), `${value} exists`);
  }
  for (const arcname of packaged) {
    if (distribution.includes(arcname)) { continue; }
    // A name inside the package is POSIX whatever the host writes it on.
    if (/^_locales\/[^/]+\/messages\.json$/.test(arcname)) { continue; }
    assert.ok(referenced.has(arcname), `${arcname} is packaged but nothing loads it`);
  }

  // Every locale the tree carries is one the package carries. An extension
  // shipped with the default locale alone loads and speaks the wrong language
  // to everyone else, which the rule above would pass.
  const localeDir = path.join(__dirname, '_locales');
  const inTree = fs.readdirSync(localeDir)
    .filter((name) => fs.existsSync(path.join(localeDir, name, 'messages.json')))
    .map((name) => `_locales/${name}/messages.json`).sort();
  // Without a second locale, packing the default one alone would satisfy this.
  assert.ok(inTree.length > 1, 'the tree carries more than one locale');
  assert.deepEqual(packaged.filter((name) => name.startsWith('_locales/')).sort(), inTree);
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
    // Each file carries its own path as its text, so an entry standing for
    // another file reads as a different digest below.
    const write = (relative, body = relative) => {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    write('manifest.json', JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      default_locale: 'ja',
      content_scripts: [{ js: ['utils.js', 'content.js'] }],
      web_accessible_resources: [{ resources: ['audio-worklet.js'] }],
      background: { service_worker: 'background.js' },
      action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon16.png' } }
    }));
    write('utils.js');
    write('content.js');
    write('audio-worklet.js');
    // Two arguments, spelled two ways: a walk that stops at the first one
    // leaves the second out of the package with nothing saying so.
    write('background.js',
      'importScripts(\'channel-store.js\', "lib/second.js");\n');
    write('channel-store.js');
    write('lib/second.js');
    // Spellings a browser reads alike. The expected list below is written out
    // by hand rather than scanned, so it does not inherit whatever this page's
    // markup happens to exercise.
    write('popup.html',
      '<script src="utils.js"></script>\n'
      + '<SCRIPT SRC="popup.js"></SCRIPT>\n'
      + "<script src='sub/deep.js'></script>\n"
      + '<script src=bare.js></script>\n'
      + '<script  src = "spaced.js" ></script>\n'
      + '<link rel="stylesheet" href="popup.style">\n'
      + '<link href="popup.css">\n'
      + '<!-- <script src="commented.js"></script> -->\n');
    write('bare.js');
    write('spaced.js');
    write('popup.style');
    write('popup.css');
    write('commented.js');
    write('sub/deep.js');
    write('LICENSE', 'MIT License\n');
    write('popup.js');
    write('icons/icon16.png');
    write('_locales/ja/messages.json', '{}');
    write('_locales/en/messages.json', '{"a":{"message":"b"}}');

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
    write('docs/en/security-audit.md');
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
    const expected = [
      'LICENSE',
      '_locales/en/messages.json',
      '_locales/ja/messages.json',
      'audio-worklet.js',
      'background.js',
      'bare.js',
      'channel-store.js',
      'content.js',
      'icons/icon16.png',
      'lib/second.js',
      'manifest.json',
      'popup.css',
      'popup.html',
      'popup.js',
      'popup.style',
      'spaced.js',
      'sub/deep.js',
      'utils.js'
    ];
    assert.deepEqual(packaged.slice().sort(), expected.slice().sort());
    const onWindows = namesOnWindows(fixture, 'the fixture');
    if (onWindows) {
      assert.deepEqual(onWindows.slice().sort(), expected.slice().sort(),
        'the fixture packs the same names on either host');
    }

    // The names say nothing about what is under them: a packer writing sixteen
    // empty entries under these names passes every assertion above. This builds
    // the archive and reads it.
    const built = spawnSync('python3', ['-B', 'pack.py'], {
      cwd: fixture,
      encoding: 'utf8'
    });
    assert.equal(built.status, 0, built.stderr);
    const held = heldInZip(fixture, 'twitch-channel-volume-1.0.0.zip');
    assert.deepEqual(held.map(([name]) => name).sort(), expected.slice().sort());
    for (const [name, digest] of held) {
      const onDisk = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(fixture, ...name.split('/')))).digest('hex');
      assert.equal(digest, onDisk, `${name} in the package is the file of that name`);
    }
    // Without this the comparison above would hold for a packer that wrote
    // nothing at all, since an empty entry matches an empty file.
    const ofNothing = crypto.createHash('sha256').update('').digest('hex');
    assert.ok(held.some(([, digest]) => digest !== ofNothing),
      'the fixture gives the packer something to get wrong');
  });
});


// gen_icons.py writes beside itself rather than beside whatever directory it
// was started from, and where there is no face to draw the mark with it says so
// instead of saving one drawn with Pillow's own and reporting success.
test('the icons are drawn beside the script or not at all', () => {
  const source = fs.readFileSync(path.join(__dirname, 'gen_icons.py'), 'utf8');
  const committed = fs.readdirSync(path.join(__dirname, 'icons'))
    .filter((name) => /^icon\d+\.png$/.test(name)).sort();
  assert.ok(committed.length > 0, 'the tree carries the icons gen_icons.py draws');

  withFixtureDir('tcv-icons-', (beside) => {
    withFixtureDir('tcv-cwd-', (elsewhere) => {
      fs.writeFileSync(path.join(beside, 'gen_icons.py'), source);
      fs.mkdirSync(path.join(beside, 'icons'));
      // Both directories can take the icons, so which one holds them answers it.
      fs.mkdirSync(path.join(elsewhere, 'icons'));
      const drawn = spawnSync('python3', ['-B', path.join(beside, 'gen_icons.py')],
        { cwd: elsewhere, encoding: 'utf8' });
      if (drawn.error || drawn.status === 3) {
        console.log(`  (icon check skipped: ${(drawn.error || drawn.stderr || '').toString().trim()})`);
        return;
      }
      assert.equal(drawn.status, 0, drawn.stderr);
      assert.deepEqual(fs.readdirSync(path.join(beside, 'icons')).sort(), committed,
        'gen_icons.py writes the icons beside itself');
      assert.deepEqual(fs.readdirSync(path.join(elsewhere, 'icons')), [],
        'gen_icons.py writes nothing under the directory it was started from');
    });
  });

  // The same script with nowhere to find a face. It runs wherever pillow is,
  // so this half needs no system font of its own.
  withFixtureDir('tcv-faceless-', (faceless) => {
    fs.mkdirSync(path.join(faceless, 'icons'));
    const withoutAFace = source.replace(/^FONT_PATHS = \[[^\]]*\]/m,
      "FONT_PATHS = ['/no/such/face.ttf']");
    assert.notEqual(withoutAFace, source,
      'gen_icons.py lists the faces it looks for in FONT_PATHS');
    fs.writeFileSync(path.join(faceless, 'gen_icons.py'), withoutAFace);
    const refused = spawnSync('python3', ['-B', path.join(faceless, 'gen_icons.py')],
      { cwd: faceless, encoding: 'utf8' });
    if (refused.error || refused.status === 3) {
      console.log(`  (faceless check skipped: ${(refused.error || refused.stderr || '').toString().trim()})`);
      return;
    }
    assert.notEqual(refused.status, 0,
      'gen_icons.py turns down a machine with no face to draw with');
    assert.match(refused.stderr, /no face here to draw the mark with/);
    assert.match(refused.stderr, /no\/such\/face\.ttf/);
    assert.deepEqual(fs.readdirSync(path.join(faceless, 'icons')), [],
      'nothing is saved under the brand letter when there is no face for it');
  });
});


// Every key that names a file is followed, a page is read for what it pulls in
// whatever it is called, and a stylesheet is read for what it reaches.
test('the package follows every manifest key that names a file', () => {
  withFixtureDir('tcv-keys-', (fixture) => {
    const write = (relative, body = relative) => {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    write('manifest.json', JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      // One path rather than a size for each: the other spelling Chrome takes.
      action: { default_popup: 'popup.htm', default_icon: 'brand.png' },
      devtools_page: 'devtools.html',
      side_panel: { default_path: 'panel.html' },
      chrome_url_overrides: { newtab: 'newtab.html' },
      sandbox: { pages: ['sandboxed.html'] },
      storage: { managed_schema: 'schema.json' },
      declarative_net_request: {
        rule_resources: [{ id: 'r', enabled: true, path: 'rules.json' }]
      },
      content_scripts: [{ js: ['content.js'], css: ['styles.css'] }],
      web_accessible_resources: [
        { resources: ['exposed.js', '/loose.png', '//spare.js', '/',
                      'images/*.png', '/lib/*.js'],
          matches: ['https://example.com/*'] }
      ]
    }));
    // Chrome loads a page under whatever name the key gives it.
    write('popup.htm', '<script src="popup.js"></script>\n');
    write('popup.js');
    write('devtools.html');
    write('panel.html');
    write('newtab.html');
    write('sandboxed.html');
    write('schema.json', '{}');
    write('rules.json', '[]');
    write('content.js');
    write('exposed.js');
    write('styles.css', '@import "theme.css";\n'
      + 'body { background: url(bg.png) }\n'
      + '/* url(commented.png) */\n'
      + 'a { background: url("https://example.com/remote.png") }\n'
      + 'b { background: url(#within) }\n'
      + 'c { background: url("__MSG_@@extension_id__/asset.png") }\n');
    write('theme.css', 'body { color: red }\n');
    write('bg.png');
    write('brand.png');
    // In a comment, remote, a fragment of the sheet, and a name Chrome
    // substitutes a message into: none of them is a file this can resolve.
    write('commented.png');
    // A resource entry is a pattern Chrome matches against the extension's
    // own files, so what it names is packed. The three beside it are the
    // ones it does not name: a different extension, a different directory,
    // and one the pattern reaches only because '*' passes over a slash.
    write('images/logo.png');
    write('images/deep/inner.png');
    write('images/notes.txt');
    // The pattern has to name the whole of what it matches: this one begins
    // with a name it does name and goes on past it.
    write('images/logo.png.bak');
    // Where a pattern names files exactly, those are the files it names:
    // this one folds onto it and is not among them.
    write('images/OTHER.PNG');
    // What a pattern names is read by what it is: this one imports, and
    // what it imports is packed with it.
    write('lib/helper.js', "importScripts('inner.js');\n");
    write('lib/inner.js');
    write('lib/notes.txt');
    // A resource is written from the extension's root, and the documented
    // form writes that root as a leading slash: '/loose.png' and '/lib/*.js'
    // name what 'loose.png' and 'lib/*.js' name. A slash on its own names
    // nothing, and one written twice is still the root.
    write('loose.png');
    write('spare.js');
    write('stray.png');
    write('LICENSE', 'MIT License\n');
    fs.copyFileSync(path.join(__dirname, 'pack.py'), path.join(fixture, 'pack.py'));

    const listed = spawnSync('python3', ['-B', 'pack.py', '--list'],
      { cwd: fixture, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(
      listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort(),
      [
      'LICENSE', 'bg.png', 'brand.png', 'content.js', 'devtools.html', 'exposed.js',
      'images/deep/inner.png', 'images/logo.png', 'lib/helper.js', 'lib/inner.js',
      'loose.png', 'manifest.json', 'newtab.html', 'panel.html', 'popup.htm',
      'popup.js', 'rules.json', 'sandboxed.html', 'schema.json', 'spare.js',
      'styles.css', 'theme.css'
    ]);

    // Each of these says the key was walked rather than the file happening to
    // be carried some other way.
    // A pattern cannot name a file that is not there, so what says it was
    // matched is that the file is in the list above and its neighbours are
    // not. These are the names that fail when the key stops being walked.
    for (const gone of ['panel.html', 'rules.json', 'schema.json', 'theme.css',
      'bg.png', 'brand.png', 'exposed.js', 'popup.js', 'lib/inner.js']) {
      fs.rmSync(path.join(fixture, gone));
      const refused = spawnSync('python3', ['-B', 'pack.py', '--list'],
        { cwd: fixture, encoding: 'utf8' });
      assert.notEqual(refused.status, 0, `pack.py refuses a package missing ${gone}`);
      assert.match(refused.stderr, new RegExp(gone.replace('.', '\\.')));
      write(gone);
    }
  });
});


// What version a tag stands for. Chrome reads the manifest's version as numbers
// alone, so a prerelease shows its name in version_name and keeps the numbers it
// is built on in version. The release runs this script, so this runs it too.
test('a tag is met by the version the manifest shows for it', () => {
  const script = path.join(__dirname, 'tools', 'verify-version.sh');
  assert.ok(fs.existsSync(script), 'the release script is in the tree');
  // A step that stopped calling it would leave every case below passing.
  const release = fs.readFileSync(
    path.join(__dirname, '.github', 'workflows', 'release.yaml'), 'utf8');
  assert.ok(release.includes('tools/verify-version.sh'),
    'the release workflow runs the version script');

  withFixtureDir('tcv-version-', (box) => {
    const ask = (manifest, tag) => {
      const at = path.join(box, 'manifest.json');
      fs.writeFileSync(at, JSON.stringify(manifest));
      return spawnSync('bash', [script, at, tag], { encoding: 'utf8' });
    };
    for (const [shape, manifest, tag, wanted] of [
      ['a release tag against a numeric version',
        { version: '1.2.0' }, 'v1.2.0', null],
      ['a prerelease tag against the name beside the version',
        { version: '1.2.0', version_name: '1.2.0-rc1' }, 'v1.2.0-rc1', null],
      ['a tag that is not the version', { version: '1.2.0' }, 'v1.2.1',
        /does not match tag/],
      ['a release tag against a manifest showing a prerelease',
        { version: '1.2.0', version_name: '1.2.0-rc1' }, 'v1.2.0', /does not match tag/],
      ['a name that is not built on the version',
        { version: '1.2.0', version_name: '9.9.9-rc1' }, 'v9.9.9-rc1',
        /does not begin with version/],
      ['a manifest naming no version', { name: 'p' }, 'v1.2.0', /names no version/]
    ]) {
      const run = ask(manifest, tag);
      const said = (run.stdout || '') + (run.stderr || '');
      if (wanted === null) {
        assert.equal(run.status, 0, `${shape} passes — ${said.trim()}`);
      } else {
        assert.notEqual(run.status, 0, `${shape} is refused`);
        assert.match(said, wanted, `${shape} says why`);
      }
    }
  });
});

// A tag moves and a commit does not, so every action this repository runs is
// named by the commit its version tag names, with that version written beside
// it. Nothing here reaches the network: what the commit is was settled when it
// was written down, and this only holds the shape.
test('every action is named by a commit and the version beside it', () => {
  const workflows = path.join(__dirname, '.github', 'workflows');
  const files = fs.readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'the repository carries workflows');
  let named = 0;
  for (const name of files) {
    for (const line of fs.readFileSync(path.join(workflows, name), 'utf8').split('\n')) {
      if (!/^\s*-?\s*uses:/.test(line)) { continue; }
      named += 1;
      assert.match(line,
        /^\s*-?\s*uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/,
        `${name} names an action by a commit and the version beside it`);
    }
  }
  // Without this the loop above would pass over a workflow that runs nothing.
  assert.ok(named > 0, 'the workflows run actions');
});

// A job with no timeout of its own runs to GitHub's six hours, so one that
// hangs holds a runner for an afternoon and says nothing until it is looked at.
test('every job names how long it may run', () => {
  const workflows = path.join(__dirname, '.github', 'workflows');
  let jobs = 0;
  for (const name of fs.readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file))) {
    const text = fs.readFileSync(path.join(workflows, name), 'utf8');
    // A job is a key at one indent under jobs:, and its block runs to the next.
    const blocks = text.slice(text.indexOf('\njobs:')).split(/\n {2}(?=[\w-]+:)/).slice(1);
    for (const block of blocks) {
      jobs += 1;
      // At the job's own indent: a step inside it naming one of its own
      // answers for the step and leaves the job running to GitHub's six hours.
      assert.match(block, /^ {4}timeout-minutes: \d+$/m,
        `${name}'s ${block.split(':')[0]} names how long it may run`);
    }
  }
  // Without this the loop above would pass over a repository with no jobs in it.
  assert.ok(jobs > 2, `the workflows carry jobs — found ${jobs}`);
});

// A release is built from whatever commit its tag names: a build that packs
// without running what CI runs turns a commit CI never passed into a release
// asset. The two are held together here
// rather than by whoever remembers to copy a step across.
test('a release is built from a commit that passed what CI runs', () => {
  const jobIn = (file, name) => {
    const text = fs.readFileSync(path.join(__dirname, '.github/workflows', file), 'utf8');
    const at = text.indexOf(`\n  ${name}:`);
    assert.ok(at > -1, `${file} carries a ${name} job`);
    const rest = text.slice(at + 1);
    const next = rest.slice(1).search(/\n {2}[\w-]+:/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  // A step run only where something already failed is a way of looking at the
  // failure, not a check the tree has to pass.
  const checksOf = (job) => job.split(/\n {6}- /).slice(1)
    .filter((step) => !/^\s*if: failure\(\)/m.test(step))
    .map((step) => step.match(/^\s*run: (.+)$/m)).filter(Boolean)
    .map((match) => match[1].trim());
  const ci = checksOf(jobIn('ci.yaml', 'test'));
  const build = jobIn('release.yaml', 'build');
  const packs = build.indexOf('run: python pack.py');
  assert.ok(packs > -1, 'the release build packs the extension');
  assert.ok(ci.length > 3, `the CI job runs checks — found ${ci.join(', ')}`);
  for (const check of ci) {
    const at = build.indexOf(`run: ${check}`);
    assert.ok(at > -1, `the release build runs what CI runs: ${check}`);
    assert.ok(at < packs, `the release build runs ${check} before it packs`);
  }
});

// A tag push is an intent to release. A tag naming no release this workflow
// makes used to pass through as a run that packed, uploaded and released
// nothing — a green tick against a tag with no release behind it.
test('a tag naming no release is refused before anything is built', () => {
  const script = path.join(__dirname, 'tools/check-tag.sh');
  assert.ok(fs.existsSync(script), 'the tag script is in the tree');
  // A step that stopped calling it would leave every case below passing.
  const release = fs.readFileSync(
    path.join(__dirname, '.github/workflows/release.yaml'), 'utf8');
  assert.ok(release.includes('tools/check-tag.sh'),
    'the release workflow runs the tag script');

  const box = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tcv-tag-'));
  const ask = (event, ref) => {
    const out = path.join(box, 'out');
    fs.writeFileSync(out, '');
    const run = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF_NAME: ref,
        GITHUB_OUTPUT: out, RUNNER_DEBUG: '' }
    });
    return { run, wrote: fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean) };
  };
  let released = 0;
  for (const [event, ref, wanted] of [
    ['push', 'v1.2.3', ['validTag=true', 'prerelease=false', 'version=v1.2.3']],
    ['push', 'v1.2.3-rc1', ['validTag=true', 'prerelease=true', 'version=v1.2.3-rc1']],
    ['push', 'v1.2.3-beta2', ['validTag=true', 'prerelease=true', 'version=v1.2.3-beta2']],
    ['push', 'v1.2.3-alpha', ['validTag=true', 'prerelease=true', 'version=v1.2.3-alpha']],
    // A run somebody started by hand carries a branch name here and makes no
    // release, which is not a failure — it is what the flag is for.
    ['workflow_dispatch', 'main', ['validTag=false']],
    ['workflow_dispatch', 'v1.2.3', ['validTag=false']],
    // Four parts, two parts, and a word the prerelease arm does not name.
    ['push', 'v1.2.3.4', null],
    ['push', 'v1.2', null],
    ['push', 'v1.2.3-nightly', null]
  ]) {
    const { run, wrote } = ask(event, ref);
    if (wanted === null) {
      assert.notEqual(run.status, 0, `${event} of ${ref} is refused`);
      assert.match(run.stdout + run.stderr, /::error::tag .* names no release/,
        `${event} of ${ref} says why`);
      assert.deepEqual(wrote, [],
        `${event} of ${ref} leaves no flag for a later job to read`);
    } else {
      assert.equal(run.status, 0,
        `${event} of ${ref} passes — ${(run.stdout + run.stderr).trim()}`);
      assert.deepEqual(wrote, wanted, `${event} of ${ref} sets ${wanted.join(' ')}`);
      if (wrote.includes('validTag=true')) { released += 1; }
    }
  }
  // Without this a script that refused everything would pass the table above.
  assert.equal(released, 4, `tags this workflow releases from — found ${released}`);
  fs.rmSync(box, { recursive: true, force: true });
});

// A run that is not making a release has a branch name where the tag would be,
// so the tag and the manifest are compared exactly where a release is made
// from them — which is the flag create-release is already gated on.
test('the tag is compared with the manifest where a release is made', () => {
  const release = fs.readFileSync(
    path.join(__dirname, '.github/workflows/release.yaml'), 'utf8');
  const gate = "if: needs.check-event.outputs.validTag == 'true'";
  const gated = release.split('\n').filter((line) => line.trim() === gate).length;
  assert.equal(gated, 2,
    `the version check and the release read one flag — found ${gated} line(s) reading it`);
  const verify = release.indexOf('run: bash tools/verify-version.sh');
  assert.ok(verify > -1, 'the release workflow runs the version script');
  assert.ok(release.lastIndexOf(gate, verify) > release.lastIndexOf('- name:', verify),
    'the version check is the step that flag stands on');
});

test('a reference naming a drive is refused under Windows path semantics', () => {
  // A drive letter reads as relative to posixpath, and on Windows it resolves
  // against the same drive — so `C:/content.js` would package what `content.js`
  // names, under a path Chrome does not accept. On this host it merely misses,
  // which is why the reference is put to pack.py under Windows path semantics.
  const driveProbe = [
    'import ntpath, os, builtins, types, importlib.util',
    'spec = importlib.util.spec_from_file_location("packmod", "pack.py")',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'real, real_open, real_os = os.path, builtins.open, os',
    'ROOT = "C:" + chr(92) + "repo"',
    'here = real.realpath(".")',
    'host = lambda p: p.replace(ROOT, here).replace(chr(92), "/")',
    'win = lambda p: p.replace(here, ROOT).replace("/", chr(92))',
    'class W:',
    '    isabs, normpath, join, dirname = ntpath.isabs, ntpath.normpath, ntpath.join, ntpath.dirname',
    '    realpath = staticmethod(lambda p: win(real.realpath(host(p))))',
    '    isfile = staticmethod(lambda p: real.isfile(host(p)))',
    '    isdir = staticmethod(lambda p: real.isdir(host(p)))',
    '    abspath = staticmethod(lambda p: win(real.abspath(host(p))))',
    'mod.os = types.SimpleNamespace(path=W, listdir=lambda p: real_os.listdir(host(p)),',
    '                               remove=real_os.remove, sep=chr(92))',
    'mod.open = lambda p, *a, **k: real_open(host(p), *a, **k)',
    'for name in ["content.js", "C:/content.js", "C:content.js", "c:content.js"]:',
    '    print(name, mod._resolve(ROOT, name) is not None)'
  ].join('\n');
  const run = spawnSync('python3', ['-B', '-c', driveProbe],
    { cwd: __dirname, encoding: 'utf8' });
  if (run.error) {
    console.log(`  (drive-letter check skipped: ${run.error.message})`);
    return;
  }
  assert.equal(run.status, 0, `the drive-letter probe runs — ${(run.stderr || '').trim()}`);
  const answers = Object.fromEntries((run.stdout || '').trim().split('\n')
    .filter(Boolean).map((line) => line.split(' ')));
  assert.equal(answers['content.js'], 'True',
    'a path inside the package still resolves under Windows path semantics');
  for (const named of ['C:/content.js', 'C:content.js', 'c:content.js']) {
    assert.equal(answers[named], 'False', `${named} names a drive and is refused`);
  }
});

test('the names inside the package are POSIX on Windows too', () => {
  // A zip entry uses forward slashes and the manifest spells its references
  // that way, so those are one name. Windows is where they would not be, and
  // this runs pack.py's own selection under Windows path semantics.
  const listed = spawnSync('python3', ['-B', 'pack.py', '--list'],
    { cwd: __dirname, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const packaged = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const onWindows = namesOnWindows(__dirname, 'this repository');
  if (onWindows) {
    assert.deepEqual(onWindows, packaged, 'the package holds the same names on either host');
  }
});

test('the store package refuses to leave out what it has to carry', () => {
  // The release workflow runs pack.py and uploads what it writes without
  // running any of this, so an omission that still exits 0 ships.
  const runPack = (box, args) => spawnSync('python3', ['-B', 'pack.py', ...args],
    { cwd: box, encoding: 'utf8' });
  const buildMinimal = () => {
    const box = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tcv-required-'));
    fs.copyFileSync(path.join(__dirname, 'pack.py'), path.join(box, 'pack.py'));
    fs.writeFileSync(path.join(box, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      version: '0.0.0',
      default_locale: 'ja',
      name: '__MSG_extName__',
      content_scripts: [{ js: ['content.js'] }]
    }));
    fs.writeFileSync(path.join(box, 'content.js'), '');
    fs.mkdirSync(path.join(box, '_locales/ja'), { recursive: true });
    // The manifest asks for extName, so the catalog answers for it.
    fs.writeFileSync(path.join(box, '_locales/ja/messages.json'),
      JSON.stringify({ extName: { message: 'Minimal' } }));
    fs.writeFileSync(path.join(box, 'LICENSE'), 'MIT License\n');
    return box;
  };

  const whole = buildMinimal();
  const listed = runPack(whole, ['--list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(
    listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort(),
    ['LICENSE', '_locales/ja/messages.json', 'content.js', 'manifest.json']);
  fs.rmSync(whole, { recursive: true, force: true });

  const writeCatalog = (box, catalog) =>
    fs.writeFileSync(path.join(box, '_locales/ja/messages.json'), JSON.stringify(catalog));
  const readBoxJson = (box) => JSON.parse(fs.readFileSync(`${box}/manifest.json`, 'utf8'));
  // A value the manifest carries as it stands. JSON.stringify spells no
  // NaN, no comment and no escape, and the manifest is where Chrome reads
  // all three.
  const appendRaw = (box, raw) => fs.writeFileSync(`${box}/manifest.json`,
    `${JSON.stringify(readBoxJson(box)).slice(0, -1)},${raw}}`);
  const editManifest = (box, change) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(box, 'manifest.json'), 'utf8'));
    change(manifest);
    fs.writeFileSync(path.join(box, 'manifest.json'), JSON.stringify(manifest));
  };
  // The third entry, where a case carries one, is what the refusal has to say.
  // Without it a rule can be deleted and a later check refuses the same input for
  // another reason, and the case cannot tell the two apart.
  for (const [broken, breakIt, diagnosis] of [
    ['the licence gone', (box) => fs.rmSync(path.join(box, 'LICENSE'))],
    ["the default locale's messages gone",
      (box) => fs.rmSync(path.join(box, '_locales/ja/messages.json'))],
    ['_locales gone', (box) => fs.rmSync(path.join(box, '_locales'), { recursive: true })],
    // Chrome reads _locales and default_locale as one contract: a directory
    // with nothing naming it is an extension it declines to load.
    ['no default_locale, and _locales still here',
      (box) => editManifest(box, (m) => { delete m.default_locale; })],
    ['default_locale set to an empty string',
      (box) => editManifest(box, (m) => { m.default_locale = ''; })],
    ['default_locale set to something that is not a string',
      (box) => editManifest(box, (m) => { m.default_locale = 7; })],
    ['default_locale naming a directory that is not there',
      (box) => editManifest(box, (m) => { m.default_locale = 'de'; })],
    ['a manifest reference naming a drive rather than a path inside the package',
      (box) => editManifest(box, (m) => { m.content_scripts = [{ js: ['C:/content.js'] }]; })],
    // Chrome resolves __MSG_name__ against the default locale's catalog, in the
    // manifest and in the stylesheets it serves. A placeholder with nothing to
    // resolve it against is an extension it declines to load.
    ['a message the manifest asks for and no locale assets at all',
      (box) => {
        fs.rmSync(`${box}/_locales`, { recursive: true });
        editManifest(box, m => { delete m.default_locale; });
      },
      /asks for extName and names no default_locale/],
    ['default_locale written as null',
      (box) => editManifest(box, m => { m.default_locale = null; }),
      /default_locale is not a locale name: None/],
    ['default_locale written as a path rather than a name',
      (box) => editManifest(box, m => { m.default_locale = 'ja/'; }),
      /default_locale is not one name under _locales: 'ja\/'/],
    ['default_locale written as a directory that means the one above',
      (box) => editManifest(box, m => { m.default_locale = '..'; }),
      /default_locale is not one name under _locales: '\.\.'/],
    ['a message the manifest asks for that the catalog does not answer',
      (box) => editManifest(box, m => { m.name = '__MSG_absentKey__'; }),
      /the manifest uses absentKey, which .* does not answer for/],
    ['a reference spelled with escapes that nothing answers',
      (box) => appendRaw(box, '"description":"__MSG_\\u0061bsent__"'),
      /the manifest uses absent, which .* does not answer for/],
    ['a message a packaged stylesheet asks for that the catalog does not answer',
      (box) => {
        fs.writeFileSync(`${box}/styles.css`, 'body { content: "__MSG_absentKey__" }\n');
        editManifest(box, m => {
          m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
        });
      },
      /styles\.css uses absentKey, which .* does not answer for/],
    ['a catalog that is not JSON',
      (box) => fs.writeFileSync(`${box}/_locales/ja/messages.json`, '{ broken'),
      /messages\.json is not readable as JSON/],
    // Chrome's parser allows comments; it does not allow a trailing comma or
    // a block comment left open.
    ['a trailing comma in a catalog',
      (box) => fs.writeFileSync(`${box}/_locales/ja/messages.json`,
        '{ "extName": { "message": "x" }, }'),
      /messages\.json is not readable as JSON/],
    ['a block comment a catalog never closes',
      (box) => fs.writeFileSync(`${box}/_locales/ja/messages.json`,
        '{ /* "extName": { "message": "x" } }'),
      /never closed/],
    ['a trailing comma in the manifest',
      (box) => fs.writeFileSync(`${box}/manifest.json`,
        '{ "manifest_version": 3, "version": "0.0.0", }'),
      /manifest\.json is not readable as JSON/],
    // Chrome reads the catalog rather than taking it on faith, and declines to
    // load the extension over any of these.
    ['a catalog whose top level is not an object',
      (box) => writeCatalog(box, [{ extName: { message: 'x' } }]),
      /is not a message catalog: the top level is a list/],
    ['an entry with no message element',
      (box) => writeCatalog(box, { extName: { description: 'x' } }),
      /gives extName no message element/],
    ['an entry whose message is not text',
      (box) => writeCatalog(box, { extName: { message: 7 } }),
      /gives extName no message element/],
    ['an entry that is not an object',
      (box) => writeCatalog(box, { extName: 'x' }),
      /gives extName a str, not an object/],
    ['a name Chrome cannot read',
      (box) => writeCatalog(box, { 'ext-name': { message: 'x' }, extName: { message: 'y' } }),
      /names a message Chrome cannot read/],
    ['a placeholder with no content',
      (box) => writeCatalog(box,
        { extName: { message: 'x $A$', placeholders: { a: { example: 'y' } } } }),
      /gives extName\.a no content/],
    // A pattern that names nothing is one Chrome takes as well. A pattern
    // that names nothing until the spelling is folded is the tree carrying
    // the files another way, and the package would go out without them —
    // which the walk cannot say, because it lists real paths and matches
    // them, so a spelling that differs reads as nothing to match.
    ['a resource pattern whose directory the tree spells another way',
      (box) => {
        fs.mkdirSync(`${box}/images`);
        fs.writeFileSync(`${box}/images/logo.png`, 'x');
        editManifest(box, m => {
          m.web_accessible_resources = [{ resources: ['Images/*.png'],
            matches: ['https://example.com/*'] }];
        });
      },
      /the tree spells this another way: Images\/\*\.png/],
    ['a resource pattern whose extension the tree spells another way',
      (box) => {
        fs.mkdirSync(`${box}/images`);
        fs.writeFileSync(`${box}/images/logo.png`, 'x');
        editManifest(box, m => {
          m.web_accessible_resources = [{ resources: ['images/*.PNG'],
            matches: ['https://example.com/*'] }];
        });
      },
      /the tree spells this another way: images\/\*\.PNG/],
    // A name that is nowhere and a name spelled another way are different
    // mistakes, and each is said as itself.
    ['a reference with no file behind it',
      (box) => fs.rmSync(`${box}/content.js`),
      /referenced file is missing or not a regular file: content\.js/],
    // A host that opens a name without regard to case hands back the file
    // the tree carries, and the package would hold two entries for the one
    // file — one of them under a name no other host can open.
    ['a reference the tree spells another way',
      (box) => editManifest(box, m => {
        m.content_scripts = [{ js: ['Content.js'] }];
      }),
      /the tree spells this another way: Content\.js/],
    // Outside a resource entry a leading slash is an absolute path, and an
    // absolute path names a file the package cannot carry.
    ['a reference beginning at the root of the host',
      (box) => editManifest(box, m => {
        m.content_scripts = [{ js: ['/content.js'] }];
      }),
      /reference leaves the package: \/content\.js/],
    // A backslash is an ordinary character in a name on this host and a
    // separator on the one the package is written for. The file is on disk
    // under that very name, so what refuses it is the rule and not its
    // absence.
    ['a reference spelled with a backslash',
      (box) => {
        fs.writeFileSync(`${box}/sub\\content.js`, '');
        editManifest(box, m => {
          m.content_scripts = [{ js: ['content.js', 'sub\\content.js'] }];
        });
      },
      /reference leaves the package: sub\\content\.js/],
    // Chrome reads a version as one to four numbers, each below 2**32, the
    // first written without a leading zero. Its own message about the range
    // says 0 to 65536, which is not the bound it applies.
    ['a version carrying a prerelease suffix',
      (box) => editManifest(box, m => { m.version = '1.0.0-rc1'; }),
      /version is not one Chrome reads: '1\.0\.0-rc1'/],
    ['a version whose first part carries a leading zero',
      (box) => editManifest(box, m => { m.version = '01.1.0'; }),
      /version is not one Chrome reads: '01\.1\.0'/],
    ['a version part past the largest number one holds',
      (box) => editManifest(box, m => { m.version = '1.0.4294967296'; }),
      /version is not one Chrome reads: '1\.0\.4294967296'/],
    ['a version of five parts',
      (box) => editManifest(box, m => { m.version = '1.0.0.0.0'; }),
      /version is not one Chrome reads: '1\.0\.0\.0\.0'/],
    // A prerelease shows its name in version_name, which Chrome reads as any
    // text at all and refuses when it is not text.
    ['a version_name that is not text',
      (box) => editManifest(box, m => { m.version_name = 7; }),
      /version_name is not text: 7/],
    ['a version written as a number rather than text',
      (box) => editManifest(box, m => { m.version = 100; }),
      /version is not one Chrome reads: 100/],
    ['a version with no version at all',
      (box) => editManifest(box, m => { delete m.version; }),
      /version is not one Chrome reads: None/],
    ['a default_locale that is no locale at all',
      (box) => {
        fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/jp`);
        editManifest(box, m => { m.default_locale = 'jp'; });
      },
      /is not a locale the store carries: 'jp'/],
    ['a locale the browser loads and the store does not carry',
      (box) => {
        fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/nb`);
        editManifest(box, m => { m.default_locale = 'nb'; });
      },
      /is not a locale the store carries: 'nb'/],
    // Every locale under _locales reaches the package, not the default one
    // alone, so each is held to the same list. Chrome loads _locales/nb and
    // _locales/zz alike; no listing presents either.
    ['a locale beside the default one that the store does not carry',
      (box) => fs.cpSync(`${box}/_locales/ja`, `${box}/_locales/nb`, { recursive: true }),
      /_locales\/nb is not a locale the store carries: 'nb'/],
    // The store spells its regions in capitals and Chrome loads the name
    // either way, so a package can carry a locale under a spelling no listing
    // answers to. The spelling the store uses is the refusal.
    ['a locale beside the default one spelled the way the store does not',
      (box) => fs.cpSync(`${box}/_locales/ja`, `${box}/_locales/en_gb`, { recursive: true }),
      /_locales\/en_gb is spelled 'en_GB' by the store/],
    // A file the manifest reaches inside _locales lands in a locale directory
    // whatever it was meant as, and Chrome reads it as one: measured against
    // 151, a package carrying _locales/fr/icon.png with no fr catalog is
    // refused at load — "Messages file is missing for locale". The sweep
    // above cannot see these, because it looks only where a catalog is.
    ['a referenced file under a locale the store does not carry', (box) => {
      fs.mkdirSync(`${box}/_locales/nb`, { recursive: true });
      fs.writeFileSync(`${box}/_locales/nb/icon.png`, 'png');
      editManifest(box, m => { m.action = { default_icon: '_locales/nb/icon.png' }; });
    }, /_locales\/nb is not a locale the store carries: 'nb'/],
    ['a referenced file under a locale spelled the way the store does not', (box) => {
      fs.mkdirSync(`${box}/_locales/en_gb`, { recursive: true });
      fs.writeFileSync(`${box}/_locales/en_gb/icon.png`, 'png');
      editManifest(box, m => { m.action = { default_icon: '_locales/en_gb/icon.png' }; });
    }, /_locales\/en_gb is spelled 'en_GB' by the store/],
    ['a referenced file in a locale directory with no catalog', (box) => {
      fs.mkdirSync(`${box}/_locales/en`, { recursive: true });
      fs.writeFileSync(`${box}/_locales/en/icon.png`, 'png');
      editManifest(box, m => { m.action = { default_icon: '_locales/en/icon.png' }; });
    }, /_locales\/en carries _locales\/en\/icon\.png and no messages\.json/],
    ['a referenced file put straight into _locales', (box) => {
      fs.writeFileSync(`${box}/_locales/icon.png`, 'png');
      editManifest(box, m => { m.action = { default_icon: '_locales/icon.png' }; });
    }, /_locales\/icon\.png is not a locale the store carries/],
    ['a default_locale spelled the way the store does not',
      (box) => {
        fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/en_gb`);
        editManifest(box, m => { m.default_locale = 'en_gb'; });
      },
      /default_locale is spelled 'en_GB' by the store/],
    // Chrome reads a JSON number as a double. NaN and the infinities are
    // Python's spelling of a number rather than JSON's, and a literal too
    // large for a double is one Chrome declines to read at all.
    ['a manifest holding a number only Python reads',
      (box) => appendRaw(box, '"x":NaN'),
      /manifest\.json is not readable as JSON: NaN is not a JSON value/],
    ['a catalog holding a number only Python reads',
      (box) => fs.writeFileSync(`${box}/_locales/ja/messages.json`,
        '{"extName":{"message":"x","description":Infinity}}'),
      /messages\.json is not readable as JSON: Infinity is not a JSON value/],
    ['a fraction larger than a number holds',
      (box) => appendRaw(box, '"x":1e400'),
      /is not readable as JSON: 1e400 is out of the range a number holds/],
    ['an integer larger than a number holds',
      (box) => appendRaw(box, `"x":1${'0'.repeat(400)}`),
      /is not readable as JSON: 10+ is out of the range a number holds/],
    // A comment stands between the tokens it separated. Dropped outright it
    // joins them into one the author never wrote.
    ['a number a block comment splits',
      (box) => appendRaw(box, '"x":1/**/2'),
      /manifest\.json is not readable as JSON: Expecting ',' delimiter/],
    ['a keyword a block comment splits',
      (box) => appendRaw(box, '"x":tr/**/ue'),
      /manifest\.json is not readable as JSON: Expecting value/],
    // Every field Chrome localizes is asked, not the first of them alone.
    ['a title the action asks for that the catalog does not answer',
      (box) => editManifest(box, m => {
        m.action = { default_title: '__MSG_absentTitle__' };
      }),
      /the manifest uses absentTitle, which .* does not answer for/],
    ['a description a command asks for that the catalog does not answer',
      (box) => editManifest(box, m => {
        m.commands = { go: { description: '__MSG_absentCommand__' } };
      }),
      /the manifest uses absentCommand, which .* does not answer for/],
    ['a name an input component asks for that the catalog does not answer',
      (box) => editManifest(box, m => {
        m.input_components = [{ name: '__MSG_absentComponent__' }];
      }),
      /the manifest uses absentComponent, which .* does not answer for/],
    ['a message under @@ that Chrome does not define',
      (box) => editManifest(box, m => { m.description = '__MSG_@@bogus__'; }),
      /the manifest uses @@bogus, which .* does not answer for/],
    ['the one message Chrome reads everywhere but the manifest, in the manifest',
      (box) => editManifest(box, m => { m.description = '__MSG_@@extension_id__'; }),
      /the manifest uses @@extension_id/],
    ['a message referring to a placeholder nothing defines',
      (box) => writeCatalog(box, { extName: { message: 'hello $WHO$' } }),
      /gives extName no placeholder named WHO/],
    ['placeholders written as null',
      (box) => writeCatalog(box, { extName: { message: 'x', placeholders: null } }),
      /gives extName placeholders that are not an object/],
    ['a placeholder Chrome cannot read',
      (box) => writeCatalog(box, { extName: { message: 'x $BAD_NAME$',
        placeholders: { 'bad-name': { content: '$1' } } } }),
      /names a placeholder Chrome cannot read/],
    // A doubled delimiter opens an empty candidate rather than escaping
    // anything, so $$NAME$$ asks for NAME; and two references share a
    // delimiter, so $A$$B$ is A then B.
    ['a doubled dollar around a name nothing defines',
      (box) => writeCatalog(box, { extName: { message: '$$NAME$$' } }),
      /gives extName no placeholder named NAME/],
    // A name is matched whole: Chromium walks every character of it, while a
    // pattern anchored with $ stops before a trailing newline.
    ['a message name ending in a newline',
      (box) => writeCatalog(box, { extName: { message: 'x' }, 'trailing\n': { message: 'y' } }),
      /names a message Chrome cannot read/],
    ['a placeholder name ending in a newline',
      (box) => writeCatalog(box,
        { extName: { message: 'x', placeholders: { 'a\n': { content: '$1' } } } }),
      /names a placeholder Chrome cannot read/],
    // Chrome supplies the reserved five and refuses a catalog that answers for
    // one of them, without regard to case. The extension id is not among them.
    ['a catalog answering for a message Chrome reserves',
      (box) => writeCatalog(box,
        { extName: { message: 'x' }, '@@ui_locale': { message: 'y' } }),
      /answers for @@ui_locale, which Chrome reserves/],
    ['a catalog answering for a reserved name spelled in capitals',
      (box) => writeCatalog(box,
        { extName: { message: 'x' }, '@@BIDI_DIR': { message: 'y' } }),
      /answers for @@BIDI_DIR, which Chrome reserves/],
    // The manifest is localized before Chrome has an extension id, so the name
    // is matched there without regard to case as everywhere else.
    ['the extension id asked for in capitals in the manifest',
      (box) => editManifest(box, m => { m.description = '__MSG_@@EXTENSION_ID__'; }),
      /the manifest uses @@EXTENSION_ID/],
    ['two references sharing a delimiter, one of them undefined',
      (box) => writeCatalog(box, { extName: { message: '$A$$B$',
        placeholders: { ab: { content: '$1' } } } }),
      /gives extName no placeholder named A/],
    // The second reference is what the shared delimiter opens, so it has to be
    // the one that fails here: a walk restarting past the delimiter never
    // reaches it.
    ['the second of two references sharing a delimiter undefined',
      (box) => writeCatalog(box, { extName: { message: '$A$$B$',
        placeholders: { a: { content: '$1' } } } }),
      /gives extName no placeholder named B/]
  ]) {
    const box = buildMinimal();
    // A package built earlier stands here, so a refusal has something to spare.
    const built = runPack(box, []);
    assert.equal(built.status, 0, built.stderr);
    const zip = path.join(box, 'twitch-channel-volume-0.0.0.zip');
    const before = fs.statSync(zip).size;
    breakIt(box);
    for (const args of [['--list'], []]) {
      const refused = runPack(box, args);
      assert.notEqual(refused.status, 0,
        `pack.py ${args.join(' ')} refuses a package with ${broken}`);
      assert.doesNotMatch(refused.stdout || '', /^\s*\+ /m,
        `pack.py names nothing as packed with ${broken}`);
      // A traceback exits non-zero too, and says what broke rather than what is
      // wrong with the package.
      assert.doesNotMatch(refused.stderr || '', /Traceback \(most recent call last\)/,
        `pack.py says what is wrong with ${broken}, instead of raising`);
      if (diagnosis) {
        assert.match(refused.stderr || '', diagnosis,
          `pack.py names what is wrong with ${broken}`);
      }
    }
    assert.ok(fs.existsSync(zip) && fs.statSync(zip).size === before,
      `the package built before is left alone with ${broken}`);
    fs.rmSync(box, { recursive: true, force: true });
  }

  // Four shapes Chrome reads without complaint. Each is a rule the checks above
  // could over-reach into: a name with an @ in it, Chrome's own message where
  // it is allowed, a literal dollar, and a positional argument in a
  // placeholder's content.
  for (const [shape, arrange] of [
    ['a message named with an @ in it', (box) => {
      writeCatalog(box, { 'foo@bar': { message: 'x' } });
      editManifest(box, m => { m.name = '__MSG_foo@bar__'; });
    }],
    ['the extension id read from a stylesheet', (box) => {
      fs.writeFileSync(`${box}/styles.css`,
        'body { background: url("__MSG_@@extension_id__") }\n');
      editManifest(box, m => {
        m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
      });
    }],
    ['a positional argument in a placeholder', (box) => writeCatalog(box,
      { extName: { message: 'hi $WHO$', placeholders: { who: { content: '$1' } } } })],
    ['two references sharing a delimiter, both defined', (box) => writeCatalog(box,
      { extName: { message: '$A$$B$',
        placeholders: { a: { content: '$1' }, b: { content: '$2' } } } })],
    ['a placeholder named with an @ in it', (box) => writeCatalog(box,
      { extName: { message: '$A@B$', placeholders: { 'a@b': { content: '$1' } } } })],
    ['a description that is not text',
      (box) => writeCatalog(box, { extName: { message: 'x', description: 7 } })],
    ['an example that is not text', (box) => writeCatalog(box,
      { extName: { message: 'x $A$', placeholders: { a: { content: '$1', example: 7 } } } })],
    ['two names differing only in case', (box) => writeCatalog(box,
      { extName: { message: 'x' }, EXTNAME: { message: 'y' } })],
    ['a catalog answering for a name under @@', (box) => {
      writeCatalog(box, { extName: { message: 'x' }, '@@custom': { message: 'y' } });
      editManifest(box, m => { m.description = '__MSG_@@custom__'; });
    }],
    // The extension id is the catalog's to answer for: Chrome does not supply
    // it to the manifest, and refusing the name outright would take this too.
    ['a catalog answering for the extension id, asked for in the manifest', (box) => {
      writeCatalog(box,
        { extName: { message: 'x' }, '@@extension_id': { message: 'y' } });
      editManifest(box, m => { m.description = '__MSG_@@extension_id__'; });
    }],
    // A candidate that is not a name is passed over rather than refused, so a
    // reference whose name ends in a newline names nothing at all. It goes in
    // a stylesheet because the manifest is read as the JSON text it is, where
    // a newline is written as an escape and never reaches a candidate.
    // Chrome reads both files with a byte order mark and with comments, and
    // reads neither the // in a URL nor the /* in a message as one.
    ['a byte order mark on the manifest', (box) => {
      const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
      fs.writeFileSync(`${box}/manifest.json`, '\uFEFF' + text);
    }],
    ['a byte order mark on the catalog', (box) => {
      const text = fs.readFileSync(`${box}/_locales/ja/messages.json`, 'utf8');
      fs.writeFileSync(`${box}/_locales/ja/messages.json`, '\uFEFF' + text);
    }],
    ['a line comment in the manifest', (box) => {
      const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
      fs.writeFileSync(`${box}/manifest.json`, '{\n  // what this is\n' + text.slice(1));
    }],
    ['a line comment in the catalog', (box) => fs.writeFileSync(
      `${box}/_locales/ja/messages.json`,
      '{\n  // the name\n  "extName": { "message": "x" }\n}')],
    ['a block comment in the catalog', (box) => fs.writeFileSync(
      `${box}/_locales/ja/messages.json`,
      '{\n  /* the name */\n  "extName": { "message": "x" }\n}')],
    // The manifest is walked as the values it decoded to: a reference inside a
    // comment is one Chrome dropped before parsing, a reference spelled with
    // escapes is one it decoded, and an object key is not a field it localizes.
    ['a reference nothing answers, inside a line comment', (box) => {
      const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
      fs.writeFileSync(`${box}/manifest.json`,
        '{\n  // "description": "__MSG_absent__"\n' + text.slice(1));
    }],
    ['a reference nothing answers, inside a block comment', (box) => {
      const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
      fs.writeFileSync(`${box}/manifest.json`,
        '{\n  /* "description": "__MSG_absent__" */\n' + text.slice(1));
    }],
    ['the extension id inside a comment', (box) => {
      const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
      fs.writeFileSync(`${box}/manifest.json`,
        '{\n  // "description": "__MSG_@@extension_id__"\n' + text.slice(1));
    }],
    ['a reference spelled with escapes that the catalog answers', (box) => {
      writeCatalog(box, { extName: { message: 'x' }, absent: { message: 'y' } });
      appendRaw(box, '"description":"__MSG_\\u0061bsent__"');
    }],
    ['a reference in an object key rather than a value',
      (box) => editManifest(box, m => { m['__MSG_absent__'] = 'x'; })],
    ['a comment opener inside a string value', (box) => {
      editManifest(box, m => { m.homepage_url = 'https://example.com/*'; });
      // The escaped quote is the point: a scanner that does not step over it
      // ends the string early and reads the // after it as a comment.
      writeCatalog(box, { extName: { message: 'a \" b // c /* d' } });
    }],
    ['a reference whose candidate is not a name', (box) => {
      fs.writeFileSync(`${box}/styles.css`, 'body { content: "__MSG_abc\n__" }\n');
      editManifest(box, m => {
        m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
      });
    }],
    ['the extension id asked for in capitals from a stylesheet', (box) => {
      fs.writeFileSync(`${box}/styles.css`,
        'body { background: url("__MSG_@@EXTENSION_ID__") }\n');
      editManifest(box, m => {
        m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
      });
    }],
    // The three sides of the version rule that a stricter one would refuse.
    // Without these, refusing every version would stay green.
    ['a version of four parts',
      (box) => editManifest(box, m => { m.version = '1.0.0.0'; })],
    ['a leading zero in a part that is not the first',
      (box) => editManifest(box, m => { m.version = '1.01.0'; })],
    ['a version part at the largest number one holds',
      (box) => editManifest(box, m => { m.version = '4294967295'; })],
    // The shape a prerelease takes: Chrome reads the version and shows the
    // name. Without this the rule above would refuse the only shape that
    // lets the prerelease branch of the release grammar build anything.
    ['a prerelease named beside the version Chrome reads', (box) => {
      editManifest(box, m => {
        m.version = '1.2.0';
        m.version_name = '1.2.0-rc1';
      });
    }],
    // Naming nothing has nothing to do with spelling: Chrome takes a pattern
    // that matches no file, so this does too.
    ['a resource pattern that names nothing', (box) => {
      fs.mkdirSync(`${box}/images`);
      fs.writeFileSync(`${box}/images/logo.png`, 'x');
      editManifest(box, m => {
        m.web_accessible_resources = [{ resources: ['images/*.svg'],
          matches: ['https://example.com/*'] }];
      });
    }],
    // The spelling is compared, not folded: a name the tree really carries
    // in capitals is the name that opens it. Without this the rule above
    // could refuse every reference and stay green.
    ['a name the tree carries in capitals', (box) => {
      fs.renameSync(`${box}/content.js`, `${box}/Content.js`);
      editManifest(box, m => { m.content_scripts = [{ js: ['Content.js'] }]; });
    }],
    // The Norwegian the store does carry, which is the name an extension
    // reaching for nb is told to use instead. Without this the rule above
    // could refuse every locale and stay green.
    ['a locale the store carries under a name of its own', (box) => {
      fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/no`);
      editManifest(box, m => { m.default_locale = 'no'; });
    }],
    // Without these two the rules above could refuse every locale that is not
    // the default one, and every region the store spells in capitals, and stay
    // green.
    ['a second locale the store carries',
      (box) => fs.cpSync(`${box}/_locales/ja`, `${box}/_locales/en`, { recursive: true })],
    // Beside the catalog the locale already carries. Without this the rule
    // above could refuse every packaged name under _locales — the catalogs
    // themselves among them — and stay green.
    ['a referenced file beside the catalog of the locale it sits in', (box) => {
      fs.writeFileSync(`${box}/_locales/ja/icon.png`, 'png');
      editManifest(box, m => { m.action = { default_icon: '_locales/ja/icon.png' }; });
    }],
    ['a locale the store spells with its region in capitals', (box) => {
      fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/en_GB`);
      editManifest(box, m => { m.default_locale = 'en_GB'; });
    }],
    // Outside the fields Chrome localizes, a reference is not a reference:
    // the string reaches the browser as it stands, a file name included.
    ['a content script named like a message', (box) => {
      fs.renameSync(`${box}/content.js`, `${box}/__MSG_absent__.js`);
      editManifest(box, m => {
        m.content_scripts = [{ js: ['__MSG_absent__.js'] }];
      });
    }],
    ['a reference in a field Chrome leaves as it stands',
      (box) => editManifest(box, m => { m.author = { email: '__MSG_absent__' }; })]
  ]) {
    const box = buildMinimal();
    arrange(box);
    const listed = runPack(box, ['--list']);
    assert(listed.status === 0,
      `${shape} packs — ${(listed.stderr || '').trim()}`);
    fs.rmSync(box, { recursive: true, force: true });
  }

  // A message Chrome defines itself needs no catalog entry. Without this the
  // rule above could refuse every @@ name and stay green.
  {
    const box = buildMinimal();
    editManifest(box, (m) => { m.description = '__MSG_@@ui_locale__'; });
    const listed = runPack(box, ['--list']);
    assert.equal(listed.status, 0, listed.stderr);
    fs.rmSync(box, { recursive: true, force: true });
  }

  // Asking for no message, an extension needs no catalog and no locale name.
  // Without this the contract above could refuse everything and stay green.
  {
    const box = buildMinimal();
    fs.rmSync(path.join(box, '_locales'), { recursive: true });
    editManifest(box, (m) => { delete m.default_locale; m.name = 'Plain'; });
    const listed = runPack(box, ['--list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(
      listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort(),
      ['LICENSE', 'content.js', 'manifest.json']);
    fs.rmSync(box, { recursive: true, force: true });
  }

  // Resolving every name answers for one that is missing; reading one can still
  // fail. What the package built last is worth is that it stays.
  const entriesIn = (zip) => spawnSync('python3',
    ['-c', 'import zipfile,sys;print(len(zipfile.ZipFile(sys.argv[1]).namelist()))', zip],
    { encoding: 'utf8' }).stdout.trim();
  for (const unreadable of ['LICENSE', '_locales/ja/messages.json']) {
    const box = buildMinimal();
    const built = runPack(box, []);
    assert.equal(built.status, 0, built.stderr);
    const zip = path.join(box, 'twitch-channel-volume-0.0.0.zip');
    const before = fs.statSync(zip).size;
    const entries = entriesIn(zip);
    fs.chmodSync(path.join(box, unreadable), 0o000);
    let denied = true;
    try { fs.readFileSync(path.join(box, unreadable)); denied = false; } catch { /* denied */ }
    if (!denied) {
      // Running as a user the mode does not stop, so the case cannot be made.
      console.log(`  (read-failure check skipped: ${unreadable} is readable at mode 000)`);
      fs.chmodSync(path.join(box, unreadable), 0o644);
      fs.rmSync(box, { recursive: true, force: true });
      continue;
    }
    const failed = runPack(box, []);
    fs.chmodSync(path.join(box, unreadable), 0o644);
    assert.notEqual(failed.status, 0, `pack.py fails when ${unreadable} cannot be read`);
    assert.ok(fs.existsSync(zip) && fs.statSync(zip).size === before,
      `the package built before survives a read failure on ${unreadable}`);
    assert.equal(entriesIn(zip), entries,
      `the package built before still carries ${entries} entries`);
    assert.deepEqual(fs.readdirSync(box).filter((name) => name.endsWith('.part')), [],
      'a half-built package is not left beside the one that stands');
    fs.rmSync(box, { recursive: true, force: true });
  }

  // A name the walk reaches and the locale sweep or DISTRIBUTION_FILES reaches
  // too. zipfile writes the second entry and warns on stderr, which the release
  // path does not read.
  {
    const box = buildMinimal();
    const manifest = JSON.parse(fs.readFileSync(path.join(box, 'manifest.json'), 'utf8'));
    manifest.web_accessible_resources = [
      { resources: ['LICENSE', '_locales/ja/messages.json'], matches: ['*://*/*'] }
    ];
    fs.writeFileSync(path.join(box, 'manifest.json'), JSON.stringify(manifest));
    const listed = runPack(box, ['--list']);
    assert.equal(listed.status, 0, listed.stderr);
    const names = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.equal(names.length, new Set(names).size, `each name enters the package once`);
    fs.rmSync(box, { recursive: true, force: true });
  }

  // A package built twice from the same files is the same package. Beyond a
  // file's name and bytes a zip entry carries the time the host last wrote it
  // and the mode the host holds it under, and a checkout supplies both afresh
  // — so an archive taking either from the tree differs on every run, and the
  // zip a release uploaded cannot be built again and compared.
  {
    const digestOf = (stamp, mode, edit) => {
      const box = buildMinimal();
      if (edit) { edit(box); }
      for (const name of ['manifest.json', 'content.js', 'LICENSE',
        '_locales/ja/messages.json']) {
        fs.chmodSync(path.join(box, name), mode);
        fs.utimesSync(path.join(box, name), stamp, stamp);
      }
      const built = runPack(box, []);
      assert.equal(built.status, 0, built.stderr);
      const digest = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(box, 'twitch-channel-volume-0.0.0.zip')))
        .digest('hex');
      fs.rmSync(box, { recursive: true, force: true });
      return digest;
    };
    const plain = digestOf(946684800, 0o644, null);
    assert.equal(plain, digestOf(1700000000, 0o755, null),
      'the same files build the same package, whatever time and mode the host holds them under');
    // Without this the rule above would hold for a packer writing one archive
    // whatever it was given.
    assert.notEqual(plain, digestOf(946684800, 0o644, (box) =>
      fs.writeFileSync(path.join(box, 'content.js'), '// a line the other build has not got\n')),
    'the package still answers for what the files hold');
  }

  // Read back rather than inferred: the host an entry says it came from is
  // filled in from the host that ran the packer where it is not written, and
  // this suite runs on one host.
  {
    const box = buildMinimal();
    const built = runPack(box, []);
    assert.equal(built.status, 0, built.stderr);
    const read = spawnSync('python3', ['-c',
      'import sys, zipfile\n'
      + 'for held in zipfile.ZipFile(sys.argv[1]).infolist():\n'
      + '    print(held.filename, held.date_time, held.create_system,'
      + ' oct(held.external_attr >> 16))',
      'twitch-channel-volume-0.0.0.zip'], { cwd: box, encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    const entries = read.stdout.trim().split('\n').filter(Boolean);
    assert.ok(entries.length > 0, 'the package has entries to read');
    for (const entry of entries) {
      assert.match(entry, / \(1980, 1, 1, 0, 0, 0\) 3 0o100644$/,
        `every entry is written under one time, one host and one mode — ${entry}`);
    }
    fs.rmSync(box, { recursive: true, force: true });
  }

  // zipfile fills an entry's create_system in from sys.platform where the
  // entry has not got one, so the host that runs the packer decides it and the
  // check above reads only this host's answer. Reading it on another host is
  // out of reach here; the reading itself is flipped instead.
  {
    const box = buildMinimal();
    const asWindows = spawnSync('python3', ['-B', '-c',
      'import sys, importlib.util, zipfile\n'
      + 'spec = importlib.util.spec_from_file_location("packmod", "pack.py")\n'
      + 'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n'
      + 'sys.platform = "win32"\n'
      // Without this the run below would prove nothing on a host where the
      // default is 3 already.
      + 'assert zipfile.ZipInfo("x").create_system == 0, "the reading did not flip"\n'
      + 'mod.pack()\n'
      + 'for held in zipfile.ZipFile("twitch-channel-volume-0.0.0.zip").infolist():\n'
      + '    print("entry", held.filename, held.create_system)'],
    { cwd: box, encoding: 'utf8' });
    assert.equal(asWindows.status, 0, asWindows.stderr);
    const hosts = asWindows.stdout.split('\n')
      .map((line) => line.match(/^entry (.+) (\d+)$/)).filter(Boolean);
    assert.ok(hosts.length > 0, 'the package has entries to read');
    for (const [, name, host] of hosts) {
      assert.equal(host, '3', `${name} names one host whatever host packed it`);
    }
    fs.rmSync(box, { recursive: true, force: true });
  }

  // What a run says it packed. The refusals above assert that no line of this
  // shape is printed; without one asserting that it is printed when a package
  // is built, renaming the marker would leave every one of them passing over a
  // run that named the whole tree.
  {
    const box = buildMinimal();
    const built = runPack(box, []);
    assert.equal(built.status, 0, built.stderr);
    const named = built.stdout.split('\n')
      .map((line) => line.match(/^\s*\+ (.+)$/)).filter(Boolean).map((match) => match[1]);
    const listed = runPack(box, ['--list']);
    assert.equal(listed.status, 0, listed.stderr);
    const names = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(named.slice().sort(), names.slice().sort(),
      'a run names what it packed');
    const held = heldInZip(box, 'twitch-channel-volume-0.0.0.zip').map(([name]) => name);
    assert.deepEqual(named.slice().sort(), held.slice().sort(),
      'what it names is what the archive holds');
    fs.rmSync(box, { recursive: true, force: true });
  }

  // An argument nobody recognised is not an instruction to rewrite the package.
  {
    const box = buildMinimal();
    const built = runPack(box, []);
    assert.equal(built.status, 0, built.stderr);
    const zip = path.join(box, 'twitch-channel-volume-0.0.0.zip');
    const stamp = fs.statSync(zip).mtimeMs;
    for (const argument of [['--lst'], ['-l'], ['--help'], ['--list', 'extra']]) {
      const refused = runPack(box, argument);
      assert.notEqual(refused.status, 0, `pack.py refuses ${argument.join(' ')}`);
      assert.doesNotMatch(refused.stdout || '', /^\s*\+ /m,
        `pack.py packs nothing for ${argument.join(' ')}`);
    }
    assert.equal(fs.statSync(zip).mtimeMs, stamp,
      'the package standing there is not rewritten by an argument nobody recognised');
    fs.rmSync(box, { recursive: true, force: true });
  }
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
  const manifest = (references, extra = {}) => JSON.stringify({
    manifest_version: 3,
    version: '1.0.0',
    content_scripts: [{ js: references }],
    ...extra
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
    assert.match(climbing.stderr, /\.\.\/secret\.js/);

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
      fs.writeFileSync(path.join(fixture, 'manifest.json'),
        manifest([], { default_locale: 'ja' }));
      fs.mkdirSync(path.join(fixture, '_locales'));
      fs.symlinkSync(outside, path.join(fixture, '_locales', 'ja'));
    });
    assert.notEqual(linkedLocaleDir.status, 0);
    assert.match(linkedLocaleDir.stderr, /_locales\/ja\/messages\.json/);

    const linkedLocaleRoot = run((fixture) => {
      fs.writeFileSync(path.join(fixture, 'manifest.json'),
        manifest([], { default_locale: 'ja' }));
      fs.symlinkSync(outside, path.join(fixture, '_locales'));
    });
    assert.notEqual(linkedLocaleRoot.status, 0);
    assert.match(linkedLocaleRoot.stderr, /_locales\//);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the store package refuses a reference it cannot pack', () => {
  withFixtureDir('tcv-pack-missing-', (fixture) => {
    const writeManifest = (extra = {}) => fs.writeFileSync(
      path.join(fixture, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        version: '1.0.0',
        content_scripts: [{ js: ['content.js'] }],
        ...extra
      }));
    writeManifest();
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
    // A _locales directory has to be named by a default_locale, so this case
    // names one to reach the rule it is about.
    writeManifest({ default_locale: 'ja' });
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

// The arguments a `[TCV]` log carried, after the label.
function loggedWarning(harness, label) {
  const logged = harness.warnings.find(([message]) => message === label);
  assert.ok(logged, `${label} was not logged`);
  return logged.slice(1);
}

function createContentHarness({
  autoApply = false,
  autoGain,
  href = 'https://www.twitch.tv/videos/100',
  channelVolumes,
  deferInitialStorageGet = false,
  failInitialStorageGet = false,
  deferChannelMutationOperation = '',
  failChannelMutationOperation = ''
} = {}) {
  const listeners = {};
  const documentListeners = {};
  const storageListeners = [];
  const commands = [];
  const warnings = [];
  const infos = [];
  let runtimeMessageListener;
  let runtimeId = 'test-extension';
  let failNextStorageGet = failInitialStorageGet;
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
    addEventListener(type, listener, options) {
      const list = (documentListeners[type] ||= []);
      if (list.some((entry) => entry.listener === listener)) return;
      list.push({ listener, once: !!(options && options.once) });
    },
    removeEventListener(type, listener) {
      const list = documentListeners[type];
      if (!list) return;
      const at = list.findIndex((entry) => entry.listener === listener);
      if (at >= 0) list.splice(at, 1);
    },
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
          if (channelMutationDeferred &&
              mutation.operation === deferChannelMutationOperation) {
            channelMutationDeferred = false;
            await new Promise((resolve) => { resolveChannelMutation = resolve; });
          }
          if (mutation.operation === failingChannelMutationOperation) {
            failingChannelMutationOperation = '';
            return { ok: false, reason: 'storage-update-failed' };
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
      info(...args) { infos.push(args); }
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
    infos,
    async dispatchMessage(data) {
      await Promise.all((listeners.message || []).map((listener) => listener({ source: window, data })));
    },
    async dispatchDocument(type) {
      for (const entry of (documentListeners[type] || []).slice()) {
        // A listener registered with `once` is gone the moment it is called.
        if (entry.once) {
          const list = documentListeners[type];
          const at = list.indexOf(entry);
          if (at >= 0) list.splice(at, 1);
        }
        entry.listener({ type });
      }
      await flushTasks();
    },
    documentListenerCount(type) { return (documentListeners[type] || []).length; },
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
  const warnings = [];
  const alerts = [];
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
  // The stub keeps markup as text. The rows the page builds carry the delete
  // buttons it wires straight afterwards, so the lookup for them is answered
  // out of the ids in that text.
  const channelsBody = element('channelsBody');
  const deleteButtons = new Map();
  channelsBody.querySelectorAll = (selector) => {
    if (selector !== 'button[data-id]') return [];
    return [...channelsBody.textContent.matchAll(/data-id="([^"]*)"/g)].map(([, id]) => {
      if (!deleteButtons.has(id)) {
        const button = stubElement(`ch-del-${id}`);
        button.setAttribute('data-id', id);
        deleteButtons.set(id, button);
      }
      // One handler per render, as a fresh element would carry.
      deleteButtons.get(id).listeners.click = [];
      return deleteButtons.get(id);
    });
  };
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
    console: {
      warn(...args) { warnings.push(args); },
      error() {},
      info() {}
    },
    alert(message) { alerts.push(message); },
    confirm() { return true; },
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
    warnings,
    alerts,
    timers,
    async fire(id, type) {
      for (const listener of element(id).listeners[type] || []) await listener({ target: element(id) });
      await flushTasks(8);
    },
    async clickDelete(channelId) {
      const button = deleteButtons.get(channelId);
      assert.ok(button, `no delete button for ${channelId}`);
      for (const listener of button.listeners.click || []) await listener({ target: button });
      await flushTasks(8);
    },
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
  failCommand = '',
  tabUrl = 'https://www.twitch.tv/somechannel',
  sendMessageError = ''
} = {}) {
  // A string fails every command, the way a content script that is gone does.
  // An object fails the commands it names, for the round trip that dies partway.
  let thrownBySendMessage = sendMessageError;
  let thrownByTabQuery = '';
  let activeTabUrl = tabUrl;
  const messages = JSON.parse(
    fs.readFileSync(path.join(__dirname, '_locales/ja/messages.json'), 'utf8')
  );
  const elements = new Map();
  const presetButtons = [];
  const sent = [];
  const warnings = [];
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
      async query() {
        if (thrownByTabQuery) throw new Error(thrownByTabQuery);
        return [activeTabUrl ? { id: 1, url: activeTabUrl } : { id: 1 }];
      },
      async sendMessage(_tabId, request) {
        sent.push(structuredClone(request));
        // What Chrome rejects with when nothing is listening in that tab.
        const thrown = typeof thrownBySendMessage === 'string'
          ? thrownBySendMessage
          : thrownBySendMessage?.[request.cmd];
        if (thrown) throw new Error(thrown);
        if (request.cmd === 'getState') return structuredClone(currentState);
        if (request.cmd === failCommand) {
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
    console: {
      warn(...args) { warnings.push(args); },
      error() {},
      info() {}
    },
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
    warnings,
    message: (key, substitutions) => {
      const text = messages[key] ? messages[key].message : key;
      return substitutions && substitutions.length
        ? text.replace('$VALUE$', substitutions[0])
        : text;
    },
    setState(next) { currentState = { ...currentState, ...next }; },
    breakSendMessage(spec) { thrownBySendMessage = spec; },
    breakTabQuery(message) { thrownByTabQuery = message; },
    setTabUrl(url) { activeTabUrl = url; },
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
  contextStartsSuspended = false,
  contextRefusesResume = false,
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
  const pageHref = 'https://www.twitch.tv/videos/100';
  const location = { href: pageHref, origin: new URL(pageHref).origin };
  const videos = [];
  const makeVideo = (props = {}) => {
    const listeners = {};
    return {
      // The player element takes its media from a MediaSource, so it carries
      // no URL of its own.
      src: '',
      currentSrc: '',
      srcObject: {},
      crossOrigin: null,
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
  const warnings = [];
  let refusesResume = contextRefusesResume;
  let builtContext = null;
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
      // Chrome starts a context suspended until the page has been interacted
      // with.
      this.state = contextStartsSuspended ? 'suspended' : 'running';
      this.listeners = {};
      builtContext = this;
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
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    async resume() {
      // What Chrome does with a context the page has earned no gesture for.
      if (refusesResume || this.state === 'running') return;
      this.state = 'running';
      fire(this, 'statechange');
    }
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
    console: {
      warn(...args) { warnings.push(args); },
      error() {},
      info(...args) { logs.push(args); }
    },
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
    warnings,
    refuseResume(value) { refusesResume = value; },
    suspendContext() {
      builtContext.state = 'suspended';
      fire(builtContext, 'statechange');
    },
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
      // A creative comes from another origin, and the element that plays one
      // asks for it in CORS mode.
      const extra = makeVideo({
        src: 'https://ads.example/creative.mp4',
        srcObject: null,
        crossOrigin: 'anonymous',
        ...props
      });
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
  const manifest = readJson('manifest.json');
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
    // The host row is one of them; a policy that names a permission the manifest
    // does not ask for, or drops one it does, is the other half of "exactly".
    const rows = new Set(
      [...text.matchAll(/^\| \*\*([A-Za-z_]+)\*\*/gm)].map((m) => m[1])
    );
    assert.deepEqual([...rows].sort(), [...manifest.permissions, 'host_permissions'].sort(),
      `${file} permission rows`);
  }
});

// The generator's own source names the scenes it draws and the languages it
// draws them in; reading it here is what ties each README to its own images.
function drawnScreenshots() {
  const source = fs.readFileSync(path.join(__dirname, 'gen_screenshots.py'), 'utf8');
  const outDir = source.match(/^OUT_DIR = os\.path\.join\(ROOT, '([^']+)', '([^']+)'\)$/m);
  const scenes = [...source.matchAll(/img\.save\(os\.path\.join\(out_dir, f'([a-z_]+)_\{lang\}\.png'\)\)/g)]
    .map((m) => m[1]);
  const langs = source.match(/for lang in \(([^)]+)\):/);
  assert.ok(outDir, 'gen_screenshots.py declares OUT_DIR beside itself');
  assert.ok(scenes.length > 0, 'gen_screenshots.py names the scenes it saves');
  assert.ok(langs, 'gen_screenshots.py names the languages it draws');
  return {
    dir: `${outDir[1]}/${outDir[2]}`,
    scenes,
    langs: [...langs[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  };
}

// From the directory rather than a literal pair: a README added without a
// language of its own is one this still reads.
const README_FILES = fs.readdirSync(__dirname)
  .filter((name) => /^README(\.[a-z][a-z-]*)?\.md$/.test(name)).sort();
const EMBED = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;

test('each README shows its own language, and every image it shows exists', () => {
  const { dir, scenes, langs } = drawnScreenshots();
  const suffixed = new Map(README_FILES.filter((name) => name !== 'README.md')
    .map((name) => [name, name.slice('README.'.length, -'.md'.length)]));
  const spare = langs.filter((lang) => ![...suffixed.values()].includes(lang));
  assert.ok(README_FILES.includes('README.md') && spare.length === 1,
    'exactly one language the generator draws is the unsuffixed README');
  const readmeLang = new Map([['README.md', spare[0]], ...suffixed]);
  assert.deepEqual([...readmeLang.values()].sort(), [...langs].sort(),
    'every language the generator draws has a README of its own');
  // A count over the two files together is satisfied by either one of them, so
  // each is held to the full set of its own language.
  for (const [file, lang] of readmeLang) {
    const embeds = [...fs.readFileSync(path.join(__dirname, file), 'utf8').matchAll(EMBED)]
      .map((m) => m[1] || m[2]).filter((image) => !/^https?:/.test(image));
    for (const image of embeds) {
      assert.ok(fs.existsSync(path.join(__dirname, image)),
        `${file} embeds ${image}, which must exist`);
    }
    assert.deepEqual([...new Set(embeds.filter((image) => image.startsWith(`${dir}/`)))].sort(),
      scenes.map((scene) => `${dir}/${scene}_${lang}.png`).sort(),
      `${file} shows every ${lang} screenshot and no other language's`);
  }
});

test('the documentation pairs keep their names, their shape and their links', () => {
  // The Chrome Web Store listing links to PRIVACY_POLICY.md by path.
  for (const file of ['PRIVACY_POLICY.md', 'PRIVACY_POLICY_JA.md']) {
    assert.ok(fs.existsSync(path.join(__dirname, file)), `${file} keeps its name`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, 'CLAUDE.ja.md')),
    'CLAUDE.md has no Japanese counterpart');

  const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
  const headings = (text) => {
    const levels = [];
    let fence = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      const head = fence ? null : line.match(/^(#{1,6}) /);
      if (head) { levels.push(head[1].length); }
    }
    return levels;
  };
  // Cell counts per row: the labels are translations, so position is the only
  // key. A row moved within a table reads the same from here.
  const tableShape = (text) => text.split('\n')
    .filter((line) => /^\s*\|/.test(line)).map((line) => line.split('|').length);

  const PAIRS = [
    ['README.md', 'README.ja.md'],
    ['docs/en/security-audit.md', 'docs/ja/security-audit.md'],
    ['PRIVACY_POLICY.md', 'PRIVACY_POLICY_JA.md']
  ];
  for (const [en, ja] of PAIRS) {
    for (const file of [en, ja]) {
      assert.ok(fs.existsSync(path.join(__dirname, file)), `${file} is one half of a pair`);
    }
    assert.deepEqual(headings(read(ja)), headings(read(en)),
      `${ja} carries the same headings as ${en}, in the same order`);
    assert.deepEqual(tableShape(read(ja)), tableShape(read(en)),
      `${ja} carries the same table rows as ${en}, in the same order`);
  }

  for (const file of [...new Set(PAIRS.flat())]) {
    const from = path.dirname(path.join(__dirname, file));
    for (const [, target] of read(file).matchAll(/\]\(\s*([^)\s#]+)/g)) {
      if (/^(https?:|mailto:)/.test(target)) { continue; }
      assert.ok(fs.existsSync(path.resolve(from, target)),
        `${file} links to ${target}, which must exist`);
    }
  }
});

test('the issue templates are English, with the note that says Japanese is welcome', () => {
  const directory = path.join(__dirname, '.github/ISSUE_TEMPLATE');
  const templates = fs.readdirSync(directory).filter((name) => name.endsWith('.md'));
  assert.ok(templates.length > 0, 'there are issue templates to read');
  for (const name of templates) {
    const text = fs.readFileSync(path.join(directory, name), 'utf8');
    const note = text.split('\n').filter((line) => line.includes('日本語で構いません'));
    assert.equal(note.length, 1, `${name} carries the note that Japanese is welcome`);
    const rest = text.split('\n').filter((line) => !line.includes('日本語で構いません')).join('\n');
    assert.ok(!/[぀-ヿ一-鿿]/.test(rest),
      `${name} is English apart from that note`);
  }
});

test('the page is given the worklet module and nothing else', () => {
  const manifest = readJson('manifest.json');
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

test('auto-apply fields are independent for Live and VOD', () => {
  assert.equal(u.autoApplyFieldForKind('live'), 'autoApplyLoudnessLive');
  assert.equal(u.autoApplyFieldForKind('vod'), 'autoApplyLoudnessVod');
  assert.equal(
    u.autoApplyDefaultFieldForKind('vod'),
    'autoApplyLoudnessVodDefault'
  );
  assert.equal(u.autoGainFieldForKind('live'), 'autoGainLive');
  assert.equal(u.autoGainFieldForKind('vod'), 'autoGainVod');
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
  assert.equal(u.resolveAutoApplySetting({ gainVod: 0.8 }, 'vod', true), false);
  assert.equal(u.resolveAutoApplySetting({ gainLive: 0.8 }, 'vod', true), true);
  assert.equal(u.resolveAutoApplySetting({ name: 'Unconfigured' }, 'vod', true), true);
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
  // The gain a version before the per-kind fields wrote answers for any kind.
  assert.equal(u.extractGainForKind({ gain: 0.6 }, 'vod'), 0.6);
  assert.equal(u.extractGainForKind({ gain: 0.6, gainVod: 0.4 }, 'vod'), 0.4);
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

  // A clip carries no channel of its own, so no owner is matched to it.
  const clip = u.classifyTwitchUrl('https://clips.twitch.tv/SomeClipSlug');
  assert.equal(u.ownerMatchesTwitchContent({
    userId: '456', source: 'clip', contentKind: 'clip', contentId: 'SomeClipSlug'
  }, clip), false);
  assert.equal(u.provisionalChannelIdForContent(vod), 'vod-owner:2770346335');
  assert.equal(u.provisionalChannelIdForContent(clip), '');
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

test('content names the storage failure behind a rejected gain save', async () => {
  const harness = createContentHarness({ failChannelMutationOperation: 'saveGain' });
  await flushTasks();

  const response = await harness.dispatchRuntime({ cmd: 'setGain', gain: 2 });
  await flushTasks();

  assert.equal(response.ok, false);
  assert.equal(response.reason, 'storage update failed');
  // Restoring the saved gain succeeds here, so this log is the only place the
  // failure that discarded the viewer's setting can still be read.
  const [payload] = loggedWarning(harness, '[TCV] failed to save gain');
  assert.equal(payload.channelId, 'vod-owner:100');
  assert.equal(payload.kind, 'vod');
  assert.equal(payload.gain, 2);
  assert.equal(String(payload.saveError?.message), 'storage-update-failed');
});

test('content names the channel a failed gain save was for', async () => {
  const harness = createContentHarness({
    deferChannelMutationOperation: 'saveGain',
    failChannelMutationOperation: 'saveGain'
  });
  await flushTasks();

  const pending = harness.dispatchRuntime({ cmd: 'setGain', gain: 2 });
  await flushTasks();
  await harness.navigate('https://www.twitch.tv/videos/200');
  harness.releaseChannelMutation();
  const response = await pending;
  await flushTasks();

  assert.equal(response.ok, false);
  // The media on screen has moved on; the log is about the one the save was for.
  const [payload] = loggedWarning(harness, '[TCV] failed to save gain');
  assert.equal(payload.channelId, 'vod-owner:100');
  assert.equal(payload.kind, 'vod');
});

test('content answers a command it does not implement', async () => {
  const harness = createContentHarness();
  await flushTasks();

  const response = await harness.dispatchRuntime({ cmd: 'setVolumeSomehow' });

  assert.equal(response.ok, false);
  assert.equal(response.reason, 'unknown command');
  const [cmd] = loggedWarning(harness, '[TCV] unknown command');
  assert.equal(cmd, 'setVolumeSomehow');
});

test('content reports a bridge message it could not finish handling', async () => {
  const harness = createContentHarness();
  await flushTasks();
  harness.failNextStorageGet();

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'owner',
    userId: '123456789',
    login: 'fixture_channel',
    displayName: 'Fixture_Channel',
    source: 'video',
    contentKind: 'vod',
    contentId: '100'
  });

  const [payload] = loggedWarning(harness, '[TCV] failed to handle a bridge message');
  assert.equal(payload.event, 'owner');
  assert.equal(String(payload.error?.message), 'injected storage read failure');
});

test('content reports a route change it could not finish handling', async () => {
  const harness = createContentHarness();
  await flushTasks();
  harness.failNextStorageGet();

  await harness.navigate('https://www.twitch.tv/videos/200');

  const [error] = loggedWarning(harness, '[TCV] failed to handle a route change');
  assert.equal(String(error?.message), 'injected storage read failure');
});

test('content reports a startup it could not finish', async () => {
  const harness = createContentHarness({ failInitialStorageGet: true });
  await flushTasks();

  const [error] = loggedWarning(harness, '[TCV] failed to start up');
  assert.equal(String(error?.message), 'injected storage read failure');
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
        ...measured({ live: -17, vod: -21 })
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

test('content keeps the expected clip refusal out of the warnings', async () => {
  const harness = createContentHarness({ href: 'https://clips.twitch.tv/AbcDef' });
  await flushTasks();
  const unavailable = () => harness.warnings
    .filter((args) => args[0] === '[TCV] player audio unavailable');

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    cause: 'cross-origin',
    reason: 'media is served from another origin without CORS'
  });
  let state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailableCause, 'cross-origin');
  // Chrome collects a content script's warnings as extension errors, and there
  // is nothing the viewer can do about this one.
  assert.deepEqual(unavailable(), []);
  // Demoted, not dropped: it is still the record of why the gain stopped.
  assert.equal(
    harness.infos.filter((args) => args[0] === '[TCV] player audio unavailable').length,
    1
  );

  // A cause that asks the viewer to do something is still a warning.
  await harness.dispatchMessage({ type: '__twitch_channel_volume__', event: 'loaded' });
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    cause: 'audio-context',
    reason: 'audio context unavailable'
  });
  state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailableCause, 'audio-context');
  assert.equal(unavailable().length, 1);
});

test('content refuses a request for a kind it does not have', async () => {
  const harness = createContentHarness({ href: 'https://www.twitch.tv/somechannel' });
  await flushTasks();
  const before = structuredClone(harness.stored[u.CHANNEL_VOLUMES_KEY]);

  // Clip was a kind of its own until this version. A page still running the
  // old content script asks for it by name.
  for (const cmd of ['setAutoApplyLoudness', 'resetMeasurement']) {
    const res = await harness.dispatchRuntime({
      cmd, channelId: 'login:somechannel', kind: 'clip', enabled: true
    });
    assert.equal(res.ok, false, cmd);
    assert.equal(res.reason, 'channel mismatch', cmd);
  }
  assert.deepEqual(harness.stored[u.CHANNEL_VOLUMES_KEY], before);
});

test('content refuses a gain with no channel to save it to', async () => {
  const harness = createContentHarness({ href: 'https://clips.twitch.tv/AbcDef' });
  await flushTasks();
  const before = structuredClone(harness.stored[u.CHANNEL_VOLUMES_KEY]);

  const res = await harness.dispatchRuntime({ cmd: 'setGain', gain: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'channel mismatch');
  assert.deepEqual(harness.stored[u.CHANNEL_VOLUMES_KEY], before);
});

test('content drops a clip refusal when the page leaves the clip', async () => {
  const harness = createContentHarness({ href: 'https://www.twitch.tv/streamer/clip/AbcDef' });
  await flushTasks();
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    cause: 'cross-origin',
    reason: 'media is served from another origin without CORS'
  });
  assert.equal((await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailable, true);

  // The next page has its own element, and the bridge reports that one for
  // itself; the clip's refusal would otherwise be shown against it.
  await harness.navigate('https://www.twitch.tv/streamer');
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, false);
  assert.equal(state.audioUnavailableCause, '');
});

test('content asks for a resume on a keypress as well as on a click', async () => {
  const harness = createContentHarness();
  await flushTasks();
  const resumes = () => harness.commands.filter((command) => command.cmd === 'resume').length;

  // The viewer unmutes with the player's keyboard shortcut and never clicks.
  await harness.dispatchDocument('keydown');
  assert.equal(resumes(), 1);
});

test('content keeps asking for a resume until the context runs', async () => {
  const harness = createContentHarness();
  await flushTasks();
  const resumes = () => harness.commands.filter((command) => command.cmd === 'resume').length;

  // The first gesture can land before the context exists, and answers with a
  // state that is not running.
  await harness.dispatchDocument('click');
  assert.equal(resumes(), 1);
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'audio-context',
    state: 'suspended'
  });

  await harness.dispatchDocument('click');
  assert.equal(resumes(), 2);
});

test('content stops asking for a resume once the context runs', async () => {
  const harness = createContentHarness();
  await flushTasks();
  const resumes = () => harness.commands.filter((command) => command.cmd === 'resume').length;

  await harness.dispatchDocument('click');
  assert.equal(resumes(), 1);
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'audio-context',
    state: 'running'
  });
  assert.equal(harness.documentListenerCount('click'), 0);
  assert.equal(harness.documentListenerCount('keydown'), 0);

  await harness.dispatchDocument('click');
  await harness.dispatchDocument('keydown');
  assert.equal(resumes(), 1);

  // A context that stops running is asked for again.
  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'audio-context',
    state: 'suspended'
  });
  await harness.dispatchDocument('keydown');
  assert.equal(resumes(), 2);
});

test('page bridge reports the state of the context it built', async () => {
  const harness = createPageBridgeHarness({ contextStartsSuspended: true });
  await harness.dispatchCommand('init');
  const states = () => harness.messages
    .filter((message) => message.event === 'audio-context')
    .map((message) => message.state);
  assert.deepEqual(states(), ['suspended']);

  await harness.dispatchCommand('resume');
  // The state change and the answer to the command both carry it.
  assert.equal(states().at(-1), 'running');
});

test('page bridge names a context that will not resume once, not once a gesture', async () => {
  const harness = createPageBridgeHarness({ contextStartsSuspended: true, contextRefusesResume: true });
  await harness.dispatchCommand('init');
  const refusals = () => harness.warnings
    .filter((entry) => entry[0] === '[TCV] audio context stayed').length;

  // Every click and every keypress asks again for as long as it stays put.
  for (let i = 0; i < 5; i++) await harness.dispatchCommand('resume');
  assert.equal(refusals(), 1);

  harness.refuseResume(false);
  await harness.dispatchCommand('resume');
  assert.equal(refusals(), 1);

  // A context that ran and stopped again is a state worth naming afresh.
  harness.refuseResume(true);
  harness.suspendContext();
  await harness.dispatchCommand('resume');
  assert.equal(refusals(), 2);
});

test('page bridge answers a resume for a context that was already running', async () => {
  const harness = createPageBridgeHarness();
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('resume');
  assert.equal(
    harness.messages.filter((message) => message.event === 'audio-context').at(-1).state,
    'running'
  );
});

test('page bridge builds the context a resume arrives before', async () => {
  const harness = createPageBridgeHarness({ contextStartsSuspended: true });
  // No init: the gesture is the first thing the bridge is asked to act on.
  await harness.dispatchCommand('resume');
  assert.equal(
    harness.messages.filter((message) => message.event === 'audio-context').at(-1).state,
    'running'
  );
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

test('content carries a notice that is not the clip\'s across a clip', async () => {
  const harness = createContentHarness({ href: 'https://www.twitch.tv/streamer' });
  await flushTasks();
  // Another script holds the player's audio. The bridge reports that once, and
  // the element it named stays in the page.
  await harness.dispatchMessage(ATTACH_FAILED);
  assert.equal((await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailableCause, 'element-taken');

  await harness.navigate('https://www.twitch.tv/streamer/clip/AbcDef');
  await harness.navigate('https://www.twitch.tv/streamer');

  // Nothing reported it again on the way back, so dropping it here would drop
  // it for good.
  const state = await harness.dispatchRuntime({ cmd: 'getState' });
  assert.equal(state.audioUnavailable, true);
  assert.equal(state.audioUnavailableCause, 'element-taken');
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

  await harness.dispatchMessage({
    type: '__twitch_channel_volume__',
    event: 'attach-failed',
    cause: 'cross-origin',
    reason: 'media is served from another origin without CORS'
  });
  assert.equal(
    (await harness.dispatchRuntime({ cmd: 'getState' })).audioUnavailableCause,
    'cross-origin'
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
  for (const kind of ['live', 'vod']) {
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
  for (const kind of ['live', 'vod']) {
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

test('content leaves a VOD seed the weight it was measured over', async () => {
  const harness = createContentHarness({
    href: 'https://www.twitch.tv/videos/100',
    channelVolumes: { 'vod-owner:100': { name: '100', ...measured({ vod: -16 }, 900) } }
  });
  await flushTasks();

  const resets = harness.commands.filter((command) => command.cmd === 'resetMeasurement');
  assert.ok(resets.length >= 1);
  assert.equal(resets.at(-1).initialIntegratedWindows, 900);
});

test('content keeps no channel for a clip', async () => {
  for (const href of [
    'https://www.twitch.tv/streamer/clip/AbcDef',
    'https://clips.twitch.tv/AbcDef'
  ]) {
    const harness = createContentHarness({ href });
    await flushTasks();
    const before = structuredClone({
      channels: harness.stored[u.CHANNEL_VOLUMES_KEY],
      aliases: harness.stored[u.CHANNEL_ALIASES_KEY]
    });
    await harness.dispatchMessage({
      type: '__twitch_channel_volume__',
      event: 'owner',
      userId: '777',
      login: 'streamer',
      displayName: 'Streamer',
      source: 'clip',
      contentKind: 'clip',
      contentId: 'AbcDef'
    });

    const state = await harness.dispatchRuntime({ cmd: 'getState' });
    assert.equal(state.channel.kind, 'clip', href);
    assert.equal(state.channel.id, '', href);
    // Nothing about the clip reached storage: no row, and no alias for its slug.
    assert.deepEqual({
      channels: harness.stored[u.CHANNEL_VOLUMES_KEY],
      aliases: harness.stored[u.CHANNEL_ALIASES_KEY]
    }, before, href);
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
              }
            }
          };
        }
      };
    }
  });
  await flushTasks();

  const owners = harness.messages.filter((message) => message.event === 'owner');
  assert.equal(owners.length, 1);
  assert.equal(owners[0].contentKind, 'vod');
  assert.equal(owners[0].contentId, '100');
});

test('page bridge reads no owner out of a clip response', async () => {
  const harness = createPageBridgeHarness();
  harness.location.href = 'https://clips.twitch.tv/DirectClip';
  harness.messages.length = 0;
  harness.fetch('https://gql.twitch.tv/gql');
  harness.resolveFetch({
    clone() {
      return {
        async json() {
          return {
            data: {
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

  assert.deepEqual(harness.messages.filter((message) => message.event === 'owner'), []);
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
      lastLufs: { live: -18, vod: -17 },
      lastMeasuredAt: 200,
      __fieldVersions: { 'lastLufs.vod': 4 }
    }
  }, {
    operation: 'clearMeasurement',
    channelId: '123456',
    kind: 'vod',
    sequence: 9
  });

  assert.deepEqual(state['123456'].lastLufs, { live: -18 });
  assert.equal(state['123456'].lastMeasuredAt, 200);
  assert.equal(state['123456'].gainVod, 0.8);
  assert.equal(state['123456'].autoGainVod, 0.9);
  assert.equal(state['123456'].autoApplyLoudnessVod, true);
  assert.equal(state['123456'].__fieldVersions['lastLufs.vod'], 9);
});

test('channel store drops what a clip stored the next time it writes', () => {
  const stored = {
    '123456': {
      name: 'Broadcaster',
      gainLive: 0.7,
      gainClip: 1.4,
      autoGainClip: 1.2,
      autoApplyLoudnessClip: true,
      lastLufs: { live: -18, clip: -16 },
      lastLufsRef: { live: 1, clip: 1 },
      lastLufsWindows: { live: 400, clip: 50 },
      autoGainRef: { clip: 1 },
      lastMeasuredAt: 200,
      __fieldVersions: { gainLive: 2, gainClip: 3, 'lastLufs.clip': 4 }
    },
    '999': {
      name: 'Clip Only',
      gainClip: 1.4,
      lastLufs: { clip: -16 },
      lastLufsRef: { clip: 1 },
      lastMeasuredAt: 300,
      __fieldVersions: { gainClip: 5, 'lastLufs.clip': 6 }
    }
  };
  const state = channelStore.applyChannelVolumesMutation(stored, {
    operation: 'normalizeChannels'
  });

  assert.deepEqual(state['123456'], {
    name: 'Broadcaster',
    gainLive: 0.7,
    lastLufs: { live: -18 },
    lastLufsRef: { live: 1 },
    lastLufsWindows: { live: 400 },
    lastMeasuredAt: 200,
    __fieldVersions: { gainLive: 2 }
  });
  // Nothing but the clip was ever kept under that row, so the row goes with it.
  assert.equal(Object.prototype.hasOwnProperty.call(state, '999'), false);
  // The value read out of storage is not the one that was written back.
  assert.equal(stored['123456'].gainClip, 1.4);
});

test('channel store keeps a row a clip value was not the whole of', () => {
  const state = channelStore.applyChannelVolumesMutation({
    // A row that names a channel and nothing else, with no clip value on it:
    // this migration is not what empties it, so it is not what removes it.
    'already-bare': { name: 'Bare', login: 'bare', url: 'https://www.twitch.tv/bare' },
    // A gain written before the per-kind fields answers for every kind, and it
    // is not a clip value.
    legacy: { name: 'Legacy', gain: 0.5, gainClip: 1.4 },
    // The measurement is gone with the clip, but the Auto choice is not.
    choice: { name: 'Choice', autoApplyLoudnessLive: true, lastLufs: { clip: -16 } }
  }, { operation: 'normalizeChannels' });

  assert.deepEqual(state['already-bare'], {
    name: 'Bare', login: 'bare', url: 'https://www.twitch.tv/bare'
  });
  assert.deepEqual(state.legacy, { name: 'Legacy', gain: 0.5 });
  assert.deepEqual(state.choice, { name: 'Choice', autoApplyLoudnessLive: true });
});

test('channel store lets go of the name a clip stood in under', async () => {
  let stored = {
    channelVolumes: { 123456: { name: 'Broadcaster', gainLive: 0.7 } },
    channelVolumeAliases: {
      'clip-owner:AbcDef': '123456',
      'vod-owner:100': '123456',
      'login:broadcaster': '123456'
    }
  };
  const storage = {
    async get(keys) { return readStoredKeys(stored, keys); },
    async set(update) { stored = { ...stored, ...structuredClone(update) }; }
  };
  const write = channelStore.createChannelVolumesWriter(storage, 'channelVolumes', () => 100);
  await write({
    operation: 'saveGain', channelId: '123456', kind: 'live', gain: 0.8
  });

  // The provisional name a clip carried resolves to nothing that is kept now.
  // The VOD and Live ones are still how a first visit finds its channel.
  assert.deepEqual(stored.channelVolumeAliases, {
    'vod-owner:100': '123456',
    'login:broadcaster': '123456'
  });
});

test('channel store refuses a mutation for a kind it no longer has', () => {
  for (const operation of ['saveGain', 'saveAuto', 'saveMeasurement', 'clearMeasurement']) {
    assert.throws(() => channelStore.applyChannelVolumesMutation({}, {
      operation, channelId: '123', kind: 'clip', gain: 1.2, enabled: true, lufs: -18,
      reference: u.LUFS_REFERENCE_VOLUME_1
    }), /kind must be live or vod/, operation);
  }
});

test('settings drop the default kept for a kind the extension no longer has', () => {
  const stored = {
    targetLufs: -18,
    autoApplyLoudnessLiveDefault: true,
    autoApplyLoudnessClipDefault: true
  };
  assert.deepEqual(settingsStore.applySettingsMutation(stored, {
    operation: 'patchSettings', patch: { displayUnit: 'dB' }
  }), { targetLufs: -18, autoApplyLoudnessLiveDefault: true, displayUnit: 'dB' });
  // The Worker sends this one on every update, so it is the migration point.
  assert.deepEqual(settingsStore.applySettingsMutation(stored, {
    operation: 'initializeSettings', defaults: { targetLufs: -18 }
  }), { targetLufs: -18, autoApplyLoudnessLiveDefault: true });
});

test('every default the worker installs is a field the settings writer accepts', () => {
  const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  const literal = /defaults:\s*(\{[\s\S]*?\n {4}\})/.exec(source);
  assert.ok(literal, 'the install defaults are an object literal in background.js');
  // eslint-disable-next-line no-new-func
  const defaults = new Function(`return (${literal[1]});`)();
  assert.ok(Object.keys(defaults).length > 0);
  // A key here that the validator table does not carry makes a fresh install
  // write no settings at all.
  assert.deepEqual(
    settingsStore.applySettingsMutation({}, { operation: 'initializeSettings', defaults }),
    defaults
  );
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
      autoApplyLoudnessVodDefault: false
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
      patch: { autoApplyLoudnessVodDefault: true }
    })
  ]);

  assert.deepEqual(stored.autoLoudnessSettings, {
    targetLufs: -18,
    displayUnit: 'dB',
    autoApplyLoudnessLiveDefault: true,
    autoApplyLoudnessVodDefault: true
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

function createBackgroundHarness({ aliases, sequence } = {}) {
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
    },
    ...(aliases ? { [channelStore.CHANNEL_ALIASES_KEY]: aliases } : {}),
    ...(sequence === undefined ? {} : { [channelStore.CHANNEL_SEQUENCE_KEY]: sequence })
  };
  let failNextSet = false;
  let messageListener;
  let installedListener;
  const errors = [];
  const warnings = [];
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
    console: {
      error(...args) { errors.push(args); },
      warn(...args) { warnings.push(args); }
    },
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

  return {
    get stored() { return stored; },
    errors,
    warnings,
    failNextSet() { failNextSet = true; },
    async install() {
      installedListener();
      await flushTasks();
    },
    // What the listener answered, and whether it held the channel open to do it.
    dispatch(message) {
      return new Promise((resolve) => {
        let responded = false;
        const keepOpen = messageListener(message, {}, (response) => {
          responded = true;
          resolve({ keepOpen, response });
        });
        if (keepOpen !== true && !responded) resolve({ keepOpen, response: undefined });
      });
    },
    async send(mutation, type = channelStore.CHANNEL_MUTATION_MESSAGE) {
      const { keepOpen, response } = await this.dispatch({ type, mutation });
      assert.equal(keepOpen, true);
      return response;
    }
  };
}

test('background mutation listener keeps async response open and reports failures', async () => {
  const harness = createBackgroundHarness();
  const send = (mutation, type) => harness.send(mutation, type);
  const stored = () => harness.stored;

  await harness.install();
  assert.equal(stored().channelVolumes['login:fixture_channel'], undefined);
  assert.equal(stored().channelVolumes['123456789'].gainLive, 0.7);
  assert.equal(stored().channelVolumes['123456789'].gainVod, 0.8);
  assert.equal(stored().channelVolumes['123456789'].url, 'https://www.twitch.tv/fixture_channel');

  const successResponse = await send({
    operation: 'saveAuto', channelId: 'login:test', kind: 'live', enabled: true
  });
  assert.equal(successResponse.ok, true);
  assert.equal(stored().channelVolumes['login:test'].autoApplyLoudnessLive, true);

  harness.failNextSet();
  const failureResponse = await send({
    operation: 'saveAuto', channelId: 'login:test', kind: 'live', enabled: false
  });
  assert.equal(failureResponse.ok, false);
  assert.equal(failureResponse.reason, 'storage-update-failed');
  assert.equal(stored().channelVolumes['login:test'].autoApplyLoudnessLive, true);

  const settingsResponse = await send({
    operation: 'patchSettings', patch: { displayUnit: 'dB' }
  }, settingsStore.SETTINGS_MUTATION_MESSAGE);
  assert.equal(settingsResponse.ok, true);
  assert.equal(settingsResponse.settings.displayUnit, 'dB');
  assert.equal(stored().autoLoudnessSettings.autoApplyLoudnessLiveDefault, true);

  harness.failNextSet();
  const settingsFailureResponse = await send({
    operation: 'patchSettings', patch: { autoApplyLoudnessLiveDefault: false }
  }, settingsStore.SETTINGS_MUTATION_MESSAGE);
  assert.equal(settingsFailureResponse.ok, false);
  assert.equal(settingsFailureResponse.reason, 'settings-update-failed');
  assert.equal(stored().autoLoudnessSettings.autoApplyLoudnessLiveDefault, true);
});

test('background tells a refused mutation from a failed write', async () => {
  const harness = createBackgroundHarness();

  for (const mutation of [
    { operation: 'noSuchOperation' },
    { operation: 'saveGain', channelId: 'login:test', kind: 'live', gain: 'loud' }
  ]) {
    const response = await harness.send(mutation);
    assert.equal(response.ok, false);
    // A caller that reads `storage-update-failed` retries or reports storage;
    // neither answers a mutation the store will refuse every time.
    assert.equal(response.reason, 'invalid-mutation');
  }

  const settingsResponse = await harness.send(
    { operation: 'patchSettings', patch: { displayUnit: 'furlongs' } },
    settingsStore.SETTINGS_MUTATION_MESSAGE
  );
  assert.equal(settingsResponse.ok, false);
  assert.equal(settingsResponse.reason, 'invalid-mutation');

  const logged = harness.errors.map(([message]) => message);
  assert.deepEqual(logged, [
    '[TCV] channelVolumes mutation rejected as invalid',
    '[TCV] channelVolumes mutation rejected as invalid',
    '[TCV] settings mutation rejected as invalid'
  ]);
  assert.equal(
    String(harness.errors[1][1]?.message),
    'gain must be finite and within [0, 6]'
  );
});

test('the service worker scripts do not share a top-level name', () => {
  const background = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  const call = /importScripts\(([^)]*)\)/.exec(background);
  assert.ok(call, 'background.js does not call importScripts');
  const files = [...call[1].matchAll(/'([^']+)'/g)].map(([, name]) => name);
  assert.ok(files.length >= 2, 'importScripts loads fewer than two scripts');

  // importScripts runs each script in the worker's own global, so a top-level
  // name declared twice leaves only whichever loaded last. Callers in the
  // earlier script then reach the later script's version.
  const declaredIn = new Map();
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const declarations =
      source.matchAll(/^(?:function ([A-Za-z0-9_$]+)|(?:const|let|var) ([A-Za-z0-9_$]+)\s*=)/gm);
    for (const [, declaredFunction, declaredBinding] of declarations) {
      const name = declaredFunction || declaredBinding;
      assert.equal(
        declaredIn.get(name),
        undefined,
        `${name} is declared in both ${declaredIn.get(name)} and ${file}`
      );
      declaredIn.set(name, file);
    }
  }
});

test('channel store names the rejections it raises', () => {
  assert.throws(
    () => channelStore.applyChannelVolumesMutation(
      {}, { operation: 'saveGain', channelId: 'login:test', kind: 'live', gain: 'loud' }, 1
    ),
    { reason: 'invalid-mutation', message: 'gain must be finite and within [0, 6]' }
  );
  assert.throws(
    () => channelStore.applyChannelVolumesMutation({}, { operation: 'noSuchOperation' }, 1),
    { reason: 'invalid-mutation', message: 'unknown channelVolumes mutation' }
  );
  assert.throws(
    () => settingsStore.applySettingsMutation(
      {}, { operation: 'patchSettings', patch: { displayUnit: 'furlongs' } }
    ),
    { reason: 'invalid-mutation', message: 'invalid settings value: displayUnit' }
  );
});

test('background separates stored state it cannot use from what the caller sent', async () => {
  // A cycle on file, and a mutation with nothing wrong with it.
  const cyclic = createBackgroundHarness({
    aliases: { 'login:a': 'login:b', 'login:b': 'login:a' }
  });
  const cyclicResponse = await cyclic.send({
    operation: 'saveGain', channelId: 'login:a', kind: 'live', gain: 1.5
  });
  assert.equal(cyclicResponse.ok, false);
  assert.equal(cyclicResponse.reason, 'stored-state-invalid');
  const [cyclicLog, cyclicError] = cyclic.errors.at(-1);
  assert.equal(cyclicLog, '[TCV] channelVolumes mutation blocked by the stored state');
  assert.equal(String(cyclicError?.message), 'channel alias cycle detected');

  // The counter on file has nowhere left to go.
  const exhausted = createBackgroundHarness({ sequence: Number.MAX_SAFE_INTEGER });
  const exhaustedResponse = await exhausted.send({
    operation: 'saveGain', channelId: 'login:test', kind: 'live', gain: 1.5
  });
  assert.equal(exhaustedResponse.ok, false);
  assert.equal(exhaustedResponse.reason, 'stored-state-invalid');
  const [exhaustedLog, exhaustedError] = exhausted.errors.at(-1);
  assert.equal(exhaustedLog, '[TCV] channelVolumes mutation blocked by the stored state');
  assert.equal(String(exhaustedError?.message), 'channel mutation sequence exhausted');
});

test('background names a message type it does not handle', async () => {
  const harness = createBackgroundHarness();

  const { keepOpen, response } = await harness.dispatch({ type: 'somethingElse' });

  assert.notEqual(keepOpen, true);
  assert.equal(response, undefined);
  assert.deepEqual(
    harness.warnings.map(([message, type]) => [message, type]),
    [['[TCV] unknown message type', 'somethingElse']]
  );
});

test('options disables settings until load and saves only field mutations', () => {
  const html = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
  for (const id of [
    'targetLufs',
    'adGainDb',
    'defaultAutoLiveToggle',
    'defaultAutoVodToggle',
    'overlayToggle'
  ]) {
    assert.match(html, new RegExp(`<[^>]+id="${id}"[^>]*\\bdisabled\\b`), id);
  }
  assert.match(html, /<button[^>]+data-unit="%"[^>]*\bdisabled\b/);
  assert.match(html, /<button[^>]+data-unit="dB"[^>]*\bdisabled\b/);
  // A control carries no data-i18n of its own, so the markup snapshot cannot
  // see one left behind.
  assert.doesNotMatch(html, /defaultAutoClip/);

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
  for (const kind of ['Live', 'Vod']) {
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
      autoApplyLoudnessVodDefault: true
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
  for (const kind of ['Live', 'Vod']) {
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

test('options names the reason a destructive change was refused', async () => {
  const refused = [
    {
      act: (harness) => harness.clickDelete('123'),
      message: '[TCV] failed to delete the channel'
    },
    {
      act: (harness) => harness.fire('clearAllBtn', 'click'),
      message: '[TCV] failed to clear the saved channels'
    }
  ];

  for (const { act, message } of refused) {
    const harness = createOptionsHarness({
      failMutation: true,
      channelVolumes: { 123: { name: 'Broadcaster', login: 'broadcaster', gainLive: 0.8 } }
    });
    await flushTasks(8);

    await act(harness);

    // Both paths put the same alert in front of the viewer; the reason the
    // service worker gave is readable only here.
    assert.equal(harness.alerts.at(-1), harness.message('channelUpdateFailed'));
    const [error] = loggedWarning(harness, message);
    assert.equal(String(error?.message), 'service worker unavailable');
  }
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
    for (const key of ['audioUnavailable', 'audioContextUnavailable',
      'audioCrossOriginUnavailable', 'measurementUnavailable']) {
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

  harness.setState({ audioUnavailableCause: 'cross-origin' });
  await harness.poll();
  assert.equal(
    harness.el('audioError').textContent,
    harness.message('audioCrossOriginUnavailable')
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

test('popup gives a clip the status line instead of the screen', async () => {
  const harness = createPopupHarness({
    state: {
      audioUnavailable: true,
      audioUnavailableCause: 'cross-origin',
      channel: { id: '', kind: 'clip' }
    }
  });
  await flushTasks(8);

  assert.equal(harness.el('errBox').textContent, harness.message('clipNotAdjustable'));
  assert.equal(harness.el('errBox').classList.contains('hidden'), false);
  assert.equal(harness.el('mainArea').classList.contains('hidden'), true);

  // Twitch's SPA can leave a clip without the popup being closed.
  harness.setState({
    audioUnavailable: false,
    audioUnavailableCause: '',
    channel: { id: '123', name: 'somechannel', kind: 'live' }
  });
  await harness.poll();
  assert.equal(harness.el('mainArea').classList.contains('hidden'), false);
  assert.equal(harness.el('errBox').classList.contains('hidden'), true);
  assert.equal(harness.el('channelName').textContent, 'somechannel');
});

test('popup clears a failed save across a clip', async () => {
  const harness = createPopupHarness({ failCommand: 'setGain' });
  await flushTasks(8);
  await harness.firePreset(3, 'click');
  assert.equal(harness.el('applyHint').classList.contains('error'), true);

  // A clip carries no channel id, so the screen it replaces must still count as
  // the channel being left.
  harness.setState({ channel: { id: '', kind: 'clip' }, audioUnavailable: true });
  await harness.poll();
  harness.setState({
    channel: { id: '999', name: 'other', kind: 'live' }, audioUnavailable: false
  });
  await harness.poll();

  assert.equal(harness.el('applyHint').classList.contains('error'), false);
  assert.equal(harness.el('applyHint').textContent, harness.message('hintNoLufs'));
});

test('popup leaves the manual controls alone where there is no channel', async () => {
  const harness = createPopupHarness({
    state: { channel: { id: '', kind: 'none' } }
  });
  await flushTasks(8);

  // The gain is saved against a channel, and content.js refuses one sent
  // without it, so the slider does not offer a setting that cannot be kept.
  assert.equal(harness.el('manualSlider').disabled, true);
  assert.equal(harness.el('manualSection').classList.contains('disabled'), true);
  assert.equal(harness.el('applyBtn').disabled, true);
  assert.equal(harness.el('autoApplyToggle').disabled, true);
  assert.equal(harness.el('applyHint').textContent, harness.message('channelNotDetected'));
});

test('popup says where to open it when the tab is not a Twitch one', async () => {
  // The manifest asks for twitch.tv alone and for no tabs permission, so Chrome
  // withholds the URL of every other tab: a tab that is not one of ours arrives
  // without one rather than with an address to look at.
  const harness = createPopupHarness({ tabUrl: '' });
  await flushTasks(8);

  assert.equal(harness.el('errBox').textContent, harness.message('openOnTwitch'));
  assert.equal(harness.el('errBox').classList.contains('hidden'), false);
  assert.equal(harness.el('mainArea').classList.contains('hidden'), true);
  // Nothing is asked of a tab the extension does not run in.
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(
    harness.warnings.filter((args) => args[0] === '[TCV] state request failed')
      .map((args) => args[1]),
    ['no Twitch tab to ask']
  );
});

test('popup names the reason the page could not answer, once', async () => {
  const harness = createPopupHarness({
    sendMessageError: 'Could not establish connection. Receiving end does not exist.'
  });
  await flushTasks(8);
  const named = () => harness.warnings.filter((args) => args[0] === '[TCV] state request failed');

  assert.equal(harness.el('errBox').textContent, harness.message('reloadPageNeeded'));
  assert.equal(harness.el('mainArea').classList.contains('hidden'), true);
  // The screen says what to do; the log says what happened.
  assert.equal(named().length, 1);
  assert.match(String(named()[0][1]), /Receiving end does not exist/);

  // The display polls every second and the page goes on not answering, so the
  // reason is named for the stretch, not for each poll.
  await harness.poll();
  await harness.poll();
  assert.equal(named().length, 1);
  assert.equal(harness.sent.length, 3);

  // It is named again for the next stretch.
  harness.breakSendMessage('');
  await harness.poll();
  assert.equal(named().length, 1);
  harness.breakSendMessage('Extension context invalidated.');
  await harness.poll();
  assert.equal(named().length, 2);
});

test('popup names a tab it could not even ask for', async () => {
  const harness = createPopupHarness();
  await flushTasks(8);

  // Asking which tab is active is the first thing that can fail, and it fails
  // the same way the rest of the request does.
  harness.breakTabQuery('Extension context invalidated.');
  await harness.poll();

  assert.equal(harness.el('errBox').textContent, harness.message('reloadPageNeeded'));
  assert.equal(harness.el('mainArea').classList.contains('hidden'), true);
  const named = harness.warnings.filter((args) => args[0] === '[TCV] state request failed');
  assert.equal(named.length, 1);
  assert.match(String(named[0][1]), /Extension context invalidated/);
});

test('popup leaves its own message up when the tab it re-reads is gone', async () => {
  const harness = createPopupHarness({ failCommand: 'setAutoApplyLoudness' });
  await flushTasks(8);

  // The save is refused, and by the time the state is re-read the tab has left
  // Twitch, so Chrome stops answering for its address.
  harness.setTabUrl('');
  harness.el('autoApplyToggle').checked = true;
  await harness.fire('autoApplyToggle', 'change');

  assert.equal(harness.el('autoError').textContent, harness.message('autoSaveFailed'));
  assert.equal(harness.el('autoError').classList.contains('hidden'), false);
  assert.equal(harness.el('mainArea').classList.contains('hidden'), false);
  assert.deepEqual(
    harness.warnings.filter((args) => args[0] === '[TCV] state request failed')
      .map((args) => args[1]),
    ['no Twitch tab to ask']
  );
});

test('popup names a reason that takes over from another', async () => {
  const harness = createPopupHarness({ tabUrl: '' });
  await flushTasks(8);
  const named = () => harness.warnings
    .filter((args) => args[0] === '[TCV] state request failed')
    .map((args) => String(args[1]));

  assert.deepEqual(named(), ['no Twitch tab to ask']);

  // The tab comes back and the page is the one that cannot answer now. Nothing
  // arrived in between, so a stretch that reports once would say nothing.
  harness.setTabUrl('https://www.twitch.tv/somechannel');
  harness.breakSendMessage('Could not establish connection.');
  await harness.poll();
  assert.equal(named().length, 2);
  assert.match(named()[1], /Could not establish connection/);

  // The same reason again is still the same thing to say.
  await harness.poll();
  assert.equal(named().length, 2);
});

test('popup keeps a save in flight from being failed by the read after it', async () => {
  const harness = createPopupHarness({ deferAutoSave: true });
  await flushTasks(8);
  harness.el('autoApplyToggle').checked = true;
  const fired = harness.fire('autoApplyToggle', 'change');
  await flushTasks(8);

  // The page dies while the save is in flight, so the state read that follows
  // it cannot even ask which tab is active.
  harness.breakTabQuery('Extension context invalidated.');
  await harness.releaseAutoSave();
  await fired;

  // The save landed. What failed afterwards is not what the viewer did.
  assert.deepEqual(
    harness.warnings.filter((args) => args[0] === '[TCV] Auto setting request failed'),
    []
  );
  assert.equal(harness.el('autoError').classList.contains('hidden'), true);
  assert.equal(
    harness.warnings.filter((args) => args[0] === '[TCV] state request failed').length,
    1
  );
});

test('popup keeps a save that worked from reading as one that failed', async () => {
  const harness = createPopupHarness();
  await flushTasks(8);

  // The save lands, and the page dies before the state it asks for next.
  harness.breakSendMessage({ getState: 'Could not establish connection.' });
  harness.el('autoApplyToggle').checked = true;
  await harness.fire('autoApplyToggle', 'change');

  assert.deepEqual(
    harness.sent.map((message) => message.cmd).filter((cmd) => cmd !== 'getState'),
    ['setAutoApplyLoudness']
  );
  // Reading the state afterwards is not what the viewer just did.
  assert.equal(harness.el('autoError').classList.contains('hidden'), true);
  assert.deepEqual(
    harness.warnings.filter((args) => args[0] === '[TCV] Auto setting request failed'),
    []
  );
  assert.equal(
    harness.warnings.filter((args) => args[0] === '[TCV] state request failed').length,
    1
  );
});

test('popup leaves its own message up where it asked for no status line', async () => {
  const harness = createPopupHarness({ failCommand: 'setAutoApplyLoudness' });
  await flushTasks(8);

  // The save is refused and the state it re-reads afterwards never arrives.
  harness.breakSendMessage({ getState: 'Could not establish connection.' });
  harness.el('autoApplyToggle').checked = true;
  await harness.fire('autoApplyToggle', 'change');

  // What the viewer did is what the screen names; the reload line would take
  // the whole screen and say nothing about the save.
  assert.equal(harness.el('autoError').textContent, harness.message('autoSaveFailed'));
  assert.equal(harness.el('autoError').classList.contains('hidden'), false);
  assert.equal(harness.el('mainArea').classList.contains('hidden'), false);
  assert.equal(
    harness.warnings.filter((args) => args[0] === '[TCV] state request failed').length,
    1
  );
});

test('popup names the reason each rejected request came back with', async () => {
  const rejected = [
    {
      failCommand: 'setGain',
      act: (harness) => harness.fire('applyBtn', 'click'),
      message: '[TCV] suggested gain request failed'
    },
    {
      failCommand: 'setGain',
      act: (harness) => harness.firePreset(3, 'click'),
      message: '[TCV] gain request failed'
    },
    {
      failCommand: 'setAutoApplyLoudness',
      act: async (harness) => {
        harness.el('autoApplyToggle').checked = true;
        await harness.fire('autoApplyToggle', 'change');
      },
      message: '[TCV] Auto setting request failed'
    },
    {
      failCommand: 'resetMeasurement',
      act: (harness) => harness.fire('resetMeasurementBtn', 'click'),
      message: '[TCV] measurement reset request failed'
    }
  ];

  for (const { failCommand, act, message } of rejected) {
    const harness = createPopupHarness({
      failCommand,
      state: { lufs: { momentary: -21, shortTerm: -21, integrated: -21 } }
    });
    await flushTasks(8);

    await act(harness);

    // The viewer sees one localized line; the reason content.js worked out is
    // readable only here.
    const [error] = loggedWarning(harness, message);
    assert.equal(String(error?.message), 'storage update failed');
  }
});

test('popup keeps a failed save visible while the audio notice stands', async () => {
  const harness = createPopupHarness({
    failCommand: 'setGain',
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
  "spec.loader.exec_module(m);" +
  // Importing no longer ends on a missing Pillow — arguments are answered
  // before it is needed — so the module says so and this asks.
  "sys.exit(3 if m.CANNOT_DRAW else 0)"
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
  'import contextlib, hashlib, importlib.util, io, os, shutil, sys, tempfile',
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
  "        for name in sorted(n for n in os.listdir(tracked) if n.lower().endswith('.png')):",
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
  '    said = io.StringIO()',
  '    try:',
  '        with contextlib.redirect_stderr(said):',
  '            code = gen.main()',
  '    except BaseException as error:',
  '        escaped = str(error)',
  '    else:',
  '        # A failure the run reports rather than raises is the same event:',
  '        # what has to hold is that the tracked six are as they were.',
  '        escaped = said.getvalue()',
  '        if code == 0:',
  "            print('the injected failure never fired')",
  '            raise SystemExit(2)',
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
  // main hands the staging directory over rather than moving anything itself,
  // and what replacing could not clear away comes back to be answered for.
  assert.match(source, /written, litter = replace_all\(staging, out_dir\)/);
  assert.match(source, /if litter is not None:\n\s+#.*\n\s+#.*\n\s+raise Refused\(litter\)/);
  const replaceAll = source.slice(source.indexOf('def replace_all('), source.indexOf('def main('));
  assert.match(replaceAll, /except BaseException as err:/);
  // Putting them back is a loop of its own: one name it cannot restore must not
  // stop it from trying the rest.
  assert.match(replaceAll,
    /except OSError as sweeping:\n\s+left\.append\(\(name, kind, reason\(sweeping\)\)\)/);
  // What was there decides how it comes back, so it is read before the first
  // move and with lstat - exists() and copy2() both read through a link.
  assert.match(replaceAll, /kind, target = state_of\(here\)/);
  assert.match(replaceAll, /os\.symlink\(target, os\.path\.join\(out_dir, name\)\)/);
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
// The images the repository tracks, by name. What else the directory is holding
// is not one of them: .DS_Store is there for the asking on a Mac and allowed by
// .gitignore, and copied into a sandbox it is answered for as this run's.
const TRACKED_SHOTS = fs.readdirSync(path.join(__dirname, 'docs/screenshots'))
  .filter((name) => name.toLowerCase().endsWith('.png')).sort();

function screenshotSandbox() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tcv-shots-'));
  fs.copyFileSync(path.join(__dirname, 'gen_screenshots.py'),
    path.join(sandbox, 'gen_screenshots.py'));
  fs.cpSync(path.join(__dirname, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'docs/screenshots'), { recursive: true });
  for (const name of TRACKED_SHOTS) {
    fs.copyFileSync(path.join(__dirname, 'docs/screenshots', name),
      path.join(sandbox, 'docs/screenshots', name));
  }
  return sandbox;
}

function runCheck(sandbox) {
  return spawnSync('python3', ['-B', 'gen_screenshots.py', '--check'],
    { cwd: sandbox, encoding: 'utf8' });
}

// Chunk surgery on a tracked image: insert <kind> [payload] before IEND, or
// copy the IHDR that is already there. Every chunk it writes carries the CRC
// the spec asks for, so what the walk turns down is the chunk, not the CRC.
const CHUNK_PROBE = [
  'import struct, sys, zlib',
  'op, target = sys.argv[1], sys.argv[2]',
  'data = open(target, "rb").read()',
  'walk, at = [], 8',
  'while at < len(data):',
  '    size = int.from_bytes(data[at:at + 4], "big")',
  '    walk.append((data[at + 4:at + 8], data[at:at + 12 + size]))',
  '    at += 12 + size',
  'if op == "bad-filter":',
  '    raw = bytearray(zlib.decompress(b"".join(r[8:-4] for k, r in walk if k == b"IDAT")))',
  '    raw[0] = 99',
  '    packed = zlib.compress(bytes(raw), 6)',
  '    out, written = bytearray(data[:8]), False',
  '    for kind, raw_chunk in walk:',
  '        if kind != b"IDAT":',
  '            out += raw_chunk',
  '            continue',
  '        if written:',
  '            continue',
  '        written = True',
  '        head = b"IDAT" + packed',
  '        out += struct.pack(">I", len(packed)) + head',
  '        out += struct.pack(">I", zlib.crc32(head) & 0xffffffff)',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "fat-text":',
  '    text = zlib.compress(b"x" * int(sys.argv[3]))',
  '    body = b"zTXt" + b"Comment\\0\\0" + text',
  '    extra = struct.pack(">I", len(body) - 4) + body',
  '    extra += struct.pack(">I", zlib.crc32(body) & 0xffffffff)',
  '    out = bytearray(data[:8])',
  '    for kind, raw in walk:',
  '        if kind == b"IDAT" and extra:',
  '            out += extra',
  '            extra = b""',
  '        out += raw',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "header-byte":',
  '    out = bytearray(data)',
  '    body = bytearray(out[12:12 + 17])',
  '    body[4 + int(sys.argv[3])] = int(sys.argv[4])',
  '    out[12:12 + 17] = body',
  '    out[29:33] = (zlib.crc32(bytes(body)) & 0xffffffff).to_bytes(4, "big")',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "pad-stream":',
  '    raw = zlib.decompress(b"".join(r[8:-4] for k, r in walk if k == b"IDAT"))',
  '    packer = zlib.compressobj(6)',
  '    packed = packer.compress(raw)',
  '    left = int(sys.argv[3])',
  '    while left:',
  '        slice_size = min(left, 1 << 20)',
  '        packed += packer.compress(bytes(slice_size))',
  '        left -= slice_size',
  '    packed += packer.flush()',
  '    out, written = bytearray(data[:8]), False',
  '    for kind, raw_chunk in walk:',
  '        if kind != b"IDAT":',
  '            out += raw_chunk',
  '            continue',
  '        if written:',
  '            continue',
  '        written = True',
  '        head = b"IDAT" + packed',
  '        out += struct.pack(">I", len(packed)) + head',
  '        out += struct.pack(">I", zlib.crc32(head) & 0xffffffff)',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "trim-idat":',
  '    body = b"".join(raw[8:-4] for kind, raw in walk if kind == b"IDAT")',
  '    body = body[:-int(sys.argv[3])]',
  '    out, written = bytearray(data[:8]), False',
  '    for kind, raw in walk:',
  '        if kind != b"IDAT":',
  '            out += raw',
  '            continue',
  '        if written:',
  '            continue',
  '        written = True',
  '        head = b"IDAT" + body',
  '        out += struct.pack(">I", len(body)) + head',
  '        out += struct.pack(">I", zlib.crc32(head) & 0xffffffff)',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "fat-idat":',
  '    room = int(sys.argv[3])',
  '    crc, block = zlib.crc32(b"IDAT"), b"\\0" * (1 << 20)',
  '    left = room',
  '    while left:',
  '        crc = zlib.crc32(block[:min(len(block), left)], crc)',
  '        left -= min(len(block), left)',
  '    out = bytearray(data[:8])',
  '    for kind, raw in walk:',
  '        if kind == b"IEND" and room:',
  '            out += struct.pack(">I", room) + b"IDAT"',
  '            left = room',
  '            while left:',
  '                out += block[:min(len(block), left)]',
  '                left -= min(len(block), left)',
  '            out += struct.pack(">I", crc & 0xffffffff)',
  '            room = 0',
  '        out += raw',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "smuggle-idat":',
  '    body = b"IDAT" + b"smuggled payload" * 4',
  '    extra = struct.pack(">I", len(body) - 4) + body',
  '    extra += struct.pack(">I", zlib.crc32(body) & 0xffffffff)',
  '    out = bytearray(data[:8])',
  '    for kind, raw in walk:',
  '        if kind == b"IEND":',
  '            out += extra',
  '        out += raw',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "split-idat":',
  '    body = b"".join(raw[8:-4] for kind, raw in walk if kind == b"IDAT")',
  '    cut = len(body) // 2',
  '    out = bytearray(data[:8])',
  '    for kind, raw in walk:',
  '        if kind != b"IDAT":',
  '            out += raw',
  '            continue',
  '        if raw is not next(r for k, r in walk if k == b"IDAT"):',
  '            continue',
  '        for piece in (body[:cut], body[cut:]):',
  '            head = b"IDAT" + piece',
  '            out += struct.pack(">I", len(piece)) + head',
  '            out += struct.pack(">I", zlib.crc32(head) & 0xffffffff)',
  '    open(target, "wb").write(bytes(out))',
  '    raise SystemExit',
  'if op == "copy-ihdr":',
  '    extra = dict(walk)[b"IHDR"]',
  'else:',
  '    kind = sys.argv[3].encode()',
  // argv carries no NUL byte, so the payload spells its separator and the
  // probe puts the byte back.
  '    text = sys.argv[4].encode().replace(rb"\\0", b"\\0") if len(sys.argv) > 4 else b""',
  '    body = kind + text',
  '    extra = struct.pack(">I", len(body) - 4) + body',
  '    extra += struct.pack(">I", zlib.crc32(body) & 0xffffffff)',
  'out = bytearray(data[:8])',
  'for kind, raw in walk:',
  '    if kind == b"IEND":',
  '        out += extra',
  '    out += raw',
  'open(target, "wb").write(bytes(out))',
].join('\n');

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

test('--check turns down a second frame riding on the drawn one',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      const target = path.join(sandbox, 'docs/screenshots/popup_ja.png');
      // Decoding reads the frame the file opens on, so an animation whose
      // first frame is the drawn one matches on it. What an animation cannot
      // do is arrive without the chunks that drive it.
      assert.equal(spawnSync('python3', ['-B', '-c',
        'import sys; from PIL import Image;' +
        'first = Image.open(sys.argv[1]).convert("RGB");' +
        'second = first.copy();' +
        'second.paste((255, 0, 255), (0, 0, first.width, first.height));' +
        'first.save(sys.argv[1], save_all=True, append_images=[second])', target],
      { encoding: 'utf8' }).status, 0, 'the probe saved a two-frame APNG');

      const run = runCheck(sandbox);
      assert.equal(run.status, 1, 'a second frame is reported: ' + (run.stderr || run.stdout));
      assert.match(run.stderr,
        /popup_ja\.png: a different sequence of chunks \(IHDR acTL fcTL IDAT fcTL fdAT IEND \/ the code draws IHDR IDAT IEND\)/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check turns down a header that names more pixels than the drawing has',
  { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // 200000 x 200000 in a header no decoder should be handed: the size the
    // file claims is in IHDR, which this reads for itself.
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import struct, sys, zlib;' +
      'chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data' +
      ' + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff);' +
      'header = struct.pack(">IIBBBBB", 200000, 200000, 8, 2, 0, 0, 0);' +
      'open(sys.argv[1], "wb").write(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", header)' +
      ' + chunk(b"IDAT", zlib.compress(b"\\x00")) + chunk(b"IEND", b""))',
      path.join(sandbox, 'docs/screenshots/overlay_ja.png')],
    { encoding: 'utf8' }).status, 0, 'the probe wrote a bomb header');
    // The second fault sits on an image that sorts after the first, so only
    // the loop carrying on can report it — an orphan would be found either
    // way, since that scan runs after the loop has ended.
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import sys; from PIL import Image;' +
      'i = Image.open(sys.argv[1]).convert("RGB");' +
      'r, g, b = i.getpixel((320, 200));' +
      'i.putpixel((320, 200), (r ^ 1, g, b));' +
      'i.save(sys.argv[1])', path.join(sandbox, 'docs/screenshots/settings_ja.png')],
    { encoding: 'utf8' }).status, 0, 'the probe changed a later image');

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'a bomb header is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /overlay_ja\.png: a different size \(\(200000, 200000\) → \(640, 400\)\)/);
    assert.match(run.stderr, /settings_ja\.png: differs from what the code draws now/,
      'and the comparison goes on to the images after it');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check turns down bytes the decoder never reaches', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // The decoder stops at IEND, so anything after it shows up in neither the
    // pixels nor the size nor the frame count.
    const target = path.join(sandbox, 'docs/screenshots/popup_ja.png');
    fs.writeFileSync(target, Buffer.concat([fs.readFileSync(target),
      fs.readFileSync(path.join(sandbox, 'docs/screenshots/overlay_ja.png'))]));

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'appended bytes are reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /popup_ja\.png: \d+ bytes after IEND/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check turns down a file that is not the PNG it is named', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // Pillow decodes by content, so the same pixels in another container read
    // as a match on every comparison above.
    const target = path.join(sandbox, 'docs/screenshots/popup_ja.png');
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import sys; from PIL import Image;' +
      'Image.open(sys.argv[1]).convert("RGB").save(sys.argv[1], format="BMP")', target],
    { encoding: 'utf8' }).status, 0, 'the probe rewrote it as a BMP');

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'a BMP is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /popup_ja\.png: not a PNG/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check turns down a PNG that stops before its own end', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // Pillow reads a PNG whose IEND was cut off, and one whose IEND no longer
    // matches its CRC, without a word.
    const cut = path.join(sandbox, 'docs/screenshots/popup_ja.png');
    fs.writeFileSync(cut, fs.readFileSync(cut).subarray(0, -12));
    const broken = path.join(sandbox, 'docs/screenshots/settings_ja.png');
    const bytes = fs.readFileSync(broken);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(broken, bytes);

    // And one whose IEND carries a payload, which the spec gives no length.
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import struct, sys, zlib;' +
      'data = open(sys.argv[1], "rb").read()[:-12];' +
      'body = b"IEND" + b"payload";' +
      'open(sys.argv[1], "wb").write(data + struct.pack(">I", 7) + body' +
      ' + struct.pack(">I", zlib.crc32(body) & 0xffffffff))',
      path.join(sandbox, 'docs/screenshots/overlay_ja.png')],
    { encoding: 'utf8' }).status, 0, 'the probe gave IEND a payload');

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'a truncated end is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /popup_ja\.png: no IEND/);
    assert.match(run.stderr, /settings_ja\.png: IEND does not match its CRC/);
    assert.match(run.stderr, /overlay_ja\.png: IEND is 7 bytes long/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// Peak resident memory of the run, which is how the ceiling on inflation shows
// up from outside. RUSAGE_CHILDREN counts what the check took; the unit is
// bytes on macOS and KiB elsewhere.
const COST_PROBE = [
  'import resource, subprocess, sys',
  'unit = 1 if sys.platform == "darwin" else 1024',
  'run = subprocess.run(["python3", "-B", "gen_screenshots.py", "--check"],',
  '                     cwd=sys.argv[1], capture_output=True, text=True)',
  'print(run.returncode)',
  'print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * unit)',
  'sys.stderr.write(run.stderr)',
].join('\n');

test('--check goes on to the next image when one cannot be read', { skip: generatorSkip
  || (process.platform === 'win32' && 'mode bits do not keep this file from being read on win32')
  || (typeof process.getuid === 'function' && process.getuid() === 0
    && 'root reads a file whatever its mode says') }, () => {
  const sandbox = screenshotSandbox();
  try {
    // The bytes are read here before anything decodes them, and a file the
    // process cannot open raises where nothing was catching it: the run ended
    // on the first one, taking the images after it and the scan for files
    // nothing draws with it.
    fs.chmodSync(path.join(sandbox, 'docs/screenshots/overlay_en.png'), 0o000);
    fs.copyFileSync(path.join(sandbox, 'docs/screenshots/overlay_ja.png'),
      path.join(sandbox, 'docs/screenshots/popup_de.png'));

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the unreadable file is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /overlay_en\.png: the file cannot be read/);
    assert.doesNotMatch(run.stderr, /Traceback/, 'without a traceback');
    assert.match(run.stderr, /popup_de\.png: drawn by nothing/,
      'and the scan for files nothing draws still runs');
  } finally {
    fs.chmodSync(path.join(sandbox, 'docs/screenshots/overlay_en.png'), 0o644);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check does not take a tracked file into memory to read it', { skip: generatorSkip
  || (process.platform === 'win32'
    && 'the resource module this measures with is not on win32') }, () => {
  const sandbox = screenshotSandbox();
  try {
    // 64 MiB in a chunk that is all there on disk: nothing inflates, so the
    // ceiling on inflation says nothing about it. Reading the file whole, or
    // handing its bytes to a stream that has already finished, spends the
    // file's size — or more, since zlib keeps what it could not use.
    const room = 64 * 1024 * 1024;
    assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'fat-idat',
      path.join(sandbox, 'docs/screenshots/popup_ja.png'), String(room)],
    { encoding: 'utf8' }).status, 0, 'the probe wrote a fat IDAT');

    const probe = spawnSync('python3', ['-B', '-c', COST_PROBE, sandbox], { encoding: 'utf8' });
    assert.equal(probe.status, 0, 'the cost probe ran: ' + probe.stderr);
    const [status, peak] = probe.stdout.trim().split('\n');
    // A run over the untouched tree peaks around 40 MB here, so anything below
    // what the file itself holds means it was read in pieces.
    assert.ok(Number(peak) < room,
      `the run peaked at ${Math.round(Number(peak) / (1 << 20))} MiB`
      + ` against a ${room / (1 << 20)} MiB chunk`);
    assert.equal(status, '1', 'and it still turns the image down: ' + probe.stderr);
    assert.match(probe.stderr, /popup_ja\.png: \d+ bytes after the end of the IDAT stream/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check does not inflate a tracked image beyond what the drawing needs',
  { skip: generatorSkip || (process.platform === 'win32'
    && 'the resource module this measures with is not on win32') }, () => {
    const sandbox = screenshotSandbox();
    try {
      // 256 MiB of zeros ride in 53 KB of chunk: the file on disk says nothing
      // about what reading it costs. Inflating on the tracked file's word is
      // how a check turns into the memory it was handed.
      const padding = 256 * 1024 * 1024;
      assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'pad-stream',
        path.join(sandbox, 'docs/screenshots/popup_ja.png'), String(padding)],
      { encoding: 'utf8' }).status, 0, 'the probe padded the stream');

      const probe = spawnSync('python3', ['-B', '-c', COST_PROBE, sandbox], { encoding: 'utf8' });
      assert.equal(probe.status, 0, 'the cost probe ran: ' + probe.stderr);
      const [status, peak] = probe.stdout.trim().split('\n');
      // A run over the untouched tree peaks around 40 MB here, and one that
      // inflates a block at a time without a ceiling reaches 133 MB, so the
      // bound sits between the two.
      assert.ok(Number(peak) < padding / 4,
        `the run peaked at ${Math.round(Number(peak) / (1 << 20))} MiB`
        + ` against a ${padding / (4 << 20)} MiB bound`);
      assert.equal(status, '1', 'and it still turns the image down: ' + probe.stderr);
      assert.match(probe.stderr, /popup_ja\.png: more to unpack after the scanlines/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check turns down a pixel stream that does not end where the chunks do',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      // The decoder stops once it has the pixels, so a further IDAT carrying
      // anything at all decodes to the same image at the same size. Folding a
      // run of IDAT into one entry is what makes the count no defence.
      assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'smuggle-idat',
        path.join(sandbox, 'docs/screenshots/popup_ja.png')],
      { encoding: 'utf8' }).status, 0, 'the probe added an IDAT with a payload');
      // And the other way round: dropping the four bytes that close the stream
      // leaves every scanline in place, so the decoder hands back the image
      // without a word.
      assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'trim-idat',
        path.join(sandbox, 'docs/screenshots/settings_ja.png'), '4'],
      { encoding: 'utf8' }).status, 0, 'the probe cut the end off the stream');

      // And inside the stream: 64 bytes past the scanlines inflate with them,
      // so nothing outside the stream is out of place.
      assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'pad-stream',
        path.join(sandbox, 'docs/screenshots/overlay_ja.png'), '64'],
      { encoding: 'utf8' }).status, 0, 'the probe padded the scanlines');

      const run = runCheck(sandbox);
      assert.equal(run.status, 1, 'the spare bytes are reported: ' + (run.stderr || run.stdout));
      assert.match(run.stderr, /popup_ja\.png: \d+ bytes after the end of the IDAT stream/);
      assert.match(run.stderr, /overlay_ja\.png: more to unpack after the scanlines/);
      assert.match(run.stderr, /settings_ja\.png: the IDAT stream does not end/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check takes the same pixels however the compressor split them',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      // How many IDAT chunks a file holds is the compressor's call, not the
      // image's: the same pixels come back whether the stream arrives in one
      // piece or several. A run of them is one entry, so a machine that splits
      // differently is not a difference in what the code draws.
      assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'split-idat',
        path.join(sandbox, 'docs/screenshots/popup_ja.png')],
      { encoding: 'utf8' }).status, 0, 'the probe split the IDAT stream');
      assert.equal(spawnSync('python3', ['-B', '-c',
        'import sys; from PIL import Image;'
        + 'print(len(Image.open(sys.argv[1]).convert("RGBA").tobytes()))',
        path.join(sandbox, 'docs/screenshots/popup_ja.png')],
      { encoding: 'utf8' }).status, 0, 'and the split file still decodes');

      const run = runCheck(sandbox);
      assert.equal(run.status, 0, 'a split stream is not a difference: '
        + (run.stderr || run.stdout));
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check turns down a chunk type the spec does not allow', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // Both carry a correct CRC and a length the file honours, so the walk that
    // reads only those two lets them through. The decoder skips what it does
    // not know, which leaves the pixels, the size and the frame count alike.
    assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'insert',
      path.join(sandbox, 'docs/screenshots/popup_ja.png'), 'a1b2'],
    { encoding: 'utf8' }).status, 0, 'the probe added a chunk named in digits');
    assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'insert',
      path.join(sandbox, 'docs/screenshots/settings_ja.png'), 'abcd'],
    { encoding: 'utf8' }).status, 0, 'the probe added a chunk with the reserved bit set');

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the chunk types are reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /popup_ja\.png: a chunk type at byte \d+ that is not four letters/);
    assert.match(run.stderr, /settings_ja\.png: abcd has the reserved bit set/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check goes on to the next image when one will not decode', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // A filter type the spec does not define, in a stream that inflates to the
    // same length under a header that is byte for byte the drawn one: every
    // check that reads the file itself passes, and the decoder is the one that
    // says no. The image that fails sorts before the one that follows it.
    assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'bad-filter',
      path.join(sandbox, 'docs/screenshots/overlay_ja.png')],
    { encoding: 'utf8' }).status, 0, 'the probe wrote an undefined filter type');
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import sys; from PIL import Image;' +
      'i = Image.open(sys.argv[1]).convert("RGB");' +
      'r, g, b = i.getpixel((320, 200));' +
      'i.putpixel((320, 200), (r ^ 1, g, b));' +
      'i.save(sys.argv[1])', path.join(sandbox, 'docs/screenshots/settings_ja.png')],
    { encoding: 'utf8' }).status, 0, 'the probe changed a later image');

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the image is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /overlay_ja\.png: cannot be read as an image/);
    assert.match(run.stderr, /settings_ja\.png: differs from what the code draws now/,
      'and the comparison goes on to the images after it');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check reads the chunks before the decoder gets the file', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // 2 MiB of text in a chunk with a correct CRC: Pillow refuses to inflate
    // it and raises ValueError, which is neither of the two the guard around
    // the decoding catches. Handing the file over before reading it here took
    // the whole run down with it — the images after this one, and the scan for
    // files nothing draws, never ran.
    assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'fat-text',
      path.join(sandbox, 'docs/screenshots/popup_ja.png'), String(2 * 1024 * 1024)],
    { encoding: 'utf8' }).status, 0, 'the probe added a fat text chunk');
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import sys; from PIL import Image;' +
      'i = Image.open(sys.argv[1]).convert("RGB");' +
      'r, g, b = i.getpixel((320, 200));' +
      'i.putpixel((320, 200), (r ^ 1, g, b));' +
      'i.save(sys.argv[1])', path.join(sandbox, 'docs/screenshots/settings_ja.png')],
    { encoding: 'utf8' }).status, 0, 'the probe changed a later image');
    fs.copyFileSync(path.join(sandbox, 'docs/screenshots/overlay_ja.png'),
      path.join(sandbox, 'docs/screenshots/popup_de.png'));

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the text chunk is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr,
      /popup_ja\.png: a different sequence of chunks \(IHDR zTXt IDAT IEND \/ the code draws IHDR IDAT IEND\)/);
    assert.match(run.stderr, /settings_ja\.png: differs from what the code draws now/,
      'and the images after it are still compared');
    assert.match(run.stderr, /popup_de\.png: drawn by nothing/,
      'and the scan for files nothing draws still runs');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check turns down a header byte the decoder does not mind',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      // The compression method is the eleventh byte of IHDR, and the spec
      // gives it one value. Pillow reads the image whatever it says, so the
      // pixels, the size and the chunk order are all as drawn.
      assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'header-byte',
        path.join(sandbox, 'docs/screenshots/popup_ja.png'), '10', '1'],
      { encoding: 'utf8' }).status, 0, 'the probe rewrote a header byte');
      assert.equal(spawnSync('python3', ['-B', '-c',
        'import sys; from PIL import Image;'
        + 'print(Image.open(sys.argv[1]).size)',
        path.join(sandbox, 'docs/screenshots/popup_ja.png')],
      { encoding: 'utf8' }).status, 0, 'and the decoder still opens it');

      const run = runCheck(sandbox);
      assert.equal(run.status, 1, 'the header is reported: ' + (run.stderr || run.stdout));
      assert.match(run.stderr, /popup_ja\.png: the body of IHDR differs from what the code draws/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check turns down chunks the drawing never writes', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // A second IHDR and a text chunk are both legal bytes to the decoder: it
    // reads the first header and skips the rest, so a file carrying either
    // still opens on the same pixels at the same size.
    assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'copy-ihdr',
      path.join(sandbox, 'docs/screenshots/popup_ja.png')],
    { encoding: 'utf8' }).status, 0, 'the probe duplicated IHDR');
    assert.equal(spawnSync('python3', ['-B', '-c', CHUNK_PROBE, 'insert',
      path.join(sandbox, 'docs/screenshots/settings_ja.png'), 'tEXt', 'Comment\\0smuggled'],
    { encoding: 'utf8' }).status, 0, 'the probe added a text chunk');

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the extra chunks are reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr,
      /popup_ja\.png: a different sequence of chunks \(IHDR IDAT IHDR IEND \/ the code draws IHDR IDAT IEND\)/);
    assert.match(run.stderr,
      /settings_ja\.png: a different sequence of chunks \(IHDR IDAT tEXt IEND \/ the code draws IHDR IDAT IEND\)/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check asks for a rename, not a deletion, when only the spelling differs',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      // On a case-insensitive filesystem the pixel comparison opens this file
      // and passes, so calling it an image nothing draws would have the reader
      // delete the one that is drawn.
      fs.renameSync(path.join(sandbox, 'docs/screenshots/popup_ja.png'),
        path.join(sandbox, 'docs/screenshots/popup_ja.PNG'));

      const run = runCheck(sandbox);
      assert.equal(run.status, 1, 'the spelling is reported: ' + (run.stderr || run.stdout));
      assert.match(run.stderr, /popup_ja\.PNG: spelled differently \(the code draws popup_ja\.png\)/);
      assert.match(run.stderr, /Rename: .*popup_ja\.PNG → popup_ja\.png/);
      assert.doesNotMatch(run.stderr, /Delete: /, 'and it is not on the list to delete');

      // Where both spellings can exist at once, renaming onto the other one is
      // no instruction at all: the spare is the one to delete.
      fs.copyFileSync(path.join(sandbox, 'docs/screenshots/popup_ja.PNG'),
        path.join(sandbox, 'docs/screenshots/popup_ja.png'));
      const both = fs.readdirSync(path.join(sandbox, 'docs/screenshots'))
        .filter((name) => name.toLowerCase() === 'popup_ja.png');
      if (both.length < 2) {
        console.log('  (both spellings at once: skipped, this filesystem folds them)');
      } else {
        const after = runCheck(sandbox);
        assert.equal(after.status, 1, 'the spare is reported: ' + (after.stderr || after.stdout));
        assert.match(after.stderr, /popup_ja\.PNG: drawn by nothing/);
        assert.match(after.stderr, /Delete: .*popup_ja\.PNG/);
        assert.doesNotMatch(after.stderr, /Rename: /,
          'and it is not asked to be renamed onto the name that is already there');

        // Two spellings and no canonical name: whichever is renamed first, the
        // second one lands on top of it, so this is not a rename to advise.
        fs.renameSync(path.join(sandbox, 'docs/screenshots/popup_ja.png'),
          path.join(sandbox, 'docs/screenshots/POPUP_JA.png'));
        const contested = runCheck(sandbox);
        assert.equal(contested.status, 1,
          'the collision is reported: ' + (contested.stderr || contested.stdout));
        assert.match(contested.stderr, /POPUP_JA\.png: one of 2 files claiming the name popup_ja\.png/);
        assert.match(contested.stderr, /popup_ja\.PNG: one of 2 files claiming the name popup_ja\.png/);
        assert.match(contested.stderr,
          /Keep one as popup_ja\.png and delete the rest: .*POPUP_JA\.png .*popup_ja\.PNG/);
        assert.doesNotMatch(contested.stderr, /Rename: /,
          'and neither is told to take the name the other would take');
      }
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
    // the crop still matches, and reading "differs" would send the reader
    // looking for the wrong thing.
    assert.match(run.stderr, /settings_en\.png: a different size/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check names a link with nothing at the end of it', { skip: generatorSkip
  || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
  const sandbox = screenshotSandbox();
  try {
    // exists() reads through the link and finds nothing, which reads as a name
    // nobody has committed — and sends the reader to a redraw that leaves the
    // link exactly where it is.
    fs.rmSync(path.join(sandbox, 'docs/screenshots/popup_ja.png'));
    fs.symlinkSync('gone.png', path.join(sandbox, 'docs/screenshots/popup_ja.png'));

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the link is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr, /popup_ja\.png: a symbolic link \(points at gone\.png\)/);
    assert.doesNotMatch(run.stderr, /popup_ja\.png: not committed/,
      'and not as a name nobody has committed');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a directory that will not take this run says so', { skip: generatorSkip
  || (process.platform === 'win32' && 'mode bits do not keep a directory shut on win32')
  || (typeof process.getuid === 'function' && process.getuid() === 0
    && 'root writes into a directory whatever its mode says') }, () => {
  const sandbox = screenshotSandbox();
  const readonly = path.join(sandbox, 'readonly');
  const tracked = path.join(sandbox, 'docs/screenshots');
  try {
    // Three moments where the filesystem is the one that refuses: making the
    // destination, making the working directory inside it, and reading what is
    // there. Each was a traceback with exit 1 — the answer for images that
    // differ — and the working directory left nothing behind either way.
    fs.mkdirSync(readonly);
    fs.chmodSync(readonly, 0o555);
    const under = spawnSync('python3', ['-B', 'gen_screenshots.py',
      '--out', path.join(readonly, 'shots')], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(under.status, 2, 'a destination that cannot be made: ' + under.stderr);
    assert.doesNotMatch(under.stderr, /Traceback/);
    assert.match(under.stderr, /usage:/);

    const into = spawnSync('python3', ['-B', 'gen_screenshots.py', '--out', readonly],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(into.status, 2, 'a destination that will not take a file: ' + into.stderr);
    assert.doesNotMatch(into.stderr, /Traceback/);
    assert.match(into.stderr, /readonly cannot be written \(Permission denied\)/,
      'named as the destination rather than as the working directory');
    assert.deepEqual(fs.readdirSync(readonly), [], 'and nothing was left in it');

    fs.chmodSync(tracked, 0o555);
    const redraw = spawnSync('python3', ['-B', 'gen_screenshots.py'],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(redraw.status, 1, 'the tracked directory refusing is exit 1: ' + redraw.stderr);
    assert.doesNotMatch(redraw.stderr, /Traceback/);
    assert.match(redraw.stderr, /docs\/screenshots cannot be written \(Permission denied\)/);
    assert.deepEqual(fs.readdirSync(tracked).filter((name) => !name.endsWith('.png')), [],
      'and left nothing of its own behind');

    fs.chmodSync(tracked, 0o000);
    const unreadable = runCheck(sandbox);
    assert.equal(unreadable.status, 1, 'a tracked directory that cannot be listed');
    assert.doesNotMatch(unreadable.stderr, /Traceback/);
    assert.match(unreadable.stderr, /docs\/screenshots: cannot be read \(Permission denied\)/);
  } finally {
    fs.chmodSync(readonly, 0o755);
    fs.chmodSync(tracked, 0o755);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a name a redraw cannot overwrite is named, not raised over', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // Replacing takes a copy of what it is about to overwrite first, and a
    // directory under one of the six names stops that copy.
    const target = path.join(sandbox, 'docs/screenshots/popup_ja.png');
    fs.rmSync(target);
    fs.mkdirSync(target);

    const redraw = spawnSync('python3', ['-B', 'gen_screenshots.py'],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(redraw.status, 1, 'the run stops: ' + redraw.stderr);
    assert.doesNotMatch(redraw.stderr, /Traceback/);
    // Named as the copy it is - taking one of the image it is about to
    // overwrite, with where that copy was going named too.
    assert.match(redraw.stderr, /docs\/screenshots\/popup_ja\.png cannot be copied to .+/);
    assert.ok(fs.statSync(target).isDirectory(), 'and the name is left as it was');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// Rolling back is six copies of its own, and they can be refused too. Stopping
// at the first refusal leaves every name after it holding this run's image, and
// the error that escapes is the rollback's - the replacement that started it is
// gone.
const INJECT_RESTORE_FAILURE = [
  'import contextlib, hashlib, importlib.util, io, json, os, shutil, sys, tempfile',
  'stuck = sys.argv[1]',
  'repo = os.getcwd()',
  'def digest(p):',
  "    return hashlib.sha256(open(p, 'rb').read()).hexdigest()",
  'with tempfile.TemporaryDirectory() as sandbox:',
  "    script = os.path.join(sandbox, 'gen_screenshots.py')",
  "    source = open(os.path.join(repo, 'gen_screenshots.py'), encoding='utf-8').read()",
  '    # Drawn white has to differ from tracked white, or a name left new cannot',
  '    # be told from one put back.',
  "    source = source.replace('WHITE = (255, 255, 255)', 'WHITE = (254, 254, 254)', 1)",
  "    open(script, 'w', encoding='utf-8').write(source)",
  "    shutil.copytree(os.path.join(repo, 'tools'), os.path.join(sandbox, 'tools'))",
  "    out = os.path.join(sandbox, 'docs', 'screenshots')",
  '    os.makedirs(out)',
  "    tracked = os.path.join(repo, 'docs', 'screenshots')",
  "    for name in sorted(n for n in os.listdir(tracked) if n.lower().endswith('.png')):",
  '        shutil.copy2(os.path.join(tracked, name), os.path.join(out, name))',
  '    before = {n: digest(os.path.join(out, n)) for n in sorted(os.listdir(out))}',
  "    spec = importlib.util.spec_from_file_location('gen_under_test', script)",
  '    gen = importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(gen)',
  "    calls = {'n': 0}",
  '    real_move, real_copy2 = shutil.move, shutil.copy2',
  '    def flaky_move(src, dst, *a, **k):',
  "        calls['n'] += 1",
  "        if calls['n'] == 4:",
  "            raise OSError('injected before the move')",
  '        return real_move(src, dst, *a, **k)',
  '    def flaky_copy2(src, dst, *a, **k):',
  '        # Only the way back, and only for the one name.',
  '        if os.path.dirname(dst) == out and os.path.basename(dst) == stuck:',
  "            raise OSError('injected while putting it back')",
  '        return real_copy2(src, dst, *a, **k)',
  '    gen.shutil.move = flaky_move',
  '    gen.shutil.copy2 = flaky_copy2',
  '    said = io.StringIO()',
  '    with contextlib.redirect_stderr(said):',
  '        code = gen.main()',
  '    gen.shutil.move, gen.shutil.copy2 = real_move, real_copy2',
  '    kept = [n for n in sorted(os.listdir(out)) if os.path.isdir(os.path.join(out, n))]',
  '    held = os.path.join(out, kept[0], stuck) if kept else None',
  "    print(json.dumps({'code': code, 'told': said.getvalue(), 'kept': kept,",
  "                      'moved': calls['n'] - 1,",
  "                      'changed': sorted(n for n in before",
  '                                        if digest(os.path.join(out, n)) != before[n]),',
  "                      'recoverable': bool(held) and os.path.exists(held)",
  '                                     and digest(held) == before[stuck]}))',
].join('\n');

test('a name the rollback cannot put back is named, and what it holds is kept',
  { skip: generatorSkip }, () => {
    const stuck = 'overlay_ja.png';
    const run = spawnSync('python3', ['-B', '-c', INJECT_RESTORE_FAILURE, stuck],
      { cwd: __dirname, encoding: 'utf8' });
    assert.equal(run.status, 0, 'the probe ran: ' + (run.stderr || run.stdout));
    const seen = JSON.parse(run.stdout);
    assert.ok(seen.moved >= 1, 'something had been replaced, so a rollback was owed');
    assert.equal(seen.code, 1, 'the run reports rather than raises: ' + seen.told);
    // The rest of the names were put back, so the one that could not be is the
    // only one left holding this run's image.
    assert.deepEqual(seen.changed, [stuck], 'only the name it could not put back: ' + seen.told);
    // The replacement failure is what the reader is looking for; the rollback's
    // own failure must not take its place.
    assert.match(seen.told, /injected before the move/);
    assert.match(seen.told, new RegExp(stuck.replace('.', '\\.')
      + ': the previous image cannot be put back \\(injected while putting it back\\)'),
    'and why it could not be: ' + seen.told);
    // And the previous image is still somewhere the reader can reach.
    assert.equal(seen.kept.length, 1, 'what it took is kept: ' + seen.told);
    assert.ok(seen.told.includes(seen.kept[0]), 'and named: ' + seen.told);
    assert.ok(seen.recoverable, 'the kept copy is the image that was there');
  });

// Drawing happens in a working directory inside the destination, so a refusal
// there arrives carrying a name nobody asked about - and the six that name is
// under are the ones the reader is looking at.
const INJECT_DRAW_FAILURE = [
  'import contextlib, importlib.util, io, json, os, shutil, sys, tempfile',
  'repo = os.getcwd()',
  'with tempfile.TemporaryDirectory() as sandbox:',
  "    script = os.path.join(sandbox, 'gen_screenshots.py')",
  "    shutil.copy2(os.path.join(repo, 'gen_screenshots.py'), script)",
  "    shutil.copytree(os.path.join(repo, 'tools'), os.path.join(sandbox, 'tools'))",
  "    out = os.path.join(sandbox, 'docs', 'screenshots')",
  '    os.makedirs(out)',
  "    tracked = os.path.join(repo, 'docs', 'screenshots')",
  "    for name in sorted(n for n in os.listdir(tracked) if n.lower().endswith('.png')):",
  '        shutil.copy2(os.path.join(tracked, name), os.path.join(out, name))',
  "    spec = importlib.util.spec_from_file_location('gen_under_test', script)",
  '    gen = importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(gen)',
  '    def refusing(target):',
  "        raise OSError(13, 'Permission denied', os.path.join(target, 'popup_ja.png'))",
  '    gen.draw_all = refusing',
  '    said = io.StringIO()',
  '    with contextlib.redirect_stderr(said):',
  '        code = gen.main()',
  "    print(json.dumps({'code': code, 'told': said.getvalue(),",
  "                      'left': sorted(os.listdir(out))}))",
].join('\n');

test('a refusal while drawing names the destination, not the working directory',
  { skip: generatorSkip }, () => {
    const run = spawnSync('python3', ['-B', '-c', INJECT_DRAW_FAILURE],
      { cwd: __dirname, encoding: 'utf8' });
    assert.equal(run.status, 0, 'the probe ran: ' + (run.stderr || run.stdout));
    const seen = JSON.parse(run.stdout);
    assert.equal(seen.code, 1, 'the run reports rather than raises: ' + seen.told);
    assert.match(seen.told, /docs\/screenshots cannot be drawn into \(Permission denied\)/);
    // The name it was handed is inside a directory this run picked and removed.
    assert.doesNotMatch(seen.told, /screenshots\/tmp/, 'a name the reader cannot look at');
    assert.equal(seen.left.length, 6, 'and it took its working directory with it');
  });

// A name about to be replaced does not have to be a plain file. exists() reads a
// link with nothing at the end of it as a name with nothing to put back, and
// copy2 reads through a link, so what came back was whatever it pointed at,
// written as a file of its own.
const INJECT_OVER_A_LINK = [
  'import contextlib, hashlib, importlib.util, io, json, os, shutil, sys, tempfile',
  'mode = sys.argv[1]',
  'repo = os.getcwd()',
  "first = 'overlay_en.png'",
  'def digest(p):',
  "    return hashlib.sha256(open(p, 'rb').read()).hexdigest()",
  'with tempfile.TemporaryDirectory() as sandbox:',
  "    script = os.path.join(sandbox, 'gen_screenshots.py')",
  "    source = open(os.path.join(repo, 'gen_screenshots.py'), encoding='utf-8').read()",
  "    source = source.replace('WHITE = (255, 255, 255)', 'WHITE = (254, 254, 254)', 1)",
  "    open(script, 'w', encoding='utf-8').write(source)",
  "    shutil.copytree(os.path.join(repo, 'tools'), os.path.join(sandbox, 'tools'))",
  "    out = os.path.join(sandbox, 'docs', 'screenshots')",
  '    os.makedirs(out)',
  "    tracked = os.path.join(repo, 'docs', 'screenshots')",
  "    if mode != 'firstrun':",
  "        for name in sorted(n for n in os.listdir(tracked) if n.lower().endswith('.png')):",
  '            shutil.copy2(os.path.join(tracked, name), os.path.join(out, name))',
  '    here = os.path.join(out, first)',
  '    aside = None',
  "    if mode in ('dangling', 'linkback', 'linkbackup'):",
  '        os.remove(here)',
  "        os.symlink('gone.png', here)",
  "    elif mode == 'pointing':",
  "        aside = os.path.join(sandbox, 'elsewhere.png')",
  '        shutil.move(here, aside)',
  '        os.symlink(aside, here)',
  "    held = digest(aside) if aside else None",
  "    spec = importlib.util.spec_from_file_location('gen_under_test', script)",
  '    gen = importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(gen)',
  "    calls = {'n': 0}",
  '    def state(p):',
  '        if os.path.islink(p):',
  "            return 'link -> ' + os.readlink(p)",
  '        if not os.path.exists(p):',
  "            return 'absent'",
  '        if os.path.isdir(p):',
  "            return 'dir'",
  "        return 'file ' + digest(p)",
  '    def snapshot(d):',
  '        return {n: state(os.path.join(d, n)) for n in sorted(os.listdir(d))}',
  '    was = snapshot(out)',
  '    real_move, real_remove, real_symlink = shutil.move, os.remove, os.symlink',
  '    def stopping(src, dst, *a, **k):',
  "        calls['n'] += 1",
  '        # The first name has been replaced by now, so a rollback is owed.',
  "        if calls['n'] == 2:",
  "            raise OSError('injected before the move')",
  '        return real_move(src, dst, *a, **k)',
  '    def refusing(path, *a, **k):',
  '        if os.path.dirname(path) == out and os.path.basename(path) == first:',
  "            raise OSError(13, 'Permission denied', path)",
  '        return real_remove(path, *a, **k)',
  '    def refusing_link(target, dst, *a, **k):',
  '        # linkback refuses the way back, linkbackup refuses the copy taken of it.',
  "        into_tracked = os.path.dirname(dst) == out",
  "        if into_tracked if mode == 'linkback' else not into_tracked:",
  "            raise OSError(13, 'Permission denied', dst)",
  '        return real_symlink(target, dst, *a, **k)',
  '    gen.shutil.move = stopping',
  "    if mode == 'firstrun':",
  '        os.remove = refusing',
  "    if mode in ('linkback', 'linkbackup'):",
  '        os.symlink = refusing_link',
  '    said = io.StringIO()',
  '    try:',
  '        with contextlib.redirect_stderr(said):',
  '            code = gen.main()',
  '    finally:',
  '        gen.shutil.move = real_move',
  '        os.remove, os.symlink = real_remove, real_symlink',
  '    now = snapshot(out)',
  "    kept = [n for n in sorted(os.listdir(out)) if os.path.isdir(os.path.join(out, n))]",
  "    print(json.dumps({'code': code, 'told': said.getvalue(), 'state': state(here),",
  "                      'moved': max(calls['n'] - 1, 0),",
  "                      'pointed_at_held': bool(aside) and digest(aside) == held,",
  "                      'kept': kept, 'changed': sorted(n for n in was if now.get(n) != was[n]),",
  "                      'kept_holds': snapshot(os.path.join(out, kept[0])) if kept else {}}))",
].join('\n');

function overALink(mode, { replaced = true } = {}) {
  const run = spawnSync('python3', ['-B', '-c', INJECT_OVER_A_LINK, mode],
    { cwd: __dirname, encoding: 'utf8' });
  assert.equal(run.status, 0, 'the probe ran: ' + (run.stderr || run.stdout));
  const seen = JSON.parse(run.stdout);
  if (replaced) {
    assert.ok(seen.moved >= 1, 'something had been replaced, so a rollback was owed');
  } else {
    assert.equal(seen.moved, 0, 'it stopped before replacing anything');
  }
  assert.equal(seen.code, 1, 'the run reports rather than raises: ' + seen.told);
  return seen;
}

test('a rollback puts back a link with nothing at the end of it', { skip: generatorSkip
  || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
  const seen = overALink('dangling');
  // Not "absent": the run did not commit its images, so it does not get to
  // decide the name is gone either.
  assert.equal(seen.state, 'link -> gone.png', 'the link is back: ' + seen.told);
});

test('a rollback puts back a link rather than what it pointed at', { skip: generatorSkip
  || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
  const seen = overALink('pointing');
  assert.match(seen.state, /^link -> .*elsewhere\.png$/, 'the link is back: ' + seen.told);
  assert.ok(seen.pointed_at_held, 'and what it pointed at was never written through');
});

test('a link the rollback cannot put back is kept, target and all', { skip: generatorSkip
  || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
  const seen = overALink('linkback');
  // Where it pointed lives in this run and nowhere else, so it has to leave the
  // run: in what is said, and in what is kept.
  assert.match(seen.told, /overlay_en\.png -> gone\.png: the previous link cannot be put back/, seen.told);
  assert.match(seen.told, /what was there is kept in/, 'and the copy it took is offered: ' + seen.told);
  assert.equal(seen.kept.length, 1, 'the copy is kept: ' + seen.told);
  assert.equal(seen.kept_holds['overlay_en.png'], 'link -> gone.png',
    'and holds the link itself, not what it pointed at');
});

test('a link that cannot be copied stops the run before it replaces anything',
  { skip: generatorSkip
    || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
    const seen = overALink('linkbackup', { replaced: false });
    // Nothing to put back is only safe while nothing has been taken away.
    assert.match(seen.told, /overlay_en\.png cannot be copied to .+ \(Permission denied\)/,
      seen.told);
    assert.deepEqual(seen.changed, [], 'and the six names are as they were');
    assert.equal(seen.state, 'link -> gone.png');
  });

test('a first run says it could not take its own image back out', { skip: generatorSkip
  || (typeof process.getuid === 'function' && process.getuid() === 0
    && 'root removes a file whatever the directory says') }, () => {
  const seen = overALink('firstrun');
  // There was no previous image under that name, so "the previous image cannot
  // be put back" would name one that never existed - and point at a backup
  // holding nothing.
  assert.match(seen.told, /overlay_en\.png: this run's image cannot be taken back out/, seen.told);
  assert.doesNotMatch(seen.told, /what was there is kept in/, 'nothing was taken, so nothing is offered');
  assert.deepEqual(seen.kept, [], 'and an empty backup is not left behind');
});

test('a link to a directory under a drawn name is turned down, not written through',
  { skip: generatorSkip
    || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
    const sandbox = screenshotSandbox();
    try {
      // shutil.move puts the file inside a directory it is handed, and a link
      // to one is a directory to everything that reads through it. The run
      // would report six images and have written one of them somewhere else.
      const aside = path.join(sandbox, 'aside');
      fs.mkdirSync(aside);
      const target = path.join(sandbox, 'docs/screenshots/overlay_en.png');
      fs.rmSync(target);
      fs.symlinkSync(aside, target);

      const redraw = spawnSync('python3', ['-B', 'gen_screenshots.py'],
        { cwd: sandbox, encoding: 'utf8' });
      assert.equal(redraw.status, 1, 'the run stops: ' + redraw.stderr);
      assert.doesNotMatch(redraw.stderr, /Traceback/);
      assert.match(redraw.stderr, /overlay_en\.png: a link to a directory/);
      assert.deepEqual(fs.readdirSync(aside), [], 'and nothing was written inside it');
      assert.ok(fs.lstatSync(target).isSymbolicLink(), 'and the link is left as it was');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

// Taking the copy reads the image and writes the copy in the one call, and a run
// that finished says the copy it made did not outlive it.
const INJECT_COPY_FAULT = [
  'import contextlib, importlib.util, io, json, os, shutil, sys, tempfile',
  'mode = sys.argv[1]',
  'repo = os.getcwd()',
  'with tempfile.TemporaryDirectory() as sandbox:',
  "    script = os.path.join(sandbox, 'gen_screenshots.py')",
  "    shutil.copy2(os.path.join(repo, 'gen_screenshots.py'), script)",
  "    shutil.copytree(os.path.join(repo, 'tools'), os.path.join(sandbox, 'tools'))",
  "    out = os.path.join(sandbox, 'docs', 'screenshots')",
  '    os.makedirs(out)',
  "    tracked = os.path.join(repo, 'docs', 'screenshots')",
  "    for name in sorted(n for n in os.listdir(tracked) if n.lower().endswith('.png')):",
  '        shutil.copy2(os.path.join(tracked, name), os.path.join(out, name))',
  '    first = sorted(os.listdir(out))[0]',
  "    spec = importlib.util.spec_from_file_location('gen_under_test', script)",
  '    gen = importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(gen)',
  '    real_copy2, real_rmtree = shutil.copy2, shutil.rmtree',
  '    def full_disk(src, dst, *a, **k):',
  '        # The copy is what will not fit; the image itself reads.',
  '        if os.path.dirname(dst) != out:',
  "            raise OSError(28, 'No space left on device', dst)",
  '        return real_copy2(src, dst, *a, **k)',
  '    def refusing_rmtree(path, *a, **k):',
  '        # Only the copy: the staging directory is empty by the time it goes.',
  '        if os.listdir(path):',
  "            raise OSError(13, 'Permission denied', path)",
  '        return real_rmtree(path, *a, **k)',
  "    if mode == 'nospace':",
  '        gen.shutil.copy2 = full_disk',
  '    else:',
  '        gen.shutil.rmtree = refusing_rmtree',
  '    said = io.StringIO()',
  '    try:',
  '        with contextlib.redirect_stderr(said), contextlib.redirect_stdout(io.StringIO()):',
  '            code = gen.main()',
  '    finally:',
  '        gen.shutil.copy2, gen.shutil.rmtree = real_copy2, real_rmtree',
  "    print(json.dumps({'code': code, 'told': said.getvalue(), 'first': first,",
  "                      'reads': open(os.path.join(out, first), 'rb').read(4).hex(),",
  "                      'left': sorted(n for n in os.listdir(out)",
  "                                     if not n.lower().endswith('.png'))}))",
].join('\n');

test('a copy that will not fit names where it was going, not the image',
  { skip: generatorSkip }, () => {
    const run = spawnSync('python3', ['-B', '-c', INJECT_COPY_FAULT, 'nospace'],
      { cwd: __dirname, encoding: 'utf8' });
    assert.equal(run.status, 0, 'the probe ran: ' + (run.stderr || run.stdout));
    const seen = JSON.parse(run.stdout);
    // The image reads perfectly well, so "cannot be read" would have the
    // reader looking at the one thing that is not in the way.
    assert.equal(seen.reads, '89504e47', 'the image reads, so the copy is what refused');
    assert.equal(seen.code, 1, 'the run stops: ' + seen.told);
    assert.match(seen.told, new RegExp(seen.first.replace('.', '\\.')
      + ' cannot be copied to .+ \\(No space left on device\\)'), seen.told);
    assert.deepEqual(seen.left, [], 'and nothing of the run is left behind');
  });

test('a run leaves alone what it found in the directory, and says nothing of it',
  { skip: generatorSkip }, () => {
    const sandbox = screenshotSandbox();
    try {
      // What the run answers for is the copy it made. Something already in the
      // directory is not this run's to remove, or to report: reading exit 0 as
      // "the six and nothing else" would be reading more than is measured.
      //
      // Both halves are measured against the same directory with one thing
      // changed. Saying nothing is the whole of what the two runs print, not
      // the absence of one name — a line that mentions the file without naming
      // it says something too — and what is left alone is read back after each
      // run, since one that removes it quietly says nothing either.
      const draw = () => spawnSync('python3', ['-B', 'gen_screenshots.py'],
        { cwd: sandbox, encoding: 'utf8' });
      const beside = path.join(sandbox, 'docs/screenshots/sentinel.txt');
      const quiet = [draw(), runCheck(sandbox)];
      assert.deepEqual(quiet.map((run) => run.status), [0, 0],
        'the runs to compare against finish: ' + quiet.map((run) => run.stderr).join(' '));

      fs.writeFileSync(beside, 'not this run\n');

      const drew = draw();
      assert.equal(drew.status, 0, 'the run finishes: ' + drew.stderr);
      assert.deepEqual([drew.stdout, drew.stderr], [quiet[0].stdout, quiet[0].stderr],
        'and says exactly what it says with nothing there: ' + drew.stdout);
      assert.equal(fs.readFileSync(beside, 'utf8'), 'not this run\n',
        'with what was there still there, unchanged');

      const checked = runCheck(sandbox);
      assert.equal(checked.status, 0, '--check counts .png files: ' + checked.stderr);
      assert.deepEqual([checked.stdout, checked.stderr], [quiet[1].stdout, quiet[1].stderr],
        'and says the same as it says with nothing there: ' + checked.stdout);
      assert.equal(fs.readFileSync(beside, 'utf8'), 'not this run\n',
        'with what was there still there after that too');
      assert.deepEqual(fs.readdirSync(sandbox + '/docs/screenshots').filter(
        (name) => !name.toLowerCase().endsWith('.png')), ['sentinel.txt'],
      'and nothing of either run beside it');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('a copy that cannot be cleared away is answered for, not only mentioned',
  { skip: generatorSkip }, () => {
    const run = spawnSync('python3', ['-B', '-c', INJECT_COPY_FAULT, 'litter'],
      { cwd: __dirname, encoding: 'utf8' });
    assert.equal(run.status, 0, 'the probe ran: ' + (run.stderr || run.stdout));
    const seen = JSON.parse(run.stdout);
    // Exit 0 says this run left no copy of its own behind - it says nothing
    // about what was in the directory before it. The copy is named and filled
    // by this run, so a copy that outlives it has nobody else to report it:
    // --check only counts .png files.
    assert.equal(seen.code, 1, 'the run does not answer 0: ' + seen.told);
    assert.match(seen.told, /is left behind \(Permission denied\)/, seen.told);
    assert.equal(seen.left.length, 1, 'since it is still there: ' + seen.left.join(', '));
  });

test('an image that cannot be read is not called one that cannot be written',
  { skip: generatorSkip
    || (process.platform === 'win32' && 'mode bits do not keep a file shut on win32')
    || (typeof process.getuid === 'function' && process.getuid() === 0
      && 'root reads a file whatever its mode says') }, () => {
    const sandbox = screenshotSandbox();
    const target = path.join(sandbox, 'docs/screenshots/overlay_en.png');
    try {
      // The copy that takes a backup reads the tracked image. Calling that
      // "cannot be written" sends the reader to the directory's mode, which is
      // the one thing that is not in the way.
      fs.chmodSync(target, 0o000);
      const redraw = spawnSync('python3', ['-B', 'gen_screenshots.py'],
        { cwd: sandbox, encoding: 'utf8' });
      assert.equal(redraw.status, 1, 'the run stops: ' + redraw.stderr);
      assert.doesNotMatch(redraw.stderr, /Traceback/);
      assert.match(redraw.stderr,
        /docs\/screenshots\/overlay_en\.png cannot be copied to .+ \(Permission denied\)/);
      assert.doesNotMatch(redraw.stderr, /cannot be written/);
    } finally {
      fs.chmodSync(target, 0o644);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('a destination handed on the command line is answered as an argument',
  { skip: generatorSkip
    || (process.platform === 'win32' && 'mode bits do not keep a directory shut on win32')
    || (typeof process.getuid === 'function' && process.getuid() === 0
      && 'root writes into a directory whatever its mode says') }, () => {
    const sandbox = screenshotSandbox();
    const tracked = path.join(sandbox, 'docs/screenshots');
    try {
      // Both runs are refused by the same directory. What differs is who is
      // being answered: one wrote the destination down, the other did not - and
      // reading the exit code off where it landed makes --out mean two things.
      fs.chmodSync(tracked, 0o555);
      const named = spawnSync('python3', ['-B', 'gen_screenshots.py', '--out', tracked],
        { cwd: sandbox, encoding: 'utf8' });
      assert.equal(named.status, 2, 'a destination that was handed over: ' + named.stderr);
      assert.match(named.stderr, /usage:/);

      const bare = spawnSync('python3', ['-B', 'gen_screenshots.py'],
        { cwd: sandbox, encoding: 'utf8' });
      assert.equal(bare.status, 1, 'and the tracked directory on its own: ' + bare.stderr);
      assert.doesNotMatch(bare.stderr, /usage:/);
    } finally {
      fs.chmodSync(tracked, 0o755);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

test('--check turns down a tracked directory that is a link to one', { skip: generatorSkip
  || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
  const sandbox = screenshotSandbox();
  try {
    // A link anywhere on the way there hides the same thing: lstat answers for
    // the last name in the path, so with docs itself a link, everything under
    // it reads as a directory of images. Neither run may write through it —
    // both name docs/screenshots in what they print.
    fs.renameSync(path.join(sandbox, 'docs'), path.join(sandbox, 'docs.source'));
    fs.symlinkSync('docs.source', path.join(sandbox, 'docs'));
    const marked = path.join(sandbox, 'docs.source/screenshots/popup_ja.png');
    assert.equal(spawnSync('python3', ['-B', '-c',
      'import sys; from PIL import Image;' +
      'i = Image.open(sys.argv[1]).convert("RGB");' +
      'r, g, b = i.getpixel((5, 5));' +
      'i.putpixel((5, 5), (r ^ 1, g, b));' +
      'i.save(sys.argv[1])', marked], { encoding: 'utf8' }).status, 0, 'the probe marked a pixel');
    const before = fs.readFileSync(marked);

    const parent = runCheck(sandbox);
    assert.equal(parent.status, 1, 'the linked parent is reported: ' + (parent.stderr || parent.stdout));
    assert.match(parent.stderr, /docs: a symbolic link \(points at docs\.source\)/);
    const redraw = spawnSync('python3', ['-B', 'gen_screenshots.py'],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(redraw.status, 1, 'and drawing refuses the same way: ' + redraw.stderr);
    assert.match(redraw.stderr, /docs: a symbolic link/);
    assert.deepEqual(fs.readFileSync(marked), before, 'the refused run wrote nothing');

    fs.unlinkSync(path.join(sandbox, 'docs'));
    fs.renameSync(path.join(sandbox, 'docs.source'), path.join(sandbox, 'docs'));

    // A link that points nowhere is not "nothing is tracked here": what the
    // six images would say about themselves is beside the point, and drawing
    // through it ends in a traceback rather than an answer.
    fs.rmSync(path.join(sandbox, 'docs/screenshots'), { recursive: true });
    fs.symlinkSync('nowhere', path.join(sandbox, 'docs/screenshots'));
    const dangling = runCheck(sandbox);
    assert.equal(dangling.status, 1, 'the dangling link is reported: ' + (dangling.stderr || ''));
    assert.match(dangling.stderr, /docs\/screenshots: a symbolic link \(points at nowhere\)/);
    const drawn = spawnSync('python3', ['-B', 'gen_screenshots.py'],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(drawn.status, 1, 'and drawing refuses it too: ' + drawn.stderr);
    assert.doesNotMatch(drawn.stderr, /Traceback/, 'without a traceback');
    fs.unlinkSync(path.join(sandbox, 'docs/screenshots'));
    fs.cpSync(path.join(__dirname, 'docs/screenshots'),
      path.join(sandbox, 'docs/screenshots'), { recursive: true });
    // lstat on each image reads the last name in the path, so the six under a
    // linked directory all pass. What a repository records for that is six
    // deletions and one link.
    fs.renameSync(path.join(sandbox, 'docs/screenshots'),
      path.join(sandbox, 'docs/screenshots.source'));
    fs.symlinkSync('screenshots.source', path.join(sandbox, 'docs/screenshots'));

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the linked directory is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr,
      /docs\/screenshots: a symbolic link \(points at screenshots\.source\)/);
    assert.doesNotMatch(run.stderr, /screenshots match the code that draws them/,
      'and the six images under it are not vouched for');

    // A file by that name is not a directory either, and neither is reported
    // as an image that differs.
    fs.unlinkSync(path.join(sandbox, 'docs/screenshots'));
    fs.writeFileSync(path.join(sandbox, 'docs/screenshots'), '');
    const asFile = runCheck(sandbox);
    assert.equal(asFile.status, 1, 'a file by that name is reported too');
    assert.match(asFile.stderr, /docs\/screenshots: not a directory/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--check turns down a tracked image that is a link to one', { skip: generatorSkip
  || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
  const sandbox = screenshotSandbox();
  try {
    // Everything that opens the file follows the link, so the pixels match and
    // the size matches. What git records for a link is where it points, which
    // is not an image at all.
    const shots = path.join(sandbox, 'docs/screenshots');
    fs.renameSync(path.join(shots, 'popup_ja.png'), path.join(shots, 'popup_ja.source'));
    fs.symlinkSync('popup_ja.source', path.join(shots, 'popup_ja.png'));
    // And two under names nothing draws: one that points nowhere, which a
    // filter asking whether the target is a file leaves out of the report, and
    // one that points at a directory, which a filter asking whether the target
    // is a directory leaves out the same way.
    fs.symlinkSync('gone.png', path.join(shots, 'popup_de.png'));
    fs.symlinkSync('../../tools', path.join(shots, 'overlay_de.png'));
    fs.mkdirSync(path.join(shots, 'tmpabc123.png'));

    const run = runCheck(sandbox);
    assert.equal(run.status, 1, 'the link is reported: ' + (run.stderr || run.stdout));
    assert.match(run.stderr,
      /popup_ja\.png: a symbolic link \(points at popup_ja\.source\)/);
    assert.match(run.stderr, /popup_de\.png: drawn by nothing/);
    assert.match(run.stderr, /overlay_de\.png: drawn by nothing/);
    assert.doesNotMatch(run.stderr, /tmpabc123\.png/,
      'while a directory of that name is still what an interrupted run left');
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

      // An image by any other spelling is still one nothing draws — and APFS
      // makes that spelling easy to commit.
      fs.renameSync(path.join(sandbox, 'docs/screenshots/popup_de.png'),
        path.join(sandbox, 'docs/screenshots/popup_de.PNG'));
      const upper = runCheck(sandbox);
      assert.equal(upper.status, 1, '.PNG is read as an image too: ' + (upper.stderr || upper.stdout));
      assert.match(upper.stderr, /popup_de\.PNG/);

      // What macOS and an interrupted run leave behind are not tracked images.
      // The staging directory carries the suffix, so the name alone cannot
      // tell it from a file.
      fs.rmSync(path.join(sandbox, 'docs/screenshots/popup_de.PNG'));
      fs.writeFileSync(path.join(sandbox, 'docs/screenshots/.DS_Store'), '');
      fs.mkdirSync(path.join(sandbox, 'docs/screenshots/tmpabc123.png'));
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
  // Drawing is deterministic, so bytes alone cannot tell a run that wrote the
  // tracked directory from one that left it alone. This pixel would come back.
  assert.equal(spawnSync('python3', ['-B', '-c',
    'import sys; from PIL import Image;' +
    'i = Image.open(sys.argv[1]).convert("RGB");' +
    'r, g, b = i.getpixel((320, 200));' +
    'i.putpixel((320, 200), (r ^ 1, g, b));' +
    'i.save(sys.argv[1])', path.join(sandbox, 'docs/screenshots/popup_ja.png')],
  { encoding: 'utf8' }).status, 0, 'the probe marked one pixel');
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
    // loosely: a near miss is an argument error, not a redraw. Neither is a
    // destination handed to the mode that writes nothing, nor a flag standing
    // in for one — `--out --chek` used to create a directory called --chek.
    // Also: a destination given twice, one that never arrived, an empty one,
    // and one that is a file — each is the argument being wrong rather than
    // the images differing, and none of them is a place to write.
    fs.writeFileSync(path.join(sandbox, 'afile'), '');
    fs.symlinkSync('nowhere', path.join(sandbox, 'broken'));
    for (const args of [['--chek'], ['--check', '--chek'],
      ['--check', '--out', elsewhere], ['--out', elsewhere, '--check'],
      ['--out', '--chek'],
      ['--out'], ['--out', ''], ['--out', elsewhere, '--out', `${elsewhere}2`],
      ['--out', path.join(sandbox, 'afile')],
      // A destination that does not exist yet is created, so what has to hold
      // is the nearest name that does: under a file there is no directory to
      // make, and a link that points nowhere is not a directory either — both
      // used to reach os.makedirs and come back as a traceback.
      ['--out', path.join(sandbox, 'afile', 'child')],
      ['--out', path.join(sandbox, 'broken')],
      // `..` after a name is only walkable if that name is a directory. The
      // path collapses to a place that would be fine, so a check that reads
      // the collapsed one never sees the file it was told to go through.
      // path.join would collapse the `..` here as well, so these are spelled
      // out: what has to reach the generator is the path as written. The last
      // two walk back onto a name that is there, past one that is not — the
      // walk stops at the missing name, so the collapsed path is what says no.
      ['--out', [sandbox, 'afile', '..', 'escaped'].join(path.sep)],
      ['--out', [sandbox, 'missing', '..', 'afile'].join(path.sep)],
      ['--out', [sandbox, 'missing', '..', 'broken'].join(path.sep)]]) {
      const refused = spawnSync('python3', ['-B', 'gen_screenshots.py', ...args],
        { cwd: sandbox, encoding: 'utf8' });
      assert.equal(refused.status, 2,
        `${args.join(' ')} is refused: ` + (refused.stderr || ''));
      assert.match(refused.stderr, /usage:/, `${args.join(' ')} is told the shape of the command`);
    }
    assert.ok(!fs.existsSync(path.join(sandbox, '--chek')), 'and none of them made a directory');
    assert.ok(!fs.statSync(path.join(sandbox, 'afile')).isDirectory(),
      'nor turned a file into one');
    assert.ok(!fs.existsSync(path.join(sandbox, 'broken')), 'nor gave a broken link somewhere to point');
    assert.ok(!fs.existsSync(path.join(sandbox, 'escaped')), 'nor wrote where the path collapsed to');
    assert.ok(!fs.existsSync(path.join(sandbox, 'missing')), 'nor made the name it was told to pass');

    // Through a directory it is the same path either way, and that one runs.
    fs.mkdirSync(path.join(sandbox, 'adir'));
    const through = spawnSync('python3', ['-B', 'gen_screenshots.py',
      '--out', [sandbox, 'adir', '..', 'landed'].join(path.sep)], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(through.status, 0, 'a path through a directory still runs: ' + through.stderr);
    assert.deepEqual(fs.readdirSync(path.join(sandbox, 'landed')).sort(),
      before.map(([name]) => name));
    // And one through a name that is not there yet, which is made on the way.
    const made = spawnSync('python3', ['-B', 'gen_screenshots.py',
      '--out', [sandbox, 'notyet', '..', 'arrived'].join(path.sep)], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(made.status, 0, 'a path through a name to be made runs: ' + made.stderr);
    assert.deepEqual(fs.readdirSync(path.join(sandbox, 'arrived')).sort(),
      before.map(([name]) => name));
    assert.ok(!fs.existsSync(`${elsewhere}2`), 'nor the second of two destinations');
    for (const [name, bytes] of before) {
      assert.ok(bytes.equals(fs.readFileSync(path.join(sandbox, 'docs/screenshots', name))),
        `${name} is untouched by the refused runs`);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--out lands where the path leads, not where it folds to', { skip: generatorSkip
  || (process.platform === 'win32' && 'symlinks need a privilege this does not ask for') }, () => {
  const sandbox = screenshotSandbox();
  try {
    // `link/..` is the directory the link points into, not the one the link
    // sits in — the kernel resolves it, and folding the text does not. What is
    // written and what is checked have to be the same place.
    fs.mkdirSync(path.join(sandbox, 'actual/inner'), { recursive: true });
    fs.symlinkSync('actual/inner', path.join(sandbox, 'link'));
    const run = spawnSync('python3', ['-B', 'gen_screenshots.py',
      '--out', [sandbox, 'link', '..', 'landed'].join(path.sep)], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(run.status, 0, 'it runs: ' + run.stderr);
    assert.equal(fs.readdirSync(path.join(sandbox, 'actual/landed')).length, 6,
      'the six are where the link leads');
    assert.ok(!fs.existsSync(path.join(sandbox, 'landed')),
      'and not beside the link, where the text folds to');

    // A file on the way there is the one that counts: on the folded side it is
    // not on the way at all, and the run goes past it.
    fs.writeFileSync(path.join(sandbox, 'afile'), '');
    const folded = spawnSync('python3', ['-B', 'gen_screenshots.py',
      '--out', [sandbox, 'link', '..', 'afile'].join(path.sep)], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(folded.status, 0, 'a file only where the text folds is not in the way: ' + folded.stderr);
    assert.equal(fs.readdirSync(path.join(sandbox, 'actual/afile')).length, 6);
    assert.ok(fs.statSync(path.join(sandbox, 'afile')).isFile(), 'and that file is left alone');

    // On the side the kernel walks, it is refused.
    fs.writeFileSync(path.join(sandbox, 'actual/inner-file'), '');
    const real = spawnSync('python3', ['-B', 'gen_screenshots.py',
      '--out', [sandbox, 'link', '..', 'inner-file'].join(path.sep)], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(real.status, 2, 'a file on the way there is refused: ' + real.stderr);
    assert.ok(fs.statSync(path.join(sandbox, 'actual/inner-file')).isFile());
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the destination is walked by the separators the platform accepts', () => {
  // On Windows both \\ and / separate names, and splitting on os.sep alone
  // leaves `C:/tmp/afile/child` as one name — a name nothing has, so the walk
  // finds nothing to refuse and os.makedirs is left to fail. The split is
  // asked here with Windows' own separators, which is the part of it that
  // cannot be run on this machine.
  const parts = spawnSync('python3', ['-B', '-c',
    'import importlib.util, ntpath, posixpath, sys;'
    + "spec = importlib.util.spec_from_file_location('g', 'gen_screenshots.py');"
    + 'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m);'
    + "print(m.path_parts(ntpath.splitdrive('C:/tmp/afile/child')[1], ntpath.sep, ntpath.altsep));"
    + "print(m.path_parts(ntpath.splitdrive('C:\\\\tmp\\\\afile')[1], ntpath.sep, ntpath.altsep));"
    + "print(m.path_parts('/tmp/afile/child', posixpath.sep, posixpath.altsep))"],
  { cwd: __dirname, encoding: 'utf8' });
  assert.equal(parts.status, 0, 'the split answered: ' + parts.stderr);
  assert.deepEqual(parts.stdout.trim().split('\n'), [
    "['tmp', 'afile', 'child']",
    "['tmp', 'afile']",
    "['tmp', 'afile', 'child']",
  ]);
});

test('an argument that is wrong is answered before Pillow is needed', () => {
  // -S keeps site-packages out of the path, so Pillow is not importable here
  // whatever the machine has. Reading the arguments after the import made
  // every one of these say "cannot draw here" (3) instead of "that argument is
  // wrong" (2) — and every test that would have caught it skips on that same
  // answer, so the whole of this file went quiet with it.
  const sandbox = screenshotSandbox();
  try {
    for (const args of [['--chek'], ['--out'], ['--out', '--chek'],
      ['--check', '--out', path.join(sandbox, 'elsewhere')]]) {
      const refused = spawnSync('python3', ['-S', '-B', 'gen_screenshots.py', ...args],
        { cwd: sandbox, encoding: 'utf8' });
      assert.equal(refused.status, 2,
        `${args.join(' ')} without Pillow is refused: ` + (refused.stderr || ''));
      assert.match(refused.stderr, /usage:/);
      assert.doesNotMatch(refused.stderr, /PIL/,
        `${args.join(' ')} is answered as an argument, not as a missing library`);
    }
    assert.ok(!fs.existsSync(path.join(sandbox, 'elsewhere')), 'and none of them wrote anywhere');
    assert.ok(!fs.existsSync(path.join(sandbox, '--chek')));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('an argument that is wrong is answered before the faces are needed', () => {
  // The faces resolve when the module loads, and that used to end the run: the
  // one answer for "no face here" (3) came back for a misspelled flag too.
  // Without the tools/ directory there is no face to resolve.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tcv-nofont-'));
  try {
    fs.copyFileSync(path.join(__dirname, 'gen_screenshots.py'),
      path.join(bare, 'gen_screenshots.py'));
    fs.cpSync(path.join(__dirname, 'docs/screenshots'), path.join(bare, 'docs/screenshots'),
      { recursive: true });

    const refused = spawnSync('python3', ['-B', 'gen_screenshots.py', '--chek'],
      { cwd: bare, encoding: 'utf8' });
    assert.equal(refused.status, 2, 'the argument is answered as one: ' + (refused.stderr || ''));
    assert.match(refused.stderr, /unknown argument: --chek/);

    // The positive control: with the arguments right, the missing face is what
    // there is to say, and it is said as "cannot draw here".
    const cannot = spawnSync('python3', ['-B', 'gen_screenshots.py', '--check'],
      { cwd: bare, encoding: 'utf8' });
    assert.equal(cannot.status, 3, 'and a missing face still says it cannot draw');
    assert.match(cannot.stderr, /MPLUS1p-Regular\.ttf cannot be read/);

    // With one of the two there, the one that is named is the one that is not:
    // the regular face is read first, so only the bold case tells them apart.
    fs.mkdirSync(path.join(bare, 'tools/fonts'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'tools/fonts/MPLUS1p-Regular.ttf'),
      path.join(bare, 'tools/fonts/MPLUS1p-Regular.ttf'));
    const noBold = spawnSync('python3', ['-B', 'gen_screenshots.py', '--check'],
      { cwd: bare, encoding: 'utf8' });
    assert.equal(noBold.status, 3, 'a missing bold face says it cannot draw');
    assert.match(noBold.stderr, /MPLUS1p-Bold\.ttf cannot be read/);
    assert.doesNotMatch(noBold.stderr, /MPLUS1p-Regular\.ttf/,
      'and does not name the face it could read');
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('no argument redraws the tracked directory', { skip: generatorSkip }, () => {
  const sandbox = screenshotSandbox();
  try {
    // The command CLAUDE.md documents and the one --check names when it
    // fails. Nothing else here runs the default destination.
    const target = path.join(sandbox, 'docs/screenshots/popup_ja.png');
    const marked = spawnSync('python3', ['-B', '-c',
      'import sys; from PIL import Image;' +
      'i = Image.open(sys.argv[1]).convert("RGB");' +
      'r, g, b = i.getpixel((320, 200));' +
      'i.putpixel((320, 200), (r ^ 1, g, b));' +
      'i.save(sys.argv[1])', target], { encoding: 'utf8' });
    assert.equal(marked.status, 0, 'the probe marked one pixel');
    assert.equal(runCheck(sandbox).status, 1, 'which --check turns down');

    const run = spawnSync('python3', ['-B', 'gen_screenshots.py'],
      { cwd: sandbox, encoding: 'utf8' });
    assert.equal(run.status, 0, (run.stderr || '') + (run.stdout || ''));
    assert.equal(runCheck(sandbox).status, 0, 'and the redraw puts the pixel back');
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
  assert.match(source, /def main\(out_dir=OUT_DIR, named=False\):\n    verify_icons\(\)/);
  // --check draws the same six, so it runs the same self-check before it
  // draws — wherever in the function that lands.
  const checkBody = source.slice(source.indexOf('def check():'));
  assert.ok(checkBody.indexOf('verify_icons()') > -1
    && checkBody.indexOf('verify_icons()') < checkBody.indexOf('draw_all('),
  '--check runs the self-check before it draws');
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

test('page bridge leaves an element whose media another origin serves', async () => {
  const harness = createPageBridgeHarness();
  const video = harness.currentVideo();
  // A Twitch clip plays a file from a CDN, and the element asks for it without
  // CORS. A source node made for it would output silence, and the element's
  // audio would not go back to the player.
  video.srcObject = null;
  video.src = 'https://clips.example/clip.mp4';
  video.currentSrc = video.src;
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  assert.equal(harness.mediaSourceCalls(), 0);
  const failures = harness.messages.filter((message) => message.event === 'attach-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].cause, 'cross-origin');
  // One report per element, not one per retry.
  await harness.runTimers();
  assert.equal(harness.messages.filter((message) => message.event === 'attach-failed').length, 1);
  assert.equal(harness.mediaSourceCalls(), 0);
});

test('page bridge still reports an element the ad path looked at first', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  const player = harness.currentVideo();

  // The measured element pauses and an ad plays in an element whose media
  // another origin serves. The ad path says nothing about it.
  harness.setPaused(true);
  const adVideo = harness.addVideo({
    volume: 1, crossOrigin: null, srcObject: null,
    src: 'https://ads.example/creative.mp4', currentSrc: 'https://ads.example/creative.mp4'
  });
  await harness.dispatchCommand('setAdActive', { active: true });
  assert.equal(harness.sourcedElements.includes(adVideo), false);
  assert.deepEqual(harness.messages.filter((message) => message.event === 'attach-failed'), []);

  // The player's own element leaves and the attach loop is left with that one.
  // The report the ad path did not make is still the player path's to make.
  harness.removeVideo(player);
  await harness.runTimers();
  const failures = harness.messages.filter((message) => message.event === 'attach-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].cause, 'cross-origin');
});

test('page bridge reports the element it passed over when the others carry nothing', async () => {
  const harness = createPageBridgeHarness();
  // The element the page opens with has loaded nothing yet, and it comes first
  // in the document.
  Object.assign(harness.currentVideo(), {
    src: '', currentSrc: '', srcObject: null, readyState: 0
  });
  harness.addVideo({
    crossOrigin: null, srcObject: null,
    src: 'https://clips.example/clip.mp4', currentSrc: 'https://clips.example/clip.mp4'
  });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  assert.equal(harness.mediaSourceCalls(), 0);
  const failures = harness.messages.filter((message) => message.event === 'attach-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].cause, 'cross-origin');
});

test('page bridge takes a reachable element beside one it cannot reach', async () => {
  const harness = createPageBridgeHarness();
  // The larger element is the one whose media another origin serves, so the
  // area alone would choose it and the player would go without any gain.
  const unreachable = harness.currentVideo();
  unreachable.srcObject = null;
  unreachable.src = 'https://clips.example/clip.mp4';
  unreachable.currentSrc = unreachable.src;
  const reachable = harness.addVideo({
    src: '', currentSrc: '', srcObject: {}, crossOrigin: null,
    clientWidth: 640, clientHeight: 360
  });
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  assert.equal(harness.mediaSourceCalls(), 1);
  assert.deepEqual(harness.sourcedElements, [reachable]);
  assert.equal(harness.sourcedElements.includes(unreachable), false);
  assert.deepEqual(harness.messages.filter((message) => message.event === 'attach-failed'), []);
});

test('page bridge reads what an element can carry from the media it loaded', async () => {
  // [what the element carries, whether the bridge takes it]
  const shapes = [
    [{ srcObject: {}, src: '', currentSrc: '' }, true],
    [{ srcObject: null, src: 'blob:https://www.twitch.tv/9e1c', currentSrc: 'blob:https://www.twitch.tv/9e1c' }, true],
    [{ srcObject: null, src: '/media/clip.mp4', currentSrc: '/media/clip.mp4' }, true],
    [{ srcObject: null, src: 'https://clips.example/c.mp4', currentSrc: 'https://clips.example/c.mp4', crossOrigin: 'anonymous' }, true],
    [{ srcObject: {}, src: 'https://clips.example/c.mp4', currentSrc: 'https://clips.example/c.mp4' }, true],
    [{ srcObject: null, src: '//cdn.example/c.mp4', currentSrc: '//cdn.example/c.mp4' }, false],
    [{ srcObject: null, src: 'https://clips.example/c.mp4', currentSrc: 'https://clips.example/c.mp4' }, false],
    // currentSrc is the resource the element actually loaded.
    [{ srcObject: null, src: '/media/clip.mp4', currentSrc: 'https://clips.example/c.mp4' }, false],
    // A src the URL parser refuses is not one the audio can be carried from.
    [{ srcObject: null, src: 'http://', currentSrc: 'http://' }, false]
  ];
  for (const [shape, taken] of shapes) {
    const harness = createPageBridgeHarness();
    Object.assign(harness.currentVideo(), { crossOrigin: null, ...shape });
    await harness.dispatchCommand('init');
    await harness.dispatchCommand('attach');
    const where = JSON.stringify(shape);
    assert.equal(harness.mediaSourceCalls(), taken ? 1 : 0, where);
    assert.equal(
      harness.messages.some((message) => message.event === 'attach-failed'),
      !taken,
      where
    );
  }
});

test('page bridge builds no audio context for an element it will not take', async () => {
  const harness = createPageBridgeHarness();
  const video = harness.currentVideo();
  video.srcObject = null;
  video.src = 'https://clips.example/clip.mp4';
  video.currentSrc = video.src;
  // No init: the attach loop is the only thing that could build a context here.
  await harness.dispatchCommand('attach');

  assert.deepEqual(harness.messages.filter((message) => message.event === 'audio-context'), []);
  assert.equal(harness.mediaSourceCalls(), 0);
});

test('page bridge lets go of an element that changed origin while the context built', async () => {
  const harness = createPageBridgeHarness({ deferWorkletLoad: true });
  const video = harness.currentVideo();
  const init = harness.dispatchCommand('init');
  const attach = harness.dispatchCommand('attach');
  await flushTasks(4);

  // The player loads a clip into the same element while the worklet module is
  // still loading, and the element it was going to take is no longer one it can.
  video.srcObject = null;
  video.src = 'https://clips.example/clip.mp4';
  video.currentSrc = video.src;
  await harness.releaseWorkletLoad();
  await Promise.all([init, attach]);

  assert.equal(harness.mediaSourceCalls(), 0);
  assert.equal(
    harness.messages.filter((message) => message.event === 'attach-failed')[0]?.cause,
    'cross-origin'
  );
});

test('page bridge takes the element once its media is one it can reach', async () => {
  const harness = createPageBridgeHarness();
  const video = harness.currentVideo();
  video.srcObject = null;
  video.src = 'https://clips.example/clip.mp4';
  video.currentSrc = video.src;
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');
  assert.equal(harness.mediaSourceCalls(), 0);

  // The same element goes back to the player's own MediaSource.
  video.src = '';
  video.currentSrc = '';
  video.srcObject = {};
  await harness.runTimers();

  assert.equal(harness.mediaSourceCalls(), 1);
  assert.equal(harness.messages.filter((message) => message.event === 'attached').length, 1);
});

test('page bridge takes a cross-origin element the page asked for in CORS mode', async () => {
  const harness = createPageBridgeHarness();
  const video = harness.currentVideo();
  video.srcObject = null;
  video.src = 'https://ads.example/creative.mp4';
  video.currentSrc = video.src;
  video.crossOrigin = 'anonymous';
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  assert.equal(harness.mediaSourceCalls(), 1);
  assert.deepEqual(harness.messages.filter((message) => message.event === 'attach-failed'), []);
});

test('page bridge takes an element served from the page origin', async () => {
  const harness = createPageBridgeHarness();
  const video = harness.currentVideo();
  video.srcObject = null;
  video.src = 'https://www.twitch.tv/media/clip.mp4';
  video.currentSrc = video.src;
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  assert.equal(harness.mediaSourceCalls(), 1);
  assert.deepEqual(harness.messages.filter((message) => message.event === 'attach-failed'), []);
});

test('page bridge waits for an element that has loaded nothing yet', async () => {
  const harness = createPageBridgeHarness();
  const video = harness.currentVideo();
  video.srcObject = null;
  video.src = '';
  video.currentSrc = '';
  await harness.dispatchCommand('init');
  await harness.dispatchCommand('attach');

  // Nothing is wrong yet: the element has not been told what to play.
  assert.equal(harness.mediaSourceCalls(), 0);
  assert.deepEqual(harness.messages.filter((message) => message.event === 'attach-failed'), []);

  video.srcObject = {};
  await harness.runTimers();
  assert.equal(harness.mediaSourceCalls(), 1);
});

test('page bridge does not take an ad element whose media another origin serves', async () => {
  const harness = createPageBridgeHarness();
  await harness.startMeasurement();
  harness.setPaused(true);
  const adVideo = harness.addVideo({ volume: 1, crossOrigin: null });
  await harness.dispatchCommand('setAdActive', { active: true });

  assert.equal(harness.sourcedElements.includes(adVideo), false);
  // The player's own element is still measured, and the popup is not told the
  // player audio is out of reach.
  assert.deepEqual(harness.messages.filter((message) => message.event === 'attach-failed'), []);
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
