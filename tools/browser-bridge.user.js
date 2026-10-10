// ==UserScript==
// @name         Browser Bridge for Cursor Agent
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.5
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
        white-space: nowrap;
      }
      #${PANEL_ID} .gm-bridge__link {
        flex: none;
        padding: 0;
        border: 0;
        background: none;
        color: #94a3b8;
        font: inherit;
        font-size: 11px;
        line-height: 1.4;
        white-space: nowrap;
        cursor: pointer;
      }
      #${PANEL_ID} .gm-bridge__link:hover { color: #f8fafc; }
      #${PANEL_ID} .gm-bridge__update-main {
        flex: 0 1 auto;
        min-width: 0;
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #86efac;
      }
      #${PANEL_ID} .gm-bridge__update-main:hover { color: #bbf7d0; }
      #${PANEL_ID} .gm-bridge__update-main[hidden] { display: none; }
      #${PANEL_ID} .gm-bridge__scripts {
        display: none;
        padding: 6px 10px;
        border-bottom: 1px solid #334155;
      }
      #${PANEL_ID}[data-scripts="open"] .gm-bridge__scripts { display: block; }
      #${PANEL_ID} .gm-bridge__script {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 3px 4px;
        border: 0;
        border-radius: 4px;
        background: none;
        color: #94a3b8;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      #${PANEL_ID} .gm-bridge__script[data-relevant="true"] { color: #86efac; }
      #${PANEL_ID} .gm-bridge__script:hover { background: #1e293b; }
      #${PANEL_ID} .gm-bridge__script span:first-child { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PANEL_ID} .gm-bridge__meta {
        color: #94a3b8;
        font-size: 11px;
      }
      #${PANEL_ID} .gm-bridge__extras {
        padding: 5px 10px 6px;
        border-bottom: 1px solid #334155;
        color: #64748b;
        font-size: 11px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #${PANEL_ID} .gm-bridge__bookkit { flex: 1 1 auto; }
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
        <button type="button" class="gm-bridge__link gm-bridge__update-main" hidden></button>
        <button type="button" class="gm-bridge__link gm-bridge__update-list" title="Userscripty ze serveru – klik otevře aktualizaci v Tampermonkey">skripty ▾</button>
        <span class="gm-bridge__meta">offline</span>
      </div>
      <div class="gm-bridge__extras">
        <span class="gm-bridge__bookkit" data-present="false">BookKit FT: —</span>
      </div>
      <div class="gm-bridge__scripts"></div>
      <div class="gm-bridge__body"></div>
    `;

    panel.querySelector(".gm-bridge__header").addEventListener("click", () => {
      panel.dataset.collapsed = panel.dataset.collapsed === "true" ? "false" : "true";
    });

    // Opening a .user.js URL makes Tampermonkey show its install / update page.
    const scriptsBox = panel.querySelector(".gm-bridge__scripts");
    const updateMain = panel.querySelector(".gm-bridge__update-main");
    let relevantScripts = [];
    const openScript = (script) => window.open(`${BRIDGE_URL}${script.path}`, "_blank");
    const matchesPage = (pattern) => {
      if (pattern === "*://*/*" || pattern === "<all_urls>") return false;
      const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return re.test(location.href);
    };
    const loadScripts = async () => {
      const health = await (await fetch(`${BRIDGE_URL}/health`, { cache: "no-store" })).json();
      const list = health.userScripts || [];
      for (const script of list) script.relevant = (script.matches || []).some(matchesPage);
      relevantScripts = list.filter((script) => script.relevant);
      // One script for this page gets a one-click link; several are in the list (marked ●).
      const only = relevantScripts.length === 1 ? relevantScripts[0] : null;
      updateMain.hidden = !only;
      if (only) {
        updateMain.textContent = `⟳ ${only.name}`;
        updateMain.title = `Aktualizovat ${only.name}${only.version ? ` na v${only.version}` : ""} v Tampermonkey (otevře ${BRIDGE_URL}${only.path})`;
      }
      setToggleLabel();
      return list;
    };
    const showList = async () => {
      panel.dataset.scripts = "open";
      panel.dataset.collapsed = "false";
      setToggleLabel();
      scriptsBox.textContent = "načítám…";
      try {
        const list = (await loadScripts()).sort((a, b) => Number(b.relevant) - Number(a.relevant));
        scriptsBox.replaceChildren(
          ...list.map((script) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "gm-bridge__script";
            button.dataset.relevant = script.relevant ? "true" : "false";
            button.title = `Otevřít ${BRIDGE_URL}${script.path} – Tampermonkey nabídne aktualizaci`;
            const name = document.createElement("span");
            name.textContent = `${script.relevant ? "● " : ""}${script.name}`;
            const version = document.createElement("span");
            version.textContent = script.version ? `v${script.version}` : "";
            button.append(name, version);
            button.addEventListener("click", () => openScript(script));
            return button;
          }),
        );
        if (!list.length) scriptsBox.textContent = "server nevrací žádné userscripty";
      } catch (error) {
        scriptsBox.textContent = `server nedostupný: ${error?.message || error}`;
      }
    };
    // Both sit in the header, whose click collapses the panel.
    updateMain.addEventListener("click", (event) => {
      event.stopPropagation();
      if (relevantScripts.length === 1) openScript(relevantScripts[0]);
    });
    const listToggle = panel.querySelector(".gm-bridge__update-list");
    function setToggleLabel() {
      listToggle.textContent = `${updateMain.hidden ? "skripty " : ""}${panel.dataset.scripts === "open" ? "▴" : "▾"}`;
    }
    listToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (panel.dataset.scripts === "open") {
        panel.dataset.scripts = "";
        setToggleLabel();
      } else showList();
    });
    loadScripts().catch(() => {});

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
