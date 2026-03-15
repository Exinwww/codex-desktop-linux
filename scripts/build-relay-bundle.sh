#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${CODEX_REMOTE_SERVER_TARGET:-$REPO_DIR/.build/codex-relay-server}"

usage() {
  cat <<USAGE
Usage: $0 [setup-relay-server options]

This is a project-root friendly wrapper around:
  ./remote/server/setup-relay-server.sh

Default target:
  $TARGET_DIR

Examples:
  $0 --public-origin https://relay.example.com --public-rendezvous-origin https://rv.example.com --host-token 'replace-me' --client-token 'browser-secret'
  $0 --target /opt/codex-relay --write-systemd

Any extra arguments are forwarded to setup-relay-server.sh unchanged.
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "No arguments provided; using default target: $TARGET_DIR"
fi

exec "$REPO_DIR/remote/server/setup-relay-server.sh" --target "$TARGET_DIR" "$@"
