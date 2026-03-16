import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import {
  DEFAULT_RELAY_PORT,
  DEFAULT_RENDEZVOUS_ORIGIN,
  DEVICE_TTL_MS,
  HOST_COMMAND_WAIT_MS,
  verifySessionToken,
  badRequest,
  createClientCommand,
  createHostStatePatch,
  getRouteParts,
  isPreflight,
  methodNotAllowed,
  notFound,
  nowIso,
  readJsonBody,
  readRequestBody,
  sanitizeDeviceId,
  sanitizeOrigin,
  sendJson,
  withCors,
} from '../protocol/remote-protocol.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const EXTRACTED_WEBVIEW_ROOT = path.join(WORKSPACE_ROOT, 'patch-work', 'local', 'extract', 'webview');
const SANDBOX_WEBVIEW_ROOT = path.join(WORKSPACE_ROOT, '.sandbox', 'codex-app', 'content', 'webview');
const MAIN_APP_WEBVIEW_ROOT = path.join(WORKSPACE_ROOT, 'content', 'webview');
const RELAY_PORT = Number.parseInt(process.env.CODEX_REMOTE_RELAY_PORT ?? `${DEFAULT_RELAY_PORT}`, 10);
const RELAY_HOST = process.env.CODEX_REMOTE_RELAY_HOST ?? '127.0.0.1';
const RENDEZVOUS_ORIGIN = process.env.CODEX_REMOTE_RENDEZVOUS_ORIGIN
  ? sanitizeOrigin(process.env.CODEX_REMOTE_RENDEZVOUS_ORIGIN, DEFAULT_RENDEZVOUS_ORIGIN)
  : '';
const HOST_TOKEN = process.env.CODEX_REMOTE_HOST_TOKEN ?? '';
const CLIENT_TOKEN = process.env.CODEX_REMOTE_CLIENT_TOKEN ?? '';
const SESSION_SECRET = process.env.CODEX_REMOTE_SESSION_SECRET ?? CLIENT_TOKEN;
const COMMAND_WAIT_MS = Number.parseInt(process.env.CODEX_REMOTE_COMMAND_WAIT_MS ?? `${HOST_COMMAND_WAIT_MS}`, 10);
const DEVICE_TTL = Number.parseInt(process.env.CODEX_REMOTE_DEVICE_TTL_MS ?? `${DEVICE_TTL_MS}`, 10);
const CLIENT_EVENT_WAIT_MS = 20_000;
const COMMAND_RESULT_WAIT_MS = 20_000;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function readBearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return '';
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readClientToken(request, url) {
  return request.headers['x-codex-client-token'] || readBearerToken(request) || url.searchParams.get('clientToken') || '';
}

function readSessionToken(request, url) {
  return request.headers['x-codex-session-token'] || readBearerToken(request) || url.searchParams.get('sessionToken') || '';
}

function ensureClientAuthorized(request, response, url) {
  if (!CLIENT_TOKEN) {
    return true;
  }

  const providedToken = readClientToken(request, url);
  if (providedToken === CLIENT_TOKEN) {
    return true;
  }

  sendJson(response, 403, {
    ok: false,
    error: 'Invalid client token',
  });
  return false;
}

function ensureSessionAuthorized(request, response, url, deviceId) {
  if (!SESSION_SECRET) {
    return ensureClientAuthorized(request, response, url);
  }

  const sessionToken = readSessionToken(request, url);
  const payload = verifySessionToken(sessionToken, SESSION_SECRET);
  if (payload && sanitizeDeviceId(payload.deviceId) === sanitizeDeviceId(deviceId)) {
    return true;
  }

  sendJson(response, 403, {
    ok: false,
    error: 'Invalid or expired session token',
  });
  return false;
}

function ensureHostAuthorized(request, response) {
  if (!HOST_TOKEN) {
    return true;
  }

  const providedToken = request.headers['x-codex-host-token'];
  if (providedToken === HOST_TOKEN) {
    return true;
  }

  sendJson(response, 403, {
    ok: false,
    error: 'Invalid host token',
  });
  return false;
}

function lookupContentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

async function resolveWebviewRoot() {
  for (const candidate of [process.env.CODEX_REMOTE_WEBVIEW_SOURCE, MAIN_APP_WEBVIEW_ROOT, SANDBOX_WEBVIEW_ROOT, EXTRACTED_WEBVIEW_ROOT]) {
    if (!candidate) {
      continue;
    }
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates.
    }
  }

  throw new Error('No Codex webview directory found for remote frontend');
}

class DeviceRegistry {
  constructor() {
    this.devices = new Map();
  }

