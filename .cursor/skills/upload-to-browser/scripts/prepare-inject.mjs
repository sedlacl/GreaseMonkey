#!/usr/bin/env node
/**
 * Prepare a userscript for Cursor-browser CDP inject (Tampermonkey-like, @grant none).
 *
 * Usage:
 *   node prepare-inject.mjs --script <path.user.js> [--out <dir>] [--chunk-bytes 4500]
 *
 * Writes:
 *   manifest.json
 *   eval/00-bootstrap.js
 *   eval/01-chunk-000.js ...
 *   eval/99-commit.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { script: null, out: null, chunkBytes: 4500 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--script") out.script = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--chunk-bytes") out.chunkBytes = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function parseUserScriptMeta(source) {
  const block = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!block) {
    throw new Error("Missing // ==UserScript== header");
  }
  const meta = {
    name: "",
    namespace: "",
    version: "",
    description: "",
    author: "",
    grant: [],
    match: [],
    include: [],
    runAt: "document-end",
  };
  for (const line of block[1].split(/\r?\n/)) {
    const m = line.match(/\/\/\s*@([a-zA-Z-]+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "name") meta.name = value;
    else if (key === "namespace") meta.namespace = value;
    else if (key === "version") meta.version = value;
    else if (key === "description") meta.description = value;
    else if (key === "author") meta.author = value;
    else if (key === "grant") meta.grant.push(value);
    else if (key === "match") meta.match.push(value);
    else if (key === "include") meta.include.push(value);
    else if (key === "run-at") meta.runAt = value;
  }
  return meta;
}

function assertGrantNone(meta) {
  const grants = meta.grant.length ? meta.grant : ["none"];
  const unsupported = grants.filter((g) => g !== "none");
  if (unsupported.length) {
    throw new Error(
      `UploadToBrowser supports only @grant none. Unsupported: ${unsupported.join(", ")}`,
    );
  }
}

function jsString(value) {
  return JSON.stringify(value);
}

function bootstrapExpression() {
  return `(() => {
  const KEY = "__gmTmSim";
  window[KEY] = {
      parts: [],
      expectedParts: 0,
      setB64(index, total, b64) {
        if (!Number.isInteger(index) || index < 0) throw new Error("invalid chunk index");
        if (!Number.isInteger(total) || total < 1 || index >= total) throw new Error("invalid chunk total");
        if (typeof b64 !== "string" || !b64) throw new Error("empty chunk");
        if (this.expectedParts && this.expectedParts !== total) throw new Error("chunk total changed");
        this.expectedParts = total;
        this.parts[index] = b64;
        return { index, received: this.parts.filter(Boolean).length, total };
      },
      commit(meta) {
        const received = this.parts.filter(Boolean).length;
        if (!this.expectedParts || received !== this.expectedParts) {
          throw new Error("incomplete chunks: " + received + "/" + this.expectedParts);
        }
        const b64 = this.parts.join("");
        this.parts = [];
        this.expectedParts = 0;
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const src = new TextDecoder().decode(bin);
        const scriptMeta = (meta && meta.script) || {};
        window.GM_info = {
          scriptHandler: "UploadToBrowser",
          version: "0.1.0",
          script: scriptMeta,
        };
        try { window.unsafeWindow = window; } catch { /* ignore */ }
        const tag = document.createElement("script");
        tag.setAttribute("data-upload-to-browser", scriptMeta.name || "userscript");
        tag.textContent = src;
        (document.documentElement || document.head).appendChild(tag);
        return {
          ok: true,
          bytes: bin.length,
          version: scriptMeta.version || null,
          name: scriptMeta.name || null,
          gmInfo: !!(window.GM_info && window.GM_info.scriptHandler === "UploadToBrowser"),
        };
      },
    };
  return "ready";
})()`;
}

function pushExpression(index, total, b64) {
  return `window.__gmTmSim.setB64(${index}, ${total}, ${jsString(b64)})`;
}

function commitExpression(meta) {
  const payload = {
    script: {
      name: meta.name,
      namespace: meta.namespace,
      version: meta.version,
      description: meta.description,
      author: meta.author,
      "run-at": meta.runAt,
      matches: meta.match,
      grant: meta.grant.length ? meta.grant : ["none"],
    },
  };
  return `window.__gmTmSim.commit(${jsString(payload)})`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.script) {
    console.error(
      "Usage: node prepare-inject.mjs --script <path.user.js> [--out <dir>] [--chunk-bytes 4500]",
    );
    process.exit(args.help ? 0 : 1);
  }
  if (!Number.isFinite(args.chunkBytes) || args.chunkBytes < 500) {
    throw new Error("--chunk-bytes must be >= 500");
  }

  const scriptPath = path.resolve(args.script);
  const source = fs.readFileSync(scriptPath, "utf8");
  const meta = parseUserScriptMeta(source);
  assertGrantNone(meta);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const projectRoot = path.resolve(__dirname, "../../../..");
  const outDir = path.resolve(
    args.out || path.join(projectRoot, ".cursor", ".tmp", "upload-to-browser", stamp),
  );
  const evalDir = path.join(outDir, "eval");
  fs.mkdirSync(evalDir, { recursive: true });

  const b64 = Buffer.from(source, "utf8").toString("base64");
  const chunks = [];
  for (let i = 0; i < b64.length; i += args.chunkBytes) {
    chunks.push(b64.slice(i, i + args.chunkBytes));
  }

  fs.writeFileSync(path.join(evalDir, "00-bootstrap.js"), bootstrapExpression(), "utf8");
  chunks.forEach((chunk, index) => {
    const name = `01-chunk-${String(index).padStart(3, "0")}.js`;
    fs.writeFileSync(path.join(evalDir, name), pushExpression(index, chunks.length, chunk), "utf8");
  });
  fs.writeFileSync(path.join(evalDir, "99-commit.js"), commitExpression(meta), "utf8");

  const manifest = {
    skill: "upload-to-browser",
    scriptPath,
    bytes: Buffer.byteLength(source, "utf8"),
    base64Chars: b64.length,
    chunkCount: chunks.length,
    chunkBytes: args.chunkBytes,
    meta,
    evalDir,
    steps: [
      "00-bootstrap.js",
      ...chunks.map((_, index) => `01-chunk-${String(index).padStart(3, "0")}.js`),
      "99-commit.js",
    ],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

try {
  main();
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
