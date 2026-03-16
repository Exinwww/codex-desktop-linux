#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${CODEX_APP_DIR:-$REPO_DIR/codex-app}"

echo "Installing main app into: $APP_DIR"
CODEX_INSTALL_DIR="$APP_DIR" APPLY_MAIN_REMOTE_INTEGRATION="${APPLY_MAIN_REMOTE_INTEGRATION:-1}" "$REPO_DIR/install.sh" "$@"

echo "Main app is ready. Launch it with: $APP_DIR/start.sh"
