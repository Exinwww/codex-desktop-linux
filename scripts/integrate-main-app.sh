#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${1:-${CODEX_APP_DIR:-$REPO_DIR/codex-app}}"
APP_DIR="$(cd "$APP_DIR" && pwd)"
WORK_ROOT="${CODEX_MAIN_PATCH_WORK:-$REPO_DIR/patch-work/main}"
WEBVIEW_PORT="${CODEX_APP_WEBVIEW_PORT:-5175}"
REMOTE_DEBUGGING_PORT="${CODEX_REMOTE_CDP_PORT:-9222}"

if [ ! -f "$APP_DIR/resources/app.asar" ]; then
  echo "App ASAR not found at $APP_DIR/resources/app.asar" >&2
  exit 1
fi

python3 "$SCRIPT_DIR/apply-patch-bundle.py" "$APP_DIR/resources/app.asar" "$WORK_ROOT"

mkdir -p "$APP_DIR/remote"
rm -rf "$APP_DIR/remote/host-agent" "$APP_DIR/remote/protocol" "$APP_DIR/remote/relay-server" "$APP_DIR/remote/rendezvous-server"
cp -a "$REPO_DIR/remote/host-agent" "$APP_DIR/remote/host-agent"
cp -a "$REPO_DIR/remote/protocol" "$APP_DIR/remote/protocol"
cp -a "$REPO_DIR/remote/relay-server" "$APP_DIR/remote/relay-server"
cp -a "$REPO_DIR/remote/rendezvous-server" "$APP_DIR/remote/rendezvous-server"

install -m755 "$SCRIPT_DIR/main-webview-server.py" "$APP_DIR/codex-webview-server.py"
install -m644 "$SCRIPT_DIR/remote_webview_server_lib.py" "$APP_DIR/remote_webview_server_lib.py"
install -m755 "$SCRIPT_DIR/main-remote-supervisor.sh" "$APP_DIR/codex-remote-supervisor.sh"
install -m755 "$SCRIPT_DIR/remote-supervisor.sh" "$APP_DIR/remote-supervisor.sh"

cat > "$APP_DIR/start.sh" <<START
#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
WEBVIEW_DIR="\$SCRIPT_DIR/content/webview"
WEBVIEW_HOST="\${CODEX_APP_WEBVIEW_HOST:-127.0.0.1}"
WEBVIEW_PORT="\${CODEX_APP_WEBVIEW_PORT:-$WEBVIEW_PORT}"
REMOTE_DEBUGGING_PORT="\${CODEX_REMOTE_CDP_PORT:-$REMOTE_DEBUGGING_PORT}"
STATE_ROOT="\${CODEX_STATE_ROOT:-\${XDG_STATE_HOME:-\$HOME/.local/state}/codex-desktop}"
RUNTIME_ROOT="\${CODEX_RUNTIME_ROOT:-\$STATE_ROOT/runtime}"
CONFIG_ROOT="\${XDG_CONFIG_HOME:-\$HOME/.config}"
USER_DATA_DIR="\${CODEX_APP_USER_DATA_DIR:-\$CONFIG_ROOT/codex-desktop}"
WEBVIEW_SERVER_SCRIPT="\$SCRIPT_DIR/codex-webview-server.py"
REMOTE_SETTINGS_FILE="\$STATE_ROOT/remote-settings.json"
PID_FILE="\$RUNTIME_ROOT/codex-webview-\${WEBVIEW_PORT}.pid"
LOG_FILE="\$RUNTIME_ROOT/codex-webview-\${WEBVIEW_PORT}.log"

