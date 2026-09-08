const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function uniqueCodesInOrder(codes) {
  const seen = new Set();
  const ordered = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    ordered.push(code);
  }
  return ordered;
}

const {
  parseBookBaseFromUrl,
  formatSize,
  itemSize,
  extractMentionedCodes,
  normalizeHaystackText,
  decodeMentionedCode,
  pullCodesFromPattern,
  HAYSTACK_REGEX_MATCH_LIMIT,
  HAYSTACK_REGEX_MATCH_LIMIT_ERROR,
  isHaystackHostObject,
  safeSerializeForHaystack,
  pageHaystack,
  pageHaystackAsync,
  extractMentionedCodesAsync,
  recordUsageHit,
  compareBySize,
  usagePathsForCode,
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
  SCRIPT_VERSION,
} = require("../bookkit-file-manager.user.js");

test("SCRIPT_VERSION is 1.4.12", () => {
  assert.equal(SCRIPT_VERSION, "1.4.12");
});

test("bootstrap waits for the deferred first render before probing the mount", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "bookkit-file-manager.bootstrap.js"), "utf8");
  const loadIndex = source.indexOf("await loadScript(USER_SCRIPT_URL);");
  const waitIndex = source.indexOf("await waitForFirstRender();", loadIndex);
  const probeIndex = source.indexOf("button: !!document.querySelector", waitIndex);

  assert.match(source, /window\.__gmBookKitFileManagerReady\s*=\s*\(async \(\) =>/);
  assert.ok(loadIndex >= 0);
  assert.ok(waitIndex > loadIndex);
  assert.ok(probeIndex > waitIndex);
});

test("withTimeout resolves before timeout", async () => {
  assert.equal(await withTimeout(Promise.resolve("done"), 50), "done");
});

test("withTimeout rejects before timeout", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("original")), 50, () => new Error("too late")),
    /original/,
  );
});

test("withTimeout rejects a never-settling Promise", async () => {
  const started = Date.now();
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, () => new Error("timed out")),
    /timed out/,
  );
  assert.ok(Date.now() - started < 500);
});

test("mapPool continues after one timed-out loadPage", async () => {
  const completed = [];
  const failed = [];
  const pages = ["page-ok-1", "page-timeout", "page-ok-2"];

  await mapPool(pages, 1, async (pageCode) => {
    try {
      const loadPage =
        pageCode === "page-timeout"
          ? new Promise(() => {})
          : Promise.resolve({ code: pageCode });
      await withTimeout(
        loadPage,
        10,
        () => new Error("loadPage page " + pageCode + " timed out after 10 ms"),
      );
      completed.push(pageCode);
    } catch {
      failed.push(pageCode);
    }
  });

  assert.deepEqual(completed, ["page-ok-1", "page-ok-2"]);
  assert.deepEqual(failed, ["page-timeout"]);
});

test("isMissingIntroError accepts HTTP 404", () => {
  assert.equal(isMissingIntroError({ status: 404 }), true);
  assert.equal(isMissingIntroError({ statusCode: 404 }), true);
});

test("isMissingIntroError accepts uuApp introDoesNotExist codes", () => {
  assert.equal(
    isMissingIntroError({
      uuAppErrorCodes: ["uu-bookkit-maing01/getIntro/introDoesNotExist"],
    }),
    true,
  );
  assert.equal(
    isMissingIntroError({
      message: "getIntro → Intro not found",
    }),
    true,
  );
});

test("isMissingIntroError rejects auth, server, network and unknown errors", () => {
  assert.equal(isMissingIntroError({ status: 401 }), false);
  assert.equal(isMissingIntroError({ status: 403 }), false);
  assert.equal(isMissingIntroError({ status: 500 }), false);
  assert.equal(isMissingIntroError({ message: "Failed to fetch" }), false);
  assert.equal(isMissingIntroError({ message: "Unexpected token < in JSON" }), false);
  assert.equal(isMissingIntroError({ uuAppErrorCodes: ["uu-bookkit-maing01/getIntro/invalidDtoIn"] }), false);
});

