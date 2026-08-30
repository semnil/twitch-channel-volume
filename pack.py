"""Pack extension for Chrome Web Store submission."""
import zipfile
import math
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
# Chromium's IsValidName: a message name and a placeholder name alike carry
# ASCII letters, digits, _ and @, and nothing else.
NAME = re.compile(r'^[A-Za-z0-9_@]+$')
# The messages Chrome supplies. It refuses a catalog that answers for one of the
# reserved five, and it has not got the extension id yet when it localizes the
# manifest — so that one is the catalog's to answer for, and the only one the
# manifest cannot reach without it.
PREDEFINED_MESSAGES = frozenset({
    '@@extension_id', '@@ui_locale', '@@bidi_dir', '@@bidi_reversed_dir',
    '@@bidi_start_edge', '@@bidi_end_edge',
})
RESERVED_IN_A_CATALOG = PREDEFINED_MESSAGES - {'@@extension_id'}
NOT_SUPPLIED_TO_THE_MANIFEST = frozenset({'@@extension_id'})
# The locale names the Chrome Web Store carries. An extension is localized to
# one of these, and where the locale its author wants is not among them the
# closest one that is stands in for it. What the browser loads is a wider set
# than what the store takes, so this is the one a package is held to.
CHROME_WEB_STORE_LOCALES = frozenset('''
    am ar bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu
    he hi hr hu id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr
    sv sw ta te th tr uk vi zh_CN zh_TW
'''.split())
# Where Chrome substitutes a message into the manifest. Everywhere else the
# string reaches the browser as it stands — a content script named
# __MSG_asset__.js is loaded under that name — so a reference outside these is
# not a reference. A step of '*' is every key of an object and '[]' every
# element of a list.
LOCALIZED_FIELDS = (
    ('name',),
    ('description',),
    ('short_name',),
    ('action', 'default_title'),
    ('browser_action', 'default_title'),
    ('page_action', 'default_title'),
    ('omnibox', 'keyword'),
    ('commands', '*', 'description'),
    ('chrome_settings_overrides', 'search_provider', 'name'),
    ('chrome_settings_overrides', 'search_provider', 'keyword'),
    ('file_browser_handlers', '[]', 'default_title'),
    ('input_components', '[]', 'name'),
)
QUOTED = re.compile(r'[\'"]([^\'"]+)[\'"]')
REMOTE = ('http:', 'https:', '//', 'data:', 'chrome-extension:')
# Where the manifest names a file inside the package, and what that file is: a
# page is read for what it pulls in, a script for what it imports, a stylesheet
# for what it reaches, and an asset is carried as it stands. A resource exposed
# to the page can be any of them and the key does not say, so the name decides.
# A step of '*' is every key of an object and '[]' every element of a list.
MANIFEST_REFERENCES = (
    (('content_scripts', '[]', 'js', '[]'), 'script'),
    (('content_scripts', '[]', 'css', '[]'), 'style'),
    (('background', 'service_worker'), 'script'),
    (('action', 'default_popup'), 'page'),
    (('options_page',), 'page'),
    (('options_ui', 'page'), 'page'),
    (('devtools_page',), 'page'),
    (('side_panel', 'default_path'), 'page'),
    (('chrome_url_overrides', '*'), 'page'),
    (('sandbox', 'pages', '[]'), 'page'),
    (('action', 'default_icon', '*'), 'asset'),
    (('icons', '*'), 'asset'),
    (('storage', 'managed_schema'), 'asset'),
    (('declarative_net_request', 'rule_resources', '[]', 'path'), 'asset'),
    (('web_accessible_resources', '[]', 'resources', '[]'), 'named'),
)
# What a name says a file is, where the key does not say.
BY_NAME = (('.html', 'page'), ('.js', 'script'), ('.css', 'style'))
# A resource entry carrying one of these is a pattern Chrome matches against
# the extension's own files rather than a name it opens. What it matches has to
# be in the package, so it is matched against the tree here, with '*' standing
# for any run of characters and '/' among them: a file carried that nothing
# asks for costs room, and one left out is a resource the page cannot load.
PATTERN = re.compile(r'[*?]')
CSS_COMMENT = re.compile(r'/\*.*?\*/', re.S)
CSS_IMPORT = re.compile(r'@import\s+(?:url\(\s*)?(["\']?)([^"\')\s;]+)\1')
CSS_URL = re.compile(r'url\(\s*(["\']?)([^"\')]+?)\1\s*\)')


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
                self.found.append((source, 'script'))
        elif tag == 'link':
            href = attributes.get('href')
            rel = (attributes.get('rel') or '').lower().split()
            if href and ('stylesheet' in rel or href.endswith('.css')):
                self.found.append((href, 'style'))


