// ==UserScript==
// @name         Message Registry - Auto refresh
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.3
// @description  Adds an auto refresh checkbox to Message Registry messages list.
// @author       Lukáš Sedláček
// @match        *://*/uu-energygateway-messageregistryg01/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/message-registry-autorefresh.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/message-registry-autorefresh.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_FLAG = "__gmMessageRegistryAutoRefresh";
  const DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS = 10;
  const MIN_AUTO_REFRESH_INTERVAL_SECONDS = 1;
  const MAX_AUTO_REFRESH_INTERVAL_SECONDS = 3600;
  const PROGRESS_UPDATE_INTERVAL_MS = 1000;
  const CONTROL_ID = "gm-message-registry-autorefresh";
  const STORAGE_KEY = "gm-message-registry-autorefresh-enabled";
  const INTERVAL_STORAGE_KEY = "gm-message-registry-autorefresh-interval-seconds";
  const LAST_RELOAD_STORAGE_KEY = "gm-message-registry-autorefresh-last-reload";
  const RELOAD_BUTTON_LABELS = ["Reload Data", "Obnovit data"];

  if (window[SCRIPT_FLAG]) return;
  window[SCRIPT_FLAG] = true;

  let isEnabled = getStoredValue(STORAGE_KEY) === "true";
  let autoRefreshIntervalSeconds = getStoredIntervalSeconds();
  let countdownStartedAt = getLastReloadTimestamp() || Date.now();
  let lastProgressRatio = 0;

  function isMessagesPage() {
    return /\/messages(?:$|[/?#])/u.test(window.location.pathname);
  }

  function removeControl() {
    document.getElementById(CONTROL_ID)?.remove();
  }

  function getCurrentUrlStorageScope() {
    return `${window.location.origin}${window.location.pathname}${window.location.search}`;
  }

  function getScopedStorageKey(key) {
    return `${key}:${encodeURIComponent(getCurrentUrlStorageScope())}`;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getStoredValue(key) {
    const scopedKey = getScopedStorageKey(key);

    try {
      return window.localStorage.getItem(scopedKey);
    } catch {
      const cookieMatch = document.cookie.match(new RegExp(`(?:^|; )${escapeRegExp(scopedKey)}=([^;]*)`));
      return cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
    }
  }

  function setStoredValue(key, value) {
    const scopedKey = getScopedStorageKey(key);

    try {
      window.localStorage.setItem(scopedKey, value);
      return;
    } catch {
      document.cookie = `${scopedKey}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
    }
  }

  function clampIntervalSeconds(value) {
    return Math.min(MAX_AUTO_REFRESH_INTERVAL_SECONDS, Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, Math.round(value)));
  }

  function getStoredIntervalSeconds() {
    const rawValue = getStoredValue(INTERVAL_STORAGE_KEY);
    const intervalSeconds = rawValue ? Number(rawValue) : NaN;
    return Number.isFinite(intervalSeconds) ? clampIntervalSeconds(intervalSeconds) : DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS;
  }

  function getAutoRefreshIntervalMs() {
    return autoRefreshIntervalSeconds * 1000;
  }

  function getLastReloadTimestamp() {
    const rawValue = getStoredValue(LAST_RELOAD_STORAGE_KEY);
    const timestamp = rawValue ? Number(rawValue) : NaN;
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }

  function getTooltipText() {
    const lastReloadTimestamp = getLastReloadTimestamp();
    const lastReloadLabel = lastReloadTimestamp ? new Date(lastReloadTimestamp).toLocaleString() : "never";
    return `Autorefresh every ${autoRefreshIntervalSeconds}s. Last reload: ${lastReloadLabel}`;
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
    const progressRatio = Math.min(1, elapsed / getAutoRefreshIntervalMs());
    fill.style.transition = progressRatio < lastProgressRatio ? "opacity 160ms ease" : `transform ${PROGRESS_UPDATE_INTERVAL_MS}ms linear, opacity 160ms ease`;
    fill.style.transform = `scaleX(${progressRatio})`;
    fill.style.opacity = isEnabled ? "1" : "0.35";
    lastProgressRatio = progressRatio;
  }

  function getBookmarkButton() {
    return document.querySelector(".uugds-bookmark")?.closest("button") || null;
  }

  function getControlHost() {
    return getBookmarkButton()?.parentElement?.parentElement || null;
  }

  function getReloadButton() {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => {
      if (!(candidate instanceof HTMLButtonElement)) {
        return false;
      }

      const label = candidate.getAttribute("title") || candidate.getAttribute("aria-label") || "";
      return RELOAD_BUTTON_LABELS.includes(label.trim());
    });

    return button || null;
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

  function setIntervalSeconds(nextValue) {
    if (!Number.isFinite(nextValue)) {
      return;
    }

    autoRefreshIntervalSeconds = clampIntervalSeconds(nextValue);
    setStoredValue(INTERVAL_STORAGE_KEY, String(autoRefreshIntervalSeconds));

    const intervalInput = document.querySelector(`#${CONTROL_ID} [data-role="autorefresh-interval"]`);
    if (intervalInput instanceof HTMLInputElement) {
      intervalInput.value = String(autoRefreshIntervalSeconds);
    }

    updateControlTooltip();
    updateProgressBar();
  }

  function ensureControl() {
    if (!isMessagesPage()) {
      removeControl();
      return;
    }

    const bookmarkButton = getBookmarkButton();
    const controlHost = getControlHost();
    const actionGroup = bookmarkButton?.parentElement || null;

    if (!bookmarkButton || !controlHost || !actionGroup) {
      return;
    }

    const existingControl = document.getElementById(CONTROL_ID);
    if (existingControl?.parentElement === controlHost) {
      const checkbox = existingControl.querySelector("input");
      if (checkbox instanceof HTMLInputElement) {
        checkbox.checked = isEnabled;
      }
      const intervalInput = existingControl.querySelector('[data-role="autorefresh-interval"]');
      if (intervalInput instanceof HTMLInputElement) {
        intervalInput.value = String(autoRefreshIntervalSeconds);
      }
      updateControlTooltip();
      updateProgressBar();
      return;
    }

    existingControl?.remove();

    const wrapper = document.createElement("div");
    wrapper.id = CONTROL_ID;
    wrapper.style.display = "inline-flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignSelf = "center";
    wrapper.style.gap = "4px";
    wrapper.style.marginLeft = "12px";

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
    text.textContent = "autorefresh";

    const intervalInput = document.createElement("input");
    intervalInput.type = "number";
    intervalInput.min = String(MIN_AUTO_REFRESH_INTERVAL_SECONDS);
    intervalInput.max = String(MAX_AUTO_REFRESH_INTERVAL_SECONDS);
    intervalInput.step = "1";
    intervalInput.value = String(autoRefreshIntervalSeconds);
    intervalInput.dataset.role = "autorefresh-interval";
    intervalInput.style.width = "52px";
    intervalInput.style.padding = "2px 4px";
    intervalInput.style.border = "1px solid rgba(100, 116, 139, 0.35)";
    intervalInput.style.borderRadius = "4px";
    intervalInput.style.font = "inherit";
    intervalInput.style.color = "inherit";
    intervalInput.style.background = "rgba(255, 255, 255, 0.95)";
    intervalInput.addEventListener("change", () => {
      const nextValue = Number(intervalInput.value);
      if (!Number.isFinite(nextValue)) {
        intervalInput.value = String(autoRefreshIntervalSeconds);
        return;
      }
      setIntervalSeconds(nextValue);
    });

    const suffix = document.createElement("span");
    suffix.textContent = "s";

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
    label.append(checkbox, text, intervalInput, suffix);
    wrapper.append(label, progressTrack);
    actionGroup.insertAdjacentElement("afterend", wrapper);
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
    if (!isMessagesPage() || !isEnabled) {
      return;
    }

    const reloadButton = getReloadButton();
    if (!reloadButton || reloadButton.disabled || reloadButton.getAttribute("aria-disabled") === "true") {
      return;
    }

    if (Date.now() - countdownStartedAt < getAutoRefreshIntervalMs()) {
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
