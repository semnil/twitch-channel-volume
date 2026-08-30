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
# Chrome substitutes __MSG_name__ from the default locale's catalog, in the
# manifest and in every packaged stylesheet. Its own predefined messages carry
# an @@ prefix and need no catalog.
MESSAGE_PLACEHOLDER = re.compile(r'__MSG_([A-Za-z0-9_@]+)__')
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


def _placeholders(text):
    """The message names a text asks the default locale to answer for."""
    return {name for name in MESSAGE_PLACEHOLDER.findall(text)
            if not name.startswith('@@')}


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

    carried = set()

    def carry(full, relative):
        """A name reachable more than one way enters the archive once.

        zipfile writes a second entry under the same name and warns on stderr,
        which the release path does not read.
        """
        if relative in carried:
            return None
        carried.add(relative)
        return full, relative

    for relative in sorted(selected):
        entry = carry(_packaged(root, relative), relative)
        if entry:
            yield entry

    # What the extension asks the default locale to answer for. Chrome reads
    # these in the manifest and in the stylesheets it serves.
    wanted = _placeholders(_read(root, 'manifest.json'))
    for relative in selected:
        if relative.endswith('.css'):
            wanted |= _placeholders(_read(root, relative))

    # Chrome requires these to agree. An extension carrying a _locales directory
    # has to name a default_locale; one asking for a message has to name it too;
    # and the locale it names has to be one directory under _locales and hold a
    # catalog that answers. Any of them alone is an extension Chrome declines to
    # load. A default_locale named with no _locales at all is refused by the
    # catalog check below rather than here.
    named = 'default_locale' in manifest
    default_locale = manifest.get('default_locale')
    if named and not (isinstance(default_locale, str) and default_locale):
        raise SystemExit(f'default_locale is not a locale name: {default_locale!r}')
    if named and (default_locale in ('.', '..') or '/' in default_locale
                  or ntpath.splitdrive(default_locale)[0]
                  or posixpath.normpath(default_locale) != default_locale):
        raise SystemExit(f'default_locale is not one name under {LOCALE_DIR}: '
                         f'{default_locale!r}')
    locales = _host(root, LOCALE_DIR)
    if os.path.isdir(locales) and not named:
        raise SystemExit(f'{LOCALE_DIR} is here and the manifest names no default_locale')
    if wanted and not named:
        raise SystemExit(f'the extension asks for {sorted(wanted)[0]} and names no '
                         f'default_locale')
    required = (posixpath.join(LOCALE_DIR, default_locale, LOCALE_FILE)
                if named else None)
    seen_locales = set()
    catalogs = {}
    if os.path.isdir(locales):
        for locale in sorted(os.listdir(locales)):
            relative = posixpath.join(LOCALE_DIR, locale, LOCALE_FILE)
            full = _packaged(root, relative)
            if os.path.isfile(full):
                # A catalog Chrome cannot read is one it refuses the whole
                # extension over, so it is read here rather than copied.
                try:
                    catalogs[locale] = json.loads(_read(root, relative))
                except ValueError as unreadable:
                    raise SystemExit(f'{relative} is not a message catalog: {unreadable}')
                seen_locales.add(relative)
                entry = carry(full, relative)
                if entry:
                    yield entry
    if required and required not in seen_locales:
        raise SystemExit(f'the default locale carries no messages: {required}')
    if wanted:
        # Message names are matched without regard to case, as Chrome matches them.
        answered = {name.lower() for name in catalogs.get(default_locale, {})}
        unanswered = sorted(name for name in wanted if name.lower() not in answered)
        if unanswered:
            raise SystemExit(f'{required} does not answer for: {", ".join(unanswered)}')

    for relative in DISTRIBUTION_FILES:
        full = _packaged(root, relative)
        if not os.path.isfile(full):
            raise SystemExit(f'the package has to carry this and it is missing: {relative}')
        entry = carry(full, relative)
        if entry:
            yield entry


def pack():
    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, 'manifest.json')) as f:
        version = json.load(f)['version']
    # Every name is resolved before anything is written. A refusal partway
    # through would otherwise leave a half-built package where the last one was.
    files = list(selected_files(root))
    out = f'twitch-channel-volume-{version}.zip'
    out_path = os.path.join(root, out)
    # Built beside the target and moved onto it. Resolving the names first
    # answers for a file that is missing, and reading one can still fail — a
    # write straight into the target would delete the package built last and
    # leave a shorter one that opens cleanly in its place.
    staging = out_path + '.part'
    try:
        with zipfile.ZipFile(staging, 'w', zipfile.ZIP_DEFLATED) as zf:
            for full, arcname in files:
                zf.write(full, arcname)
                print(f'  + {arcname}')
        os.replace(staging, out_path)
    except BaseException:
        if os.path.exists(staging):
            os.remove(staging)
        raise
    print(f'\n=> {out}')


def list_files():
    root = os.path.dirname(os.path.abspath(__file__))
    for _full, arcname in list(selected_files(root)):
        print(arcname)


if __name__ == '__main__':
    arguments = sys.argv[1:]
    if arguments == ['--list']:
        list_files()
    elif arguments:
        raise SystemExit(f'usage: pack.py [--list] (got: {" ".join(arguments)})')
    else:
        pack()
