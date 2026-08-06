"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MAIN_PATH = path.join(ROOT, "message-registry-preview-downloads.user.js");
const UUCLOUD1_PATH = path.join(ROOT, "message-registry-preview-downloads.uucloud1.user.js");

const mainSource = fs.readFileSync(MAIN_PATH, "utf8");
const uucloud1Source = fs.readFileSync(UUCLOUD1_PATH, "utf8");

function extractPatchFetchBody(source) {
  const match = source.match(
    /function patchFetch\(\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  function patchBlobDownloads/,
  );
  assert.ok(match, "patchFetch() body not found");
  return match[1];
}

function assertSafeFetchInterceptor(source, label, expectedVersion) {
  assert.match(source, new RegExp(`@version\\s+${expectedVersion.replace(/\./g, "\\.")}\\b`), `${label} @version`);
  assert.match(source, /function isRequestLike\s*\(/, `${label} isRequestLike`);
  assert.match(source, /Permission denied to access object/, `${label} documents GM/FF hazard`);

  // Regression: never wrap page fetch with async / return-path .then().
  assert.doesNotMatch(source, /window\.fetch\s*=\s*async\b/, `${label} no async assignment to window.fetch`);
  assert.doesNotMatch(source, /async\s+function\s+patchedFetch\b/, `${label} no async patchedFetch`);

  const patchBody = extractPatchFetchBody(source);
  assert.doesNotMatch(
    patchBody,
    /return\s+nativeFetch\s*\([^)]*\)\s*\.then\s*\(/,
    `${label} must not return nativeFetch(...).then(...)`,
  );
  assert.doesNotMatch(
    patchBody,
    /return\s+originalFetch\s*\([^)]*\)\s*\.then\s*\(/,
    `${label} must not return originalFetch(...).then(...)`,
  );
  assert.match(patchBody, /return pending;/, `${label} returns original pending Promise`);
  assert.match(patchBody, /void pending\s*\r?\n?\s*\.then\s*\(/, `${label} side effects are fire-and-forget`);
  assert.doesNotMatch(patchBody, /\bawait\b/, `${label} patchFetch must not await`);
  assert.doesNotMatch(patchBody, /instanceof\s+Request\b/, `${label} no instanceof Request in patchFetch`);
}

test("main MR preview userscript fetch interceptor is GM/Firefox-safe (1.34)", () => {
  assertSafeFetchInterceptor(mainSource, "main", "1.34");
  assert.match(mainSource, /@grant\s+none\b/);
  // Non-preview path still caches message/get via fire-and-forget side effect.
  assert.match(extractPatchFetchBody(mainSource), /rememberMessageSourceResponse/);
});

test("uucloud1 MR preview userscript fetch interceptor is GM/Firefox-safe (1.20)", () => {
  assertSafeFetchInterceptor(uucloud1Source, "uucloud1", "1.20");
  assert.match(uucloud1Source, /@grant\s+none\b/);
});

test("isRequestLike duck-typing matches CUS shape in both scripts", () => {
  for (const [label, source] of [
    ["main", mainSource],
    ["uucloud1", uucloud1Source],
  ]) {
    assert.match(source, /typeof input\.url === "string"/, `${label} url`);
    assert.match(source, /typeof input\.clone === "function"/, `${label} clone`);
    assert.match(source, /typeof input\.text === "function"/, `${label} text`);
  }
});
