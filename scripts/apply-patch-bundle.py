#!/usr/bin/env python3
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional


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


def copy_tree(src: Path, dst: Path) -> None:
    for path in src.rglob('*'):
        rel = path.relative_to(src)
        target = dst / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def copy_live_webview_tree(src: Path, dst: Path) -> None:
    webview_src = src / 'webview'
    if not webview_src.is_dir():
        return

    for path in webview_src.rglob('*'):
        rel = path.relative_to(webview_src)
        target = dst / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def apply_replacements(root: Path, rules: list, *, glob_prefix: Optional[str] = None) -> None:
    for rule in rules:
        glob_pattern = rule['glob']
        if glob_prefix is not None:
            prefix = f'{glob_prefix}/'
            if not glob_pattern.startswith(prefix):
                continue
            glob_pattern = glob_pattern[len(prefix):]

        matched_files = sorted(root.glob(glob_pattern))
        if not matched_files:
            raise SystemExit(f"No files matched {glob_pattern} for {rule['name']}")

        total_replacements = 0
        already_present = False
        for path in matched_files:
            text = path.read_text(encoding='utf-8')
            if rule['find'] in text:
                total_replacements += text.count(rule['find'])
                text = text.replace(rule['find'], rule['replace'])
                path.write_text(text, encoding='utf-8')
            elif rule.get('already_contains') and rule['already_contains'] in text:
                already_present = True

        expected = rule.get('count')
        if total_replacements == 0:
            if already_present:
                continue
            raise SystemExit(f"Rule did not match: {rule['name']}")
        if expected is not None and total_replacements != expected:
            raise SystemExit(
                f"Rule {rule['name']} replaced {total_replacements} occurrences, expected {expected}"
            )


def main() -> int:
    bundle_dir = REPO_DIR / 'patches' / 'codex-desktop'
    asar_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else REPO_DIR / 'codex-app' / 'resources' / 'app.asar'
    work_root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else REPO_DIR / 'patch-work' / 'local'

    if not asar_path.is_file():
        raise SystemExit(f'ASAR not found: {asar_path}')
    if not (bundle_dir / 'manifest.json').is_file():
        raise SystemExit(f"Patch manifest not found: {bundle_dir / 'manifest.json'}")

    manifest = json.loads((bundle_dir / 'manifest.json').read_text(encoding='utf-8'))
    unpacked_dir = asar_path.with_name(f'{asar_path.name}.unpacked')
    app_dir = asar_path.parent.parent
    live_webview_dir = app_dir / 'content' / 'webview'
    extract_dir = work_root / 'extract'
    packed_dir = work_root / 'packed'
    packed_asar = packed_dir / asar_path.name
    packed_unpacked = packed_dir / f'{asar_path.name}.unpacked'

    if work_root.exists():
        shutil.rmtree(work_root)
    work_root.mkdir(parents=True, exist_ok=True)

    run([*ASAR, 'extract', str(asar_path), str(extract_dir)])

    for item in manifest.get('copy_tree', []):
        src = bundle_dir / item['from']
        copy_tree(src, extract_dir / item['to'])
        if live_webview_dir.is_dir():
            copy_live_webview_tree(src, live_webview_dir)

    apply_replacements(extract_dir, manifest.get('replacements', []))
    if live_webview_dir.is_dir():
        apply_replacements(live_webview_dir, manifest.get('replacements', []), glob_prefix='webview')

    packed_dir.mkdir(parents=True, exist_ok=True)
    run([
        *ASAR,
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

    print(f'Patched: {asar_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
