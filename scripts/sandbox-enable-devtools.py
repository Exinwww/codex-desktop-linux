#!/usr/bin/env python3
import shutil
import subprocess
import sys
from pathlib import Path

FIND = 'l=a.BuildFlavor.allowDevtools(e),u=e===a.BuildFlavor.Dev||e===a.BuildFlavor.Agent,d=a.BuildFlavor.allowDebugMenu(e),'
REPLACE = 'l=!0,u=!0,d=!0,'


def run(cmd):
    subprocess.run(cmd, check=True)


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit('usage: sandbox-enable-devtools.py APP_DIR [WORK_DIR]')

    app_dir = Path(sys.argv[1]).resolve()
    work_root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else app_dir.parent / 'patch-work-devtools'
    asar_path = app_dir / 'resources' / 'app.asar'

    if not asar_path.is_file():
        raise SystemExit(f'asar not found: {asar_path}')

    unpacked_dir = asar_path.with_name(f'{asar_path.name}.unpacked')
    extract_dir = work_root / 'extract'
    packed_dir = work_root / 'packed'
    packed_asar = packed_dir / asar_path.name
    packed_unpacked = packed_dir / f'{asar_path.name}.unpacked'

    if work_root.exists():
        shutil.rmtree(work_root)
    work_root.mkdir(parents=True, exist_ok=True)

    run(['node', '/home/linbei/.npm/_npx/8b3f11f22d4db0c9/node_modules/asar/bin/asar.js', 'extract', str(asar_path), str(extract_dir)])

    matched_files = sorted((extract_dir / '.vite' / 'build').glob('main-*.js'))
    if not matched_files:
        raise SystemExit('No main bundle matched .vite/build/main-*.js')

    replaced = 0
    already_enabled = False
    for path in matched_files:
        text = path.read_text(encoding='utf-8')
        if FIND in text:
            replaced += text.count(FIND)
            text = text.replace(FIND, REPLACE)
            path.write_text(text, encoding='utf-8')
        elif REPLACE in text:
            already_enabled = True

    if replaced == 0 and not already_enabled:
        raise SystemExit('DevTools patch point not found in main bundle')
    if replaced not in (0, 1):
        raise SystemExit(f'Unexpected DevTools replacement count: {replaced}')

    packed_dir.mkdir(parents=True, exist_ok=True)
    run([
        'node',
        '/home/linbei/.npm/_npx/8b3f11f22d4db0c9/node_modules/asar/bin/asar.js',
        'pack',
        str(extract_dir),
        str(packed_asar),
        '--unpack',
        '*.node',
    ])

    shutil.copy2(packed_asar, asar_path)
    if unpacked_dir.exists():
        shutil.rmtree(unpacked_dir)
    if packed_unpacked.exists():
        shutil.copytree(packed_unpacked, unpacked_dir)

    if replaced == 0:
        print(f'DevTools already enabled in: {asar_path}')
    else:
        print(f'Enabled sandbox DevTools in: {asar_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
