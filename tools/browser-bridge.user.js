// ==UserScript==
// @name         Browser Bridge for Cursor Agent
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.3
// @description  Polls a local bridge server so a Cursor agent can execute JS and read results from your logged-in browser.
// @author       Lukáš Sedláček
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const BRIDGE_URL = "http://127.0.0.1:8766";
  const POLL_MS = 500;
  const FLAG = "__gmBrowserBridge";
  const PANEL_ID = "gm-browser-bridge-panel";
  const LOG_LIMIT = 40;

  // Captcha / third-party iframes also match *://*/* and would steal /pending commands.
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }

  if (window[FLAG]) return;
  window[FLAG] = true;

  const ui = createUi();

  function nowLabel() {
    return new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function createUi() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      const bookkit = existing.querySelector(".gm-bridge__bookkit");
      const refreshBookKitVersion = () => {
        if (!bookkit) return;
        const version = window.__gmBookKitFulltextVersion;
        const present = typeof version === "string" && version.length > 0;
        bookkit.textContent = present ? `BookKit FT: ${version}` : "BookKit FT: —";
        bookkit.dataset.present = present ? "true" : "false";
      };
      refreshBookKitVersion();
      return {
        setStatus() {},
        log() {},
        refreshBookKitVersion,
      };
    }

    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483646;
        width: 320px;
        max-height: 240px;
        border: 1px solid #334155;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.94);
        color: #e2e8f0;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        overflow: hidden;
      }
      #${PANEL_ID}[data-collapsed="true"] .gm-bridge__body {
        display: none;
      }
      #${PANEL_ID} .gm-bridge__header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: #1e293b;
        border-bottom: 1px solid #334155;
        cursor: pointer;
        user-select: none;
      }
      #${PANEL_ID} .gm-bridge__dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #64748b;
        flex: 0 0 auto;
      }
      #${PANEL_ID}[data-status="online"] .gm-bridge__dot {
        background: #22c55e;
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
      }
      #${PANEL_ID}[data-status="offline"] .gm-bridge__dot {
        background: #ef4444;
        box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.25);
      }
      #${PANEL_ID}[data-status="busy"] .gm-bridge__dot {
        background: #f59e0b;
        box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.25);
      }
      #${PANEL_ID} .gm-bridge__title {
        flex: 1 1 auto;
        font-weight: 600;
      }
      #${PANEL_ID} .gm-bridge__meta {
        color: #94a3b8;
        font-size: 11px;
      }
      #${PANEL_ID} .gm-bridge__extras {
        padding: 5px 10px 6px;
        border-bottom: 1px solid #334155;
        color: #64748b;
        font-size: 11px;
      }
      #${PANEL_ID} .gm-bridge__bookkit[data-present="true"] {
        color: #86efac;
      }
      #${PANEL_ID} .gm-bridge__body {
        max-height: 180px;
        overflow: auto;
        padding: 8px 10px;
      }
      #${PANEL_ID} .gm-bridge__line {
        margin: 0 0 4px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${PANEL_ID} .gm-bridge__line[data-level="ok"] { color: #86efac; }
      #${PANEL_ID} .gm-bridge__line[data-level="warn"] { color: #fcd34d; }
      #${PANEL_ID} .gm-bridge__line[data-level="err"] { color: #fca5a5; }
      #${PANEL_ID} .gm-bridge__line[data-level="info"] { color: #cbd5e1; }
    `;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.dataset.status = "offline";
    panel.dataset.collapsed = "false";
    panel.innerHTML = `
      <div class="gm-bridge__header">
        <span class="gm-bridge__dot"></span>
        <span class="gm-bridge__title">Browser Bridge</span>
        <span class="gm-bridge__meta">offline</span>
      </div>
      <div class="gm-bridge__extras">
        <span class="gm-bridge__bookkit" data-present="false">BookKit FT: —</span>
      </div>
      <div class="gm-bridge__body"></div>
    `;

    panel.querySelector(".gm-bridge__header").addEventListener("click", () => {
      panel.dataset.collapsed = panel.dataset.collapsed === "true" ? "false" : "true";
    });

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);

    const body = panel.querySelector(".gm-bridge__body");
    const meta = panel.querySelector(".gm-bridge__meta");
    const bookkit = panel.querySelector(".gm-bridge__bookkit");

    function refreshBookKitVersion() {
      const version = window.__gmBookKitFulltextVersion;
      const present = typeof version === "string" && version.length > 0;
      bookkit.textContent = present ? `BookKit FT: ${version}` : "BookKit FT: —";
      bookkit.dataset.present = present ? "true" : "false";
    }

    refreshBookKitVersion();

    return {
      setStatus(status, label) {
        panel.dataset.status = status;
        meta.textContent = label || status;
        refreshBookKitVersion();
      },
      log(level, message) {
        const line = document.createElement("div");
        line.className = "gm-bridge__line";
        line.dataset.level = level;
        line.textContent = `[${nowLabel()}] ${message}`;
        body.appendChild(line);
        while (body.children.length > LOG_LIMIT) {
          body.removeChild(body.firstChild);
        }
        body.scrollTop = body.scrollHeight;
      },
      refreshBookKitVersion,
    };
  }

  async function executeCommand(command) {
    const payload = command.payload || {};

    if (command.type === "eval") {
      const fn = new Function(`return (${payload.expression});`);
      const value = await fn();
      return { ok: true, result: value };
    }

    if (command.type === "click") {
      const element = document.querySelector(payload.selector);
      if (!element) throw new Error(`Selector not found: ${payload.selector}`);
      element.click();
      return { ok: true, result: { clicked: payload.selector } };
    }

    if (command.type === "fill") {
      const element = document.querySelector(payload.selector);
      if (!element) throw new Error(`Selector not found: ${payload.selector}`);
      element.focus();
      element.value = payload.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, result: { filled: payload.selector } };
    }

    if (command.type === "snapshot") {
      let text = "";
      try {
        text = document.body?.innerText?.slice(0, 12000) || "";
      } catch {
        // Cross-origin / opaque frames may deny document.body.
      }
      return {
        ok: true,
        result: {
          url: location.href,
          title: document.title,
          text,
        },
      };
    }

    throw new Error(`Unknown command type: ${command.type}`);
  }

  function summarizeResult(result) {
    if (result == null) return "null";
    if (typeof result === "string") return result.length > 80 ? `${result.slice(0, 80)}…` : result;
    try {
      const json = JSON.stringify(result);
      return json.length > 80 ? `${json.slice(0, 80)}…` : json;
    } catch {
      return String(result);
    }
  }

  async function pollOnce() {
    const response = await fetch(`${BRIDGE_URL}/pending?top=1`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    ui.setStatus("online", "online");
    const commands = await response.json();
    if (!Array.isArray(commands) || !commands.length) return;

    ui.setStatus("busy", `${commands.length} cmd`);
    ui.log("info", `received ${commands.length} command(s)`);

    for (const command of commands) {
      const label = `${command.type || "unknown"} ${command.id?.slice(0, 8) || ""}`.trim();
      ui.log("info", `exec ${label}`);
      try {
        const result = await executeCommand(command);
        await fetch(`${BRIDGE_URL}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: command.id, ok: true, result: result.result }),
        });
        ui.log("ok", `done ${label}: ${summarizeResult(result.result)}`);
      } catch (error) {
        await fetch(`${BRIDGE_URL}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: command.id, ok: false, error: String(error?.message || error) }),
        });
        ui.log("err", `fail ${label}: ${error?.message || error}`);
      }
    }

    ui.setStatus("online", "online");
  }

  async function loop() {
    try {
      await pollOnce();
    } catch (error) {
      ui.setStatus("offline", "offline");
      if (!loop.lastOfflineLog || Date.now() - loop.lastOfflineLog > 5000) {
        ui.log("warn", `server unreachable: ${error?.message || error}`);
        loop.lastOfflineLog = Date.now();
      }
    }
    ui.refreshBookKitVersion();
    window.setTimeout(loop, POLL_MS);
  }

  ui.log("info", "bridge started");
  loop();
})();
