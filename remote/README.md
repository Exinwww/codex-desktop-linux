# Remote Relay Frontend MVP

This remote prototype now follows the same UI path as the local Codex app instead of rendering a custom control page.

## Architecture

1. `remote/host-agent/server.mjs`
   - attaches to the live sandboxed Codex renderer through Chromium DevTools on `localhost:9223`
   - injects a small runtime bridge into the real Codex webview
   - forwards renderer message events, worker events, and bridge RPC calls to the relay
2. `remote/rendezvous-server/server.mjs`
   - registers online devices and issues short-lived relay session tokens for browsers
   - validates client tokens before redirecting browsers to the relay UI
3. `remote/relay-server/server.mjs`
   - serves the original extracted Codex webview assets as the remote browser frontend
   - injects a browser-side shim that emulates `window.electronBridge`
   - relays bridge calls and event streams between the remote browser and the host agent
4. remote browser
   - loads the actual Codex webview shell instead of a lookalike page
   - keeps the same asset bundle, routes, styles, and React tree as the local app

## Localhost debug workflow

Launch the sandboxed Codex app:

```bash
./scripts/sandbox-run.sh
```

Then open Settings -> Remote -> Remote relay and enable the sandbox remote
switch. The sandbox webview server persists that choice and starts/stops the
localhost relay plus host agent automatically. The old manual workflow,
`./scripts/sandbox-remote-dev.sh`, still works when you want to debug the relay
independently of the app wrapper.

Open the remote frontend through the rendezvous entrypoint:

```text
http://127.0.0.1:9002/connect?deviceId=sandbox-local
```

Localhost and public deployments now use the same browser flow: open rendezvous first, then enter the pairing code shown in the host app. The relay root is no longer the primary human entrypoint. If you open the relay URL directly with a `deviceId`, it redirects into rendezvous; otherwise it shows a small landing page.

## Current limits

- The remote browser now reuses the real Codex frontend bundle, but the relay shim only covers the Electron bridge surface needed by the current remote path.
- Some native integrations may still need extra bridge methods as more routes and features are exercised.
- The sandbox here blocks binding localhost ports, so full end-to-end runtime verification must be done on the host machine outside this restricted execution environment.


## Standalone relay server bundle

A deployment-friendly server module now lives under `remote/server/` and now packages both the relay and rendezvous services:

- `remote/server/server.mjs` - stable relay entrypoint for deployed machines
- `remote/rendezvous-server/server.mjs` - rendezvous control plane
- `remote/server/env.example` - example environment file
- `remote/server/setup-relay-server.sh` - generates a standalone bundle with:
  - `run-relay.sh`
  - `run-rendezvous.sh`
  - `config/relay.env`
  - `config/rendezvous.env`
  - optional systemd unit templates
  - copied Codex webview assets

Example:

```bash
./remote/server/setup-relay-server.sh \
  --target /opt/codex-remote \
  --relay-host 0.0.0.0 \
  --relay-port 9001 \
  --rendezvous-host 0.0.0.0 \
  --rendezvous-port 9002 \
  --public-origin https://relay.example.com \
  --public-rendezvous-origin https://rv.example.com \
  --host-token 'replace-me' \
  --client-token 'browser-secret' \
  --write-systemd
```

Then on the server:

```bash
cd /opt/codex-remote
./run-rendezvous.sh
./run-relay.sh
```

When `CODEX_REMOTE_CLIENT_TOKEN` is configured on the rendezvous service, the remote browser should open the rendezvous URL first. The relay service itself should be treated as a data plane endpoint, not the user-facing entrypoint:

```text
https://rv.example.com/connect?deviceId=your-device
```

Then enter the pairing code shown in the host app. For automation or headless testing, you can still append `&pairingCode=...` or use a configured `clientToken`.
