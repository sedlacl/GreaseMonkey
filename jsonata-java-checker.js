// ==UserScript==
// @name         JSONATA JAVA Checker
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      0.33
// @description  JSONata kontrola přes lokální Java backend
// @author       Lukáš Sedláček
// @match        https://try.jsonata.org/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=jsonata.org
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jsonata-java-checker.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jsonata-java-checker.js
// ==/UserScript==

(function () {
  "use strict";

  const DEFAULT_ENDPOINT = "http://localhost:8097/usy-idsmari-mddpg01/00361100020000000000000000000104/mddp/debug/jsonata";
  const ENDPOINT_STORAGE_KEY = "jsonata-java-checker:endpoint";
  const TOOLBAR_BUTTON_ID = "jsonata-java-checker-run";
  const TOOLBAR_TOGGLE_BUTTON_ID = "jsonata-java-checker-toggle-inline";
  const TOOLBAR_SETTINGS_BUTTON_ID = "jsonata-java-checker-settings";
  const INLINE_RESULT_PANEL_ID = "jsonata-java-checker-inline-result";
  const SETTINGS_DIALOG_ID = "jsonata-java-checker-settings-dialog";
  const STYLE_ID = "jsonata-java-checker-style";
  const BRIDGE_SCRIPT_ID = "jsonata-java-checker-bridge";
  const BRIDGE_REQUEST_EVENT = "jsonata-java-checker:bridge-request";
  const BRIDGE_RESPONSE_EVENT = "jsonata-java-checker:bridge-response";
  const BOOTSTRAP_RETRY_LIMIT = 40;
  const BOOTSTRAP_RETRY_DELAY = 500;
  const state = {
    status: { label: "Idle", tone: "" },
    inlineResultAvailable: false,
    inlineResultVisible: false,
    inlineResultPreference: false,
    layoutListenersRegistered: false,
    editorContainerBaseStyle: null,
  };

  function formatRunButtonLabel(statusLabel) {
    return `Java check: ${statusLabel}`;
  }

  function formatToggleButtonLabel(isVisible) {
    return isVisible ? "Hide Java" : "Show Java";
  }

  function shouldShowInlineResult(statusLabel) {
    return statusLabel === "OK" || statusLabel === "Mismatch" || statusLabel === "Error" || statusLabel === "Local error";
  }

  function safeGetText(element) {
    return element?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function truncateText(value, maxLength = 160) {
    if (typeof value !== "string") {
      return value;
    }

    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }

  function normalizeValue(value) {
    if (Array.isArray(value)) {
      return value.map(normalizeValue);
    }

    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = normalizeValue(value[key]);
          return result;
        }, {});
    }

    return value;
  }

  function stringifyForDisplay(value) {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === "string" ? serialized : String(value);
  }

  function parseJson(text) {
    return JSON.parse(text);
  }

  function getEndpoint() {
    try {
      const storedValue = localStorage.getItem(ENDPOINT_STORAGE_KEY);
      return storedValue && storedValue.trim() ? storedValue.trim() : DEFAULT_ENDPOINT;
    } catch (error) {
      return DEFAULT_ENDPOINT;
    }
  }

  function saveEndpoint(value) {
    const trimmedValue = String(value || "").trim();

    try {
      if (!trimmedValue || trimmedValue === DEFAULT_ENDPOINT) {
        localStorage.removeItem(ENDPOINT_STORAGE_KEY);
      } else {
        localStorage.setItem(ENDPOINT_STORAGE_KEY, trimmedValue);
      }
    } catch (error) {
      console.error("Unable to persist endpoint setting.", error);
    }
  }

  function getSettingsButtonTitle() {
    return `Nastavit URL Java backendu. Aktuální URL: ${getEndpoint()}`;
  }

  function ensureBridge() {
    if (document.getElementById(BRIDGE_SCRIPT_ID)) {
      return;
    }

    const script = document.createElement("script");
    script.id = BRIDGE_SCRIPT_ID;
    script.textContent = `
      (() => {
        const requestEvent = ${JSON.stringify(BRIDGE_REQUEST_EVENT)};
        const responseEvent = ${JSON.stringify(BRIDGE_RESPONSE_EVENT)};

        function normalizeValue(value) {
          if (Array.isArray(value)) {
            return value.map(normalizeValue);
          }

          if (value && typeof value === "object") {
            return Object.keys(value)
              .sort()
              .reduce((result, key) => {
                result[key] = normalizeValue(value[key]);
                return result;
              }, {});
          }

          return value;
        }

        function getModels() {
          return window.monaco?.editor?.getModels?.() || [];
        }

        function getReactNodeKey(element, prefix) {
          return Object.keys(element || {}).find((key) => key.startsWith(prefix));
        }

        function getFiberFromElement(element) {
          const fiberKey = getReactNodeKey(element, "__reactFiber$");
          return fiberKey ? element[fiberKey] : null;
        }

        function findFiberStateNodeWithState(rootFiber) {
          const queue = [rootFiber];
          const visited = new Set();

          while (queue.length) {
            const fiber = queue.shift();
            if (!fiber || visited.has(fiber)) {
              continue;
            }

            visited.add(fiber);

            const stateNode = fiber.stateNode;
            if (stateNode?.state && typeof stateNode.state === "object") {
              const state = stateNode.state;
              if (Object.prototype.hasOwnProperty.call(state, "json") && Object.prototype.hasOwnProperty.call(state, "jsonata")) {
                return stateNode;
              }
            }

            if (fiber.child) {
              queue.push(fiber.child);
            }
            if (fiber.sibling) {
              queue.push(fiber.sibling);
            }
          }

          return null;
        }

        function findStateNodeFromElementTree(rootElement) {
          const candidates = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];

          for (const element of candidates) {
            let fiber = getFiberFromElement(element);

            while (fiber) {
              const stateNode = fiber.stateNode;
              if (stateNode?.state && typeof stateNode.state === "object") {
                const componentState = stateNode.state;
                if (Object.prototype.hasOwnProperty.call(componentState, "json") && Object.prototype.hasOwnProperty.call(componentState, "jsonata")) {
                  return stateNode;
                }
              }

              fiber = fiber.return;
            }
          }

          return null;
        }

        function getExerciserStateNode() {
          const rootElement = document.getElementById("root");
          if (!rootElement) {
            return null;
          }

          const containerKey = getReactNodeKey(rootElement, "__reactContainer$");
          const fiberKey = getReactNodeKey(rootElement, "__reactFiber$");
          const rootFiber = containerKey ? rootElement[containerKey]?._internalRoot?.current : fiberKey ? rootElement[fiberKey] : null;

          if (rootFiber) {
            const fromRootFiber = findFiberStateNodeWithState(rootFiber);
            if (fromRootFiber) {
              return fromRootFiber;
            }
          }

          return findStateNodeFromElementTree(rootElement);
        }

        async function getExerciserValues() {
          const stateNode = getExerciserStateNode();
          if (stateNode?.state) {
            return {
              source: "react-state",
              json: stateNode.state.json,
              jsonata: stateNode.state.jsonata,
              bindings: stateNode.state.bindings,
              result: stateNode.state.result,
              panelStates: stateNode.state.panelStates,
              externalLibsCount: Array.isArray(stateNode.state.externalLibs) ? stateNode.state.externalLibs.length : 0,
            };
          }

          throw new Error("Exerciser state not found in React tree.");
        }

        function serializeModels() {
          return getModels().map((model, index) => ({
            index,
            uri: model.uri?.toString?.() || null,
            languageId: typeof model.getLanguageId === "function" ? model.getLanguageId() : null,
            lineCount: typeof model.getLineCount === "function" ? model.getLineCount() : null,
            valuePreview: typeof model.getValue === "function" ? model.getValue().slice(0, 120) : null,
          }));
        }

        window.addEventListener(requestEvent, async (event) => {
          const detail = event.detail || {};
          const response = { id: detail.id };

          try {
            if (detail.action === "diagnostics") {
              const exerciserState = getExerciserStateNode()?.state || null;
              response.payload = {
                monacoAvailable: Boolean(window.monaco),
                hasEditorApi: Boolean(window.monaco?.editor),
                hasGetModels: typeof window.monaco?.editor?.getModels === "function",
                hasGetModel: typeof window.monaco?.editor?.getModel === "function",
                hasUriParse: typeof window.monaco?.Uri?.parse === "function",
                modelCount: getModels().length,
                models: serializeModels(),
                reactStateAvailable: Boolean(exerciserState),
                reactStateKeys: exerciserState ? Object.keys(exerciserState) : [],
                reactStatePreview: exerciserState ? {
                  jsonPreview: typeof exerciserState.json === "string" ? exerciserState.json.slice(0, 120) : exerciserState.json,
                  jsonataPreview: typeof exerciserState.jsonata === "string" ? exerciserState.jsonata.slice(0, 120) : exerciserState.jsonata,
                  bindingsPreview: typeof exerciserState.bindings === "string" ? exerciserState.bindings.slice(0, 120) : exerciserState.bindings,
                  resultPreview: typeof exerciserState.result === "string" ? exerciserState.result.slice(0, 120) : exerciserState.result,
                } : null,
              };
            } else if (detail.action === "get-editor-values") {
              const values = await getExerciserValues();
              response.payload = {
                input: values.json,
                expression: values.jsonata,
                bindings: values.bindings,
                result: values.result,
                source: values.source,
                panelStates: values.panelStates,
                externalLibsCount: values.externalLibsCount,
                models: serializeModels(),
              };
            } else if (detail.action === "normalize-preview") {
              response.payload = normalizeValue(detail.value);
            } else {
              throw new Error("Unknown bridge action: " + detail.action);
            }
          } catch (error) {
            response.error = {
              message: error?.message || String(error),
              stack: error?.stack || null,
            };
          }

          window.dispatchEvent(new CustomEvent(responseEvent, { detail: response }));
        });
      })();
    `;

    (document.documentElement || document.head || document.body).append(script);
  }

  function requestBridge(action, payload = {}) {
    ensureBridge();

    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse);
        reject(new Error(`Bridge timeout for action: ${action}`));
      }, 8000);

      function handleResponse(event) {
        if (event.detail?.id !== id) {
          return;
        }

        window.clearTimeout(timeoutId);
        window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse);

        if (event.detail.error) {
          const error = new Error(event.detail.error.message || `Bridge action failed: ${action}`);
          error.stack = event.detail.error.stack || error.stack;
          reject(error);
          return;
        }

        resolve(event.detail.payload);
      }

      window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse);
      window.dispatchEvent(new CustomEvent(BRIDGE_REQUEST_EVENT, { detail: { id, action, ...payload } }));
    });
  }

  async function getMonacoDiagnostics() {
    try {
      const diagnostics = await requestBridge("diagnostics");
      return {
        available: diagnostics.monacoAvailable,
        hasEditorApi: diagnostics.hasEditorApi,
        hasGetModels: diagnostics.hasGetModels,
        hasGetModel: diagnostics.hasGetModel,
        hasUriParse: diagnostics.hasUriParse,
        modelCount: diagnostics.modelCount,
        models: (diagnostics.models || []).map((model) => ({
          ...model,
          valuePreview: truncateText(model.valuePreview, 120),
        })),
        reactStateAvailable: diagnostics.reactStateAvailable,
        reactStateKeys: diagnostics.reactStateKeys,
        reactStatePreview: diagnostics.reactStatePreview,
      };
    } catch (error) {
      return {
        available: false,
        reason: error.message,
      };
    }
  }

  function getDomDiagnostics() {
    const textareas = Array.from(document.querySelectorAll("textarea")).map((element, index) => ({
      index,
      className: element.className || null,
      ariaLabel: element.getAttribute("aria-label"),
      placeholder: element.getAttribute("placeholder"),
      valuePreview: truncateText(element.value || "", 120),
    }));

    const editableElements = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).map((element, index) => ({
      index,
      tagName: element.tagName,
      className: element.className || null,
      ariaLabel: element.getAttribute("aria-label"),
      role: element.getAttribute("role"),
      textPreview: truncateText(safeGetText(element), 120),
    }));

    const banner = document.getElementById("banner4");
    const headingCandidates = Array.from(document.querySelectorAll("h1, h2, h3, [id^='banner']"))
      .slice(0, 12)
      .map((element) => ({
        tagName: element.tagName,
        id: element.id || null,
        text: truncateText(safeGetText(element), 120),
      }));

    return {
      readyState: document.readyState,
      url: window.location.href,
      title: document.title,
      banner4Present: Boolean(banner),
      banner4Children: banner ? Array.from(banner.children).map((element) => ({ tagName: element.tagName, text: truncateText(safeGetText(element), 80) })) : [],
      textareaCount: textareas.length,
      textareas,
      editableElementCount: editableElements.length,
      editableElements,
      headingCandidates,
    };
  }

  async function collectDiagnostics() {
    return {
      timestamp: new Date().toISOString(),
      location: window.location.href,
      userAgent: navigator.userAgent,
      userscript: {
        panelPresent: Boolean(document.getElementById(INLINE_RESULT_PANEL_ID)),
        toolbarButtonPresent: Boolean(document.getElementById(TOOLBAR_BUTTON_ID)),
      },
      globals: {
        unsafeWindowEqualsWindow: unsafeWindow === window,
        hasUnsafeWindowMonaco: Boolean(unsafeWindow.monaco),
        unsafeWindowKeysSample: Object.keys(unsafeWindow).slice(0, 30),
      },
      monaco: await getMonacoDiagnostics(),
      dom: getDomDiagnostics(),
    };
  }

  function getAllModels() {
    throw new Error("Direct Monaco access is unavailable in the userscript sandbox. Use the bridge instead.");
  }

  async function getEditorValues() {
    const payload = await requestBridge("get-editor-values");

    return {
      input: (payload.input || "").replace(/&nbsp;/g, " ").trim(),
      expression: (payload.expression || "").replace(/&nbsp;/g, " ").trim(),
      bindings: (payload.bindings || "").replace(/&nbsp;/g, " ").trim(),
      result: (payload.result || "").replace(/&nbsp;/g, " ").trim(),
      source: payload.source || "unknown",
      panelStates: payload.panelStates || null,
      externalLibsCount: payload.externalLibsCount || 0,
      models: payload.models || [],
    };
  }

  function compareValues(localValue, remoteValue) {
    return JSON.stringify(normalizeValue(localValue)) === JSON.stringify(normalizeValue(remoteValue));
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOOLBAR_BUTTON_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 10px;
        background: #0f766e;
        color: #ffffff;
        font-weight: 700;
        cursor: pointer;
        line-height: 1;
        white-space: nowrap;
        box-sizing: border-box;
        flex: 0 0 auto;
        height: 28px;
        padding: 0 12px;
        margin: 0;
        vertical-align: middle;
      }

      #${TOOLBAR_BUTTON_ID}:hover {
        background: #0b5d57;
      }

      #${TOOLBAR_TOGGLE_BUTTON_ID},
      #${TOOLBAR_SETTINGS_BUTTON_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(15, 23, 42, 0.14);
        border-radius: 10px;
        background: rgba(248, 250, 252, 0.96);
        color: #0f172a;
        cursor: pointer;
        box-sizing: border-box;
        flex: 0 0 auto;
        height: 28px;
        padding: 0 10px;
        margin: 0;
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
      }

      #${TOOLBAR_TOGGLE_BUTTON_ID}:hover,
      #${TOOLBAR_SETTINGS_BUTTON_ID}:hover {
        background: #ffffff;
      }

      #${TOOLBAR_TOGGLE_BUTTON_ID}[hidden] {
        display: none;
      }

      #${TOOLBAR_SETTINGS_BUTTON_ID} {
        width: 28px;
        padding: 0;
        border-radius: 999px;
        font-size: 15px;
        line-height: 1;
      }

      #${TOOLBAR_BUTTON_ID}[data-status-tone="is-success"] {
        background: #0f766e;
      }

      #${TOOLBAR_BUTTON_ID}[data-status-tone="is-warning"] {
        background: #b45309;
      }

      #${TOOLBAR_BUTTON_ID}[data-status-tone="is-error"] {
        background: #b91c1c;
      }

      #${TOOLBAR_BUTTON_ID}[data-status-tone="is-running"] {
        background: #1d4ed8;
      }

      #banner4 {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        overflow: hidden;
        min-height: 0;
        max-height: 32px;
      }

      #banner4 > * {
        flex: 0 0 auto;
      }

      #banner4 a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      #banner4 img {
        padding-top: 0;
        display: block;
      }

      #${INLINE_RESULT_PANEL_ID} {
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        bottom: 0;
        padding: 0;
        border: 0;
        border-top: 1px solid #d6e0e8;
        border-radius: 0;
        background: #f3f3f3;
        box-shadow: none;
        box-sizing: border-box;
        width: auto;
        max-width: none;
        overflow: hidden;
        z-index: 5;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      #${INLINE_RESULT_PANEL_ID}.is-hidden {
        display: none;
      }

      #${INLINE_RESULT_PANEL_ID} .jsonata-java-checker__editor-fallback {
        margin: 0;
        padding: 0 6px 6px 26px;
        border-radius: 0;
        background: #f3f3f3;
        color: #7f1d1d;
        overflow: auto;
        flex: 1 1 auto;
        min-height: 0;
        font-size: 14px;
        line-height: 19px;
        white-space: pre;
        word-break: normal;
        font-family: Consolas, "Courier New", monospace;
        font-weight: normal;
      }

      #${INLINE_RESULT_PANEL_ID} .jsonata-java-checker__editor-fallback.is-hidden {
        display: none;
      }

      #${SETTINGS_DIALOG_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.35);
        box-sizing: border-box;
      }

      #${SETTINGS_DIALOG_ID}.is-open {
        display: flex;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-panel {
        width: min(680px, 100%);
        padding: 20px;
        border-radius: 14px;
        background: #ffffff;
        box-shadow: 0 20px 50px rgba(15, 23, 42, 0.24);
        box-sizing: border-box;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-heading {
        margin: 0 0 8px;
        color: #0f172a;
        font-size: 18px;
        font-weight: 700;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-copy {
        margin: 0 0 14px;
        color: #334155;
        font-size: 13px;
        line-height: 1.5;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-input {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        box-sizing: border-box;
        font: inherit;
        color: #0f172a;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-button {
        border: 1px solid rgba(15, 23, 42, 0.14);
        border-radius: 10px;
        background: rgba(248, 250, 252, 0.96);
        color: #0f172a;
        cursor: pointer;
        height: 34px;
        padding: 0 12px;
        font-size: 13px;
        font-weight: 700;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-button:hover {
        background: #ffffff;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-button.is-primary {
        border-color: #0f766e;
        background: #0f766e;
        color: #ffffff;
      }

      #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-button.is-primary:hover {
        background: #0b5d57;
      }

      @media (max-width: 700px) {
        #${INLINE_RESULT_PANEL_ID} {
          left: 0;
          right: 0;
          bottom: 0;
        }

        #${SETTINGS_DIALOG_ID} {
          padding: 12px;
        }

        #${SETTINGS_DIALOG_ID} .jsonata-java-checker__settings-panel {
          padding: 16px;
        }
      }
    `;

    document.head.append(style);
  }

  function postData(url = "", data = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: url,
        headers: {
          "Content-Type": "application/json",
        },
        data: JSON.stringify(data),
        onload: function (response) {
          try {
            const json = JSON.parse(response.responseText);
            resolve(json);
          } catch (e) {
            reject(e);
          }
        },
        onerror: function (err) {
          reject(err);
        },
        ontimeout: function (err) {
          reject(err);
        },
      });
    });
  }

  function findEditorHost(editor) {
    if (!editor) {
      return null;
    }

    return editor.closest(".pane, [class*='Pane'], [class*='pane'], [class*='panel'], [class*='split'], section, article") || editor.parentElement;
  }

  function findEditorContainer(editor) {
    if (!editor) {
      return null;
    }

    return editor.closest(".react-monaco-editor-container") || editor.parentElement;
  }

  function rememberEditorContainerBaseStyle(editorContainer) {
    if (!editorContainer || state.editorContainerBaseStyle) {
      return;
    }

    state.editorContainerBaseStyle = {
      height: editorContainer.style.height,
      bottom: editorContainer.style.bottom,
    };
  }

  function findResultPanelAnchor() {
    const resultEditor = document.querySelector(".result-pane, [class*='result-pane'], [class*='resultPane'], [data-testid='result-pane']");
    if (!resultEditor) {
      const editors = Array.from(document.querySelectorAll(".monaco-editor"));
      const lastEditor = editors[editors.length - 1];
      if (lastEditor) {
        const host = findEditorHost(lastEditor);
        return host ? { host, insertionPoint: lastEditor } : null;
      }

      return null;
    }

    const host = findEditorHost(resultEditor);
    return host ? { host, insertionPoint: resultEditor } : null;
  }

  function findJavaPanelAnchor() {
    const jsonLabel = document.getElementById("json-label");
    const host = jsonLabel?.closest?.(".pane") || null;
    const insertionPoint = host?.querySelector?.(".monaco-editor") || document.querySelector(".monaco-editor");
    if (!host || !insertionPoint) {
      return null;
    }

    return { host, insertionPoint };
  }

  function syncInlineResultPanelLayout(panel, javaAnchor, resultAnchor) {
    if (!panel || !javaAnchor?.host) {
      return;
    }

    const hostRect = javaAnchor.host.getBoundingClientRect();
    const resultRect = resultAnchor?.insertionPoint?.getBoundingClientRect?.();
    let topOffset = 0;

    if (resultRect && hostRect.height > 0) {
      topOffset = Math.round(resultRect.top - hostRect.top);
    }

    const minTop = 0;
    const maxTop = Math.max(minTop, Math.round(hostRect.height - 80));
    const clampedTop = Math.max(minTop, Math.min(topOffset, maxTop));
    panel.style.top = `${clampedTop}px`;
  }

  function resetInlineResultReservation(javaAnchor) {
    const editorContainer = findEditorContainer(javaAnchor?.insertionPoint);
    if (!editorContainer) {
      return;
    }

    rememberEditorContainerBaseStyle(editorContainer);
    editorContainer.style.height = state.editorContainerBaseStyle?.height || "";
    editorContainer.style.bottom = state.editorContainerBaseStyle?.bottom || "";
  }

  function syncInlineResultReservation(panel, javaAnchor) {
    const editorContainer = findEditorContainer(javaAnchor?.insertionPoint);
    if (!editorContainer || !javaAnchor?.host) {
      return;
    }

    rememberEditorContainerBaseStyle(editorContainer);

    javaAnchor.host.style.overflow = "hidden";
    javaAnchor.host.style.overflowY = "hidden";

    if (!state.inlineResultVisible || panel.classList.contains("is-hidden")) {
      resetInlineResultReservation(javaAnchor);
      return;
    }

    const hostRect = javaAnchor.host.getBoundingClientRect();
    const panelTop = Number.parseFloat(panel.style.top || "0");
    const editorHeight = Math.max(80, Math.min(Math.round(panelTop), Math.round(hostRect.height)));

    editorContainer.style.bottom = "auto";
    editorContainer.style.height = `${editorHeight}px`;
  }

  function syncInlineResultLayout() {
    const panel = document.getElementById(INLINE_RESULT_PANEL_ID);
    const javaAnchor = findJavaPanelAnchor();

    if (!panel || !javaAnchor?.host || !javaAnchor?.insertionPoint) {
      resetInlineResultReservation(javaAnchor);
      return;
    }

    syncInlineResultPanelLayout(panel, javaAnchor, findResultPanelAnchor());
    syncInlineResultReservation(panel, javaAnchor);
  }

  function deferInlineResultLayoutSync() {
    window.setTimeout(() => {
      syncInlineResultLayout();
      window.dispatchEvent(new Event("resize"));
    }, 0);
  }

  function ensureInlineResultPanel() {
    const javaAnchor = findJavaPanelAnchor();
    if (!javaAnchor?.host || !javaAnchor?.insertionPoint) {
      return null;
    }

    if (window.getComputedStyle(javaAnchor.host).position === "static") {
      javaAnchor.host.style.position = "relative";
    }

    let panel = document.getElementById(INLINE_RESULT_PANEL_ID);

    if (!panel) {
      panel = document.createElement("section");
      panel.id = INLINE_RESULT_PANEL_ID;
      panel.className = "is-hidden";
      panel.innerHTML = `
        <pre class="jsonata-java-checker__editor-fallback is-hidden" data-role="inline-output-fallback"></pre>
      `;
    }

    if (panel.parentElement !== javaAnchor.host) {
      panel.remove();
      javaAnchor.host.append(panel);
    }

    syncInlineResultLayout();

    return panel;
  }

  function registerLayoutSyncListeners() {
    if (state.layoutListenersRegistered) {
      return;
    }

    state.layoutListenersRegistered = true;

    window.addEventListener("resize", () => {
      syncInlineResultLayout();
    });

    document.addEventListener(
      "pointerup",
      () => {
        window.setTimeout(() => {
          syncInlineResultLayout();
        }, 0);
      },
      true,
    );
  }

  function closeSettingsDialog() {
    const dialog = document.getElementById(SETTINGS_DIALOG_ID);
    if (!dialog) {
      return;
    }

    dialog.classList.remove("is-open");
  }

  function ensureSettingsDialog() {
    let dialog = document.getElementById(SETTINGS_DIALOG_ID);
    if (dialog) {
      return dialog;
    }

    dialog = document.createElement("div");
    dialog.id = SETTINGS_DIALOG_ID;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML = `
      <div class="jsonata-java-checker__settings-panel" data-role="settings-panel">
        <h2 class="jsonata-java-checker__settings-heading">Java Checker Settings</h2>
        <p class="jsonata-java-checker__settings-copy">Změněná URL se uloží do localStorage a použije se při dalším Java checku. Prázdná hodnota obnoví defaultní URL.</p>
        <input class="jsonata-java-checker__settings-input" data-role="settings-endpoint" type="url" spellcheck="false" />
        <div class="jsonata-java-checker__settings-actions">
          <button type="button" class="jsonata-java-checker__settings-button" data-role="settings-reset">Default</button>
          <button type="button" class="jsonata-java-checker__settings-button" data-role="settings-cancel">Cancel</button>
          <button type="button" class="jsonata-java-checker__settings-button is-primary" data-role="settings-save">Save</button>
        </div>
      </div>
    `;

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeSettingsDialog();
      }
    });

    dialog.querySelector('[data-role="settings-cancel"]').addEventListener("click", () => {
      closeSettingsDialog();
    });

    dialog.querySelector('[data-role="settings-reset"]').addEventListener("click", () => {
      const input = dialog.querySelector('[data-role="settings-endpoint"]');
      input.value = DEFAULT_ENDPOINT;
      input.focus();
      input.select();
    });

    dialog.querySelector('[data-role="settings-save"]').addEventListener("click", () => {
      const input = dialog.querySelector('[data-role="settings-endpoint"]');
      saveEndpoint(input.value);
      closeSettingsDialog();

      const settingsButton = document.getElementById(TOOLBAR_SETTINGS_BUTTON_ID);
      if (settingsButton) {
        settingsButton.title = getSettingsButtonTitle();
      }
    });

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettingsDialog();
      }

      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        dialog.querySelector('[data-role="settings-save"]').click();
      }
    });

    document.body.append(dialog);
    return dialog;
  }

  function openSettingsDialog() {
    const dialog = ensureSettingsDialog();
    const input = dialog.querySelector('[data-role="settings-endpoint"]');
    input.value = getEndpoint();
    dialog.classList.add("is-open");
    input.focus();
    input.select();
  }

  function setInlineResultVisibility(visible, { scrollIntoView = false } = {}) {
    state.inlineResultPreference = Boolean(visible);
    state.inlineResultVisible = state.inlineResultPreference && state.inlineResultAvailable;

    const toggleButton = document.getElementById(TOOLBAR_TOGGLE_BUTTON_ID);
    if (toggleButton) {
      toggleButton.hidden = !state.inlineResultAvailable;
      toggleButton.textContent = formatToggleButtonLabel(state.inlineResultVisible);
      toggleButton.title = state.inlineResultVisible ? "Skrýt detail Java výsledku" : "Zobrazit detail Java výsledku";
    }

    const inlinePanel = ensureInlineResultPanel();
    if (!inlinePanel) {
      return;
    }

    inlinePanel.classList.toggle("is-hidden", !state.inlineResultVisible);
    syncInlineResultLayout();
    deferInlineResultLayoutSync();
  }

  function updatePanel(status, headline, message, output, details = {}) {
    state.status = status;
    state.inlineResultAvailable = shouldShowInlineResult(status.label);

    const toolbarButton = document.getElementById(TOOLBAR_BUTTON_ID);
    if (toolbarButton) {
      toolbarButton.textContent = formatRunButtonLabel(status.label);
      toolbarButton.dataset.statusTone = status.tone || "";
      toolbarButton.title = headline;
    }

    const inlinePanel = ensureInlineResultPanel();
    if (!inlinePanel) {
      return;
    }

    const inlineOutputFallback = inlinePanel.querySelector('[data-role="inline-output-fallback"]');

    if (typeof details.openInline === "boolean") {
      setInlineResultVisibility(details.openInline, { scrollIntoView: details.openInline === true });
    } else {
      state.inlineResultVisible = state.inlineResultPreference && state.inlineResultAvailable;
      inlinePanel.classList.toggle("is-hidden", !state.inlineResultVisible);

      const toggleButton = document.getElementById(TOOLBAR_TOGGLE_BUTTON_ID);
      if (toggleButton) {
        toggleButton.hidden = !state.inlineResultAvailable;
        toggleButton.textContent = formatToggleButtonLabel(state.inlineResultVisible);
        toggleButton.title = state.inlineResultVisible ? "Skrýt detail Java výsledku" : "Zobrazit detail Java výsledku";
      }
    }

    inlineOutputFallback.textContent = output;
    inlineOutputFallback.classList.remove("is-hidden");
    inlineOutputFallback.scrollTop = 0;
    inlineOutputFallback.scrollLeft = 0;
    syncInlineResultLayout();
    deferInlineResultLayoutSync();
  }

  function ensureToolbarButton() {
    const rightMenu = document.getElementById("banner4");

    if (!rightMenu) {
      return;
    }

    let toggleButton = document.getElementById(TOOLBAR_TOGGLE_BUTTON_ID);
    if (!toggleButton) {
      toggleButton = document.createElement("button");
      toggleButton.id = TOOLBAR_TOGGLE_BUTTON_ID;
      toggleButton.type = "button";
      toggleButton.hidden = true;
      toggleButton.textContent = formatToggleButtonLabel(false);
      toggleButton.addEventListener("click", () => {
        setInlineResultVisibility(!state.inlineResultVisible, { scrollIntoView: !state.inlineResultVisible });
      });
      rightMenu.prepend(toggleButton);
    }

    let settingsButton = document.getElementById(TOOLBAR_SETTINGS_BUTTON_ID);
    if (!settingsButton) {
      settingsButton = document.createElement("button");
      settingsButton.id = TOOLBAR_SETTINGS_BUTTON_ID;
      settingsButton.type = "button";
      settingsButton.textContent = "⚙";
      settingsButton.setAttribute("aria-label", "Settings");
      settingsButton.addEventListener("click", () => {
        openSettingsDialog();
      });
      rightMenu.append(settingsButton);
    }

    let button = document.getElementById(TOOLBAR_BUTTON_ID);
    if (!button) {
      button = document.createElement("button");
      button.id = TOOLBAR_BUTTON_ID;
      button.type = "button";
      button.addEventListener("click", () => {
        runCheck();
      });
      rightMenu.prepend(button);
    }

    button.textContent = formatRunButtonLabel(state.status.label);
    button.dataset.statusTone = state.status.tone || "";
    settingsButton.title = getSettingsButtonTitle();
    setInlineResultVisibility(state.inlineResultVisible);
  }

  async function runCheck() {
    const timestamp = new Date().toLocaleTimeString("cs-CZ");

    updatePanel(
      { label: "Running", tone: "is-running" },
      "Porovnávám výsledky",
      "Volám lokální Java backend a porovnávám odpověď s výsledkem v JSONata Exerciseru.",
      "Čekám na odpověď z Java backendu...",
      {
        localStatus: "Načítám",
        remoteStatus: "Volám backend",
        timestamp,
      },
    );

    try {
      const editorValues = await getEditorValues();
      const inputValue = editorValues.input;
      const expression = editorValues.expression;
      const localResultText = editorValues.result;

      const dtoIn = {
        expression,
        inputValue,
      };

      let localResult;
      let localParseError = null;

      try {
        localResult = parseJson(localResultText);
      } catch (error) {
        localParseError = error;
      }

      const remoteResult = await postData(getEndpoint(), dtoIn);

      if (localParseError) {
        updatePanel(
          { label: "Local error", tone: "is-error" },
          "Lokální výsledek nejde přečíst",
          `JSONata Exerciser nevrátil validní JSON: ${localParseError.message}. Java backend byl přesto zavolán a jeho odpověď je níže.`,
          stringifyForDisplay(remoteResult),
          {
            localStatus: "Nevalidní JSON",
            remoteStatus: "Odpověď načtena",
            timestamp,
            openInline: true,
          },
        );
        return;
      }

      const isMatch = compareValues(localResult, remoteResult);

      updatePanel(
        isMatch ? { label: "OK", tone: "is-success" } : { label: "Mismatch", tone: "is-warning" },
        isMatch ? "Výsledek sedí" : "Výsledek nesedí",
        isMatch
          ? `Lokální JSONata výsledek a Java backend vrací stejná data po normalizaci JSON objektů. Zdroj dat: ${editorValues.source}.`
          : `Lokální JSONata výsledek a Java backend se liší. Detail z backendu je níže. Zdroj dat: ${editorValues.source}.`,
        stringifyForDisplay(remoteResult),
        {
          localStatus: `Validní JSON (${editorValues.source})`,
          remoteStatus: isMatch ? "Shoda" : "Neshoda",
          timestamp,
        },
      );
    } catch (error) {
      updatePanel(
        { label: "Error", tone: "is-error" },
        "Kontrola selhala",
        `Volání Java backendu nebo přístup k editoru skončil chybou: ${error.message || error}`,
        error.stack || String(error),
        {
          localStatus: "Neznámé",
          remoteStatus: "Chyba",
          timestamp,
          openInline: true,
        },
      );
      console.error(error);
    }
  }

  function initialize() {
    ensureStyles();
    registerLayoutSyncListeners();
    ensureToolbarButton();
    ensureSettingsDialog();
    ensureInlineResultPanel();
  }

  function startBootstrapRetries() {
    let attempt = 0;

    const timerId = window.setInterval(() => {
      attempt += 1;

      ensureToolbarButton();
      ensureInlineResultPanel();

      const toolbarReady = Boolean(document.getElementById(TOOLBAR_BUTTON_ID));
      const toggleReady = Boolean(document.getElementById(TOOLBAR_TOGGLE_BUTTON_ID));
      const bannerReady = Boolean(document.getElementById("banner4"));
      const anchorReady = Boolean(findResultPanelAnchor()) && Boolean(findJavaPanelAnchor());

      if ((bannerReady && toolbarReady && toggleReady && anchorReady) || attempt >= BOOTSTRAP_RETRY_LIMIT) {
        window.clearInterval(timerId);
      }
    }, BOOTSTRAP_RETRY_DELAY);
  }

  initialize();
  startBootstrapRetries();
})();
