#!/usr/bin/env python3
import argparse
import os
from pathlib import Path

from remote_webview_server_lib import run_webview_server


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
    sandbox_app_dir = Path(os.environ.get("CODEX_SANDBOX_APP_DIR", repo_dir / ".sandbox" / "codex-app")).resolve()

    if not repo_dir.is_dir():
        raise SystemExit(f"Repository directory not found: {repo_dir}")

    return run_webview_server(
        bind=args.bind,
        port=args.port,
        webview_dir=webview_dir,
        settings_path=settings_path,
        supervisor_script=repo_dir / "scripts" / "sandbox-remote-dev.sh",
        supervisor_cwd=repo_dir,
        supervisor_env={
            "CODEX_SANDBOX_APP_DIR": str(sandbox_app_dir),
            "CODEX_REMOTE_APP_DIR": str(sandbox_app_dir),
        },
        default_device_id="sandbox-local",
        default_webview_origin=f"http://127.0.0.1:{os.environ.get('CODEX_SANDBOX_WEBVIEW_PORT', '55175')}",
        default_cdp_origin=f"http://127.0.0.1:{os.environ.get('CODEX_SANDBOX_REMOTE_DEBUGGING_PORT', '9223')}",
        log_prefix="sandbox-webview",
        server_description="Sandbox webview server",
    )


if __name__ == "__main__":
    raise SystemExit(main())
