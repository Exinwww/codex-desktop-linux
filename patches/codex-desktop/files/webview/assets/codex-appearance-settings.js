import { t as createReact } from "./react-DEh3VhWB.js";
import { t as createJsxRuntime } from "./jsx-runtime-BjItZljr.js";
import { n as SettingsGroup, t as SettingsCard } from "./settings-surface-FyeZDgVr.js";
import { t as SettingsRow } from "./settings-row-BAVonNmd.js";
import { t as SegmentedToggle } from "./segmented-toggle-6vaOhoHs.js";
import {
  D as DEFAULT_BUBBLE_THEME,
  S as STYLE_BUBBLES,
  a as STYLE_DEFAULT,
  b as applyMessageStyle,
  d as normalizeMessageStyle,
  e as applyBubbleTheme,
  f as normalizeBubbleTheme,
  g as readStoredBubbleTheme,
  h as writeStoredBubbleTheme,
  r as readStoredMessageStyle,
  w as writeStoredMessageStyle,
} from "./codex-appearance-shared.js";
import {
  THREAD_PINS_MODE_DEFAULT,
  THREAD_PINS_MODE_HEADER,
  THREAD_PINS_MODE_UPDATED_EVENT,
  readStoredThreadPinsMode,
  writeStoredThreadPinsMode,
} from "./codex-thread-pins-shared.js";

const React = createReact();
const jsxRuntime = createJsxRuntime();
const { jsx, jsxs } = jsxRuntime;

const fieldLabelClassName = "text-token-text-secondary text-xs font-medium uppercase tracking-[0.08em]";
const swatchInputClassName = "h-9 w-14 cursor-pointer rounded-md border border-token-border bg-transparent p-1";
const colorCodeClassName = "min-w-[74px] text-right font-mono text-xs text-token-text-secondary";
const rangeInputClassName = "w-40 accent-token-accent-primary";
const resetButtonClassName = "rounded-md border border-token-border bg-token-bg-fog px-3 py-1.5 text-sm text-token-text-primary enabled:hover:bg-token-button-secondary-hover-background";
const presetButtonClassName = "rounded-lg border border-token-border bg-token-bg-primary px-3 py-2 text-left text-sm text-token-text-primary enabled:hover:bg-token-button-secondary-hover-background";
const selectedPresetButtonClassName = "border-token-accent-primary bg-token-background-accent";
const officialPresetButtonClassName = "border-token-accent-primary/50 bg-token-background-accent/40";
const officialBadgeClassName = "rounded-full bg-token-background-accent px-2 py-0.5 text-[11px] font-medium text-token-accent-primary";
const subtlePanelClassName = "rounded-lg border border-token-border bg-token-bg-fog px-3 py-2";