  getOrCreate(deviceId) {
    const id = sanitizeDeviceId(deviceId);
    let device = this.devices.get(id);
    if (!device) {
      device = {
        deviceId: id,
        state: createHostStatePatch({ status: 'offline' }),
        bridgeBootstrap: null,
        frame: null,
        frameContentType: 'image/jpeg',
        frameUpdatedAt: null,
        commandSeq: 0,
        commandQueue: [],
        pendingCommandPolls: new Set(),
        resultWaiters: new Map(),
        eventSeq: 0,
        eventQueue: [],
        pendingEventPolls: new Set(),
        lastSeenAt: 0,
      };
      this.devices.set(id, device);
    }
    return device;
  }

  registerHost(deviceId, state) {
    const device = this.getOrCreate(deviceId);
    device.lastSeenAt = Date.now();
    device.state = {
      ...device.state,
      ...createHostStatePatch(state),
      status: state.status ?? 'ready',
    };
    if (state.app?.remoteBridge) {
      device.bridgeBootstrap = state.app.remoteBridge;
    }
    return device;
  }

  listVisibleDevices() {
    return [...this.devices.values()]
      .filter((device) => this.isOnline(device))
      .map((device) => this.toClientState(device));
  }

  isOnline(device) {
    return Date.now() - device.lastSeenAt <= DEVICE_TTL;
  }

  toClientState(device) {
    return {
      deviceId: device.deviceId,
      online: this.isOnline(device),
      lastSeenAt: device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : null,
      frameUpdatedAt: device.frameUpdatedAt,
      hasFrame: Boolean(device.frame),
      bridgeReady: Boolean(device.bridgeBootstrap),
      state: device.state,
    };
  }

  setFrame(deviceId, buffer, contentType) {
    const device = this.getOrCreate(deviceId);
    device.frame = buffer;
    device.frameContentType = contentType || 'image/jpeg';
    device.frameUpdatedAt = nowIso();
    return device;
  }

  enqueueCommand(deviceId, command) {
    const device = this.getOrCreate(deviceId);
    const entry = {
      seq: ++device.commandSeq,
      ...createClientCommand(command),
    };
    device.commandQueue.push(entry);
    this.flushPendingCommandPolls(device);
    return entry;
  }

  getCommandsSince(deviceId, cursor) {
    const device = this.getOrCreate(deviceId);
    return {
      device,
      cursor: device.commandSeq,
      commands: device.commandQueue.filter((entry) => entry.seq > cursor),
    };
  }

  async waitForCommands(deviceId, cursor, timeoutMs) {
    const initial = this.getCommandsSince(deviceId, cursor);
    if (initial.commands.length > 0) {
      return initial;
    }

    const device = initial.device;
    return await new Promise((resolve) => {
      const poll = {
        resolve,
        timer: setTimeout(() => {
          device.pendingCommandPolls.delete(poll);
          resolve(this.getCommandsSince(deviceId, cursor));
        }, timeoutMs),
      };
      device.pendingCommandPolls.add(poll);
    });
  }

  flushPendingCommandPolls(device) {
    for (const poll of device.pendingCommandPolls) {
      clearTimeout(poll.timer);
      poll.resolve({
        device,
        cursor: device.commandSeq,
        commands: device.commandQueue,
      });
    }
    device.pendingCommandPolls.clear();
  }

  async waitForResult(deviceId, commandId, timeoutMs) {
    const device = this.getOrCreate(deviceId);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        device.resultWaiters.delete(commandId);
        reject(new Error(`Timed out waiting for command result: ${commandId}`));
      }, timeoutMs);
      device.resultWaiters.set(commandId, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  resolveCommandResult(deviceId, commandId, payload) {
    const device = this.getOrCreate(deviceId);
    const waiter = device.resultWaiters.get(commandId);
    if (!waiter) {
      return false;
    }
    device.resultWaiters.delete(commandId);
    waiter.resolve(payload);
    return true;
  }

  pushEvents(deviceId, events) {
    const device = this.getOrCreate(deviceId);
    const normalized = [];
    for (const event of events) {
      normalized.push({
        seq: ++device.eventSeq,
        createdAt: nowIso(),
        ...event,
      });
    }
    if (normalized.length === 0) {
      return device;
    }
    device.eventQueue.push(...normalized);
    if (device.eventQueue.length > 1000) {
      device.eventQueue.splice(0, device.eventQueue.length - 1000);
    }
    this.flushPendingEventPolls(device);
    return device;
  }

  getEventsSince(deviceId, cursor) {
    const device = this.getOrCreate(deviceId);
    return {
      device,
      cursor: device.eventSeq,
      events: device.eventQueue.filter((entry) => entry.seq > cursor),
    };
  }

  async waitForEvents(deviceId, cursor, timeoutMs) {
    const initial = this.getEventsSince(deviceId, cursor);
    if (initial.events.length > 0) {
      return initial;
    }

    const device = initial.device;
    return await new Promise((resolve) => {
      const poll = {
        resolve,
        timer: setTimeout(() => {
          device.pendingEventPolls.delete(poll);
          resolve(this.getEventsSince(deviceId, cursor));
        }, timeoutMs),
      };
      device.pendingEventPolls.add(poll);
    });
  }

  flushPendingEventPolls(device) {
    for (const poll of device.pendingEventPolls) {
      clearTimeout(poll.timer);
      poll.resolve({
        device,
        cursor: device.eventSeq,
        events: device.eventQueue,
      });
    }
    device.pendingEventPolls.clear();
  }

  prune() {
    for (const [deviceId, device] of this.devices) {
      if (this.isOnline(device)) {
        continue;
      }
      if (!device.frame && device.commandQueue.length === 0 && device.eventQueue.length === 0) {
        this.devices.delete(deviceId);
      }
    }
  }
}

