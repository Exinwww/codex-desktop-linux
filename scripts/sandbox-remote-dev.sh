#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_ROOT="${CODEX_SANDBOX_ROOT:-$REPO_DIR/.sandbox}"
SANDBOX_PROFILE_DIR="${CODEX_SANDBOX_PROFILE_DIR:-$SANDBOX_ROOT/profile}"
RUNTIME_ROOT="${CODEX_SANDBOX_RUNTIME_ROOT:-$SANDBOX_PROFILE_DIR/runtime}"
LAUNCH_MODE="${CODEX_REMOTE_LAUNCH_MODE:-all-in-one}"
RELAY_HOST="${CODEX_REMOTE_RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${CODEX_REMOTE_RELAY_PORT:-9001}"
RELAY_ORIGIN="${CODEX_REMOTE_RELAY_ORIGIN:-http://${RELAY_HOST}:${RELAY_PORT}}"
RENDEZVOUS_HOST="${CODEX_REMOTE_RENDEZVOUS_HOST:-127.0.0.1}"
RENDEZVOUS_PORT="${CODEX_REMOTE_RENDEZVOUS_PORT:-9002}"
RENDEZVOUS_ORIGIN="${CODEX_REMOTE_RENDEZVOUS_ORIGIN:-http://${RENDEZVOUS_HOST}:${RENDEZVOUS_PORT}}"
DEVICE_ID="${CODEX_REMOTE_DEVICE_ID:-sandbox-local}"
HOST_TOKEN="${CODEX_REMOTE_HOST_TOKEN:-}"
PAIRING_CODE="${CODEX_REMOTE_PAIRING_CODE:-}"
CLIENT_TOKEN="${CODEX_REMOTE_CLIENT_TOKEN:-}"
SESSION_SECRET="${CODEX_REMOTE_SESSION_SECRET:-$CLIENT_TOKEN}"
RELAY_PID_FILE="$RUNTIME_ROOT/sandbox-remote-relay.pid"
RENDEZVOUS_PID_FILE="$RUNTIME_ROOT/sandbox-remote-rendezvous.pid"
HOST_AGENT_PID_FILE="$RUNTIME_ROOT/sandbox-remote-host-agent.pid"
MANAGED_RELAY=0
MANAGED_RENDEZVOUS=0
MANAGED_HOST_AGENT=0

port_in_use() {
  python3 - "$1" "$2" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.2)
try:
    result = sock.connect_ex((sys.argv[1], int(sys.argv[2])))
finally:
    sock.close()

raise SystemExit(0 if result == 0 else 1)
PY
}

json_healthcheck() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1], timeout=1.5) as response:
        payload = json.load(response)
except Exception:
    raise SystemExit(1)

key = sys.argv[2]
if payload.get("ok") is True and key in payload:
    raise SystemExit(0)
raise SystemExit(1)
PY
}

relay_healthcheck() {
  json_healthcheck "$RELAY_ORIGIN/api/health" "relayOrigin"
}

rendezvous_healthcheck() {
  json_healthcheck "$RENDEZVOUS_ORIGIN/api/health" "rendezvousOrigin"
}

is_pid_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

clear_pid_file() {
  local pid_file="$1"
  rm -f "$pid_file"
}