test("loadOptionalIntro returns payload on success", async () => {
  const intro = { uu5String: "intro-code" };
  assert.deepEqual(await loadOptionalIntro(async () => intro), intro);
});

test("loadOptionalIntro returns null for missing intro", async () => {
  assert.equal(
    await loadOptionalIntro(async () => {
      throw { status: 404, message: "Not Found" };
    }),
    null,
  );
  assert.equal(
    await loadOptionalIntro(async () => {
      throw { uuAppErrorCodes: ["uu-bookkit-maing01/getIntro/introDoesNotExist"] };
    }),
    null,
  );
});

test("loadOptionalIntro rethrows fatal errors", async () => {
  await assert.rejects(
    () =>
      loadOptionalIntro(async () => {
        throw { status: 401, message: "Unauthorized" };
      }),
    (error) => error.status === 401,
  );
  await assert.rejects(
    () =>
      loadOptionalIntro(async () => {
        throw { status: 500, message: "Internal Server Error" };
      }),
    (error) => error.status === 500,
  );
  await assert.rejects(
    () =>
      loadOptionalIntro(async () => {
        throw new Error("Failed to fetch");
      }),
    /Failed to fetch/,
  );
});

test("parseBookBaseFromUrl extracts origin, awid and baseUri", () => {
  const book = parseBookBaseFromUrl(
    "https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3/book/page?code=intro",
  );

  assert.equal(book.origin, "https://uuapp.plus4u.net");
  assert.equal(book.awid, "10b5c8ef37b74c11a7a4d7e566ec00b3");
  assert.equal(book.baseUri, "https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3");
});

test("parseBookBaseFromUrl accepts prefixed workspace ids", () => {
  const book = parseBookBaseFromUrl(
    "https://uuapp-dev.plus4u.net/uu-bookkit-maing01/78462435-e884539c8511447a977c7ff070e7f2cf/book/attachment",
  );

  assert.equal(book.awid, "78462435-e884539c8511447a977c7ff070e7f2cf");
  assert.equal(
    book.baseUri,
    "https://uuapp-dev.plus4u.net/uu-bookkit-maing01/78462435-e884539c8511447a977c7ff070e7f2cf",
  );
});

test("parseBookBaseFromUrl rejects non-bookkit urls", () => {
  assert.equal(parseBookBaseFromUrl("https://example.com/other"), null);
  assert.equal(parseBookBaseFromUrl("not-a-url"), null);
});

test("formatSize formats bytes with sensible units", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(1024 * 1024), "1.0 MB");
  assert.equal(formatSize(150 * 1024 * 1024), "150 MB");
});

test("itemSize and compareBySize sort numerically", () => {
  const small = { size: 300 };
  const large = { binary: { size: 1000 } };
  const missing = {};

  assert.equal(itemSize(small), 300);
  assert.equal(itemSize(large), 1000);
  assert.equal(itemSize(missing), -1);
  assert.ok(compareBySize(small, large, "ASC") < 0);
  assert.ok(compareBySize(small, large, "DESC") > 0);
  assert.ok(compareBySize(missing, small, "ASC") < 0);
});

test("extractMentionedCodes finds uu5 and JSON attachment references", () => {
  const text = [
    '<UU5.Bricks.Image src="photo01" />',
    'code="doc_file"',
    "?code=from-query",
    '"binaryCode": "bin-42"',
    '"attachmentCode": "att-7"',
    '"fileCode": "file-9"',
    'srcUri="https://example/getBinary?code=uri-code"',
    '"code": "json-code"',
  ].join("\n");

  const codes = extractMentionedCodes(text);
  assert.deepEqual(
    [...new Set(codes)].sort(),
    ["att-7", "bin-42", "doc_file", "file-9", "from-query", "json-code", "photo01", "uri-code"].sort(),
  );
});

