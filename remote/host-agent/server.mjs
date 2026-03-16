import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_RELAY_ORIGIN,
  DEFAULT_RENDEZVOUS_ORIGIN,
  HOST_COMMAND_WAIT_MS,
  HOST_HEARTBEAT_MS,
  sanitizeDeviceId,
} from '../protocol/remote-protocol.mjs';

const require = createRequire(import.meta.url);
const DEVICE_ID = sanitizeDeviceId(process.env.CODEX_REMOTE_DEVICE_ID ?? DEFAULT_DEVICE_ID);
const RELAY_ORIGIN = process.env.CODEX_REMOTE_RELAY_ORIGIN ?? DEFAULT_RELAY_ORIGIN;
const HOST_TOKEN = process.env.CODEX_REMOTE_HOST_TOKEN ?? '';
const PAIRING_CODE = String(process.env.CODEX_REMOTE_PAIRING_CODE ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
const RENDEZVOUS_ORIGIN = process.env.CODEX_REMOTE_RENDEZVOUS_ORIGIN ?? '';
const CDP_ORIGIN = process.env.CODEX_REMOTE_CDP_ORIGIN ?? 'http://127.0.0.1:9223';
const WEBVIEW_ORIGIN = process.env.CODEX_REMOTE_WEBVIEW_ORIGIN ?? 'http://127.0.0.1:55175';
const HEARTBEAT_MS = Number.parseInt(process.env.CODEX_REMOTE_HOST_HEARTBEAT_MS ?? `${HOST_HEARTBEAT_MS}`, 10);
const COMMAND_WAIT_MS = Number.parseInt(process.env.CODEX_REMOTE_COMMAND_WAIT_MS ?? `${HOST_COMMAND_WAIT_MS}`, 10);
const FRAME_INTERVAL_MS = Number.parseInt(process.env.CODEX_REMOTE_FRAME_INTERVAL_MS ?? '1200', 10);
const BRIDGE_POLL_MS = Number.parseInt(process.env.CODEX_REMOTE_BRIDGE_POLL_MS ?? '400', 10);
const JPEG_QUALITY = Number.parseInt(process.env.CODEX_REMOTE_JPEG_QUALITY ?? '55', 10);

function createHostAuthHeaders(extraHeaders = {}) {
  return HOST_TOKEN
    ? {
        ...extraHeaders,
        'x-codex-host-token': HOST_TOKEN,
      }
    : extraHeaders;
}

function getWebSocketCtor() {
  if (typeof WebSocket !== 'undefined') {
    return WebSocket;
  }

  for (const candidate of ['ws', '../node_modules/ws', '../../node_modules/ws', '../../patch-work/local/extract/node_modules/ws']) {
    try {
      return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('No WebSocket implementation available for remote host-agent');
}

class CdpClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(webSocketUrl) {
    if (this.ws && this.ws.readyState === 1) {
      return;
    }

    const WebSocketCtor = getWebSocketCtor();
    const ws = new WebSocketCtor(webSocketUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (error) => reject(error instanceof Error ? error : new Error('Failed to open CDP websocket'));
    });

    this.ws = ws;
    ws.onmessage = (event) => {
      const payload = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString('utf8'));
      if (!payload.id || !this.pending.has(payload.id)) {
        return;
      }
      const { resolve, reject } = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      if (payload.error) {
        reject(new Error(payload.error.message ?? 'CDP request failed'));
        return;
      }
      resolve(payload.result ?? {});
    };
    ws.onerror = (error) => {
      const err = error instanceof Error ? error : new Error('CDP websocket error');
      for (const entry of this.pending.values()) {
        entry.reject(err);
      }
      this.pending.clear();
    };
    ws.onclose = () => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error('CDP websocket closed'));
      }
      this.pending.clear();
    };
  }

  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('CDP websocket is not connected');
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    if (!this.ws) {
      return;
    }
    try {
      this.ws.close();
    } catch {
      // Ignore close races.
    }
    this.ws = null;
  }
}

