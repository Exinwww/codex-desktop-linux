#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_TARGET="$REPO_DIR/.build/codex-relay-server"
TARGET_DIR="${CODEX_REMOTE_SERVER_TARGET:-$DEFAULT_TARGET}"
WEBVIEW_SOURCE="${CODEX_REMOTE_WEBVIEW_SOURCE:-}"
RELAY_HOST="${CODEX_REMOTE_RELAY_HOST:-0.0.0.0}"
RELAY_PORT="${CODEX_REMOTE_RELAY_PORT:-9001}"
RENDEZVOUS_HOST="${CODEX_REMOTE_RENDEZVOUS_HOST:-0.0.0.0}"
RENDEZVOUS_PORT="${CODEX_REMOTE_RENDEZVOUS_PORT:-9002}"
HOST_TOKEN="${CODEX_REMOTE_HOST_TOKEN:-}"
CLIENT_TOKEN="${CODEX_REMOTE_CLIENT_TOKEN:-}"
SESSION_SECRET="${CODEX_REMOTE_SESSION_SECRET:-$CLIENT_TOKEN}"
PUBLIC_ORIGIN="${CODEX_REMOTE_PUBLIC_ORIGIN:-}"
PUBLIC_RENDEZVOUS_ORIGIN="${CODEX_REMOTE_PUBLIC_RENDEZVOUS_ORIGIN:-}"
SERVICE_NAME="${CODEX_REMOTE_SERVER_SERVICE_NAME:-codex-relay}"
SERVICE_USER="${CODEX_REMOTE_SERVER_USER:-$(id -un)}"
WRITE_SYSTEMD=0
FORCE=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --target DIR               Output directory for the standalone remote bundle
  --webview-source DIR       Source Codex webview directory to copy into the bundle
  --relay-host HOST          Relay listen host (default: $RELAY_HOST)
  --relay-port PORT          Relay listen port (default: $RELAY_PORT)
  --rendezvous-host HOST     Rendezvous listen host (default: $RENDEZVOUS_HOST)
  --rendezvous-port PORT     Rendezvous listen port (default: $RENDEZVOUS_PORT)
  --host-token TOKEN         Shared secret required for host-agent registration
  --client-token TOKEN       Shared secret required for browser session creation
  --session-secret TOKEN     Secret used to sign relay session tokens
  --public-origin URL        Browser/app-facing relay origin, for example https://relay.example.com
  --public-rendezvous-origin URL  Browser-facing rendezvous origin, for example https://rv.example.com
  --service-name NAME        Name used for the generated systemd unit
  --service-user USER        User used in the generated systemd unit
  --write-systemd            Also generate config/<service-name>.service and config/<service-name>-rendezvous.service
  --force                    Remove an existing target directory before writing
  -h, --help                 Show this help
USAGE
}

env_quote() {
  local value="$1"
  value=${value//"'"/"'\\''"}
  printf "'%s'" "$value"
}

resolve_webview_source() {
  if [ -n "$WEBVIEW_SOURCE" ]; then
    if [ -d "$WEBVIEW_SOURCE" ]; then
      printf '%s\n' "$WEBVIEW_SOURCE"
      return 0
    fi
    echo "Configured webview source not found: $WEBVIEW_SOURCE" >&2
    exit 1
  fi

  local candidate
  for candidate in \
    "$REPO_DIR/patch-work/local/extract/webview" \
    "$REPO_DIR/.sandbox/codex-app/content/webview"
  do
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "No webview source found. Pass --webview-source DIR or prepare patch-work/local/extract/webview." >&2
  exit 1
}

copy_tree() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  cp -R "$src"/. "$dest"/
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      TARGET_DIR="$2"
      shift 2
      ;;
    --webview-source)
      WEBVIEW_SOURCE="$2"
      shift 2
      ;;
    --relay-host)
      RELAY_HOST="$2"
      shift 2
      ;;
    --relay-port)
      RELAY_PORT="$2"
      shift 2
      ;;
    --rendezvous-host)
      RENDEZVOUS_HOST="$2"
      shift 2
      ;;
    --rendezvous-port)
      RENDEZVOUS_PORT="$2"
      shift 2
      ;;
    --host-token)
      HOST_TOKEN="$2"
      shift 2
      ;;
    --client-token)
      CLIENT_TOKEN="$2"
      SESSION_SECRET="${SESSION_SECRET:-$CLIENT_TOKEN}"
      shift 2
      ;;
    --session-secret)
      SESSION_SECRET="$2"
      shift 2
      ;;
    --public-origin)
      PUBLIC_ORIGIN="$2"
      shift 2
      ;;
    --public-rendezvous-origin)
      PUBLIC_RENDEZVOUS_ORIGIN="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --service-user)
      SERVICE_USER="$2"
      shift 2
      ;;
    --write-systemd)
      WRITE_SYSTEMD=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

