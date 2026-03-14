#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_ROOT="${CODEX_SANDBOX_ROOT:-$REPO_DIR/.sandbox}"
SANDBOX_APP_DIR="${CODEX_SANDBOX_APP_DIR:-$SANDBOX_ROOT/codex-app}"
SANDBOX_WEBVIEW_PORT="${CODEX_SANDBOX_WEBVIEW_PORT:-55175}"

if [ ! -f "$SANDBOX_APP_DIR/resources/app.asar" ]; then
    echo "Sandbox app not found at $SANDBOX_APP_DIR/resources/app.asar" >&2
    echo "Run $SCRIPT_DIR/sandbox-install.sh first." >&2
    exit 1
fi

python3 "$SCRIPT_DIR/apply-patch-bundle.py" "$SANDBOX_APP_DIR/resources/app.asar" "$SANDBOX_ROOT/patch-work"
python3 "$SCRIPT_DIR/sandbox-retarget-webview-port.py" "$SANDBOX_APP_DIR" "$SANDBOX_WEBVIEW_PORT" "$SANDBOX_ROOT/port-work"
python3 "$SCRIPT_DIR/sandbox-enable-devtools.py" "$SANDBOX_APP_DIR" "$SANDBOX_ROOT/devtools-work"
