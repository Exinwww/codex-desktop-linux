#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="$SCRIPT_DIR"
SERVICE_NAME="${CODEX_REMOTE_SERVER_SERVICE_NAME:-codex-relay}"
SERVICE_USER="${CODEX_REMOTE_SERVER_USER:-codexrelay}"
NODE_BIN="${NODE_BIN:-}"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE_PATH=""
UNIT_TEMPLATE=""
START_AFTER_INSTALL=1
FORCE=0
UNINSTALL=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --bundle-dir DIR      Remote bundle directory that contains run-relay.sh
  --service-name NAME   Systemd unit name without .service suffix
  --service-user USER   User account that should run the service
  --node-bin PATH       Absolute path to the node executable
  --unit-template PATH  Use an existing unit template instead of generating one
  --no-start            Install and enable the service, but do not start/restart it
  --force               Overwrite an existing unit file
  --uninstall           Stop, disable, and remove the installed unit
  -h, --help            Show this help
USAGE
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root." >&2
    exit 1
  fi
}

require_bundle_files() {
  local missing=0
  local path
  for path in \
    "$BUNDLE_DIR/run-relay.sh" \
    "$BUNDLE_DIR/run-rendezvous.sh" \
    "$BUNDLE_DIR/config/relay.env" \
    "$BUNDLE_DIR/config/rendezvous.env" \
    "$BUNDLE_DIR/remote/server/server.mjs" \
    "$BUNDLE_DIR/remote/rendezvous-server/server.mjs" \
    "$BUNDLE_DIR/remote/relay-server/server.mjs" \
    "$BUNDLE_DIR/remote/protocol/remote-protocol.mjs" \
    "$BUNDLE_DIR/webview"
  do
    if [ ! -e "$path" ]; then
      echo "Missing remote bundle asset: $path" >&2
      missing=1
    fi
  done

  if [ "$missing" -ne 0 ]; then
    exit 1
  fi
}

resolve_node_bin() {
  if [ -n "$NODE_BIN" ]; then
    if [ -x "$NODE_BIN" ]; then
      printf '%s\n' "$NODE_BIN"
      return 0
    fi
    echo "Configured --node-bin is not executable: $NODE_BIN" >&2
    exit 1
  fi

  local candidate
  candidate="$(command -v node || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  echo "Could not find a node executable. Pass --node-bin PATH." >&2
  exit 1
}

render_unit() {
  local node_bin="$1"
  cat <<UNIT
[Unit]
Description=Codex Remote Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$BUNDLE_DIR
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_BIN=$node_bin
ExecStart=/usr/bin/env bash $BUNDLE_DIR/run-relay.sh
Restart=always
RestartSec=2
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadOnlyPaths=$BUNDLE_DIR
LimitNOFILE=65535
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
}

install_service() {
  local node_bin="$1"
  local tmp_file
  SERVICE_PATH="$SYSTEMD_DIR/$SERVICE_NAME.service"

  if [ -f "$SERVICE_PATH" ] && [ "$FORCE" != "1" ]; then
    echo "Service file already exists: $SERVICE_PATH" >&2
    echo "Re-run with --force to overwrite it." >&2
    exit 1
  fi

  tmp_file="$(mktemp)"
  if [ -n "$UNIT_TEMPLATE" ]; then
    cp "$UNIT_TEMPLATE" "$tmp_file"
  else
    render_unit "$node_bin" > "$tmp_file"
  fi
  install -m 0644 "$tmp_file" "$SERVICE_PATH"
  rm -f "$tmp_file"

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME.service"

  if [ "$START_AFTER_INSTALL" = "1" ]; then
    if systemctl is-active --quiet "$SERVICE_NAME.service"; then
      systemctl restart "$SERVICE_NAME.service"
    else
      systemctl start "$SERVICE_NAME.service"
    fi
  fi

  echo "Installed systemd service: $SERVICE_PATH"
  if [ "$START_AFTER_INSTALL" = "1" ]; then
    echo "Service status:"
    systemctl --no-pager --full status "$SERVICE_NAME.service" || true
  else
    echo "Service installed and enabled. Start it manually with: systemctl start $SERVICE_NAME.service"
  fi
}

uninstall_service() {
  SERVICE_PATH="$SYSTEMD_DIR/$SERVICE_NAME.service"

  if [ -f "$SERVICE_PATH" ]; then
    systemctl stop "$SERVICE_NAME.service" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME.service" 2>/dev/null || true
    rm -f "$SERVICE_PATH"
    systemctl daemon-reload
    echo "Removed systemd service: $SERVICE_PATH"
  else
    echo "Service file does not exist: $SERVICE_PATH"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-dir)
      BUNDLE_DIR="$2"
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
    --node-bin)
      NODE_BIN="$2"
      shift 2
      ;;
    --unit-template)
      UNIT_TEMPLATE="$2"
      shift 2
      ;;
    --no-start)
      START_AFTER_INSTALL=0
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
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

BUNDLE_DIR="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$BUNDLE_DIR")"
if [ -n "$UNIT_TEMPLATE" ]; then
  UNIT_TEMPLATE="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$UNIT_TEMPLATE")"
fi

require_root

if [ "$UNINSTALL" = "1" ]; then
  uninstall_service
  exit 0
fi

require_bundle_files
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user does not exist: $SERVICE_USER" >&2
  echo "Create it first, for example: useradd --system --home $BUNDLE_DIR --shell /usr/sbin/nologin $SERVICE_USER" >&2
  exit 1
fi
if [ -n "$UNIT_TEMPLATE" ] && [ ! -f "$UNIT_TEMPLATE" ]; then
  echo "Unit template not found: $UNIT_TEMPLATE" >&2
  exit 1
fi

NODE_BIN="$(resolve_node_bin)"
install_service "$NODE_BIN"