test("extractMentionedCodes finds src, dataUri, href and URL-encoded query codes", () => {
  const text = [
    '"src": "json-src-code"',
    '"dataUri": "data-uri-code"',
    '"href": "https://example/getBinary?code=href-json-code"',
    'href="https://example/getBinary?code=href-attr-code"',
    "?code=url%2Dencoded%2Dcode",
    'src="file%2Dname"',
  ].join("\n");

  const codes = extractMentionedCodes(text);
  assert.deepEqual(
    [...new Set(codes)].sort(),
    [
      "data-uri-code",
      "file-name",
      "href-attr-code",
      "href-json-code",
      "json-src-code",
      "url-encoded-code",
    ].sort(),
  );
});

test("extractMentionedCodes still finds codes in a large haystack via windows", () => {
  const text = "x".repeat(90000) + ' src="windowed-att-code" ' + "y".repeat(1000);
  const codes = extractMentionedCodes(text);
  assert.ok(codes.includes("windowed-att-code"));
});

test("async code extraction matches sync unique codes across regex window overlap", async () => {
  const prefix = "x".repeat(80000 - 12);
  const text = prefix + ' src="overlap-code" ' + "y".repeat(1000);
  assert.deepEqual(
    uniqueCodesInOrder(await extractMentionedCodesAsync(text)),
    uniqueCodesInOrder(extractMentionedCodes(text)),
  );
});

test("async haystack scan yields to timers and matches sync reference", async () => {
  const page = {
    items: Array.from({ length: 12000 }, (_, index) => ({
      body: 'src="synthetic-code-' + (index % 31) + '" ' + "x".repeat(100),
    })),
  };
  const expected = extractMentionedCodes(pageHaystack(page));
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount++;
  }, 0);

  const asyncHaystack = await pageHaystackAsync(page);
  const actual = await extractMentionedCodesAsync(asyncHaystack);
  clearInterval(heartbeat);

  assert.ok(heartbeatCount > 0);
  assert.equal(asyncHaystack, pageHaystack(page));
  assert.deepEqual(uniqueCodesInOrder(actual), uniqueCodesInOrder(expected));
});

test("usage hit deduplication preserves first path order", () => {
  const pathsByCode = new Map();
  const pathSetsByCode = new Map();
  [
    ["code-a", "Page 2"],
    ["code-a", "Page 1"],
    ["code-a", "Page 2"],
    ["code-a", "Page 1"],
    ["code-a", "Page 3"],
    ["code-a", "Page 3"],
  ].forEach(([code, path]) => recordUsageHit(pathsByCode, pathSetsByCode, code, path));

  assert.deepEqual(pathsByCode.get("code-a"), ["Page 2", "Page 1", "Page 3"]);
  assert.deepEqual([...pathSetsByCode.get("code-a")], ["Page 2", "Page 1", "Page 3"]);
});

test("isHaystackHostObject detects DOM-like hosts", () => {
  assert.equal(isHaystackHostObject({ nodeType: 1, tagName: "DIV" }), true);
  assert.equal(isHaystackHostObject({ content: "page" }), false);
});

test("pageHaystack skips long data URI blobs", () => {
  const haystack = pageHaystack({
    code: "keep-me",
    dataUri: "data:image/png;base64," + "A".repeat(5000),
  });
  assert.match(haystack, /keep-me/);
  assert.equal(haystack.includes("AAAA"), false);
});

