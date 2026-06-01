// ==UserScript==
// @name         IndSoft JIRA - ManiTime copy tag
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.6
// @description  Adds a fast ManiTime copy button on JIRA issue browse pages and overrides the embedded copy icons.
// @author       Lukáš Sedláček
// @match        *://jira.indsoft.local/browse/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/indsoft-jira-manictime.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/indsoft-jira-manictime.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_FLAG = "__gmIndsoftJiraManiTime";
  const STYLE_ID = "gm-indsoft-jira-manictime-style";
  const BUTTON_ID = "gm-indsoft-jira-manictime-button";
  const FEEDBACK_ATTRIBUTE = "data-copied";
  const BREADCRUMB_SELECTOR = ".aui-nav.aui-nav-breadcrumbs";
  const ISSUE_KEY_PATTERN = /^\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#].*)?$/iu;
  const TITLE_SUMMARY_PATTERN = /^\[[^\]]+\]\s*(.*?)\s*-\s*IndSoft JIRA$/u;
  const OVERRIDDEN_ICON_IDS = Object.freeze(["manictime-link-icon", "copy-link-icon"]);
  const SVG_CACHE_STORAGE_KEY = "gm-indsoft-jira-manictime-svg";
  const SUMMARY_MAX_LENGTH = 30;
  let copyFeedbackTimeout = 0;

  function supportsQuerySelector(node) {
    return Boolean(node && typeof node.querySelector === "function" && typeof node.querySelectorAll === "function");
  }

  if (window[SCRIPT_FLAG]) {
    return;
  }
  window[SCRIPT_FLAG] = true;

  function getIssueKey() {
    const match = window.location.pathname.match(ISSUE_KEY_PATTERN);
    return match?.[1]?.toUpperCase() ?? "";
  }

  function normalizeWhitespace(value) {
    return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  }

  function truncateSummary(value) {
    const normalizedValue = normalizeWhitespace(value);
    return normalizedValue.slice(0, SUMMARY_MAX_LENGTH);
  }

  function getIssueSummary() {
    const summarySelectors = ["#summary-val", "h1#summary-val", ".aui-page-header-main > h1", "#issuedetails h1", "#issue-content h1"];

    for (const selector of summarySelectors) {
      const summaryElement = document.querySelector(selector);
      const summaryText = truncateSummary(summaryElement?.textContent ?? "");
      if (summaryText) {
        return summaryText;
      }
    }

    const titleMatch = normalizeWhitespace(document.title).match(TITLE_SUMMARY_PATTERN);
    return truncateSummary(titleMatch?.[1] ?? "");
  }

  function buildCopyText() {
    const issueKey = getIssueKey();
    if (!issueKey) {
      return "";
    }

    const projectKey = issueKey.split("-")[0] || "";
    const issueSummary = getIssueSummary();
    return issueSummary ? `JIRA, ${projectKey}, #${issueKey} ${issueSummary}` : `JIRA, ${projectKey}, #${issueKey}`;
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    (document.body || document.documentElement).appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  async function copyText(text) {
    if (!text) {
      return false;
    }

    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_error) {
        // Ignore and fall back to the legacy copy path below.
      }
    }

    fallbackCopyText(text);
    return true;
  }

  function flashCopyState(button) {
    window.clearTimeout(copyFeedbackTimeout);
    button.setAttribute(FEEDBACK_ATTRIBUTE, "true");
    copyFeedbackTimeout = window.setTimeout(() => {
      button.removeAttribute(FEEDBACK_ATTRIBUTE);
    }, 1200);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #manictime-link-icon,
      #copy-link-icon {
        display: none !important;
      }

      ${BREADCRUMB_SELECTOR} {
        position: relative;
      }

      #${BUTTON_ID} {
        width: 16px;
        height: 16px;
        margin-top: 2px;
        margin-left: 24px;
        position: absolute;
        cursor: pointer;
      }

      #${BUTTON_ID}:hover {
        filter: brightness(1.02);
      }

      #${BUTTON_ID} svg {
        display: block;
        width: 16px;
        height: 16px;
      }

      #${BUTTON_ID}:hover [data-gm-manictime-highlight="true"] {
        fill: #DFE1E6;
      }

      #${BUTTON_ID}[${FEEDBACK_ATTRIBUTE}="true"] {
        opacity: 0.8;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getOriginalIcon(root = document) {
    if (root instanceof SVGSVGElement && root.id === "manictime-link-icon") {
      return root;
    }

    if (!supportsQuerySelector(root)) {
      return null;
    }

    return root.querySelector("#manictime-link-icon");
  }

  function isOurNode(node) {
    return Boolean(node instanceof Element && (node.id === BUTTON_ID || node.id === STYLE_ID || node.closest(`#${BUTTON_ID}`)));
  }

  function removeOverriddenIcons(root = document) {
    OVERRIDDEN_ICON_IDS.forEach((iconId) => {
      if (root instanceof Element && root.id === iconId) {
        root.remove();
        return;
      }

      if (!supportsQuerySelector(root)) {
        return;
      }

      const escapedIconId = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(iconId) : iconId;
      root.querySelectorAll(`#${escapedIconId}`).forEach((element) => element.remove());
    });
  }

  function createFallbackIcon() {
    const cachedIcon = createCachedIcon();
    if (cachedIcon) {
      return cachedIcon;
    }

    const namespaceUri = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespaceUri, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const rect = document.createElementNS(namespaceUri, "rect");
    rect.setAttribute("x", "1");
    rect.setAttribute("y", "1");
    rect.setAttribute("width", "14");
    rect.setAttribute("height", "14");
    rect.setAttribute("rx", "3");
    rect.setAttribute("fill", "#F4F5F7");
    rect.setAttribute("stroke", "#C1C7D0");

    const primary = document.createElementNS(namespaceUri, "path");
    primary.setAttribute("d", "M4 11V5h1.7l2.3 3.4L10.3 5H12v6h-1.3V7.1L8.8 9.9H7.2L5.3 7.1V11H4z");
    primary.setAttribute("fill", "#006644");

    const accent = document.createElementNS(namespaceUri, "path");
    accent.setAttribute("d", "M12.2 3.2l.6-.6.9.9-.6.6z");
    accent.setAttribute("fill", "#DE350B");

    svg.append(rect, primary, accent);
    return svg;
  }

  function createCachedIcon() {
    let cachedMarkup = "";

    try {
      cachedMarkup = window.localStorage?.getItem(SVG_CACHE_STORAGE_KEY) ?? "";
    } catch (_error) {
      return null;
    }

    if (!cachedMarkup) {
      return null;
    }

    const template = document.createElement("template");
    template.innerHTML = cachedMarkup.trim();
    const cachedIcon = template.content.firstElementChild;
    return cachedIcon instanceof SVGSVGElement ? cloneSvgForButton(cachedIcon) : null;
  }

  function cloneSvgForButton(sourceIcon) {
    if (!(sourceIcon instanceof SVGSVGElement)) {
      return createFallbackIcon();
    }

    const clone = sourceIcon.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("onclick");
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("focusable", "false");
    clone.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    const paths = clone.querySelectorAll("path");
    if (paths[2]) {
      paths[2].setAttribute("data-gm-manictime-highlight", "true");
    }

    return clone;
  }

  function cacheOriginalIcon(sourceIcon) {
    if (!(sourceIcon instanceof SVGSVGElement)) {
      return;
    }

    try {
      window.localStorage?.setItem(SVG_CACHE_STORAGE_KEY, sourceIcon.outerHTML);
    } catch (_error) {
      // Ignore storage failures and keep the runtime-only icon swap working.
    }
  }

  function cloneOriginalIcon(sourceIcon) {
    return cloneSvgForButton(sourceIcon);
  }

  function updateButtonIcon(sourceIcon = getOriginalIcon()) {
    const button = document.getElementById(BUTTON_ID);
    if (!(button instanceof SVGSVGElement) || !(sourceIcon instanceof SVGSVGElement)) {
      return;
    }

    cacheOriginalIcon(sourceIcon);
    const nextIcon = cloneOriginalIcon(sourceIcon);
    if (button.isEqualNode(nextIcon)) {
      return;
    }

    button.replaceWith(nextIcon);
    nextIcon.id = BUTTON_ID;
    nextIcon.style.width = "16px";
    nextIcon.style.height = "16px";
    nextIcon.style.marginTop = "2px";
    nextIcon.style.marginLeft = "24px";
    nextIcon.style.position = "absolute";
    nextIcon.style.cursor = "pointer";
    nextIcon.setAttribute("title", "Copy ManiTime tag");
    nextIcon.setAttribute("aria-label", "Copy ManiTime tag");
    nextIcon.setAttribute("role", "button");
    nextIcon.setAttribute("tabindex", "0");
    attachCopyHandlers(nextIcon);
  }

  function attachCopyHandlers(button) {
    if (!(button instanceof SVGSVGElement) || button.dataset.gmBound === "true") {
      return;
    }

    const handleCopy = async () => {
      const copied = await copyText(buildCopyText());
      if (copied) {
        flashCopyState(button);
      }
    };

    button.dataset.gmBound = "true";
    button.addEventListener("click", handleCopy);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void handleCopy();
      }
    });
  }

  function createButton() {
    const button = createFallbackIcon();
    button.id = BUTTON_ID;
    button.style.width = "16px";
    button.style.height = "16px";
    button.style.marginTop = "2px";
    button.style.marginLeft = "24px";
    button.style.position = "absolute";
    button.style.cursor = "pointer";
    button.setAttribute("title", "Copy ManiTime tag");
    button.setAttribute("aria-label", "Copy ManiTime tag");
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    attachCopyHandlers(button);
    return button;
  }

  function ensureButton() {
    if (!getIssueKey()) {
      return;
    }

    const breadcrumb = document.querySelector(BREADCRUMB_SELECTOR);
    if (!(breadcrumb instanceof HTMLElement)) {
      return;
    }

    if (document.getElementById(BUTTON_ID)) {
      return;
    }
    breadcrumb.appendChild(createButton());
    updateButtonIcon();
  }

  function exposeOverrides() {
    window.copyManicTimeLink = function copyManicTimeLink() {
      return copyText(buildCopyText());
    };

    window.copyLink = function copyLink() {
      return false;
    };
  }

  function syncUi() {
    ensureStyle();
    ensureButton();
    updateButtonIcon();
    removeOverriddenIcons();
    exposeOverrides();
  }

  const observer = new MutationObserver((mutationList) => {
    mutationList.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element) || isOurNode(node)) {
          return;
        }

        removeOverriddenIcons(node);

        const originalIcon = getOriginalIcon(node);
        if (originalIcon) {
          updateButtonIcon(originalIcon);
        }

        if (node.matches(BREADCRUMB_SELECTOR) || node.querySelector(BREADCRUMB_SELECTOR)) {
          ensureButton();
        }
      });
    });

    ensureButton();
    exposeOverrides();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", syncUi, { once: true });
  syncUi();
})();
