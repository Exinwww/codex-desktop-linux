import { t as createReact } from "./react-DEh3VhWB.js";
import { t as createJsxRuntime } from "./jsx-runtime-BjItZljr.js";
import { n as SettingsGroup, t as SettingsCard } from "./settings-surface-FyeZDgVr.js";
import { t as SettingsRow } from "./settings-row-BAVonNmd.js";
import { t as SegmentedToggle } from "./segmented-toggle-6vaOhoHs.js";

const React = createReact();
const jsxRuntime = createJsxRuntime();
const { jsx, jsxs } = jsxRuntime;

const REMOTE_SETTINGS_ENDPOINT = "/__codex_dev__/remote-setting";
const subtlePanelClassName = "rounded-lg border border-token-border bg-token-bg-fog px-3 py-2";
const statusValueClassName = "font-medium text-token-text-primary";
const errorTextClassName = "text-sm text-token-status-error";
const inputClassName = "w-full rounded-md border border-token-border bg-token-bg-primary px-3 py-2 text-sm text-token-text-primary outline-none transition focus:border-token-border-strong";
const labelClassName = "text-xs font-medium uppercase tracking-wide text-token-text-tertiary";
const helperTextClassName = "text-xs text-token-text-tertiary";
const saveButtonClassName = "rounded-md bg-token-text-primary px-3 py-2 text-sm font-medium text-token-bg-primary transition disabled:cursor-not-allowed disabled:opacity-50";

const remoteToggleOptions = [
  { id: "enabled", label: "Enabled", ariaLabel: "Enable sandbox remote relay" },
  { id: "disabled", label: "Disabled", ariaLabel: "Disable sandbox remote relay" },
];

const modeOptions = [
  { id: "localhost", label: "Localhost", ariaLabel: "Use the bundled localhost relay" },
  { id: "custom-relay", label: "Custom relay", ariaLabel: "Connect to an external relay" },
];

function getDefaultState() {
  return {
    supported: true,
    loading: true,
    saving: false,
    dirty: false,
    enabled: false,
    running: false,
    mode: "localhost",
    relayOrigin: "http://127.0.0.1:9001",
    rendezvousOrigin: "http://127.0.0.1:9002",
    deviceId: "sandbox-local",
    hostToken: "",
    pairingCode: "",
    connectUrl: "",
    launchMode: "all-in-one",
    error: null,
    lastError: null,
  };
}

function describeStatus(state) {
  if (!state.supported) {
    return "Unavailable";
  }

  if (state.saving) {
    return state.enabled ? "Applying..." : "Stopping...";
  }

  if (state.running) {
    return state.mode === "localhost" ? "Relay + host agent running" : "Host agent running";
  }

  return state.enabled ? "Waiting for sandbox" : "Stopped";
}

