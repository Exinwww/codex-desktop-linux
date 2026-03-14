#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/sandbox-dev-sync.sh"
exec "$SCRIPT_DIR/sandbox-run.sh" "$@"