function buildRemoteBridgeInstallExpression() {
  return `(() => {
    if (globalThis.__codexRemoteBridge) {
      return globalThis.__codexRemoteBridge.getBootstrap();
    }

    const state = {
      seq: 0,
      events: [],
      workerUnsubscribers: new Map(),
      remoteRequests: new Map(),
      remoteConversationIds: new Set(),
      remoteFetchRequestIds: new Set(),
      fetchWaiters: new Map(),
      bootstrapPromise: null,
    };

    const pushEvent = (event) => {
      state.events.push({ seq: ++state.seq, ...event });
      if (state.events.length > 1000) {
        state.events.splice(0, state.events.length - 1000);
      }
    };

    const maybeRememberRemoteConversation = (request) => {
      const params = request?.params;
      const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
      if (threadId) {
        state.remoteConversationIds.add(threadId);
      }
    };

    const rememberRemoteConversationFromResult = (request, result) => {
      maybeRememberRemoteConversation(request);
      const method = request?.method;
      if ((method === 'thread/start' || method === 'thread/fork' || method === 'thread/read' || method === 'thread/resume') && typeof result?.thread?.id === 'string') {
        state.remoteConversationIds.add(result.thread.id);
      }
    };

    const extractConversationIdFromMessage = (data) => {
      if (!data || typeof data !== 'object') {
        return null;
      }
      if (data.type === 'mcp-notification') {
        const params = data.params;
        if (typeof params?.threadId === 'string') {
          return params.threadId;
        }
        if (typeof params?.conversationId === 'string') {
          return params.conversationId;
        }
        if (typeof params?.thread?.id === 'string') {
          return params.thread.id;
        }
        return null;
      }
      if (data.type === 'mcp-request') {
        const params = data.request?.params;
        if (typeof params?.threadId === 'string') {
          return params.threadId;
        }
        if (typeof params?.conversationId === 'string') {
          return params.conversationId;
        }
        return null;
      }
      if (data.type === 'ipc-broadcast') {
        const params = data.params;
        if (typeof params?.conversationId === 'string') {
          return params.conversationId;
        }
      }
      return null;
    };

    globalThis.addEventListener('message', (event) => {
      const data = event.data;
      if (data?.type === 'fetch-response' && data.requestId && state.fetchWaiters.has(data.requestId)) {
        const resolve = state.fetchWaiters.get(data.requestId);
        state.fetchWaiters.delete(data.requestId);
        resolve(data);
        event.stopImmediatePropagation();
        return;
      }
      if (data?.type === 'fetch-response' && data.requestId && state.remoteFetchRequestIds.has(data.requestId)) {
        state.remoteFetchRequestIds.delete(data.requestId);
        pushEvent({ kind: 'view-message', data });
        event.stopImmediatePropagation();
        return;
      }
      if (data?.type === 'mcp-response' && data.message?.id && state.remoteRequests.has(data.message.id)) {
        const request = state.remoteRequests.get(data.message.id);
        state.remoteRequests.delete(data.message.id);
        rememberRemoteConversationFromResult(request, data.message.result);
        pushEvent({ kind: 'view-message', data });
        event.stopImmediatePropagation();
        return;
      }
      const conversationId = extractConversationIdFromMessage(data);
      if (conversationId && state.remoteConversationIds.has(conversationId)) {
        if (data?.type === 'ipc-broadcast' && data.method === 'thread-stream-state-changed') {
          pushEvent({ kind: 'view-message', data });
          event.stopImmediatePropagation();
          return;
        }
      }
      pushEvent({ kind: 'view-message', data });
    }, true);

    const sendCodexFetchRequest = async (endpoint, params = {}) => {
      const requestId = 'remote-bootstrap-' + Math.random().toString(36).slice(2);
      const response = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          state.fetchWaiters.delete(requestId);
          reject(new Error('Timed out waiting for fetch response: ' + endpoint));
        }, 5000);
        state.fetchWaiters.set(requestId, (payload) => {
          clearTimeout(timeoutId);
          resolve(payload);
        });
        globalThis.electronBridge?.sendMessageFromView?.({
          type: 'fetch',
          hostId: 'local',
          requestId,
          method: 'POST',
          url: 'vscode://codex/' + endpoint,
          body: JSON.stringify(params),
        });
      });

      if (response?.responseType !== 'success') {
        throw new Error(response?.error || 'Fetch request failed: ' + endpoint);
      }
      return JSON.parse(response.bodyJsonString);
    };

    const loadBootstrapWorkspaceData = async () => {
      if (!state.bootstrapPromise) {
        state.bootstrapPromise = (async () => {
          const [workspaceRootOptionsResult, activeWorkspaceRootsResult] = await Promise.allSettled([
            sendCodexFetchRequest('workspace-root-options'),
            sendCodexFetchRequest('active-workspace-roots'),
          ]);
          const workspaceRootOptions = workspaceRootOptionsResult.status === 'fulfilled' ? workspaceRootOptionsResult.value : null;
          const activeWorkspaceRoots = activeWorkspaceRootsResult.status === 'fulfilled' ? activeWorkspaceRootsResult.value : null;
          const optionRoots = Array.isArray(workspaceRootOptions?.roots) ? workspaceRootOptions.roots : [];
          const activeRoots = Array.isArray(activeWorkspaceRoots?.roots) ? activeWorkspaceRoots.roots : [];
          const roots = activeRoots.length > 0 ? activeRoots : optionRoots;
          return {
            workspaceRootOptions: {
              roots: optionRoots.length > 0 ? optionRoots : roots,
              labels: workspaceRootOptions?.labels && typeof workspaceRootOptions.labels === 'object' ? workspaceRootOptions.labels : {},
            },
            activeWorkspaceRoots: {
              roots,
            },
          };
        })();
      }
      return await state.bootstrapPromise;
    };

    let themeUnsubscribe = null;
    if (globalThis.electronBridge?.subscribeToSystemThemeVariant) {
      themeUnsubscribe = globalThis.electronBridge.subscribeToSystemThemeVariant(() => {
        pushEvent({ kind: 'system-theme-variant', variant: globalThis.electronBridge.getSystemThemeVariant?.() ?? 'dark' });
      });
    }

    globalThis.__codexRemoteBridge = {
      async getBootstrap() {
        const workspaceData = await loadBootstrapWorkspaceData().catch(() => ({
          workspaceRootOptions: { roots: [], labels: {} },
          activeWorkspaceRoots: { roots: [] },
        }));
        return {
          codexWindowType: globalThis.codexWindowType ?? 'electron',
          codexOs: document.documentElement.dataset.codexOs ?? 'linux',
          systemThemeVariant: globalThis.electronBridge?.getSystemThemeVariant?.() ?? 'dark',
          sentryInitOptions: globalThis.electronBridge?.getSentryInitOptions?.() ?? null,
          appSessionId: globalThis.electronBridge?.getAppSessionId?.() ?? null,
          buildFlavor: globalThis.electronBridge?.getBuildFlavor?.() ?? 'prod',
          workspaceRootOptions: workspaceData.workspaceRootOptions,
          activeWorkspaceRoots: workspaceData.activeWorkspaceRoots,
        };
      },
      drainEvents(afterSeq) {
        return state.events.filter((entry) => entry.seq > afterSeq);
      },
      async call(method, args) {
        if (method === 'subscribeWorker') {
          const workerId = args[0];
          if (state.workerUnsubscribers.has(workerId)) {
            return true;
          }
          const unsubscribe = globalThis.electronBridge.subscribeToWorkerMessages(workerId, (payload) => {
            pushEvent({ kind: 'worker-message', workerId, payload });
          });
          state.workerUnsubscribers.set(workerId, unsubscribe);
          return true;
        }
        if (method === 'unsubscribeWorker') {
          const workerId = args[0];
          const unsubscribe = state.workerUnsubscribers.get(workerId);
          if (unsubscribe) {
            unsubscribe();
            state.workerUnsubscribers.delete(workerId);
          }
          return true;
        }

        if (method === 'sendMessageFromView') {
          const message = args[0];
          if (message?.type === 'mcp-request' && message.request?.id) {
            state.remoteRequests.set(message.request.id, message.request);
            maybeRememberRemoteConversation(message.request);
          }
          if (message?.type === 'fetch' && message.requestId) {
            state.remoteFetchRequestIds.add(message.requestId);
          }

          const fn = globalThis.electronBridge?.sendMessageFromView;
          if (typeof fn !== 'function') {
            throw new Error('Unsupported remote bridge method: ' + method);
          }
          try {
            fn(...args);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn('[remote-bridge] sendMessageFromView failed', {
              messageType: message?.type ?? null,
              requestMethod: message?.request?.method ?? null,
              requestId: message?.request?.id ?? message?.requestId ?? null,
              error: errorMessage,
            });
            if (message?.type === 'mcp-request' && message.request?.id) {
              pushEvent({
                kind: 'view-message',
                data: {
                  type: 'mcp-response',
                  hostId: message.hostId || 'local',
                  message: {
                    id: message.request.id,
                    error: { message: errorMessage },
                  },
                },
              });
              return true;
            }
            if (message?.type === 'fetch' && message.requestId) {
              pushEvent({
                kind: 'view-message',
                data: {
                  type: 'fetch-response',
                  hostId: message.hostId || 'local',
                  requestId: message.requestId,
                  responseType: 'error',
                  error: errorMessage,
                },
              });
              return true;
            }
            return true;
          }
          return true;
        }

        const fn = globalThis.electronBridge?.[method];
        if (typeof fn !== 'function') {
          throw new Error('Unsupported remote bridge method: ' + method);
        }
        return await fn(...args);
      },
      dispose() {
        themeUnsubscribe?.();
        for (const unsubscribe of state.workerUnsubscribers.values()) {
          unsubscribe();
        }
        state.workerUnsubscribers.clear();
      },
    };

    return globalThis.__codexRemoteBridge.getBootstrap();
  })()`;
}