test("pageHaystack collects nested string content from full page payload", () => {
  const haystack = pageHaystack({
    name: { cs: "Úvod" },
    desc: "Popis",
    uu5String: '<UU5.Bricks.Image src="uu5-string-code" />',
    contentEn: "content-en-code",
    body: [
      { content: 'src="used-attachment"' },
      { content: { nested: "ignored-object-string" } },
      '<UU5.Bricks.Image src="body-string-code" />',
    ],
    props: {
      nested: {
        dataUri: "nested-data-uri",
      },
    },
  });

  assert.match(haystack, /Úvod/);
  assert.match(haystack, /Popis/);
  assert.match(haystack, /used-attachment/);
  assert.match(haystack, /ignored-object-string/);
  assert.match(haystack, /uu5-string-code/);
  assert.match(haystack, /content-en-code/);
  assert.match(haystack, /body-string-code/);
  assert.match(haystack, /nested-data-uri/);
  assert.match(haystack, /"dataUri"/);
  assert.match(haystack, /"dataUri":"nested-data-uri"/);
});

test("pageHaystack survives cyclic object references", () => {
  const page = { name: "Cycle", body: [{ content: "cycle-code" }] };
  page.self = page;
  page.body[0].parent = page;

  assert.doesNotThrow(() => pageHaystack(page));
  assert.match(pageHaystack(page), /cycle-code/);
});

test("pageHaystack keeps JSON-like fragments for parsed attachment props", () => {
  const haystack = pageHaystack({
    parsed: {
      src: "parsed-src",
      dataUri: "parsed-data-uri",
      href: "parsed-href",
    },
    body: '<UU5.Bricks.Image src="body-code" />',
  });

  assert.match(haystack, /"src":"parsed-src"/);
  assert.match(haystack, /"dataUri":"parsed-data-uri"/);
  assert.match(haystack, /"href":"parsed-href"/);
  assert.match(haystack, /body-code/);
  assert.doesNotMatch(haystack, /"parsed"/);
});

test("pageHaystack rejects injectable traversal limits", () => {
  assert.throws(
    () => pageHaystack({ nested: { value: "too-many-nodes" } }, { maxNodes: 1 }),
    /node limit exceeded/,
  );
  assert.throws(
    () => pageHaystack({ body: "12345" }, { maxStringData: 4 }),
    /string limit exceeded/,
  );
});

test("safeSerializeForHaystack produces cycle-safe JSON", () => {
  const value = { code: "a", nested: { src: "b" } };
  value.nested.parent = value;

  const serialized = safeSerializeForHaystack(value);
  assert.match(serialized, /"src":"b"/);
  assert.doesNotThrow(() => JSON.parse(serialized));
});

test("scanConcurrencyForCount uses two workers above 1000 pages", () => {
  assert.equal(scanConcurrencyForCount(1000), 2);
  assert.equal(scanConcurrencyForCount(1001), 2);
  assert.equal(scanConcurrencyForCount(2161), 2);
});

test("nextRateGate spaces requests by the configured gap", () => {
  const first = nextRateGate(0, 1000, 150);
  assert.deepEqual(first, { waitMs: 0, nextAllowedAt: 1150 });
  const second = nextRateGate(first.nextAllowedAt, 1010, 150);
  assert.deepEqual(second, { waitMs: 140, nextAllowedAt: 1300 });
  const later = nextRateGate(1300, 2000, 150);
  assert.deepEqual(later, { waitMs: 0, nextAllowedAt: 2150 });
});

test("rate controller starts conservatively without a success streak", () => {
  const controller = createRateController();
  assert.deepEqual(controller.getState(), { gapMs: 75, successStreak: 0 });
  assert.deepEqual(RATE_CONTROLLER_DEFAULTS, {
    initialGapMs: 75,
    minGapMs: 15,
    maxGapMs: 2000,
    successStreakLimit: 10,
    successGapFactor: 0.8,
    failureMinGapMs: 250,
  });
});

test("rate controller lowers gap only after a stable success streak", () => {
  let state = { gapMs: 75, successStreak: 0 };
  for (let index = 0; index < 9; index++) {
    state = nextRateControllerState(state, "success");
  }
  assert.deepEqual(state, { gapMs: 75, successStreak: 9 });
  assert.deepEqual(nextRateControllerState(state, "success"), { gapMs: 60, successStreak: 0 });
});

