// ==UserScript==
// @name         uuBookKit Fulltext Search
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.5.7
// @description  Adds a cached fulltext search for uuBookKit pages and sections using BookKit JSON commands.
// @author       Lukáš Sedláček
// @match        *://*/uu-bookkit-maing01/*
// @grant        none
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/minisearch@7.1.2/dist/umd/index.min.js
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/bookkit-fulltext-search.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/bookkit-fulltext-search.user.js
// ==/UserScript==

(function factory(rootFactory) {
  const api = rootFactory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    api.run();
  }
})(function createBookKitFulltextApi() {
  "use strict";

  const SCRIPT_FLAG = "__gmBookKitFulltextSearch";
  const STYLE_ID = "gm-bookkit-fulltext-style";
  const MODAL_ID = "gm-bookkit-fulltext-modal";
  const TRIGGER_ID = "gm-bookkit-fulltext-trigger";
  const TRIGGERS_WRAP_ID = "gm-bookkit-fulltext-triggers";
  const NAV_TRIGGER_ID = "gm-bookkit-fulltext-nav-trigger";
  const NAV_MENU_ID = "gm-bookkit-fulltext-nav-menu";
  const DB_NAME = "gm-bookkit-fulltext";
  const DB_VERSION = 1;
  const BOOKS_STORE = "books";
  const INDEXES_STORE = "indexes";
  const INDEX_STALE_MS = 24 * 60 * 60 * 1000;
  const FRESHNESS_PROBE_MS = 5 * 60 * 1000;
  const INDEX_CONCURRENCY = 4;
  const BOOKKIT_MATCHER = /^(https?:\/\/[^/]+\/uu-bookkit-maing01\/([a-z0-9]{32}))(?:\/book\/(?:page\?code=([^&#]+)|intro)|\/?.*)?$/iu;
  const SEARCHABLE_ATTRIBUTE_PATTERN = /\b(?:header|content|label|value|title|alt|name|subtitle|description|text|code)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
  const UU5STRING_ATTRIBUTE_PATTERN = /\buu5string\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/giu;
  const STRUCTURED_DATA_ATTRIBUTE_PATTERN = /\bdata\s*=\s*"((?:[^"\\]|\\.)*)"/giu;
  const COMPONENT_NOISE_PATTERN =
    /\b(?:uu5string|UU5(?:\.[A-Za-z0-9_]+)+|Uu5(?:\.[A-Za-z0-9_]+)+|Plus4U5(?:\.[A-Za-z0-9_]+)+|UuDcc(?:\.[A-Za-z0-9_]+)+|UuBookKit(?:\.[A-Za-z0-9_]+)+|UuContentKit(?:\.[A-Za-z0-9_]+)+|UuTerritory(?:\.[A-Za-z0-9_]+)+)\b/gu;
  const IGNORED_STRUCTURED_DATA_KEYS = new Set(["id", "type", "customIcon", "colorSchema", "nestingLevel", "uuIdentity", "target", "rel"]);
  // #region agent log
  function dbg(location, message, data, hypothesisId) {
    fetch("http://127.0.0.1:7800/ingest/e8ee066a-71cc-4312-958f-727626369721", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "186a15" },
      body: JSON.stringify({ sessionId: "186a15", location, message, data, hypothesisId, timestamp: Date.now() }),
    }).catch(() => {});
  }
  // #endregion
  const KNOWN_BOOKS = Object.freeze([
    {
      bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3",
      baseUri: "https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3",
      awid: "10b5c8ef37b74c11a7a4d7e566ec00b3",
      title: "IDS Maintenance - Documentation",
      known: true,
    },
    {
      bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/e3f5c648e85f4319bd8fc25ea5be6c2c",
      baseUri: "https://uuapp.plus4u.net/uu-bookkit-maing01/e3f5c648e85f4319bd8fc25ea5be6c2c",
      awid: "e3f5c648e85f4319bd8fc25ea5be6c2c",
      title: "uuBookKit Documentation",
      known: true,
    },
  ]);

  function pickLabel(labelMap) {
    if (!labelMap) return "";
    if (typeof labelMap === "string") return labelMap.trim();
    return String(labelMap.cs || labelMap.en || labelMap.cz || Object.values(labelMap)[0] || "").trim();
  }

  function parseBookContextFromUrl(inputUrl) {
    const value = String(inputUrl || "");
    const match = value.match(BOOKKIT_MATCHER);
    if (!match) return null;

    const origin = new URL(value).origin;
    const baseUri = match[1];
    const awid = match[2];
    const pageCode = match[3] ? decodeURIComponent(match[3]) : value.includes("/book/intro") ? "intro" : "home";

    return {
      origin,
      awid,
      baseUri,
      pageCode,
      bookId: baseUri,
    };
  }

  function decodeHtmlEntities(value) {
    const text = String(value || "");
    if (!text) return "";

    if (typeof document !== "undefined" && document.createElement) {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = text;
      return textarea.value;
    }

    return text
      .replaceAll("&nbsp;", " ")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'");
  }

  function normalizeWhitespace(value) {
    return String(value || "")
      .replace(/\u00a0/gu, " ")
      .replace(/[ \t\r\f\v]+/gu, " ")
      .replace(/\n{3,}/gu, "\n\n")
      .replace(/[ \t]*\n[ \t]*/gu, "\n")
      .trim();
  }

  function stripTechnicalNoise(value) {
    return normalizeWhitespace(
      String(value || "")
        .replace(COMPONENT_NOISE_PATTERN, " ")
        .replace(/\b(?:props|children|tagName|className|uuId)\b/gu, " "),
    );
  }

  function stripEscapedJsonNoise(value) {
    return String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (line.includes('\\"')) return false;
        if (/^[\[\]{}:,"]+$/u.test(line)) return false;
        if (/^\/?>$/u.test(line)) return false;
        return true;
      })
      .join("\n");
  }

  function extractAttributeValues(markup) {
    const values = [];
    const text = String(markup || "");
    let match;
    while ((match = SEARCHABLE_ATTRIBUTE_PATTERN.exec(text)) !== null) {
      const raw = match[1] ?? match[2] ?? "";
      const cleaned = stripTechnicalNoise(decodeHtmlEntities(raw));
      if (cleaned) values.push(cleaned);
    }
    return values;
  }

  function decodeEscapedAttributeValue(value) {
    return decodeHtmlEntities(String(value || ""))
      .replace(/\\\\/gu, "\\")
      .replace(/\\n/gu, "\n")
      .replace(/\\t/gu, "\t")
      .replace(/\\"/gu, '"')
      .replace(/\\'/gu, "'");
  }

  function collectStructuredDataValues(value, sourceKey = "") {
    if (Array.isArray(value)) {
      return value.flatMap((item) => collectStructuredDataValues(item, sourceKey));
    }

    if (value && typeof value === "object") {
      return Object.entries(value).flatMap(([nestedKey, nestedValue]) => {
        if (IGNORED_STRUCTURED_DATA_KEYS.has(nestedKey)) return [];
        return collectStructuredDataValues(nestedValue, nestedKey);
      });
    }

    if (typeof value !== "string") {
      return [];
    }

    const decodedValue = decodeHtmlEntities(value);
    const cleanedValue = decodedValue.includes("<")
      ? stripTechnicalNoise(collectTextNodesFromHtml(decodedValue, { includeStructuredData: false }))
      : stripTechnicalNoise(decodedValue);

    if (!cleanedValue || /^https?:\/\//iu.test(cleanedValue)) {
      return [];
    }

    if (sourceKey === "code" && cleanedValue.length > 4000) {
      return [];
    }

    return [cleanedValue];
  }

  function extractStructuredDataText(markup) {
    const text = String(markup || "");
    const values = [];
    let match;

    while ((match = STRUCTURED_DATA_ATTRIBUTE_PATTERN.exec(text)) !== null) {
      const decodedValue = decodeEscapedAttributeValue(match[1]).trim();
      const jsonText = decodedValue.replace(/^<uu5json\s*\/>\s*/iu, "").trim();
      if (!jsonText || !/^[\[{]/u.test(jsonText)) continue;

      try {
        const parsed = JSON.parse(jsonText);
        values.push(...collectStructuredDataValues(parsed));
      } catch {
        // Ignore malformed structured payloads and keep plain-text extraction as fallback.
      }
    }

    return values;
  }

  function expandUu5StringAttributes(markup) {
    let expanded = String(markup || "");

    for (let pass = 0; pass < 10; pass += 1) {
      let changed = false;
      expanded = expanded.replace(UU5STRING_ATTRIBUTE_PATTERN, (_full, doubleQuoted, singleQuoted) => {
        changed = true;
        return (
          decodeEscapedAttributeValue(doubleQuoted ?? singleQuoted ?? "")
            .replace(/^<uu5string\s*\/?>/giu, "")
            .trim() || " "
        );
      });
      if (!changed) break;
    }

    return expanded;
  }

  function collectTextNodesFromHtml(markup, options = {}) {
    const html = expandUu5StringAttributes(markup);
    if (!html) return "";

    const structuredDataChunks = options.includeStructuredData === false ? [] : extractStructuredDataText(html);

    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${html.replace(/<uu5string\s*\/?>/giu, "")}</div>`, "text/html");
      const skipTags = new Set(["SCRIPT", "STYLE"]);
      const chunks = [];

      (function walk(node) {
        if (!node) return;
        if (node.nodeType === 3) {
          const textContent = normalizeWhitespace(node.textContent || "");
          if (textContent) chunks.push(textContent);
          return;
        }

        if (node.nodeType !== 1) return;
        if (skipTags.has(node.tagName)) return;

        for (const attribute of Array.from(node.attributes || [])) {
          if (/^uu5string$/iu.test(attribute.name)) continue;
          if (!/^(?:header|content|label|value|title|alt|name|subtitle|description|text|code)$/iu.test(attribute.name)) continue;
          const attributeValue = stripTechnicalNoise(decodeHtmlEntities(attribute.value));
          if (attributeValue) chunks.push(attributeValue);
        }

        for (const child of Array.from(node.childNodes || [])) {
          walk(child);
        }
      })(doc.body);

      return [...structuredDataChunks, ...chunks].filter(Boolean).join("\n");
    }

    const attributeText = extractAttributeValues(html).join("\n");
    const plainText = decodeHtmlEntities(
      html
        .replace(/<uu5string\s*\/?>/giu, " ")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
        .replace(/<[^>]+>/gu, " "),
    );

    return [...structuredDataChunks, attributeText, plainText].filter(Boolean).join("\n");
  }

  function extractSearchText(markup) {
    const text = collectTextNodesFromHtml(markup);
    return stripTechnicalNoise(stripEscapedJsonNoise(text));
  }

  function parseBookTitleFromDocumentTitle(documentTitle) {
    const title = String(documentTitle || "").trim();
    if (!title) return "";

    const withoutAppSuffix = title.replace(/\s*-\s*uuBookKit\s*$/iu, "").trim();
    const firstSeparator = withoutAppSuffix.indexOf(" - ");
    if (firstSeparator === -1) return withoutAppSuffix;

    return withoutAppSuffix.slice(firstSeparator + 3).trim() || withoutAppSuffix;
  }

  function isGenericBookTitle(title) {
    const normalized = String(title || "")
      .trim()
      .toLocaleLowerCase("cs");
    if (!normalized) return true;
    if (["uuBookKit", "page", "intro", "home", "welcome"].includes(normalized)) return true;
    if (/^welcome\b/u.test(normalized)) return true;
    if (/^vítej/u.test(normalized)) return true;
    return false;
  }

  function pickBetterBookTitle(existingTitle, nextTitle) {
    const existing = String(existingTitle || "").trim();
    const next = String(nextTitle || "").trim();
    if (!existing) return next;
    if (!next) return existing;

    const existingGeneric = isGenericBookTitle(existing);
    const nextGeneric = isGenericBookTitle(next);
    if (existingGeneric && !nextGeneric) return next;
    if (!existingGeneric && nextGeneric) return existing;
    if (next.length > existing.length) return next;
    return existing;
  }

  function getCurrentBookTitle() {
    const fromDom = document.querySelector(".uu-bookkit-book-top-text")?.textContent?.trim();
    if (fromDom && !isGenericBookTitle(fromDom)) {
      return fromDom;
    }

    const fromDocumentTitle = parseBookTitleFromDocumentTitle(document.title);
    if (fromDocumentTitle && !isGenericBookTitle(fromDocumentTitle)) {
      return fromDocumentTitle;
    }

    return fromDom || fromDocumentTitle || "uuBookKit";
  }

  function resolveBookTitle(book, context) {
    if (context?.bookId === book?.bookId) {
      const liveTitle = getCurrentBookTitle();
      if (!isGenericBookTitle(liveTitle)) {
        return liveTitle;
      }
    }

    if (!isGenericBookTitle(book?.title)) {
      return book.title;
    }

    const knownBook = KNOWN_BOOKS.find((entry) => entry.bookId === book?.bookId);
    if (knownBook?.title && !isGenericBookTitle(knownBook.title)) {
      return knownBook.title;
    }

    return book?.title || book?.baseUri || "";
  }

  function extractBookTitleFromBookDto(dto) {
    const data = dto?.data || dto?.body || dto;
    return pickLabel(data?.name) || "";
  }

  function mergeBookRegistries(seedBooks, runtimeBooks) {
    const merged = new Map();

    for (const book of [...(seedBooks || []), ...(runtimeBooks || [])]) {
      if (!book || !book.bookId) continue;
      const existing = merged.get(book.bookId) || {};
      const next = {
        ...existing,
        ...book,
        bookId: book.bookId,
        baseUri: book.baseUri || existing.baseUri || book.bookId,
        awid: book.awid || existing.awid || parseBookContextFromUrl(book.baseUri || book.bookId)?.awid || "",
        title: pickBetterBookTitle(existing.title, book.title),
      };

      if (existing.known || book.known) next.known = true;
      if (existing.seed || book.seed) next.seed = true;
      merged.set(next.bookId, next);
    }

    return Array.from(merged.values()).sort((a, b) => {
      const byKnown = Number(Boolean(b.known)) - Number(Boolean(a.known));
      if (byKnown !== 0) return byKnown;
      const byIndexed = Number(Boolean(b.lastIndexedAt)) - Number(Boolean(a.lastIndexedAt));
      if (byIndexed !== 0) return byIndexed;
      return String(a.title || a.baseUri).localeCompare(String(b.title || b.baseUri), "cs");
    });
  }

  function createPageListFromStructure(structure, baseUri) {
    const itemMap = structure?.itemMap || {};
    const rootEntry = Object.entries(itemMap).find(([, item]) => !item?.previous);
    if (!rootEntry) return [];

    const pages = [];
    const pathByIndent = new Map();
    const codeByIndent = new Map();
    let currentCode = rootEntry[0];

    while (currentCode) {
      const item = itemMap[currentCode];
      if (!item) break;

      const indent = Number.isFinite(item.indent) ? item.indent : 0;
      const title = pickLabel(item.label) || currentCode;
      const parentPath = indent > 0 ? pathByIndent.get(indent - 1) || "" : "";
      const path = `${parentPath}/${title}`.replace(/\/+/gu, "/");
      const parents = [];

      for (let level = 0; level < indent; level += 1) {
        if (codeByIndent.has(level)) {
          parents.push(codeByIndent.get(level));
        }
      }

      pathByIndent.set(indent, path);
      codeByIndent.set(indent, currentCode);

      for (const key of Array.from(pathByIndent.keys())) {
        if (key > indent) pathByIndent.delete(key);
      }
      for (const key of Array.from(codeByIndent.keys())) {
        if (key > indent) codeByIndent.delete(key);
      }

      pages.push({
        ...item,
        code: currentCode,
        title,
        path,
        parents,
        url: `${baseUri}/book/page?code=${encodeURIComponent(currentCode)}`,
      });

      currentCode = item.next || "";
    }

    return pages;
  }

  function computeStructureSignature(structure) {
    const itemMap = structure?.itemMap || {};
    return Object.keys(itemMap)
      .sort()
      .map((code) => {
        const item = itemMap[code] || {};
        const label =
          item.label && typeof item.label === "object"
            ? Object.keys(item.label)
                .sort()
                .map((key) => `${key}:${pickLabel({ [key]: item.label[key] }) || item.label[key]}`)
                .join("|")
            : String(item.label || "");
        return `${code}\t${item.previous || ""}\t${item.next || ""}\t${item.indent ?? ""}\t${label}`;
      })
      .join("\n");
  }

  function hashFingerprint(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  function fingerprintStructure(structure) {
    return hashFingerprint(computeStructureSignature(structure));
  }

  function normalizeLoadPageBody(loadPageResult) {
    if (Array.isArray(loadPageResult)) return loadPageResult;
    if (Array.isArray(loadPageResult?.body)) return loadPageResult.body;
    if (Array.isArray(loadPageResult?.data?.body)) return loadPageResult.data.body;
    if (Array.isArray(loadPageResult?.dtoOut?.body)) return loadPageResult.dtoOut.body;
    return [];
  }

  function createSearchDocuments(book, page, loadPageResult) {
    const body = normalizeLoadPageBody(loadPageResult);
    const documents = [];

    body.forEach((section, sectionIndex) => {
      const rawContent = section?.content || section?.uu5String || section?.text || "";
      const searchText = extractSearchText(rawContent);
      if (!searchText) return;

      const sectionTitle = pickLabel(section?.label) || stripTechnicalNoise(decodeHtmlEntities(section?.header || section?.name || section?.title || ""));
      const excerpt = normalizeWhitespace(searchText.split("\n").join(" ")).slice(0, 220);

      documents.push({
        id: `${book.bookId}::${page.code}::${section?.id || sectionIndex}`,
        bookId: book.bookId,
        baseUri: book.baseUri,
        pageCode: page.code,
        pageTitle: page.title,
        path: page.path,
        sectionId: section?.id || String(sectionIndex),
        sectionTitle,
        excerpt,
        text: searchText,
        url: `${book.baseUri}/book/page?code=${encodeURIComponent(page.code)}`,
      });
    });

    if (!documents.length) {
      const fallbackText = extractSearchText(loadPageResult?.content || "");
      if (fallbackText) {
        documents.push({
          id: `${book.bookId}::${page.code}::fallback`,
          bookId: book.bookId,
          baseUri: book.baseUri,
          pageCode: page.code,
          pageTitle: page.title,
          path: page.path,
          sectionId: "fallback",
          sectionTitle: "",
          excerpt: normalizeWhitespace(fallbackText.split("\n").join(" ")).slice(0, 220),
          text: fallbackText,
          url: `${book.baseUri}/book/page?code=${encodeURIComponent(page.code)}`,
        });
      }
    }

    return documents;
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function getCandidateAccessTokens() {
    if (typeof window === "undefined" || !window.sessionStorage) return [];

    const candidates = new Set();
    const addToken = (token) => {
      if (typeof token !== "string") return;
      const trimmed = token.trim();
      if (trimmed.length < 20) return;
      if (!/^[A-Za-z0-9\-_=]+(?:\.[A-Za-z0-9\-_=]+){1,2}$/u.test(trimmed) && !trimmed.startsWith("ey")) return;
      candidates.add(trimmed);
    };

    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, nestedValue] of Object.entries(value)) {
        if (/^(?:access_token|accessToken|token)$/u.test(key)) {
          addToken(nestedValue);
          continue;
        }
        if (nestedValue && typeof nestedValue === "object") visit(nestedValue);
      }
    };

    for (const key of Object.keys(window.sessionStorage)) {
      const parsed = safeJsonParse(window.sessionStorage.getItem(key) || "");
      if (parsed) visit(parsed);
    }

    return Array.from(candidates);
  }

  function buildAuthenticatedHeaders(additionalHeaders) {
    const headers = new Headers(additionalHeaders || {});
    const token = getCandidateAccessTokens()[0];
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    return headers;
  }

  async function getFrameworkAppClient() {
    const globalClient = window.Plus4U5?.Utils?.AppClient;
    if (globalClient) {
      return globalClient;
    }

    if (!window.Uu5Loader?.import) {
      return null;
    }

    try {
      const plus4uModule = window.Uu5Loader.get?.("uu_plus4u5g02") || (await window.Uu5Loader.import("uu_plus4u5g02"));
      return plus4uModule?.Utils?.AppClient || null;
    } catch {
      return null;
    }
  }

  async function fetchBookKitJson(baseUri, command, dtoIn) {
    const requestUrl = new URL(`${baseUri}/${command}`);
    const params = dtoIn || {};
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      if (typeof value === "object") {
        requestUrl.searchParams.set(key, JSON.stringify(value));
      } else {
        requestUrl.searchParams.set(key, String(value));
      }
    });

    const appClient = await getFrameworkAppClient();
    if (appClient?.get) {
      try {
        const response = await appClient.get(requestUrl.toString(), {});
        // #region agent log
        dbg("fetchBookKitJson:appClient", "AppClient OK", { command, hasData: !!(response?.data || response) }, "B");
        // #endregion
        return response?.data || response;
      } catch (error) {
        // #region agent log
        dbg("fetchBookKitJson:appClient", "AppClient failed", { command, error: String(error?.message || error) }, "B");
        // #endregion
        throw error;
      }
    }

    const attempts = [
      () =>
        window.fetch(requestUrl.toString(), {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        }),
      () =>
        window.fetch(requestUrl.toString(), {
          credentials: "same-origin",
          headers: buildAuthenticatedHeaders(),
        }),
    ];

    let lastError = null;
    for (const execute of attempts) {
      const response = await execute();
      const text = await response.text();
      const json = safeJsonParse(text);

      if (response.ok) {
        return json;
      }

      lastError = new Error(json?.uuAppErrorMap ? Object.values(json.uuAppErrorMap)[0]?.message || response.statusText : response.statusText);
      lastError.status = response.status;
      lastError.body = json || text;
      if (response.status !== 401 && response.status !== 403) {
        throw lastError;
      }
    }

    // #region agent log
    dbg("fetchBookKitJson:fetch", "Fetch fallback failed", { command, status: lastError?.status, error: String(lastError?.message || lastError) }, "B");
    // #endregion
    throw lastError || new Error(`BookKit command ${command} failed.`);
  }

  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  }

  function openDatabase() {
    const deferred = createDeferred();
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        db.createObjectStore(BOOKS_STORE, { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains(INDEXES_STORE)) {
        db.createObjectStore(INDEXES_STORE, { keyPath: "bookId" });
      }
    };
    request.onsuccess = () => deferred.resolve(request.result);
    request.onerror = () => deferred.reject(request.error);

    return deferred.promise;
  }

  async function idbGetAll(db, storeName) {
    const deferred = createDeferred();
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => deferred.resolve(request.result || []);
    request.onerror = () => deferred.reject(request.error);
    return deferred.promise;
  }

  async function idbGet(db, storeName, key) {
    const deferred = createDeferred();
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => deferred.resolve(request.result || null);
    request.onerror = () => deferred.reject(request.error);
    return deferred.promise;
  }

  async function idbPut(db, storeName, value) {
    const deferred = createDeferred();
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).put(value);
    request.onsuccess = () => deferred.resolve(value);
    request.onerror = () => deferred.reject(request.error);
    return deferred.promise;
  }

  function getMiniSearchCtor() {
    if (typeof window !== "undefined" && window.MiniSearch) return window.MiniSearch;
    if (typeof globalThis !== "undefined" && globalThis.MiniSearch) return globalThis.MiniSearch;
    return null;
  }

  function tokenizeSearchText(text) {
    return (
      String(text || "")
        .toLocaleLowerCase("cs")
        .match(/[\p{L}\p{N}][\p{L}\p{N}\-_.]*/gu) || []
    );
  }

  function buildDocumentHaystack(document) {
    return `${document.pageTitle}\n${document.path}\n${document.sectionTitle}\n${document.text}`;
  }

  function scoreExactMatch(document, queryLower) {
    let score = 100;
    const fields = [
      { value: document.text, boost: 10 },
      { value: document.sectionTitle, boost: 8 },
      { value: document.pageTitle, boost: 6 },
      { value: document.path, boost: 4 },
    ];

    for (const field of fields) {
      const haystack = String(field.value || "").toLocaleLowerCase("cs");
      const index = haystack.indexOf(queryLower);
      if (index >= 0) {
        score += field.boost;
        score += Math.max(0, 3 - Math.floor(index / 120));
      }
    }

    return score;
  }

  function buildSearchEngine(documents) {
    const MiniSearchCtor = getMiniSearchCtor();
    if (!MiniSearchCtor) return null;

    const engine = new MiniSearchCtor({
      fields: ["pageTitle", "path", "sectionTitle", "text"],
      storeFields: ["id", "url", "pageTitle", "path", "sectionTitle", "excerpt", "pageCode", "bookId", "text"],
      tokenize: tokenizeSearchText,
      searchOptions: {
        boost: {
          pageTitle: 4,
          path: 3,
          sectionTitle: 2,
          text: 1,
        },
        prefix: true,
        fuzzy: 0.15,
        combineWith: "AND",
      },
    });
    engine.addAll(documents);
    return engine;
  }

  function fallbackSearch(documents, query) {
    const normalizedQuery = normalizeWhitespace(query).toLocaleLowerCase("cs");
    if (!normalizedQuery) return [];

    return documents
      .map((document) => {
        const haystack = `${document.pageTitle}\n${document.path}\n${document.sectionTitle}\n${document.text}`.toLocaleLowerCase("cs");
        if (!haystack.includes(normalizedQuery)) return null;

        let score = 1;
        if (document.pageTitle.toLocaleLowerCase("cs").includes(normalizedQuery)) score += 8;
        if (document.path.toLocaleLowerCase("cs").includes(normalizedQuery)) score += 6;
        if (document.sectionTitle.toLocaleLowerCase("cs").includes(normalizedQuery)) score += 4;
        score += Math.max(0, 3 - Math.floor(haystack.indexOf(normalizedQuery) / 120));

        return {
          ...document,
          score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
  }

  function searchDocuments(engine, documents, query) {
    const normalizedQuery = normalizeWhitespace(query);
    if (!normalizedQuery) return [];

    const queryLower = normalizedQuery.toLocaleLowerCase("cs");
    const exactMatches = documents
      .filter((document) => buildDocumentHaystack(document).toLocaleLowerCase("cs").includes(queryLower))
      .map((document) => ({ ...document, score: scoreExactMatch(document, queryLower) }))
      .sort((left, right) => right.score - left.score);

    let results = exactMatches;
    let mode = "exact";

    if (!exactMatches.length) {
      const technicalQuery = /[\-_.\\/]/u.test(normalizedQuery);
      if (engine) {
        results = engine.search(normalizedQuery, {
          prefix: !technicalQuery,
          fuzzy: technicalQuery ? 0 : 0.15,
          combineWith: "AND",
        });
        mode = "mini";
      } else {
        results = fallbackSearch(documents, query);
        mode = "fallback";
      }
    }

    results = results.slice(0, 100);
    // #region agent log
    if (/update-ca-certificates/i.test(query)) {
      dbg(
        "searchDocuments",
        "Search executed",
        {
          query: normalizedQuery,
          mode,
          exactCount: exactMatches.length,
          resultCount: results.length,
          engine: engine ? "MiniSearch" : "fallback",
          docCount: documents.length,
          sampleTitles: results.slice(0, 3).map((result) => result.pageTitle),
        },
        "D",
      );
    }
    // #endregion
    return results;
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return "nikdy";
    const deltaMs = Date.now() - timestamp;
    const deltaMinutes = Math.round(deltaMs / 60000);
    if (deltaMinutes < 1) return "právě teď";
    if (deltaMinutes < 60) return `před ${deltaMinutes} min`;
    const deltaHours = Math.round(deltaMinutes / 60);
    if (deltaHours < 24) return `před ${deltaHours} h`;
    const deltaDays = Math.round(deltaHours / 24);
    return `před ${deltaDays} d`;
  }

  function runWorkerPool(items, worker, concurrency, onProgress) {
    let index = 0;
    let done = 0;
    const results = new Array(items.length);

    async function runOne() {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
        done += 1;
        if (onProgress) onProgress(done, items.length, items[currentIndex]);
      }
    }

    return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne)).then(() => results);
  }

  function buildBookRecord(baseBook, patch) {
    return {
      ...baseBook,
      ...patch,
      updatedAt: Date.now(),
    };
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TRIGGERS_WRAP_ID} {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 6px;
        vertical-align: middle;
        flex: 0 0 auto;
        height: 32px;
      }

      #${TRIGGERS_WRAP_ID} .gm-bookkit-fulltext__toolbar-btn {
        box-sizing: border-box;
        min-height: 32px;
        height: 32px;
        margin: 0;
        padding: 0 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border-radius: 999px;
        line-height: 1;
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
        vertical-align: middle;
      }

      #${TRIGGERS_WRAP_ID} .gm-bookkit-fulltext__toolbar-btn .uu5-bricks-icon {
        width: auto;
        height: auto;
        font-size: 18px;
        line-height: 1;
      }

      #${TRIGGERS_WRAP_ID} .gm-bookkit-fulltext__nav-trigger {
        width: 32px;
        min-width: 32px;
        padding: 0;
      }

      #${TRIGGERS_WRAP_ID}.gm-bookkit-fulltext__triggers--header .gm-bookkit-fulltext__toolbar-btn {
        color: #fff;
        background: transparent;
        border: none;
        border-radius: 0;
        box-shadow: none;
        outline: none;
      }

      #${TRIGGERS_WRAP_ID}.gm-bookkit-fulltext__triggers--header .gm-bookkit-fulltext__toolbar-btn .uu5-bricks-icon {
        color: #fff;
      }

      #${TRIGGERS_WRAP_ID}.gm-bookkit-fulltext__triggers--header .gm-bookkit-fulltext__toolbar-btn:hover,
      #${TRIGGERS_WRAP_ID}.gm-bookkit-fulltext__triggers--header .gm-bookkit-fulltext__toolbar-btn:focus-visible {
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
        border: none;
        box-shadow: none;
      }

      .gm-bookkit-fulltext__nav-menu[hidden] {
        display: none !important;
      }

      .gm-bookkit-fulltext__nav {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .gm-bookkit-fulltext__nav-menu {
        position: absolute;
        right: 0;
        top: calc(100% + 8px);
        width: min(420px, calc(100vw - 48px));
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.2);
        padding: 12px;
        z-index: 2147483647;
      }

      .gm-bookkit-fulltext__nav-filter {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 14px;
      }

      .gm-bookkit-fulltext__nav-list {
        max-height: 320px;
        overflow: auto;
        margin-top: 8px;
      }

      #${MODAL_ID}[hidden] {
        display: none !important;
      }

      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(15, 23, 42, 0.45);
        font-family: Arial, sans-serif;
      }

      .gm-bookkit-fulltext__panel {
        width: min(960px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        background: #fff;
        border-radius: 14px;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.32);
        color: #0f172a;
      }

      .gm-bookkit-fulltext__header,
      .gm-bookkit-fulltext__toolbar,
      .gm-bookkit-fulltext__status {
        padding: 16px 20px;
      }

      .gm-bookkit-fulltext__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #e2e8f0;
      }

      .gm-bookkit-fulltext__header h2 {
        margin: 0;
        font-size: 20px;
      }

      .gm-bookkit-fulltext__toolbar {
        display: grid;
        grid-template-columns: minmax(220px, 300px) 1fr auto;
        gap: 12px;
        align-items: center;
        border-bottom: 1px solid #e2e8f0;
      }

      .gm-bookkit-fulltext__search-input,
      .gm-bookkit-fulltext__book-filter {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 14px;
      }

      .gm-bookkit-fulltext__book-button,
      .gm-bookkit-fulltext__action,
      .gm-bookkit-fulltext__close {
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #0f172a;
        border-radius: 10px;
        padding: 10px 12px;
        cursor: pointer;
        font-size: 14px;
      }

      .gm-bookkit-fulltext__action--primary {
        background: #0f62fe;
        border-color: #0f62fe;
        color: #fff;
      }

      .gm-bookkit-fulltext__status {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #e2e8f0;
        color: #475569;
        font-size: 13px;
      }

      .gm-bookkit-fulltext__results {
        overflow: auto;
        padding: 12px;
        background: #f8fafc;
      }

      .gm-bookkit-fulltext__empty {
        padding: 24px;
        color: #475569;
        text-align: center;
      }

      .gm-bookkit-fulltext__result {
        display: block;
        text-decoration: none;
        background: #fff;
        color: inherit;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 14px 16px;
        margin-bottom: 12px;
      }

      .gm-bookkit-fulltext__result-title {
        font-weight: 700;
        margin-bottom: 4px;
      }

      .gm-bookkit-fulltext__result-path {
        font-size: 12px;
        color: #334155;
        margin-bottom: 8px;
      }

      .gm-bookkit-fulltext__result-excerpt {
        font-size: 14px;
        color: #1e293b;
        line-height: 1.45;
      }

      .gm-bookkit-fulltext__result-excerpt mark.gm-bookkit-fulltext__hit {
        background: #fef08a;
        color: inherit;
        padding: 0 2px;
        border-radius: 2px;
      }

      .gm-bookkit-fulltext__result-hits {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .gm-bookkit-fulltext__result-hit {
        display: block;
      }

      .gm-bookkit-fulltext__result-hit + .gm-bookkit-fulltext__result-hit {
        padding-top: 10px;
        border-top: 1px solid #e2e8f0;
      }

      .gm-bookkit-fulltext__result-section {
        display: inline-block;
        margin-top: 8px;
        font-size: 12px;
        color: #475569;
      }

      .gm-bookkit-fulltext__book-picker[hidden] {
        display: none !important;
      }

      .gm-bookkit-fulltext__book-picker {
        position: absolute;
        margin-top: 8px;
        width: min(420px, calc(100vw - 48px));
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.2);
        padding: 12px;
        z-index: 2147483647;
      }

      .gm-bookkit-fulltext__book-list {
        max-height: 320px;
        overflow: auto;
        margin-top: 8px;
      }

      .gm-bookkit-fulltext__book-item {
        width: 100%;
        display: block;
        text-align: left;
        border: 1px solid transparent;
        background: #fff;
        border-radius: 10px;
        padding: 10px;
        cursor: pointer;
      }

      .gm-bookkit-fulltext__book-item:hover,
      .gm-bookkit-fulltext__book-item[data-active="true"] {
        background: #eff6ff;
        border-color: #bfdbfe;
      }

      .gm-bookkit-fulltext__book-meta {
        display: block;
        margin-top: 4px;
        font-size: 12px;
        color: #475569;
      }
    `;
    document.head.appendChild(style);
  }

  function createRuntime() {
    return {
      db: null,
      context: parseBookContextFromUrl(window.location.href),
      books: [],
      selectedBookId: "",
      selectedBook: null,
      indexRecord: null,
      searchEngine: null,
      ui: null,
      searchQuery: "",
      statusMessage: "",
      isBusy: false,
      pickerFilter: "",
      navFilter: "",
      topNav: null,
      freshnessCache: {},
      titleRefreshTimer: 0,
      titleRefreshAttempt: 0,
      contextWatchersInstalled: false,
    };
  }

  function setStatus(state, message) {
    state.statusMessage = message;
    if (state.ui?.statusLeft) {
      state.ui.statusLeft.textContent = message;
    }
  }

  function setFreshnessStatus(state, message) {
    state.freshnessMessage = message;
    if (state.ui?.statusRight) {
      state.ui.statusRight.textContent = message;
    }
  }

  async function probeIndexFreshness(state, options = {}) {
    const force = options.force === true;
    if (!state.selectedBook?.baseUri || !state.indexRecord?.documents?.length) {
      setFreshnessStatus(state, "");
      return "missing";
    }

    if (!state.indexRecord.structureSignature) {
      setFreshnessStatus(state, "bez otisku struktury — aktualizuj index");
      return "unknown-signature";
    }

    const cacheKey = state.selectedBook.bookId;
    const cached = state.freshnessCache[cacheKey];
    if (!force && cached && Date.now() - cached.checkedAt < FRESHNESS_PROBE_MS) {
      setFreshnessStatus(state, cached.message);
      return cached.status;
    }

    try {
      setFreshnessStatus(state, "kontroluji strukturu…");
      const structure = await loadBookStructure(state.selectedBook.baseUri);
      const liveSignature = fingerprintStructure(structure);
      const pageCount = createPageListFromStructure(structure, state.selectedBook.baseUri).length;
      let status;
      let message;

      if (liveSignature === state.indexRecord.structureSignature && pageCount === state.selectedBook.pageCount) {
        status = "current";
        message = "struktura aktuální";
      } else if (liveSignature !== state.indexRecord.structureSignature) {
        status = "structure-stale";
        message = "struktura knihy se změnila";
      } else {
        status = "structure-stale";
        message = `počet stránek ${state.selectedBook.pageCount} → ${pageCount}`;
      }

      state.freshnessCache[cacheKey] = { status, message, checkedAt: Date.now() };
      setFreshnessStatus(state, message);
      return status;
    } catch (error) {
      setFreshnessStatus(state, "kontrola struktury selhala");
      return "error";
    }
  }

  function setBusy(state, busy) {
    state.isBusy = busy;
    if (!state.ui) return;
    state.ui.buildButton.disabled = busy;
    state.ui.searchInput.disabled = busy && !(state.indexRecord?.documents?.length > 0);
  }

  function createModal(state) {
    if (state.ui?.modal) return state.ui;

    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.hidden = true;
    modal.innerHTML = `
      <div class="gm-bookkit-fulltext__panel" role="dialog" aria-modal="true" aria-label="uuBookKit Fulltext Search">
        <div class="gm-bookkit-fulltext__header">
          <h2>uuBookKit Fulltext</h2>
          <button type="button" class="gm-bookkit-fulltext__close">Zavřít</button>
        </div>
        <div class="gm-bookkit-fulltext__toolbar">
          <div style="position: relative;">
            <button type="button" class="gm-bookkit-fulltext__book-button"></button>
            <div class="gm-bookkit-fulltext__book-picker" hidden>
              <input type="search" class="gm-bookkit-fulltext__book-filter" placeholder="Filtrovat BookKity..." />
              <div class="gm-bookkit-fulltext__book-list"></div>
            </div>
          </div>
          <input type="search" class="gm-bookkit-fulltext__search-input" placeholder="Hledej napříč stránkami a sekcemi..." />
          <button type="button" class="gm-bookkit-fulltext__action gm-bookkit-fulltext__action--primary">Sestavit / aktualizovat index</button>
        </div>
        <div class="gm-bookkit-fulltext__status">
          <div></div>
          <div></div>
        </div>
        <div class="gm-bookkit-fulltext__results">
          <div class="gm-bookkit-fulltext__empty">Načítám registry BookKitů…</div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const ui = {
      modal,
      panel: modal.firstElementChild,
      closeButton: modal.querySelector(".gm-bookkit-fulltext__close"),
      bookButton: modal.querySelector(".gm-bookkit-fulltext__book-button"),
      picker: modal.querySelector(".gm-bookkit-fulltext__book-picker"),
      bookFilter: modal.querySelector(".gm-bookkit-fulltext__book-filter"),
      bookList: modal.querySelector(".gm-bookkit-fulltext__book-list"),
      searchInput: modal.querySelector(".gm-bookkit-fulltext__search-input"),
      buildButton: modal.querySelector(".gm-bookkit-fulltext__action"),
      statusLeft: modal.querySelector(".gm-bookkit-fulltext__status > div:first-child"),
      statusRight: modal.querySelector(".gm-bookkit-fulltext__status > div:last-child"),
      results: modal.querySelector(".gm-bookkit-fulltext__results"),
    };

    ui.closeButton.addEventListener("click", () => {
      modal.hidden = true;
      ui.picker.hidden = true;
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        modal.hidden = true;
        ui.picker.hidden = true;
      }
    });
    ui.bookButton.addEventListener("click", () => {
      ui.picker.hidden = !ui.picker.hidden;
      if (!ui.picker.hidden) {
        ui.bookFilter.focus();
        renderBookPicker(state);
      }
    });
    ui.bookFilter.addEventListener("input", () => {
      state.pickerFilter = ui.bookFilter.value;
      renderBookPicker(state);
    });
    ui.searchInput.addEventListener("input", () => {
      state.searchQuery = ui.searchInput.value;
      renderResults(state);
    });
    ui.buildButton.addEventListener("click", () => {
      buildIndexForSelectedBook(state).catch((error) => {
        setBusy(state, false);
        setStatus(state, `Indexace selhala: ${error.message}`);
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) {
        modal.hidden = true;
        ui.picker.hidden = true;
      }
    });

    state.ui = ui;
    return ui;
  }

  function formatBookIndexLabel(book) {
    if (book?.lastIndexedAt) {
      const parts = [`indexováno ${formatRelativeTime(book.lastIndexedAt)}`];
      if (book.pageCount) {
        parts.push(`${book.pageCount} stránek`);
      }
      return parts.join(" · ");
    }

    if (book?.lastVisitedAt) {
      return `navštíveno ${formatRelativeTime(book.lastVisitedAt)} · bez lokálního indexu`;
    }

    return "bez lokálního indexu";
  }

  function getNavBooks(state) {
    return [...(state.books || [])]
      .filter((book) => book.lastVisitedAt || book.lastIndexedAt)
      .sort((a, b) => {
        const byVisited = (b.lastVisitedAt || 0) - (a.lastVisitedAt || 0);
        if (byVisited !== 0) return byVisited;
        const byIndexed = (b.lastIndexedAt || 0) - (a.lastIndexedAt || 0);
        if (byIndexed !== 0) return byIndexed;
        return String(a.title || a.baseUri).localeCompare(String(b.title || b.baseUri), "cs");
      });
  }

  function renderNavMenu(state) {
    const nav = state.topNav;
    if (!nav?.list) return;

    const filter = normalizeWhitespace(state.navFilter).toLocaleLowerCase("cs");
    const books = getNavBooks(state).filter((book) => {
      if (!filter) return true;
      return `${book.title} ${book.baseUri} ${book.awid}`.toLocaleLowerCase("cs").includes(filter);
    });

    nav.list.innerHTML = "";
    for (const book of books) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gm-bookkit-fulltext__book-item";
      button.dataset.active = String(book.bookId === state.context?.bookId);
      button.innerHTML = `
        <strong>${escapeHtml(book.title || book.baseUri)}</strong>
        <span class="gm-bookkit-fulltext__book-meta">${escapeHtml(book.awid || "")} · ${escapeHtml(formatBookIndexLabel(book))}</span>
      `;
      button.addEventListener("click", () => {
        nav.navMenu.hidden = true;
        window.location.assign(`${book.baseUri}/book/intro`);
      });
      nav.list.appendChild(button);
    }

    if (!books.length) {
      nav.list.innerHTML = `<div class="gm-bookkit-fulltext__empty">Žádný BookKit neodpovídá filtru.</div>`;
    }
  }

  function renderBookPicker(state) {
    const ui = state.ui;
    if (!ui) return;

    const filter = normalizeWhitespace(state.pickerFilter).toLocaleLowerCase("cs");
    const books = state.books.filter((book) => {
      if (!filter) return true;
      return `${book.title} ${book.baseUri} ${book.awid}`.toLocaleLowerCase("cs").includes(filter);
    });

    ui.bookList.innerHTML = "";
    for (const book of books) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gm-bookkit-fulltext__book-item";
      button.dataset.active = String(book.bookId === state.selectedBookId);
      button.innerHTML = `
        <strong>${escapeHtml(book.title || book.baseUri)}</strong>
        <span class="gm-bookkit-fulltext__book-meta">${escapeHtml(book.awid || "")} · ${
          book.lastIndexedAt ? `index ${formatRelativeTime(book.lastIndexedAt)}` : "bez indexu"
        }</span>
      `;
      button.addEventListener("click", async () => {
        ui.picker.hidden = true;
        state.selectedBookId = book.bookId;
        state.selectedBook = book;
        await hydrateSelectedBook(state);
        renderResults(state);
      });
      ui.bookList.appendChild(button);
    }

    if (!books.length) {
      ui.bookList.innerHTML = `<div class="gm-bookkit-fulltext__empty">Žádný BookKit neodpovídá filtru.</div>`;
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function flattenResultText(value) {
    return normalizeWhitespace(String(value || "").replace(/\s+/gu, " "));
  }

  function highlightAllMatches(text, query) {
    const normalizedQuery = normalizeWhitespace(query);
    if (!normalizedQuery) return escapeHtml(text);

    const textLower = text.toLocaleLowerCase("cs");
    const queryLower = normalizedQuery.toLocaleLowerCase("cs");
    let html = "";
    let position = 0;

    while (position < text.length) {
      const index = textLower.indexOf(queryLower, position);
      if (index < 0) {
        html += escapeHtml(text.slice(position));
        break;
      }

      html += escapeHtml(text.slice(position, index));
      html += `<mark class="gm-bookkit-fulltext__hit">${escapeHtml(text.slice(index, index + normalizedQuery.length))}</mark>`;
      position = index + normalizedQuery.length;
    }

    return html;
  }

  function buildResultSnippet(result, query, maxLength = 220) {
    const normalizedQuery = normalizeWhitespace(query);
    const queryLower = normalizedQuery.toLocaleLowerCase("cs");
    const sources = [result.text, result.sectionTitle, result.pageTitle, result.path, result.excerpt].map(flattenResultText).filter(Boolean);

    const matchedSource = sources.find((source) => source.toLocaleLowerCase("cs").includes(queryLower)) || sources[0] || "";
    if (!matchedSource) return "";

    const matchIndex = matchedSource.toLocaleLowerCase("cs").indexOf(queryLower);
    if (matchIndex < 0) {
      const fallback = matchedSource.slice(0, maxLength);
      return escapeHtml(fallback) + (matchedSource.length > maxLength ? "…" : "");
    }

    const padding = Math.max(40, Math.floor((maxLength - normalizedQuery.length) / 2));
    let start = Math.max(0, matchIndex - padding);
    let end = Math.min(matchedSource.length, matchIndex + normalizedQuery.length + padding);

    if (end - start > maxLength) {
      end = start + maxLength;
    }

    let snippet = matchedSource.slice(start, end).trim();
    if (start > 0) snippet = `… ${snippet}`;
    if (end < matchedSource.length) snippet = `${snippet} …`;

    return highlightAllMatches(snippet, normalizedQuery);
  }

  function resolveSearchResults(results, documents) {
    const byId = new Map(documents.map((document) => [document.id, document]));
    return results.map((result) => {
      const full = byId.get(result.id);
      return full ? { ...full, score: result.score } : result;
    });
  }

  function groupSearchResultsByPage(results) {
    const groups = new Map();
    const order = [];

    for (const result of results) {
      const key = `${result.bookId || ""}::${result.pageCode || result.url || result.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          url: result.url,
          pageTitle: result.pageTitle,
          path: result.path,
          score: result.score ?? 0,
          hits: [],
        });
        order.push(key);
      }

      const group = groups.get(key);
      group.score = Math.max(group.score ?? 0, result.score ?? 0);
      group.hits.push(result);
    }

    return order.map((key) => groups.get(key)).sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  }

  function renderResultHit(result, query) {
    const sectionTitle = flattenResultText(result.sectionTitle);
    const sectionHtml = sectionTitle ? `<span class="gm-bookkit-fulltext__result-section">Sekce: ${escapeHtml(sectionTitle)}</span>` : "";

    return `
      <div class="gm-bookkit-fulltext__result-hit">
        <div class="gm-bookkit-fulltext__result-excerpt">${buildResultSnippet(result, query)}</div>
        ${sectionHtml}
      </div>
    `;
  }

  function renderResults(state) {
    const ui = state.ui;
    if (!ui) return;

    ui.bookButton.textContent = state.selectedBook?.title || "Vybrat BookKit";
    ui.statusRight.textContent = state.indexRecord?.documents?.length ? `${state.indexRecord.documents.length} sekcí` : "bez indexu";

    const query = normalizeWhitespace(state.searchQuery);
    const documents = state.indexRecord?.documents || [];

    if (!documents.length) {
      ui.results.innerHTML =
        '<div class="gm-bookkit-fulltext__empty">Pro vybraný BookKit zatím není lokální index. Klikni na "Sestavit / aktualizovat index".</div>';
      return;
    }

    if (!query) {
      ui.results.innerHTML = '<div class="gm-bookkit-fulltext__empty">Zadej dotaz, fulltext hledá v názvech stránek i obsahu sekcí.</div>';
      return;
    }

    const results = resolveSearchResults(searchDocuments(state.searchEngine, documents, query), documents);
    if (!results.length) {
      ui.results.innerHTML = '<div class="gm-bookkit-fulltext__empty">Nic jsem nenašel. Zkus kratší nebo obecnější dotaz.</div>';
      return;
    }

    const groupedResults = groupSearchResultsByPage(results);

    ui.results.innerHTML = groupedResults
      .map((group) => {
        return `
          <a class="gm-bookkit-fulltext__result" href="${escapeHtml(group.url)}">
            <div class="gm-bookkit-fulltext__result-title">${escapeHtml(group.pageTitle || "")}</div>
            <div class="gm-bookkit-fulltext__result-path">${escapeHtml(group.path || "")}</div>
            <div class="gm-bookkit-fulltext__result-hits">
              ${group.hits.map((hit) => renderResultHit(hit, query)).join("")}
            </div>
          </a>
        `;
      })
      .join("");
  }

  async function loadRegistry(state) {
    state.db = await openDatabase();
    const storedBooks = await idbGetAll(state.db, BOOKS_STORE);
    const liveTitle = getCurrentBookTitle();
    const currentBook = state.context
      ? {
          ...state.context,
          ...(isGenericBookTitle(liveTitle) ? {} : { title: liveTitle }),
          lastVisitedAt: Date.now(),
        }
      : null;

    state.titleRefreshAttempt = 0;
    state.books = mergeBookRegistries(
      KNOWN_BOOKS.map((book) => ({ ...book, seed: true })),
      currentBook ? [...storedBooks, currentBook] : storedBooks,
    );

    for (const book of state.books) {
      await idbPut(state.db, BOOKS_STORE, book);
    }

    state.selectedBookId = state.context?.bookId || state.books[0]?.bookId || "";
    state.selectedBook = state.books.find((book) => book.bookId === state.selectedBookId) || state.books[0] || null;
    await hydrateSelectedBook(state);
    scheduleCurrentBookTitleRefresh(state);
  }

  async function hydrateSelectedBook(state) {
    if (!state.selectedBook || !state.db) return;
    state.indexRecord = await idbGet(state.db, INDEXES_STORE, state.selectedBook.bookId);
    state.searchEngine = state.indexRecord?.documents?.length ? buildSearchEngine(state.indexRecord.documents) : null;
    setStatus(
      state,
      state.indexRecord?.documents?.length
        ? `Index připraven pro ${state.selectedBook.title || state.selectedBook.baseUri}.`
        : `Vybraný BookKit ještě nemá lokální index.`,
    );
    if (state.ui) renderBookPicker(state);
  }

  async function loadBookStructure(baseUri) {
    const json = await fetchBookKitJson(baseUri, "getBookStructure", {});
    return json?.data || json?.body || json;
  }

  async function loadPage(baseUri, code) {
    const json = await fetchBookKitJson(baseUri, "loadPage", { code });
    return json?.data || json?.body || json;
  }

  async function fetchBookTitle(baseUri) {
    const json = await fetchBookKitJson(baseUri, "getBook", {});
    return extractBookTitleFromBookDto(json);
  }

  async function persistBookTitle(state, bookId, title) {
    const normalized = String(title || "").trim();
    if (!normalized || isGenericBookTitle(normalized)) return false;

    const book = state.books.find((entry) => entry.bookId === bookId);
    if (!book) return false;

    const nextTitle = pickBetterBookTitle(book.title, normalized);
    if (nextTitle === book.title) return false;

    const nextBook = buildBookRecord(book, { title: nextTitle });
    state.books = state.books.map((entry) => (entry.bookId === bookId ? nextBook : entry));
    if (state.selectedBook?.bookId === bookId) {
      state.selectedBook = nextBook;
      if (state.ui?.bookButton) {
        state.ui.bookButton.textContent = nextBook.title || "Vybrat BookKit";
      }
    }

    if (state.db) {
      await idbPut(state.db, BOOKS_STORE, nextBook);
    }

    renderNavMenu(state);
    renderBookPicker(state);
    return true;
  }

  async function refreshBookTitleFromApi(state, bookId) {
    const book = state.books.find((entry) => entry.bookId === bookId);
    if (!book?.baseUri) return false;

    try {
      const title = await fetchBookTitle(book.baseUri);
      return await persistBookTitle(state, bookId, title);
    } catch {
      return false;
    }
  }

  async function refreshGenericNavBookTitles(state) {
    const staleBooks = getNavBooks(state).filter((book) => isGenericBookTitle(book.title));
    for (const book of staleBooks) {
      await refreshBookTitleFromApi(state, book.bookId);
    }
  }

  async function refreshCurrentBookTitle(state) {
    const bookId = state.context?.bookId;
    if (!bookId) return false;

    const domTitle = getCurrentBookTitle();
    if (!isGenericBookTitle(domTitle)) {
      return persistBookTitle(state, bookId, domTitle);
    }

    const book = state.books.find((entry) => entry.bookId === bookId);
    if (book && !isGenericBookTitle(book.title)) return true;

    return refreshBookTitleFromApi(state, bookId);
  }

  function scheduleCurrentBookTitleRefresh(state) {
    const bookId = state.context?.bookId;
    if (!bookId) return;

    const book = state.books.find((entry) => entry.bookId === bookId);
    if (book && !isGenericBookTitle(book.title)) {
      state.titleRefreshAttempt = 0;
      return;
    }

    const delays = [300, 1000, 3000, 8000];
    const attempt = Math.min(state.titleRefreshAttempt, delays.length - 1);
    clearTimeout(state.titleRefreshTimer);
    state.titleRefreshTimer = window.setTimeout(async () => {
      const fixed = await refreshCurrentBookTitle(state);
      const current = state.books.find((entry) => entry.bookId === bookId);
      if (!fixed && isGenericBookTitle(current?.title) && state.titleRefreshAttempt < delays.length - 1) {
        state.titleRefreshAttempt += 1;
        scheduleCurrentBookTitleRefresh(state);
      } else {
        state.titleRefreshAttempt = 0;
      }
    }, delays[attempt]);
  }

  let lastTrackedBookId = "";

  async function syncBookContext(state) {
    const context = parseBookContextFromUrl(window.location.href);
    if (!context?.bookId) return;

    const bookChanged = context.bookId !== state.context?.bookId;
    if (!bookChanged && context.bookId === lastTrackedBookId) {
      scheduleCurrentBookTitleRefresh(state);
      return;
    }

    state.context = context;
    lastTrackedBookId = context.bookId;

    if (bookChanged) {
      await loadRegistry(state);
      renderBookPicker(state);
      renderNavMenu(state);
      ensureTrigger(state);
      return;
    }

    scheduleCurrentBookTitleRefresh(state);
  }

  function installBookContextWatchers(state) {
    if (state.contextWatchersInstalled) return;
    state.contextWatchersInstalled = true;
    lastTrackedBookId = state.context?.bookId || "";

    window.addEventListener("popstate", () => {
      syncBookContext(state).catch(() => {});
    });

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        syncBookContext(state).catch(() => {});
        return result;
      };
    }

    window.setInterval(() => {
      syncBookContext(state).catch(() => {});
    }, 1500);
  }

  async function buildIndexForSelectedBook(state) {
    if (!state.selectedBook || !state.db) return;

    setBusy(state, true);
    setStatus(state, `Načítám strukturu knihy ${state.selectedBook.title || state.selectedBook.baseUri}…`);

    try {
      const book = state.selectedBook;
      const structure = await loadBookStructure(book.baseUri);
      const pages = createPageListFromStructure(structure, book.baseUri);
      let resolvedTitle = resolveBookTitle(book, state.context);
      if (isGenericBookTitle(resolvedTitle)) {
        const apiTitle = await fetchBookTitle(book.baseUri);
        if (apiTitle && !isGenericBookTitle(apiTitle)) {
          resolvedTitle = apiTitle;
        }
      }

      const allDocuments = [];
      await runWorkerPool(
        pages,
        async (page) => {
          const loadPageResult = await loadPage(book.baseUri, page.code);
          const documents = createSearchDocuments(book, page, loadPageResult);
          allDocuments.push(...documents);
        },
        INDEX_CONCURRENCY,
        (done, total, page) => {
          setStatus(state, `Indexuji ${done}/${total}: ${page.title}`);
        },
      );

      const now = Date.now();
      const structureSignature = fingerprintStructure(structure);
      const nextBook = buildBookRecord(book, {
        title: resolvedTitle,
        pageCount: pages.length,
        lastIndexedAt: now,
        lastVisitedAt: now,
        structureSignature,
      });
      const indexRecord = {
        bookId: book.bookId,
        baseUri: book.baseUri,
        createdAt: state.indexRecord?.createdAt || now,
        indexedAt: now,
        structureSignature,
        documents: allDocuments,
      };

      await idbPut(state.db, BOOKS_STORE, nextBook);
      await idbPut(state.db, INDEXES_STORE, indexRecord);

      state.books = mergeBookRegistries(
        KNOWN_BOOKS.map((item) => ({ ...item, seed: true })),
        [...(state.books.filter((entry) => entry.bookId !== nextBook.bookId) || []), nextBook],
      );
      state.selectedBook = nextBook;
      state.indexRecord = indexRecord;
      state.searchEngine = buildSearchEngine(allDocuments);
      delete state.freshnessCache[book.bookId];
      setStatus(state, `Index hotový: ${allDocuments.length} sekcí z ${pages.length} stránek.`);
      setFreshnessStatus(state, "struktura aktuální");
      // #region agent log
      const certMatches = allDocuments.filter((d) => /update-ca-certificates/i.test(d.text || ""));
      dbg(
        "buildIndexForSelectedBook",
        "Index built",
        {
          pageCount: pages.length,
          docCount: allDocuments.length,
          hasMiniSearch: !!state.searchEngine,
          certMatchCount: certMatches.length,
          certPages: certMatches.slice(0, 5).map((d) => d.pageTitle),
        },
        "C",
      );
      // #endregion
      renderBookPicker(state);
      renderNavMenu(state);
      renderResults(state);
    } finally {
      setBusy(state, false);
    }
  }

  function isDarkTopHeader() {
    return Boolean(document.querySelector(".plus4u5-app-page-top-wrapper"));
  }

  function getBookKitTopButtonClasses(headerMode) {
    const nativeButton = document.querySelector(".uu-bookkit-search-area-top-button");
    let classNames = nativeButton?.className || "uu5-bricks-button uu5-bricks-button-m uu5-bricks-button-filled";

    if (headerMode) {
      classNames = classNames
        .split(/\s+/)
        .filter((name) => {
          if (!name) return false;
          if (name.includes("filled")) return false;
          if (name.startsWith("uu-bricks-") && !name.includes("zsiwht")) return false;
          return true;
        })
        .join(" ");
    }

    if (!classNames.includes("uu5-bricks-button")) {
      classNames = `uu5-bricks-button uu5-bricks-button-m ${classNames}`.trim();
    }

    return `${classNames} gm-bookkit-fulltext__toolbar-btn`;
  }

  function ensureTrigger(state) {
    const searchArea = document.querySelector(".uu-bookkit-search-area-top-div");
    if (!searchArea || document.getElementById(TRIGGERS_WRAP_ID)) return;

    const legacyTrigger = document.getElementById(TRIGGER_ID);
    if (legacyTrigger) {
      legacyTrigger.remove();
    }

    const headerMode = isDarkTopHeader();
    const buttonClasses = getBookKitTopButtonClasses(headerMode);

    const wrap = document.createElement("div");
    wrap.id = TRIGGERS_WRAP_ID;
    wrap.className = headerMode ? "gm-bookkit-fulltext__triggers gm-bookkit-fulltext__triggers--header" : "gm-bookkit-fulltext__triggers";

    const nav = document.createElement("div");
    nav.className = "gm-bookkit-fulltext__nav";

    const navButton = document.createElement("button");
    navButton.id = NAV_TRIGGER_ID;
    navButton.type = "button";
    navButton.className = `${buttonClasses} gm-bookkit-fulltext__nav-trigger`;
    navButton.setAttribute("aria-label", "BookKity");
    navButton.title = "BookKity";
    navButton.innerHTML = '<span class="uu5-bricks-icon mdi mdi-menu" aria-hidden="true"></span>';

    const navMenu = document.createElement("div");
    navMenu.id = NAV_MENU_ID;
    navMenu.className = "gm-bookkit-fulltext__nav-menu";
    navMenu.hidden = true;
    navMenu.innerHTML = `
      <input type="search" class="gm-bookkit-fulltext__nav-filter" placeholder="Hledat BookKit..." />
      <div class="gm-bookkit-fulltext__nav-list"></div>
    `;

    const filterInput = navMenu.querySelector(".gm-bookkit-fulltext__nav-filter");
    const list = navMenu.querySelector(".gm-bookkit-fulltext__nav-list");

    state.topNav = { navMenu, filterInput, list, navButton };

    navButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      navMenu.hidden = !navMenu.hidden;
      if (!navMenu.hidden) {
        state.navFilter = "";
        filterInput.value = "";
        list.innerHTML = `<div class="gm-bookkit-fulltext__empty">Načítám názvy BookKitů…</div>`;
        await refreshGenericNavBookTitles(state);
        renderNavMenu(state);
        filterInput.focus();
      }
    });

    filterInput.addEventListener("input", () => {
      state.navFilter = filterInput.value;
      renderNavMenu(state);
    });
    filterInput.addEventListener("click", (event) => event.stopPropagation());
    navMenu.addEventListener("click", (event) => event.stopPropagation());

    document.addEventListener("click", () => {
      if (state.topNav?.navMenu) {
        state.topNav.navMenu.hidden = true;
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.topNav?.navMenu && !state.topNav.navMenu.hidden) {
        state.topNav.navMenu.hidden = true;
      }
    });

    nav.appendChild(navButton);
    nav.appendChild(navMenu);

    const button = document.createElement("button");
    button.id = TRIGGER_ID;
    button.type = "button";
    button.className = buttonClasses;
    button.textContent = "Fulltext";
    button.addEventListener("click", async () => {
      if (!state.ui) createModal(state);
      state.ui.modal.hidden = false;
      state.ui.searchInput.focus();
      renderResults(state);
      probeIndexFreshness(state).catch(() => {});
    });

    wrap.appendChild(button);
    wrap.appendChild(nav);
    searchArea.appendChild(wrap);
  }

  async function initialize() {
    if (window[SCRIPT_FLAG]) {
      if (window.__gmBookKitFulltextState) {
        await syncBookContext(window.__gmBookKitFulltextState);
      }
      return;
    }
    window[SCRIPT_FLAG] = true;

    const state = createRuntime();
    if (!state.context) return;

    window.__gmBookKitFulltextState = state;

    ensureStyles();
    createModal(state);
    ensureTrigger(state);
    await loadRegistry(state);
    renderBookPicker(state);
    renderNavMenu(state);
    renderResults(state);
    installBookContextWatchers(state);

    const observer = new MutationObserver(() => {
      ensureTrigger(state);
      if (state.context && document.querySelector(".uu-bookkit-book-top-text")) {
        scheduleCurrentBookTitleRefresh(state);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    if (state.indexRecord?.indexedAt && Date.now() - state.indexRecord.indexedAt > INDEX_STALE_MS && !state.indexRecord.structureSignature) {
      setStatus(state, `Index je starší než 24 hodin, zvaž aktualizaci.`);
    }
    // #region agent log
    dbg(
      "initialize",
      "Init complete",
      {
        hasTrigger: !!document.getElementById(TRIGGER_ID),
        hasNavTrigger: !!document.getElementById(NAV_TRIGGER_ID),
        hasIndex: !!state.indexRecord?.documents?.length,
        indexDocCount: state.indexRecord?.documents?.length || 0,
        selectedBook: state.selectedBook?.title,
      },
      "A",
    );
    // #endregion
  }

  function run() {
    initialize().catch((error) => {
      // #region agent log
      dbg("initialize", "Init failed", { error: String(error?.message || error) }, "A");
      // #endregion
      console.error("gm-bookkit-fulltext-search init failed", error);
    });
  }

  return {
    parseBookContextFromUrl,
    mergeBookRegistries,
    parseBookTitleFromDocumentTitle,
    extractBookTitleFromBookDto,
    isGenericBookTitle,
    pickBetterBookTitle,
    resolveBookTitle,
    createPageListFromStructure,
    computeStructureSignature,
    fingerprintStructure,
    extractSearchText,
    createSearchDocuments,
    searchDocuments,
    fallbackSearch,
    buildResultSnippet,
    highlightAllMatches,
    groupSearchResultsByPage,
    getNavBooks,
    formatBookIndexLabel,
    run,
  };
});