class RemoteCodexHostAgent {
  constructor() {
    this.cdp = new CdpClient();
    this.commandCursor = 0;
    this.connectedTargetId = null;
    this.bridgeInstalledTargetId = null;
    this.bridgeEventCursor = 0;
    this.stopped = false;
    this.target = null;
    this.remoteBridgeBootstrap = null;
    this.lastState = {
      status: 'booting',
      relayOrigin: RELAY_ORIGIN,
      rendezvousOrigin: RENDEZVOUS_ORIGIN || DEFAULT_RENDEZVOUS_ORIGIN,
      app: {
        deviceId: DEVICE_ID,
        webviewOrigin: WEBVIEW_ORIGIN,
        cdpOrigin: CDP_ORIGIN,
        remoteBridge: null,
      },
      viewport: null,
      target: null,
      diagnostics: {
        heartbeats: 0,
        framesCaptured: 0,
        bridgeEventsForwarded: 0,
        pairingCodeConfigured: Boolean(PAIRING_CODE),
      },
      lastError: null,
    };
  }

  async run() {
    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

    console.log(`[host-agent] device=${DEVICE_ID} relay=${RELAY_ORIGIN} rendezvous=${RENDEZVOUS_ORIGIN || 'disabled'}`);

    await Promise.all([
      this.heartbeatLoop(),
      this.commandLoop(),
      this.frameLoop(),
      this.bridgeEventLoop(),
    ]);
  }

