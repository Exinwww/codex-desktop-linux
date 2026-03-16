#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export CODEX_REMOTE_APP_DIR="${CODEX_REMOTE_APP_DIR:-$SCRIPT_DIR}"

exec "$SCRIPT_DIR/remote-supervisor.sh" "$@"