async function requestRemoteState(init) {
  const response = await window.fetch(REMOTE_SETTINGS_ENDPOINT, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init && init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...init,
  });

  if (response.status === 404) {
    const error = new Error("Sandbox remote controls are not available in this session.");
    error.code = "unsupported";
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error === "string" && payload.error.length > 0
      ? payload.error
      : `Remote control request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

function buildRemotePayload(state, overrides) {
  return {
    enabled: Object.prototype.hasOwnProperty.call(overrides || {}, "enabled") ? Boolean(overrides.enabled) : Boolean(state.enabled),
    mode: state.mode === "custom-relay" ? "custom-relay" : "localhost",
    relayOrigin: String(state.relayOrigin || "").trim(),
    rendezvousOrigin: String(state.rendezvousOrigin || "").trim(),
    deviceId: String(state.deviceId || "").trim(),
    hostToken: String(state.hostToken || "").trim(),
    pairingCode: String(state.pairingCode || "").trim().toUpperCase(),
  };
}

function RemoteSettings() {
  const [state, setState] = React.useState(() => getDefaultState());

  const applyPayload = React.useCallback((payload) => {
    setState((currentState) => ({
      ...currentState,
      supported: true,
      loading: false,
      saving: false,
      dirty: false,
      enabled: Boolean(payload.enabled),
      running: Boolean(payload.running),
      mode: payload.mode === "custom-relay" ? "custom-relay" : "localhost",
      relayOrigin: typeof payload.relayOrigin === "string" && payload.relayOrigin.length > 0
        ? payload.relayOrigin
        : currentState.relayOrigin,
      rendezvousOrigin: typeof payload.rendezvousOrigin === "string" && payload.rendezvousOrigin.length > 0
        ? payload.rendezvousOrigin
        : currentState.rendezvousOrigin,
      deviceId: typeof payload.deviceId === "string" && payload.deviceId.length > 0
        ? payload.deviceId
        : currentState.deviceId,
      hostToken: typeof payload.hostToken === "string"
        ? payload.hostToken
        : currentState.hostToken,
      pairingCode: typeof payload.pairingCode === "string"
        ? payload.pairingCode
        : currentState.pairingCode,
      connectUrl: typeof payload.connectUrl === "string"
        ? payload.connectUrl
        : currentState.connectUrl,
      launchMode: typeof payload.launchMode === "string" && payload.launchMode.length > 0
        ? payload.launchMode
        : currentState.launchMode,
      error: null,
      lastError: typeof payload.lastError === "string" && payload.lastError.length > 0 ? payload.lastError : null,
    }));
  }, []);

  const markUnsupported = React.useCallback(() => {
    setState((currentState) => ({
      ...currentState,
      supported: false,
      loading: false,
      saving: false,
      dirty: false,
      running: false,
      error: "This panel is only available in sandbox sessions started with ./scripts/sandbox-run.sh.",
    }));
  }, []);

  const loadState = React.useCallback(async (signal) => {
    try {
      const payload = await requestRemoteState({ signal });
      applyPayload(payload);
    } catch (error) {
      if (signal && signal.aborted) {
        return;
      }

      if (error && error.code === "unsupported") {
        markUnsupported();
        return;
      }

      setState((currentState) => ({
        ...currentState,
        loading: false,
        saving: false,
        error: error instanceof Error ? error.message : "Failed to load remote relay state.",
      }));
    }
  }, [applyPayload, markUnsupported]);

  React.useEffect(() => {
    const abortController = new AbortController();
    loadState(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [loadState]);

  React.useEffect(() => {
    if (!state.supported || state.dirty || state.saving) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      loadState();
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadState, state.dirty, state.saving, state.supported]);

  const persistRemoteState = React.useCallback(async (overrides) => {
    if (!state.supported || state.loading || state.saving) {
      return;
    }

    const payload = buildRemotePayload(state, overrides);
    setState((currentState) => ({
      ...currentState,
      ...payload,
      saving: true,
      dirty: false,
      error: null,
    }));

    try {
      const nextState = await requestRemoteState({
        method: "PUT",
        body: JSON.stringify(payload),
      });
      applyPayload(nextState);
    } catch (error) {
      if (error && error.code === "unsupported") {
        markUnsupported();
        return;
      }

      setState((currentState) => ({
        ...currentState,
        saving: false,
        dirty: true,
        error: error instanceof Error ? error.message : "Failed to update remote relay state.",
      }));
    }
  }, [applyPayload, markUnsupported, state]);

  const onSelectEnabled = React.useCallback((nextMode) => {
    persistRemoteState({ enabled: nextMode === "enabled" });
  }, [persistRemoteState]);

  const onSave = React.useCallback(() => {
    persistRemoteState();
  }, [persistRemoteState]);

  const controlsDisabled = !state.supported || state.loading || state.saving;
  const selectedMode = state.enabled ? "enabled" : "disabled";
  const statusLabel = describeStatus(state);
  const activeError = state.error ?? state.lastError;
  const launchModeLabel = state.mode === "localhost" ? "Bundled localhost relay + host agent" : "Host agent only";

  return jsxs(SettingsGroup, {
    children: [
      jsx(SettingsGroup.Header, {
        title: "Remote relay",
        subtitle: "Configure how this sandboxed Codex app exposes itself for remote browser access.",
      }),
      jsx(SettingsGroup.Content, {
        children: jsxs("div", {
          className: "flex flex-col gap-3",
          children: [
            jsx(SettingsCard, {
              children: jsx(SettingsRow, {
                label: "Remote access",
                description: state.supported
                  ? "Enable remote access and choose whether the app launches the built-in localhost relay or connects only to an external relay."
                  : "Remote controls are unavailable outside the sandbox webview server.",
                control: jsx(SegmentedToggle, {
                  options: remoteToggleOptions,
                  selectedId: selectedMode,
                  onSelect: onSelectEnabled,
                  ariaLabel: "Sandbox remote relay",
                }),
              }),
            }),
            jsx(SettingsCard, {
              children: jsxs("div", {
                className: "flex flex-col gap-4 p-3 text-sm text-token-text-secondary",
                children: [
                  jsxs("div", {
                    className: "flex flex-col gap-2",
                    children: [
                      jsx("span", {
                        className: labelClassName,
                        children: "Connection mode",
                      }),
                      jsx(SegmentedToggle, {
                        options: modeOptions,
                        selectedId: state.mode,
                        onSelect: (nextMode) => {
                          if (controlsDisabled) {
                            return;
                          }
                          setState((currentState) => ({
                            ...currentState,
                            dirty: true,
                            mode: nextMode === "custom-relay" ? "custom-relay" : "localhost",
                          }));
                        },
                        ariaLabel: "Remote connection mode",
                      }),
                      jsx("span", {
                        className: helperTextClassName,
                        children: state.mode === "localhost"
                          ? "Localhost mode launches the bundled relay inside the sandbox machine for debugging."
                          : "Custom relay mode launches only the host agent and points it at your external relay server.",
                      }),
                    ],
                  }),
                  jsxs("label", {
                    className: "flex flex-col gap-2",
                    children: [
                      jsx("span", {
                        className: labelClassName,
                        children: "Relay origin",
                      }),
                      jsx("input", {
                        className: inputClassName,
                        type: "text",
                        value: state.relayOrigin,
                        disabled: controlsDisabled,
                        onChange: (event) => {
                          const value = event && event.target ? event.target.value : "";
                          setState((currentState) => ({
                            ...currentState,
                            dirty: true,
                            relayOrigin: value,
                          }));
                        },
                        placeholder: "https://relay.example.com",
                      }),
                      jsx("span", {
                        className: helperTextClassName,
                        children: state.mode === "localhost"
                          ? "For localhost debugging this is usually http://127.0.0.1:9001."
                          : "Use the public origin of your deployed relay server.",
                      }),
                    ],
                  }),
                  jsxs("label", {
                    className: "flex flex-col gap-2",
                    children: [
                      jsx("span", {
                        className: labelClassName,
                        children: "Rendezvous origin",
                      }),
                      jsx("input", {
                        className: inputClassName,
                        type: "text",
                        value: state.rendezvousOrigin,
                        disabled: controlsDisabled,
                        onChange: (event) => {
                          const value = event && event.target ? event.target.value : "";
                          setState((currentState) => ({
                            ...currentState,
                            dirty: true,
                            rendezvousOrigin: value,
                          }));
                        },
                        placeholder: "https://rendezvous.example.com",
                      }),
                      jsx("span", {
                        className: helperTextClassName,
                        children: state.mode === "localhost"
                          ? "For localhost debugging this is usually http://127.0.0.1:9002."
                          : "Use the control-plane rendezvous origin that browsers open first to obtain relay sessions.",
                      }),
                    ],
                  }),
                  jsxs("label", {
                    className: "flex flex-col gap-2",
                    children: [
                      jsx("span", {
                        className: labelClassName,
                        children: "Device ID",
                      }),
                      jsx("input", {
                        className: inputClassName,
                        type: "text",
                        value: state.deviceId,
                        disabled: controlsDisabled,
                        onChange: (event) => {
                          const value = event && event.target ? event.target.value : "";
                          setState((currentState) => ({
                            ...currentState,
                            dirty: true,
                            deviceId: value,
                          }));
                        },
                        placeholder: "sandbox-local",
                      }),
                      jsx("span", {
                        className: helperTextClassName,
                        children: "The remote browser connects to this device ID, for example ?deviceId=sandbox-local.",
                      }),
                    ],
                  }),
                  jsxs("label", {
                    className: "flex flex-col gap-2",
                    children: [
                      jsx("span", {
                        className: labelClassName,
                        children: "Host token",
                      }),
                      jsx("input", {
                        className: inputClassName,
                        type: "password",
                        value: state.hostToken,
                        disabled: controlsDisabled,
                        onChange: (event) => {
                          const value = event && event.target ? event.target.value : "";
                          setState((currentState) => ({
                            ...currentState,
                            dirty: true,
                            hostToken: value,
                          }));
                        },
                        placeholder: "Optional shared secret for host registration",
                      }),
                      jsx("span", {
                        className: helperTextClassName,
                        children: "If your relay requires host authentication, enter the shared token used by the host agent.",
                      }),
                    ],
                  }),
                  jsxs("label", {
                    className: "flex flex-col gap-2",
                    children: [
                      jsx("span", {
                        className: labelClassName,
                        children: "Pairing code",
                      }),
                      jsx("input", {
                        className: inputClassName,
                        type: "text",
                        value: state.pairingCode,
                        disabled: controlsDisabled,
                        onChange: (event) => {
                          const value = event && event.target ? event.target.value : "";
                          setState((currentState) => ({
                            ...currentState,
                            dirty: true,
                            pairingCode: String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
                          }));
                        },
                        placeholder: "PAIRCODE",
                      }),
                      jsx("span", {
                        className: helperTextClassName,
                        children: "Localhost and public relay both use the same rendezvous pairing flow. Open the connect URL below and enter this code.",
                      }),
                    ],
                  }),
                  jsx("div", {
                    className: "flex justify-end",
                    children: jsx("button", {
                      type: "button",
                      className: saveButtonClassName,
                      disabled: controlsDisabled,
                      onClick: onSave,
                      children: state.saving ? "Saving..." : "Save settings",
                    }),
                  }),
                ],
              }),
            }),
            jsx(SettingsCard, {
              children: jsxs("div", {
                className: "flex flex-col gap-3 p-3 text-sm text-token-text-secondary",
                children: [
                  jsxs("div", {
                    className: subtlePanelClassName,
                    children: [
                      jsxs("div", {
                        className: "grid gap-2 sm:grid-cols-2 lg:grid-cols-4",
                        children: [
                          jsxs("div", {
                            className: "flex flex-col gap-1",
                            children: [
                              jsx("span", { children: "Status" }),
                              jsx("span", {
                                className: statusValueClassName,
                                children: statusLabel,
                              }),
                            ],
                          }),
                          jsxs("div", {
                            className: "flex flex-col gap-1",
                            children: [
                              jsx("span", { children: "Launch mode" }),
                              jsx("span", {
                                className: statusValueClassName,
                                children: launchModeLabel,
                              }),
                            ],
                          }),
                          jsxs("div", {
                            className: "flex flex-col gap-1",
                            children: [
                              jsx("span", { children: "Relay" }),
                              jsx("span", {
                                className: statusValueClassName,
                                children: state.relayOrigin,
                              }),
                            ],
                          }),
                          jsxs("div", {
                            className: "flex flex-col gap-1",
                            children: [
                              jsx("span", { children: "Rendezvous" }),
                              jsx("span", {
                                className: statusValueClassName,
                                children: state.rendezvousOrigin,
                              }),
                            ],
                          }),
                          jsxs("div", {
                            className: "flex flex-col gap-1",
                            children: [
                              jsx("span", { children: "Device ID" }),
                              jsx("span", {
                                className: statusValueClassName,
                                children: state.deviceId,
                              }),
                            ],
                          }),
                          jsxs("div", {
                            className: "flex flex-col gap-1",
                            children: [
                              jsx("span", { children: "Pairing code" }),
                              jsx("span", {
                                className: statusValueClassName,
                                children: state.pairingCode,
                              }),
                            ],
                          }),
                        ],
                      }),
                      jsx("div", {
                        className: "mt-2",
                        children: state.mode === "localhost"
                          ? "Changes apply immediately and the next sandbox launch will reuse these localhost settings."
                          : "Changes apply immediately and the sandbox will reconnect its host agent to the configured external relay.",
                      }),
                      state.connectUrl
                        ? jsxs("div", {
                            className: "mt-2 flex flex-col gap-1",
                            children: [
                              jsx("span", { children: "Browser entry URL" }),
                              jsx("code", {
                                className: "break-all rounded bg-token-bg-primary px-2 py-1 text-xs text-token-text-primary",
                                children: state.connectUrl,
                              }),
                            ],
                          })
                        : null,
                    ],
                  }),
                  activeError
                    ? jsx("div", {
                        className: errorTextClassName,
                        children: activeError,
                      })
                    : null,
                ],
              }),
            }),
          ],
        }),
      }),
    ],
  });
}

export { RemoteSettings as C };
