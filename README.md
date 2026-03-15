# Codex Desktop for Linux

Run [OpenAI Codex Desktop](https://openai.com/codex/) on Linux by converting the official macOS app bundle into a Linux-ready Electron app.

This repo now has three clear layers:

1. `install.sh` converts `Codex.dmg` into a runnable `codex-app/`
2. your private local helper can reapply custom patches to `app.asar`
3. `build-deb.sh` packages the finished app into a Debian package

## Quick start

If you only want to use a prebuilt Debian package, you do not need the compiler toolchains from the build instructions.

### Install a prebuilt `.deb` on Debian or Ubuntu

Install the minimum prerequisites:

```bash
sudo apt update
sudo apt install -y nodejs npm
```

Install the package, then let `apt` resolve any missing runtime libraries:

```bash
sudo dpkg -i ./codex-desktop-linux_<app-version>-1_amd64.deb
sudo apt -f install -y
```

Install the Codex CLI required by the desktop launcher:

```bash
npm i -g @openai/codex
```

Then launch `Codex Desktop` from the app menu, or run:

```bash
codex-desktop
```

## Repository layout

Tracked source files:

- `install.sh` - convert the official DMG into `codex-app/`
- `build-deb.sh` - package `codex-app/` into `dist/*.deb`
- `packaging/deb/` - launcher, desktop file, and Debian metadata assets
- `patches/codex-desktop/` - reusable patch bundle assets committed to git
- `README.md` - end-to-end workflow and maintenance notes

Generated or local-only paths:

- `codex-app/` - generated Linux app bundle
- `dist/` - generated Debian packages
- `.cache/` - downloaded helper tools such as modern `7-Zip`
- `.sandbox/` - isolated development app, user data, and patch workdirs
- `patch-work/` - temporary extraction and repack workdirs
- `local/` - private helper scripts, intentionally gitignored
- `Codex.dmg` - optional local copy of the upstream macOS installer

## Development sandbox

If you want to experiment on a separate copy without touching your main app,
use the sandbox helpers under `scripts/`.

The sandbox uses the normal `install.sh` output format, but keeps its own files
under `./.sandbox/`:

- app files under `./.sandbox/codex-app/`
- patch workdirs under `./.sandbox/patch-work/`
- Electron profile data under `./.sandbox/profile/`

Create or refresh the sandbox from the latest DMG:

```bash
./scripts/sandbox-install.sh /path/to/Codex.dmg
```

If you omit the DMG path, the helper falls back to the same auto-download logic
as `install.sh`.

Reapply the committed patch bundle after editing files under
`patches/codex-desktop/`:

```bash
./scripts/sandbox-repatch.sh
```

Launch the isolated app copy:

```bash
./scripts/sandbox-run.sh
```

The sandbox runner wraps the separate app copy instead of changing the main
installer. It also points Electron at isolated XDG config/data/cache paths.

By default the sandbox retargets the bundled app to webview port `55175`, so
it can run alongside the normal app on `5175`. If you change the sandbox port
later, rerun `./scripts/sandbox-repatch.sh` so the sandbox bundle and wrapper
stay aligned.

You can override the sandbox paths with these environment variables:

- `CODEX_SANDBOX_ROOT`
- `CODEX_SANDBOX_APP_DIR`
- `CODEX_SANDBOX_PROFILE_DIR`

The sandbox runner also accepts:

- `CODEX_SANDBOX_WEBVIEW_HOST`
- `CODEX_SANDBOX_WEBVIEW_PORT`
- `CODEX_SANDBOX_REMOTE_DEBUGGING_PORT`
- `CODEX_SANDBOX_OPEN_DEVTOOLS`

The sandbox repatch step also forces DevTools, Inspect Element, and the debug
menu on inside the sandbox bundle only. By default `sandbox-run.sh` opens
Chromium DevTools and exposes a remote debugging endpoint on port `9223`.

For quick UI experiments, edit the tracked dev override at
`./sandbox/dev/codex-appearance-dev.css`, then sync or launch it with:

```bash
./scripts/sandbox-dev-sync.sh
./scripts/sandbox-dev.sh
```

`sandbox-dev-sync.sh` copies that file into the sandbox webview assets and
injects an `@import` for `codex-appearance-dev.css` into the extracted theme
CSS, so you can iterate on appearance changes without rebuilding the app or
repacking `app.asar`.

## Remote relay sandbox MVP

For localhost-only remote debugging, the workspace now includes a relay MVP
under `remote/` that serves the original Codex webview frontend instead of a
custom lookalike page:

- `remote/host-agent/server.mjs` attaches to the live sandboxed Codex renderer
  over Chromium DevTools and injects a relay bridge into the real webview
- `remote/relay-server/server.mjs` serves the extracted Codex webview assets,
  injects a browser shim for `window.electronBridge`, and relays events/RPCs
- the remote browser therefore loads the same frontend bundle, styling, and
  routes as the local Codex app

Launch the sandboxed Codex app:

```bash
./scripts/sandbox-run.sh
```

Then open Settings -> Remote -> Remote relay and enable the sandbox remote toggle.
That setting persists across future `sandbox-run.sh` launches and starts/stops the
localhost relay plus host agent automatically. If you still want the old manual
workflow for debugging the relay in isolation, `./scripts/sandbox-remote-dev.sh`
continues to work.

For a standalone relay deployment bundle, you can either call the low-level generator directly or use the project-root wrapper:

```bash
./scripts/build-relay-bundle.sh --public-origin https://relay.example.com --public-rendezvous-origin https://rv.example.com --client-token 'browser-secret'
```

Equivalent low-level command:

```bash
./remote/server/setup-relay-server.sh \
  --target /opt/codex-remote \
  --public-origin https://relay.example.com \
  --public-rendezvous-origin https://rv.example.com \
  --client-token 'browser-secret' \
  --write-systemd
```

That produces a self-contained remote server directory with `run-relay.sh`, `run-rendezvous.sh`,
`config/relay.env`, `config/rendezvous.env`, copied webview assets, and optional systemd unit templates.

Open the remote frontend through the rendezvous entrypoint:

```text
http://127.0.0.1:9002/connect?deviceId=sandbox-local
```

That URL is now the same in localhost and public deployments: the browser always enters through rendezvous, then types the pairing code shown in the host app before a relay session is created. The relay root only redirects into rendezvous or shows a landing page.

## Requirements

For a prebuilt `.deb`, you only need:

- `Node.js`
- `npm`
- the `codex` CLI (`npm i -g @openai/codex`)

For building the Linux app from the macOS DMG, you also need:

```bash
npm i -g @openai/codex
```

- `Node.js 20+`
- `npm`
- `Python 3`
- `curl`
- `tar`
- `unzip`
- build tools with working C++20 support

The installer prefers a recent `7-Zip` (`7zz`/`7z`, version 22+). If your distro only ships old `p7zip` 16.x, `install.sh` downloads the official Linux `7-Zip` binary into `.cache/` automatically.

### Debian/Ubuntu

```bash
sudo apt install nodejs npm python3 curl tar unzip build-essential
sudo apt install gcc-12 g++-12
```

Optional fallback if you prefer Clang and your distro provides it:

```bash
sudo apt install clang-18 libc++-18-dev libc++abi-18-dev
```

### Fedora

```bash
sudo dnf install nodejs npm python3 curl tar unzip
sudo dnf groupinstall 'Development Tools'
```

### Arch

```bash
sudo pacman -S nodejs npm python curl tar unzip base-devel
```

## End-to-end workflow

### 1. Convert the official DMG into a Linux app

Auto-download the current DMG:

```bash
./install.sh
```

Or use a DMG you already downloaded:

```bash
./install.sh /path/to/Codex.dmg
```

This produces:

```text
./codex-app/
```

### 2. Reapply local custom patches

If you maintain a private helper in `local/`, run it after every new `install.sh` output so the generated `codex-app/resources/app.asar` and sibling `content/webview/` shell pick up your local fixes again.

Typical local command:

```bash
./local/apply_codex_patch.py ./codex-app/resources/app.asar
```

In this workspace, the committed patch bundle under `patches/codex-desktop/` is designed for:

- bundled `Ubuntu` / `Ubuntu Mono` fonts
- Linux project picker fixes
- the recommended-skills clone workaround

If OpenAI changes the bundle layout in a future release, adjust `patches/codex-desktop/manifest.json` and rerun your local helper.

### 3. Run the unpacked app

```bash
./codex-app/start.sh
```

Optional custom install directory while converting:

```bash
CODEX_INSTALL_DIR=/opt/codex ./install.sh
```

### 4. Build a Debian package

Once `codex-app/` is in the exact state you want, package it:

```bash
./build-deb.sh
```

This writes a package to:

```text
./dist/codex-desktop-linux_<version>_<arch>.deb
```

Useful overrides:

```bash
MAINTAINER_NAME="Your Name" \
MAINTAINER_EMAIL="you@example.com" \
PACKAGE_NAME="codex-desktop-linux" \
./build-deb.sh
```

### 5. Install the Debian package

```bash
sudo dpkg -i ./dist/codex-desktop-linux_<version>_<arch>.deb
sudo apt -f install
```

Then make sure the Codex CLI exists for the launcher:

```bash
npm i -g @openai/codex
```

## GitHub Actions release automation

The workflow [`release-deb.yml`](.github/workflows/release-deb.yml) runs on `ubuntu-20.04` and can be triggered manually or on the daily schedule.

It performs the full pipeline:

1. downloads the latest upstream `Codex.dmg`
2. runs `install.sh`
3. reapplies the committed patch bundle from `patches/codex-desktop/`
4. runs `build-deb.sh`
5. publishes `dist/*.deb` to a GitHub Release tagged with the Codex app version and Ubuntu target, for example `codex-desktop-linux-v26.309.31024-ubuntu20.04`

The workflow uses the repository `GITHUB_TOKEN` with `contents: write` so it can create or update the release for a given upstream app version.

The daily scheduled run checks the Codex app version found inside the latest DMG and skips patching, packaging, and release publishing when a release for that exact app version on Ubuntu 20.04 already exists.

## Updating to a new Codex release

When a new upstream `Codex.dmg` appears, redo the build in this order:

```bash
./install.sh /path/to/new/Codex.dmg
./local/apply_codex_patch.py ./codex-app/resources/app.asar   # if you keep the local helper
./build-deb.sh                                                # optional
```

Important detail: `build-deb.sh` packages the current contents of `codex-app/` exactly as they are. If you want your fonts or JS fixes inside the `.deb`, apply your local patch before running `build-deb.sh`.

## How it works

The macOS Codex app is an Electron app. The platform-independent JavaScript lives in `app.asar`, but the original bundle also includes:

- native modules compiled for macOS
- a macOS Electron runtime
- macOS-only updater pieces such as `sparkle`

`install.sh` extracts the DMG, swaps in a Linux Electron runtime, rebuilds native modules such as `node-pty` and `better-sqlite3`, removes macOS-only pieces, and creates a Linux launcher.

`build-deb.sh` does not rebuild the app; it simply packages the current `codex-app/` tree together with the desktop launcher assets from `packaging/deb/`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Error: write EPIPE` | Run `start.sh` directly; do not pipe its output |
| `Open ERROR: Can not open the file as [Dmg] archive` | Your `7z` is too old; rerun `install.sh` and let it fetch a newer 7-Zip, or install `7zz` 22+ |
| `g++: error: unrecognized command line option '-std=c++20'` or `fatal error: 'compare' file not found` | Install GCC 10+ or Clang with a working C++20 standard library |
| Blank window | Check whether port `5175` is already in use: `lsof -i :5175` |
| `Codex CLI not found` | Install it with `npm i -g @openai/codex`, or set `CODEX_CLI_PATH` manually |
| App menu icon is correct but taskbar icon is wrong | Reinstall the latest `.deb`, remove any old pinned icon, then re-pin the running app |
| GPU/rendering issues | Try `./codex-app/start.sh --disable-gpu` |
| Sandbox errors | The launcher already adds `--no-sandbox` |

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI.

Make sure you understand the redistribution implications before publicly sharing repackaged application bundles.

## License

MIT

If you configure a relay-side browser token, open the remote UI with a URL like:

```text
https://relay.example.com/?deviceId=your-device&clientToken=browser-secret
```
