#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_ROOT="${CODEX_SANDBOX_ROOT:-$REPO_DIR/.sandbox}"
SANDBOX_APP_DIR="${CODEX_SANDBOX_APP_DIR:-$SANDBOX_ROOT/codex-app}"
SOURCE_CSS="${CODEX_SANDBOX_DEV_CSS:-$REPO_DIR/sandbox/dev/codex-appearance-dev.css}"
TARGET_DIR="$SANDBOX_APP_DIR/content/webview/assets"
TARGET_CSS="$TARGET_DIR/codex-appearance-dev.css"
IMPORT_LINE='@import "./codex-appearance-dev.css";'

if [ ! -f "$SOURCE_CSS" ]; then
    echo "Dev CSS template not found at $SOURCE_CSS" >&2
    exit 1
fi

if [ ! -d "$TARGET_DIR" ]; then
    echo "Sandbox assets directory not found at $TARGET_DIR" >&2
    echo "Run $SCRIPT_DIR/sandbox-install.sh first." >&2
    exit 1
fi

cp "$SOURCE_CSS" "$TARGET_CSS"

python3 - "$TARGET_DIR" "$IMPORT_LINE" <<'PY'
from pathlib import Path
import sys

assets_dir = Path(sys.argv[1])
import_line = sys.argv[2]
css_files = sorted(
    path for path in assets_dir.glob('*.css')
    if path.name not in {'codex-fonts.css', 'codex-appearance-dev.css'}
)

preferred = []
fallback = []
already_present = False
for path in css_files:
    text = path.read_text(encoding='utf-8')
    if import_line in text:
        already_present = True
        continue
    if '@layer theme{:root,:host' in text or '@layer theme {' in text:
        preferred.append((path, text))
    else:
        fallback.append((path, text))

if already_present:
    print('Dev override import already present')
    raise SystemExit(0)

targets = preferred or fallback[:1]
if not targets:
    raise SystemExit('No CSS files available for dev override injection')

for path, text in targets:
    path.write_text(f'{import_line}\n{text}', encoding='utf-8')
    print(f'Injected dev override import into {path}')
PY

echo "Synced sandbox dev CSS to $TARGET_CSS"