def _messages_used(text, begin, end, known=None):
    """Walk a text for references the way Chromium's ReplaceVariables walks it.

    It scans for the opening delimiter, takes what runs to the next closing one
    as a candidate, and passes over anything that is not a name — so two
    references share a delimiter (`$A$$B$` is A then B) and a doubled delimiter
    opens an empty candidate rather than escaping anything (`$$NAME$$` asks for
    NAME). Returns the names it took and the first one `known` does not answer;
    with no map it answers everything, which is how the names a text asks for
    are counted.
    """
    used, index = [], 0
    while True:
        found = text.find(begin, index)
        if found < 0:
            return used, None
        index = found + len(begin)
        if index >= len(text):
            return used, None
        stop = text.find(end, index)
        if stop < 0:
            return used, None
        name = text[index:stop]
        if not NAME.fullmatch(name):
            continue
        used.append(name)
        if known is not None and name.lower() not in known:
            return used, name
        index = stop + len(end)


def _catalog(relative, text):
    """The names a catalog answers for, or a refusal saying why it answers none.

    Only what Chromium refuses is refused here: it reads `message` and
    `placeholders` and passes over `description` and `example`, and it lowercases
    a key on the way in rather than objecting to two that differ only in case.
    """
    def refuse(complaint):
        raise SystemExit(f'{relative} {complaint}')

    loaded = _json(relative, text)
    if not isinstance(loaded, dict):
        refuse(f'is not a message catalog: the top level is a '
               f'{type(loaded).__name__}, not an object')
    answered = set()
    for name, entry in loaded.items():
        if not NAME.fullmatch(name):
            refuse(f'names a message Chrome cannot read: {name!r}')
        if name.lower() in RESERVED_IN_A_CATALOG:
            refuse(f'answers for {name}, which Chrome reserves')
        answered.add(name.lower())
        if not isinstance(entry, dict):
            refuse(f'gives {name} a {type(entry).__name__}, not an object')
        if not isinstance(entry.get('message'), str):
            refuse(f'gives {name} no message element')
        # A key written as null is a key the author wrote, not one left out.
        placeholders = entry['placeholders'] if 'placeholders' in entry else {}
        if not isinstance(placeholders, dict):
            refuse(f'gives {name} placeholders that are not an object')
        for holder, shape in placeholders.items():
            if not NAME.fullmatch(holder):
                refuse(f'names a placeholder Chrome cannot read: {name}.{holder}')
            if not isinstance(shape, dict) or not isinstance(shape.get('content'), str):
                refuse(f'gives {name}.{holder} no content')
        _used, missing = _messages_used(
            entry['message'], '$', '$', {holder.lower() for holder in placeholders})
        if missing:
            refuse(f'gives {name} no placeholder named {missing}')
    return answered


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


def _without_comments(text):
    """The text with its comments taken out and its string literals left alone.

    Chrome reads a manifest and a catalog with a parser that allows // and
    /* */. Taking them out by pattern would take the // out of a URL and the /*
    out of a message, so the string states are walked instead.
    """
    out, index, length = [], 0, len(text)
    while index < length:
        character = text[index]
        if character == '"':
            start = index
            index += 1
            while index < length:
                if text[index] == '\\':
                    index += 2
                    continue
                if text[index] == '"':
                    index += 1
                    break
                index += 1
            out.append(text[start:index])
            continue
        if character == '/' and index + 1 < length:
            if text[index + 1] == '/':
                stop = text.find('\n', index)
                index = length if stop < 0 else stop
                continue
            if text[index + 1] == '*':
                stop = text.find('*/', index + 2)
                if stop < 0:
                    raise ValueError('a block comment is never closed')
                index = stop + 2
                out.append(' ')
                continue
        out.append(character)
        index += 1
    return ''.join(out)


