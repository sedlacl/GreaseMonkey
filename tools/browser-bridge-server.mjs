import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 8766);
const HOST = process.env.BROWSER_BRIDGE_HOST || "127.0.0.1";
const RESULT_TTL_MS = 5 * 60 * 1000;
// A tab polls every 500 ms; a hidden one is throttled by the browser to about once a minute.
const TAB_TTL_MS = 90 * 1000;
const UNCLAIMED_TTL_MS = 2 * 60 * 1000;
const CLAIMED_TTL_MS = 10 * 60 * 1000;
const DIAG_LIMIT = Number(process.env.BROWSER_BRIDGE_DIAG_LIMIT || 300);
const DIAG_TTL_MS = Number(process.env.BROWSER_BRIDGE_DIAG_TTL_MS || 30 * 60 * 1000);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Map<string, string>} */
const STATIC_SCRIPTS = new Map([
  ["/tools/bookkit-fulltext-search.bootstrap.js", "tools/bookkit-fulltext-search.bootstrap.js"],
  ["/tools/bookkit-file-manager.bootstrap.js", "tools/bookkit-file-manager.bootstrap.js"],
  ["/bookkit-fulltext-search.user.js", "bookkit-fulltext-search.user.js"],
  ["/bookkit-file-manager.user.js", "bookkit-file-manager.user.js"],
  ["/cursor-usage-statistics.user.js", "cursor-usage-statistics.user.js"],
  ["/wtm-jira-sync.user.js", "wtm-jira-sync.user.js"],
  ["/jira-attachment-preview.user.js", "jira-attachment-preview.user.js"],
  ["/tools/browser-bridge.user.js", "tools/browser-bridge.user.js"],
]);

/**
 * Each command is handed to exactly one tab (claimedBy) and never re-delivered,
 * so a slow command cannot run again in the same or another tab.
 * @type {Map<string, { id: string, type: string, payload: unknown, created: number, target?: { url?: string, tabId?: string }, claimedBy?: string, claimedAt?: number }>}
 */
const pending = new Map();
/** @type {Map<string, { tabId: string, url: string, title: string, visible: boolean, lastSeen: number }>} */
const tabs = new Map();
/** @type {Map<string, { id: string, ok: boolean, result?: unknown, error?: string, tab?: { tabId: string, url: string }, finished: number }>} */
const results = new Map();
/** @type {Array<{ id: string, received: number, source: string, event: string, version?: string, url?: string, timestamp: number, data?: unknown }>} */
const diagnostics = [];

function pruneDiagnostics() {
  const cutoff = Date.now() - DIAG_TTL_MS;
  while (diagnostics.length && diagnostics[0].timestamp < cutoff) {
    diagnostics.shift();
  }
  while (diagnostics.length > DIAG_LIMIT) {
    diagnostics.shift();
  }
}

