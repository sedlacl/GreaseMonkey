import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.BROWSER_BRIDGE_URL || "http://127.0.0.1:8766";
const TIMEOUT_MS = Number(process.env.BROWSER_BRIDGE_TIMEOUT || 30000);

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(json?.error || `${response.status} ${response.statusText}`);
  }
  return json;
}

async function waitForResult(id) {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    try {
      return await request(`/result/${encodeURIComponent(id)}`);
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for result ${id}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(`Usage:
  node tools/browser-bridge-cli.mjs health
  node tools/browser-bridge-cli.mjs eval "<javascript expression>"
  node tools/browser-bridge-cli.mjs click "#selector"
  node tools/browser-bridge-cli.mjs fill "#selector" "value"
  node tools/browser-bridge-cli.mjs snapshot`);
    process.exit(command ? 0 : 1);
  }

  if (command === "health") {
    console.log(JSON.stringify(await request("/health"), null, 2));
    return;
  }

  let payload = {};
  if (command === "eval") {
    payload = { expression: rest.join(" "), awaitPromise: true };
  } else if (command === "click") {
    payload = { selector: rest[0] };
  } else if (command === "fill") {
    payload = { selector: rest[0], value: rest.slice(1).join(" ") };
  } else if (command === "snapshot") {
    payload = { snapshot: true };
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  const queued = await request("/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: command, payload }),
  });
  const result = await waitForResult(queued.id);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    throw new Error(result.error || "Bridge command failed");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