def _at(value, path):
    """Every string the given path reaches, which is none where it does not lead."""
    if not path:
        if isinstance(value, str):
            yield value
        return
    step, rest = path[0], path[1:]
    if step == '*':
        if isinstance(value, dict):
            for held in value.values():
                yield from _at(held, rest)
    elif step == '[]':
        if isinstance(value, list):
            for held in value:
                yield from _at(held, rest)
    elif isinstance(value, dict) and step in value:
        yield from _at(value[step], rest)


def _localized_values(manifest):
    """What the manifest asks the catalog for, read as the values it decoded to.

    The decoded manifest is what Chrome localizes: the raw text still carries
    the comments it dropped and the escapes it resolved.
    """
    for path in LOCALIZED_FIELDS:
        yield from _at(manifest, path)


def _number(literal):
    """Chrome reads a JSON number as a double and refuses one that will not fit."""
    number = float(literal)
    if not math.isfinite(number):
        raise ValueError(f'{literal} is out of the range a number holds')
    return number


def _integer(literal):
    _number(literal)
    return int(literal)


def _not_a_value(literal):
    """NaN and the infinities are Python's spelling of a number, not JSON's."""
    raise ValueError(f'{literal} is not a JSON value')


def _json(relative, text):
    """Read JSON the way Chrome reads it: a byte order mark and comments allowed."""
    try:
        return json.loads(_without_comments(text.lstrip('\ufeff')),
                          parse_constant=_not_a_value, parse_float=_number,
                          parse_int=_integer)
    except ValueError as unreadable:
        raise SystemExit(f'{relative} is not readable as JSON: {unreadable}')


def _chrome_reads_the_version(version):
    """Chrome reads a version as one to four numbers, each below 2**32, the
    first of them written without a leading zero. What a prerelease shows
    instead goes in version_name, which Chrome reads as any text at all."""
    if not isinstance(version, str):
        return False
    parts = version.split('.')
    return (len(parts) <= 4
            and all(part.isascii() and part.isdigit() and int(part) < 2 ** 32
                    for part in parts)
            and parts[0] == str(int(parts[0])))


def _read(root, relative):
    with open(_host(root, relative), encoding='utf-8') as handle:
        return handle.read()


def _matching(root, pattern):
    """Every file under the package root that a resource pattern names."""
    shape = re.compile(''.join(
        '.*' if part == '*' else '.' if part == '?' else re.escape(part)
        for part in re.split(r'([*?])', pattern)))
    found = []
    for base, directories, files in os.walk(root):
        # A name beginning with a dot is one Chrome's own packer leaves out.
        directories[:] = sorted(name for name in directories
                                if not name.startswith('.'))
        held = os.path.relpath(base, root)
        prefix = '' if held == os.curdir else held.replace(os.sep, '/') + '/'
        for name in sorted(files):
            if name.startswith('.'):
                continue
            relative = prefix + name
            if shape.fullmatch(relative):
                found.append(relative)
    return found


def _by_name(value):
    return next((named for suffix, named in BY_NAME
                 if value.endswith(suffix)), 'asset')


def _manifest_references(root, manifest):
    """Every file the manifest names, with what the key says it is.

    A resource is written from the extension's root, and that root may be
    written as a leading slash: '/images/*' names what 'images/*' names, and a
    resource that is nothing but slashes names nothing. It is the one key where
    a leading slash is not an absolute path.
    """
    for path, kind in MANIFEST_REFERENCES:
        for value in _at(manifest, path):
            if kind != 'named':
                yield value, kind
                continue
            named = value.lstrip('/')
            if not named:
                continue
            if PATTERN.search(named):
                for held in _matching(root, named):
                    yield held, _by_name(held)
            else:
                yield named, _by_name(named)


def _style_references(text):
    """What a stylesheet pulls in: what it imports and what url() names.

    A target Chrome substitutes a message into names no file here, and one
    that is a fragment of the sheet itself names none either.
    """
    body = CSS_COMMENT.sub(' ', text)
    for pattern, kind in ((CSS_IMPORT, 'style'), (CSS_URL, 'asset')):
        for _quote, target in pattern.findall(body):
            target = target.strip()
            if not target or target.startswith('#') or '__MSG_' in target:
                continue
            yield target, kind