function addDiagnostic(entry) {
  pruneDiagnostics();
  const normalized = {
    id: randomUUID(),
    received: Date.now(),
    source: String(entry.source || "unknown"),
    event: String(entry.event || "event"),
    version: entry.version ? String(entry.version) : undefined,
    url: entry.url ? String(entry.url) : undefined,
    timestamp: Number(entry.timestamp) || Date.now(),
    data: entry.data ?? entry.payload ?? undefined,
  };
  diagnostics.push(normalized);
  console.log(`[diag] ${normalized.source} ${normalized.event}`);
  return normalized;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

function sendScript(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

async function serveStaticScript(res, pathname) {
  const relativePath = STATIC_SCRIPTS.get(pathname);
  if (!relativePath) {
    return false;
  }

  const filePath = path.resolve(REPO_ROOT, relativePath);
  const fromRoot = path.relative(REPO_ROOT, filePath);
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }

  try {
    const body = await fs.readFile(filePath, "utf8");
    sendScript(res, 200, body);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
  return true;
}

/** Name, version and @match patterns from the userscript header, for the bridge "update scripts" list. */
async function readUserScriptMeta(urlPath, relativePath) {
  try {
    const head = (await fs.readFile(path.resolve(REPO_ROOT, relativePath), "utf8")).split("==/UserScript==")[0];
    const values = (key) => [...head.matchAll(new RegExp(`^//\\s*@${key}\\s+(.+?)\\s*$`, "gm"))].map((m) => m[1]);
    return { path: urlPath, name: values("name")[0] || urlPath, version: values("version")[0] || null, matches: [...values("match"), ...values("include")] };
  } catch {
    return { path: urlPath, name: urlPath, version: null, matches: [] };
  }
}

function pruneResults() {
  const now = Date.now();
  const cutoff = now - RESULT_TTL_MS;
  for (const [id, entry] of results.entries()) {
    if (entry.finished < cutoff) results.delete(id);
  }
  for (const [id, command] of pending.entries()) {
    const age = now - (command.claimedAt || command.created);
    if (age > (command.claimedBy ? CLAIMED_TTL_MS : UNCLAIMED_TTL_MS)) pending.delete(id);
  }
  for (const [tabId, tab] of tabs.entries()) {
    if (now - tab.lastSeen > TAB_TTL_MS) tabs.delete(tabId);
  }
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object") return undefined;
  const normalized = {};
  if (typeof target.url === "string" && target.url) normalized.url = target.url;
  if (typeof target.tabId === "string" && target.tabId) normalized.tabId = target.tabId;
  return Object.keys(normalized).length ? normalized : undefined;
}

function commandMatchesTab(command, tab) {
  const target = command.target;
  if (!target) return true;
  if (target.tabId && target.tabId !== tab.tabId) return false;
  if (target.url && !tab.url.includes(target.url)) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  pruneResults();

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        pending: pending.size,
        tabs: tabs.size,
        results: results.size,
        port: PORT,
        scripts: Array.from(STATIC_SCRIPTS.keys()),
        userScripts: await Promise.all(
          Array.from(STATIC_SCRIPTS.entries())
            .filter(([urlPath]) => urlPath.endsWith(".user.js"))
            .map(([urlPath, relativePath]) => readUserScriptMeta(urlPath, relativePath)),
        ),
        diagnostics: diagnostics.length,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/diagnostics") {
      pruneDiagnostics();
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), DIAG_LIMIT);
      const source = url.searchParams.get("source");
      let items = diagnostics;
      if (source) {
        items = items.filter((entry) => entry.source === source);
      }
      sendJson(res, 200, {
        count: items.length,
        items: items.slice(-limit).reverse(),
      });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/diagnostics") {
      diagnostics.length = 0;
      sendJson(res, 200, { ok: true, cleared: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/diagnostics") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const entries = Array.isArray(body.events) ? body.events : [body];
      const stored = entries.filter((entry) => entry && entry.event).map((entry) => addDiagnostic(entry));
      sendJson(res, 200, { ok: true, stored: stored.length });
      return;
    }

    if (req.method === "GET" && (await serveStaticScript(res, url.pathname))) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/pending") {
      // Only the top-frame userscript may claim commands. Match-all userscripts in
      // captcha/payment iframes otherwise race the real page for the same queue.
      if (url.searchParams.get("top") !== "1") {
        sendJson(res, 200, []);
        return;
      }
      // Bridge userscript < 1.6 sends no tab id or URL; it only gets untargeted commands.
      const tab = {
        tabId: url.searchParams.get("tab") || "",
        url: url.searchParams.get("url") || "",
        title: url.searchParams.get("title") || "",
        visible: url.searchParams.get("visible") === "1",
        lastSeen: Date.now(),
      };
      if (tab.tabId) tabs.set(tab.tabId, tab);
      const claimed = Array.from(pending.values())
        .filter((command) => !command.claimedBy && commandMatchesTab(command, tab))
        .sort((left, right) => left.created - right.created);
      for (const command of claimed) {
        command.claimedBy = tab.tabId || "legacy";
        command.claimedAt = Date.now();
      }
      sendJson(res, 200, claimed);
      return;
    }

    if (req.method === "GET" && url.pathname === "/tabs") {
      sendJson(
        res,
        200,
        Array.from(tabs.values())
          .sort((left, right) => right.lastSeen - left.lastSeen)
          .map((tab) => ({ ...tab, lastSeenMsAgo: Date.now() - tab.lastSeen })),
      );
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/pending/")) {
      const id = decodeURIComponent(url.pathname.slice("/pending/".length));
      const command = pending.get(id);
      pending.delete(id);
      sendJson(res, 200, { ok: true, removed: Boolean(command), claimedBy: command?.claimedBy || null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/result") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.id) {
        sendJson(res, 400, { error: "Missing id" });
        return;
      }

      pending.delete(body.id);
      results.set(body.id, {
        id: body.id,
        ok: Boolean(body.ok),
        result: body.result,
        error: body.error,
        tab: body.tab && typeof body.tab === "object" ? { tabId: String(body.tab.tabId || ""), url: String(body.tab.url || "") } : undefined,
        finished: Date.now(),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = randomUUID();
      pending.set(id, {
        id,
        type: body.type || "eval",
        payload: body.payload ?? {},
        target: normalizeTarget(body.target),
        created: Date.now(),
      });
      sendJson(res, 200, { id });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/result/")) {
      const id = decodeURIComponent(url.pathname.slice("/result/".length));
      const entry = results.get(id);
      if (!entry) {
        sendJson(res, 404, { error: "Result not ready" });
        return;
      }
      results.delete(id);
      sendJson(res, 200, entry);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`browser-bridge listening on http://${HOST}:${PORT}`);
});
