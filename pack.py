"""Pack extension for Chrome Web Store submission."""
import zipfile
import ntpath
import os
import json
import posixpath
import re
import sys
from html.parser import HTMLParser

# The package is what the extension loads: the manifest, everything the
# manifest names, what those pages and workers pull in, and the locale files.
# A file nobody references is not part of it, whatever it is called.
# Everything below names a packaged file by its path inside the package, which
# is POSIX whatever the host writes: the manifest spells its references with
# forward slashes and a zip entry carries them, so the two are one name and
# only opening a file goes through the host's own separator.
LOCALE_DIR = '_locales'
LOCALE_FILE = 'messages.json'
# What a copy of the extension carries although nothing in it loads them. The
# MIT text requires the notice to travel with the copies it covers, and a store
# package is one, so the reference walk below never reaching it is not an answer.
DISTRIBUTION_FILES = ('LICENSE',)
IMPORT_SCRIPTS = re.compile(r'importScripts\(([^)]*)\)')
QUOTED = re.compile(r'[\'"]([^\'"]+)[\'"]')
REMOTE = ('http:', 'https:', '//', 'data:', 'chrome-extension:')


def _host(root, relative):
    """The host path of a packaged file named by its path inside the package."""
    return os.path.join(root, *relative.split('/'))


class _PageReferences(HTMLParser):
    """The scripts and stylesheets a page pulls in.

    The markup is parsed rather than matched. A quoting style, an attribute
    order or a letter case a pattern did not anticipate is a file that leaves
    the package with nothing saying so, and a reference inside a comment is one
    that enters it although the browser never asks for it.
    """

    def __init__(self):
        super().__init__()
        self.found = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'script':
            source = attributes.get('src')
            if source:
                self.found.append(source)
        elif tag == 'link':
            href = attributes.get('href')
            rel = (attributes.get('rel') or '').lower().split()
            if href and ('stylesheet' in rel or href.endswith('.css')):
                self.found.append(href)


def _page_references(text):
    parser = _PageReferences()
    parser.feed(text)
    parser.close()
    return parser.found


def _resolve(root, relative):
    """Absolute host path of a packaged file, or None when it leaves the package.

    The path is rejected when it is absolute, carries a backslash or a drive
    letter, climbs out with .., or reaches its target through a symbolic link at
    any point — the final name or a parent directory alike. A drive letter reads
    as relative to posixpath and resolves against the same drive on Windows, so
    "C:/content.js" would package the file "content.js" names, under a path
    Chrome does not accept.
    """
    if '\\' in relative or posixpath.isabs(relative) or ntpath.splitdrive(relative)[0]:
        return None
    normalized = posixpath.normpath(relative)
    real_root = os.path.realpath(root)
    full = _host(real_root, normalized)
    if os.path.realpath(full) != full:
        return None
    return full


def _packaged(root, relative):
    full = _resolve(root, relative)
    if full is None:
        raise SystemExit(f'reference leaves the package: {relative}')
    return full


def _read(root, relative):
    with open(_host(root, relative), encoding='utf-8') as handle:
        return handle.read()


def _manifest_references(manifest):
    for entry in manifest.get('content_scripts', []):
        yield from entry.get('js', [])
        yield from entry.get('css', [])
    for entry in manifest.get('web_accessible_resources', []):
        yield from entry.get('resources', [])
    worker = manifest.get('background', {}).get('service_worker')
    if worker:
        yield worker
    for key in ('options_page',):
        if manifest.get(key):
            yield manifest[key]
    if manifest.get('options_ui', {}).get('page'):
        yield manifest['options_ui']['page']
    if manifest.get('action', {}).get('default_popup'):
        yield manifest['action']['default_popup']
    yield from manifest.get('icons', {}).values()
    yield from manifest.get('action', {}).get('default_icon', {}).values()


def _references_within(root, relative):
    """Paths the given page or script pulls in, relative to the package root."""
    base = posixpath.dirname(relative)
    found = []
    if relative.endswith('.html'):
        found.extend(_page_references(_read(root, relative)))
    elif relative.endswith('.js'):
        for call in IMPORT_SCRIPTS.findall(_read(root, relative)):
            found.extend(QUOTED.findall(call))
    for reference in found:
        if reference.startswith(REMOTE):
            continue
        yield posixpath.normpath(posixpath.join(base, reference))


def selected_files(root):
    """Yield (path, arcname) for every file the package carries."""
    manifest = json.loads(_read(root, 'manifest.json'))
    pending = ['manifest.json']
    pending.extend(_manifest_references(manifest))
    selected = []
    while pending:
        relative = posixpath.normpath(pending.pop(0))
        if relative in selected:
            continue
        full = _packaged(root, relative)
        if not os.path.isfile(full):
            raise SystemExit(f'referenced file is missing or not a regular file: {relative}')
        selected.append(relative)
        pending.extend(_references_within(root, relative))

    for relative in sorted(selected):
        yield _packaged(root, relative), relative

    # Chrome resolves every __MSG_ placeholder against the default locale and
    # declines to load an extension whose default locale holds no messages, so
    # that one file is required rather than carried when it happens to be there.
    default_locale = manifest.get('default_locale')
    locales = _host(root, LOCALE_DIR)
    required = (posixpath.join(LOCALE_DIR, default_locale, LOCALE_FILE)
                if default_locale else None)
    carried = set()
    if os.path.isdir(locales):
        for locale in sorted(os.listdir(locales)):
            relative = posixpath.join(LOCALE_DIR, locale, LOCALE_FILE)
            full = _packaged(root, relative)
            if os.path.isfile(full):
                carried.add(relative)
                yield full, relative
    if required and required not in carried:
        raise SystemExit(f'the default locale carries no messages: {required}')

    for relative in DISTRIBUTION_FILES:
        full = _packaged(root, relative)
        if not os.path.isfile(full):
            raise SystemExit(f'the package has to carry this and it is missing: {relative}')
        yield full, relative


def pack():
    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, 'manifest.json')) as f:
        version = json.load(f)['version']
    # Every name is resolved before anything is written. A refusal partway
    # through would otherwise leave a half-built package where the last one was.
    files = list(selected_files(root))
    out = f'twitch-channel-volume-{version}.zip'
    out_path = os.path.join(root, out)
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for full, arcname in files:
            zf.write(full, arcname)
            print(f'  + {arcname}')
    print(f'\n=> {out}')


def list_files():
    root = os.path.dirname(os.path.abspath(__file__))
    for _full, arcname in list(selected_files(root)):
        print(arcname)


if __name__ == '__main__':
    if '--list' in sys.argv:
        list_files()
    else:
        pack()
