#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_ROOT="${CODEX_SANDBOX_ROOT:-$REPO_DIR/.sandbox}"
SANDBOX_APP_DIR="${CODEX_SANDBOX_APP_DIR:-$SANDBOX_ROOT/codex-app}"
SANDBOX_PROFILE_DIR="${CODEX_SANDBOX_PROFILE_DIR:-$SANDBOX_ROOT/profile}"
WEBVIEW_HOST="${CODEX_SANDBOX_WEBVIEW_HOST:-127.0.0.1}"
WEBVIEW_PORT="${CODEX_SANDBOX_WEBVIEW_PORT:-55175}"
REMOTE_DEBUGGING_PORT="${CODEX_SANDBOX_REMOTE_DEBUGGING_PORT:-9223}"
OPEN_DEVTOOLS="${CODEX_SANDBOX_OPEN_DEVTOOLS:-1}"
WEBVIEW_DIR="$SANDBOX_APP_DIR/content/webview"
RUNTIME_ROOT="$SANDBOX_PROFILE_DIR/runtime"
PID_FILE="$RUNTIME_ROOT/codex-webview-${WEBVIEW_PORT}.pid"
LOG_FILE="$RUNTIME_ROOT/codex-webview-${WEBVIEW_PORT}.log"
REMOTE_SETTINGS_FILE="$RUNTIME_ROOT/remote-dev-settings.json"
WEBVIEW_SERVER_SCRIPT="$SCRIPT_DIR/sandbox-webview-server.py"

find_codex_cli() {
    if [ -n "${CODEX_CLI_PATH:-}" ] && [ -x "${CODEX_CLI_PATH}" ]; then
        printf '%s\n' "${CODEX_CLI_PATH}"
        return 0
    fi

    if command -v codex >/dev/null 2>&1; then
        command -v codex
        return 0
    fi

    for candidate in \
        "${HOME:-}/.local/bin/codex" \
        "${HOME:-}/.npm-global/bin/codex" \
        "${HOME:-}/bin/codex"
    do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    latest_nvm=""
    for candidate in "${HOME:-}/.nvm/versions/node"/*/bin/codex; do
        if [ -x "$candidate" ]; then
            latest_nvm="$candidate"
        fi
    done

    if [ -n "$latest_nvm" ]; then
        printf '%s\n' "$latest_nvm"
        return 0
    fi

    return 1
}

port_in_use() {
    python3 - "$WEBVIEW_HOST" "$WEBVIEW_PORT" <<'PY'
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

wait_for_webview_server() {
    local attempts=50
    local pid=""

    while [ "$attempts" -gt 0 ]; do
        if port_in_use; then
            return 0
        fi

        if [ -f "$PID_FILE" ]; then
            pid="$(cat "$PID_FILE" 2>/dev/null || true)"
            if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
                echo "Sandbox webview server exited before becoming ready." >&2
                echo "See log: $LOG_FILE" >&2
                tail -n 40 "$LOG_FILE" >&2 || true
                return 1
            fi
        fi

        sleep 0.1
        attempts=$((attempts - 1))
    done

    echo "Timed out waiting for the sandbox webview server on $WEBVIEW_HOST:$WEBVIEW_PORT." >&2
    echo "See log: $LOG_FILE" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    return 1
}

cleanup_webview_server() {
    local pid=""

    if [ ! -f "$PID_FILE" ]; then
        return
    fi

    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
}

if [ ! -x "$SANDBOX_APP_DIR/electron" ]; then
    echo "Sandbox app not found at $SANDBOX_APP_DIR/electron" >&2
    echo "Run $SCRIPT_DIR/sandbox-install.sh first." >&2
    exit 1
fi

if [ ! -d "$WEBVIEW_DIR" ]; then
    echo "Sandbox webview directory not found at $WEBVIEW_DIR" >&2
    exit 1
fi

if [ ! -f "$WEBVIEW_SERVER_SCRIPT" ]; then
    echo "Sandbox webview server script not found at $WEBVIEW_SERVER_SCRIPT" >&2
    exit 1
fi

mkdir -p "$SANDBOX_PROFILE_DIR" "$RUNTIME_ROOT"
cleanup_webview_server

if port_in_use; then
    echo "Port $WEBVIEW_PORT is already in use." >&2
    echo "Choose a different CODEX_SANDBOX_WEBVIEW_PORT and rerun ./scripts/sandbox-repatch.sh if you need another sandbox instance." >&2
    exit 1
fi

if ! CODEX_CLI_PATH="$(find_codex_cli)"; then
    echo "Error: Codex CLI not found. Install with: npm i -g @openai/codex" >&2
    exit 1
fi
export CODEX_CLI_PATH

export XDG_CONFIG_HOME="$SANDBOX_PROFILE_DIR/config"
export XDG_DATA_HOME="$SANDBOX_PROFILE_DIR/data"
export XDG_CACHE_HOME="$SANDBOX_PROFILE_DIR/cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

python3 "$WEBVIEW_SERVER_SCRIPT" \
    --bind "$WEBVIEW_HOST" \
    --port "$WEBVIEW_PORT" \
    --webview-dir "$WEBVIEW_DIR" \
    --repo-dir "$REPO_DIR" \
    --settings-file "$REMOTE_SETTINGS_FILE" \
    >"$LOG_FILE" 2>&1 &
WEBVIEW_SERVER_PID=$!
printf '%s\n' "$WEBVIEW_SERVER_PID" > "$PID_FILE"
trap cleanup_webview_server EXIT
wait_for_webview_server

echo "Sandbox webview server log: $LOG_FILE"
if [ -f "$REMOTE_SETTINGS_FILE" ]; then
    echo "Remote settings: $REMOTE_SETTINGS_FILE"
fi

electron_args=(--no-sandbox "--remote-debugging-port=${REMOTE_DEBUGGING_PORT}")
if [ "$OPEN_DEVTOOLS" = "1" ]; then
    electron_args+=(--auto-open-devtools-for-tabs)
fi

cd "$SANDBOX_APP_DIR"
"$SANDBOX_APP_DIR/electron" "${electron_args[@]}" "$@"
