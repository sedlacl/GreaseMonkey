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
  const PROGRESS_UPDATE_INTERVAL_MS = 1000;
  const CONTROL_ID = "gm-message-registry-autorefresh";
  const STORAGE_KEY = "gm-message-registry-autorefresh-enabled";
  const LAST_RELOAD_STORAGE_KEY = "gm-message-registry-autorefresh-last-reload";

  if (window[SCRIPT_FLAG]) return;
  window[SCRIPT_FLAG] = true;

  let isEnabled = getStoredValue(STORAGE_KEY) === "true";
  let countdownStartedAt = getLastReloadTimestamp() || Date.now();
  let lastProgressRatio = 0;

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

  function updateProgressBar() {
    const fill = document.querySelector(`#${CONTROL_ID} [data-role="autorefresh-progress-fill"]`);
    if (!(fill instanceof HTMLSpanElement)) {
      return;
    }

    const elapsed = isEnabled ? Math.max(0, Date.now() - countdownStartedAt) : 0;
    const progressRatio = Math.min(1, elapsed / AUTO_REFRESH_INTERVAL_MS);
    fill.style.transition = progressRatio < lastProgressRatio ? "opacity 160ms ease" : `transform ${PROGRESS_UPDATE_INTERVAL_MS}ms linear, opacity 160ms ease`;
    fill.style.transform = `scaleX(${progressRatio})`;
    fill.style.opacity = isEnabled ? "1" : "0.35";
    lastProgressRatio = progressRatio;
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

    if (isEnabled) {
      countdownStartedAt = getLastReloadTimestamp() || Date.now();
    }

    const checkbox = document.querySelector(`#${CONTROL_ID} input`);
    if (checkbox instanceof HTMLInputElement) {
      checkbox.checked = isEnabled;
    }

    updateControlTooltip();
    updateProgressBar();
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

    const wrapper = document.createElement("div");
    wrapper.id = CONTROL_ID;
    wrapper.style.display = "inline-flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignSelf = "center";
    wrapper.style.gap = "4px";
    wrapper.style.marginRight = "12px";

    const label = document.createElement("label");
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
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

    const progressTrack = document.createElement("span");
    progressTrack.setAttribute("aria-hidden", "true");
    progressTrack.style.display = "block";
    progressTrack.style.position = "relative";
    progressTrack.style.width = "100%";
    progressTrack.style.height = "1px";
    progressTrack.style.background = "rgba(100, 116, 139, 0.22)";
    progressTrack.style.overflow = "hidden";

    const progressFill = document.createElement("span");
    progressFill.dataset.role = "autorefresh-progress-fill";
    progressFill.style.display = "block";
    progressFill.style.width = "100%";
    progressFill.style.height = "100%";
    progressFill.style.background = "#475569";
    progressFill.style.transformOrigin = "left center";
    progressFill.style.transform = "scaleX(0)";
    progressFill.style.transition = `transform ${PROGRESS_UPDATE_INTERVAL_MS}ms linear, opacity 160ms ease`;

    progressTrack.appendChild(progressFill);
    label.append(checkbox, text);
    wrapper.append(label, progressTrack);
    bookmarkButton.insertAdjacentElement("beforebegin", wrapper);
    updateControlTooltip();
    updateProgressBar();
  }

  function markReloadedNow() {
    countdownStartedAt = Date.now();
    setStoredValue(LAST_RELOAD_STORAGE_KEY, String(countdownStartedAt));
    updateControlTooltip();
    updateProgressBar();
  }

  function triggerRefresh() {
    if (!isEnabled) {
      return;
    }

    const reloadButton = getReloadButton();
    if (!reloadButton || reloadButton.disabled || reloadButton.getAttribute("aria-disabled") === "true") {
      return;
    }

    if (Date.now() - countdownStartedAt < AUTO_REFRESH_INTERVAL_MS) {
      updateProgressBar();
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
  window.setInterval(() => {
    updateProgressBar();
    triggerRefresh();
  }, PROGRESS_UPDATE_INTERVAL_MS);
})();
