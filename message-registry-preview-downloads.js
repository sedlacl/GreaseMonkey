// ==UserScript==
// @name         Message Registry - Preview downloads
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.13
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
  const SYNTAX_HIGHLIGHT_MAX_CHARS = 50000;
  const PAYLOAD_BUTTON_SELECTOR = '[data-testid="external-payload-button"], [data-testid="internal-payload-button"]';
  const PREVIEW_BUTTON_CLASS = "gm-message-preview-trigger";

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
    const rowText =
      [...(row?.childNodes || [])]
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim() || "Attachment";
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

  function formatFileSize(sizeInBytes) {
    if (!Number.isFinite(sizeInBytes) || sizeInBytes < 0) {
      return null;
    }

    const units = ["B", "KB", "MB", "GB"];
    let size = sizeInBytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    const roundedSize = size >= 100 || unitIndex === 0 ? Math.round(size) : size.toFixed(1);
    return `${roundedSize} ${units[unitIndex]}`;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
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

  function buildMessageSourcePreviewUrl() {
    const messageId = getCurrentMessageId();
    if (!messageId) {
      throw new Error("Message ID was not found in the current URL.");
    }

    const url = new URL(`${window.location.origin}${getWorkspaceBaseUri()}/message/get`);
    url.searchParams.set("id", messageId);
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

  function escapeHtml(value) {
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

  function findBalancedSegment(text, startIndex, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (char === "\\") {
          isEscaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }

    return -1;
  }

  function splitTopLevel(text, separatorChar) {
    const items = [];
    let startIndex = 0;
    let curlyDepth = 0;
    let squareDepth = 0;
    let roundDepth = 0;
    let inString = false;
    let isEscaped = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (char === "\\") {
          isEscaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{") curlyDepth += 1;
      else if (char === "}") curlyDepth -= 1;
      else if (char === "[") squareDepth += 1;
      else if (char === "]") squareDepth -= 1;
      else if (char === "(") roundDepth += 1;
      else if (char === ")") roundDepth -= 1;

      if (char === separatorChar && curlyDepth === 0 && squareDepth === 0 && roundDepth === 0) {
        items.push(text.slice(startIndex, index).trim());
        startIndex = index + 1;
      }
    }

    items.push(text.slice(startIndex).trim());
    return items.filter(Boolean);
  }

  function parseWrappedResponse(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) {
      return null;
    }

    const innerText = trimmed.slice(1, -1).trim();
    const jsonStartIndex = innerText.indexOf("{");
    if (jsonStartIndex < 0) {
      return null;
    }

    const jsonEndIndex = findBalancedSegment(innerText, jsonStartIndex, "{", "}");
    if (jsonEndIndex < 0) {
      return null;
    }

    const prefix = innerText.slice(0, jsonStartIndex).replace(/,\s*$/u, "").trim();
    const jsonText = innerText.slice(jsonStartIndex, jsonEndIndex + 1).trim();
    const suffix = innerText
      .slice(jsonEndIndex + 1)
      .replace(/^\s*,/u, "")
      .trim();

    if (!prefix) {
      return null;
    }

    return { prefix, jsonText, suffix };
  }

  function formatWrappedSuffix(text) {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      return trimmed;
    }

    const items = splitTopLevel(trimmed.slice(1, -1), ",");
    if (!items.length) {
      return "[]";
    }

    return `[\n  ${items.join(",\n  ")}\n]`;
  }

  function tryFormatWrappedResponse(text) {
    const wrappedResponse = parseWrappedResponse(text);
    if (!wrappedResponse) {
      return null;
    }

    const formattedJson = tryFormatJson(wrappedResponse.jsonText);
    if (!formattedJson) {
      return null;
    }

    const lines = [`<${wrappedResponse.prefix},`, formattedJson];
    if (wrappedResponse.suffix) {
      lines.push(formatWrappedSuffix(wrappedResponse.suffix) || wrappedResponse.suffix);
    }
    lines.push(">");
    return lines.join("\n");
  }

  function splitStructuredPrefix(text) {
    const normalizedText = text.replace(/\r\n/gu, "\n");
    const headerSeparatorMatch = normalizedText.match(/\n\s*\n/gu);
    if (!headerSeparatorMatch) {
      return null;
    }

    const separator = headerSeparatorMatch[0];
    const separatorIndex = normalizedText.indexOf(separator);
    if (separatorIndex < 0) {
      return null;
    }

    const prefix = normalizedText.slice(0, separatorIndex).trimEnd();
    const body = normalizedText.slice(separatorIndex + separator.length).trim();
    if (!prefix || !body) {
      return null;
    }

    const prefixLines = prefix
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const looksLikeStructuredPrefix = prefixLines.some((line) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+|^[A-Za-z0-9-]+\s*:/u.test(line));
    if (!looksLikeStructuredPrefix) {
      return null;
    }

    return { prefix, body };
  }

  function getFormattedPreviewText(text, contentType) {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    const formattedWrappedResponse = tryFormatWrappedResponse(trimmed);
    if (formattedWrappedResponse && formattedWrappedResponse !== text) {
      return formattedWrappedResponse;
    }

    const structuredText = splitStructuredPrefix(text);
    if (structuredText) {
      const formattedBody = getFormattedPreviewText(structuredText.body, contentType);
      if (formattedBody) {
        return `${structuredText.prefix}\n\n${formattedBody}`;
      }
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

  function detectHighlightMode(text, contentType) {
    const trimmed = text.trim();
    if (!trimmed) {
      return "plain";
    }

    if (parseWrappedResponse(text)) {
      return "wrapped-response";
    }

    const structuredText = splitStructuredPrefix(text);
    if (structuredText) {
      const bodyMode = detectHighlightMode(structuredText.body, contentType);
      return bodyMode === "plain" ? "structured" : `structured-${bodyMode}`;
    }

    if (/json/i.test(contentType || "") || /^[\[{]/.test(trimmed)) {
      return "json";
    }

    if (/xml|soap|html/i.test(contentType || "") || trimmed.startsWith("<")) {
      return "xml";
    }

    return "plain";
  }

  function highlightJson(text) {
    const escapedText = escapeHtml(text);
    return escapedText.replace(
      /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:?)|(\btrue\b|\bfalse\b|\bnull\b)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/gu,
      (match, stringToken, keywordToken, numberToken) => {
        if (stringToken) {
          const className = stringToken.endsWith(":") ? "gm-syntax-key" : "gm-syntax-string";
          return `<span class="${className}">${stringToken}</span>`;
        }

        if (keywordToken) {
          return `<span class="gm-syntax-keyword">${keywordToken}</span>`;
        }

        if (numberToken) {
          return `<span class="gm-syntax-number">${numberToken}</span>`;
        }

        return match;
      },
    );
  }

  function highlightXml(text) {
    const escapedText = escapeHtml(text);
    return escapedText
      .replace(/(&lt;!--[\s\S]*?--&gt;)/gu, '<span class="gm-syntax-comment">$1</span>')
      .replace(/(&lt;!\[CDATA\[[\s\S]*?\]\]&gt;)/gu, '<span class="gm-syntax-cdata">$1</span>')
      .replace(/(&lt;\/?)([A-Za-z_][\w.:-]*)(.*?)(\/??&gt;)/gu, (_match, open, tagName, attributes, close) => {
        const highlightedAttributes = attributes.replace(
          /([A-Za-z_][\w.:-]*)(=)(".*?")/gu,
          '<span class="gm-syntax-attr">$1</span><span class="gm-syntax-punctuation">$2</span><span class="gm-syntax-string">$3</span>',
        );

        return `<span class="gm-syntax-tag">${open}</span><span class="gm-syntax-tag-name">${tagName}</span>${highlightedAttributes}<span class="gm-syntax-tag">${close}</span>`;
      });
  }

  function highlightStructuredText(text, contentType) {
    const structuredText = splitStructuredPrefix(text);
    if (!structuredText) {
      return escapeHtml(text);
    }

    const highlightedPrefix = structuredText.prefix
      .split("\n")
      .map((line) => {
        const trimmedLine = line.trim();
        const requestLineMatch = trimmedLine.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\s+)(.+)$/u);
        if (requestLineMatch) {
          return `<span class="gm-syntax-keyword">${requestLineMatch[1]}</span>${requestLineMatch[2]}<span class="gm-syntax-string">${escapeHtml(requestLineMatch[3])}</span>`;
        }

        const headerLineMatch = trimmedLine.match(/^([A-Za-z0-9-]+)(\s*:\s*)(.*)$/u);
        if (headerLineMatch) {
          return `<span class="gm-syntax-attr">${headerLineMatch[1]}</span><span class="gm-syntax-punctuation">${escapeHtml(headerLineMatch[2])}</span><span class="gm-syntax-string">${escapeHtml(headerLineMatch[3])}</span>`;
        }

        return escapeHtml(line);
      })
      .join("\n");

    const bodyMode = detectHighlightMode(structuredText.body, contentType);
    const highlightedBody =
      bodyMode === "json" ? highlightJson(structuredText.body) : bodyMode === "xml" ? highlightXml(structuredText.body) : escapeHtml(structuredText.body);

    return `${highlightedPrefix}\n\n${highlightedBody}`;
  }

  function highlightWrappedResponse(text, isFormatted = false) {
    const wrappedResponse = parseWrappedResponse(text);
    if (!wrappedResponse) {
      return escapeHtml(text);
    }

    const parts = [`&lt;${escapeHtml(wrappedResponse.prefix)},`, highlightJson(wrappedResponse.jsonText)];
    if (wrappedResponse.suffix) {
      parts.push(escapeHtml(isFormatted ? formatWrappedSuffix(wrappedResponse.suffix) || wrappedResponse.suffix : wrappedResponse.suffix));
    }
    parts.push("&gt;");
    return parts.join(isFormatted ? "\n" : "");
  }

  function getHighlightedPreviewHtml(text, contentType, isFormatted = false) {
    const highlightMode = detectHighlightMode(text, contentType);
    if (highlightMode === "wrapped-response") {
      return highlightWrappedResponse(text, isFormatted);
    }

    if (highlightMode === "json") {
      return highlightJson(text);
    }

    if (highlightMode === "xml") {
      return highlightXml(text);
    }

    if (highlightMode.startsWith("structured")) {
      return highlightStructuredText(text, contentType);
    }

    return escapeHtml(text);
  }

  function shouldUseSyntaxHighlight(text) {
    return text.length <= SYNTAX_HIGHLIGHT_MAX_CHARS;
  }

  function renderPreviewContent(dialog, text, contentType) {
    dialog.pre.style.whiteSpace = dialog.isFormatted ? "pre-wrap" : "pre";
    dialog.pre.style.wordBreak = dialog.isFormatted ? "break-word" : "normal";
    dialog.pre.style.overflowWrap = dialog.isFormatted ? "anywhere" : "normal";

    if (!shouldUseSyntaxHighlight(text)) {
      dialog.pre.textContent = text;
      return;
    }

    dialog.pre.innerHTML = getHighlightedPreviewHtml(text, contentType, dialog.isFormatted);
  }

  function createDialogActionIcon(kind) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "18");
    icon.setAttribute("height", "18");
    icon.setAttribute("aria-hidden", "true");
    icon.style.display = "block";

    const addPath = (d, fill = "none") => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", fill);
      path.setAttribute("stroke", fill === "none" ? "currentColor" : "none");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      icon.appendChild(path);
    };

    if (kind === "download") {
      addPath("M12 4v9");
      addPath("M8.5 10.5 12 14l3.5-3.5");
      addPath("M7 18h10");
      return icon;
    }

    if (kind === "copy") {
      addPath("M9 9h10v12H9z");
      addPath("M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1");
      return icon;
    }

    if (kind === "format") {
      addPath("M8 9 5 12l3 3");
      addPath("M16 9l3 3-3 3");
      addPath("M10 12h4");
      return icon;
    }

    if (kind === "source") {
      addPath("M8.5 8.5 5 12l3.5 3.5");
      addPath("M15.5 8.5 19 12l-3.5 3.5");
      addPath("M13 6.5 11 17.5");
      return icon;
    }

    addPath("M6 6l12 12");
    addPath("M18 6 6 18");
    return icon;
  }

  function styleDialogActionControl(control, isPrimary = false) {
    control.style.display = "inline-flex";
    control.style.alignItems = "center";
    control.style.justifyContent = "center";
    control.style.width = "40px";
    control.style.minWidth = "40px";
    control.style.height = "40px";
    control.style.padding = "0";
    control.style.border = "none";
    control.style.borderRadius = "999px";
    control.style.background = isPrimary ? "#0f172a" : "#e2e8f0";
    control.style.color = isPrimary ? "#ffffff" : "#0f172a";
    control.style.cursor = "pointer";
    control.style.textDecoration = "none";
    control.style.flex = "0 0 auto";
  }

  function setDialogActionLabel(control, label) {
    control.title = label;
    control.setAttribute("aria-label", label);
  }

  function updateFormatButtonState(button, isFormatted) {
    button.style.background = isFormatted ? "#0f172a" : "#e2e8f0";
    button.style.color = isFormatted ? "#ffffff" : "#0f172a";
    button.style.boxShadow = isFormatted ? "inset 0 0 0 1px rgba(15, 23, 42, 0.08)" : "none";
    setDialogActionLabel(button, isFormatted ? "Show raw content" : "Format content");
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
    downloadLink.style.display = "none";
    styleDialogActionControl(downloadLink);
    setDialogActionLabel(downloadLink, "Download file");
    downloadLink.appendChild(createDialogActionIcon("download"));

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    styleDialogActionControl(copyButton);
    setDialogActionLabel(copyButton, "Copy content");
    copyButton.appendChild(createDialogActionIcon("copy"));

    const formatButton = document.createElement("button");
    formatButton.type = "button";
    formatButton.style.display = "none";
    styleDialogActionControl(formatButton);
    setDialogActionLabel(formatButton, "Format content");
    formatButton.appendChild(createDialogActionIcon("format"));

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    styleDialogActionControl(closeButton, true);
    setDialogActionLabel(closeButton, "Close preview");
    closeButton.appendChild(createDialogActionIcon("close"));
    closeButton.addEventListener("click", () => hideDialog());

    actions.append(downloadLink, copyButton, formatButton, closeButton);
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

    const style = document.createElement("style");
    style.textContent = `
      .gm-syntax-key { color: #9f1239; }
      .gm-syntax-string { color: #0f766e; }
      .gm-syntax-number { color: #1d4ed8; }
      .gm-syntax-keyword { color: #7c3aed; font-weight: 600; }
      .gm-syntax-tag { color: #475569; }
      .gm-syntax-tag-name { color: #b45309; }
      .gm-syntax-attr { color: #9a3412; }
      .gm-syntax-punctuation { color: #64748b; }
      .gm-syntax-comment { color: #6b7280; font-style: italic; }
      .gm-syntax-cdata { color: #0f766e; }
    `;

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
    backdrop.appendChild(style);
    document.body.appendChild(backdrop);

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
      copyButton,
      formatButton,
      rawText: "",
      formattedText: null,
      isFormatted: false,
      objectUrl: null,
    };

    formatButton.addEventListener("click", () => {
      if (!dialogState?.formattedText) return;

      dialogState.isFormatted = !dialogState.isFormatted;
      renderPreviewContent(dialogState, dialogState.isFormatted ? dialogState.formattedText : dialogState.rawText, dialogState.meta.textContent);
      updateFormatButtonState(dialogState.formatButton, dialogState.isFormatted);
    });

    copyButton.addEventListener("click", async () => {
      if (!dialogState) return;

      const contentToCopy = dialogState.isFormatted && dialogState.formattedText ? dialogState.formattedText : dialogState.rawText;
      if (!contentToCopy) return;

      const originalBackground = copyButton.style.background;
      const originalColor = copyButton.style.color;
      try {
        await copyTextToClipboard(contentToCopy);
        copyButton.style.background = "#dcfce7";
        copyButton.style.color = "#166534";
        setDialogActionLabel(copyButton, "Copied");
        window.setTimeout(() => {
          copyButton.style.background = originalBackground;
          copyButton.style.color = originalColor;
          setDialogActionLabel(copyButton, "Copy content");
        }, 1200);
      } catch {
        setDialogActionLabel(copyButton, "Copy failed");
        window.setTimeout(() => {
          setDialogActionLabel(copyButton, "Copy content");
        }, 1200);
      }
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
    renderPreviewContent(dialog, text, meta);
    dialog.meta.textContent = meta || "";
    dialog.notice.textContent = notice || "";
    dialog.notice.style.display = notice ? "block" : "none";
    setDialogActionLabel(dialog.copyButton, "Copy content");
    updateFormatButtonState(dialog.formatButton, false);
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
    const sizeLabel = formatFileSize(previewBlob.size);
    const meta = `Status: ${statusLabel} | Content-Type: ${contentType} | Filename: ${filename}${sizeLabel ? ` | Size: ${sizeLabel}` : ""}`;

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

  async function previewMessageSourceDirectly() {
    const requestUrl = buildMessageSourcePreviewUrl();

    try {
      const response = await window.fetch(requestUrl, {
        headers: {
          Accept: "application/json",
        },
      });
      const sourceBlob = await response.clone().blob();
      const sourceText = await response.text();

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim() + (sourceText ? `\n\n${sourceText}` : ""));
      }

      const contentType = response.headers.get("content-type") || "application/json";
      const sizeLabel = formatFileSize(sourceBlob.size);
      showDialog({
        title: "Message Source",
        subtitle: requestUrl,
        text: sourceText,
        meta: `Status: ${`${response.status} ${response.statusText}`.trim()} | Content-Type: ${contentType}${sizeLabel ? ` | Size: ${sizeLabel}` : ""}`,
      });
    } catch (error) {
      await showErrorPreview(error, requestUrl, { title: "Message Source" });
    }
  }

  function createButtonIcon(kind = "preview") {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "18");
    icon.setAttribute("height", "18");
    icon.setAttribute("aria-hidden", "true");
    icon.style.display = "block";

    const addPath = (d, fill = "none") => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", fill);
      path.setAttribute("stroke", fill === "none" ? "currentColor" : "none");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      icon.appendChild(path);
    };

    if (kind === "source") {
      addPath("M8.5 8.5 5 12l3.5 3.5");
      addPath("M15.5 8.5 19 12l-3.5 3.5");
      addPath("M13 6.5 11 17.5");
      return icon;
    }

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "11");
    circle.setAttribute("cy", "11");
    circle.setAttribute("r", "6");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "2");

    const handle = document.createElementNS("http://www.w3.org/2000/svg", "line");
    handle.setAttribute("x1", "15.5");
    handle.setAttribute("y1", "15.5");
    handle.setAttribute("x2", "21");
    handle.setAttribute("y2", "21");
    handle.setAttribute("stroke", "currentColor");
    handle.setAttribute("stroke-width", "2");
    handle.setAttribute("stroke-linecap", "round");

    icon.append(circle, handle);
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
    button.style.color = window.getComputedStyle(referenceButton).color;
    button.appendChild(createButtonIcon(options.kind));

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
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }

    armPreview(getAttachmentPreviewInfo(link));
    link.click();
  }

  function ensurePayloadPreviewButtons() {
    [...document.querySelectorAll(PAYLOAD_BUTTON_SELECTOR)]
      .filter((button) => button instanceof HTMLButtonElement)
      .forEach((button) => {
        const payloadType = button.dataset.testid === "external-payload-button" ? "external" : "internal";
        const existingButton = button.nextElementSibling;
        if (existingButton?.classList?.contains(PREVIEW_BUTTON_CLASS) && existingButton.getAttribute("data-payload-type") === payloadType) {
          return;
        }

        button.insertAdjacentElement(
          "afterend",
          createPreviewButton(button, {
            kind: "payload",
            payloadType,
            title: payloadType === "external" ? "Preview external payload" : "Preview internal payload",
            onClick: () => {
              void previewPayloadDirectly(payloadType);
            },
          }),
        );
      });
  }

  function ensureMessageSourceButton() {
    const internalButton = document.querySelector('[data-testid="internal-payload-button"]');
    if (!(internalButton instanceof HTMLButtonElement)) {
      return;
    }

    const payloadPreviewButton =
      internalButton.nextElementSibling?.classList?.contains(PREVIEW_BUTTON_CLASS) && internalButton.nextElementSibling.dataset.previewKind === "payload"
        ? internalButton.nextElementSibling
        : null;
    const anchorElement = payloadPreviewButton || internalButton;
    const existingButton = document.querySelector(`.${PREVIEW_BUTTON_CLASS}[data-preview-kind="source"]`);

    if (existingButton?.previousElementSibling === anchorElement) {
      return;
    }

    existingButton?.remove();
    anchorElement.insertAdjacentElement(
      "afterend",
      createPreviewButton(internalButton, {
        kind: "source",
        title: "Preview message source",
        onClick: () => {
          void previewMessageSourceDirectly();
        },
      }),
    );
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
          onClick: () => {
            triggerAttachmentPreview(attachmentLink);
          },
        }),
      );
    });
  }

  function observePayloadButtons() {
    ensurePayloadPreviewButtons();
    ensureMessageSourceButton();
    ensureAttachmentPreviewButtons();

    const observer = new MutationObserver(() => {
      ensurePayloadPreviewButtons();
      ensureMessageSourceButton();
      ensureAttachmentPreviewButtons();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(() => {
      ensurePayloadPreviewButtons();
      ensureMessageSourceButton();
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

      const adjustedUrl = previewInfo.kind === "payload" ? adjustDownloadUrl(requestUrl) : requestUrl;
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
              meta: `Captured a generated blob (${blob.type || "application/octet-stream"})${formatFileSize(blob.size) ? ` | Size: ${formatFileSize(blob.size)}` : ""}.`,
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
