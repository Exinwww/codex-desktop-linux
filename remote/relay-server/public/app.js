const state = {
  deviceId: 'sandbox-local',
  clientToken: '',
  sessionToken: '',
  pollingHandle: null,
  frameHandle: null,
  lastFrameUpdatedAt: null,
};

const elements = {
  connectForm: document.querySelector('#connect-form'),
  deviceId: document.querySelector('#device-id'),
  frameImage: document.querySelector('#frame-image'),
  frameEmpty: document.querySelector('#frame-empty'),
  statusBadge: document.querySelector('#status-badge'),
  statusText: document.querySelector('#status-text'),
  metaTitle: document.querySelector('#meta-title'),
  metaUrl: document.querySelector('#meta-url'),
  metaViewport: document.querySelector('#meta-viewport'),
  metaFrameUpdated: document.querySelector('#meta-frame-updated'),
  refreshFrame: document.querySelector('#refresh-frame'),
  textInput: document.querySelector('#text-input'),
  sendText: document.querySelector('#send-text'),
};

function buildAuthHeaders(existing) {
  const headers = new Headers(existing || {});
  if (state.sessionToken && !headers.has('x-codex-session-token')) {
    headers.set('x-codex-session-token', state.sessionToken);
  }
  if (state.clientToken && !headers.has('x-codex-client-token')) {
    headers.set('x-codex-client-token', state.clientToken);
  }
  return headers;
}

async function fetchJson(path, options) {
  const response = await fetch(path, {
    ...(options || {}),
    headers: buildAuthHeaders(options && options.headers),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

async function postCommand(type, payload = {}) {
  await fetchJson(`/api/client/device/${encodeURIComponent(state.deviceId)}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, payload }),
  });
}

function setStatus(online, text) {
  elements.statusBadge.textContent = online ? 'Online' : 'Offline';
  elements.statusBadge.classList.toggle('online', online);
  elements.statusBadge.classList.toggle('offline', !online);
  elements.statusText.textContent = text;
}

function updateMeta(device) {
  const hostState = device?.state || {};
  elements.metaTitle.textContent = hostState.target?.title || '-';
  elements.metaUrl.textContent = hostState.target?.url || '-';
  if (hostState.viewport?.width && hostState.viewport?.height) {
    elements.metaViewport.textContent = `${hostState.viewport.width} x ${hostState.viewport.height}`;
  } else {
    elements.metaViewport.textContent = '-';
  }
  elements.metaFrameUpdated.textContent = device?.frameUpdatedAt || '-';
}

async function refreshState() {
  const payload = await fetchJson(`/api/client/device/${encodeURIComponent(state.deviceId)}/state`);
  const device = payload.device;
  const statusText = device.online
    ? (device.state?.lastError ? `Host online, latest issue: ${device.state.lastError}` : 'Connected to relay session')
    : 'Waiting for host heartbeat';
  setStatus(device.online, statusText);
  updateMeta(device);
  elements.frameEmpty.hidden = device.hasFrame;
  if (device.frameUpdatedAt && device.frameUpdatedAt !== state.lastFrameUpdatedAt) {
    await refreshFrame();
  }
}

async function refreshFrame() {
  const url = `/api/client/device/${encodeURIComponent(state.deviceId)}/frame?t=${Date.now()}`;
  const response = await fetch(url, { cache: 'no-store', headers: buildAuthHeaders() });
  if (!response.ok) {
    return;
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  elements.frameImage.src = objectUrl;
  state.lastFrameUpdatedAt = response.headers.get('x-codex-frame-updated-at');
  elements.metaFrameUpdated.textContent = state.lastFrameUpdatedAt || '-';
  elements.frameEmpty.hidden = true;
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

function getNormalizedPoint(event) {
  const rect = elements.frameImage.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }
  const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
  const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;
  return {
    normalizedX: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    normalizedY: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  };
}

async function handlePointer(event) {
  event.preventDefault();
  const point = getNormalizedPoint(event);
  if (!point) {
    return;
  }
  await postCommand('tap', point);
  await refreshState();
}

function restartPolling() {
  clearInterval(state.pollingHandle);
  clearInterval(state.frameHandle);
  state.pollingHandle = setInterval(() => {
    refreshState().catch((error) => setStatus(false, error.message));
  }, 1500);
  state.frameHandle = setInterval(() => {
    refreshFrame().catch(() => {});
  }, 1200);
}

function bindControls() {
  elements.connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.deviceId = elements.deviceId.value.trim() || 'sandbox-local';
    state.lastFrameUpdatedAt = null;
    restartPolling();
    refreshState().catch((error) => setStatus(false, error.message));
  });

  elements.refreshFrame.addEventListener('click', () => {
    refreshFrame().catch((error) => setStatus(false, error.message));
  });

  elements.frameImage.addEventListener('click', handlePointer);
  elements.frameImage.addEventListener('touchstart', handlePointer, { passive: false });

  document.querySelectorAll('[data-key]').forEach((button) => {
    button.addEventListener('click', async () => {
      await postCommand('key', { key: button.dataset.key });
      await refreshState();
    });
  });

  document.querySelectorAll('[data-scroll]').forEach((button) => {
    button.addEventListener('click', async () => {
      await postCommand('scroll', {
        normalizedX: 0.5,
        normalizedY: 0.5,
        deltaY: Number(button.dataset.scroll || 0),
      });
      await refreshState();
    });
  });

  elements.sendText.addEventListener('click', async () => {
    const text = elements.textInput.value;
    if (!text.trim()) {
      return;
    }
    await postCommand('insertText', { text });
    elements.textInput.value = '';
    await refreshState();
  });
}

function initFromLocation() {
  const params = new URLSearchParams(window.location.search);
  state.deviceId = params.get('deviceId') || state.deviceId;
  state.clientToken = params.get('clientToken') || state.clientToken;
  state.sessionToken = params.get('sessionToken') || state.sessionToken;
  elements.deviceId.value = state.deviceId;
}

initFromLocation();
bindControls();
restartPolling();
refreshState().catch((error) => setStatus(false, error.message));
