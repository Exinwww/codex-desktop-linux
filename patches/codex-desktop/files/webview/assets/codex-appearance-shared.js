const MESSAGE_STYLE_STORAGE_KEY = "codex.desktop.appearance.messageStyle";
const BUBBLE_THEME_STORAGE_KEY = "codex.desktop.appearance.bubbleTheme";
const STYLE_DEFAULT = "default";
const STYLE_BUBBLES = "bubbles";
const VALID_STYLES = new Set([STYLE_DEFAULT, STYLE_BUBBLES]);
const VALID_DENSITIES = new Set(["compact", "cozy"]);
const DATA_ATTRIBUTE = "codexMessageStyle";
const DEFAULT_BUBBLE_THEME = {
  userBubbleBg: "#2563eb",
  userBubbleFg: "#ffffff",
  assistantBubbleBg: "#f8fafc",
  assistantBubbleFg: "#1f2937",
  radius: 18,
  shadowStrength: 18,
  borderWidth: 1,
  density: "cozy",
};

function normalizeMessageStyle(value) {
  return VALID_STYLES.has(value) ? value : STYLE_DEFAULT;
}

function normalizeHexColor(value, fallbackValue) {
  if (typeof value !== "string") {
    return fallbackValue;
  }

  const normalizedValue = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalizedValue) ? normalizedValue.toLowerCase() : fallbackValue;
}

function normalizeRadius(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_BUBBLE_THEME.radius;
  }

  return Math.max(8, Math.min(28, Math.round(numericValue)));
}

function normalizeShadowStrength(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_BUBBLE_THEME.shadowStrength;
  }

  return Math.max(0, Math.min(28, Math.round(numericValue)));
}

function normalizeBorderWidth(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_BUBBLE_THEME.borderWidth;
  }

  return Math.max(0, Math.min(2, Math.round(numericValue)));
}

function normalizeDensity(value) {
  return VALID_DENSITIES.has(value) ? value : DEFAULT_BUBBLE_THEME.density;
}

function normalizeBubbleTheme(theme) {
  const nextTheme = theme && typeof theme === "object" ? theme : {};
  return {
    userBubbleBg: normalizeHexColor(nextTheme.userBubbleBg, DEFAULT_BUBBLE_THEME.userBubbleBg),
    userBubbleFg: normalizeHexColor(nextTheme.userBubbleFg, DEFAULT_BUBBLE_THEME.userBubbleFg),
    assistantBubbleBg: normalizeHexColor(nextTheme.assistantBubbleBg, DEFAULT_BUBBLE_THEME.assistantBubbleBg),
    assistantBubbleFg: normalizeHexColor(nextTheme.assistantBubbleFg, DEFAULT_BUBBLE_THEME.assistantBubbleFg),
    radius: normalizeRadius(nextTheme.radius),
    shadowStrength: normalizeShadowStrength(nextTheme.shadowStrength),
    borderWidth: normalizeBorderWidth(nextTheme.borderWidth),
    density: normalizeDensity(nextTheme.density),
  };
}

function hexToRgbChannels(hexColor) {
  return {
    red: Number.parseInt(hexColor.slice(1, 3), 16),
    green: Number.parseInt(hexColor.slice(3, 5), 16),
    blue: Number.parseInt(hexColor.slice(5, 7), 16),
  };
}

