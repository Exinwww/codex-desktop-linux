const THREAD_PINS_MODE_STORAGE_KEY = "codex-thread-pins:mode";
const THREAD_PINS_MODE_DEFAULT = "default";
const THREAD_PINS_MODE_HEADER = "header";
const THREAD_PINS_MODE_UPDATED_EVENT = "codex-thread-pins:mode-changed";

function normalizeThreadPinsMode(value) {
  return value === THREAD_PINS_MODE_HEADER ? THREAD_PINS_MODE_HEADER : THREAD_PINS_MODE_DEFAULT;
}

function dispatchThreadPinsEvent(eventName, detail) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

function readStoredThreadPinsMode() {
  try {
    return normalizeThreadPinsMode(window.localStorage.getItem(THREAD_PINS_MODE_STORAGE_KEY));
  } catch {
    return THREAD_PINS_MODE_DEFAULT;
  }
}

function writeStoredThreadPinsMode(value) {
  const normalizedValue = normalizeThreadPinsMode(value);

  try {
    window.localStorage.setItem(THREAD_PINS_MODE_STORAGE_KEY, normalizedValue);
  } catch {
    // Ignore localStorage failures so the settings UI still responds in sandbox sessions.
  }

  dispatchThreadPinsEvent(THREAD_PINS_MODE_UPDATED_EVENT, { mode: normalizedValue });
  return normalizedValue;
}

export {
  THREAD_PINS_MODE_DEFAULT,
  THREAD_PINS_MODE_HEADER,
  THREAD_PINS_MODE_UPDATED_EVENT,
  readStoredThreadPinsMode,
  writeStoredThreadPinsMode,
};