test("rate controller stops decreasing at 15 ms", () => {
  let state = { gapMs: 19, successStreak: 9 };
  state = nextRateControllerState(state, "success");
  assert.deepEqual(state, { gapMs: 15, successStreak: 0 });
  for (let index = 0; index < 10; index++) {
    state = nextRateControllerState(state, "success");
  }
  assert.equal(state.gapMs, 15);
});

test("rate controller backs off failures multiplicatively with a 250 ms floor", () => {
  assert.deepEqual(
    nextRateControllerState({ gapMs: 100, successStreak: 7 }, "failure"),
    { gapMs: 250, successStreak: 0 },
  );
  assert.deepEqual(
    nextRateControllerState({ gapMs: 400, successStreak: 7 }, "failure"),
    { gapMs: 800, successStreak: 0 },
  );
});

test("rate controller caps failure backoff at 2000 ms", () => {
  assert.deepEqual(
    nextRateControllerState({ gapMs: 1500, successStreak: 4 }, "failure"),
    { gapMs: 2000, successStreak: 0 },
  );
  assert.deepEqual(
    nextRateControllerState({ gapMs: 2000, successStreak: 4 }, "failure"),
    { gapMs: 2000, successStreak: 0 },
  );
});

test("rate controller failure resets the success streak", () => {
  const controller = createRateController();
  for (let index = 0; index < 6; index++) controller.recordSuccess();
  assert.equal(controller.getState().successStreak, 6);
  assert.deepEqual(controller.recordFailure(), { gapMs: 250, successStreak: 0 });
});

test("shared rate gate spaces concurrent worker starts without burst", () => {
  let sharedNextAllowedAt = 0;
  const acquire = (now, gapMs) => {
    const planned = nextRateGate(sharedNextAllowedAt, now, gapMs);
    sharedNextAllowedAt = planned.nextAllowedAt;
    return planned;
  };

  const now = 1000;
  const first = acquire(now, 75);
  const second = acquire(now, 75);

  assert.deepEqual(first, { waitMs: 0, nextAllowedAt: 1075 });
  assert.deepEqual(second, { waitMs: 75, nextAllowedAt: 1150 });
});

test("rate gate uses the current gap without creating a burst", () => {
  const first = nextRateGate(0, 1000, 75);
  const second = nextRateGate(first.nextAllowedAt, 1000, 15);
  assert.deepEqual(first, { waitMs: 0, nextAllowedAt: 1075 });
  assert.deepEqual(second, { waitMs: 75, nextAllowedAt: 1090 });
});

test("yieldToBrowser yields to a timer macrotask", async () => {
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);

  await yieldToBrowser();
  assert.equal(timerRan, true);
});

test("normalizeHaystackText decodes common HTML entities", () => {
  assert.equal(normalizeHaystackText("&amp;quot;code&amp;quot;"), '"code"');
});

test("normalizeHaystackText skips entity replace when text has no ampersand", () => {
  assert.equal(normalizeHaystackText("plain-code"), "plain-code");
});

test("decodeMentionedCode skips decodeURIComponent when text has no percent", () => {
  assert.equal(decodeMentionedCode("file-name"), "file-name");
  assert.equal(decodeMentionedCode("file%2Dname"), "file-name");
});

test("async regex matcher yields during a single 80k window with many matches", async () => {
  const unit = "&code=hit";
  const text = unit.repeat(Math.floor(80000 / unit.length));
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount++;
  }, 0);

  await extractMentionedCodesAsync(text);
  clearInterval(heartbeat);

  assert.ok(heartbeatCount > 0);
});

test("async and sync extraction agree on encoded entity and overlap variants", async () => {
  const prefix = "x".repeat(80000 - 24);
  const text = [
    'code="file%2Dname"',
    '"code": "json%2Dcode"',
    "&quot;binaryCode&quot;: &quot;entity%2Dbin&quot;",
    prefix + ' src="overlap-code"',
  ].join("\n");

  assert.deepEqual(
    uniqueCodesInOrder(await extractMentionedCodesAsync(text)),
    uniqueCodesInOrder(extractMentionedCodes(text)),
  );
});

