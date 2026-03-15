#!/usr/bin/env python3
import argparse
import atexit
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse
from typing import Optional, Tuple

DEFAULT_RELAY_HOST = os.environ.get("CODEX_REMOTE_RELAY_HOST", "127.0.0.1")
DEFAULT_RELAY_PORT = int(os.environ.get("CODEX_REMOTE_RELAY_PORT", "9001"))
DEFAULT_RELAY_ORIGIN = os.environ.get("CODEX_REMOTE_RELAY_ORIGIN", f"http://{DEFAULT_RELAY_HOST}:{DEFAULT_RELAY_PORT}")
DEFAULT_RENDEZVOUS_HOST = os.environ.get("CODEX_REMOTE_RENDEZVOUS_HOST", DEFAULT_RELAY_HOST)
DEFAULT_RENDEZVOUS_PORT = int(os.environ.get("CODEX_REMOTE_RENDEZVOUS_PORT", "9002"))
DEFAULT_RENDEZVOUS_ORIGIN = os.environ.get("CODEX_REMOTE_RENDEZVOUS_ORIGIN", f"http://{DEFAULT_RENDEZVOUS_HOST}:{DEFAULT_RENDEZVOUS_PORT}")
DEFAULT_DEVICE_ID = os.environ.get("CODEX_REMOTE_DEVICE_ID", "sandbox-local")
DEFAULT_REMOTE_MODE = os.environ.get("CODEX_REMOTE_MODE", "localhost")
DEFAULT_HOST_TOKEN = os.environ.get("CODEX_REMOTE_HOST_TOKEN", "")
ALLOWED_REMOTE_MODES = {"localhost", "custom-relay"}


class RemoteSupervisor:
    def __init__(self, repo_dir: Path, settings_path: Path) -> None:
        self.repo_dir = repo_dir
        self.settings_path = settings_path
        self.script_path = repo_dir / "scripts" / "sandbox-remote-dev.sh"
        self.default_pairing_code = self._generate_pairing_code()
        self.process = None
        self.lock = threading.Lock()
        self.last_error = None
        self.active_signature = None

    def _default_settings(self) -> dict:
        return {
            "enabled": False,
            "mode": DEFAULT_REMOTE_MODE if DEFAULT_REMOTE_MODE in ALLOWED_REMOTE_MODES else "localhost",
            "relayOrigin": self._normalize_origin(DEFAULT_RELAY_ORIGIN, DEFAULT_RELAY_ORIGIN),
            "rendezvousOrigin": self._normalize_origin(DEFAULT_RENDEZVOUS_ORIGIN, DEFAULT_RENDEZVOUS_ORIGIN),
            "deviceId": self._normalize_device_id(DEFAULT_DEVICE_ID),
            "hostToken": str(DEFAULT_HOST_TOKEN),
            "pairingCode": self.default_pairing_code,
        }

    def _normalize_mode(self, value) -> str:
        mode = str(value or "").strip()
        return mode if mode in ALLOWED_REMOTE_MODES else "localhost"

    def _normalize_device_id(self, value) -> str:
        candidate = re.sub(r"[^a-zA-Z0-9._-]", "-", str(value or "").strip())[:128]
        return candidate or DEFAULT_DEVICE_ID

    def _normalize_origin(self, value, fallback: str) -> str:
        candidate = str(value or "").strip() or fallback
        parsed = urlparse(candidate)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return self._normalize_origin(fallback, fallback) if candidate != fallback else fallback
        return f"{parsed.scheme}://{parsed.netloc}"

    def _normalize_host_token(self, value) -> str:
        return str(value or "").strip()

    def _generate_pairing_code(self) -> str:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return "".join(secrets.choice(alphabet) for _ in range(8))

    def _normalize_pairing_code(self, value) -> str:
        candidate = re.sub(r"[^A-Za-z0-9]", "", str(value or "").strip().upper())[:32]
        return candidate or self.default_pairing_code

    def _normalize_settings(self, payload: Optional[dict]) -> dict:
        defaults = self._default_settings()
        data = payload or {}
        return {
            "enabled": bool(data.get("enabled", defaults["enabled"])),
            "mode": self._normalize_mode(data.get("mode", defaults["mode"])),
            "relayOrigin": self._normalize_origin(data.get("relayOrigin", defaults["relayOrigin"]), defaults["relayOrigin"]),
            "rendezvousOrigin": self._normalize_origin(data.get("rendezvousOrigin", defaults["rendezvousOrigin"]), defaults["rendezvousOrigin"]),
            "deviceId": self._normalize_device_id(data.get("deviceId", defaults["deviceId"])),
            "hostToken": self._normalize_host_token(data.get("hostToken", defaults["hostToken"])),
            "pairingCode": self._normalize_pairing_code(data.get("pairingCode", defaults["pairingCode"])),
        }

    def _read_settings(self) -> dict:
        if not self.settings_path.is_file():
            return self._default_settings()

        try:
            payload = json.loads(self.settings_path.read_text(encoding="utf-8"))
        except Exception as error:  # pragma: no cover - defensive path
            self.last_error = f"Failed to read remote settings: {error}"
            return self._default_settings()

        return self._normalize_settings(payload)

    def persist_settings(self, settings: dict) -> dict:
        normalized = self._normalize_settings(settings)
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            **normalized,
            "updatedAt": int(time.time()),
        }
        self.settings_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        return normalized

    def _refresh_process_state(self) -> None:
        process = self.process
        if process is None:
            return

        return_code = process.poll()
        if return_code is None:
            return

        self.process = None
        self.active_signature = None
        self.last_error = f"Remote supervisor exited with code {return_code}."

    def _launch_mode(self, settings: dict) -> str:
        return "all-in-one" if settings["mode"] == "localhost" else "host-agent-only"

    def _parse_relay_origin(self, relay_origin: str) -> Tuple[str, int]:
        parsed = urlparse(relay_origin)
        host = parsed.hostname or DEFAULT_RELAY_HOST
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return host, port

    def _config_signature(self, settings: dict) -> tuple:
        return (
            settings["mode"],
            settings["relayOrigin"],
            settings["rendezvousOrigin"],
            settings["deviceId"],
            settings["hostToken"],
            settings["pairingCode"],
        )

    def status(self) -> dict:
        with self.lock:
            self._refresh_process_state()
            settings = self._read_settings()
            running = self.process is not None and self.process.poll() is None
            connect_url = f"{settings['rendezvousOrigin']}/connect?deviceId={quote(settings['deviceId'])}"
            return {
                **settings,
                "running": running,
                "launchMode": self._launch_mode(settings),
                "connectUrl": connect_url,
                "lastError": self.last_error,
            }

    def start_if_enabled(self) -> None:
        settings = self._read_settings()
        if settings["enabled"]:
            self.start(settings)

    def _stop_unlocked(self) -> None:
        process = self.process
        if process is None:
            self.active_signature = None
            return

        if process.poll() is not None:
            self.process = None
            self.active_signature = None
            return

        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

        self.process = None
        self.active_signature = None

    def start(self, settings: Optional[dict] = None) -> None:
        with self.lock:
            self._refresh_process_state()
            effective_settings = self._normalize_settings(settings or self._read_settings())
            signature = self._config_signature(effective_settings)
            if self.process is not None and self.active_signature == signature:
                return

            if self.process is not None:
                self._stop_unlocked()

            relay_host, relay_port = self._parse_relay_origin(effective_settings["relayOrigin"])
            rendezvous_host, rendezvous_port = self._parse_relay_origin(effective_settings["rendezvousOrigin"])
            launch_mode = self._launch_mode(effective_settings)
            env = os.environ.copy()
            env.update({
                "CODEX_REMOTE_MODE": effective_settings["mode"],
                "CODEX_REMOTE_LAUNCH_MODE": launch_mode,
                "CODEX_REMOTE_RELAY_ORIGIN": effective_settings["relayOrigin"],
                "CODEX_REMOTE_RELAY_HOST": relay_host,
                "CODEX_REMOTE_RELAY_PORT": str(relay_port),
                "CODEX_REMOTE_RENDEZVOUS_ORIGIN": effective_settings["rendezvousOrigin"],
                "CODEX_REMOTE_RENDEZVOUS_HOST": rendezvous_host,
                "CODEX_REMOTE_RENDEZVOUS_PORT": str(rendezvous_port),
                "CODEX_REMOTE_DEVICE_ID": effective_settings["deviceId"],
                "CODEX_REMOTE_HOST_TOKEN": effective_settings["hostToken"],
                "CODEX_REMOTE_PAIRING_CODE": effective_settings["pairingCode"],
            })

            self.last_error = None
            try:
                self.process = subprocess.Popen(
                    [str(self.script_path)],
                    cwd=str(self.repo_dir),
                    env=env,
                    stdout=sys.stdout,
                    stderr=sys.stderr,
                    text=True,
                )
                self.active_signature = signature
            except Exception as error:
                self.process = None
                self.active_signature = None
                self.last_error = f"Failed to start remote supervisor: {error}"
                raise

    def stop(self) -> None:
        with self.lock:
            self._stop_unlocked()

    def apply_settings(self, payload: dict) -> dict:
        normalized = self.persist_settings({
            **self._read_settings(),
            **(payload or {}),
        })

        if normalized["enabled"]:
            self.start(normalized)
        else:
            self.stop()
            self.last_error = None

        return self.status()


class SandboxRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str, supervisor: RemoteSupervisor, **kwargs):
        self.supervisor = supervisor
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format: str, *args) -> None:
        sys.stdout.write("[sandbox-webview] " + format % args + "\n")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/__codex_dev__/remote-setting":
            self._respond_json(HTTPStatus.OK, self.supervisor.status())
            return
        super().do_GET()

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if path != "/__codex_dev__/remote-setting":
            self._respond_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._respond_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid Content-Length"})
            return

        try:
            body = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            self._respond_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON body"})
            return

        try:
            status = self.supervisor.apply_settings(payload)
        except Exception as error:
            self._respond_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "error": str(error),
                    **self.supervisor.status(),
                },
            )
            return

        self._respond_json(HTTPStatus.OK, status)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _respond_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SandboxWebviewServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the sandbox webview with remote dev controls.")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--webview-dir", required=True)
    parser.add_argument("--repo-dir", required=True)
    parser.add_argument("--settings-file", required=True)
    args = parser.parse_args()

    webview_dir = Path(args.webview_dir).resolve()
    repo_dir = Path(args.repo_dir).resolve()
    settings_path = Path(args.settings_file).resolve()

    if not webview_dir.is_dir():
        raise SystemExit(f"Webview directory not found: {webview_dir}")
    if not repo_dir.is_dir():
        raise SystemExit(f"Repository directory not found: {repo_dir}")

    supervisor = RemoteSupervisor(repo_dir=repo_dir, settings_path=settings_path)
    supervisor.start_if_enabled()
    atexit.register(supervisor.stop)

    def handle_signal(signum, _frame):
        supervisor.stop()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    def handler(*handler_args, **handler_kwargs):
        return SandboxRequestHandler(*handler_args, directory=str(webview_dir), supervisor=supervisor, **handler_kwargs)

    server = SandboxWebviewServer((args.bind, args.port), handler)
    print(f"Sandbox webview server listening on http://{args.bind}:{args.port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()
        supervisor.stop()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
