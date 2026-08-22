"""Pack extension for Chrome Web Store submission."""
import zipfile
import os
import json
import re
import sys

# The package is what the extension loads: the manifest, everything the
# manifest names, what those pages and workers pull in, and the locale files.
# A file nobody references is not part of it, whatever it is called.
LOCALE_DIR = '_locales'
LOCALE_FILE = 'messages.json'
SCRIPT_SRC = re.compile(r'<script[^>]+src="([^"]+)"')
STYLE_HREF = re.compile(r'<link[^>]+href="([^"]+)"')
IMPORT_SCRIPTS = re.compile(r'importScripts\(([^)]*)\)')
QUOTED = re.compile(r'[\'"]([^\'"]+)[\'"]')
REMOTE = ('http:', 'https:', '//', 'data:', 'chrome-extension:')


def _read(root, relative):
    with open(os.path.join(root, relative), encoding='utf-8') as handle:
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
    base = os.path.dirname(relative)
    found = []
    if relative.endswith('.html'):
        text = _read(root, relative)
        found.extend(SCRIPT_SRC.findall(text))
        found.extend(href for href in STYLE_HREF.findall(text) if href.endswith('.css'))
    elif relative.endswith('.js'):
        for call in IMPORT_SCRIPTS.findall(_read(root, relative)):
            found.extend(QUOTED.findall(call))
    for reference in found:
        if reference.startswith(REMOTE):
            continue
        yield os.path.normpath(os.path.join(base, reference))


def selected_files(root):
    """Yield (path, arcname) for every file the package carries."""
    pending = ['manifest.json']
    pending.extend(_manifest_references(json.loads(_read(root, 'manifest.json'))))
    selected = []
    while pending:
        relative = os.path.normpath(pending.pop(0))
        if relative in selected:
            continue
        full = os.path.join(root, relative)
        if os.path.islink(full) or not os.path.isfile(full):
            raise SystemExit(f'referenced file is missing or not a regular file: {relative}')
        selected.append(relative)
        pending.extend(_references_within(root, relative))

    for relative in sorted(selected):
        yield os.path.join(root, relative), relative

    locales = os.path.join(root, LOCALE_DIR)
    if os.path.isdir(locales) and not os.path.islink(locales):
        for locale in sorted(os.listdir(locales)):
            relative = os.path.join(LOCALE_DIR, locale, LOCALE_FILE)
            full = os.path.join(root, relative)
            if os.path.islink(full):
                raise SystemExit(f'referenced file is missing or not a regular file: {relative}')
            if os.path.isfile(full):
                yield full, relative


def pack():
    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, 'manifest.json')) as f:
        version = json.load(f)['version']
    out = f'twitch-channel-volume-{version}.zip'
    out_path = os.path.join(root, out)
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for full, arcname in selected_files(root):
            zf.write(full, arcname)
            print(f'  + {arcname}')
    print(f'\n=> {out}')


def list_files():
    root = os.path.dirname(os.path.abspath(__file__))
    for _full, arcname in selected_files(root):
        print(arcname)


if __name__ == '__main__':
    if '--list' in sys.argv:
        list_files()
    else:
        pack()
