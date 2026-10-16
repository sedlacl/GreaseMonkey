// ==UserScript==
// @name         IndSoft JIRA - Attachment preview
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.0.2
// @description  Adds a "Náhled" eye button to supported issue attachments (HTML, text, images, PDF) and opens the file in a reloadable new tab; HTML runs in a sandboxed frame.
// @author       Lukáš Sedláček
// @match        *://jira.indsoft.local/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jira-attachment-preview.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jira-attachment-preview.user.js
// ==/UserScript==

(function factory(rootFactory) {
  const api = rootFactory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    api.run();
  }
})(function createJiraAttachmentPreviewApi() {
  "use strict";

  const SCRIPT_FLAG = "__gmJiraAttachmentPreview";
  const SCRIPT_VERSION = "1.0.2";
  const STYLE_ID = "gm-jira-attachment-preview-style";
  const BUTTON_CLASS = "gm-jap-btn";
  const OVERLAY_CLASS = "gm-jap-overlay";
  const OVERLAY_HOST_CLASS = "gm-jap-host";
  const MODULE_SELECTOR = "#attachmentmodule";
  const THUMBNAILS_SELECTOR = "#attachment_thumbnails";
  const ATTACHMENT_LINK_SELECTOR = 'a.attachment-title[href*="/secure/attachment/"], dt a[href*="/secure/attachment/"]';
  const PREVIEW_PARAM = "viewAttachment";
  const PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;
  const SANDBOX_TOKENS = Object.freeze(["allow-scripts", "allow-popups", "allow-forms", "allow-modals", "allow-downloads"]);

  const TEXT_TOO_LARGE = "Příloha je větší než 10 MB, náhled se neotevře.";
  const TEXT_LOAD_FAILED = "Přílohu se nepodařilo načíst.";
  const TEXT_UNSUPPORTED = "Tento typ přílohy náhled nemá.";
  const TEXT_LOADING = "Načítám přílohu…";
  const TEXT_DEFAULT_TITLE = "Náhled přílohy";

  const EXTENSION_KINDS = buildLookup({
    html: ["html", "htm"],
    text: [
      "txt", "log", "csv", "tsv", "sql", "xml", "json", "jsonl", "ndjson", "md", "markdown", "yml", "yaml",
      "ini", "conf", "properties", "css", "js", "mjs", "cjs", "ts", "sh", "ps1", "bat", "py", "java", "cs",
      "diff", "patch", "toml",
    ],
    image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"],
    pdf: ["pdf"],
  });

  const MIME_KINDS = buildLookup({
    html: ["text/html"],
    text: [
      "text/plain", "text/csv", "text/xml", "text/markdown", "text/css", "text/javascript", "application/json",
      "application/xml", "application/javascript", "application/x-sql", "text/x-sql",
    ],
    pdf: ["application/pdf"],
  });

  const IMAGE_TYPES_BY_EXTENSION = Object.freeze({
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
  });

  function buildLookup(groups) {
    const lookup = new Map();
    for (const [kind, keys] of Object.entries(groups)) {
      for (const key of keys) {
        lookup.set(key, kind);
      }
    }
    return lookup;
  }

  function fileExtension(filename) {
    const name = String(filename ?? "").trim();
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  }

  function essenceOfMimeType(mimeType) {
    return String(mimeType ?? "").split(";")[0].trim().toLowerCase();
  }

  function charsetOfMimeType(mimeType) {
    const match = String(mimeType ?? "").match(/;\s*charset\s*=\s*"?([^";\s]+)"?/iu);
    return match ? match[1] : "";
  }

  function classifyAttachment({ filename, mimeType } = {}) {
    const byExtension = EXTENSION_KINDS.get(fileExtension(filename));
    if (byExtension) {
      return byExtension;
    }
    const essence = essenceOfMimeType(mimeType);
    if (MIME_KINDS.has(essence)) {
      return MIME_KINDS.get(essence);
    }
    if (essence.startsWith("image/")) {
      return "image";
    }
    return null;
  }

  function isWithinPreviewLimit(byteLength) {
    return Number.isFinite(byteLength) && byteLength >= 0 && byteLength <= PREVIEW_LIMIT_BYTES;
  }

  function sandboxAttribute() {
    return SANDBOX_TOKENS.join(" ");
  }

  function formatJsonPreview(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  function shouldFormatJson({ filename, mimeType }) {
    return fileExtension(filename) === "json" || essenceOfMimeType(mimeType) === "application/json";
  }

  /** Absolute attachment URL on the page origin over http(s), or null. */
  function resolvePreviewUrl(href, pageHref) {
    try {
      const page = new URL(pageHref);
      const target = new URL(href, page);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return null;
      }
      return target.origin === page.origin ? target.href : null;
    } catch {
      return null;
    }
  }

  function filenameFromUrl(href) {
    try {
      const segment = new URL(href).pathname.split("/").filter(Boolean).pop() ?? "";
      return decodeURIComponent(segment);
    } catch {
      return "";
    }
  }

  function attachmentIdFromHref(href) {
    const match = String(href ?? "").match(/\/secure\/attachment\/(\d+)(?:\/|$)/u);
    return match ? match[1] : "";
  }

  /** Attachment id from the preview tab's query string; only plain digits are accepted. */
  function previewAttachmentId(search) {
    const value = new URLSearchParams(String(search ?? "")).get(PREVIEW_PARAM) ?? "";
    return /^\d{1,18}$/u.test(value) ? value : "";
  }

  /** Reloadable address of the preview tab: the issue page with ?viewAttachment=<id>. */
  function previewPageUrl({ origin, issueKey, pathname, attachmentId }) {
    const key = /^[A-Z][A-Z0-9_]*-\d+$/iu.test(String(issueKey ?? "")) ? issueKey.toUpperCase() : "";
    const path = key ? `/browse/${key}` : pathname || "/";
    return `${origin}${path}?${PREVIEW_PARAM}=${encodeURIComponent(attachmentId)}`;
  }

  /** Same-origin download path built from the id and file name, never taken from the URL. */
  function attachmentContentPath(attachmentId, filename) {
    return `/secure/attachment/${encodeURIComponent(attachmentId)}/${encodeURIComponent(filename)}`;
  }

  /** Jira puts "mime:filename:url" into data-downloadurl on each attachment item. */
  function mimeTypeFromDownloadUrl(value) {
    const raw = String(value ?? "");
    const colon = raw.indexOf(":");
    return colon > 0 ? raw.slice(0, colon) : "";
  }

  function decodeText(bytes, mimeType) {
    const charset = charsetOfMimeType(mimeType) || "utf-8";
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }

  // --- issue page: eye buttons ---------------------------------------------

  const EYE_ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M12 5C6.5 5 2.7 9.1 1.5 12c1.2 2.9 5 7 10.5 7s9.3-4.1 10.5-7C21.3 9.1 17.5 5 12 5zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>' +
    "</svg>";

  const PAGE_CSS = `
    .${BUTTON_CLASS} {
      display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
      width: 22px; height: 22px; margin: 0 0 0 4px; padding: 0; border-radius: 3px;
      color: #42526e; background: transparent; vertical-align: middle; text-decoration: none;
    }
    .${BUTTON_CLASS} svg { width: 16px; height: 16px; }
    .${BUTTON_CLASS}:hover, .${BUTTON_CLASS}:focus { color: #0052cc; background: rgba(9, 30, 66, 0.08); text-decoration: none; }
    .${BUTTON_CLASS}:focus-visible { outline: 2px solid #4c9aff; outline-offset: 1px; }
    .${OVERLAY_HOST_CLASS} { position: relative !important; }
    /* Jira styles every link in the tile (.attachment-thumb a), so the overlay pins its own box. */
    .${OVERLAY_HOST_CLASS} > a.${BUTTON_CLASS}.${OVERLAY_CLASS} {
      display: inline-flex !important; position: absolute !important; top: 8px !important; right: 8px !important;
      left: auto !important; bottom: auto !important; z-index: 2; margin: 0 !important; padding: 0 !important;
      width: 44px !important; height: 44px !important; border-radius: 50%;
      background: rgba(255, 255, 255, 0.92); box-shadow: 0 1px 3px rgba(9, 30, 66, 0.35);
    }
    .${OVERLAY_HOST_CLASS} > a.${BUTTON_CLASS}.${OVERLAY_CLASS} svg { width: 32px !important; height: 32px !important; }
    .${OVERLAY_HOST_CLASS} > a.${BUTTON_CLASS}.${OVERLAY_CLASS}:hover,
    .${OVERLAY_HOST_CLASS} > a.${BUTTON_CLASS}.${OVERLAY_CLASS}:focus { background: #fff; }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function currentIssueKey() {
    const fromMeta = document.querySelector('meta[name="ajs-issue-key"]')?.getAttribute("content");
    const fromHeader = document.querySelector("#key-val")?.textContent;
    const fromPath = location.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]*-\d+)/iu)?.[1];
    return [fromMeta, fromHeader, fromPath].map((value) => String(value ?? "").trim()).find(Boolean) || "";
  }

  function attachmentInfo(link) {
    const url = resolvePreviewUrl(link.getAttribute("href"), location.href);
    const attachmentId = url ? attachmentIdFromHref(new URL(url).pathname) : "";
    if (!attachmentId) {
      return null;
    }
    const filename = (link.textContent || "").trim() || filenameFromUrl(url);
    const item = link.closest("li.attachment-content, li[data-attachment-id], li");
    const mimeType = mimeTypeFromDownloadUrl(item?.getAttribute("data-downloadurl"));
    if (!classifyAttachment({ filename, mimeType })) {
      return null;
    }
    // In the thumbnail view the eye sits over the preview tile, in the list view right after the name.
    const thumb = link.closest(THUMBNAILS_SELECTOR) ? item?.querySelector(".attachment-thumb") : null;
    return { attachmentId, filename, item, thumb };
  }

  function createButton(info) {
    const button = document.createElement("a");
    button.className = info.thumb ? `${BUTTON_CLASS} ${OVERLAY_CLASS}` : BUTTON_CLASS;
    button.href = previewPageUrl({
      origin: location.origin,
      issueKey: currentIssueKey(),
      pathname: location.pathname,
      attachmentId: info.attachmentId,
    });
    button.target = "_blank";
    button.rel = "noopener";
    button.draggable = false;
    button.title = `Náhled: ${info.filename}`;
    button.setAttribute("aria-label", `Náhled: ${info.filename}`);
    button.innerHTML = EYE_ICON_SVG;
    // Keep Jira's own handlers on the tile (file viewer, drag) away from the eye.
    button.addEventListener("click", (event) => event.stopPropagation());
    return button;
  }

  function isPlaced(button, link, info) {
    return info.thumb ? button.parentElement === info.thumb : button.previousElementSibling === link;
  }

  function decorateLink(link) {
    const info = attachmentInfo(link);
    const scope = info?.item || link.parentElement;
    if (!info || !scope) {
      return;
    }
    const existing = scope.querySelectorAll(`.${BUTTON_CLASS}`);
    if (existing.length === 1 && isPlaced(existing[0], link, info)) {
      return;
    }
    existing.forEach((button) => button.remove());
    const button = createButton(info);
    if (info.thumb) {
      info.thumb.classList.add(OVERLAY_HOST_CLASS);
      info.thumb.appendChild(button);
    } else {
      link.insertAdjacentElement("afterend", button);
    }
  }

  function titleLinks(module) {
    const links = new Set();
    for (const link of module.querySelectorAll(ATTACHMENT_LINK_SELECTOR)) {
      const item = link.closest("li") || link.parentElement;
      const title = item?.querySelector('a.attachment-title[href*="/secure/attachment/"]');
      links.add(title || link);
    }
    return links;
  }

  function scan() {
    const module = document.querySelector(MODULE_SELECTOR);
    if (!module) {
      return;
    }
    ensureStyle();
    titleLinks(module).forEach(decorateLink);
  }

  function runIssuePage() {
    let scheduled = false;
    const schedule = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        scan();
      }, 100);
    };

    schedule();
    // At document-start <html> may not exist yet, so watch the document itself.
    // Our own insertions trigger one more scan, which finds nothing to change and adds nothing.
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  }

  // --- preview tab: <issue>?viewAttachment=<id> ------------------------------

  const PREVIEW_CSS = `
    html, body { margin: 0; height: 100%; background: #fff; color: #172b4d;
      font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .gm-jap-message { margin: 0; padding: 24px; }
    .gm-jap-pre { margin: 0; padding: 16px; white-space: pre-wrap; word-break: break-word;
      font: 13px/1.5 Consolas, "SFMono-Regular", Menlo, monospace; }
    .gm-jap-image { display: flex; align-items: center; justify-content: center; min-height: 100%;
      box-sizing: border-box; padding: 16px; background: #f4f5f7; }
    .gm-jap-image img { max-width: 100%; height: auto; background: #fff; }
    /* The frame's color-scheme is what prefers-color-scheme reports inside it: follow the system theme. */
    .gm-jap-frame { display: block; width: 100%; height: 100%; border: 0; color-scheme: light dark; }
  `;

  const ownNodes = new WeakSet();

  function own(node) {
    ownNodes.add(node);
    return node;
  }

  /**
   * Tampermonkey may inject only after Jira's head scripts ran. Their ready/load handlers and timers
   * would write into our page (banners, dialogs), so the events stop here and foreign nodes go.
   */
  function shieldFromJira(doc) {
    const swallow = (event) => event.stopImmediatePropagation();
    for (const type of ["readystatechange", "DOMContentLoaded", "load"]) {
      window.addEventListener(type, swallow, true);
    }
    const sweep = (records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => ownNodes.has(node) || node.remove());
      }
    };
    const observer = new MutationObserver(sweep);
    for (const target of [doc.documentElement, doc.head, doc.body]) {
      observer.observe(target, { childList: true });
    }
  }

  /**
   * Swaps the Jira issue page for an empty document of our own. The parser keeps going into the
   * detached old <html>: scripts outside the document never run and its stylesheets block nothing.
   * No window.stop(): it aborts the parser before <body> and Chrome then never paints the tab.
   */
  function takeOverDocument() {
    const doc = document;
    const root = own(doc.createElement("html"));
    root.lang = "cs";
    const head = own(doc.createElement("head"));
    const charset = own(doc.createElement("meta"));
    charset.setAttribute("charset", "utf-8");
    const title = own(doc.createElement("title"));
    const style = own(doc.createElement("style"));
    style.textContent = PREVIEW_CSS;
    head.append(charset, title, style);
    root.append(head, own(doc.createElement("body")));
    if (doc.documentElement) {
      doc.replaceChild(root, doc.documentElement);
    } else {
      doc.appendChild(root);
    }
    shieldFromJira(doc);
    doc.title = TEXT_DEFAULT_TITLE;
    showMessage(doc, TEXT_LOADING);
    return doc;
  }

  function replaceBody(doc, node) {
    doc.body.replaceChildren(own(node));
  }

  function showMessage(doc, text) {
    const message = doc.createElement("p");
    message.className = "gm-jap-message";
    message.textContent = text;
    replaceBody(doc, message);
  }

  async function readLimited(response) {
    const declared = Number(response.headers.get("content-length"));
    if (response.headers.has("content-length") && Number.isFinite(declared)) {
      if (!isWithinPreviewLimit(declared)) {
        response.body?.cancel().catch(() => {});
        return null;
      }
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      const buffer = await response.arrayBuffer();
      return isWithinPreviewLimit(buffer.byteLength) ? new Uint8Array(buffer) : null;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (!isWithinPreviewLimit(total)) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  function renderHtml(doc, text) {
    const frame = doc.createElement("iframe");
    frame.className = "gm-jap-frame";
    frame.setAttribute("sandbox", sandboxAttribute());
    frame.setAttribute("title", doc.title);
    frame.srcdoc = text;
    replaceBody(doc, frame);
  }

  function renderText(doc, text) {
    const pre = doc.createElement("pre");
    pre.className = "gm-jap-pre";
    pre.appendChild(doc.createTextNode(text));
    replaceBody(doc, pre);
  }

  function renderImage(doc, bytes, filename, mimeType) {
    const type = IMAGE_TYPES_BY_EXTENSION[fileExtension(filename)] || essenceOfMimeType(mimeType) || "image/png";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const wrapper = doc.createElement("div");
    wrapper.className = "gm-jap-image";
    const image = doc.createElement("img");
    image.alt = filename;
    image.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    image.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      showMessage(doc, TEXT_LOAD_FAILED);
    }, { once: true });
    image.src = url;
    wrapper.appendChild(image);
    replaceBody(doc, wrapper);
  }

  /** The built-in PDF viewer in a frame; the tab keeps its own address, so reload works. */
  function renderPdf(doc, bytes) {
    const frame = doc.createElement("iframe");
    frame.className = "gm-jap-frame";
    frame.setAttribute("title", doc.title);
    frame.src = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    replaceBody(doc, frame);
  }

  async function fetchAttachmentMeta(attachmentId) {
    const response = await fetch(`/rest/api/2/attachment/${encodeURIComponent(attachmentId)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const meta = await response.json();
    const filename = String(meta?.filename ?? "").trim();
    return filename ? { filename, mimeType: String(meta.mimeType ?? ""), size: Number(meta.size) } : null;
  }

  async function runPreviewPage(attachmentId) {
    const doc = takeOverDocument();
    try {
      const meta = await fetchAttachmentMeta(attachmentId);
      if (!meta) {
        showMessage(doc, TEXT_LOAD_FAILED);
        return;
      }
      doc.title = meta.filename;
      if (!classifyAttachment(meta)) {
        showMessage(doc, TEXT_UNSUPPORTED);
        return;
      }
      if (Number.isFinite(meta.size) && !isWithinPreviewLimit(meta.size)) {
        showMessage(doc, TEXT_TOO_LARGE);
        return;
      }

      const response = await fetch(attachmentContentPath(attachmentId, meta.filename), { credentials: "same-origin" });
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        showMessage(doc, TEXT_LOAD_FAILED);
        return;
      }
      const bytes = await readLimited(response);
      if (!bytes) {
        showMessage(doc, TEXT_TOO_LARGE);
        return;
      }
      const mimeType = response.headers.get("content-type") || meta.mimeType;
      const kind = classifyAttachment({ filename: meta.filename, mimeType }) || classifyAttachment(meta);
      if (kind === "pdf") {
        renderPdf(doc, bytes);
      } else if (kind === "image") {
        renderImage(doc, bytes, meta.filename, mimeType);
      } else {
        const text = decodeText(bytes, mimeType);
        if (kind === "html") {
          renderHtml(doc, text);
        } else {
          renderText(doc, shouldFormatJson({ filename: meta.filename, mimeType }) ? formatJsonPreview(text) : text);
        }
      }
    } catch (error) {
      console.warn("[jira-attachment-preview] preview failed", error);
      showMessage(doc, TEXT_LOAD_FAILED);
    }
  }

  // --- bootstrap ----------------------------------------------------------

  function run() {
    if (window[SCRIPT_FLAG]) {
      return;
    }
    window[SCRIPT_FLAG] = true;

    const attachmentId = previewAttachmentId(location.search);
    if (attachmentId) {
      runPreviewPage(attachmentId);
    } else {
      runIssuePage();
    }
  }

  return {
    classifyAttachment,
    isWithinPreviewLimit,
    sandboxAttribute,
    formatJsonPreview,
    shouldFormatJson,
    resolvePreviewUrl,
    filenameFromUrl,
    mimeTypeFromDownloadUrl,
    charsetOfMimeType,
    decodeText,
    attachmentIdFromHref,
    previewAttachmentId,
    previewPageUrl,
    attachmentContentPath,
    PREVIEW_LIMIT_BYTES,
    SCRIPT_VERSION,
    run,
  };
});
