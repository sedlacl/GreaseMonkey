import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 8766);
const HOST = process.env.BROWSER_BRIDGE_HOST || "127.0.0.1";
const RESULT_TTL_MS = 5 * 60 * 1000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Map<string, string>} */
const STATIC_SCRIPTS = new Map([
  ["/tools/bookkit-fulltext-search.bootstrap.js", "tools/bookkit-fulltext-search.bootstrap.js"],
  ["/bookkit-fulltext-search.user.js", "bookkit-fulltext-search.user.js"],
  ["/tools/browser-bridge.user.js", "tools/browser-bridge.user.js"],
]);

/** @type {Map<string, { id: string, type: string, payload: unknown, created: number }>} */
const pending = new Map();
/** @type {Map<string, { id: string, ok: boolean, result?: unknown, error?: string, finished: number }>} */
const results = new Map();

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
      });
      return;
    }

    if (req.method === "GET" && (await serveStaticScript(res, url.pathname))) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/pending") {
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
