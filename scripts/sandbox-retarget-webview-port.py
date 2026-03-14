#!/usr/bin/env python3
import shutil
import subprocess
import sys
from pathlib import Path

TEXT_SUFFIXES = {
    '',
    '.css',
    '.html',
    '.js',
    '.json',
    '.mjs',
    '.sh',
    '.txt',
}
OLD_PORT = '5175'
REPO_DIR = Path(__file__).resolve().parent.parent


def find_asar_cli() -> list:
    candidates = [
        REPO_DIR / '.cache' / 'tools' / 'asar' / 'bin' / 'asar.js',
        Path.home() / '.npm' / '_npx' / '8b3f11f22d4db0c9' / 'node_modules' / 'asar' / 'bin' / 'asar.js',
    ]
    for path in candidates:
        if path.is_file():
            return ['node', str(path)]
    return ['npx', '--yes', 'asar']


ASAR = find_asar_cli()


def run(cmd):
    subprocess.run(cmd, check=True)


def patch_text_file(path: Path, new_port: str) -> int:
    if path.suffix not in TEXT_SUFFIXES:
        return 0

    try:
        text = path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        return 0

    count = text.count(OLD_PORT)
    if count == 0:
        return 0

    path.write_text(text.replace(OLD_PORT, new_port), encoding='utf-8')
    return count


def patch_tree(root: Path, new_port: str):
    files_changed = 0
    replacements = 0
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        count = patch_text_file(path, new_port)
        if count:
            files_changed += 1
            replacements += count
    return files_changed, replacements


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit('usage: sandbox-retarget-webview-port.py APP_DIR [PORT] [WORK_DIR]')

    app_dir = Path(sys.argv[1]).resolve()
    new_port = sys.argv[2] if len(sys.argv) > 2 else '55175'
    work_root = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else app_dir.parent / 'patch-work-port'

    if not app_dir.is_dir():
        raise SystemExit(f'app dir not found: {app_dir}')
    if not new_port.isdigit():
        raise SystemExit(f'invalid port: {new_port}')
    if not (1 <= int(new_port) <= 65535):
        raise SystemExit(f'port out of range: {new_port}')

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

    run([*ASAR, 'extract', str(asar_path), str(extract_dir)])
    asar_files, asar_replacements = patch_tree(extract_dir, new_port)

    packed_dir.mkdir(parents=True, exist_ok=True)
    run([
        *ASAR, 'pack', str(extract_dir), str(packed_asar), '--unpack', '*.node'
    ])

    shutil.copy2(packed_asar, asar_path)
    if unpacked_dir.exists():
        shutil.rmtree(unpacked_dir)
    if packed_unpacked.exists():
        shutil.copytree(packed_unpacked, unpacked_dir)

    outer_targets = []
    start_script = app_dir / 'start.sh'
    if start_script.exists():
        outer_targets.append(start_script)
    webview_dir = app_dir / 'content' / 'webview'
    if webview_dir.is_dir():
        outer_targets.extend(path for path in webview_dir.rglob('*') if path.is_file())

    outer_files = 0
    outer_replacements = 0
    for path in outer_targets:
        count = patch_text_file(path, new_port)
        if count:
            outer_files += 1
            outer_replacements += count

    total_files = asar_files + outer_files
    total_replacements = asar_replacements + outer_replacements
    print(
        f'Retargeted sandbox webview port to {new_port}: '
        f'{total_replacements} replacements across {total_files} files'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