const bubblePresets = [
  {
    id: "default",
    label: "Default",
    description: "Repository default bubble theme.",
    theme: { ...DEFAULT_BUBBLE_THEME },
  },
  {
    id: "classic",
    label: "Codex Blue",
    description: "Balanced blue chat bubbles with the custom look.",
    theme: {
      userBubbleBg: "#2563eb",
      userBubbleFg: "#ffffff",
      assistantBubbleBg: "#f8fafc",
      assistantBubbleFg: "#1f2937",
      radius: 18,
      shadowStrength: 18,
      borderWidth: 1,
      density: "cozy",
    },
  },
  {
    id: "imessage",
    label: "iMessage",
    description: "Brighter blue with softer cards.",
    theme: {
      userBubbleBg: "#1982fc",
      userBubbleFg: "#ffffff",
      assistantBubbleBg: "#e5e7eb",
      assistantBubbleFg: "#111827",
      radius: 22,
      shadowStrength: 14,
      borderWidth: 0,
      density: "cozy",
    },
  },
  {
    id: "telegram",
    label: "Telegram",
    description: "Telegram-inspired green outgoing bubble and clean neutral replies.",
    theme: {
      userBubbleBg: "#d9fdd3",
      userBubbleFg: "#1f2937",
      assistantBubbleBg: "#ffffff",
      assistantBubbleFg: "#1f2937",
      radius: 18,
      shadowStrength: 6,
      borderWidth: 1,
      density: "compact",
    },
  },
  {
    id: "notion",
    label: "Notion",
    description: "Quiet neutral tones and gentler rounding.",
    theme: {
      userBubbleBg: "#2f3437",
      userBubbleFg: "#ffffff",
      assistantBubbleBg: "#f5f5f4",
      assistantBubbleFg: "#292524",
      radius: 16,
      shadowStrength: 8,
      borderWidth: 1,
      density: "compact",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Dark assistant card with vivid reply bubble.",
    theme: {
      userBubbleBg: "#7c3aed",
      userBubbleFg: "#ffffff",
      assistantBubbleBg: "#111827",
      assistantBubbleFg: "#e5e7eb",
      radius: 20,
      shadowStrength: 20,
      borderWidth: 1,
      density: "cozy",
    },
  },
];

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

function getDensityPreviewPadding(density) {
  return density === "compact"
    ? { bubblePaddingX: "11px", bubblePaddingY: "7px", assistantPaddingX: "12px", assistantPaddingY: "8px" }
    : { bubblePaddingX: "14px", bubblePaddingY: "10px", assistantPaddingX: "14px", assistantPaddingY: "10px" };
}

function ColorControl(props) {
  const { value, onChange, ariaLabel } = props;

  return jsxs("div", {
    className: "flex items-center gap-2",
    children: [
      jsx("input", {
        type: "color",
        value,
        onChange: (event) => onChange(event.target.value),
        "aria-label": ariaLabel,
        className: swatchInputClassName,
      }),
      jsx("span", {
        className: colorCodeClassName,
        children: value.toUpperCase(),
      }),
    ],
  });
}

function SliderControl(props) {
  const { value, onChange, min, max, step, suffix, ariaLabel } = props;

  return jsxs("div", {
    className: "flex items-center gap-3",
    children: [
      jsx("input", {
        type: "range",
        min: String(min),
        max: String(max),
        step: String(step),
        value,
        onChange: (event) => onChange(Number(event.target.value)),
        className: rangeInputClassName,
        "aria-label": ariaLabel,
      }),
      jsxs("span", {
        className: "w-14 text-right text-sm text-token-text-secondary",
        children: [value, suffix],
      }),
    ],
  });
}

function DensityControl(props) {
  const { value, onChange } = props;

  return jsx(SegmentedToggle, {
    options: [
      { id: "compact", label: "Compact", ariaLabel: "Compact bubble density" },
      { id: "cozy", label: "Cozy", ariaLabel: "Cozy bubble density" },
    ],
    selectedId: value,
    onSelect: onChange,
    ariaLabel: "Bubble density",
  });
}

function PreviewBubble(props) {
  const { align, backgroundColor, foregroundColor, borderColor, borderWidth, shadow, radius, paddingX, paddingY, children } = props;
  const wrapperClassName = align === "end" ? "flex justify-end" : "flex justify-start";

  return jsx("div", {
    className: wrapperClassName,
    children: jsx("div", {
      className: "max-w-[85%] text-sm",
      style: {
        backgroundColor,
        color: foregroundColor,
        borderRadius: `${radius}px`,
        border: borderWidth > 0 ? `${borderWidth}px solid ${borderColor}` : "none",
        boxShadow: shadow,
        padding: `${paddingY} ${paddingX}`,
      },
      children,
    }),
  });
}

function BubblePreview(props) {
  const { theme } = props;
  const densityPadding = getDensityPreviewPadding(theme.density);
  const shadow = theme.shadowStrength > 0
    ? `0 10px ${12 + theme.shadowStrength * 0.8}px ${rgbaFromHex(theme.userBubbleBg, theme.shadowStrength / 100)}`
    : "none";

  return jsxs("div", {
    className: "flex min-w-[260px] flex-col gap-2 rounded-xl border border-token-border bg-token-bg-fog px-3 py-3",
    children: [
      jsx("div", {
        className: fieldLabelClassName,
        children: "Preview",
      }),
      jsx(PreviewBubble, {
        align: "start",
        backgroundColor: theme.assistantBubbleBg,
        foregroundColor: theme.assistantBubbleFg,
        borderColor: rgbaFromHex(theme.assistantBubbleFg, 0.12),
        borderWidth: theme.borderWidth,
        shadow: "none",
        radius: Math.max(10, theme.radius - 4),
        paddingX: densityPadding.assistantPaddingX,
        paddingY: densityPadding.assistantPaddingY,
        children: "This is how assistant replies will look.",
      }),
      jsx(PreviewBubble, {
        align: "end",
        backgroundColor: theme.userBubbleBg,
        foregroundColor: theme.userBubbleFg,
        borderColor: rgbaFromHex(theme.userBubbleBg, 0.34),
        borderWidth: theme.borderWidth,
        shadow,
        radius: theme.radius,
        paddingX: densityPadding.bubblePaddingX,
        paddingY: densityPadding.bubblePaddingY,
        children: "And this is your bubble style.",
      }),
    ],
  });
}

function BubblePresetPicker(props) {
  const { theme, onApplyPreset } = props;

  const selectedPresetId = React.useMemo(() => {
    const matchedPreset = bubblePresets.find((preset) => {
      const presetTheme = normalizeBubbleTheme(preset.theme);
      return JSON.stringify(presetTheme) === JSON.stringify(theme);
    });

    return matchedPreset ? matchedPreset.id : null;
  }, [theme]);

  return jsxs("div", {
    className: "flex flex-col gap-3",
    children: [
      jsx("div", {
        className: fieldLabelClassName,
        children: "Presets",
      }),
      jsx("div", {
        className: "grid grid-cols-2 gap-2 max-md:grid-cols-1",
        children: bubblePresets.map((preset) => {
          const isSelected = preset.id === selectedPresetId;
          const isOfficialDefault = preset.id === "default";
          const className = isSelected
            ? `${presetButtonClassName} ${selectedPresetButtonClassName}`
            : isOfficialDefault
              ? `${presetButtonClassName} ${officialPresetButtonClassName}`
              : presetButtonClassName;

          return jsxs(
            "button",
            {
              type: "button",
              className,
              onClick: () => onApplyPreset(preset.theme),
              children: [
                jsxs("div", {
                  className: "flex items-center justify-between gap-2",
                  children: [
                    jsx("div", {
                      className: "font-medium text-token-text-primary",
                      children: preset.label,
                    }),
                    isOfficialDefault
                      ? jsx("span", {
                          className: officialBadgeClassName,
                          children: "Official default",
                        })
                      : null,
                  ],
                }),
                jsx("div", {
                  className: "mt-1 text-xs text-token-text-secondary",
                  children: preset.description,
                }),
              ],
            },
            preset.id,
          );
        }),
      }),
    ],
  });
}

function ThemeCustomizer(props) {
  const { theme, setTheme } = props;

  const updateTheme = React.useCallback(
    (patch) => {
      setTheme((currentTheme) => normalizeBubbleTheme({ ...currentTheme, ...patch }));
    },
    [setTheme],
  );

  return jsxs("div", {
    className: "flex flex-col gap-3",
    children: [
      jsx(SettingsRow, {
        label: "Your bubble",
        description: "Background color for messages you send.",
        control: jsx(ColorControl, {
          value: theme.userBubbleBg,
          onChange: (value) => updateTheme({ userBubbleBg: value }),
          ariaLabel: "User bubble color",
        }),
      }),
      jsx(SettingsRow, {
        label: "Your text",
        description: "Text color inside your bubble.",
        control: jsx(ColorControl, {
          value: theme.userBubbleFg,
          onChange: (value) => updateTheme({ userBubbleFg: value }),
          ariaLabel: "User bubble text color",
        }),
      }),
      jsx(SettingsRow, {
        label: "Assistant bubble",
        description: "Background color for assistant replies.",
        control: jsx(ColorControl, {
          value: theme.assistantBubbleBg,
          onChange: (value) => updateTheme({ assistantBubbleBg: value }),
          ariaLabel: "Assistant bubble color",
        }),
      }),
      jsx(SettingsRow, {
        label: "Assistant text",
        description: "Text color for assistant replies.",
        control: jsx(ColorControl, {
          value: theme.assistantBubbleFg,
          onChange: (value) => updateTheme({ assistantBubbleFg: value }),
          ariaLabel: "Assistant bubble text color",
        }),
      }),
      jsx(SettingsRow, {
        label: "Corner radius",
        description: "Adjust how rounded the chat bubbles feel.",
        control: jsx(SliderControl, {
          value: theme.radius,
          onChange: (value) => updateTheme({ radius: value }),
          min: 8,
          max: 28,
          step: 1,
          suffix: "px",
          ariaLabel: "Bubble corner radius",
        }),
      }),
      jsx(SettingsRow, {
        label: "Shadow",
        description: "Make the sent bubble flatter or more elevated.",
        control: jsx(SliderControl, {
          value: theme.shadowStrength,
          onChange: (value) => updateTheme({ shadowStrength: value }),
          min: 0,
          max: 28,
          step: 1,
          suffix: "%",
          ariaLabel: "Bubble shadow strength",
        }),
      }),
      jsx(SettingsRow, {
        label: "Border",
        description: "Control the outline thickness for both bubbles.",
        control: jsx(SliderControl, {
          value: theme.borderWidth,
          onChange: (value) => updateTheme({ borderWidth: value }),
          min: 0,
          max: 2,
          step: 1,
          suffix: "px",
          ariaLabel: "Bubble border width",
        }),
      }),
      jsx(SettingsRow, {
        label: "Density",
        description: "Compact packs messages tighter, cozy gives them more room.",
        control: jsx(DensityControl, {
          value: theme.density,
          onChange: (value) => updateTheme({ density: value }),
        }),
      }),
    ],
  });
}

function HeaderPinnedThreadSettings() {
  const [threadPinsMode, setThreadPinsMode] = React.useState(() => readStoredThreadPinsMode());

  React.useEffect(() => {
    const syncSettingsState = () => {
      setThreadPinsMode(readStoredThreadPinsMode());
    };

    window.addEventListener(THREAD_PINS_MODE_UPDATED_EVENT, syncSettingsState);
    return () => {
      window.removeEventListener(THREAD_PINS_MODE_UPDATED_EVENT, syncSettingsState);
    };
  }, []);

  const onSelectMode = React.useCallback((nextMode) => {
    const resolvedMode = writeStoredThreadPinsMode(nextMode);
    setThreadPinsMode(resolvedMode);
  }, []);

  const headerModeOptions = React.useMemo(
    () => [
      { id: THREAD_PINS_MODE_DEFAULT, label: "Current default", ariaLabel: "Use the current header behavior" },
      { id: THREAD_PINS_MODE_HEADER, label: "Pinned threads", ariaLabel: "Mirror existing pinned threads into the header" },
    ],
    [],
  );

  return jsxs(SettingsGroup, {
    children: [
      jsx(SettingsGroup.Header, {
        title: "Pinned threads in top bar",
        subtitle: "Mirror the same pinned threads from the sidebar into a dedicated top bar.",
      }),
      jsx(SettingsGroup.Content, {
        children: jsxs("div", {
          className: "flex flex-col gap-3",
          children: [
            jsx(SettingsCard, {
              children: jsx(SettingsRow, {
                label: "Top bar behavior",
                description: "Choose between the stock layout and a dedicated top strip that mirrors your existing sidebar pins.",
                control: jsx(SegmentedToggle, {
                  options: headerModeOptions,
                  selectedId: threadPinsMode,
                  onSelect: onSelectMode,
                  ariaLabel: "Pinned threads header mode",
                }),
              }),
            }),
            jsx(SettingsCard, {
              children: jsx("div", {
                className: "flex flex-col gap-2 p-3 text-sm text-token-text-secondary",
                children: jsxs("div", {
                  className: subtlePanelClassName,
                  children: [
                    jsx("div", {
                      className: "font-medium text-token-text-primary",
                      children: "How it works",
                    }),
                    jsx("div", {
                      className: "mt-1",
                      children: "This setting does not create a second pin list. It simply mirrors the threads you already pinned in the sidebar into the top bar.",
                    }),
                    jsx("div", {
                      className: "mt-2",
                      children: "Use the existing Pin/Unpin action in the sidebar, and the header will stay in sync automatically.",
                    }),
                  ],
                }),
              }),
            }),
          ],
        }),
      }),
    ],
  });
}

function MessageAppearanceSettings() {
  const [messageStyle, setMessageStyle] = React.useState(() => readStoredMessageStyle());
  const [bubbleTheme, setBubbleTheme] = React.useState(() => readStoredBubbleTheme());

  React.useEffect(() => {
    applyMessageStyle(messageStyle);
  }, [messageStyle]);

  React.useEffect(() => {
    applyBubbleTheme(bubbleTheme);
  }, [bubbleTheme]);

  const options = React.useMemo(
    () => [
      { id: STYLE_DEFAULT, label: "Default", ariaLabel: "Default message style" },
      { id: STYLE_BUBBLES, label: "Bubbles", ariaLabel: "Bubble message style" },
    ],
    [],
  );

  const onSelectStyle = React.useCallback((nextStyle) => {
    const normalizedValue = normalizeMessageStyle(nextStyle);
    setMessageStyle(normalizedValue);
    writeStoredMessageStyle(normalizedValue);
  }, []);

  const onSetTheme = React.useCallback((nextTheme) => {
    setBubbleTheme((currentTheme) => {
      const resolvedTheme = typeof nextTheme === "function" ? nextTheme(currentTheme) : nextTheme;
      const normalizedTheme = normalizeBubbleTheme(resolvedTheme);
      writeStoredBubbleTheme(normalizedTheme);
      return normalizedTheme;
    });
  }, []);

  const onResetTheme = React.useCallback(() => {
    onSetTheme({ ...DEFAULT_BUBBLE_THEME });
  }, [onSetTheme]);

  const showBubbleCustomizer = messageStyle === STYLE_BUBBLES;

  return jsxs(React.Fragment, {
    children: [
      jsxs(SettingsGroup, {
        children: [
          jsx(SettingsGroup.Header, {
            title: "Chat bubbles",
            subtitle: "Choose how conversation messages are rendered in the thread view.",
          }),
          jsx(SettingsGroup.Content, {
            children: jsxs("div", {
              className: "flex flex-col gap-3",
              children: [
                jsx(SettingsCard, {
                  children: jsx(SettingsRow, {
                    label: "Message style",
                    description: "Switch between the stock layout and the custom bubble layout.",
                    control: jsx(SegmentedToggle, {
                      options,
                      selectedId: messageStyle,
                      onSelect: onSelectStyle,
                      ariaLabel: "Message style",
                    }),
                  }),
                }),
                showBubbleCustomizer
                  ? jsx(SettingsCard, {
                      children: jsxs("div", {
                        className: "flex flex-col gap-4 p-3",
                        children: [
                          jsxs("div", {
                            className: "flex items-start justify-between gap-4 max-md:flex-col",
                            children: [
                              jsxs("div", {
                                className: "flex min-w-0 flex-1 flex-col gap-4",
                                children: [
                                  jsx(BubblePresetPicker, {
                                    theme: bubbleTheme,
                                    onApplyPreset: onSetTheme,
                                  }),
                                  jsx(ThemeCustomizer, {
                                    theme: bubbleTheme,
                                    setTheme: onSetTheme,
                                  }),
                                ],
                              }),
                              jsx(BubblePreview, {
                                theme: bubbleTheme,
                              }),
                            ],
                          }),
                          jsx("div", {
                            className: "flex justify-end",
                            children: jsx("button", {
                              type: "button",
                              className: resetButtonClassName,
                              onClick: onResetTheme,
                              children: "Reset bubble style",
                            }),
                          }),
                        ],
                      }),
                    })
                  : null,
              ],
            }),
          }),
        ],
      }),
      jsx(HeaderPinnedThreadSettings, {}),
    ],
  });
}

export { MessageAppearanceSettings as C };
