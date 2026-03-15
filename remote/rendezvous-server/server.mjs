import http from 'node:http';
import {
  DEFAULT_RELAY_ORIGIN,
  DEFAULT_RENDEZVOUS_ORIGIN,
  DEFAULT_RENDEZVOUS_PORT,
  DEVICE_TTL_MS,
  badRequest,
  createHostStatePatch,
  createSessionToken,
  getRouteParts,
  isPreflight,
  methodNotAllowed,
  notFound,
  nowIso,
  readJsonBody,
  sanitizeDeviceId,
  sanitizeOrigin,
  sendJson,
  verifySessionToken,
  withCors,
} from '../protocol/remote-protocol.mjs';

const RENDEZVOUS_PORT = Number.parseInt(process.env.CODEX_REMOTE_RENDEZVOUS_PORT ?? `${DEFAULT_RENDEZVOUS_PORT}`, 10);
const RENDEZVOUS_HOST = process.env.CODEX_REMOTE_RENDEZVOUS_HOST ?? '127.0.0.1';
const RENDEZVOUS_ORIGIN = sanitizeOrigin(process.env.CODEX_REMOTE_RENDEZVOUS_ORIGIN ?? DEFAULT_RENDEZVOUS_ORIGIN, DEFAULT_RENDEZVOUS_ORIGIN);
const DEFAULT_PUBLIC_RELAY_ORIGIN = sanitizeOrigin(process.env.CODEX_REMOTE_RELAY_ORIGIN ?? DEFAULT_RELAY_ORIGIN, DEFAULT_RELAY_ORIGIN);
const HOST_TOKEN = process.env.CODEX_REMOTE_HOST_TOKEN ?? '';
const CLIENT_TOKEN = process.env.CODEX_REMOTE_CLIENT_TOKEN ?? '';
const SESSION_SECRET = process.env.CODEX_REMOTE_SESSION_SECRET ?? CLIENT_TOKEN;
const DEVICE_TTL = Number.parseInt(process.env.CODEX_REMOTE_DEVICE_TTL_MS ?? `${DEVICE_TTL_MS}`, 10);
const SESSION_TTL_MS = Number.parseInt(process.env.CODEX_REMOTE_SESSION_TTL_MS ?? `${5 * 60_000}`, 10);

function sanitizePairingCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function readBearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return '';
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readClientToken(request, url, payload = null) {
  return request.headers['x-codex-client-token'] || readBearerToken(request) || payload?.clientToken || url.searchParams.get('clientToken') || '';
}

function readPairingCode(request, url, payload = null) {
  return sanitizePairingCode(request.headers['x-codex-pairing-code'] || payload?.pairingCode || url.searchParams.get('pairingCode') || '');
}

function ensureHostAuthorized(request, response) {
  if (!HOST_TOKEN) {
    return true;
  }
  if (request.headers['x-codex-host-token'] === HOST_TOKEN) {
    return true;
  }
  sendJson(response, 403, { ok: false, error: 'Invalid host token' });
  return false;
}

function ensureClientAuthorized(request, response, url) {
  if (!CLIENT_TOKEN) {
    return true;
  }
  const token = readClientToken(request, url);
  if (token === CLIENT_TOKEN) {
    return true;
  }
  sendJson(response, 403, { ok: false, error: 'Invalid client token' });
  return false;
}

function readSessionToken(request, url) {
  return request.headers['x-codex-session-token'] || readBearerToken(request) || url.searchParams.get('sessionToken') || '';
}

function evaluateDeviceAccess(request, url, device, payload = null) {
  const clientToken = readClientToken(request, url, payload);
  if (CLIENT_TOKEN && clientToken === CLIENT_TOKEN) {
    return { ok: true, mode: 'client-token' };
  }

  if (device.pairingCode) {
    const pairingCode = readPairingCode(request, url, payload);
    if (pairingCode && pairingCode === device.pairingCode) {
      return { ok: true, mode: 'pairing-code' };
    }
    return { ok: false, reason: pairingCode ? 'invalid-pairing-code' : 'pairing-required' };
  }

  if (CLIENT_TOKEN) {
    return { ok: false, reason: clientToken ? 'invalid-client-token' : 'client-token-required' };
  }

  return { ok: true, mode: 'open' };
}

class DeviceRegistry {
  constructor() {
    this.devices = new Map();
  }

