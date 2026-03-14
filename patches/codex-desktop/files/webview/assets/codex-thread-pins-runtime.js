import {
  THREAD_PINS_MODE_HEADER,
  THREAD_PINS_MODE_UPDATED_EVENT,
  readStoredThreadPinsMode,
} from "./codex-thread-pins-shared.js";

const HEADER_MAIN_SELECTOR = "#app-header-portal-main";
const MOUNT_ID = "codex-thread-pins-inline";
const HISTORY_CHANGED_EVENT = "codex-thread-pins:history-changed";
const PIN_BUTTON_SELECTOR = 'button[aria-label="Unpin thread"]';
const TITLE_SELECTOR = "[data-thread-title]";
const CLICKABLE_ROW_SELECTOR = '[role="button"]';

function findHeaderPinsHost() {
  const headerMain = document.querySelector(HEADER_MAIN_SELECTOR);
  const headerGrid = headerMain?.firstElementChild;
  const titleCluster = headerGrid?.firstElementChild;

  if (!(titleCluster instanceof HTMLElement)) {
    return null;
  }

  return titleCluster;
}

function ensureMountNode(hostNode) {
  let mountNode = document.getElementById(MOUNT_ID);
  if (!mountNode) {
    mountNode = document.createElement("div");
    mountNode.id = MOUNT_ID;
    mountNode.className = "codex-thread-pins-inline no-drag";
  }

  if (mountNode.parentElement !== hostNode) {
    hostNode.insertBefore(mountNode, hostNode.lastElementChild ?? null);
  }

  return mountNode;
}

function clearShellState() {
  const mountNode = document.getElementById(MOUNT_ID);
  if (mountNode) {
    delete mountNode.dataset.codexThreadPinsSignature;
    mountNode.remove();
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function findThreadRow(pinButton) {
  if (!(pinButton instanceof HTMLElement)) {
    return null;
  }

  let node = pinButton.parentElement;
  while (node && node !== document.body) {
    const row = node.matches(CLICKABLE_ROW_SELECTOR) && node.querySelector(TITLE_SELECTOR)
      ? node
      : node.querySelector(`${CLICKABLE_ROW_SELECTOR} ${TITLE_SELECTOR}`)?.closest(CLICKABLE_ROW_SELECTOR);

    if (row) {
      return row;
    }

    node = node.parentElement;
  }

  return null;
}

function extractPinnedThreadEntry(pinButton) {
  const row = findThreadRow(pinButton);
  if (!row) {
    return null;
  }

  const titleNode = row.querySelector(TITLE_SELECTOR);
  const title = normalizeText(titleNode?.textContent ?? row.textContent);
  if (!title) {
    return null;
  }

  return {
    title,
    row,
    titleNode,
    isActive: row.getAttribute("aria-current") === "page",
  };
}

function readPinnedThreadsFromSidebar() {
  const entries = [];
  const seenRows = new Set();

  for (const pinButton of document.querySelectorAll(PIN_BUTTON_SELECTOR)) {
    const entry = extractPinnedThreadEntry(pinButton);
    if (!entry || seenRows.has(entry.row)) {
      continue;
    }

    seenRows.add(entry.row);
    entries.push(entry);
  }

  return entries;
}

function triggerElementClick(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  element.focus?.();
  element.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    view: window,
  }));
  element.dispatchEvent(new MouseEvent("mouseup", {
    bubbles: true,
    cancelable: true,
    view: window,
  }));
  element.click?.();
  element.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    view: window,
  }));
  return true;
}

function activateThread(entry) {
  if (!entry?.row || !(entry.row instanceof HTMLElement)) {
    return;
  }

  // The title span only mirrors text; the actual navigation handler lives on the row root.
  triggerElementClick(entry.row);
}

function getEntriesSignature(entries) {
  return entries.map((entry) => `${entry.title}::${entry.isActive ? "1" : "0"}`).join("||");
}

function renderThreadPins() {
  if (readStoredThreadPinsMode() !== THREAD_PINS_MODE_HEADER) {
    clearShellState();
    return;
  }

  const hostNode = findHeaderPinsHost();
  if (!hostNode) {
    clearShellState();
    return;
  }

  const entries = readPinnedThreadsFromSidebar();
  if (entries.length === 0) {
    clearShellState();
    return;
  }

  const signature = getEntriesSignature(entries);
  const mountNode = ensureMountNode(hostNode);
  if (mountNode.dataset.codexThreadPinsSignature === signature && mountNode.parentElement === hostNode) {
    return;
  }

  mountNode.dataset.codexThreadPinsSignature = signature;
  mountNode.replaceChildren();
  mountNode.setAttribute("role", "navigation");
  mountNode.setAttribute("aria-label", "Pinned threads");

  const listNode = document.createElement("div");
  listNode.className = "codex-thread-pins-list";

  for (const entry of entries) {
    const chipNode = document.createElement("button");
    chipNode.type = "button";
    chipNode.className = `codex-thread-pin-chip no-drag${entry.isActive ? " is-active" : ""}`;
    chipNode.textContent = entry.title;
    chipNode.title = entry.title;
    chipNode.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activateThread(entry);
    });
    listNode.appendChild(chipNode);
  }

  mountNode.appendChild(listNode);
}

function initializeThreadPinsRuntime() {
  let isRenderQueued = false;

  const scheduleRender = () => {
    if (isRenderQueued) {
      return;
    }

    isRenderQueued = true;
    window.requestAnimationFrame(() => {
      isRenderQueued = false;
      renderThreadPins();
    });
  };

  const installHistoryBridge = () => {
    if (window.__codexThreadPinsHistoryBridgeInstalled) {
      return;
    }

    window.__codexThreadPinsHistoryBridgeInstalled = true;

    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);

    window.history.pushState = (...args) => {
      const result = originalPushState(...args);
      window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
      return result;
    };

    window.history.replaceState = (...args) => {
      const result = originalReplaceState(...args);
      window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
      return result;
    };
  };

  installHistoryBridge();

  const observer = new MutationObserver(scheduleRender);
  const startObserving = () => {
    if (!document.body) {
      return;
    }

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current", "aria-label"],
    });

    scheduleRender();
  };

  window.addEventListener("load", scheduleRender, { once: true });
  window.addEventListener("popstate", scheduleRender);
  window.addEventListener(HISTORY_CHANGED_EVENT, scheduleRender);
  window.addEventListener(THREAD_PINS_MODE_UPDATED_EVENT, scheduleRender);
  document.addEventListener("visibilitychange", scheduleRender);

  if (document.body) {
    startObserving();
  } else {
    window.addEventListener("DOMContentLoaded", startObserving, { once: true });
  }

  scheduleRender();
}

export { initializeThreadPinsRuntime };