def _references_within(root, relative, kind):
    """Paths the given file pulls in, relative to the package root.

    What a file is read as comes from how it was reached, not from what it is
    called: Chrome loads a page named options.htm as a page.
    """
    base = posixpath.dirname(relative)
    found = []
    if kind == 'page':
        found = _page_references(_read(root, relative))
    elif kind == 'script':
        for call in IMPORT_SCRIPTS.findall(_read(root, relative)):
            found.extend((name, 'script') for name in QUOTED.findall(call))
    elif kind == 'style':
        found = _style_references(_read(root, relative))
    for reference, held in found:
        if reference.startswith(REMOTE):
            continue
        yield posixpath.normpath(posixpath.join(base, reference)), held


def selected_files(root):
    """Yield (path, arcname) for every file the package carries."""
    manifest = _json('manifest.json', _read(root, 'manifest.json'))
    version = manifest.get('version')
    if not _chrome_reads_the_version(version):
        raise SystemExit(f'version is not one Chrome reads: {version!r}')
    if 'version_name' in manifest and not isinstance(manifest['version_name'], str):
        raise SystemExit('version_name is not text: '
                         f'{manifest["version_name"]!r}')
    pending = [('manifest.json', 'asset')]
    pending.extend(_manifest_references(root, manifest))
    selected = {}
    while pending:
        relative, kind = pending.pop(0)
        relative = posixpath.normpath(relative)
        if kind in selected.get(relative, ()):
            continue
        full = _packaged(root, relative)
        if not os.path.isfile(full):
            raise SystemExit(f'referenced file is missing or not a regular file: {relative}')
        selected.setdefault(relative, set()).add(kind)
        pending.extend(_references_within(root, relative, kind))

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
    # these in the manifest and in the stylesheets it serves, and reads one of
    # its own everywhere but the manifest, so the two are kept apart.
    # The manifest is read as the fields it localizes hold once decoded; a
    # stylesheet is not JSON and is read as it stands.
    asking = [('the manifest', list(_localized_values(manifest)),
               NOT_SUPPLIED_TO_THE_MANIFEST)]
    asking += [(relative, [_read(root, relative)], frozenset())
               for relative in sorted(selected) if 'style' in selected[relative]]
    predefined = {name.lower() for name in PREDEFINED_MESSAGES}
    wanted = {name for _label, texts, _withheld in asking for text in texts
              for name in _messages_used(text, '__MSG_', '__')[0]
              if name.lower() not in predefined}

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
    if named and default_locale not in CHROME_WEB_STORE_LOCALES:
        raise SystemExit(f'default_locale is not a locale the store carries: '
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
                catalogs[locale] = _catalog(relative, _read(root, relative))
                seen_locales.add(relative)
                entry = carry(full, relative)
                if entry:
                    yield entry
    if required and required not in seen_locales:
        raise SystemExit(f'the default locale carries no messages: {required}')
    # Every reference resolves against the default catalog and the messages
    # Chrome supplies where it supplies them. The manifest is localized before
    # Chrome has an extension id, so only a catalog can answer for that one
    # there; everywhere else it is supplied.
    answered_by = catalogs.get(default_locale, set())
    for label, texts, withheld in asking:
        known = answered_by | (predefined - withheld)
        for text in texts:
            _seen, missing = _messages_used(text, '__MSG_', '__', known)
            if missing:
                raise SystemExit(f'{label} uses {missing}, which '
                                 f'{required or "no catalog"} does not answer for')

    for relative in DISTRIBUTION_FILES:
        full = _packaged(root, relative)
        if not os.path.isfile(full):
            raise SystemExit(f'the package has to carry this and it is missing: {relative}')
        entry = carry(full, relative)
        if entry:
            yield entry


def pack():
    root = os.path.dirname(os.path.abspath(__file__))
    # Every name is resolved before anything is written. A refusal partway
    # through would otherwise leave a half-built package where the last one was.
    files = list(selected_files(root))
    version = _json('manifest.json', _read(root, 'manifest.json'))['version']
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
