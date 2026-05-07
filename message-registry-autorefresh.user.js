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
  const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 10000;
  const MIN_AUTO_REFRESH_INTERVAL_MS = 1000;
  const PROGRESS_UPDATE_INTERVAL_MS = 1000;
  const CONTROL_ID = "gm-message-registry-autorefresh";
  const STORAGE_KEY = "gm-message-registry-autorefresh-enabled";
  const INTERVAL_STORAGE_KEY = "gm-message-registry-autorefresh-interval-ms";
  const LAST_RELOAD_STORAGE_KEY = "gm-message-registry-autorefresh-last-reload";
  const RELOAD_BUTTON_LABELS = ["Reload Data", "Obnovit data"];

  if (window[SCRIPT_FLAG]) return;
  window[SCRIPT_FLAG] = true;

  let isEnabled = getStoredValue(STORAGE_KEY) === "true";
  let autoRefreshIntervalMs = getStoredInterval();
  let countdownStartedAt = getLastReloadTimestamp() || Date.now();
  let lastProgressRatio = 0;
  let isIntervalEditing = false;

  function isMessagesPage() {
    return /\/messages(?:$|[/?#])/u.test(window.location.pathname);
  }

  function removeControl() {
    document.getElementById(CONTROL_ID)?.remove();
    isIntervalEditing = false;
  }

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

  function getStoredInterval() {
    const rawValue = getStoredValue(INTERVAL_STORAGE_KEY);
    const parsedValue = rawValue ? Number(rawValue) : NaN;
    return Number.isFinite(parsedValue) && parsedValue >= MIN_AUTO_REFRESH_INTERVAL_MS ? parsedValue : DEFAULT_AUTO_REFRESH_INTERVAL_MS;
  }

  function getIntervalSeconds() {
    return Math.round(autoRefreshIntervalMs / 1000);
  }

  function getTooltipText() {
    const lastReloadTimestamp = getLastReloadTimestamp();
    const lastReloadLabel = lastReloadTimestamp ? new Date(lastReloadTimestamp).toLocaleString() : "never";
    return `Autorefresh every ${getIntervalSeconds()}s. Last reload: ${lastReloadLabel}`;
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
    const progressRatio = Math.min(1, elapsed / autoRefreshIntervalMs);
    fill.style.transition = progressRatio < lastProgressRatio ? "opacity 160ms ease" : `transform ${PROGRESS_UPDATE_INTERVAL_MS}ms linear, opacity 160ms ease`;
    fill.style.transform = `scaleX(${progressRatio})`;
    fill.style.opacity = isEnabled ? "1" : "0.35";
    lastProgressRatio = progressRatio;
  }

  function updateIntervalLabel() {
    const intervalLabel = document.querySelector(`#${CONTROL_ID} [data-role="autorefresh-interval-value"]`);
    if (intervalLabel instanceof HTMLSpanElement) {
      intervalLabel.textContent = `${getIntervalSeconds()}s`;
    }
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
    updateIntervalLabel();
    updateProgressBar();
  }

  function setIntervalSeconds(nextValueSeconds) {
    const parsedSeconds = Number(nextValueSeconds);
    if (!Number.isFinite(parsedSeconds) || parsedSeconds < 1) {
      return false;
    }

    autoRefreshIntervalMs = Math.max(MIN_AUTO_REFRESH_INTERVAL_MS, Math.round(parsedSeconds * 1000));
    setStoredValue(INTERVAL_STORAGE_KEY, String(autoRefreshIntervalMs));
    updateControlTooltip();
    updateIntervalLabel();
    updateProgressBar();
    return true;
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
      updateControlTooltip();
      updateIntervalLabel();
      updateProgressBar();
      return;
    }

    existingControl?.remove();
    isIntervalEditing = false;

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
    text.append("autorefresh every ");

    const intervalValue = document.createElement("span");
    intervalValue.dataset.role = "autorefresh-interval-value";
    intervalValue.textContent = `${getIntervalSeconds()}s`;
    intervalValue.style.textDecoration = "underline";
    intervalValue.style.cursor = "text";
    intervalValue.style.textUnderlineOffset = "2px";
    intervalValue.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (isIntervalEditing || intervalValue.querySelector("input")) {
        return;
      }
      isIntervalEditing = true;

      const editInput = document.createElement("input");
      editInput.type = "number";
      editInput.min = "1";
      editInput.step = "1";
      editInput.required = true;
      editInput.value = String(getIntervalSeconds());
      editInput.style.width = "56px";
      editInput.style.font = "inherit";
      editInput.style.padding = "0 4px";
      editInput.style.margin = "0";
      editInput.style.border = "1px solid #94a3b8";
      editInput.style.borderRadius = "3px";
      editInput.style.color = "inherit";

      const finishEditing = (shouldSave) => {
        if (!editInput.isConnected) {
          isIntervalEditing = false;
          return;
        }

        if (shouldSave) {
          const hasSaved = setIntervalSeconds(editInput.value);
          if (!hasSaved) {
            editInput.setCustomValidity("Enter at least 1 second.");
            editInput.reportValidity();
            return;
          }
          editInput.setCustomValidity("");
        }

        intervalValue.textContent = `${getIntervalSeconds()}s`;
        isIntervalEditing = false;
      };

      editInput.addEventListener("keydown", (keyEvent) => {
        if (keyEvent.key === "Enter") {
          keyEvent.preventDefault();
          finishEditing(true);
        } else if (keyEvent.key === "Escape") {
          keyEvent.preventDefault();
          finishEditing(false);
        }
      });
      editInput.addEventListener("blur", () => {
        finishEditing(true);
      });

      intervalValue.replaceChildren(editInput);
      editInput.focus();
      editInput.select();
    });

    text.append(intervalValue);

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

    if (Date.now() - countdownStartedAt < autoRefreshIntervalMs) {
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