  stop(reason) {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.cdp.close();
    console.log(`[host-agent] stopping (${reason})`);
  }

  async heartbeatLoop() {
    while (!this.stopped) {
      try {
        await this.refreshState();
      } catch (error) {
        this.recordError(error);
      }

      try {
        await this.registerState();
      } catch (error) {
        this.recordError(error);
      }

      if (RENDEZVOUS_ORIGIN) {
        try {
          await this.registerWithRendezvous();
        } catch (error) {
          this.recordError(error);
        }
      }

      await delay(HEARTBEAT_MS);
    }
  }

  async frameLoop() {
    while (!this.stopped) {
      try {
        await this.captureAndUploadFrame();
      } catch (error) {
        this.recordError(error);
      }
      await delay(FRAME_INTERVAL_MS);
    }
  }

  async bridgeEventLoop() {
    while (!this.stopped) {
      try {
        await this.refreshState();
        if (!this.target) {
          await delay(BRIDGE_POLL_MS);
          continue;
        }
        await this.ensureRemoteBridge();
        const events = await this.bridgeDrainEvents();
        if (events.length > 0) {
          await this.pushBridgeEvents(events);
          this.lastState = {
            ...this.lastState,
            diagnostics: {
              ...this.lastState.diagnostics,
              bridgeEventsForwarded: (this.lastState.diagnostics?.bridgeEventsForwarded ?? 0) + events.length,
            },
          };
        }
      } catch (error) {
        this.recordError(error);
      }
      await delay(BRIDGE_POLL_MS);
    }
  }

  async commandLoop() {
    while (!this.stopped) {
      try {
        const response = await fetch(`${RELAY_ORIGIN}/api/host/commands?deviceId=${encodeURIComponent(DEVICE_ID)}&cursor=${this.commandCursor}&waitMs=${COMMAND_WAIT_MS}`, {
          headers: createHostAuthHeaders(),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error ?? 'Failed to poll relay commands');
        }
        const commands = Array.isArray(payload.commands) ? payload.commands : [];
        for (const command of commands) {
          await this.handleCommand(command);
          this.commandCursor = Math.max(this.commandCursor, command.seq ?? this.commandCursor);
        }
        this.commandCursor = Math.max(this.commandCursor, payload.cursor ?? this.commandCursor);
      } catch (error) {
        this.recordError(error);
        await delay(1000);
      }
    }
  }

