// ==UserScript==
// @name         Message Registry - Preview downloads
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.4
// @description  Shows message payloads and attachments in a dialog instead of downloading them.
// @author       Lukáš Sedláček
// @match        *://*/uu-energygateway-messageregistryg01/*/messageDetail*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/message-registry-preview-downloads.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/message-registry-preview-downloads.js
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_FLAG = "__gmMessageRegistryPreviewDownloads";
  const PREVIEW_TIMEOUT_MS = 15000;
  const DOWNLOAD_SUPPRESSION_MS = 5000;
  const PAYLOAD_BUTTON_SELECTOR = '[data-testid="external-payload-button"], [data-testid="internal-payload-button"]';
  const PREVIEW_BUTTON_CLASS = "gm-message-preview-trigger";
  const PAYLOAD_PREVIEW_GROUP_CLASS = "gm-message-preview-group";

  if (window[SCRIPT_FLAG]) return;
  window[SCRIPT_FLAG] = true;

  let pendingPreview = null;
  let pendingPreviewTimeout = null;
  let suppressDownloadsUntil = 0;
  let dialogState = null;

  function armPreview(info) {
    pendingPreview = {
      ...info,
      armedAt: Date.now(),
    };

    window.clearTimeout(pendingPreviewTimeout);
    pendingPreviewTimeout = window.setTimeout(() => {
      pendingPreview = null;
    }, PREVIEW_TIMEOUT_MS);
  }

  function consumePreview() {
    const currentPreview = pendingPreview;
    pendingPreview = null;
    window.clearTimeout(pendingPreviewTimeout);
    pendingPreviewTimeout = null;
    return currentPreview;
  }

  function hasPendingPreview() {
    return Boolean(pendingPreview && Date.now() - pendingPreview.armedAt <= PREVIEW_TIMEOUT_MS);
  }

  function activateDownloadSuppression() {
    suppressDownloadsUntil = Date.now() + DOWNLOAD_SUPPRESSION_MS;
  }

  function isDownloadSuppressed() {
    return Date.now() < suppressDownloadsUntil;
  }

  function getAttachmentLink(target) {
    const link = target.closest("tr a[role='link']");
    if (!link) return false;

    const button = link.querySelector("button");
    if (!button) return null;

    return link.querySelector(".uugds-download") || button.querySelector(".uugds-download") ? link : null;
  }

  function getAttachmentPreviewInfo(link) {
    const row = link.closest("tr");
    const rowText = row?.innerText?.trim() || "Attachment";
    return {
      kind: "attachment",
      title: "Download Attachment",
      subtitle: rowText,
    };
  }

  function shouldInspectUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.pathname.includes("/message/payload/get")) return true;
      if (url.searchParams.get("forceDownload") === "true") return true;
      if (url.searchParams.get("contentDisposition") === "attachment") return true;
      return false;
    } catch {
      return false;
    }
  }

  function adjustDownloadUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.searchParams.has("forceDownload")) {
        url.searchParams.set("forceDownload", "false");
      }
      if (url.searchParams.has("contentDisposition")) {
        url.searchParams.set("contentDisposition", "inline");
      }
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  function decodeContentDispositionFilename(contentDisposition) {
    if (!contentDisposition) return null;

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }

    const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    return plainMatch ? plainMatch[1] : null;
  }

  function inferFilename(url, headers) {
    const headerFilename = decodeContentDispositionFilename(headers.get("content-disposition"));
    if (headerFilename) return headerFilename;

    try {
      const parsedUrl = new URL(url, window.location.href);
      const payloadType = parsedUrl.searchParams.get("payloadType");
      if (payloadType) return `message-${payloadType}.txt`;
      const lastSegment = parsedUrl.pathname.split("/").filter(Boolean).pop();
      return lastSegment || "download.bin";
    } catch {
      return "download.bin";
    }
  }

  function getCurrentMessageId() {
    return new URL(window.location.href).searchParams.get("messageId");
  }

  function getWorkspaceBaseUri() {
    return window.location.pathname.replace(/\/messageDetail.*$/u, "");
  }

  function buildPayloadPreviewUrl(payloadType) {
    const messageId = getCurrentMessageId();
    if (!messageId) {
      throw new Error("Message ID was not found in the current URL.");
    }

    const url = new URL(`${window.location.origin}${getWorkspaceBaseUri()}/message/payload/get`);
    url.searchParams.set("messageId", messageId);
    url.searchParams.set("payloadType", payloadType);
    url.searchParams.set("contentDisposition", "inline");
    url.searchParams.set("forceDownload", "false");
    return url.toString();
  }

  function isLikelyText(contentType) {
    if (!contentType) return false;

    return [
      "text/",
      "application/json",
      "application/xml",
      "application/xhtml+xml",
      "application/javascript",
      "application/x-javascript",
      "application/sql",
      "application/csv",
      "application/yaml",
      "application/x-yaml",
      "image/svg+xml",
    ].some((textType) => contentType.includes(textType));
  }

  function looksPrintable(text) {
    if (!text) return false;
    let printableChars = 0;

    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code >= 160) {
        printableChars += 1;
      }
    }

    return printableChars / text.length > 0.85;
  }

  function escapeXmlText(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function formatXmlNode(node, indent = "") {
    const childNodes = [...node.childNodes].filter((child) => {
      return child.nodeType !== Node.TEXT_NODE || child.textContent.trim();
    });

    if (!childNodes.length) {
      return `${indent}<${node.nodeName}${[...node.attributes].map((attr) => ` ${attr.name}="${attr.value}"`).join("")}/>`;
    }

    if (childNodes.length === 1 && childNodes[0].nodeType === Node.TEXT_NODE) {
      return `${indent}<${node.nodeName}${[...node.attributes].map((attr) => ` ${attr.name}="${attr.value}"`).join("")}>${escapeXmlText(childNodes[0].textContent.trim())}</${node.nodeName}>`;
    }

    const lines = [`${indent}<${node.nodeName}${[...node.attributes].map((attr) => ` ${attr.name}="${attr.value}"`).join("")}>`];

    for (const child of childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        lines.push(formatXmlNode(child, `${indent}  `));
      } else if (child.nodeType === Node.CDATA_SECTION_NODE) {
        lines.push(`${indent}  <![CDATA[${child.textContent}]]>`);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        lines.push(`${indent}  <!--${child.textContent}-->`);
      } else if (child.nodeType === Node.TEXT_NODE) {
        lines.push(`${indent}  ${escapeXmlText(child.textContent.trim())}`);
      }
    }

    lines.push(`${indent}</${node.nodeName}>`);
    return lines.join("\n");
  }

  function tryFormatXml(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("<")) {
      return null;
    }

    const parser = new DOMParser();
    const xml = parser.parseFromString(trimmed, "application/xml");
    if (xml.querySelector("parsererror")) {
      return null;
    }

    const declarationMatch = trimmed.match(/^<\?xml[^>]*\?>/i);
    const formattedBody = formatXmlNode(xml.documentElement);
    return declarationMatch ? `${declarationMatch[0]}\n${formattedBody}` : formattedBody;
  }

  function tryFormatJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  }

  function getFormattedPreviewText(text, contentType) {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    if (/json/i.test(contentType || "") || /^[\[{]/.test(trimmed)) {
      const formattedJson = tryFormatJson(trimmed);
      if (formattedJson && formattedJson !== text) {
        return formattedJson;
      }
    }

    if (/xml|soap|html/i.test(contentType || "") || trimmed.startsWith("<")) {
      const formattedXml = tryFormatXml(trimmed);
      if (formattedXml && formattedXml !== text) {
        return formattedXml;
      }
    }

    return null;
  }

  async function blobToPreview(blob, contentType) {
    if (isLikelyText(contentType)) {
      return blob.text();
    }

    const buffer = await blob.arrayBuffer();
    const utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (looksPrintable(utf8Text)) {
      return utf8Text;
    }

    return null;
  }

  function ensureDialog() {
    if (dialogState) return dialogState;

    const backdrop = document.createElement("div");
    backdrop.style.position = "fixed";
    backdrop.style.inset = "0";
    backdrop.style.background = "rgba(15, 23, 42, 0.56)";
    backdrop.style.backdropFilter = "blur(2px)";
    backdrop.style.display = "none";
    backdrop.style.alignItems = "center";
    backdrop.style.justifyContent = "center";
    backdrop.style.padding = "24px";
    backdrop.style.zIndex = "2147483647";

    const panel = document.createElement("div");
    panel.style.width = "min(1100px, 100%)";
    panel.style.maxHeight = "min(85vh, 100%)";
    panel.style.background = "#ffffff";
    panel.style.color = "#0f172a";
    panel.style.borderRadius = "16px";
    panel.style.boxShadow = "0 24px 80px rgba(15, 23, 42, 0.32)";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.overflow = "hidden";

    const header = document.createElement("div");
    header.style.padding = "18px 24px 14px";
    header.style.borderBottom = "1px solid #dbe4f0";
    header.style.display = "flex";
    header.style.gap = "16px";
    header.style.alignItems = "start";
    header.style.justifyContent = "space-between";

    const headingWrap = document.createElement("div");
    headingWrap.style.minWidth = "0";

    const title = document.createElement("div");
    title.style.fontSize = "20px";
    title.style.fontWeight = "700";
    title.style.marginBottom = "6px";

    const subtitle = document.createElement("div");
    subtitle.style.fontSize = "13px";
    subtitle.style.lineHeight = "1.5";
    subtitle.style.color = "#475569";
    subtitle.style.whiteSpace = "pre-wrap";
    subtitle.style.wordBreak = "break-word";

    headingWrap.append(title, subtitle);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.flexDirection = "row";
    actions.style.gap = "10px";
    actions.style.alignItems = "center";
    actions.style.flexWrap = "nowrap";
    actions.style.flexShrink = "0";

    const downloadLink = document.createElement("a");
    downloadLink.textContent = "Download";
    downloadLink.style.display = "none";
    downloadLink.style.alignItems = "center";
    downloadLink.style.justifyContent = "center";
    downloadLink.style.borderRadius = "999px";
    downloadLink.style.padding = "10px 16px";
    downloadLink.style.background = "#e2e8f0";
    downloadLink.style.color = "#0f172a";
    downloadLink.style.textDecoration = "none";
    downloadLink.style.fontSize = "13px";
    downloadLink.style.lineHeight = "1";
    downloadLink.style.whiteSpace = "nowrap";

    const formatButton = document.createElement("button");
    formatButton.type = "button";
    formatButton.textContent = "Format";
    formatButton.style.display = "none";
    formatButton.style.alignItems = "center";
    formatButton.style.justifyContent = "center";
    formatButton.style.flex = "0 0 auto";
    formatButton.style.border = "none";
    formatButton.style.borderRadius = "999px";
    formatButton.style.padding = "10px 16px";
    formatButton.style.width = "84px";
    formatButton.style.background = "#e2e8f0";
    formatButton.style.color = "#0f172a";
    formatButton.style.cursor = "pointer";
    formatButton.style.fontSize = "13px";
    formatButton.style.lineHeight = "1";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.style.display = "inline-flex";
    closeButton.style.alignItems = "center";
    closeButton.style.justifyContent = "center";
    closeButton.style.flex = "0 0 auto";
    closeButton.style.border = "none";
    closeButton.style.borderRadius = "999px";
    closeButton.style.padding = "10px 16px";
    closeButton.style.background = "#0f172a";
    closeButton.style.color = "#ffffff";
    closeButton.style.cursor = "pointer";
    closeButton.addEventListener("click", () => hideDialog());

    actions.append(downloadLink, formatButton, closeButton);
    header.append(headingWrap, actions);

    const body = document.createElement("div");
    body.style.padding = "0";
    body.style.overflow = "auto";
    body.style.background = "#f8fafc";

    const notice = document.createElement("div");
    notice.style.display = "none";
    notice.style.padding = "12px 24px 0";
    notice.style.color = "#92400e";
    notice.style.fontSize = "12px";

    const pre = document.createElement("pre");
    pre.style.margin = "0";
    pre.style.padding = "20px 24px 24px";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-word";
    pre.style.fontFamily = "Consolas, Monaco, 'Courier New', monospace";
    pre.style.fontSize = "13px";
    pre.style.lineHeight = "1.5";
    pre.style.color = "#0f172a";

    body.append(notice, pre);

    const footer = document.createElement("div");
    footer.style.padding = "14px 24px 18px";
    footer.style.borderTop = "1px solid #dbe4f0";
    footer.style.display = "flex";
    footer.style.gap = "12px";
    footer.style.alignItems = "center";
    footer.style.justifyContent = "space-between";

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.color = "#64748b";

    footer.append(meta);
    panel.append(header, body, footer);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        hideDialog();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && backdrop.style.display !== "none") {
        hideDialog();
      }
    });

    dialogState = {
      backdrop,
      title,
      subtitle,
      notice,
      pre,
      meta,
      downloadLink,
      formatButton,
      rawText: "",
      formattedText: null,
      isFormatted: false,
      objectUrl: null,
    };

    formatButton.addEventListener("click", () => {
      if (!dialogState?.formattedText) return;

      dialogState.isFormatted = !dialogState.isFormatted;
      dialogState.pre.textContent = dialogState.isFormatted ? dialogState.formattedText : dialogState.rawText;
      dialogState.formatButton.textContent = dialogState.isFormatted ? "Raw" : "Format";
    });

    return dialogState;
  }

  function hideDialog() {
    if (!dialogState) return;

    dialogState.backdrop.style.display = "none";
    dialogState.notice.style.display = "none";
    if (dialogState.objectUrl) {
      URL.revokeObjectURL(dialogState.objectUrl);
      dialogState.objectUrl = null;
    }
    dialogState.downloadLink.style.display = "none";
    dialogState.downloadLink.removeAttribute("href");
    dialogState.downloadLink.removeAttribute("download");
  }

  function showDialog({ title, subtitle, text, meta, blob, filename, notice }) {
    const dialog = ensureDialog();

    if (dialog.objectUrl) {
      URL.revokeObjectURL(dialog.objectUrl);
      dialog.objectUrl = null;
    }

    dialog.title.textContent = filename ? `${title} - ${filename}` : title;
    dialog.subtitle.textContent = subtitle || "";
    dialog.rawText = text;
    dialog.formattedText = getFormattedPreviewText(text, meta);
    dialog.isFormatted = false;
    dialog.pre.textContent = text;
    dialog.meta.textContent = meta || "";
    dialog.notice.textContent = notice || "";
    dialog.notice.style.display = notice ? "block" : "none";
    dialog.formatButton.textContent = "Format";
    dialog.formatButton.style.display = dialog.formattedText ? "inline-flex" : "none";

    if (blob) {
      dialog.objectUrl = URL.createObjectURL(blob);
      dialog.downloadLink.href = dialog.objectUrl;
      dialog.downloadLink.download = filename || "download.bin";
      dialog.downloadLink.style.display = "inline-flex";
    } else {
      dialog.downloadLink.style.display = "none";
      dialog.downloadLink.removeAttribute("href");
      dialog.downloadLink.removeAttribute("download");
    }

    dialog.backdrop.style.display = "flex";
  }

  async function showResponsePreview(response, requestUrl, previewInfo) {
    const filename = inferFilename(requestUrl, response.headers);
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const previewBlob = await response.clone().blob();
    const previewText = await blobToPreview(previewBlob, contentType);
    const statusLabel = `${response.status} ${response.statusText}`.trim();
    const meta = `Status: ${statusLabel} | Content-Type: ${contentType} | Filename: ${filename}`;

    showDialog({
      title: previewInfo.title,
      subtitle: previewInfo.subtitle || requestUrl,
      text:
        previewText ||
        `Binary content cannot be rendered safely as text.\n\nFilename: ${filename}\nContent-Type: ${contentType}\nSize: ${previewBlob.size} bytes`,
      meta,
      blob: previewBlob,
      filename,
      notice: previewText ? "" : "Use Download if you still want the original file.",
    });
  }

  async function showErrorPreview(error, requestUrl, previewInfo) {
    const message = error instanceof Error ? error.message : String(error);
    showDialog({
      title: `${previewInfo.title} failed`,
      subtitle: previewInfo.subtitle || requestUrl,
      text: message,
      meta: "The original download request failed before the preview could be rendered.",
    });
  }

  async function previewPayloadDirectly(payloadType) {
    const title = payloadType === "external" ? "Download External" : "Download Internal";
    const requestUrl = buildPayloadPreviewUrl(payloadType);

    try {
      const response = await window.fetch(requestUrl);
      activateDownloadSuppression();
      await showResponsePreview(response, requestUrl, { title });
    } catch (error) {
      await showErrorPreview(error, requestUrl, { title });
    }
  }

  function createButtonIcon(symbol) {
    const icon = document.createElement("span");
    icon.textContent = symbol;
    icon.style.fontSize = "16px";
    icon.style.lineHeight = "1";
    return icon;
  }

  function createPreviewButton(referenceButton, options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = PREVIEW_BUTTON_CLASS;
    button.title = options.title;
    button.setAttribute("aria-label", options.title);
    button.classList.add(...referenceButton.className.split(/\s+/u).filter(Boolean));
    button.dataset.previewKind = options.kind;
    if (options.payloadType) {
      button.dataset.payloadType = options.payloadType;
    }

    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.width = "36px";
    button.style.minWidth = "36px";
    button.style.height = "36px";
    button.style.padding = "0";
    button.style.marginLeft = options.marginLeft || "6px";
    button.style.flex = "0 0 auto";
    button.appendChild(createButtonIcon("🔍"));

    if (options.disabled) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
    } else {
      button.style.cursor = "pointer";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        options.onClick();
      });
    }

    return button;
  }

  function triggerAttachmentPreview(link) {
    const button = link.querySelector("button");
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      return;
    }

    armPreview(getAttachmentPreviewInfo(link));
    link.click();
  }

  function ensurePayloadPreviewButtons() {
    const payloadButtons = [...document.querySelectorAll(PAYLOAD_BUTTON_SELECTOR)].filter((button) => button instanceof HTMLButtonElement);
    if (!payloadButtons.length) {
      return;
    }

    const toolbar = payloadButtons[0].parentElement;
    if (!toolbar) {
      return;
    }

    let previewGroup = toolbar.querySelector(`.${PAYLOAD_PREVIEW_GROUP_CLASS}`);
    if (!previewGroup) {
      previewGroup = document.createElement("div");
      previewGroup.className = PAYLOAD_PREVIEW_GROUP_CLASS;
      previewGroup.style.display = "inline-flex";
      previewGroup.style.alignItems = "center";
      previewGroup.style.gap = "6px";

      const menuButton = [...toolbar.children].find((child) => child instanceof HTMLButtonElement && child.getAttribute("aria-haspopup") === "menu");
      toolbar.insertBefore(previewGroup, menuButton || null);
    }

    payloadButtons.forEach((button) => {
      const payloadType = button.dataset.testid === "external-payload-button" ? "external" : "internal";
      const existingButton = previewGroup.querySelector(`.${PREVIEW_BUTTON_CLASS}[data-payload-type="${payloadType}"]`);
      if (existingButton) {
        return;
      }

      previewGroup.appendChild(
        createPreviewButton(button, {
          kind: "payload",
          payloadType,
          title: payloadType === "external" ? "Preview external payload" : "Preview internal payload",
          marginLeft: "0",
          onClick: () => {
            void previewPayloadDirectly(payloadType);
          },
        }),
      );
    });
  }

  function ensureAttachmentPreviewButtons() {
    document.querySelectorAll("tr a[role='link']").forEach((link) => {
      if (!(link instanceof HTMLAnchorElement)) {
        return;
      }

      const attachmentLink = getAttachmentLink(link);
      if (!attachmentLink) {
        return;
      }

      const existingButton = attachmentLink.nextElementSibling;
      if (existingButton?.classList?.contains(PREVIEW_BUTTON_CLASS) && existingButton.dataset.previewKind === "attachment") {
        return;
      }

      const referenceButton = attachmentLink.querySelector("button");
      if (!(referenceButton instanceof HTMLButtonElement)) {
        return;
      }

      attachmentLink.insertAdjacentElement(
        "afterend",
        createPreviewButton(referenceButton, {
          kind: "attachment",
          title: "Preview attachment",
          disabled: referenceButton.disabled || referenceButton.getAttribute("aria-disabled") === "true",
          onClick: () => {
            triggerAttachmentPreview(attachmentLink);
          },
        }),
      );
    });
  }

  function observePayloadButtons() {
    ensurePayloadPreviewButtons();
    ensureAttachmentPreviewButtons();

    const observer = new MutationObserver(() => {
      ensurePayloadPreviewButtons();
      ensureAttachmentPreviewButtons();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(() => {
      ensurePayloadPreviewButtons();
      ensureAttachmentPreviewButtons();
    }, 1000);
  }

  function patchFetch() {
    const originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
      const requestUrl = typeof input === "string" ? input : input?.url;
      const previewInfo = hasPendingPreview() && requestUrl && shouldInspectUrl(requestUrl) ? consumePreview() : null;

      if (!previewInfo) {
        return originalFetch(input, init);
      }

      const adjustedUrl = adjustDownloadUrl(requestUrl);
      const actualInput = typeof input === "string" ? adjustedUrl : input instanceof Request ? new Request(adjustedUrl, input) : input;

      try {
        const response = await originalFetch(actualInput, init);
        activateDownloadSuppression();
        await showResponsePreview(response, adjustedUrl, previewInfo);
        return response;
      } catch (error) {
        await showErrorPreview(error, adjustedUrl, previewInfo);
        throw error;
      }
    };
  }

  function patchBlobDownloads() {
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function patchedCreateObjectURL(blob) {
      const previewInfo = hasPendingPreview() ? consumePreview() : null;
      if (previewInfo && blob instanceof Blob) {
        activateDownloadSuppression();
        blobToPreview(blob, blob.type || "application/octet-stream")
          .then((previewText) => {
            showDialog({
              title: previewInfo.title,
              subtitle: previewInfo.subtitle || window.location.href,
              text:
                previewText ||
                `Binary content cannot be rendered safely as text.\n\nContent-Type: ${blob.type || "application/octet-stream"}\nSize: ${blob.size} bytes`,
              meta: `Captured a generated blob (${blob.type || "application/octet-stream"}).`,
              blob,
              filename: previewInfo.filename || "download.bin",
              notice: previewText ? "" : "Use Download if you still want the original file.",
            });
          })
          .catch((error) => {
            showErrorPreview(error, window.location.href, previewInfo);
          });
      }

      return originalCreateObjectUrl(blob);
    };

    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedAnchorClick() {
      const href = this.getAttribute("href") || "";
      if (isDownloadSuppressed() && (this.hasAttribute("download") || href.startsWith("blob:") || href.startsWith("data:"))) {
        return;
      }

      return originalAnchorClick.call(this);
    };

    const originalWindowOpen = window.open;
    window.open = function patchedWindowOpen(url, ...rest) {
      if (isDownloadSuppressed() && typeof url === "string" && (url.startsWith("blob:") || url.startsWith("data:") || shouldInspectUrl(url))) {
        return null;
      }

      return originalWindowOpen.call(window, url, ...rest);
    };
  }

  patchFetch();
  patchBlobDownloads();
  observePayloadButtons();
})();