const registry = new DeviceRegistry();
const webviewRootPromise = resolveWebviewRoot();

const REMOTE_SENTRY_INIT_DEFAULTS = Object.freeze({
  codexAppSessionId: 'remote-session',
  appVersion: '0.0.0',
  buildFlavor: 'prod',
});

function normalizeSentryInitOptions(options, bootstrap = {}) {
  return {
    ...REMOTE_SENTRY_INIT_DEFAULTS,
    codexAppSessionId: bootstrap.appSessionId || options?.codexAppSessionId || REMOTE_SENTRY_INIT_DEFAULTS.codexAppSessionId,
    appVersion: typeof options?.appVersion === 'string' && options.appVersion.trim() ? options.appVersion.trim() : REMOTE_SENTRY_INIT_DEFAULTS.appVersion,
    buildFlavor: bootstrap.buildFlavor || options?.buildFlavor || REMOTE_SENTRY_INIT_DEFAULTS.buildFlavor,
    ...(options || {}),
  };
}

function injectRemoteShim(html) {
  const shimTag = '<script type="module" src="/__relay__/remote-shim.js"></script>';
  if (html.includes('/__relay__/remote-shim.js')) {
    return html;
  }

  const withoutCsp = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '\n');
  return withoutCsp.replace('<script type="module" crossorigin src="./assets/index-CywFs2Ob.js"></script>', `${shimTag}\n    <script type="module" crossorigin src="./assets/index-CywFs2Ob.js"></script>`);
}


function buildRendezvousRedirectUrl(url) {
  const rawDeviceId = String(url.searchParams.get('deviceId') ?? '').trim();
  if (!RENDEZVOUS_ORIGIN || !rawDeviceId) {
    return null;
  }

  const redirectUrl = new URL('/connect', `${RENDEZVOUS_ORIGIN}/`);
  redirectUrl.searchParams.set('deviceId', sanitizeDeviceId(rawDeviceId));

  const clientToken = String(url.searchParams.get('clientToken') ?? '').trim();
  if (clientToken) {
    redirectUrl.searchParams.set('clientToken', clientToken);
  }

  const pairingCode = String(url.searchParams.get('pairingCode') ?? '').trim();
  if (pairingCode) {
    redirectUrl.searchParams.set('pairingCode', pairingCode);
  }

  return redirectUrl.toString();
}