  async refreshState() {
    const webviewOk = await this.checkWebview();
    let target = null;
    try {
      target = await this.resolveTarget();
    } catch (error) {
      this.target = null;
      this.connectedTargetId = null;
      this.bridgeInstalledTargetId = null;
      this.bridgeEventCursor = 0;
      this.remoteBridgeBootstrap = null;
      this.cdp.close();
      throw error;
    }

    this.target = target;
    this.lastState = {
      ...this.lastState,
      status: target ? 'ready' : 'waiting-for-codex',
      target: target ? {
        id: target.id,
        title: target.title,
        url: target.url,
      } : null,
      diagnostics: {
        ...this.lastState.diagnostics,
        heartbeats: (this.lastState.diagnostics?.heartbeats ?? 0) + 1,
        webviewReachable: webviewOk,
      },
      lastError: target ? null : this.lastState.lastError,
    };

    if (target) {
      await this.ensureCdpConnected(target);
      const metrics = await this.cdp.send('Page.getLayoutMetrics');
      const viewport = metrics.cssContentSize ?? metrics.contentSize ?? null;
      this.lastState.viewport = viewport ? {
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
      } : null;
      await this.ensureRemoteBridge();
      this.lastState.app = {
        ...this.lastState.app,
        remoteBridge: this.remoteBridgeBootstrap,
      };
    } else {
      this.connectedTargetId = null;
      this.bridgeInstalledTargetId = null;
      this.bridgeEventCursor = 0;
      this.remoteBridgeBootstrap = null;
      this.cdp.close();
      this.lastState.viewport = null;
      this.lastState.app = {
        ...this.lastState.app,
        remoteBridge: null,
      };
    }
  }

  async registerState() {
    const response = await fetch(`${RELAY_ORIGIN}/api/host/register`, {
      method: 'POST',
      headers: createHostAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        state: this.lastState,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? 'Failed to register host state');
    }
    this.commandCursor = Math.max(this.commandCursor, payload.commandCursor ?? 0);
  }

  async registerWithRendezvous() {
    const response = await fetch(`${RENDEZVOUS_ORIGIN}/api/host/register`, {
      method: 'POST',
      headers: createHostAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        relayOrigin: RELAY_ORIGIN,
        rendezvousOrigin: RENDEZVOUS_ORIGIN,
        pairingCode: PAIRING_CODE,
        state: this.lastState,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? 'Failed to register rendezvous state');
    }
    return payload;
  }

  async checkWebview() {
    try {
      const response = await fetch(WEBVIEW_ORIGIN, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async resolveTarget() {
    const response = await fetch(new URL('/json/list', CDP_ORIGIN));
    if (!response.ok) {
      throw new Error(`Unable to query CDP targets: ${response.status}`);
    }
    const targets = await response.json();
    return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && (entry.url.includes(new URL(WEBVIEW_ORIGIN).host) || `${entry.title} ${entry.url}`.includes('Codex'))) ?? null;
  }

  async ensureCdpConnected(target) {
    if (this.connectedTargetId === target.id && this.cdp.ws && this.cdp.ws.readyState === 1) {
      return;
    }
    this.cdp.close();
    await this.cdp.connect(target.webSocketDebuggerUrl);
    this.connectedTargetId = target.id;
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
  }

  async runtimeEvaluate(expression) {
    const evaluation = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.text || 'Runtime evaluation failed');
    }
    return evaluation.result?.value ?? null;
  }

  async ensureRemoteBridge() {
    if (!this.target) {
      return null;
    }
    await this.ensureCdpConnected(this.target);
    if (this.bridgeInstalledTargetId === this.target.id && this.remoteBridgeBootstrap) {
      return this.remoteBridgeBootstrap;
    }
    this.remoteBridgeBootstrap = await this.runtimeEvaluate(buildRemoteBridgeInstallExpression());
    this.bridgeInstalledTargetId = this.target.id;
    this.bridgeEventCursor = 0;
    return this.remoteBridgeBootstrap;
  }

