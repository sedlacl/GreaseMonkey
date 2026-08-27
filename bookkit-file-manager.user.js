// ==UserScript==
// @name         uuBookKit – FileManager
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.4.2
// @description  Attachment size, sort by size, and optional heuristic attachment-usage check for uuBookKit FileManager.
// @author       Lukáš Vyleťal
// @match        https://uuapp.plus4u.net/uu-bookkit-maing01/*
// @match        https://uuapp-dev.plus4u.net/uu-bookkit-maing01/*
// @grant        none
// @run-at       document-start
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/bookkit-file-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/bookkit-file-manager.user.js
// ==/UserScript==
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Lukáš Vyleťal
// Adopted into sedlacl/GreaseMonkey from "uuBookKit – FileManager-1.4.0" (SHA-256 C3035143B5C2AF747F5BFF6D2CF700F2A9757F4C2399105836942FC18E8B8850).
// Usage detection is heuristic and may miss non-standard references.

(function factory(rootFactory) {
  const api = rootFactory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    api.run();
  }
})(function createBookKitFileManagerApi() {
  "use strict";

  const SCRIPT_FLAG = "__gmBookKitFileManager";
  const SCRIPT_VERSION = "1.4.2";
  const STYLE_ID = "gm-bk-file-manager-style";
  const NET_HOOK_FLAG = "__gmBkFmNetHooked";
  const SIZE_SORTER_HOOK_FLAG = "__gmBkSizeSorterHooked";

  const BADGE_CLASS = "bk-attachment-size-badge";
  const CORNER_CLASS = "bk-attachment-corner";
  const UNUSED_CLASS = "bk-attachment-unused";
  const OVERLAY_CLASS = "bk-attachment-unused-overlay";
  const MARK_CLASS = "bk-attachment-usage-mark";
  const MARK_UNUSED_CLASS = "bk-attachment-usage-mark-unused";
  const BUTTON_CLASS = "bk-attachment-usage-btn";
  const SELECT_UNUSED_BUTTON_CLASS = "bk-attachment-select-unused-btn";
  const BUTTON_FALLBACK_CLASS = "bk-attachment-usage-btn-fallback";
  const TILE_SELECTOR = ".plus4u5-files-file-manager-tile";
  const FM_SELECTOR = ".plus4u5-files-file-manager";
  const CACHE_TTL_MS = 30 * 60 * 1000;
  const CACHE_KEY_PREFIX = "gm-bk-att-usage:v4:";
  const SCAN_CONCURRENCY = 4;
  const SIZE_SORT_KEY = "size";
  const SIZE_SORTER_RETRY_MS = 200;
  const SIZE_SORTER_MAX_MS = 10000;

  const LIST_CMD_RE = /\/list(Binaries|DictionaryEntries|PublicDictionaryEntries)(\?|$)/;
  const BOOK_BASE_PATH_RE = /^(.*?\/uu-bookkit-maing01\/(?:\d+-)?[a-z0-9]{32})/i;
  const AWID_RE = /uu-bookkit-maing01\/((?:\d+-)?[a-z0-9]{32})/i;

  // Heuristic patterns for attachment codes in page content (may miss non-standard references).
  const CODE_PULL =
    /(?:(?:^|[^\w-])(?:code|src|binaryCode|attachmentCode|fileCode)\s*=\s*["']?([^\s"'<>/]+)|[?&]code=([^&"'#\s]+)|"(?:code|binaryCode|attachmentCode|fileCode)"\s*:\s*"([^"]+)"|srcUri\s*=\s*["'][^"']*[?&]code=([^&"'#\s]+))/gi;

  const LANGUAGES = ["cs", "en", "uk"];
  const FALLBACK_LANGUAGE = "en";
  const LANGUAGE_CACHE_MS = 1000;
  const LSI = {
    buttonLabel: {
      cs: "Ověřit použití příloh",
      en: "Check attachment usage",
      uk: "Перевірити використання вкладень",
    },
    buttonTitle: {
      cs: "Heuristicky ověří, zda je příloha v této knize použita; nepoužité podbarví červeně (může minout nestandardní odkazy).",
      en: "Heuristically checks whether each attachment is used in this book and highlights unused ones in red (may miss non-standard references).",
      uk: "Евристично перевіряє, чи використовується вкладення в цій книзі, і підсвічує невикористані червоним (може пропустити нестандартні посилання).",
    },
    buttonProgress: { cs: "Ověřuji…", en: "Checking…", uk: "Перевіряю…" },
    buttonFailed: { cs: "Ověření selhalo", en: "Check failed", uk: "Перевірка не вдалася" },
    selectUnusedLabel: {
      cs: "Označit nepoužité",
      en: "Select unused",
      uk: "Вибрати невикористані",
    },
    selectUnusedTitle: {
      cs: "Přidá všechny bezpečně rozpoznané nepoužité přílohy do výběru pro hromadné akce.",
      en: "Adds all confidently identified unused attachments to the bulk-action selection.",
      uk: "Додає всі надійно визначені невикористані вкладення до вибору для масових дій.",
    },
    selectUnusedUnavailable: {
      cs: "Nejprve dokončete ověření použití příloh bez chyb.",
      en: "First complete the attachment usage check without errors.",
      uk: "Спочатку завершіть перевірку використання вкладень без помилок.",
    },
    unusedHint: {
      cs: "Příloha není v této knize zobrazena/odkázána (heuristická kontrola — nestandardní reference mohou chybět).",
      en: "The attachment is not displayed or referenced anywhere in this book (heuristic check — non-standard references may be missed).",
      uk: "Вкладення не відображається та не згадується в цій книзі (евристична перевірка — нестандартні посилання можуть бути пропущені).",
    },
    errorLabel: { cs: "Chyba", en: "Error", uk: "Помилка" },
    warningLabel: { cs: "Pozor", en: "Warning", uk: "Увага" },
    missingToken: {
      cs: "nepodařilo se získat přihlašovací token, zkuste stránku znovu načíst",
      en: "the access token could not be obtained, try reloading the page",
      uk: "не вдалося отримати токен доступу, спробуйте перезавантажити сторінку",
    },
    noPageLoaded: {
      cs: "nepodařilo se načíst žádnou stránku knihy",
      en: "no book page could be loaded",
      uk: "не вдалося завантажити жодної сторінки книги",
    },
    pagesFailed: {
      cs: "{failed} z {total} stránek se nepodařilo načíst — nepoužité přílohy nejsou označeny",
      en: "{failed} of {total} pages could not be loaded — unused attachments are not marked",
      uk: "{failed} з {total} сторінок не вдалося завантажити — невикористані вкладення не позначені",
    },
    bookIntro: { cs: "Intro knihy", en: "Book intro", uk: "Вступ книги" },
    sizeSort: { cs: "Velikost", en: "Size", uk: "Розмір" },
  };

  function parseBookBaseFromUrl(url) {
    const value = String(url || "");
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    const pathMatch = parsed.pathname.match(BOOK_BASE_PATH_RE);
    if (!pathMatch) return null;
    const awidMatch = pathMatch[1].match(AWID_RE);
    if (!awidMatch) return null;
    return {
      origin: parsed.origin,
      awid: awidMatch[1],
      baseUri: parsed.origin + pathMatch[1],
    };
  }

  function formatSize(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return (value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
  }

  function itemSize(item) {
    const size = item && (typeof item.size === "number" ? item.size : item.binary && item.binary.size);
    return typeof size === "number" ? size : -1;
  }

  function compareBySize(a, b, order) {
    const diff = itemSize(a) - itemSize(b);
    return order === "DESC" ? -diff : diff;
  }

  function createSizeSortItem(sizeSortLsi) {
    return {
      key: SIZE_SORT_KEY,
      name: sizeSortLsi,
      sortFn: (a, b, { order }) => compareBySize(a, b, order),
    };
  }

  function structureRev(structure) {
    return structure && structure.sys && structure.sys.rev != null ? String(structure.sys.rev) : "";
  }

  function hasNonEmptyUsagePaths(pathsByCode) {
    if (pathsByCode instanceof Map) {
      for (const list of pathsByCode.values()) {
        if (Array.isArray(list) && list.length) return true;
      }
      return false;
    }
    if (pathsByCode && typeof pathsByCode === "object") {
      return Object.keys(pathsByCode).some((key) => {
        const list = pathsByCode[key];
        return Array.isArray(list) && list.length > 0;
      });
    }
    return false;
  }

  function shouldWriteUsageCache({ failedCount, completed, pathsByCode }) {
    if (!completed || failedCount > 0) return false;
    return hasNonEmptyUsagePaths(pathsByCode);
  }

  function extractMentionedCodes(text) {
    const found = [];
    if (!text) return found;
    CODE_PULL.lastIndex = 0;
    let match;
    while ((match = CODE_PULL.exec(text))) {
      const code = match[1] || match[2] || match[3] || match[4];
      if (code) found.push(code);
    }
    return found;
  }

  function collectStrings(value, out) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
    else if (value && typeof value === "object") {
      Object.keys(value).forEach((key) => collectStrings(value[key], out));
    }
  }

  function pageHaystack(page) {
    const parts = [];
    collectStrings(page && page.name, parts);
    collectStrings(page && page.desc, parts);
    if (page && Array.isArray(page.body)) {
      page.body.forEach((section) => collectStrings(section && section.content, parts));
    }
    return parts.join("\n");
  }

  function usagePathsForCode(pathsByCode, code) {
    if (!code || !pathsByCode) return [];
    const lookup = (entryCode) => {
      if (pathsByCode instanceof Map) return pathsByCode.get(entryCode);
      return pathsByCode[entryCode];
    };
    const direct = lookup(code);
    if (Array.isArray(direct) && direct.length) return direct;
    if (code.length > 3 && code.slice(-3) === "_th") {
      const base = lookup(code.slice(0, -3));
      if (Array.isArray(base) && base.length) return base;
    }
    return [];
  }

  function unusedCodes(items, pathsByCode, completed, failedCount) {
    if (!completed || failedCount > 0 || !Array.isArray(items)) return [];
    return items
      .map((item) => item && (item.code || (item.binary && item.binary.code)))
      .filter((code) => code && usagePathsForCode(pathsByCode, code).length === 0);
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
      headers.set("Authorization", "Bearer " + token);
    }
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    return headers;
  }

  async function getFrameworkAppClient() {
    const globalClient = typeof window !== "undefined" ? window.Plus4U5?.Utils?.AppClient : null;
    if (globalClient) return globalClient;

    const loader = typeof window !== "undefined" ? window.Uu5Loader : null;
    if (!loader?.import) return null;

    try {
      const plus4uModule = loader.get?.("uu_plus4u5g02") || (await loader.import("uu_plus4u5g02"));
      return plus4uModule?.Utils?.AppClient || null;
    } catch {
      return null;
    }
  }

  async function fetchBookKitJson(baseUri, command, dtoIn) {
    const requestUrl = new URL(baseUri + "/" + command);
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
      const response = await appClient.get(requestUrl.toString(), {});
      return response?.data || response;
    }

    const attempts = [
      () =>
        fetch(requestUrl.toString(), {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        }),
      () =>
        fetch(requestUrl.toString(), {
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

      lastError = new Error(
        json?.uuAppErrorMap
          ? Object.values(json.uuAppErrorMap)[0]?.message || response.statusText
          : response.statusText
      );
      lastError.status = response.status;
      lastError.body = json || text;
      if (response.status !== 401 && response.status !== 403) {
        throw lastError;
      }
    }

    throw lastError || new Error("BookKit command " + command + " failed.");
  }

  function normalizeLanguage(value) {
    if (typeof value !== "string") return "";
    const code = value.trim().slice(0, 2).toLowerCase();
    return LANGUAGES.indexOf(code) === -1 ? "" : code;
  }

  function readLanguageFrom(getter) {
    try {
      return normalizeLanguage(getter());
    } catch {
      return "";
    }
  }

  function detectLanguage() {
    if (typeof window === "undefined") return FALLBACK_LANGUAGE;
    return (
      readLanguageFrom(() => window.UU5?.Common?.Tools?.getLanguage()) ||
      readLanguageFrom(() => window.Uu5g05?.Utils?.Language?.getLanguage()) ||
      readLanguageFrom(() => window.Uu5g05?.Lsi?.getLanguage()) ||
      readLanguageFrom(() => document.documentElement.lang) ||
      readLanguageFrom(() => navigator.language) ||
      FALLBACK_LANGUAGE
    );
  }

  let languageCache = { code: "", ts: 0 };

  function language() {
    const now = Date.now();
    if (!languageCache.code || now - languageCache.ts > LANGUAGE_CACHE_MS) {
      languageCache = { code: detectLanguage(), ts: now };
    }
    return languageCache.code;
  }

  function t(key, params) {
    const item = LSI[key];
    let text = (item && (item[language()] || item[FALLBACK_LANGUAGE])) || "";
    if (params) {
      Object.keys(params).forEach((name) => {
        text = text.split("{" + name + "}").join(String(params[name]));
      });
    }
    return text;
  }

  function lsiText(label) {
    if (!label) return "";
    if (typeof label === "string") return label;
    return (
      label[language()] ||
      label[FALLBACK_LANGUAGE] ||
      Object.keys(label)
        .map((key) => label[key])
        .find((value) => typeof value === "string") ||
      ""
    );
  }

  const sizeByCode = new Map();
  const sizeByFilename = new Map();

  const usageScan = {
    active: false,
    running: false,
    done: false,
    doneCount: 0,
    totalCount: 0,
    failedCount: 0,
    error: null,
    pathsByCode: new Map(),
  };

  let trackedAwid = "";
  let sizesFetchedForAwid = "";
  let renderScheduled = false;
  let sizeSorterAdded = false;
  let activeSizeFetchPromise = null;
  let sizeSorterTimer = null;

  function isListCmd(url) {
    return typeof url === "string" && LIST_CMD_RE.test(url);
  }

  function ingest(payload) {
    const itemList = payload && payload.itemList;
    if (!Array.isArray(itemList)) return;

    let changed = false;
    for (const item of itemList) {
      if (!item || typeof item.size !== "number") continue;
      if (item.code && sizeByCode.get(item.code) !== item.size) {
        sizeByCode.set(item.code, item.size);
        changed = true;
      }
      if (item.filename) {
        const known = sizeByFilename.get(item.filename);
        sizeByFilename.set(
          item.filename,
          sizeByFilename.has(item.filename) && known !== item.size ? null : item.size
        );
      }
    }
    if (changed) scheduleRender();
  }

  function hookNetworkForSizes() {
    if (typeof window === "undefined" || window[NET_HOOK_FLAG]) return;
    window[NET_HOOK_FLAG] = true;

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__gmBkFmListCmd = isListCmd(typeof url === "string" ? url : String(url));
      return origOpen.apply(this, arguments);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this.__gmBkFmListCmd) {
        this.addEventListener("load", () => {
          try {
            const type = this.responseType;
            if (type === "json") ingest(this.response);
            else if (type === "" || type === "text") ingest(JSON.parse(this.responseText));
          } catch {
            /* not a JSON response we understand */
          }
        });
      }
      return origSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input) {
        const url = typeof input === "string" ? input : input && input.url;
        const promise = origFetch.apply(this, arguments);
        if (isListCmd(url)) {
          promise
            .then((response) => response.clone().json().then(ingest))
            .catch(() => {});
        }
        return promise;
      };
    }
  }

  async function activelyFetchSizes(baseUri) {
    if (!baseUri) return;
    const commands = ["listBinaries", "listDictionaryEntries", "listPublicDictionaryEntries"];
    for (const cmd of commands) {
      try {
        const dtoOut = await fetchBookKitJson(baseUri, cmd, {
          pageInfo: { pageSize: 1000, pageIndex: 0 },
        });
        ingest(dtoOut);
      } catch {
        /* best-effort */
      }
    }
  }

  function scheduleActiveSizeFetch() {
    const fm = findFileManager();
    if (!fm) return;
    const book = parseBookBaseFromUrl(typeof location !== "undefined" ? location.href : "");
    if (!book?.baseUri) return;
    if (sizesFetchedForAwid === book.awid || activeSizeFetchPromise) return;
    sizesFetchedForAwid = book.awid;
    activeSizeFetchPromise = activelyFetchSizes(book.baseUri).finally(() => {
      activeSizeFetchPromise = null;
    });
  }

  function reactFiber(node) {
    const fiberKey = Object.keys(node).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );
    return fiberKey ? node[fiberKey] : null;
  }

  function looksLikeBinary(value) {
    return (
      value &&
      typeof value === "object" &&
      (typeof value.size === "number" || typeof value.filename === "string" || value.contentType)
    );
  }

  function binaryFromReactProps(tile) {
    let fiber = reactFiber(tile);
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props) continue;
      const data = props.data;
      const candidates = [data && data.binary, data && data.data, data, props.binary];
      for (const candidate of candidates) {
        if (looksLikeBinary(candidate)) return candidate;
      }
    }
    return null;
  }

  function sizeFromReactProps(tile) {
    const binary = binaryFromReactProps(tile);
    return binary && typeof binary.size === "number" ? binary.size : null;
  }

  function resolveSize(tile) {
    const titled = tile.querySelectorAll("[title]");
    for (const element of titled) {
      const size = sizeByCode.get(element.getAttribute("title"));
      if (typeof size === "number") return size;
    }
    for (const element of titled) {
      const size = sizeByFilename.get(element.getAttribute("title"));
      if (typeof size === "number") return size;
    }
    return sizeFromReactProps(tile);
  }

  function resolveCode(tile) {
    const binary = binaryFromReactProps(tile);
    if (binary && binary.code) return binary.code;
    for (const element of tile.querySelectorAll("[title]")) {
      const title = element.getAttribute("title");
      if (title && sizeByCode.has(title)) return title;
    }
    return null;
  }

  function usagePathsFor(code) {
    return usagePathsForCode(usageScan.pathsByCode, code);
  }

  function tileChild(tile, className, create) {
    let node = tile.querySelector(":scope > ." + className);
    if (node || !create) return node;
    node = document.createElement("div");
    node.className = className;
    tile.appendChild(node);
    return node;
  }

  function dropTileChild(tile, className) {
    const node = tileChild(tile, className, false);
    if (node) node.remove();
  }

  function cornerChild(tile, className, create) {
    let host = tile.querySelector(":scope > ." + CORNER_CLASS);
    if (!host) {
      if (!create) return null;
      host = document.createElement("div");
      host.className = CORNER_CLASS;
      tile.appendChild(host);
    }
    let node = host.querySelector(":scope > ." + className);
    if (node || !create) return node;
    node = document.createElement("div");
    node.className = className;
    host.appendChild(node);
    return node;
  }

  function dropCornerChild(tile, className) {
    const node = cornerChild(tile, className, false);
    if (node) node.remove();
  }

  function clearUsageOnTile(tile) {
    tile.classList.remove(UNUSED_CLASS);
    dropTileChild(tile, OVERLAY_CLASS);
    dropCornerChild(tile, MARK_CLASS);
    if (tile.getAttribute("data-bk-usage-title") === "1") {
      tile.removeAttribute("title");
      tile.removeAttribute("data-bk-usage-title");
    }
  }

  function markUsage(tile, text, tooltip, unused) {
    tile.classList.toggle(UNUSED_CLASS, unused);
    if (unused) tileChild(tile, OVERLAY_CLASS, true);
    else dropTileChild(tile, OVERLAY_CLASS);

    const mark = cornerChild(tile, MARK_CLASS, true);
    mark.classList.toggle(MARK_UNUSED_CLASS, unused);
    if (mark.textContent !== text) mark.textContent = text;
    if (mark.getAttribute("title") !== tooltip) mark.setAttribute("title", tooltip);

    if (tile.getAttribute("title") !== tooltip) tile.setAttribute("title", tooltip);
    tile.setAttribute("data-bk-usage-title", "1");
  }

  function applyUsageOnTile(tile) {
    if (!usageScan.active) {
      clearUsageOnTile(tile);
      return;
    }
    const code = resolveCode(tile);
    if (!code) {
      clearUsageOnTile(tile);
      return;
    }
    const paths = usagePathsFor(code);
    if (paths.length) {
      markUsage(tile, paths.length + "×", paths.join("\n"), false);
      return;
    }
    if (!usageScan.done) {
      clearUsageOnTile(tile);
      return;
    }
    if (usageScan.failedCount > 0) {
      clearUsageOnTile(tile);
      return;
    }
    markUsage(tile, "0×", t("unusedHint"), true);
  }

  function render() {
    syncBookContext();
    ensureUsageButton();
    scheduleActiveSizeFetch();

    for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
      applyUsageOnTile(tile);

      const size = resolveSize(tile);
      if (size == null) {
        dropCornerChild(tile, BADGE_CLASS);
        continue;
      }

      const badge = cornerChild(tile, BADGE_CLASS, true);
      const text = formatSize(size);
      if (badge.textContent !== text) {
        badge.textContent = text;
        badge.title = size.toLocaleString() + " B";
      }
    }
  }

  function scheduleRender() {
    if (renderScheduled || typeof requestAnimationFrame !== "function") return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function injectStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "\n      ." +
      CORNER_CLASS +
      " {\n        position: absolute;\n        right: 6px;\n        bottom: 6px;\n        z-index: 6;\n        display: flex;\n        align-items: center;\n        gap: 4px;\n        pointer-events: none;\n      }\n      ." +
      BADGE_CLASS +
      " {\n        order: 2;\n        padding: 1px 6px;\n        border-radius: 10px;\n        background: rgba(0, 0, 0, 0.62);\n        color: #fff;\n        font-size: 11px;\n        line-height: 16px;\n        font-weight: 500;\n        white-space: nowrap;\n      }\n      " +
      TILE_SELECTOR +
      "." +
      UNUSED_CLASS +
      " {\n        background-color: rgba(220, 53, 69, 0.12) !important;\n      }\n      ." +
      OVERLAY_CLASS +
      " {\n        position: absolute;\n        inset: 0;\n        z-index: 4;\n        background: rgba(220, 53, 69, 0.12);\n        pointer-events: none;\n      }\n      ." +
      MARK_CLASS +
      " {\n        order: 1;\n        padding: 1px 6px;\n        border-radius: 10px;\n        background: rgba(0, 0, 0, 0.62);\n        color: #fff;\n        font-size: 11px;\n        line-height: 16px;\n        font-weight: 500;\n        white-space: nowrap;\n        cursor: help;\n        pointer-events: auto;\n      }\n      ." +
      MARK_UNUSED_CLASS +
      " {\n        background: rgba(198, 40, 40, 0.9);\n      }\n      ." +
      BUTTON_CLASS +
      ",\n      ." +
      SELECT_UNUSED_BUTTON_CLASS +
      " {\n        white-space: nowrap;\n      }\n      ." +
      BUTTON_FALLBACK_CLASS +
      " {\n        margin: 8px 12px 8px 0;\n        padding: 6px 14px;\n        font-size: 14px;\n        line-height: 20px;\n        border: 1px solid rgba(0, 0, 0, 0.18);\n        border-radius: 4px;\n        background: #fff;\n        color: #212121;\n        cursor: pointer;\n      }\n      ." +
      BUTTON_FALLBACK_CLASS +
      ":hover:not(:disabled) {\n        background: #f5f5f5;\n      }\n      ." +
      BUTTON_CLASS +
      '[aria-disabled="true"],\n      .' +
      BUTTON_CLASS +
      ":disabled,\n      ." +
      SELECT_UNUSED_BUTTON_CLASS +
      '[aria-disabled="true"],\n      .' +
      SELECT_UNUSED_BUTTON_CLASS +
      ":disabled {\n        opacity: 0.65;\n        cursor: default;\n      }\n    ";
    document.documentElement.appendChild(style);
  }

  function findFileManager() {
    const byClass = document.querySelector(FM_SELECTOR);
    if (byClass) return byClass;
    const tile = document.querySelector(TILE_SELECTOR);
    return tile && tile.closest("[class*='file-manager']");
  }

  function isUsableButton(node) {
    if (node.classList.contains(BUTTON_CLASS) || node.classList.contains(SELECT_UNUSED_BUTTON_CLASS)) return false;
    if (node.closest(TILE_SELECTOR)) return false;
    if (node.closest("[class*='modal'], [class*='popover'], [class*='menu']")) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buttonRow(fm) {
    const rows = new Map();
    for (const node of fm.querySelectorAll("button, [role='button']")) {
      if (!isUsableButton(node)) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      let siblings = rows.get(parent);
      if (!siblings) rows.set(parent, (siblings = []));
      siblings.push(node);
    }

    let best = null;
    rows.forEach((siblings, parent) => {
      if (siblings.length < 2) return;
      const top = parent.getBoundingClientRect().top;
      if (!best || top < best.top) best = { parent: parent, siblings: siblings, top: top };
    });
    return best;
  }

  function buildUsageButton(sample) {
    const button = document.createElement(sample ? sample.tagName.toLowerCase() : "button");
    if (sample) {
      button.className = sample.className;
      const role = sample.getAttribute("role");
      if (role) button.setAttribute("role", role);
    } else {
      button.className = BUTTON_FALLBACK_CLASS;
    }
    button.classList.add(BUTTON_CLASS);
    if (button.tagName === "BUTTON") button.type = "button";
    button.title = t("buttonTitle");
    button.textContent = t("buttonLabel");
    button.addEventListener("click", () => {
      if (!usageScan.running) startUsageScan();
    });
    return button;
  }

  function fileManagerController(fm) {
    let fiber = reactFiber(fm);
    for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
      const controller = fiber.stateNode && fiber.stateNode._listController;
      if (
        controller &&
        typeof controller.getData === "function" &&
        typeof controller.getSelectedItemList === "function" &&
        typeof controller.addSelectedItem === "function"
      ) {
        return controller;
      }
    }
    return null;
  }

  function addCodesToSelection(controller, codes) {
    if (
      !controller ||
      typeof controller.getSelectedItemList !== "function" ||
      typeof controller.addSelectedItem !== "function"
    ) {
      return 0;
    }

    const selectedCodes = new Set(
      controller
        .getSelectedItemList()
        .map((item) => item && (item.code || (item.binary && item.binary.code)))
        .filter(Boolean)
    );
    let selected = 0;
    for (const code of codes) {
      if (!code || selectedCodes.has(code)) continue;
      controller.addSelectedItem(code);
      selectedCodes.add(code);
      selected++;
    }
    return selected;
  }

  function selectUnusedAttachments() {
    if (!usageScan.done || usageScan.failedCount > 0 || usageScan.error) return 0;

    const fm = findFileManager();
    if (!fm) return 0;

    const controller = fileManagerController(fm);
    if (controller) {
      const items = controller.getData();
      const codes = new Set(unusedCodes(items, usageScan.pathsByCode, true, 0));
      return addCodesToSelection(controller, codes);
    }

    // Fallback for a future FileManager without the current list controller.
    let selected = 0;
    for (const tile of fm.querySelectorAll(TILE_SELECTOR + "." + UNUSED_CLASS)) {
      const button = tile.querySelector(".select-button");
      if (!button) continue;
      button.click();
      selected++;
    }
    return selected;
  }

  function buildSelectUnusedButton(sample) {
    const button = document.createElement(sample ? sample.tagName.toLowerCase() : "button");
    if (sample) {
      button.className = sample.className;
      const role = sample.getAttribute("role");
      if (role) button.setAttribute("role", role);
    } else {
      button.className = BUTTON_FALLBACK_CLASS;
    }
    button.classList.add(SELECT_UNUSED_BUTTON_CLASS);
    if (button.tagName === "BUTTON") button.type = "button";
    button.addEventListener("click", selectUnusedAttachments);
    return button;
  }

  function buttonLabel() {
    if (usageScan.running) {
      return t("buttonProgress") + " " + usageScan.doneCount + "/" + usageScan.totalCount;
    }
    if (usageScan.error) return t("buttonFailed");
    return t("buttonLabel");
  }

  function buttonTitle() {
    const title = t("buttonTitle");
    if (usageScan.error) return title + "\n\n" + t("errorLabel") + ": " + usageScan.error;
    if (usageScan.failedCount) {
      const detail = t("pagesFailed", {
        failed: usageScan.failedCount,
        total: usageScan.totalCount,
      });
      return title + "\n\n" + t("warningLabel") + ": " + detail;
    }
    return title;
  }

  function syncUsageButton(button) {
    const disabled = usageScan.running;
    if (button.tagName === "BUTTON") button.disabled = disabled;
    button.setAttribute("aria-disabled", disabled ? "true" : "false");

    const label = buttonLabel();
    if (button.textContent !== label) button.textContent = label;

    const title = buttonTitle();
    if (button.getAttribute("title") !== title) button.setAttribute("title", title);
  }

  function syncSelectUnusedButton(button) {
    const disabled =
      usageScan.running || !usageScan.done || usageScan.failedCount > 0 || Boolean(usageScan.error);
    if (button.tagName === "BUTTON") button.disabled = disabled;
    button.setAttribute("aria-disabled", disabled ? "true" : "false");

    const label = t("selectUnusedLabel");
    if (button.textContent !== label) button.textContent = label;

    const title = disabled ? t("selectUnusedUnavailable") : t("selectUnusedTitle");
    if (button.getAttribute("title") !== title) button.setAttribute("title", title);
  }

  function resetUsageVisualsIfFmGone(fm) {
    if (usageScan.running) return;
    if (fm || document.querySelector(TILE_SELECTOR)) return;
    if (!usageScan.active && !usageScan.done) return;
    usageScan.active = false;
    usageScan.done = false;
    usageScan.doneCount = 0;
    usageScan.totalCount = 0;
    usageScan.failedCount = 0;
    usageScan.error = null;
    usageScan.pathsByCode = new Map();
  }

  function ensureUsageButton() {
    const fm = findFileManager();
    resetUsageVisualsIfFmGone(fm);
    if (!fm) return;

    let button = document.querySelector("." + BUTTON_CLASS);
    let selectUnusedButton = document.querySelector("." + SELECT_UNUSED_BUTTON_CLASS);
    if (!button || !button.isConnected || !fm.contains(button)) {
      if (button) button.remove();
      if (selectUnusedButton) selectUnusedButton.remove();
      const row = buttonRow(fm);
      const host = row ? row.parent : fm;
      const sample = row && row.siblings[row.siblings.length - 1];
      button = buildUsageButton(sample);
      selectUnusedButton = buildSelectUnusedButton(sample);
      host.appendChild(button);
      host.appendChild(selectUnusedButton);
    } else if (!selectUnusedButton || !selectUnusedButton.isConnected || !fm.contains(selectUnusedButton)) {
      if (selectUnusedButton) selectUnusedButton.remove();
      selectUnusedButton = buildSelectUnusedButton(button);
      button.insertAdjacentElement("afterend", selectUnusedButton);
    }
    syncUsageButton(button);
    syncSelectUnusedButton(selectUnusedButton);
  }

  function bookBaseUri() {
    const book = parseBookBaseFromUrl(typeof location !== "undefined" ? location.href : "");
    return book ? book.baseUri : null;
  }

  function bookAwid() {
    const book = parseBookBaseFromUrl(typeof location !== "undefined" ? location.href : "");
    return book ? book.awid : "";
  }

  function cacheKey() {
    return CACHE_KEY_PREFIX + language() + ":" + bookAwid();
  }

  function readUsageCache(structure) {
    if (typeof sessionStorage === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(cacheKey());
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || !data.paths) return null;
      if (Date.now() - data.ts > CACHE_TTL_MS) return null;
      if (data.rev !== structureRev(structure)) return null;
      return Object.keys(data.paths).length ? data.paths : null;
    } catch {
      return null;
    }
  }

  function writeUsageCache(structure, pathsByCode) {
    if (!shouldWriteUsageCache({ failedCount: 0, completed: true, pathsByCode })) return;
    const paths = {};
    pathsByCode.forEach((list, code) => {
      paths[code] = list;
    });
    try {
      sessionStorage.setItem(
        cacheKey(),
        JSON.stringify({ rev: structureRev(structure), ts: Date.now(), paths: paths })
      );
    } catch {
      /* storage quota / private mode */
    }
  }

  function applyCachedPaths(paths) {
    const map = new Map();
    Object.keys(paths).forEach((code) => {
      const list = paths[code];
      if (Array.isArray(list) && list.length) map.set(code, list.slice());
    });
    usageScan.pathsByCode = map;
  }

  async function uuGet(cmd, params) {
    const base = bookBaseUri();
    if (!base) throw new Error("missing book base uri");
    try {
      return await fetchBookKitJson(base, cmd, params || {});
    } catch (error) {
      const status = error && error.status;
      const hint = status === 401 ? " (" + t("missingToken") + ")" : "";
      throw new Error(cmd + " → " + ((error && error.message) || String(error)) + hint);
    }
  }

  function recordHit(code, path) {
    if (!code || !path) return;
    let list = usageScan.pathsByCode.get(code);
    if (!list) {
      list = [];
      usageScan.pathsByCode.set(code, list);
    }
    if (list.indexOf(path) === -1) list.push(path);
  }

  function scanHaystack(text, path) {
    extractMentionedCodes(text).forEach((code) => recordHit(code, path));
  }

  function pageOrderAndPaths(itemMap) {
    const order = [];
    const paths = {};
    if (!itemMap) return { order: order, paths: paths };

    const start = Object.keys(itemMap).find((code) => {
      const prev = itemMap[code] && itemMap[code].previous;
      return prev === "" || prev == null;
    });
    const stack = [];
    let code = start;
    const seen = Object.create(null);
    while (code && itemMap[code] && !seen[code]) {
      seen[code] = true;
      const item = itemMap[code];
      const indent = typeof item.indent === "number" ? item.indent : 0;
      stack.length = indent;
      stack[indent] = lsiText(item.label) || code;
      paths[code] = stack.filter(Boolean).join(" > ");
      order.push(code);
      code = item.next;
    }
    Object.keys(itemMap).forEach((extra) => {
      if (!seen[extra]) {
        order.push(extra);
        if (!paths[extra]) paths[extra] = lsiText(itemMap[extra].label) || extra;
      }
    });
    return { order: order, paths: paths };
  }

  async function listAllPageCodes() {
    const codes = new Map();
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const dtoOut = await uuGet("listPages", {
        pageInfo: { pageSize: 1000, pageIndex: pageIndex },
      });
      const itemList = Array.isArray(dtoOut && dtoOut.itemList) ? dtoOut.itemList : [];
      itemList.forEach((item) => {
        if (item && item.code && !codes.has(item.code)) codes.set(item.code, lsiText(item.name));
      });

      const pageInfo = dtoOut && dtoOut.pageInfo;
      if (!pageInfo || (pageInfo.pageIndex + 1) * pageInfo.pageSize >= pageInfo.total) break;
    }
    return codes;
  }

  async function mapPool(items, limit, fn) {
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const current = index++;
        await fn(items[current], current);
      }
    }
    const workers = [];
    const count = Math.min(limit, items.length) || 0;
    for (let i = 0; i < count; i++) workers.push(worker());
    await Promise.all(workers);
  }

  async function startUsageScan() {
    usageScan.active = true;
    usageScan.running = true;
    usageScan.done = false;
    usageScan.doneCount = 0;
    usageScan.totalCount = 0;
    usageScan.failedCount = 0;
    usageScan.error = null;
    usageScan.pathsByCode = new Map();
    ensureUsageButton();
    scheduleRender();

    let completed = false;
    try {
      const structure = await uuGet("getBookStructure");
      const cached = readUsageCache(structure);
      if (cached) {
        applyCachedPaths(cached);
        usageScan.done = true;
        usageScan.running = false;
        ensureUsageButton();
        scheduleRender();
        return;
      }

      const walked = pageOrderAndPaths(structure.itemMap);
      const paths = walked.paths;
      const pageCodes = walked.order.slice();

      let extra = new Map();
      try {
        extra = await listAllPageCodes();
      } catch {
        /* without listPages only the menu tree remains */
      }
      extra.forEach((name, code) => {
        if (paths[code]) return;
        paths[code] = name || code;
        pageCodes.push(code);
      });

      usageScan.totalCount = pageCodes.length;
      ensureUsageButton();

      try {
        const intro = await uuGet("getIntro");
        scanHaystack(pageHaystack(intro) || JSON.stringify(intro), t("bookIntro"));
      } catch {
        /* the intro does not have to exist */
      }

      await mapPool(pageCodes, SCAN_CONCURRENCY, async (pageCode) => {
        try {
          const page = await uuGet("loadPage", { code: pageCode });
          scanHaystack(pageHaystack(page), paths[pageCode] || pageCode);
        } catch {
          usageScan.failedCount++;
        }
        usageScan.doneCount++;
        ensureUsageButton();
        scheduleRender();
      });

      if (pageCodes.length && usageScan.failedCount === pageCodes.length) {
        throw new Error(t("noPageLoaded"));
      }

      completed = true;
      if (shouldWriteUsageCache({ failedCount: usageScan.failedCount, completed, pathsByCode: usageScan.pathsByCode })) {
        writeUsageCache(structure, usageScan.pathsByCode);
      }
    } catch (error) {
      usageScan.active = false;
      usageScan.error = (error && error.message) || String(error);
    }

    usageScan.running = false;
    usageScan.done = completed;
    ensureUsageButton();
    scheduleRender();
  }

  function clearBookState() {
    sizeByCode.clear();
    sizeByFilename.clear();
    sizesFetchedForAwid = "";
    usageScan.active = false;
    usageScan.running = false;
    usageScan.done = false;
    usageScan.doneCount = 0;
    usageScan.totalCount = 0;
    usageScan.failedCount = 0;
    usageScan.error = null;
    usageScan.pathsByCode = new Map();
  }

  function syncBookContext() {
    const awid = bookAwid();
    if (!awid) return;
    if (trackedAwid && trackedAwid !== awid) {
      clearBookState();
    }
    trackedAwid = awid;
  }

  function addSizeSorter(fileManager) {
    for (let component = fileManager; component; component = component.hocFor) {
      const sortItems = component.defaultProps && component.defaultProps.sortItems;
      if (!Array.isArray(sortItems)) continue;
      if (!sortItems.some((item) => item.key === SIZE_SORT_KEY)) {
        sortItems.push(createSizeSortItem(LSI.sizeSort));
      }
      sizeSorterAdded = true;
      return;
    }
  }

  function hookLibraryImport() {
    const loader = typeof window !== "undefined" ? window.Uu5Loader : null;
    if (!loader || typeof loader.import !== "function" || loader[SIZE_SORTER_HOOK_FLAG]) return;

    const origImport = loader.import;
    loader.import = function () {
      const result = origImport.apply(this, arguments);
      if (result && typeof result.then === "function") {
        result.then(
          (module) => {
            try {
              if (module && module.FileManager) addSizeSorter(module.FileManager);
            } catch {
              /* the module does not contain the attachments library */
            }
          },
          () => {}
        );
      }
      return result;
    };
    loader[SIZE_SORTER_HOOK_FLAG] = true;
  }

  function trySizeSorter() {
    hookLibraryImport();
    try {
      const files = typeof window !== "undefined" && window.Plus4U5 && window.Plus4U5.Files;
      if (files && files.FileManager) addSizeSorter(files.FileManager);
    } catch {
      /* the library is not loaded yet */
    }
    return sizeSorterAdded;
  }

  function installSizeSorter() {
    if (trySizeSorter()) return;

    let elapsed = 0;
    sizeSorterTimer = setInterval(() => {
      elapsed += SIZE_SORTER_RETRY_MS;
      const fmVisible = Boolean(findFileManager());
      if (trySizeSorter() || elapsed >= SIZE_SORTER_MAX_MS || (!fmVisible && elapsed > SIZE_SORTER_RETRY_MS)) {
        clearInterval(sizeSorterTimer);
        sizeSorterTimer = null;
      }
    }, SIZE_SORTER_RETRY_MS);
  }

  function observeTiles() {
    new MutationObserver(scheduleRender).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    scheduleRender();
  }

  function run() {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window[SCRIPT_FLAG]) return;
    window[SCRIPT_FLAG] = true;

    hookNetworkForSizes();
    injectStyles();
    installSizeSorter();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", observeTiles, { once: true });
    } else {
      observeTiles();
    }
  }

  return {
    parseBookBaseFromUrl,
    formatSize,
    itemSize,
    extractMentionedCodes,
    pageHaystack,
    structureRev,
    shouldWriteUsageCache,
    compareBySize,
    createSizeSortItem,
    usagePathsForCode,
    unusedCodes,
    addCodesToSelection,
    SCRIPT_VERSION,
    run,
  };
});