function renderRelayLandingPage(url) {
  const rawDeviceId = String(url.searchParams.get('deviceId') ?? '').trim();
  const deviceId = rawDeviceId ? sanitizeDeviceId(rawDeviceId) : 'your-device';
  const connectPath = `/connect?deviceId=${encodeURIComponent(deviceId)}`;
  const rendezvousEntry = RENDEZVOUS_ORIGIN ? `${RENDEZVOUS_ORIGIN}${connectPath}` : null;
  const entryHtml = rendezvousEntry
    ? `<p>Open the browser through rendezvous: <code>${rendezvousEntry}</code></p><p>Enter the pairing code shown in the host app, or append <code>&pairingCode=...</code> for automated testing.</p>`
    : '<p>This relay currently has no rendezvous origin configured. Configure <code>CODEX_REMOTE_RENDEZVOUS_ORIGIN</code> or access it with a valid <code>sessionToken</code>.</p>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Remote Relay</title>
    <style>
      body { font-family: sans-serif; margin: 2rem; color: #111; }
      code { background: #f3f3f3; padding: 0.15rem 0.35rem; border-radius: 4px; }
      .box { max-width: 50rem; padding: 1rem 1.25rem; border: 1px solid #ddd; border-radius: 12px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>Codex Remote Relay</h1>
      <p>This endpoint is the Codex remote data plane. Human browser sessions should enter through rendezvous first.</p>
      ${entryHtml}
      <p>If you already have a browser session token, open <code>/?deviceId=${deviceId}&sessionToken=...</code>.</p>
      <p>API health: <code>/api/health</code></p>
    </div>
  </body>
</html>`;
}

async function serveRelayLandingPage(response, url) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(renderRelayLandingPage(url));
}

async function serveRemoteIndex(response) {
  const webviewRoot = await webviewRootPromise;
  const indexPath = path.join(webviewRoot, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(injectRemoteShim(html));
}

async function serveWebviewFile(response, requestPath) {
  const webviewRoot = await webviewRootPromise;
  const resolvedPath = path.normalize(path.join(webviewRoot, requestPath));
  if (!resolvedPath.startsWith(webviewRoot)) {
    notFound(response);
    return;
  }

  try {
    const fileInfo = await stat(resolvedPath);
    if (!fileInfo.isFile()) {
      notFound(response);
      return;
    }
    const contents = await readFile(resolvedPath);
    response.writeHead(200, {
      'content-type': lookupContentType(resolvedPath),
      'cache-control': 'no-store',
    });
    response.end(contents);
  } catch {
    notFound(response);
  }
}

function getRemoteShimScript() {
  return `
const REMOTE_SENTRY_INIT_DEFAULTS = Object.freeze({
  codexAppSessionId: 'remote-session',
  appVersion: '0.0.0',
  buildFlavor: 'prod',
});

function normalizeSentryInitOptions(options, bootstrap = {}) {
  return {
    ...REMOTE_SENTRY_INIT_DEFAULTS,
    codexAppSessionId: bootstrap.appSessionId || options?.codexAppSessionId || REMOTE_SENTRY_INIT_DEFAULTS.codexAppSessionId,
    appVersion: typeof options?.appVersion === 'string' && options.appVersion.trim() ? options.appVersion.trim() : REMOTE_SENTRY_INIT_DEFAULTS.appVersion,
    buildFlavor: bootstrap.buildFlavor || options?.buildFlavor || REMOTE_SENTRY_INIT_DEFAULTS.buildFlavor,
    ...(options || {}),
  };
}

const deviceId = new URL(window.location.href).searchParams.get('deviceId') || 'sandbox-local';
const bridgeState = {
  deviceId,
  cursor: 0,
  workerListeners: new Map(),
  workerSubscribed: new Set(),
  themeListeners: new Set(),
  requestMethods: new Map(),
  lastHostId: 'local',
  bootstrap: {
    codexWindowType: 'electron',
    codexOs: 'linux',
    systemThemeVariant: 'dark',
    sentryInitOptions: { ...REMOTE_SENTRY_INIT_DEFAULTS },
    appSessionId: 'remote-session',
    buildFlavor: 'prod',
    workspaceRootOptions: { roots: [], labels: {} },
    activeWorkspaceRoots: { roots: [] },
  },
  ready: false,
  readyPromise: null,
  queuedViewMessages: [],
  queuedWorkerMessages: [],
};

function applyWindowMetadata(bootstrap) {
  const nextBootstrap = { ...bridgeState.bootstrap, ...(bootstrap || {}) };
  nextBootstrap.sentryInitOptions = normalizeSentryInitOptions(nextBootstrap.sentryInitOptions, nextBootstrap);
  bridgeState.bootstrap = nextBootstrap;
  const doc = document.documentElement;
  doc.dataset.codexWindowType = 'electron';
  doc.dataset.windowType = 'electron';
  doc.dataset.codexOs = bridgeState.bootstrap.codexOs || 'linux';
  window.codexWindowType = 'electron';
}

applyWindowMetadata(bridgeState.bootstrap);
normalizeRemoteLocationToHome();
window.__SENTRY_DEBUG__ = false;
const sentryIpcStub = {
  sendRendererStart() {},
  sendScope() {},
  sendEnvelope() {},
  sendStatus() {},
  sendStructuredLog() {},
  sendMetric() {},
};
window.__SENTRY_IPC__ = new Proxy(window.__SENTRY_IPC__ || {}, {
  get(target, key) {
    if (key in target) {
      return target[key];
    }
    return sentryIpcStub;
  },
});
const sessionToken = new URL(window.location.href).searchParams.get('sessionToken') || '';
const clientToken = new URL(window.location.href).searchParams.get('clientToken') || '';
const originalFetch = globalThis.fetch.bind(globalThis);
function withClientAuth(init = {}) {
  const headers = new Headers(init.headers || {});
  if (sessionToken && !headers.has('x-codex-session-token')) {
    headers.set('x-codex-session-token', sessionToken);
  }
  if (clientToken && !headers.has('x-codex-client-token')) {
    headers.set('x-codex-client-token', clientToken);
  }
  return { ...init, headers };
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  if (url.startsWith('sentry-ipc://')) {
    return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  const resolvedUrl = new URL(url, window.location.href);
  const nextInit = resolvedUrl.origin === window.location.origin && resolvedUrl.pathname.startsWith('/api/') ? withClientAuth(init) : init;
  return await originalFetch(input, nextInit);
};

async function fetchJson(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

async function bridgeCall(method, args = []) {
  const payload = await fetchJson('/api/client/device/' + encodeURIComponent(deviceId) + '/bridge-call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  return payload.result;
}

function normalizeRemoteLocationToHome() {
  const url = new URL(window.location.href);
  if (url.pathname === '/' && !url.searchParams.has('initialRoute')) {
    return;
  }
  url.pathname = '/';
  url.searchParams.delete('initialRoute');
  const nextUrl = url.toString();
  try {
    window.history.replaceState(null, '', nextUrl);
  } catch {
    window.history.replaceState(window.history.state, '', nextUrl);
  }
}

function synthesizeViewMessage(data) {
  dispatchRemoteEvent({ kind: 'view-message', data });
}

function synthesizeMcpResponse(hostId, id, result, error) {
  const payload = {
    type: 'mcp-response',
    hostId: hostId || bridgeState.lastHostId || 'local',
    message: { id },
  };
  if (error) {
    payload.message.error = error;
  } else {
    payload.message.result = result;
  }
  synthesizeViewMessage(payload);
}

function getWorkspaceRootOptions() {
  const options = bridgeState.bootstrap.workspaceRootOptions;
  const activeRoots = Array.isArray(bridgeState.bootstrap.activeWorkspaceRoots?.roots) ? bridgeState.bootstrap.activeWorkspaceRoots.roots : [];
  const roots = Array.isArray(options?.roots) && options.roots.length > 0 ? options.roots : activeRoots;
  return {
    roots,
    labels: options?.labels && typeof options.labels === 'object' ? options.labels : {},
  };
}

function getActiveWorkspaceRoots() {
  const activeRoots = Array.isArray(bridgeState.bootstrap.activeWorkspaceRoots?.roots) ? bridgeState.bootstrap.activeWorkspaceRoots.roots : [];
  const roots = activeRoots.length > 0 ? activeRoots : getWorkspaceRootOptions().roots;
  return { roots };
}

function synthesizeFetchResponse(hostId, requestId, body, status = 200) {
  synthesizeViewMessage({
    type: 'fetch-response',
    hostId: hostId || bridgeState.lastHostId || 'local',
    requestId,
    responseType: 'success',
    status,
    headers: {},
    bodyJsonString: JSON.stringify(body),
  });
}

function shouldDropViewMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  if (message.type === 'desktop-notification-show' || message.type === 'desktop-notification-hide') {
    return true;
  }
  if (message.type === 'shared-object-unsubscribe') {
    return true;
  }
  return false;
}

async function maybeHandleCompatFetchRequest(message) {
  if (!message || message.type !== 'fetch' || !message.requestId || typeof message.url !== 'string') {
    return false;
  }
  const url = message.url;
  if (url !== 'vscode://codex/workspace-root-options' && url !== 'vscode://codex/active-workspace-roots') {
    return false;
  }
  await ensureReady();
  if (url === 'vscode://codex/workspace-root-options') {
    synthesizeFetchResponse(message.hostId, message.requestId, getWorkspaceRootOptions());
    return true;
  }
  if (url === 'vscode://codex/active-workspace-roots') {
    synthesizeFetchResponse(message.hostId, message.requestId, getActiveWorkspaceRoots());
    return true;
  }
  return false;
}

function maybeHandleCompatMcpRequest(message) {
  if (!message || message.type !== 'mcp-request' || !message.request?.id || !message.request?.method) {
    return false;
  }
  bridgeState.lastHostId = message.hostId || bridgeState.lastHostId || 'local';
  bridgeState.requestMethods.set(message.request.id, message.request.method);
  if (message.request.method === 'plugin/list') {
    queueMicrotask(() => {
      synthesizeMcpResponse(message.hostId, message.request.id, { marketplaces: [] }, null);
    });
    return true;
  }
  if (message.request.method === 'plugin/uninstall') {
    queueMicrotask(() => {
      synthesizeMcpResponse(message.hostId, message.request.id, {}, null);
    });
    return true;
  }
  return false;
}

async function ensureReady() {
  if (bridgeState.ready) {
    return bridgeState.bootstrap;
  }
  if (!bridgeState.readyPromise) {
    bridgeState.readyPromise = (async () => {
      const payload = await fetchJson('/api/client/device/' + encodeURIComponent(deviceId) + '/bootstrap');
      applyWindowMetadata(payload.bootstrap || {});
      bridgeState.ready = true;
      while (bridgeState.queuedViewMessages.length > 0) {
        const message = bridgeState.queuedViewMessages.shift();
        if (shouldDropViewMessage(message)) {
          continue;
        }
        if (await maybeHandleCompatFetchRequest(message)) {
          continue;
        }
        if (maybeHandleCompatMcpRequest(message)) {
          continue;
        }
        await bridgeCall('sendMessageFromView', [message]);
      }
      while (bridgeState.queuedWorkerMessages.length > 0) {
        const [workerId, message] = bridgeState.queuedWorkerMessages.shift();
        await bridgeCall('sendWorkerMessageFromView', [workerId, message]);
      }
      for (const workerId of bridgeState.workerListeners.keys()) {
        if (bridgeState.workerSubscribed.has(workerId)) {
          continue;
        }
        await bridgeCall('subscribeWorker', [workerId]);
        bridgeState.workerSubscribed.add(workerId);
      }
      return bridgeState.bootstrap;
    })();
  }
  return await bridgeState.readyPromise;
}

function dispatchRemoteEvent(event) {
  if (event.kind === 'view-message') {
    const data = event.data;
    if (data?.type === 'mcp-response' && data.message?.id) {
      const method = bridgeState.requestMethods.get(data.message.id);
      bridgeState.requestMethods.delete(data.message.id);
      const errorMessage = typeof data.message.error?.message === 'string' ? data.message.error.message : '';
      if (method === 'thread/resume' && errorMessage.includes('no rollout found for thread id')) {
        console.warn('[remote-shim] thread resume failed for stale route, returning to home', data.message.error);
        setTimeout(() => {
          normalizeRemoteLocationToHome();
          window.location.reload();
        }, 0);
      }
    }
    window.dispatchEvent(new MessageEvent('message', { data: event.data }));
    return;
  }
  if (event.kind === 'worker-message') {
    const listeners = bridgeState.workerListeners.get(event.workerId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event.payload);
    }
    return;
  }
  if (event.kind === 'system-theme-variant') {
    applyWindowMetadata({ systemThemeVariant: event.variant });
    for (const listener of bridgeState.themeListeners) {
      listener();
    }
  }
}

async function eventLoop() {
  while (true) {
    try {
      const payload = await fetchJson('/api/client/device/' + encodeURIComponent(deviceId) + '/events?cursor=' + bridgeState.cursor + '&waitMs=20000');
      bridgeState.cursor = payload.cursor || bridgeState.cursor;
      for (const event of payload.events || []) {
        dispatchRemoteEvent(event);
      }
    } catch (error) {
      console.warn('[remote-shim] event loop error', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

window.electronBridge = {
  windowType: 'electron',
  async sendMessageFromView(message) {
    if (shouldDropViewMessage(message)) {
      return;
    }
    if (await maybeHandleCompatFetchRequest(message)) {
      return;
    }
    if (maybeHandleCompatMcpRequest(message)) {
      return;
    }
    if (!bridgeState.ready) {
      bridgeState.queuedViewMessages.push(message);
      ensureReady().catch((error) => console.warn('[remote-shim] bootstrap failed while flushing sendMessageFromView', error));
      return;
    }
    await bridgeCall('sendMessageFromView', [message]);
  },
  getPathForFile() {
    return null;
  },
  async sendWorkerMessageFromView(workerId, message) {
    if (!bridgeState.ready) {
      bridgeState.queuedWorkerMessages.push([workerId, message]);
      ensureReady().catch((error) => console.warn('[remote-shim] bootstrap failed while flushing worker message', error));
      return;
    }
    await bridgeCall('sendWorkerMessageFromView', [workerId, message]);
  },
  subscribeToWorkerMessages(workerId, callback) {
    let listeners = bridgeState.workerListeners.get(workerId);
    if (!listeners) {
      listeners = new Set();
      bridgeState.workerListeners.set(workerId, listeners);
      if (bridgeState.ready && !bridgeState.workerSubscribed.has(workerId)) {
        bridgeCall('subscribeWorker', [workerId]).then(() => {
          bridgeState.workerSubscribed.add(workerId);
        }).catch((error) => {
          console.warn('[remote-shim] failed to subscribe worker', workerId, error);
        });
      } else {
        ensureReady().catch((error) => console.warn('[remote-shim] bootstrap failed while subscribing worker', error));
      }
    }
    listeners.add(callback);
    return () => {
      const current = bridgeState.workerListeners.get(workerId);
      if (!current) {
        return;
      }
      current.delete(callback);
      if (current.size === 0) {
        bridgeState.workerListeners.delete(workerId);
        if (bridgeState.workerSubscribed.has(workerId)) {
          bridgeState.workerSubscribed.delete(workerId);
          bridgeCall('unsubscribeWorker', [workerId]).catch(() => {});
        }
      }
    };
  },
  async showContextMenu(payload) {
    await ensureReady();
    return await bridgeCall('showContextMenu', [payload]);
  },
  async showApplicationMenu(menuId, x, y) {
    await ensureReady();
    return await bridgeCall('showApplicationMenu', [menuId, x, y]);
  },
  async getFastModeRolloutMetrics(payload) {
    await ensureReady();
    return await bridgeCall('getFastModeRolloutMetrics', [payload]);
  },
  getSystemThemeVariant() {
    return bridgeState.bootstrap.systemThemeVariant || 'dark';
  },
  subscribeToSystemThemeVariant(callback) {
    bridgeState.themeListeners.add(callback);
    return () => bridgeState.themeListeners.delete(callback);
  },
  async triggerSentryTestError() {
    await ensureReady();
    return await bridgeCall('triggerSentryTestError', []);
  },
  getSentryInitOptions() {
    return normalizeSentryInitOptions(bridgeState.bootstrap.sentryInitOptions, bridgeState.bootstrap);
  },
  getAppSessionId() {
    return bridgeState.bootstrap.appSessionId || 'remote-session';
  },
  getBuildFlavor() {
    return bridgeState.bootstrap.buildFlavor || 'prod';
  },
};

ensureReady().then(() => {
  eventLoop().catch((error) => {
    console.warn('[remote-shim] event loop crashed', error);
  });
}).catch((error) => {
  console.error('[remote-shim] bootstrap failed', error);
});
`;
}

async function handleRequest(request, response) {
  withCors(response);
  if (isPreflight(request, response)) {
    return;
  }

  const { pathname, parts, url } = getRouteParts(request.url ?? '/');

  if (pathname === '/' || pathname === '/index.html') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }

    if (readSessionToken(request, url)) {
      await serveRemoteIndex(response);
      return;
    }

    const rendezvousRedirectUrl = buildRendezvousRedirectUrl(url);
    if (rendezvousRedirectUrl) {
      response.writeHead(302, {
        location: rendezvousRedirectUrl,
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }

    await serveRelayLandingPage(response, url);
    return;
  }

  if (pathname === '/__relay__/remote-shim.js') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(getRemoteShimScript());
    return;
  }

  if (pathname.startsWith('/assets/') || pathname.startsWith('/apps/')) {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    await serveWebviewFile(response, pathname.slice(1));
    return;
  }

  if (pathname === '/api/health') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    sendJson(response, 200, {
      ok: true,
      relayOrigin: `http://${RELAY_HOST}:${RELAY_PORT}`,
      rendezvousOrigin: RENDEZVOUS_ORIGIN || null,
      serverTime: nowIso(),
    });
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
    sendJson(response, 200, {
      ok: true,
      devices: registry.listVisibleDevices(),
      serverTime: nowIso(),
    });
    return;
  }

  if (pathname === '/api/host/register') {
    if (!ensureHostAuthorized(request, response)) {
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const payload = await readJsonBody(request);
    const deviceId = sanitizeDeviceId(payload.deviceId);
    const device = registry.registerHost(deviceId, payload.state ?? {});
    sendJson(response, 200, {
      ok: true,
      device: registry.toClientState(device),
      commandCursor: device.commandSeq,
      commandWaitMs: COMMAND_WAIT_MS,
      eventCursor: device.eventSeq,
      serverTime: nowIso(),
    });
    return;
  }

  if (pathname === '/api/host/commands') {
    if (!ensureHostAuthorized(request, response)) {
      return;
    }
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const deviceId = sanitizeDeviceId(url.searchParams.get('deviceId'));
    const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
    const waitMs = Math.min(Math.max(Number.parseInt(url.searchParams.get('waitMs') ?? `${COMMAND_WAIT_MS}`, 10) || COMMAND_WAIT_MS, 50), COMMAND_WAIT_MS);
    const result = await registry.waitForCommands(deviceId, cursor, waitMs);
    sendJson(response, 200, {
      ok: true,
      deviceId,
      cursor: result.cursor,
      commands: result.commands.filter((entry) => entry.seq > cursor),
      serverTime: nowIso(),
    });
    return;
  }

  if (pathname === '/api/host/command-result') {
    if (!ensureHostAuthorized(request, response)) {
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const payload = await readJsonBody(request);
    const deviceId = sanitizeDeviceId(payload.deviceId);
    registry.resolveCommandResult(deviceId, String(payload.commandId), {
      ok: payload.ok !== false,
      result: payload.result,
      error: payload.error ?? null,
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'host' && parts[2] === 'events' && parts[3]) {
    if (!ensureHostAuthorized(request, response)) {
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const payload = await readJsonBody(request);
    const deviceId = sanitizeDeviceId(parts[3]);
    const device = registry.pushEvents(deviceId, Array.isArray(payload.events) ? payload.events : []);
    sendJson(response, 200, {
      ok: true,
      cursor: device.eventSeq,
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'host' && parts[2] === 'frame' && parts[3]) {
    if (!ensureHostAuthorized(request, response)) {
      return;
    }
    if (request.method !== 'PUT') {
      methodNotAllowed(response, ['PUT']);
      return;
    }
    const deviceId = sanitizeDeviceId(parts[3]);
    const buffer = await readRequestBody(request);
    if (buffer.length === 0) {
      badRequest(response, 'Frame payload is empty');
      return;
    }
    const contentType = request.headers['content-type'] || 'image/jpeg';
    const device = registry.setFrame(deviceId, buffer, contentType);
    sendJson(response, 200, {
      ok: true,
      device: registry.toClientState(device),
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'client' && parts[2] === 'device' && parts[3] && parts[4] === 'state') {
    if (!ensureSessionAuthorized(request, response, url, parts[3])) {
      return;
    }
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const device = registry.getOrCreate(parts[3]);
    sendJson(response, 200, {
      ok: true,
      device: registry.toClientState(device),
      serverTime: nowIso(),
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'client' && parts[2] === 'device' && parts[3] && parts[4] === 'bootstrap') {
    if (!ensureSessionAuthorized(request, response, url, parts[3])) {
      return;
    }
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const device = registry.getOrCreate(parts[3]);
    sendJson(response, 200, {
      ok: true,
      device: registry.toClientState(device),
      bootstrap: device.bridgeBootstrap,
      serverTime: nowIso(),
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'client' && parts[2] === 'device' && parts[3] && parts[4] === 'events') {
    if (!ensureSessionAuthorized(request, response, url, parts[3])) {
      return;
    }
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const deviceId = sanitizeDeviceId(parts[3]);
    const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
    const waitMs = Math.min(Math.max(Number.parseInt(url.searchParams.get('waitMs') ?? `${CLIENT_EVENT_WAIT_MS}`, 10) || CLIENT_EVENT_WAIT_MS, 50), CLIENT_EVENT_WAIT_MS);
    const result = await registry.waitForEvents(deviceId, cursor, waitMs);
    sendJson(response, 200, {
      ok: true,
      cursor: result.cursor,
      events: result.events.filter((entry) => entry.seq > cursor),
      serverTime: nowIso(),
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'client' && parts[2] === 'device' && parts[3] && parts[4] === 'bridge-call') {
    if (!ensureSessionAuthorized(request, response, url, parts[3])) {
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const deviceId = sanitizeDeviceId(parts[3]);
    const payload = await readJsonBody(request);
    if (!payload.method) {
      badRequest(response, 'Missing bridge method');
      return;
    }
    const command = registry.enqueueCommand(deviceId, {
      type: 'bridge-call',
      payload: {
        method: payload.method,
        args: Array.isArray(payload.args) ? payload.args : [],
      },
    });
    const result = await registry.waitForResult(deviceId, command.id, COMMAND_RESULT_WAIT_MS);
    if (!result.ok) {
      sendJson(response, 500, {
        ok: false,
        error: result.error ?? 'Bridge call failed',
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      result: result.result,
      serverTime: nowIso(),
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'client' && parts[2] === 'device' && parts[3] && parts[4] === 'frame') {
    if (!ensureSessionAuthorized(request, response, url, parts[3])) {
      return;
    }
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const device = registry.getOrCreate(parts[3]);
    if (!device.frame) {
      notFound(response, 'Frame not available');
      return;
    }
    response.writeHead(200, {
      'content-type': device.frameContentType,
      'cache-control': 'no-store',
      'x-codex-frame-updated-at': device.frameUpdatedAt ?? '',
    });
    response.end(device.frame);
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'client' && parts[2] === 'device' && parts[3] && parts[4] === 'input') {
    if (!ensureSessionAuthorized(request, response, url, parts[3])) {
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const deviceId = sanitizeDeviceId(parts[3]);
    const payload = await readJsonBody(request);
    if (!payload.type) {
      badRequest(response, 'Missing command type');
      return;
    }
    const entry = registry.enqueueCommand(deviceId, payload);
    sendJson(response, 200, {
      ok: true,
      queued: true,
      command: entry,
      serverTime: nowIso(),
    });
    return;
  }

  notFound(response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('[relay-server] request failed', error);
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

server.listen(RELAY_PORT, RELAY_HOST, () => {
  console.log(`[relay-server] listening on http://${RELAY_HOST}:${RELAY_PORT}`);
});

setInterval(() => {
  registry.prune();
}, 10_000).unref();
