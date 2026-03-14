// ==UserScript==
// @name         JSONATA JAVA Checker
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      0.10
// @description  JSONata kontrola přes lokální Java backend
// @author       Lukáš Sedláček
// @match        https://try.jsonata.org/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=jsonata.org
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      get-shared.1g5lolddjght.us-east.codeengine.appdomain.cloud
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jsonata-java-checker.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jsonata-java-checker.js
// ==/UserScript==

(function () {
  "use strict";

  const ENDPOINT = "http://localhost:8097/usy-idsmari-mddpg01/00361100020000000000000000000104/mddp/debug/jsonata";
  const TOOLBAR_BUTTON_ID = "jsonata-java-checker-run";
  const PANEL_ID = "jsonata-java-checker-panel";
  const STYLE_ID = "jsonata-java-checker-style";
  const BRIDGE_SCRIPT_ID = "jsonata-java-checker-bridge";
  const BRIDGE_REQUEST_EVENT = "jsonata-java-checker:bridge-request";
  const BRIDGE_RESPONSE_EVENT = "jsonata-java-checker:bridge-response";
  const SHARED_ENDPOINT = "https://get-shared.1g5lolddjght.us-east.codeengine.appdomain.cloud?id=";

  const state = {
    collapsed: true,
  };

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
    if (typeof value === "string") {
      return value;
    }

    return JSON.stringify(value, null, 2);
  }

  function parseJson(text) {
    return JSON.parse(text);
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
        const sharedEndpoint = ${JSON.stringify(SHARED_ENDPOINT)};

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

        async function getSharedDocument() {
          const pathParts = window.location.pathname.split("/").filter(Boolean);
          const sharedId = pathParts[0];

          if (!sharedId) {
            return null;
          }

          const response = await fetch(sharedEndpoint + encodeURIComponent(sharedId));
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error || "Failed to load shared document");
          }

          return payload;
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

          const sharedDocument = await getSharedDocument();
          if (sharedDocument) {
            return {
              source: "shared-document",
              json: typeof sharedDocument.json === "undefined" ? "" : JSON.stringify(sharedDocument.json, null, 2),
              jsonata: sharedDocument.jsonata || "",
              bindings: sharedDocument.bindings || "",
              result: sharedDocument.result || "",
              panelStates: null,
              externalLibsCount: Array.isArray(sharedDocument.externalLibs) ? sharedDocument.externalLibs.length : 0,
            };
          }

          throw new Error("Exerciser state not found in React tree and shared document is unavailable.");
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
        panelPresent: Boolean(document.getElementById(PANEL_ID)),
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

  function getSharedIdFromLocation() {
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    return pathParts[0] || null;
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: function (response) {
          try {
            resolve(JSON.parse(response.responseText));
          } catch (error) {
            reject(error);
          }
        },
        onerror: function (error) {
          reject(error);
        },
        ontimeout: function (error) {
          reject(error);
        },
      });
    });
  }

  async function getSharedDocumentFallback() {
    const sharedId = getSharedIdFromLocation();

    if (!sharedId) {
      return null;
    }

    const payload = await requestJson(`${SHARED_ENDPOINT}${encodeURIComponent(sharedId)}`);

    return {
      input: typeof payload.json === "undefined" ? "" : JSON.stringify(payload.json, null, 2),
      expression: payload.jsonata || "",
      bindings: payload.bindings || "",
      result: payload.result || "",
      source: "shared-document-userscript",
      panelStates: null,
      externalLibsCount: Array.isArray(payload.externalLibs) ? payload.externalLibs.length : 0,
      models: [],
    };
  }

  async function getEditorValues() {
    let payload;

    try {
      payload = await requestBridge("get-editor-values");
    } catch (bridgeError) {
      const sharedFallback = await getSharedDocumentFallback().catch(() => null);
      if (sharedFallback) {
        return sharedFallback;
      }
      throw bridgeError;
    }

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
      #${PANEL_ID} {
        position: fixed;
        top: 84px;
        right: 0;
        width: min(440px, calc(100vw - 16px));
        max-height: calc(100vh - 100px);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        background: #fbfcfe;
        color: #14212b;
        border: 1px solid #cbd5df;
        border-right: none;
        border-radius: 18px 0 0 18px;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.18);
        overflow: hidden;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        font-family: "Segoe UI", Tahoma, sans-serif;
      }

      #${PANEL_ID}.is-collapsed {
        transform: translateX(calc(100% - 190px));
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
      }

      #${PANEL_ID}.is-collapsed .jsonata-java-checker__body {
        display: none;
      }

      #${PANEL_ID} .jsonata-java-checker__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: linear-gradient(135deg, #12344d, #1b4d6b);
        color: #f8fbff;
        cursor: pointer;
      }

      #${PANEL_ID} .jsonata-java-checker__summary {
        min-width: 0;
      }

      #${PANEL_ID} .jsonata-java-checker__title {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.8;
      }

      #${PANEL_ID} .jsonata-java-checker__headline {
        margin-top: 3px;
        font-size: 14px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${PANEL_ID} .jsonata-java-checker__header-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      #${PANEL_ID} .jsonata-java-checker__badge {
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        background: rgba(255, 255, 255, 0.16);
        color: #f8fbff;
      }

      #${PANEL_ID} .jsonata-java-checker__badge.is-success {
        background: #d1fae5;
        color: #065f46;
      }

      #${PANEL_ID} .jsonata-java-checker__badge.is-warning {
        background: #fef3c7;
        color: #92400e;
      }

      #${PANEL_ID} .jsonata-java-checker__badge.is-error {
        background: #fee2e2;
        color: #991b1b;
      }

      #${PANEL_ID} .jsonata-java-checker__badge.is-running {
        background: #dbeafe;
        color: #1d4ed8;
      }

      #${PANEL_ID} .jsonata-java-checker__toggle {
        border: none;
        background: rgba(255, 255, 255, 0.14);
        color: inherit;
        width: 30px;
        height: 30px;
        border-radius: 999px;
        cursor: pointer;
        font-size: 16px;
      }

      #${PANEL_ID} .jsonata-java-checker__body {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 14px;
        overflow: auto;
      }

      #${PANEL_ID} .jsonata-java-checker__toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      #${PANEL_ID} .jsonata-java-checker__run,
      #${TOOLBAR_BUTTON_ID} {
        border: none;
        border-radius: 10px;
        background: #0f766e;
        color: #ffffff;
        padding: 8px 12px;
        font-weight: 700;
        cursor: pointer;
      }

      #${PANEL_ID} .jsonata-java-checker__run:hover,
      #${TOOLBAR_BUTTON_ID}:hover {
        background: #0b5d57;
      }

      #${PANEL_ID} .jsonata-java-checker__meta {
        font-size: 12px;
        color: #51606d;
      }

      #${PANEL_ID} .jsonata-java-checker__card {
        background: #f2f6fa;
        border: 1px solid #d6e0e8;
        border-radius: 14px;
        padding: 12px;
      }

      #${PANEL_ID} .jsonata-java-checker__card-title {
        margin: 0 0 8px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #51606d;
      }

      #${PANEL_ID} .jsonata-java-checker__message {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
      }

      #${PANEL_ID} .jsonata-java-checker__pre {
        margin: 0;
        padding: 12px;
        border-radius: 12px;
        background: #0f172a;
        color: #e2e8f0;
        overflow: auto;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: Consolas, "Courier New", monospace;
      }

      #${PANEL_ID} .jsonata-java-checker__comparison {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }

      #${PANEL_ID} .jsonata-java-checker__comparison-item {
        padding: 10px;
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid #d6e0e8;
      }

      #${PANEL_ID} .jsonata-java-checker__comparison-label {
        display: block;
        margin-bottom: 4px;
        font-size: 11px;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      #${PANEL_ID} .jsonata-java-checker__comparison-value {
        font-size: 13px;
        font-weight: 700;
      }

      @media (max-width: 700px) {
        #${PANEL_ID} {
          top: auto;
          bottom: 12px;
          width: calc(100vw - 12px);
          max-height: 70vh;
        }

        #${PANEL_ID}.is-collapsed {
          transform: translateX(calc(100% - 170px));
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

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);

    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.classList.add("is-collapsed");
      panel.innerHTML = `
        <div class="jsonata-java-checker__header">
          <div class="jsonata-java-checker__summary">
            <div class="jsonata-java-checker__title">Java Checker</div>
            <div class="jsonata-java-checker__headline">Zatím nezkontrolováno</div>
          </div>
          <div class="jsonata-java-checker__header-meta">
            <span class="jsonata-java-checker__badge">Idle</span>
            <button type="button" class="jsonata-java-checker__toggle" aria-label="Toggle panel">›</button>
          </div>
        </div>
        <div class="jsonata-java-checker__body">
          <div class="jsonata-java-checker__toolbar">
            <button type="button" class="jsonata-java-checker__run">Run Java check</button>
            <button type="button" class="jsonata-java-checker__diagnostics">Dump diagnostics</button>
            <div class="jsonata-java-checker__meta">Porovnání používá normalizovaný JSON bez ohledu na pořadí klíčů.</div>
          </div>
          <div class="jsonata-java-checker__card">
            <h3 class="jsonata-java-checker__card-title">Shrnutí</h3>
            <p class="jsonata-java-checker__message">Spusť kontrolu a v hlavičce panelu uvidíš jen stav porovnání. Detail výsledku může zůstat schovaný.</p>
          </div>
          <div class="jsonata-java-checker__comparison">
            <div class="jsonata-java-checker__comparison-item">
              <span class="jsonata-java-checker__comparison-label">Lokální výsledek</span>
              <span class="jsonata-java-checker__comparison-value" data-role="local-status">Čeká</span>
            </div>
            <div class="jsonata-java-checker__comparison-item">
              <span class="jsonata-java-checker__comparison-label">Java backend</span>
              <span class="jsonata-java-checker__comparison-value" data-role="remote-status">Čeká</span>
            </div>
            <div class="jsonata-java-checker__comparison-item">
              <span class="jsonata-java-checker__comparison-label">Poslední běh</span>
              <span class="jsonata-java-checker__comparison-value" data-role="timestamp">-</span>
            </div>
          </div>
          <div class="jsonata-java-checker__card">
            <h3 class="jsonata-java-checker__card-title">Java výstup</h3>
            <pre class="jsonata-java-checker__pre" data-role="output">Klikni na "Run Java check".</pre>
          </div>
        </div>
      `;

      const header = panel.querySelector(".jsonata-java-checker__header");
      const toggle = panel.querySelector(".jsonata-java-checker__toggle");
      const runButton = panel.querySelector(".jsonata-java-checker__run");
      const diagnosticsButton = panel.querySelector(".jsonata-java-checker__diagnostics");

      header.addEventListener("click", (event) => {
        if (event.target === runButton) {
          return;
        }

        state.collapsed = !state.collapsed;
        renderCollapsedState();
      });

      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        state.collapsed = !state.collapsed;
        renderCollapsedState();
      });

      runButton.addEventListener("click", () => {
        runCheck();
      });

      diagnosticsButton.addEventListener("click", () => {
        dumpDiagnostics();
      });

      document.body.append(panel);
    }

    renderCollapsedState();
    return panel;
  }

  function renderCollapsedState() {
    const panel = document.getElementById(PANEL_ID);

    if (!panel) {
      return;
    }

    panel.classList.toggle("is-collapsed", state.collapsed);

    const toggle = panel.querySelector(".jsonata-java-checker__toggle");
    toggle.textContent = state.collapsed ? "‹" : "›";
    toggle.setAttribute("aria-label", state.collapsed ? "Expand panel" : "Collapse panel");
  }

  function updatePanel(status, headline, message, output, details = {}) {
    const panel = ensurePanel();
    const badge = panel.querySelector(".jsonata-java-checker__badge");
    const headlineNode = panel.querySelector(".jsonata-java-checker__headline");
    const messageNode = panel.querySelector(".jsonata-java-checker__message");
    const outputNode = panel.querySelector('[data-role="output"]');
    const localStatusNode = panel.querySelector('[data-role="local-status"]');
    const remoteStatusNode = panel.querySelector('[data-role="remote-status"]');
    const timestampNode = panel.querySelector('[data-role="timestamp"]');

    badge.className = "jsonata-java-checker__badge";
    badge.textContent = status.label;

    if (status.tone) {
      badge.classList.add(status.tone);
    }

    headlineNode.textContent = headline;
    messageNode.textContent = message;
    outputNode.textContent = output;
    localStatusNode.textContent = details.localStatus || "-";
    remoteStatusNode.textContent = details.remoteStatus || "-";
    timestampNode.textContent = details.timestamp || "-";
  }

  function ensureToolbarButton() {
    const rightMenu = document.getElementById("banner4");

    if (!rightMenu || document.getElementById(TOOLBAR_BUTTON_ID)) {
      return;
    }

    const button = document.createElement("button");
    button.id = TOOLBAR_BUTTON_ID;
    button.type = "button";
    button.textContent = "Run Java check";
    button.addEventListener("click", () => {
      runCheck();
    });
    rightMenu.prepend(button);
  }

  async function dumpDiagnostics() {
    const diagnostics = await collectDiagnostics();
    const prettyDiagnostics = JSON.stringify(diagnostics, null, 2);

    updatePanel(
      { label: "Info" },
      "Diagnostika připravena",
      "Zkopíruj výstup níže a pošli mi ho. Je v něm stav Monaco API, modely a relevantní DOM prvky stránky.",
      prettyDiagnostics,
      {
        localStatus: diagnostics.monaco.available ? `Monaco ${diagnostics.monaco.modelCount} modelů` : "Monaco nedostupné",
        remoteStatus: "Diagnostika",
        timestamp: new Date().toLocaleTimeString("cs-CZ"),
      },
    );

    state.collapsed = false;
    renderCollapsedState();
    console.log("JSONATA JAVA Checker diagnostics", diagnostics);
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

      try {
        localResult = parseJson(localResultText);
      } catch (error) {
        updatePanel(
          { label: "Local error", tone: "is-error" },
          "Lokální výsledek nejde přečíst",
          `JSONata Exerciser nevrátil validní JSON: ${error.message}`,
          localResultText || "Prázdný lokální výstup",
          {
            localStatus: "Nevalidní JSON",
            remoteStatus: "Nepuštěno",
            timestamp,
          },
        );
        state.collapsed = false;
        renderCollapsedState();
        return;
      }

      const remoteResult = await postData(ENDPOINT, dtoIn);
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
        },
      );
      state.collapsed = false;
      renderCollapsedState();
      console.error(error);
    }
  }

  function initialize() {
    ensureStyles();
    ensurePanel();
    ensureToolbarButton();
  }

  initialize();

  const observer = new MutationObserver(() => {
    ensureToolbarButton();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