find_codex_cli() {
    if [ -n "\${CODEX_CLI_PATH:-}" ] && [ -x "\${CODEX_CLI_PATH}" ]; then
        printf '%s\\n' "\${CODEX_CLI_PATH}"
        return 0
    fi

    if command -v codex >/dev/null 2>&1; then
        command -v codex
        return 0
    fi

    for candidate in \\
        "\${HOME:-}/.local/bin/codex" \\
        "\${HOME:-}/.npm-global/bin/codex" \\
        "\${HOME:-}/bin/codex"
    do
        if [ -x "\$candidate" ]; then
            printf '%s\\n' "\$candidate"
            return 0
        fi
    done

    latest_nvm=""
    for candidate in "\${HOME:-}/.nvm/versions/node"/*/bin/codex; do
        if [ -x "\$candidate" ]; then
            latest_nvm="\$candidate"
        fi
    done

    if [ -n "\$latest_nvm" ]; then
        printf '%s\\n' "\$latest_nvm"
        return 0
    fi

    return 1
}

port_in_use() {
  python3 - "\$WEBVIEW_HOST" "\$WEBVIEW_PORT" <<'PY'
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

  while [ "\$attempts" -gt 0 ]; do
    if port_in_use; then
      return 0
    fi

    if [ -f "\$PID_FILE" ]; then
      pid="\$(cat "\$PID_FILE" 2>/dev/null || true)"
      if [ -n "\$pid" ] && ! kill -0 "\$pid" 2>/dev/null; then
        echo "Codex webview server exited before becoming ready." >&2
        echo "See log: \$LOG_FILE" >&2
        tail -n 40 "\$LOG_FILE" >&2 || true
        return 1
      fi
    fi

    sleep 0.1
    attempts=\$((attempts - 1))
  done

  echo "Timed out waiting for the Codex webview server on \$WEBVIEW_HOST:\$WEBVIEW_PORT." >&2
  echo "See log: \$LOG_FILE" >&2
  tail -n 40 "\$LOG_FILE" >&2 || true
  return 1
}

cleanup_webview_server() {
  local pid=""

  if [ ! -f "\$PID_FILE" ]; then
    return
  fi

  pid="\$(cat "\$PID_FILE" 2>/dev/null || true)"
  if [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null; then
    kill "\$pid" 2>/dev/null || true
    wait "\$pid" 2>/dev/null || true
  fi

  rm -f "\$PID_FILE"
}

cleanup_orphaned_webview_servers() {
  local pid=""

  command -v pgrep >/dev/null 2>&1 || return 0

  while IFS= read -r pid; do
    [ -n "\$pid" ] || continue
    if ! kill -0 "\$pid" 2>/dev/null; then
      continue
    fi
    kill "\$pid" 2>/dev/null || true
    wait "\$pid" 2>/dev/null || true
  done < <(pgrep -f "codex-webview-server.py --bind \$WEBVIEW_HOST --port \$WEBVIEW_PORT" || true)
}

mkdir -p "\$RUNTIME_ROOT" "\$STATE_ROOT"

if [ ! -d "\$WEBVIEW_DIR" ]; then
  echo "Codex webview directory not found at \$WEBVIEW_DIR" >&2
  exit 1
fi

if [ ! -f "\$WEBVIEW_SERVER_SCRIPT" ]; then
  echo "Codex webview server script not found at \$WEBVIEW_SERVER_SCRIPT" >&2
  exit 1
fi

cleanup_webview_server
if port_in_use; then
  cleanup_orphaned_webview_servers
fi
trap cleanup_webview_server EXIT

if port_in_use; then
  echo "Port \$WEBVIEW_PORT is already in use." >&2
  echo "Set CODEX_APP_WEBVIEW_PORT to another value and rerun the integration script if you need a different app instance." >&2
  exit 1
fi

python3 "\$WEBVIEW_SERVER_SCRIPT" \\
  --bind "\$WEBVIEW_HOST" \\
  --port "\$WEBVIEW_PORT" \\
  --webview-dir "\$WEBVIEW_DIR" \\
  --app-dir "\$SCRIPT_DIR" \\
  --settings-file "\$REMOTE_SETTINGS_FILE" \\
  >"\$LOG_FILE" 2>&1 &
WEBVIEW_SERVER_PID=\$!
printf '%s\\n' "\$WEBVIEW_SERVER_PID" > "\$PID_FILE"
wait_for_webview_server

echo "Codex webview server log: \$LOG_FILE"

export CODEX_CLI_PATH="\${CODEX_CLI_PATH:-\$(find_codex_cli || true)}"

if [ -z "\$CODEX_CLI_PATH" ]; then
  echo "Error: Codex CLI not found. Install with: npm i -g @openai/codex" >&2
  exit 1
fi

mkdir -p "\$USER_DATA_DIR"
electron_args=(--no-sandbox "--remote-debugging-port=\${REMOTE_DEBUGGING_PORT}" "--user-data-dir=\$USER_DATA_DIR")

cd "\$SCRIPT_DIR"
set +e
"\$SCRIPT_DIR/electron" "\${electron_args[@]}" "\$@"
electron_status=\$?
set -e
exit "\$electron_status"
START
chmod +x "$APP_DIR/start.sh"

echo "Integrated remote runtime into main app: $APP_DIR"
echo "- start launcher: $APP_DIR/start.sh"
echo "- webview server: $APP_DIR/codex-webview-server.py"
echo "- remote supervisor: $APP_DIR/codex-remote-supervisor.sh"
