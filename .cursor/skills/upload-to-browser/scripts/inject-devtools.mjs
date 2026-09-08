#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function parseMetadata(source) {
  const block = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!block) throw new Error("Userscript metadata block was not found.");

  const metadata = {};
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    if (metadata[key] === undefined) metadata[key] = value;
    else if (Array.isArray(metadata[key])) metadata[key].push(value);
    else metadata[key] = [metadata[key], value];
  }
  const grants = Array.isArray(metadata.grant) ? metadata.grant : [metadata.grant].filter(Boolean);
  if (grants.length !== 1 || grants[0] !== "none") {
    throw new Error(`Only @grant none is supported (found: ${grants.join(", ") || "none"}).`);
  }
  return metadata;
}

function cdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP connection timed out.")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP connection failed."));
    });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out.`));
        }, 15000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timeout);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function markerMatches(target, marker) {
  if (!target.webSocketDebuggerUrl) return false;
  const client = cdp(target.webSocketDebuggerUrl);
  try {
    const response = await client.send("Runtime.evaluate", {
      expression: "window.__uploadToBrowserTargetMarker",
      returnByValue: true,
    });
    return response.result?.value === marker;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.script) throw new Error("Usage: inject-devtools.mjs --script <file.user.js> --marker <value> [--port 19222]");
  if (!args.marker) throw new Error("--marker is required to select the exact Cursor browser tab.");

  const scriptPath = path.resolve(args.script);
  const source = await fs.readFile(scriptPath, "utf8");
  const metadata = parseMetadata(source);
  const port = Number(args.port || 19222);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
    if (!response.ok) throw new Error(`DevTools target listing failed: HTTP ${response.status}`);
    return response.json();
  });
  const candidates = targets.filter(
    (target) =>
      target.webSocketDebuggerUrl &&
      (!args["url-substring"] || String(target.url || "").includes(args["url-substring"])),
  );
  const checked = await Promise.all(
    candidates.map(async (target) => ({ target, matches: await markerMatches(target, args.marker) })),
  );
  const matches = checked.filter((entry) => entry.matches).map((entry) => entry.target);
  if (matches.length !== 1) {
    throw new Error(`Expected one marked browser target, found ${matches.length}.`);
  }

  const scriptMeta = {
    name: metadata.name || path.basename(scriptPath),
    namespace: metadata.namespace || "",
    version: metadata.version || "",
    description: metadata.description || "",
    author: metadata.author || "",
    "run-at": metadata["run-at"] || "",
    matches: [metadata.match].flat().filter(Boolean),
    grant: [metadata.grant].flat().filter(Boolean),
  };
  const expression = `(() => {
    const scriptMeta = ${JSON.stringify(scriptMeta)};
    window.GM_info = { scriptHandler: "UploadToBrowser", version: "0.2.0", script: scriptMeta };
    try { window.unsafeWindow = window; } catch {}
    const tag = document.createElement("script");
    tag.setAttribute("data-upload-to-browser", scriptMeta.name || "userscript");
    tag.textContent = ${JSON.stringify(source)};
    (document.documentElement || document.head).appendChild(tag);
    return {
      ok: true,
      bytes: new TextEncoder().encode(tag.textContent).length,
      name: scriptMeta.name,
      version: scriptMeta.version,
      gmInfo: window.GM_info?.scriptHandler === "UploadToBrowser"
    };
  })()`;

  const client = cdp(matches[0].webSocketDebuggerUrl);
  try {
    const response = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    console.log(JSON.stringify({ target: matches[0].id, result: response.result?.value }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
