"""Pack extension for Chrome Web Store submission."""
import zipfile
import os
import json
import sys

# The package is an allowlist: the manifest, the scripts and pages the
# extension loads, the icons and the locale files. Anything else in the tree —
# notes, dotfiles, scratch directories, symlinks — is not part of it.
ROOT_FILES = {'manifest.json'}
ROOT_SUFFIXES = ('.js', '.html')
EXCLUDE_FILES = {'test.js'}
ICON_DIR = 'icons'
ICON_SUFFIX = '.png'
LOCALE_DIR = '_locales'
LOCALE_FILE = 'messages.json'


def _files_in(directory):
    if not os.path.isdir(directory) or os.path.islink(directory):
        return []
    names = []
    for name in sorted(os.listdir(directory)):
        full = os.path.join(directory, name)
        if os.path.isfile(full) and not os.path.islink(full):
            names.append(name)
    return names


def selected_files(root):
    """Yield (path, arcname) for every file the package carries."""
    for name in _files_in(root):
        if name in EXCLUDE_FILES:
            continue
        if name in ROOT_FILES or name.endswith(ROOT_SUFFIXES):
            yield os.path.join(root, name), name

    icons = os.path.join(root, ICON_DIR)
    for name in _files_in(icons):
        if name.endswith(ICON_SUFFIX):
            yield os.path.join(icons, name), os.path.join(ICON_DIR, name)

    locales = os.path.join(root, LOCALE_DIR)
    if os.path.isdir(locales) and not os.path.islink(locales):
        for locale in sorted(os.listdir(locales)):
            if LOCALE_FILE in _files_in(os.path.join(locales, locale)):
                yield (
                    os.path.join(locales, locale, LOCALE_FILE),
                    os.path.join(LOCALE_DIR, locale, LOCALE_FILE)
                )


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
