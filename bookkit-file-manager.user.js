// ==UserScript==
// @name         uuBookKit – FileManager
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.4.12
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
  const SCRIPT_VERSION = "1.4.12";
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
  const SCAN_CONCURRENCY = 2;
  const LARGE_SCAN_PAGE_COUNT = 1000;
  const LARGE_SCAN_CONCURRENCY = 2;
  const SCAN_INITIAL_GAP_MS = 75;
  const SCAN_GAP_MIN_MS = 15;
  const SCAN_GAP_MAX_MS = 2000;
  const SCAN_SUCCESS_STREAK_LIMIT = 10;
  const SCAN_SUCCESS_GAP_FACTOR = 0.8;
  const SCAN_FAILURE_MIN_GAP_MS = 250;
  const LOAD_PAGE_TIMEOUT_MS = 15000;
  const PROGRESS_UI_THROTTLE_MS = 200;
  const HAYSTACK_REGEX_WINDOW = 80000;
  const HAYSTACK_REGEX_OVERLAP = 256;
  const HAYSTACK_COOPERATIVE_NODE_BATCH = 256;
  const HAYSTACK_COOPERATIVE_BUDGET_MS = 7;
  const HAYSTACK_REGEX_MATCH_BUDGET_MS = 7;
  const HAYSTACK_REGEX_MATCH_BATCH = 200;
  const HAYSTACK_REGEX_MATCH_LIMIT = 50000;
  const HAYSTACK_REGEX_MATCH_LIMIT_ERROR =
    "gm-bk-att-usage:haystack regex match limit exceeded";
  const DEFAULT_HAYSTACK_LIMITS = {
    maxNodes: 100000,
    maxStringData: 5 * 1024 * 1024,
  };
  const HAYSTACK_SKIP_KEYS = new Set([
    "sys",
    "uuAppErrorMap",
    "authorizationResult",
    "session",
    "memoizedProps",
    "stateNode",
  ]);
  const HAYSTACK_JSON_KEYS = new Set([
    "src",
    "dataUri",
    "srcUri",
    "href",
    "code",
    "binaryCode",
    "attachmentCode",
    "fileCode",
  ]);
  const SIZE_SORT_KEY = "size";
  const SIZE_SORTER_RETRY_MS = 200;
  const SIZE_SORTER_MAX_MS = 10000;

  const LIST_CMD_RE = /\/list(Binaries|DictionaryEntries|PublicDictionaryEntries)(\?|$)/;
  const BOOK_BASE_PATH_RE = /^(.*?\/uu-bookkit-maing01\/(?:\d+-)?[a-z0-9]{32})/i;
  const AWID_RE = /uu-bookkit-maing01\/((?:\d+-)?[a-z0-9]{32})/i;

  const CODE_DIRECT_ATTR_KEYS = "code|src|dataUri|binaryCode|attachmentCode|fileCode";
  const CODE_JSON_KEYS = "code|src|dataUri|srcUri|href|binaryCode|attachmentCode|fileCode";
  const CODE_PULL_DIRECT_ATTR = new RegExp(
    "(?:^|[^\\w-])(?:" + CODE_DIRECT_ATTR_KEYS + ')\\s*=\\s*["\']?([^\\s"\'<>/]+)',
    "gi"
  );
  const CODE_PULL_QUERY = /[?&]code=([^&"'#\s]+)/gi;
  const CODE_PULL_JSON = new RegExp('"(?:' + CODE_JSON_KEYS + ')"\\s*:\\s*"([^"]+)"', "gi");
  const CODE_PULL_URL_ATTR = /(?:srcUri|href)\s*=\s*["']([^"']+)["']/gi;

  const CODE_PULL_PATTERNS = [
    CODE_PULL_DIRECT_ATTR,
    CODE_PULL_QUERY,
    CODE_PULL_URL_ATTR,
    CODE_PULL_JSON,
  ];

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
      cs: "Označit kandidáty",
      en: "Select candidates",
      uk: "Вибрати кандидатів",
    },
    selectUnusedTitle: {
      cs: "Přidá heuristicky rozpoznané kandidáty na nepoužité přílohy do výběru pro hromadné akce.",
      en: "Adds heuristically identified candidate unused attachments to the bulk-action selection.",
      uk: "Додає евристично визначених кандидатів на невикористані вкладення до вибору для масових дій.",
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
    scanHostGone: {
      cs: "FileManager během ověření zmizel (BookKit Unknown Error / reload) — scan zastaven, aby se neposílaly další loadPage",
      en: "FileManager disappeared during the check (BookKit Unknown Error / reload) — scan stopped so further loadPage calls are not sent",
      uk: "FileManager зник під час перевірки (BookKit Unknown Error / reload) — сканування зупинено",
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

  function normalizeHaystackText(text) {
    if (!text) return "";
    const value = String(text);
    if (!value.includes("&")) return value;
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function decodeMentionedCode(value, hooks) {
    if (!value) return value;
    if (hooks && typeof hooks.onDecodeMentionedCode === "function") {
      hooks.onDecodeMentionedCode();
    }
    let decoded = normalizeHaystackText(value);
    if (decoded.includes("%")) {
      try {
        decoded = decodeURIComponent(decoded.replace(/\+/g, " "));
      } catch {
        /* keep partially decoded value */
      }
    }
    return decoded;
  }

  function advancePatternLastIndex(pattern, match) {
    if (match[0].length === 0) {
      pattern.lastIndex++;
    }
  }

  function pullCodesFromPattern(pattern, text, found) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      advancePatternLastIndex(pattern, match);
      pushMentionedCode(match[1], found);
    }
  }

  function pushMentionedCode(raw, found, hooks) {
    const code = decodeMentionedCode(raw, hooks);
    if (!code) return;
    if (/^https?:/i.test(code) || /[?&]code=/i.test(code)) {
      pullCodesFromPattern(CODE_PULL_QUERY, code, found);
      return;
    }
    found.push(code);
  }

  function createMentionedCodeScanState(found) {
    return {
      found,
      seenRaw: new Set(),
      matchCount: 0,
    };
  }

  function noteRegexMatch(state) {
    state.matchCount++;
    if (state.matchCount > HAYSTACK_REGEX_MATCH_LIMIT) {
      throw new Error(HAYSTACK_REGEX_MATCH_LIMIT_ERROR);
    }
  }

  async function pullCodesFromPatternAsync(pattern, text, state, hooks) {
    pattern.lastIndex = 0;
    let match;
    let matchesInBatch = 0;
    let budgetStart = Date.now();

    while ((match = pattern.exec(text))) {
      noteRegexMatch(state);
      advancePatternLastIndex(pattern, match);
      matchesInBatch++;
      if (
        matchesInBatch >= HAYSTACK_REGEX_MATCH_BATCH ||
        Date.now() - budgetStart >= HAYSTACK_REGEX_MATCH_BUDGET_MS
      ) {
        matchesInBatch = 0;
        budgetStart = Date.now();
        await yieldToBrowser();
      }
      const raw = match[1];
      if (!raw || state.seenRaw.has(raw)) continue;
      state.seenRaw.add(raw);
      await pushMentionedCodeAsync(raw, state, hooks);
    }
  }

  async function pushMentionedCodeAsync(raw, state, hooks) {
    const pending = [raw];
    while (pending.length) {
      const nextRaw = pending.shift();
      const code = decodeMentionedCode(nextRaw, hooks);
      if (!code) continue;
      if (/^https?:/i.test(code) || /[?&]code=/i.test(code)) {
        CODE_PULL_QUERY.lastIndex = 0;
        let match;
        let matchesInBatch = 0;
        let budgetStart = Date.now();
        while ((match = CODE_PULL_QUERY.exec(code))) {
          noteRegexMatch(state);
          advancePatternLastIndex(CODE_PULL_QUERY, match);
          const nestedRaw = match[1];
          if (!nestedRaw || state.seenRaw.has(nestedRaw)) continue;
          state.seenRaw.add(nestedRaw);
          pending.push(nestedRaw);
          matchesInBatch++;
          if (
            matchesInBatch >= HAYSTACK_REGEX_MATCH_BATCH ||
            Date.now() - budgetStart >= HAYSTACK_REGEX_MATCH_BUDGET_MS
          ) {
            matchesInBatch = 0;
            budgetStart = Date.now();
            await yieldToBrowser();
          }
        }
        continue;
      }
      state.found.push(code);
    }
  }

  async function scanChunkForMentionedCodesAsync(chunk, state, hooks) {
    for (const pattern of CODE_PULL_PATTERNS) {
      await pullCodesFromPatternAsync(pattern, chunk, state, hooks);
    }
  }

  function extractMentionedCodes(text) {
    const found = [];
    if (!text) return found;
    const normalized = normalizeHaystackText(text);
    const scanChunk = (chunk) => {
      pullCodesFromPattern(CODE_PULL_DIRECT_ATTR, chunk, found);
      pullCodesFromPattern(CODE_PULL_QUERY, chunk, found);
      pullCodesFromPattern(CODE_PULL_URL_ATTR, chunk, found);
      pullCodesFromPattern(CODE_PULL_JSON, chunk, found);
    };
    if (normalized.length <= HAYSTACK_REGEX_WINDOW) {
      scanChunk(normalized);
      return found;
    }
    const step = HAYSTACK_REGEX_WINDOW - HAYSTACK_REGEX_OVERLAP;
    for (let start = 0; start < normalized.length; start += step) {
      scanChunk(normalized.slice(start, start + HAYSTACK_REGEX_WINDOW));
    }
    return found;
  }

  async function extractMentionedCodesAsync(text, options) {
    const found = [];
    if (!text) return found;
    const hooks = options && options.hooks;
    const normalized = normalizeHaystackText(text);
    const state = createMentionedCodeScanState(found);
    const step = HAYSTACK_REGEX_WINDOW - HAYSTACK_REGEX_OVERLAP;
    for (let start = 0; start < normalized.length; start += step) {
      const end = Math.min(start + HAYSTACK_REGEX_WINDOW, normalized.length);
      await scanChunkForMentionedCodesAsync(normalized.slice(start, end), state, hooks);
      if (end < normalized.length) await yieldToBrowser();
    }
    return found;
  }

  function isLongDataUri(text) {
    return typeof text === "string" && text.length > 4096 && /^data:/i.test(text);
  }

  function isHaystackHostObject(value) {
    if (!value || typeof value !== "object") return false;
    if (value.nodeType != null) return true;
    if (typeof Element !== "undefined" && value instanceof Element) return true;
    if (typeof Window !== "undefined" && value instanceof Window) return true;
    return false;
  }

  function safeSerializeForHaystack(value) {
    if (value == null) return "";
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (_key, nested) => {
        if (typeof nested === "object" && nested !== null) {
          if (seen.has(nested)) return undefined;
          seen.add(nested);
        }
        return nested;
      });
    } catch {
      return "";
    }
  }

  function pageHaystack(page, limits) {
    if (!page) return "";
    const parts = [];
    const options = Object.assign({}, DEFAULT_HAYSTACK_LIMITS, limits || {});
    const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_HAYSTACK_LIMITS.maxNodes;
    const maxStringData = Number.isFinite(options.maxStringData)
      ? options.maxStringData
      : DEFAULT_HAYSTACK_LIMITS.maxStringData;
    const stack = [page];
    const seen = new WeakSet();
    let visitedNodes = 0;
    let stringData = 0;

    const addString = (text) => {
      stringData += text.length;
      if (stringData > maxStringData) {
        throw new Error("page haystack string limit exceeded");
      }
      parts.push(text);
    };

    while (stack.length) {
      const value = stack.pop();
      visitedNodes++;
      if (visitedNodes > maxNodes) {
        throw new Error("page haystack node limit exceeded");
      }
      if (typeof value === "string") {
        if (isLongDataUri(value)) continue;
        addString(value);
        continue;
      }
      if (value == null || typeof value !== "object") continue;
      if (isHaystackHostObject(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      let keys;
      try {
        keys = Object.keys(value);
      } catch {
        throw new Error("page haystack traversal failed");
      }
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        if (HAYSTACK_SKIP_KEYS.has(key)) continue;
        let nested;
        try {
          nested = value[key];
        } catch {
          throw new Error("page haystack traversal failed");
        }
        if (isLongDataUri(nested)) continue;
        if (typeof nested === "string" && HAYSTACK_JSON_KEYS.has(key)) {
          addString(JSON.stringify(key) + ":" + JSON.stringify(nested));
        }
        stack.push(nested);
      }
    }
    return parts.join("\n");
  }

  async function pageHaystackAsync(page, limits) {
    if (!page) return "";
    const parts = [];
    const options = Object.assign({}, DEFAULT_HAYSTACK_LIMITS, limits || {});
    const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_HAYSTACK_LIMITS.maxNodes;
    const maxStringData = Number.isFinite(options.maxStringData)
      ? options.maxStringData
      : DEFAULT_HAYSTACK_LIMITS.maxStringData;
    const stack = [page];
    const seen = new WeakSet();
    let visitedNodes = 0;
    let stringData = 0;
    let batchStart = Date.now();
    let batchNodes = 0;

    const addString = (text) => {
      stringData += text.length;
      if (stringData > maxStringData) {
        throw new Error("page haystack string limit exceeded");
      }
      parts.push(text);
    };

    while (stack.length) {
      const value = stack.pop();
      visitedNodes++;
      batchNodes++;
      if (visitedNodes > maxNodes) {
        throw new Error("page haystack node limit exceeded");
      }
      if (typeof value === "string") {
        if (!isLongDataUri(value)) addString(value);
      } else if (value != null && typeof value === "object" && !isHaystackHostObject(value)) {
        if (!seen.has(value)) {
          seen.add(value);
          let keys;
          try {
            keys = Object.keys(value);
          } catch {
            throw new Error("page haystack traversal failed");
          }
          for (let index = keys.length - 1; index >= 0; index--) {
            const key = keys[index];
            if (HAYSTACK_SKIP_KEYS.has(key)) continue;
            let nested;
            try {
              nested = value[key];
            } catch {
              throw new Error("page haystack traversal failed");
            }
            if (isLongDataUri(nested)) continue;
            if (typeof nested === "string" && HAYSTACK_JSON_KEYS.has(key)) {
              addString(JSON.stringify(key) + ":" + JSON.stringify(nested));
            }
            stack.push(nested);
          }
        }
      }

      if (
        stack.length &&
        (batchNodes >= HAYSTACK_COOPERATIVE_NODE_BATCH ||
          Date.now() - batchStart >= HAYSTACK_COOPERATIVE_BUDGET_MS)
      ) {
        await yieldToBrowser();
        batchStart = Date.now();
        batchNodes = 0;
      }
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

  function collectUuAppErrorCodes(body) {
    if (!body || typeof body !== "object") return [];
    const map = body.uuAppErrorMap;
    if (!map || typeof map !== "object") return [];
    const codes = [];
    Object.keys(map).forEach((key) => {
      codes.push(key);
      const entry = map[key];
      if (entry && typeof entry.code === "string") codes.push(entry.code);
    });
    return codes;
  }

  function copyBookKitErrorMeta(target, source) {
    if (!target || !source) return target;
    if (source.status != null) {
      target.status = source.status;
      target.statusCode = source.statusCode != null ? source.statusCode : source.status;
    } else if (source.statusCode != null) {
      target.statusCode = source.statusCode;
    }
    if (Array.isArray(source.uuAppErrorCodes)) {
      target.uuAppErrorCodes = source.uuAppErrorCodes.slice();
    }
    return target;
  }

  function isMissingIntroError(error) {
    if (!error) return false;
    const status = error.status != null ? error.status : error.statusCode;
    if (status === 404) return true;

    const parts = [];
    if (Array.isArray(error.uuAppErrorCodes)) parts.push(...error.uuAppErrorCodes);
    if (typeof error.message === "string") parts.push(error.message);
    const haystack = parts.join(" ").toLowerCase();
    const compact = haystack.replace(/[^a-z0-9]+/g, "");
    if (!compact.includes("intro")) return false;

    return (
      compact.includes("notfound") ||
      compact.includes("doesnotexist") ||
      compact.includes("missing")
    );
  }

  async function loadOptionalIntro(fetchFn) {
    try {
      return await fetchFn("getIntro");
    } catch (error) {
      if (isMissingIntroError(error)) return null;
      throw error;
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
      lastError.statusCode = response.status;
      const uuAppErrorCodes = collectUuAppErrorCodes(json);
      if (uuAppErrorCodes.length) lastError.uuAppErrorCodes = uuAppErrorCodes;
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

  function resetUsagePaths() {
    usageScan.pathsByCode = new Map();
    usageScan.pathSetsByCode = new Map();
  }

  const usageScan = {
    active: false,
    running: false,
    done: false,
    doneCount: 0,
    totalCount: 0,
    failedCount: 0,
    error: null,
    pathsByCode: new Map(),
    pathSetsByCode: new Map(),
  };

  let trackedAwid = "";
  let sizesFetchedForAwid = "";
  let renderScheduled = false;
  let progressUiTimer = null;
  let progressUiPending = false;
  let progressUiGeneration = 0;
  let usageScanGeneration = 0;
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
    if (changed && !usageScan.running) scheduleRender();
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
    if (usageScan.running || renderScheduled || typeof requestAnimationFrame !== "function") return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (usageScan.running) return;
      render();
    });
  }

  function clearProgressUiTimer() {
    if (progressUiTimer !== null) {
      clearTimeout(progressUiTimer);
      progressUiTimer = null;
    }
    progressUiPending = false;
    progressUiGeneration++;
  }

  function flushProgressUi() {
    if (progressUiTimer !== null) {
      clearTimeout(progressUiTimer);
      progressUiTimer = null;
    }
    progressUiPending = false;
    ensureUsageButton();
    if (!usageScan.running) scheduleRender();
  }

  function scheduleProgressUiUpdate(immediate) {
    if (immediate) {
      flushProgressUi();
      return;
    }
    progressUiPending = true;
    if (progressUiTimer !== null) return;
    const generation = progressUiGeneration;
    progressUiTimer = setTimeout(() => {
      progressUiTimer = null;
      if (generation !== progressUiGeneration || !progressUiPending) return;
      progressUiPending = false;
      ensureUsageButton();
      if (!usageScan.running) scheduleRender();
    }, PROGRESS_UI_THROTTLE_MS);
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
    clearProgressUiTimer();
    usageScan.active = false;
    usageScan.done = false;
    usageScan.doneCount = 0;
    usageScan.totalCount = 0;
    usageScan.failedCount = 0;
    usageScan.error = null;
    resetUsagePaths();
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

  async function uuGet(cmd, params) {
    const base = bookBaseUri();
    if (!base) throw new Error("missing book base uri");
    try {
      return await fetchBookKitJson(base, cmd, params || {});
    } catch (error) {
      const status = error && error.status;
      const hint = status === 401 ? " (" + t("missingToken") + ")" : "";
      const wrapped = new Error(cmd + " → " + ((error && error.message) || String(error)) + hint);
      copyBookKitErrorMeta(wrapped, error);
      throw wrapped;
    }
  }

  function recordUsageHit(pathsByCode, pathSetsByCode, code, path) {
    if (!code || !path) return;
    let list = pathsByCode.get(code);
    let membership = pathSetsByCode.get(code);
    if (!list) {
      list = [];
      pathsByCode.set(code, list);
      membership = new Set();
      pathSetsByCode.set(code, membership);
    } else if (!membership) {
      membership = new Set(list);
      pathSetsByCode.set(code, membership);
    }
    if (membership.has(path)) return;
    membership.add(path);
    list.push(path);
  }

  function recordHit(code, path) {
    recordUsageHit(usageScan.pathsByCode, usageScan.pathSetsByCode, code, path);
  }

  function scanHaystack(text, path) {
    extractMentionedCodes(text).forEach((code) => recordHit(code, path));
  }

  async function scanHaystackAsync(text, path) {
    const codes = await extractMentionedCodesAsync(text);
    codes.forEach((code) => recordHit(code, path));
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

  function withTimeout(promise, timeoutMs, createError) {
    let timer;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        let error;
        try {
          error =
            typeof createError === "function"
              ? createError()
              : createError || new Error("Promise timed out after " + timeoutMs + " ms");
        } catch (createErrorError) {
          error = createErrorError;
        }
        settle(reject, error);
      }, timeoutMs);

      Promise.resolve(promise).then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      );
    });
  }

  async function mapPool(items, limit, fn) {
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const current = index++;
        try {
          await fn(items[current], current);
        } finally {
          await yieldToBrowser();
        }
      }
    }
    const workers = [];
    const count = Math.min(limit, items.length) || 0;
    for (let i = 0; i < count; i++) workers.push(worker());
    await Promise.all(workers);
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function scanConcurrencyForCount(count) {
    return count > LARGE_SCAN_PAGE_COUNT ? LARGE_SCAN_CONCURRENCY : SCAN_CONCURRENCY;
  }

  const RATE_CONTROLLER_DEFAULTS = Object.freeze({
    initialGapMs: SCAN_INITIAL_GAP_MS,
    minGapMs: SCAN_GAP_MIN_MS,
    maxGapMs: SCAN_GAP_MAX_MS,
    successStreakLimit: SCAN_SUCCESS_STREAK_LIMIT,
    successGapFactor: SCAN_SUCCESS_GAP_FACTOR,
    failureMinGapMs: SCAN_FAILURE_MIN_GAP_MS,
  });

  function rateControllerOptions(options) {
    const source = options || {};
    const minGapMs = Number.isFinite(source.minGapMs)
      ? Math.max(1, Math.round(source.minGapMs))
      : RATE_CONTROLLER_DEFAULTS.minGapMs;
    const maxGapMs = Number.isFinite(source.maxGapMs)
      ? Math.max(minGapMs, Math.round(source.maxGapMs))
      : RATE_CONTROLLER_DEFAULTS.maxGapMs;
    return {
      initialGapMs: Math.min(
        maxGapMs,
        Math.max(
          minGapMs,
          Number.isFinite(source.initialGapMs)
            ? Math.round(source.initialGapMs)
            : RATE_CONTROLLER_DEFAULTS.initialGapMs,
        ),
      ),
      minGapMs,
      maxGapMs,
      successStreakLimit: Number.isFinite(source.successStreakLimit)
        ? Math.max(1, Math.round(source.successStreakLimit))
        : RATE_CONTROLLER_DEFAULTS.successStreakLimit,
      successGapFactor:
        Number.isFinite(source.successGapFactor) && source.successGapFactor > 0 && source.successGapFactor < 1
          ? source.successGapFactor
          : RATE_CONTROLLER_DEFAULTS.successGapFactor,
      failureMinGapMs: Number.isFinite(source.failureMinGapMs)
        ? Math.max(minGapMs, Math.round(source.failureMinGapMs))
        : RATE_CONTROLLER_DEFAULTS.failureMinGapMs,
    };
  }

  function nextRateControllerState(state, outcome, options) {
    const settings = rateControllerOptions(options);
    const currentGapMs = Number.isFinite(state && state.gapMs)
      ? Math.min(settings.maxGapMs, Math.max(settings.minGapMs, Math.round(state.gapMs)))
      : settings.initialGapMs;
    const currentStreak = Number.isFinite(state && state.successStreak)
      ? Math.max(0, Math.round(state.successStreak))
      : 0;
    const event = typeof outcome === "string" ? outcome : outcome && outcome.type;

    if (event === "failure") {
      return {
        gapMs: Math.min(
          settings.maxGapMs,
          Math.max(settings.failureMinGapMs, currentGapMs * 2),
        ),
        successStreak: 0,
      };
    }

    if (event !== "success") {
      return { gapMs: currentGapMs, successStreak: currentStreak };
    }

    const successStreak = currentStreak + 1;
    if (successStreak < settings.successStreakLimit) {
      return { gapMs: currentGapMs, successStreak };
    }
    return {
      gapMs: Math.max(settings.minGapMs, Math.round(currentGapMs * settings.successGapFactor)),
      successStreak: 0,
    };
  }

  function createRateController(options) {
    const settings = rateControllerOptions(options);
    let state = {
      gapMs: settings.initialGapMs,
      successStreak: 0,
    };
    const getState = () => ({ gapMs: state.gapMs, successStreak: state.successStreak });
    return {
      getGapMs: () => state.gapMs,
      getState,
      recordSuccess: () => {
        state = nextRateControllerState(state, "success", settings);
        return getState();
      },
      recordFailure: () => {
        state = nextRateControllerState(state, "failure", settings);
        return getState();
      },
    };
  }

  function nextRateGate(nextAllowedAt, now, gapMs) {
    const start = Math.max(now, nextAllowedAt);
    return { waitMs: start - now, nextAllowedAt: start + gapMs };
  }

  function createRateGate(defaultGapMs = SCAN_INITIAL_GAP_MS) {
    let nextAllowedAt = 0;
    return async function waitForSlot(currentGapMs = defaultGapMs) {
      const now = Date.now();
      const planned = nextRateGate(nextAllowedAt, now, currentGapMs);
      nextAllowedAt = planned.nextAllowedAt;
      if (planned.waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, planned.waitMs));
      }
      return planned.waitMs;
    };
  }

  function isScanHostAlive() {
    if (typeof document === "undefined") return true;
    if (!findFileManager()) return false;
    const text = (document.body && document.body.textContent) || "";
    return !( /Unknown Error/i.test(text) && /uuBookKit/i.test(text) );
  }

  async function startUsageScan() {
    const scanGeneration = ++usageScanGeneration;
    usageScan.active = true;
    usageScan.running = true;
    usageScan.done = false;
    usageScan.doneCount = 0;
    usageScan.totalCount = 0;
    usageScan.failedCount = 0;
    usageScan.error = null;
    resetUsagePaths();
    flushProgressUi();

    let completed = false;
    try {
      const structure = await uuGet("getBookStructure");
      if (scanGeneration !== usageScanGeneration) return;

      const walked = pageOrderAndPaths(structure.itemMap);
      const paths = walked.paths;
      const pageCodes = walked.order.slice();

      const extra = await listAllPageCodes();
      if (scanGeneration !== usageScanGeneration) return;
      extra.forEach((name, code) => {
        if (paths[code]) return;
        paths[code] = name || code;
        pageCodes.push(code);
      });

      usageScan.totalCount = pageCodes.length;
      ensureUsageButton();

      const intro = await loadOptionalIntro(uuGet);
      if (scanGeneration !== usageScanGeneration) return;
      if (intro != null) {
        await scanHaystackAsync(await pageHaystackAsync(intro), t("bookIntro"));
      }

      const rateController = createRateController();
      const waitForScanSlot = createRateGate();
      await mapPool(pageCodes, scanConcurrencyForCount(pageCodes.length), async (pageCode) => {
        if (scanGeneration !== usageScanGeneration) return;
        if (!isScanHostAlive()) throw new Error(t("scanHostGone"));
        await waitForScanSlot(rateController.getGapMs());
        if (scanGeneration !== usageScanGeneration) return;
        if (!isScanHostAlive()) throw new Error(t("scanHostGone"));
        let pageLoaded = false;
        try {
          const page = await withTimeout(
            uuGet("loadPage", { code: pageCode }),
            LOAD_PAGE_TIMEOUT_MS,
            () =>
              new Error(
                "loadPage page " + String(pageCode) + " timed out after " + LOAD_PAGE_TIMEOUT_MS + " ms",
              ),
          );
          pageLoaded = true;
          rateController.recordSuccess();
          if (scanGeneration !== usageScanGeneration) return;
          await scanHaystackAsync(
            await pageHaystackAsync(page),
            paths[pageCode] || pageCode,
          );
        } catch (error) {
          if (error && error.message === t("scanHostGone")) throw error;
          if (!pageLoaded) rateController.recordFailure();
          usageScan.failedCount++;
        }
        usageScan.doneCount++;
        scheduleProgressUiUpdate(false);
      });

      if (scanGeneration !== usageScanGeneration) return;
      if (pageCodes.length && usageScan.failedCount === pageCodes.length) {
        throw new Error(t("noPageLoaded"));
      }

      completed = true;
    } catch (error) {
      if (scanGeneration !== usageScanGeneration) return;
      usageScan.active = false;
      usageScan.error = (error && error.message) || String(error);
    }

    usageScan.running = false;
    usageScan.done = completed;
    flushProgressUi();
  }

  function clearBookState() {
    usageScanGeneration++;
    clearProgressUiTimer();
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
    resetUsagePaths();
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
    new MutationObserver(() => {
      if (usageScan.running) return;
      scheduleRender();
    }).observe(document.documentElement, {
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
    extractMentionedCodesAsync,
    normalizeHaystackText,
    decodeMentionedCode,
    pullCodesFromPattern,
    HAYSTACK_REGEX_MATCH_LIMIT,
    HAYSTACK_REGEX_MATCH_LIMIT_ERROR,
    isHaystackHostObject,
    safeSerializeForHaystack,
    pageHaystack,
    pageHaystackAsync,
    compareBySize,
    createSizeSortItem,
    usagePathsForCode,
    recordUsageHit,
    unusedCodes,
    addCodesToSelection,
    isMissingIntroError,
    loadOptionalIntro,
    withTimeout,
    mapPool,
    yieldToBrowser,
    scanConcurrencyForCount,
    RATE_CONTROLLER_DEFAULTS,
    nextRateControllerState,
    createRateController,
    nextRateGate,
    createRateGate,
    isScanHostAlive,
    SCRIPT_VERSION,
    run,
  };
});