  register(deviceId, payload) {
    const id = sanitizeDeviceId(deviceId);
    const entry = {
      deviceId: id,
      relayOrigin: sanitizeOrigin(payload.relayOrigin ?? DEFAULT_PUBLIC_RELAY_ORIGIN, DEFAULT_PUBLIC_RELAY_ORIGIN),
      rendezvousOrigin: sanitizeOrigin(payload.rendezvousOrigin ?? RENDEZVOUS_ORIGIN, RENDEZVOUS_ORIGIN),
      pairingCode: sanitizePairingCode(payload.pairingCode),
      state: createHostStatePatch(payload.state ?? {}),
      lastSeenAt: Date.now(),
    };
    this.devices.set(id, entry);
    return entry;
  }

  get(deviceId) {
    return this.devices.get(sanitizeDeviceId(deviceId)) ?? null;
  }

  isOnline(device) {
    return Boolean(device) && Date.now() - device.lastSeenAt <= DEVICE_TTL;
  }

  toClientState(device) {
    return {
      deviceId: device.deviceId,
      relayOrigin: device.relayOrigin,
      rendezvousOrigin: device.rendezvousOrigin,
      requiresPairing: Boolean(device.pairingCode),
      online: this.isOnline(device),
      lastSeenAt: new Date(device.lastSeenAt).toISOString(),
      state: device.state,
    };
  }

  toHostState(device) {
    return {
      ...this.toClientState(device),
      pairingCodeConfigured: Boolean(device.pairingCode),
    };
  }

  list() {
    return [...this.devices.values()]
      .filter((device) => this.isOnline(device))
      .map((device) => this.toClientState(device));
  }

  prune() {
    for (const [deviceId, device] of this.devices) {
      if (!this.isOnline(device)) {
        this.devices.delete(deviceId);
      }
    }
  }
}

const registry = new DeviceRegistry();

function buildSession(device) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = {
    deviceId: device.deviceId,
    relayOrigin: device.relayOrigin,
    rendezvousOrigin: device.rendezvousOrigin,
    issuedAt: Date.now(),
    expiresAt,
  };
  const sessionToken = createSessionToken(payload, SESSION_SECRET || CLIENT_TOKEN || 'codex-remote-session');
  const redirectUrl = new URL(device.relayOrigin);
  redirectUrl.searchParams.set('deviceId', device.deviceId);
  redirectUrl.searchParams.set('sessionToken', sessionToken);
  return {
    deviceId: device.deviceId,
    relayOrigin: device.relayOrigin,
    rendezvousOrigin: device.rendezvousOrigin,
    sessionToken,
    expiresAt,
    redirectUrl: redirectUrl.toString(),
  };
}

