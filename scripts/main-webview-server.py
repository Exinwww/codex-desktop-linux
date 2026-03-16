#!/usr/bin/env python3
import argparse
import os
from pathlib import Path

from remote_webview_server_lib import run_webview_server


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the Codex app webview with embedded remote controls.")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--webview-dir", required=True)
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--settings-file", required=True)
    args = parser.parse_args()

    webview_dir = Path(args.webview_dir).resolve()
    app_dir = Path(args.app_dir).resolve()
    settings_path = Path(args.settings_file).resolve()

    return run_webview_server(
        bind=args.bind,
        port=args.port,
        webview_dir=webview_dir,
        settings_path=settings_path,
        supervisor_script=app_dir / "codex-remote-supervisor.sh",
        supervisor_cwd=app_dir,
        supervisor_env={
            "CODEX_APP_DIR": str(app_dir),
            "CODEX_REMOTE_APP_DIR": str(app_dir),
        },
        default_device_id="local-device",
        default_webview_origin="http://127.0.0.1:5175",
        default_cdp_origin=f"http://127.0.0.1:{os.environ.get('CODEX_REMOTE_CDP_PORT', '9222')}",
        log_prefix="codex-webview",
        server_description="Codex webview server",
    )


if __name__ == "__main__":
    raise SystemExit(main())
