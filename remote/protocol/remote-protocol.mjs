import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';

export const DEFAULT_DEVICE_ID = 'sandbox-local';
export const DEFAULT_RELAY_PORT = 9001;
export const DEFAULT_RENDEZVOUS_PORT = 9002;
export const DEFAULT_RELAY_ORIGIN = `http://127.0.0.1:${DEFAULT_RELAY_PORT}`;
export const DEFAULT_RENDEZVOUS_ORIGIN = `http://127.0.0.1:${DEFAULT_RENDEZVOUS_PORT}`;
export const HOST_HEARTBEAT_MS = 2000;
export const HOST_COMMAND_WAIT_MS = 25000;
export const DEVICE_TTL_MS = 15000;

export function nowIso() {
  return new Date().toISOString();
}

export function createTraceId(prefix = 'trace') {
  return `${prefix}-${randomUUID()}`;
}

export function sanitizeDeviceId(value) {
  const input = String(value ?? '').trim();
  if (!input) {
    return DEFAULT_DEVICE_ID;
  }

  return input.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128) || DEFAULT_DEVICE_ID;
}

export function sanitizeOrigin(value, fallbackOrigin) {
  const candidate = String(value ?? '').trim() || fallbackOrigin;
  const parsed = new URL(candidate, fallbackOrigin);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
    return fallbackOrigin;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  };
}

export function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, jsonHeaders(extraHeaders));
  response.end(JSON.stringify(payload));
}

export async function readJsonBody(request) {
  const buffer = await readRequestBody(request);
  if (buffer.length === 0) {
    return {};
  }

  return JSON.parse(buffer.toString('utf8'));
}

export async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function notFound(response, message = 'Not found') {
  sendJson(response, 404, { ok: false, error: message });
}

export function methodNotAllowed(response, allowed) {
  response.writeHead(405, {
    allow: allowed.join(', '),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
}

export function badRequest(response, message) {
  sendJson(response, 400, { ok: false, error: message });
}

export function getRouteParts(requestUrl) {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  return {
    url,
    pathname: url.pathname,
    parts: url.pathname.split('/').filter(Boolean),
  };
}

export function withCors(response) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type, authorization, x-codex-host-token, x-codex-client-token, x-codex-session-token, x-codex-pairing-code');
}

export function isPreflight(request, response) {
  if (request.method !== 'OPTIONS') {
    return false;
  }

  withCors(response);
  response.writeHead(204);
  response.end();
  return true;
}

export function createHostStatePatch(state = {}) {
  return {
    updatedAt: nowIso(),
    status: state.status ?? 'unknown',
    relayOrigin: state.relayOrigin ?? null,
    rendezvousOrigin: state.rendezvousOrigin ?? null,
    app: state.app ?? null,
    viewport: state.viewport ?? null,
    target: state.target ?? null,
    diagnostics: state.diagnostics ?? null,
    lastError: state.lastError ?? null,
  };
}

export function createClientCommand(command) {
  return {
    id: randomUUID(),
    createdAt: nowIso(),
    type: command.type,
    payload: command.payload ?? {},
  };
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(payloadSegment, secret) {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

export function createSessionToken(payload, secret) {
  const normalizedSecret = String(secret ?? '').trim();
  if (!normalizedSecret) {
    throw new Error('Missing session secret');
  }
  const payloadSegment = encodeBase64Url(JSON.stringify(payload));
  const signature = signPayload(payloadSegment, normalizedSecret);
  return `${payloadSegment}.${signature}`;
}

export function verifySessionToken(token, secret) {
  const normalizedSecret = String(secret ?? '').trim();
  if (!normalizedSecret || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const [payloadSegment, signature] = parts;
  const expected = signPayload(payloadSegment, normalizedSecret);
  const provided = Buffer.from(signature);
  const actual = Buffer.from(expected);
  if (provided.length !== actual.length || !timingSafeEqual(provided, actual)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(payloadSegment));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (typeof payload.deviceId !== 'string' || !payload.deviceId) {
    return null;
  }
  if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) {
    return null;
  }
  if (Date.now() >= payload.expiresAt) {
    return null;
  }

  return payload;
}
