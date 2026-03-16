#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${1:-${CODEX_APP_DIR:-$REPO_DIR/codex-app}}"

if [ ! -f "$APP_DIR/resources/app.asar" ]; then
  echo "Main app not found at $APP_DIR/resources/app.asar" >&2
  echo "Run $SCRIPT_DIR/main-install.sh first." >&2
  exit 1
fi

"$SCRIPT_DIR/integrate-main-app.sh" "$APP_DIR"
