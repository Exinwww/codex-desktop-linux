#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_ROOT="${CODEX_SANDBOX_ROOT:-$REPO_DIR/.sandbox}"
SANDBOX_APP_DIR="${CODEX_SANDBOX_APP_DIR:-$SANDBOX_ROOT/codex-app}"
SANDBOX_WEBVIEW_PORT="${CODEX_SANDBOX_WEBVIEW_PORT:-55175}"

mkdir -p "$SANDBOX_ROOT"

echo "Installing sandbox app into: $SANDBOX_APP_DIR"
echo "Sandbox webview port: $SANDBOX_WEBVIEW_PORT"
CODEX_INSTALL_DIR="$SANDBOX_APP_DIR" "$REPO_DIR/install.sh" "$@"

python3 "$SCRIPT_DIR/apply-patch-bundle.py" "$SANDBOX_APP_DIR/resources/app.asar" "$SANDBOX_ROOT/patch-work"
python3 "$SCRIPT_DIR/sandbox-retarget-webview-port.py" "$SANDBOX_APP_DIR" "$SANDBOX_WEBVIEW_PORT" "$SANDBOX_ROOT/port-work"
python3 "$SCRIPT_DIR/sandbox-enable-devtools.py" "$SANDBOX_APP_DIR" "$SANDBOX_ROOT/devtools-work"

echo "Sandbox is ready. Launch it with: $SCRIPT_DIR/sandbox-run.sh"
