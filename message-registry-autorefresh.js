// ==UserScript==
// @name         Message Registry - Auto refresh
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.0
// @description  Adds an auto refresh checkbox to Message Registry messages list.
// @author       Lukáš Sedláček
// @match        *://*/uu-energygateway-messageregistryg01/*/messages*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/message-registry-autorefresh.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/message-registry-autorefresh.js
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_FLAG = "__gmMessageRegistryAutoRefresh";
  const AUTO_REFRESH_INTERVAL_MS = 10000;
  const CONTROL_ID = "gm-message-registry-autorefresh";
  const STORAGE_KEY = "gm-message-registry-autorefresh-enabled";
  const LAST_RELOAD_STORAGE_KEY = "gm-message-registry-autorefresh-last-reload";

  if (window[SCRIPT_FLAG]) return;
  window[SCRIPT_FLAG] = true;

  let isEnabled = getStoredValue(STORAGE_KEY) === "true";

  function getStoredValue(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      const cookieMatch = document.cookie.match(new RegExp(`(?:^|; )${key}=([^;]*)`));
      return cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
    }
  }

  function setStoredValue(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return;
    } catch {
      document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
    }
  }

  function getLastReloadTimestamp() {
    const rawValue = getStoredValue(LAST_RELOAD_STORAGE_KEY);
    const timestamp = rawValue ? Number(rawValue) : NaN;
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }

  function getTooltipText() {
    const lastReloadTimestamp = getLastReloadTimestamp();
    const lastReloadLabel = lastReloadTimestamp ? new Date(lastReloadTimestamp).toLocaleString() : "never";
    return `Autorefresh every ${Math.round(AUTO_REFRESH_INTERVAL_MS / 1000)}s. Last reload: ${lastReloadLabel}`;
  }

  function updateControlTooltip() {
    const control = document.getElementById(CONTROL_ID);
    if (!control) {
      return;
    }

    const tooltipText = getTooltipText();
    control.title = tooltipText;
    control.setAttribute("aria-label", tooltipText);

    control.querySelectorAll("input, span").forEach((element) => {
      element.title = tooltipText;
      element.setAttribute("aria-label", tooltipText);
    });
  }

  function getBookmarkButton() {
    return document.querySelector(".uugds-bookmark")?.closest("button") || null;
  }

  function getReloadButton() {
    const button = document.querySelector('button[title="Reload Data"]');
    return button instanceof HTMLButtonElement ? button : null;
  }

  function setEnabled(nextValue) {
    isEnabled = Boolean(nextValue);
    setStoredValue(STORAGE_KEY, String(isEnabled));

    const checkbox = document.querySelector(`#${CONTROL_ID} input`);
    if (checkbox instanceof HTMLInputElement) {
      checkbox.checked = isEnabled;
    }

    updateControlTooltip();
  }

  function ensureControl() {
    const bookmarkButton = getBookmarkButton();
    if (!bookmarkButton?.parentElement) {
      return;
    }

    const existingControl = document.getElementById(CONTROL_ID);
    if (existingControl?.parentElement === bookmarkButton.parentElement) {
      const checkbox = existingControl.querySelector("input");
      if (checkbox instanceof HTMLInputElement) {
        checkbox.checked = isEnabled;
      }
      updateControlTooltip();
      return;
    }

    existingControl?.remove();

    const label = document.createElement("label");
    label.id = CONTROL_ID;
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
    label.style.marginRight = "12px";
    label.style.fontSize = "14px";
    label.style.color = "#475569";
    label.style.whiteSpace = "nowrap";
    label.style.userSelect = "none";
    label.style.cursor = "pointer";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isEnabled;
    checkbox.style.margin = "0";
    checkbox.style.cursor = "pointer";
    checkbox.addEventListener("change", () => {
      setEnabled(checkbox.checked);
    });

    const text = document.createElement("span");
    text.textContent = `autorefresh every ${Math.round(AUTO_REFRESH_INTERVAL_MS / 1000)}s`;

    label.append(checkbox, text);
    bookmarkButton.insertAdjacentElement("beforebegin", label);
    updateControlTooltip();
  }

  function markReloadedNow() {
    setStoredValue(LAST_RELOAD_STORAGE_KEY, String(Date.now()));
    updateControlTooltip();
  }

  function triggerRefresh() {
    if (!isEnabled) {
      return;
    }

    const reloadButton = getReloadButton();
    if (!reloadButton || reloadButton.disabled || reloadButton.getAttribute("aria-disabled") === "true") {
      return;
    }

    markReloadedNow();
    reloadButton.click();
  }

  ensureControl();

  const observer = new MutationObserver(() => {
    ensureControl();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(ensureControl, 1000);
  window.setInterval(triggerRefresh, AUTO_REFRESH_INTERVAL_MS);
})();