function renderLandingPage(url) {
  const deviceId = sanitizeDeviceId(url.searchParams.get('deviceId'));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Remote Rendezvous</title>
    <style>
      body { font-family: sans-serif; margin: 2rem; color: #111; }
      code { background: #f3f3f3; padding: 0.15rem 0.35rem; border-radius: 4px; }
      .box { max-width: 48rem; padding: 1rem 1.25rem; border: 1px solid #ddd; border-radius: 12px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>Codex Remote Rendezvous</h1>
      <p>This endpoint coordinates browser pairing before redirecting to the relay UI.</p>
      <p>Open <code>/connect?deviceId=${deviceId || 'your-device'}</code>, then enter the pairing code shown in the host app.</p>
      <p>For automated flows, you can still provide <code>pairingCode</code> or a configured <code>clientToken</code> directly in the URL.</p>
      <p>API health: <code>/api/health</code></p>
    </div>
  </body>
</html>`;
}

function renderConnectPage(device, access, url) {
  const deviceId = sanitizeDeviceId(device.deviceId);
  const hasClientToken = Boolean(CLIENT_TOKEN);
  const errorMessage = access.reason === 'invalid-pairing-code'
    ? 'The pairing code is invalid. Please try again.'
    : access.reason === 'client-token-required'
      ? 'This relay requires a client token before a session can be created.'
      : access.reason === 'invalid-client-token'
        ? 'The client token is invalid.'
        : null;
  const infoMessage = device.pairingCode
    ? 'Enter the pairing code shown in the host app to continue.'
    : hasClientToken
      ? 'Provide the client token configured on the rendezvous service to continue.'
      : 'This device can be opened immediately.';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect to ${deviceId}</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: sans-serif; margin: 2rem; color: #111; }
      code { background: #f3f3f3; padding: 0.15rem 0.35rem; border-radius: 4px; }
      .box { max-width: 32rem; padding: 1.25rem; border: 1px solid #ddd; border-radius: 12px; }
      .field { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
      input { border: 1px solid #ccc; border-radius: 8px; padding: 0.75rem 0.9rem; font-size: 1rem; }
      button { margin-top: 1rem; border: 0; border-radius: 8px; padding: 0.75rem 1rem; font-size: 1rem; cursor: pointer; background: #111; color: #fff; }
      .error { color: #b42318; margin-top: 0.75rem; }
      .hint { color: #555; font-size: 0.95rem; margin-top: 0.75rem; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>Connect to ${deviceId}</h1>
      <p>${infoMessage}</p>
      ${errorMessage ? `<p class="error">${errorMessage}</p>` : ''}
      <form method="GET" action="/connect">
        <input type="hidden" name="deviceId" value="${deviceId}" />
        ${url.searchParams.get('clientToken') ? `<input type="hidden" name="clientToken" value="${String(url.searchParams.get('clientToken')).replace(/"/g, '&quot;')}" />` : ''}
        ${device.pairingCode ? `
        <label class="field">
          <span>Pairing code</span>
          <input name="pairingCode" type="text" autocomplete="one-time-code" placeholder="Enter pairing code" autofocus />
        </label>` : hasClientToken ? `
        <label class="field">
          <span>Client token</span>
          <input name="clientToken" type="password" autocomplete="off" placeholder="Enter client token" autofocus />
        </label>` : ''}
        <button type="submit">Continue</button>
      </form>
      <p class="hint">Relay: <code>${device.relayOrigin}</code></p>
    </div>
  </body>
</html>`;
}

function sendConnectPage(response, device, access, url) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(renderConnectPage(device, access, url));
}

async function handleRequest(request, response) {
  withCors(response);
  if (isPreflight(request, response)) {
    return;
  }

  const { pathname, url } = getRouteParts(request.url ?? '/');

  if (pathname === '/' || pathname === '/index.html') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(renderLandingPage(url));
    return;
  }

  if (pathname === '/api/health') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    sendJson(response, 200, { ok: true, rendezvousOrigin: RENDEZVOUS_ORIGIN, serverTime: nowIso() });
    return;
  }

  if (pathname === '/api/devices') {
    if (!ensureClientAuthorized(request, response, url)) {
      return;
    }
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    sendJson(response, 200, { ok: true, devices: registry.list(), serverTime: nowIso() });
    return;
  }

  if (pathname === '/api/host/register' || pathname === '/api/host/heartbeat') {
    if (!ensureHostAuthorized(request, response)) {
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const payload = await readJsonBody(request);
    if (!payload.deviceId) {
      badRequest(response, 'Missing deviceId');
      return;
    }
    const device = registry.register(payload.deviceId, payload);
    sendJson(response, 200, { ok: true, device: registry.toHostState(device), serverTime: nowIso() });
    return;
  }

  if (pathname === '/api/client/session') {
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const payload = await readJsonBody(request);
    if (!payload.deviceId) {
      badRequest(response, 'Missing deviceId');
      return;
    }
    const device = registry.get(payload.deviceId);
    if (!device || !registry.isOnline(device)) {
      notFound(response, 'Device is offline');
      return;
    }
    const access = evaluateDeviceAccess(request, url, device, payload);
    if (!access.ok) {
      sendJson(response, 403, { ok: false, error: access.reason ?? 'Access denied' });
      return;
    }
    sendJson(response, 200, { ok: true, session: buildSession(device), serverTime: nowIso() });
    return;
  }

  if (pathname === '/connect') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) {
      badRequest(response, 'Missing deviceId');
      return;
    }
    const device = registry.get(deviceId);
    if (!device || !registry.isOnline(device)) {
      notFound(response, 'Device is offline');
      return;
    }
    const access = evaluateDeviceAccess(request, url, device);
    if (!access.ok) {
      sendConnectPage(response, device, access, url);
      return;
    }
    const session = buildSession(device);
    response.writeHead(302, { location: session.redirectUrl, 'cache-control': 'no-store' });
    response.end();
    return;
  }

  if (pathname === '/api/client/session/verify') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const payload = verifySessionToken(readSessionToken(request, url), SESSION_SECRET || CLIENT_TOKEN || 'codex-remote-session');
    if (!payload) {
      sendJson(response, 403, { ok: false, error: 'Invalid session token' });
      return;
    }
    sendJson(response, 200, { ok: true, payload, serverTime: nowIso() });
    return;
  }

  notFound(response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('[rendezvous-server] request failed', error);
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(RENDEZVOUS_PORT, RENDEZVOUS_HOST, () => {
  console.log(`[rendezvous-server] listening on ${RENDEZVOUS_ORIGIN}`);
});

setInterval(() => {
  registry.prune();
}, 10_000).unref();
