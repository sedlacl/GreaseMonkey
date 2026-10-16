import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.BROWSER_BRIDGE_URL || "http://127.0.0.1:8766";
const DEFAULT_TIMEOUT_MS = Number(process.env.BROWSER_BRIDGE_TIMEOUT || 30000);

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(json?.error || `${response.status} ${response.statusText}`);
  }
  return json;
}

async function waitForResult(id, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await request(`/result/${encodeURIComponent(id)}`);
    } catch {
      await delay(250);
    }
  }
  // Withdraw the command so no tab runs it after we stopped waiting.
  const cancelled = await request(`/pending/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
  const hint = cancelled?.claimedBy ? `tab ${cancelled.claimedBy} took it but did not answer in time` : "no matching tab picked it up (see: tabs)";
  throw new Error(`Timed out waiting for result ${id}: ${hint}`);
}

/** Pulls --url / --tab / --timeout out of the arguments; the rest stays positional. */
function parseOptions(args) {
  const options = { target: {}, timeoutMs: DEFAULT_TIMEOUT_MS };
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if ((token === "--url" || token === "--tab" || token === "--timeout") && args[index + 1] !== undefined) {
      const value = args[index + 1];
      index += 1;
      if (token === "--url") options.target.url = value;
      else if (token === "--tab") options.target.tabId = value;
      else options.timeoutMs = Number(value) || DEFAULT_TIMEOUT_MS;
    } else {
      rest.push(token);
    }
  }
  return { options, rest };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(`Usage:
  node tools/browser-bridge-cli.mjs health
  node tools/browser-bridge-cli.mjs tabs
  node tools/browser-bridge-cli.mjs eval "<javascript expression>" [--url <part of URL>] [--tab <id>] [--timeout <ms>]
  node tools/browser-bridge-cli.mjs click "#selector" [--url ...] [--tab ...]
  node tools/browser-bridge-cli.mjs fill "#selector" "value" [--url ...] [--tab ...]
  node tools/browser-bridge-cli.mjs snapshot [--url ...] [--tab ...]
  node tools/browser-bridge-cli.mjs diagnostics [--limit N] [--source NAME]
  node tools/browser-bridge-cli.mjs diagnostics-clear

--url runs the command only in a tab whose URL contains the text, --tab only in the
tab with that id (shown by "tabs" and in the bridge panel). Without them the first
polling tab takes the command. Every command runs in exactly one tab, once.`);
    process.exit(command ? 0 : 1);
  }

  if (command === "tabs") {
    const tabs = await request("/tabs");
    for (const tab of tabs) {
      console.log(`${tab.tabId}  ${tab.visible ? "visible" : "hidden "}  ${Math.round(tab.lastSeenMsAgo / 1000)}s  ${tab.url}`);
    }
    if (!tabs.length) console.log("No tabs with bridge userscript >= 1.6 polled recently.");
    return;
  }

  const { options, rest } = command === "diagnostics" ? { options: null, rest: args } : parseOptions(args);

  if (command === "health") {
    console.log(JSON.stringify(await request("/health"), null, 2));
    return;
  }

  if (command === "diagnostics") {
    const params = new URLSearchParams();
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--limit" && rest[index + 1]) {
        params.set("limit", rest[index + 1]);
        index += 1;
      } else if (token === "--source" && rest[index + 1]) {
        params.set("source", rest[index + 1]);
        index += 1;
      }
    }
    const query = params.toString();
    console.log(JSON.stringify(await request(`/diagnostics${query ? `?${query}` : ""}`), null, 2));
    return;
  }

  if (command === "diagnostics-clear") {
    console.log(JSON.stringify(await request("/diagnostics", { method: "DELETE" }), null, 2));
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
    body: JSON.stringify({ type: command, payload, target: Object.keys(options.target).length ? options.target : undefined }),
  });
  const result = await waitForResult(queued.id, options.timeoutMs);
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