WEBVIEW_SOURCE="$(resolve_webview_source)"
TARGET_DIR="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$TARGET_DIR")"
if [ -z "$PUBLIC_ORIGIN" ]; then
  if [ "$RELAY_HOST" = "0.0.0.0" ] || [ "$RELAY_HOST" = "::" ]; then
    PUBLIC_ORIGIN="http://127.0.0.1:$RELAY_PORT"
  else
    PUBLIC_ORIGIN="http://$RELAY_HOST:$RELAY_PORT"
  fi
fi
if [ -z "$PUBLIC_RENDEZVOUS_ORIGIN" ]; then
  if [ "$RENDEZVOUS_HOST" = "0.0.0.0" ] || [ "$RENDEZVOUS_HOST" = "::" ]; then
    PUBLIC_RENDEZVOUS_ORIGIN="http://127.0.0.1:$RENDEZVOUS_PORT"
  else
    PUBLIC_RENDEZVOUS_ORIGIN="http://$RENDEZVOUS_HOST:$RENDEZVOUS_PORT"
  fi
fi

if [ -e "$TARGET_DIR" ] && [ "$FORCE" = "1" ]; then
  rm -rf "$TARGET_DIR"
fi

mkdir -p "$TARGET_DIR/remote/relay-server" "$TARGET_DIR/remote/rendezvous-server" "$TARGET_DIR/remote/protocol" "$TARGET_DIR/remote/server" "$TARGET_DIR/config" "$TARGET_DIR/webview"

cp "$REPO_DIR/remote/relay-server/server.mjs" "$TARGET_DIR/remote/relay-server/server.mjs"
cp "$REPO_DIR/remote/rendezvous-server/server.mjs" "$TARGET_DIR/remote/rendezvous-server/server.mjs"
cp "$REPO_DIR/remote/protocol/remote-protocol.mjs" "$TARGET_DIR/remote/protocol/remote-protocol.mjs"
cp "$REPO_DIR/remote/server/server.mjs" "$TARGET_DIR/remote/server/server.mjs"
cp "$REPO_DIR/remote/server/install-systemd-service.sh" "$TARGET_DIR/install-systemd-service.sh"
copy_tree "$WEBVIEW_SOURCE" "$TARGET_DIR/webview"

cat > "$TARGET_DIR/config/relay.env" <<ENV
CODEX_REMOTE_RELAY_HOST=$(env_quote "$RELAY_HOST")
CODEX_REMOTE_RELAY_PORT=$(env_quote "$RELAY_PORT")
CODEX_REMOTE_HOST_TOKEN=$(env_quote "$HOST_TOKEN")
CODEX_REMOTE_CLIENT_TOKEN=$(env_quote "$CLIENT_TOKEN")
CODEX_REMOTE_SESSION_SECRET=$(env_quote "$SESSION_SECRET")
CODEX_REMOTE_RENDEZVOUS_ORIGIN=$(env_quote "$PUBLIC_RENDEZVOUS_ORIGIN")
CODEX_REMOTE_WEBVIEW_SOURCE=$(env_quote "$TARGET_DIR/webview")
ENV

cat > "$TARGET_DIR/config/rendezvous.env" <<ENV
CODEX_REMOTE_RENDEZVOUS_HOST=$(env_quote "$RENDEZVOUS_HOST")
CODEX_REMOTE_RENDEZVOUS_PORT=$(env_quote "$RENDEZVOUS_PORT")
CODEX_REMOTE_RENDEZVOUS_ORIGIN=$(env_quote "$PUBLIC_RENDEZVOUS_ORIGIN")
CODEX_REMOTE_RELAY_ORIGIN=$(env_quote "$PUBLIC_ORIGIN")
CODEX_REMOTE_HOST_TOKEN=$(env_quote "$HOST_TOKEN")
CODEX_REMOTE_CLIENT_TOKEN=$(env_quote "$CLIENT_TOKEN")
CODEX_REMOTE_SESSION_SECRET=$(env_quote "$SESSION_SECRET")
ENV

