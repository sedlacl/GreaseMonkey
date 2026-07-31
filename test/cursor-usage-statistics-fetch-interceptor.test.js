"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const USERSCRIPT_PATH = path.resolve(__dirname, "..", "cursor-usage-statistics.user.js");
const source = fs.readFileSync(USERSCRIPT_PATH, "utf8");

const {
  VERSION,
  USAGE_ENDPOINT,
  resolvePageWindow,
  isUsageRequest,
  installPageFetchInterceptor,
} = require(USERSCRIPT_PATH);

/** Simulates Greasemonkey/Firefox sandbox `window.fetch` (getter-only / read-only). */
function createReadonlyFetchSandbox(nativeFetch) {
  const sandbox = {};
  Object.defineProperty(sandbox, "fetch", {
    get() {
      return nativeFetch;
    },
    enumerable: true,
    configurable: false,
  });
  return sandbox;
}

function createWritablePageWindow(nativeFetch) {
  return { fetch: nativeFetch };
}

test("userscript metadata is 1.3.4 and grants unsafeWindow", () => {
  assert.equal(VERSION, "1.3.4");
  assert.match(source, /@version\s+1\.3\.4\b/);
  assert.match(source, /@grant\s+unsafeWindow\b/);
  assert.doesNotMatch(source, /@grant\s+none\b/);
  assert.match(source, /installPageFetchInterceptor\s*\(/);
  assert.match(source, /resolvePageWindow\s*\(/);
  // Regression: never wrap native fetch Promise with .then() / async (GM/Firefox Xray).
  assert.doesNotMatch(
    source,
    /return nativeFetch\(input, init\)\.then\s*\(/,
  );
  assert.match(source, /Permission denied to access object/);
});

test("pre-fix reproduction: assigning to read-only sandbox fetch throws", () => {
  const nativeFetch = async () => ({ ok: true });
  const sandbox = createReadonlyFetchSandbox(nativeFetch);

  assert.throws(
    () => {
      sandbox.fetch = async function cursorUsageFetchInterceptor() {
        return nativeFetch();
      };
    },
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(String(error.message), /read-only|only a getter|Cannot set property/i);
      return true;
    },
  );
});

test("resolvePageWindow prefers unsafeWindow over sandbox window", () => {
  const sandbox = { id: "sandbox" };
  const page = { id: "page" };

  assert.equal(resolvePageWindow(sandbox, page), page);
  assert.equal(resolvePageWindow(sandbox, undefined), sandbox);
  assert.equal(resolvePageWindow(sandbox, null), sandbox);
});

test("installPageFetchInterceptor patches writable page window and keeps native fetch", async () => {
  const captured = [];
  let nativeCalls = 0;

  const nativeFetchImpl = async (input, init) => {
    nativeCalls += 1;
    return {
      ok: true,
      status: 200,
      url: typeof input === "string" ? input : "",
      init,
    };
  };

  const pageWindow = createWritablePageWindow(nativeFetchImpl);
  const sandbox = createReadonlyFetchSandbox(nativeFetchImpl);

  assert.throws(() => {
    sandbox.fetch = async () => nativeFetchImpl();
  }, TypeError);

  const { nativeFetch, interceptor } = installPageFetchInterceptor(pageWindow, {
    isUsageRequest: (input) => isUsageRequest(input, "https://cursor.com"),
    readRequestBody: async (_input, init) => (typeof init?.body === "string" ? init.body : ""),
    captureRequestContext: (bodyText) => {
      captured.push(bodyText);
    },
  });

  assert.equal(typeof interceptor, "function");
  assert.notEqual(pageWindow.fetch, nativeFetchImpl);
  assert.equal(pageWindow.fetch, interceptor);

  const body = JSON.stringify({ teamId: "team-1", userId: "user-1" });
  const response = await pageWindow.fetch(USAGE_ENDPOINT, {
    method: "POST",
    body,
  });

  assert.equal(response.ok, true);
  assert.equal(nativeCalls, 1);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captured, [body]);

  // Userscript API calls must keep using the unbound native implementation.
  const direct = await nativeFetch(USAGE_ENDPOINT, { method: "POST", body });
  assert.equal(direct.ok, true);
  assert.equal(nativeCalls, 2);
  assert.equal(captured.length, 1);
});

test("interceptor returns the same Promise instance as native fetch (no sandbox wrap)", () => {
  const pagePromise = Promise.resolve({ ok: true, status: 200 });
  const nativeFetchImpl = () => pagePromise;
  const pageWindow = createWritablePageWindow(nativeFetchImpl);

  installPageFetchInterceptor(pageWindow, {
    isUsageRequest: () => false,
    readRequestBody: async () => "",
    captureRequestContext: () => {},
  });

  const returned = pageWindow.fetch("/api/analytics");
  assert.equal(returned, pagePromise);
});

test("usage capture still fires without wrapping the returned Promise", async () => {
  const captured = [];
  const pagePromise = Promise.resolve({ ok: true });
  const nativeFetchImpl = () => pagePromise;
  const pageWindow = createWritablePageWindow(nativeFetchImpl);

  installPageFetchInterceptor(pageWindow, {
    isUsageRequest: (input) => isUsageRequest(input, "https://cursor.com"),
    readRequestBody: async (_input, init) => (typeof init?.body === "string" ? init.body : ""),
    captureRequestContext: (bodyText) => {
      captured.push(bodyText);
    },
  });

  const body = JSON.stringify({ teamId: "t", userId: "u" });
  const returned = pageWindow.fetch(USAGE_ENDPOINT, { method: "POST", body });
  assert.equal(returned, pagePromise);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captured, [body]);
});

test("installPageFetchInterceptor fails loudly when page fetch is not patchable", () => {
  const lockedPage = createReadonlyFetchSandbox(async () => ({ ok: true }));

  assert.throws(
    () =>
      installPageFetchInterceptor(lockedPage, {
        isUsageRequest: () => false,
        readRequestBody: async () => "",
        captureRequestContext: () => {},
      }),
    /unable to install fetch interceptor|not patchable/i,
  );
});
