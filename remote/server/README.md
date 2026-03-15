# Remote Server Bundle

This directory packages the Codex remote relay and rendezvous servers into a deployment-friendly module.

## Files

- `server.mjs` - stable relay entrypoint for the data plane
- `env.example` - example environment configuration
- `setup-relay-server.sh` - prepares a standalone server bundle with relay, rendezvous, env files, and optional systemd units
- `install-systemd-service.sh` - installs, enables, starts, or removes generated systemd units on the target host

## Typical flow

Generate a standalone bundle from the development repository:

```bash
./scripts/build-relay-bundle.sh \
  --public-origin https://relay.example.com \
  --public-rendezvous-origin https://rv.example.com \
  --client-token 'browser-secret'
```

Or call the lower-level generator directly:

```bash
./remote/server/setup-relay-server.sh \
  --target /opt/codex-remote \
  --public-origin https://relay.example.com \
  --public-rendezvous-origin https://rv.example.com \
  --client-token 'browser-secret' \
  --write-systemd
```

Then start the generated services:

```bash
cd /opt/codex-remote
./run-rendezvous.sh
./run-relay.sh
```

Or install them as managed systemd services:

```bash
sudo useradd --system --home /opt/codex-remote --shell /usr/sbin/nologin codexrelay
sudo /opt/codex-remote/install-systemd-service.sh \
  --service-name codex-relay \
  --service-user codexrelay
sudo /opt/codex-remote/install-systemd-service.sh \
  --service-name codex-relay-rendezvous \
  --service-user codexrelay \
  --unit-template /opt/codex-remote/config/codex-relay-rendezvous.service
```

Remote browser URLs should point at the rendezvous service when one is configured. The relay root is only a data plane endpoint and now redirects to rendezvous when it receives a `deviceId` query:

```text
https://rv.example.com/connect?deviceId=your-device
```

Then enter the pairing code shown in the host app. For automation, you can still append `&pairingCode=...` or use a configured `clientToken`.
