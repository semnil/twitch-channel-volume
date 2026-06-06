"""Pack extension for Chrome Web Store submission."""
import zipfile
import os
import json

EXCLUDE_FILES = {
    'CLAUDE.md', 'gen_icons.py', 'gen_screenshots.py', 'pack.py', 'test.js',
    '.gitignore', '.webstoreignore', 'README.md',
    'CHANGES.md', 'CHANGES_ja.md', 'LICENSE',
    'PRIVACY_POLICY.md', 'PRIVACY_POLICY_JA.md'
}
EXCLUDE_DIRS = {'.claude', '.git', '.github', '__pycache__', 'screenshots', 'docs'}


def pack():
    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, 'manifest.json')) as f:
        version = json.load(f)['version']
    out = f'twitch-channel-volume-{version}.zip'
    out_path = os.path.join(root, out)
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fname in filenames:
                if fname in EXCLUDE_FILES or fname.endswith('.zip'):
                    continue
                full = os.path.join(dirpath, fname)
                arcname = os.path.relpath(full, root)
                zf.write(full, arcname)
                print(f'  + {arcname}')
    print(f'\n=> {out}')


if __name__ == '__main__':
    pack()