test("extractMentionedCodesAsync decodes each unique raw candidate once", async () => {
  let decodeCount = 0;
  const text = ('"code":"duplicate"').repeat(500);
  await extractMentionedCodesAsync(text, {
    hooks: {
      onDecodeMentionedCode: () => {
        decodeCount++;
      },
    },
  });

  assert.equal(decodeCount, 1);
  assert.deepEqual(
    uniqueCodesInOrder(await extractMentionedCodesAsync(text)),
    uniqueCodesInOrder(extractMentionedCodes(text)),
  );
});

test("extractMentionedCodesAsync rejects page when regex match limit exceeded", async () => {
  const text = "&code=x".repeat(HAYSTACK_REGEX_MATCH_LIMIT + 1);
  await assert.rejects(
    () => extractMentionedCodesAsync(text),
    (error) => error.message === HAYSTACK_REGEX_MATCH_LIMIT_ERROR,
  );
});

test("pullCodesFromPattern advances lastIndex on zero-length matches", () => {
  const pattern = /()/g;
  const found = [];
  const started = Date.now();
  pullCodesFromPattern(pattern, "abc", found);
  assert.ok(Date.now() - started < 500);
});

test("startUsageScan always runs a fresh scan without persistent usage cache", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "bookkit-file-manager.user.js"), "utf8");
  const startIndex = source.indexOf("async function startUsageScan()");
  assert.ok(startIndex >= 0);
  const startBody = source.slice(startIndex, startIndex + 4500);

  assert.doesNotMatch(
    source,
    /CACHE_KEY_PREFIX|CACHE_TTL_MS|cacheKey|readUsageCache|writeUsageCache|applyCachedPaths|shouldWriteUsageCache|structureRev/,
  );
  assert.doesNotMatch(startBody, /sessionStorage|localStorage/);
  assert.doesNotMatch(startBody, /readUsageCache|writeUsageCache|applyCachedPaths|shouldWriteUsageCache/);
  assert.match(startBody, /resetUsagePaths\(\)/);
  assert.match(startBody, /await mapPool\(pageCodes/);
  assert.match(source, /if \(!usageScan\.running\) startUsageScan\(\)/);
});

test("usagePathsForCode maps thumbnail suffix to base code", () => {
  const paths = { photo: ["Home > Gallery"] };
  assert.deepEqual(usagePathsForCode(paths, "photo"), ["Home > Gallery"]);
  assert.deepEqual(usagePathsForCode(paths, "photo_th"), ["Home > Gallery"]);
  assert.deepEqual(usagePathsForCode(paths, "missing"), []);
});

test("unusedCodes returns only unused attachments after a clean scan", () => {
  const items = [
    { code: "used" },
    { code: "unused" },
    { binary: { code: "thumbnail_th" } },
  ];
  const paths = new Map([
    ["used", ["Intro"]],
    ["thumbnail", ["Gallery"]],
  ]);

  assert.deepEqual(unusedCodes(items, paths, true, 0), ["unused"]);
  assert.deepEqual(unusedCodes(items, paths, false, 0), []);
  assert.deepEqual(unusedCodes(items, paths, true, 1), []);
});

test("addCodesToSelection preserves existing selection and adds codes once", () => {
  const selected = [{ code: "already-selected" }];
  const added = [];
  const controller = {
    getSelectedItemList: () => selected,
    addSelectedItem: (code) => {
      added.push(code);
      selected.push({ code });
    },
  };

  assert.equal(
    addCodesToSelection(controller, ["already-selected", "unused-a", "unused-a", "unused-b"]),
    2,
  );
  assert.deepEqual(added, ["unused-a", "unused-b"]);
});