cat > "$TARGET_DIR/run-relay.sh" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck disable=SC1091
. "$SCRIPT_DIR/config/relay.env"
set +a

exec "${NODE_BIN:-node}" "$SCRIPT_DIR/remote/server/server.mjs"
RUN
chmod +x "$TARGET_DIR/run-relay.sh"

cat > "$TARGET_DIR/run-rendezvous.sh" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck disable=SC1091
. "$SCRIPT_DIR/config/rendezvous.env"
set +a

exec "${NODE_BIN:-node}" "$SCRIPT_DIR/remote/rendezvous-server/server.mjs"
RUN
chmod +x "$TARGET_DIR/run-rendezvous.sh"
chmod +x "$TARGET_DIR/install-systemd-service.sh"

cat > "$TARGET_DIR/README.md" <<README
# Codex Remote Server Bundle

Generated by:
- $0

Bundle contents:
- relay entrypoint: ./remote/server/server.mjs
- rendezvous entrypoint: ./remote/rendezvous-server/server.mjs
- relay env: ./config/relay.env
- rendezvous env: ./config/rendezvous.env
- launch helpers: ./run-relay.sh and ./run-rendezvous.sh
- systemd installer: ./install-systemd-service.sh
- copied webview assets: ./webview

Start the relay data plane:

	./run-relay.sh

Start the rendezvous control plane:

	./run-rendezvous.sh

Human browser traffic should enter via rendezvous first; hitting the relay root directly will only redirect there when a deviceId is present, or show a landing page.

Relay listen origin:
- http://$RELAY_HOST:$RELAY_PORT

Relay browser/app origin:
- $PUBLIC_ORIGIN

Rendezvous listen origin:
- http://$RENDEZVOUS_HOST:$RENDEZVOUS_PORT

Rendezvous browser entry origin:
- $PUBLIC_RENDEZVOUS_ORIGIN

If you enable Custom relay in the Codex sandbox app, set:
- Relay origin: $PUBLIC_ORIGIN
- Rendezvous origin: $PUBLIC_RENDEZVOUS_ORIGIN
- Host token: $( [ -n "$HOST_TOKEN" ] && printf 'configured' || printf 'not set' )
- Browser client token: $( [ -n "$CLIENT_TOKEN" ] && printf 'configured (optional override)' || printf 'not set' )
- Browser URL example: $PUBLIC_RENDEZVOUS_ORIGIN/connect?deviceId=your-device
- Browser pairing: enter the pairing code shown in the host app, or append &pairingCode=<pairing-code> for automated testing
README

if [ "$WRITE_SYSTEMD" = "1" ]; then
  cat > "$TARGET_DIR/config/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=Codex Remote Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=$TARGET_DIR
EnvironmentFile=$TARGET_DIR/config/relay.env
ExecStart=/usr/bin/env bash $TARGET_DIR/run-relay.sh
Restart=always
RestartSec=2
User=$SERVICE_USER

[Install]
WantedBy=multi-user.target
UNIT

  cat > "$TARGET_DIR/config/$SERVICE_NAME-rendezvous.service" <<UNIT
[Unit]
Description=Codex Remote Rendezvous
After=network.target

[Service]
Type=simple
WorkingDirectory=$TARGET_DIR
EnvironmentFile=$TARGET_DIR/config/rendezvous.env
ExecStart=/usr/bin/env bash $TARGET_DIR/run-rendezvous.sh
Restart=always
RestartSec=2
User=$SERVICE_USER

[Install]
WantedBy=multi-user.target
UNIT
fi

echo "Created remote server bundle: $TARGET_DIR"
echo "- relay public origin: $PUBLIC_ORIGIN"
echo "- rendezvous public origin: $PUBLIC_RENDEZVOUS_ORIGIN"
echo "- relay env: $TARGET_DIR/config/relay.env"
echo "- rendezvous env: $TARGET_DIR/config/rendezvous.env"
echo "- launch helpers: $TARGET_DIR/run-relay.sh and $TARGET_DIR/run-rendezvous.sh"
if [ "$WRITE_SYSTEMD" = "1" ]; then
  echo "- systemd unit templates: $TARGET_DIR/config/$SERVICE_NAME.service and $TARGET_DIR/config/$SERVICE_NAME-rendezvous.service"
fi
