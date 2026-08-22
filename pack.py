"""Pack extension for Chrome Web Store submission."""
import zipfile
import os
import json
import sys

EXCLUDE_FILES = {
    'CLAUDE.md', 'gen_icons.py', 'gen_screenshots.py', 'pack.py', 'test.js',
    '.gitignore', '.webstoreignore', 'README.md',
    'CHANGES.md', 'CHANGES_ja.md', 'LICENSE',
    'PRIVACY_POLICY.md', 'PRIVACY_POLICY_JA.md',
    '.git', '.DS_Store'
}
EXCLUDE_DIRS = {'.claude', '.git', '.github', '__pycache__', 'screenshots', 'docs',
                'work', 'node_modules'}


def selected_files(root):
    """Yield (path, arcname) for every file the package carries."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fname in sorted(filenames):
            if fname in EXCLUDE_FILES or fname.endswith('.zip'):
                continue
            full = os.path.join(dirpath, fname)
            yield full, os.path.relpath(full, root)


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