function rgbaFromHex(hexColor, alpha) {
  const { red, green, blue } = hexToRgbChannels(hexColor);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function readStoredMessageStyle() {
  try {
    return normalizeMessageStyle(window.localStorage.getItem(MESSAGE_STYLE_STORAGE_KEY));
  } catch {
    return STYLE_DEFAULT;
  }
}

function writeStoredMessageStyle(value) {
  const normalizedValue = normalizeMessageStyle(value);

  try {
    window.localStorage.setItem(MESSAGE_STYLE_STORAGE_KEY, normalizedValue);
  } catch {
    // Ignore localStorage failures so the UI still responds in sandboxed sessions.
  }

  return normalizedValue;
}

function applyMessageStyle(value) {
  const normalizedValue = normalizeMessageStyle(value);
  document.documentElement.dataset[DATA_ATTRIBUTE] = normalizedValue;
  return normalizedValue;
}

function readStoredBubbleTheme() {
  try {
    const rawValue = window.localStorage.getItem(BUBBLE_THEME_STORAGE_KEY);
    if (!rawValue) {
      return { ...DEFAULT_BUBBLE_THEME };
    }

    return normalizeBubbleTheme(JSON.parse(rawValue));
  } catch {
    return { ...DEFAULT_BUBBLE_THEME };
  }
}

function writeStoredBubbleTheme(theme) {
  const normalizedTheme = normalizeBubbleTheme(theme);

  try {
    window.localStorage.setItem(BUBBLE_THEME_STORAGE_KEY, JSON.stringify(normalizedTheme));
  } catch {
    // Ignore localStorage failures so the UI still responds in sandboxed sessions.
  }

  return normalizedTheme;
}

function applyBubbleTheme(theme) {
  const normalizedTheme = normalizeBubbleTheme(theme);
  const root = document.documentElement;
  const shadowAlpha = normalizedTheme.shadowStrength / 100;
  const densityMap = normalizedTheme.density === "compact"
    ? {
        bubblePaddingX: "11px",
        bubblePaddingY: "7px",
        assistantPaddingX: "12px",
        assistantPaddingY: "8px",
      }
    : {
        bubblePaddingX: "14px",
        bubblePaddingY: "10px",
        assistantPaddingX: "14px",
        assistantPaddingY: "10px",
      };

  root.style.setProperty("--codex-dev-user-bubble-bg", normalizedTheme.userBubbleBg);
  root.style.setProperty("--codex-dev-user-bubble-fg", normalizedTheme.userBubbleFg);
  root.style.setProperty("--codex-dev-user-bubble-border", rgbaFromHex(normalizedTheme.userBubbleBg, 0.34));
  root.style.setProperty("--codex-dev-user-bubble-shadow", rgbaFromHex(normalizedTheme.userBubbleBg, shadowAlpha));
  root.style.setProperty("--codex-dev-assistant-bg", normalizedTheme.assistantBubbleBg);
  root.style.setProperty("--codex-dev-assistant-fg", normalizedTheme.assistantBubbleFg);
  root.style.setProperty("--codex-dev-assistant-border", rgbaFromHex(normalizedTheme.assistantBubbleFg, 0.12));
  root.style.setProperty("--codex-dev-bubble-radius", `${normalizedTheme.radius}px`);
  root.style.setProperty("--codex-dev-assistant-radius", `${Math.max(10, normalizedTheme.radius - 4)}px`);
  root.style.setProperty("--codex-dev-bubble-border-width", `${normalizedTheme.borderWidth}px`);
  root.style.setProperty("--codex-dev-bubble-shadow-blur", `${12 + normalizedTheme.shadowStrength * 0.8}px`);
  root.style.setProperty("--codex-dev-bubble-padding-x", densityMap.bubblePaddingX);
  root.style.setProperty("--codex-dev-bubble-padding-y", densityMap.bubblePaddingY);
  root.style.setProperty("--codex-dev-assistant-padding-x", densityMap.assistantPaddingX);
  root.style.setProperty("--codex-dev-assistant-padding-y", densityMap.assistantPaddingY);

  return normalizedTheme;
}

function initializeAppearance() {
  applyMessageStyle(readStoredMessageStyle());
  applyBubbleTheme(readStoredBubbleTheme());
}

export {
  STYLE_BUBBLES as S,
  STYLE_DEFAULT as a,
  applyMessageStyle as b,
  initializeAppearance as c,
  normalizeMessageStyle as d,
  readStoredMessageStyle as r,
  writeStoredMessageStyle as w,
  DEFAULT_BUBBLE_THEME as D,
  applyBubbleTheme as e,
  normalizeBubbleTheme as f,
  readStoredBubbleTheme as g,
  writeStoredBubbleTheme as h,
};