stop_pid() {
  local pid="$1"
  if ! is_pid_running "$pid"; then
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

stop_pid_file_process() {
  local pid_file="$1"
  local label="$2"
  local pid=""

  if [ ! -f "$pid_file" ]; then
    return 0
  fi

  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if is_pid_running "$pid"; then
    echo "Stopping stale ${label} process (${pid})."
    stop_pid "$pid"
  fi

  clear_pid_file "$pid_file"
}

wait_for_service_ready() {
  local label="$1"
  local healthcheck_fn="$2"
  local pid_var="$3"
  local attempts=40
  local pid=""

  while [ "$attempts" -gt 0 ]; do
    if "$healthcheck_fn"; then
      return 0
    fi

    pid="${!pid_var:-}"
    if [ -n "$pid" ] && ! is_pid_running "$pid"; then
      echo "${label} process exited before becoming ready." >&2
      return 1
    fi

    sleep 0.1
    attempts=$((attempts - 1))
  done

  echo "Timed out waiting for ${label} readiness." >&2
  return 1
}

cleanup() {
  local exit_code=$?

  if [ "$MANAGED_HOST_AGENT" = "1" ] && [ -n "${HOST_AGENT_PID:-}" ]; then
    stop_pid "$HOST_AGENT_PID"
    clear_pid_file "$HOST_AGENT_PID_FILE"
  fi

  if [ "$MANAGED_RENDEZVOUS" = "1" ] && [ -n "${RENDEZVOUS_PID:-}" ]; then
    stop_pid "$RENDEZVOUS_PID"
    clear_pid_file "$RENDEZVOUS_PID_FILE"
  fi

  if [ "$MANAGED_RELAY" = "1" ] && [ -n "${RELAY_PID:-}" ]; then
    stop_pid "$RELAY_PID"
    clear_pid_file "$RELAY_PID_FILE"
  fi

  exit "$exit_code"
}
trap cleanup EXIT

mkdir -p "$RUNTIME_ROOT"
cd "$REPO_DIR"

stop_pid_file_process "$HOST_AGENT_PID_FILE" "host agent"
stop_pid_file_process "$RENDEZVOUS_PID_FILE" "rendezvous"
stop_pid_file_process "$RELAY_PID_FILE" "relay"

if [ "$LAUNCH_MODE" != "all-in-one" ] && [ "$LAUNCH_MODE" != "host-agent-only" ]; then
  echo "Unsupported CODEX_REMOTE_LAUNCH_MODE: ${LAUNCH_MODE}" >&2
  exit 1
fi

START_RELAY=0
START_RENDEZVOUS=0
if [ "$LAUNCH_MODE" = "all-in-one" ]; then
  START_RELAY=1
  START_RENDEZVOUS=1

  if port_in_use "$RELAY_HOST" "$RELAY_PORT"; then
    if relay_healthcheck; then
      START_RELAY=0
      echo "Relay already running at ${RELAY_ORIGIN}; reusing existing process."
    else
      echo "Port ${RELAY_PORT} is already in use on ${RELAY_HOST}, but it does not look like the Codex relay." >&2
      exit 1
    fi
  fi

  if port_in_use "$RENDEZVOUS_HOST" "$RENDEZVOUS_PORT"; then
    if rendezvous_healthcheck; then
      START_RENDEZVOUS=0
      echo "Rendezvous already running at ${RENDEZVOUS_ORIGIN}; reusing existing process."
    else
      echo "Port ${RENDEZVOUS_PORT} is already in use on ${RENDEZVOUS_HOST}, but it does not look like the Codex rendezvous server." >&2
      exit 1
    fi
  fi
fi

if [ "$START_RELAY" = "1" ]; then
  CODEX_REMOTE_RELAY_HOST="$RELAY_HOST" \
  CODEX_REMOTE_RELAY_PORT="$RELAY_PORT" \
  CODEX_REMOTE_RELAY_ORIGIN="$RELAY_ORIGIN" \
  CODEX_REMOTE_RENDEZVOUS_ORIGIN="$RENDEZVOUS_ORIGIN" \
  CODEX_REMOTE_HOST_TOKEN="$HOST_TOKEN" \
  CODEX_REMOTE_CLIENT_TOKEN="$CLIENT_TOKEN" \
  CODEX_REMOTE_SESSION_SECRET="$SESSION_SECRET" \
  node ./remote/relay-server/server.mjs &
  RELAY_PID=$!
  MANAGED_RELAY=1
  printf '%s\n' "$RELAY_PID" > "$RELAY_PID_FILE"
  wait_for_service_ready "Relay" relay_healthcheck RELAY_PID
fi

if [ "$START_RENDEZVOUS" = "1" ]; then
  CODEX_REMOTE_RENDEZVOUS_HOST="$RENDEZVOUS_HOST" \
  CODEX_REMOTE_RENDEZVOUS_PORT="$RENDEZVOUS_PORT" \
  CODEX_REMOTE_RENDEZVOUS_ORIGIN="$RENDEZVOUS_ORIGIN" \
  CODEX_REMOTE_RELAY_ORIGIN="$RELAY_ORIGIN" \
  CODEX_REMOTE_HOST_TOKEN="$HOST_TOKEN" \
  CODEX_REMOTE_CLIENT_TOKEN="$CLIENT_TOKEN" \
  CODEX_REMOTE_SESSION_SECRET="$SESSION_SECRET" \
  node ./remote/rendezvous-server/server.mjs &
  RENDEZVOUS_PID=$!
  MANAGED_RENDEZVOUS=1
  printf '%s\n' "$RENDEZVOUS_PID" > "$RENDEZVOUS_PID_FILE"
  wait_for_service_ready "Rendezvous" rendezvous_healthcheck RENDEZVOUS_PID
fi

CODEX_REMOTE_RELAY_ORIGIN="$RELAY_ORIGIN" \
CODEX_REMOTE_RENDEZVOUS_ORIGIN="$RENDEZVOUS_ORIGIN" \
CODEX_REMOTE_DEVICE_ID="$DEVICE_ID" \
CODEX_REMOTE_HOST_TOKEN="$HOST_TOKEN" \
CODEX_REMOTE_PAIRING_CODE="$PAIRING_CODE" \
CODEX_REMOTE_WEBVIEW_ORIGIN="${CODEX_REMOTE_WEBVIEW_ORIGIN:-http://127.0.0.1:55175}" \
CODEX_REMOTE_CDP_ORIGIN="${CODEX_REMOTE_CDP_ORIGIN:-http://127.0.0.1:9223}" \
node ./remote/host-agent/server.mjs &
HOST_AGENT_PID=$!
MANAGED_HOST_AGENT=1
printf '%s\n' "$HOST_AGENT_PID" > "$HOST_AGENT_PID_FILE"

echo "Remote launch mode: ${LAUNCH_MODE}"
echo "Relay origin: ${RELAY_ORIGIN}"
echo "Rendezvous origin: ${RENDEZVOUS_ORIGIN}"
echo "Device ID: ${DEVICE_ID}"
if [ -n "$HOST_TOKEN" ]; then
  echo "Host token: configured"
fi
if [ -n "$PAIRING_CODE" ]; then
  echo "Pairing code: configured"
fi

if [ "$MANAGED_RELAY" = "1" ] && [ "$MANAGED_RENDEZVOUS" = "1" ]; then
  wait -n "$RELAY_PID" "$RENDEZVOUS_PID" "$HOST_AGENT_PID"
elif [ "$MANAGED_RELAY" = "1" ]; then
  wait -n "$RELAY_PID" "$HOST_AGENT_PID"
elif [ "$MANAGED_RENDEZVOUS" = "1" ]; then
  wait -n "$RENDEZVOUS_PID" "$HOST_AGENT_PID"
else
  wait "$HOST_AGENT_PID"
fi