  async bridgeDrainEvents() {
    const events = await this.runtimeEvaluate(`globalThis.__codexRemoteBridge ? globalThis.__codexRemoteBridge.drainEvents(${this.bridgeEventCursor}) : []`);
    if (!Array.isArray(events) || events.length === 0) {
      return [];
    }
    const maxSeq = Math.max(...events.map((event) => Number(event.seq) || 0));
    this.bridgeEventCursor = Math.max(this.bridgeEventCursor, maxSeq);
    return events.map(({ seq, ...event }) => event);
  }

  async bridgeCall(method, args = []) {
    await this.ensureRemoteBridge();
    return await this.runtimeEvaluate(`globalThis.__codexRemoteBridge.call(${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  }

  async pushBridgeEvents(events) {
    const response = await fetch(`${RELAY_ORIGIN}/api/host/events/${encodeURIComponent(DEVICE_ID)}`, {
      method: 'POST',
      headers: createHostAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ events }),
    });
    if (!response.ok) {
      throw new Error('Failed to push bridge events to relay');
    }
  }

  async postCommandResult(commandId, payload) {
    const response = await fetch(`${RELAY_ORIGIN}/api/host/command-result`, {
      method: 'POST',
      headers: createHostAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        commandId,
        ...payload,
      }),
    });
    if (!response.ok) {
      throw new Error('Failed to post command result');
    }
  }

  async captureAndUploadFrame() {
    if (!this.target) {
      return;
    }
    await this.ensureCdpConnected(this.target);
    const screenshot = await this.cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const buffer = Buffer.from(screenshot.data, 'base64');
    const response = await fetch(`${RELAY_ORIGIN}/api/host/frame/${encodeURIComponent(DEVICE_ID)}`, {
      method: 'PUT',
      headers: createHostAuthHeaders({ 'content-type': 'image/jpeg' }),
      body: buffer,
    });
    if (!response.ok) {
      throw new Error('Failed to upload frame');
    }
    this.lastState = {
      ...this.lastState,
      diagnostics: {
        ...this.lastState.diagnostics,
        framesCaptured: (this.lastState.diagnostics?.framesCaptured ?? 0) + 1,
      },
    };
  }

  async handleCommand(command) {
    try {
      await this.refreshState();
      const payload = command.payload ?? {};
      switch (command.type) {
        case 'tap':
          await this.dispatchTap(payload);
          break;
        case 'scroll':
          await this.dispatchScroll(payload);
          break;
        case 'insertText':
          await this.cdp.send('Input.insertText', { text: String(payload.text ?? '') });
          break;
        case 'key':
          await this.dispatchSpecialKey(String(payload.key ?? ''));
          break;
        case 'bridge-call': {
          const result = await this.bridgeCall(String(payload.method), Array.isArray(payload.args) ? payload.args : []);
          await this.postCommandResult(command.id, { ok: true, result });
          return;
        }
        default:
          throw new Error(`Unsupported command type: ${command.type}`);
      }
      await this.captureAndUploadFrame();
    } catch (error) {
      if (command.type === 'bridge-call') {
        await this.postCommandResult(command.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
  }

  async dispatchTap(payload) {
    const point = this.resolvePoint(payload);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  async dispatchScroll(payload) {
    const point = this.resolvePoint(payload);
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: Number(payload.deltaX ?? 0),
      deltaY: Number(payload.deltaY ?? 0),
      modifiers: 0,
    });
  }

  async dispatchSpecialKey(key) {
    const mapping = {
      Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 },
      Backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
      Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
      Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
    };
    const descriptor = mapping[key];
    if (!descriptor) {
      throw new Error(`Unsupported special key: ${key}`);
    }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...descriptor });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor });
  }

  resolvePoint(payload) {
    const viewport = this.lastState.viewport;
    if (!viewport?.width || !viewport?.height) {
      throw new Error('Viewport is not available yet');
    }
    const normalizedX = Number(payload.normalizedX ?? 0.5);
    const normalizedY = Number(payload.normalizedY ?? 0.5);
    return {
      x: Math.max(0, Math.min(viewport.width - 1, Math.round(normalizedX * viewport.width))),
      y: Math.max(0, Math.min(viewport.height - 1, Math.round(normalizedY * viewport.height))),
    };
  }

  recordError(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.lastState = {
      ...this.lastState,
      status: this.target ? 'degraded' : 'waiting-for-codex',
      lastError: message,
    };
    console.warn('[host-agent]', message);
  }
}

const agent = new RemoteCodexHostAgent();
agent.run().catch((error) => {
  console.error('[host-agent] fatal error', error);
  process.exitCode = 1;
});
