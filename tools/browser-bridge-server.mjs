import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 8766);
const HOST = process.env.BROWSER_BRIDGE_HOST || "127.0.0.1";
const RESULT_TTL_MS = 5 * 60 * 1000;
const DIAG_LIMIT = Number(process.env.BROWSER_BRIDGE_DIAG_LIMIT || 300);
const DIAG_TTL_MS = Number(process.env.BROWSER_BRIDGE_DIAG_TTL_MS || 30 * 60 * 1000);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Map<string, string>} */
const STATIC_SCRIPTS = new Map([
  ["/tools/bookkit-fulltext-search.bootstrap.js", "tools/bookkit-fulltext-search.bootstrap.js"],
  ["/bookkit-fulltext-search.user.js", "bookkit-fulltext-search.user.js"],
  ["/cursor-usage-statistics.user.js", "cursor-usage-statistics.user.js"],
  ["/tools/browser-bridge.user.js", "tools/browser-bridge.user.js"],
]);

/** @type {Map<string, { id: string, type: string, payload: unknown, created: number }>} */
const pending = new Map();
/** @type {Map<string, { id: string, ok: boolean, result?: unknown, error?: string, finished: number }>} */
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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

function pruneResults() {
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const [id, entry] of results.entries()) {
    if (entry.finished < cutoff) results.delete(id);
  }
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
        results: results.size,
        port: PORT,
        scripts: Array.from(STATIC_SCRIPTS.keys()),
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
      sendJson(
        res,
        200,
        Array.from(pending.values()).sort((left, right) => left.created - right.created),
      );
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
