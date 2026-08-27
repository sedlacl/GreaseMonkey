const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBookBaseFromUrl,
  formatSize,
  itemSize,
  extractMentionedCodes,
  normalizeHaystackText,
  safeSerializeForHaystack,
  pageHaystack,
  structureRev,
  shouldWriteUsageCache,
  compareBySize,
  usagePathsForCode,
  unusedCodes,
  addCodesToSelection,
  isMissingIntroError,
  loadOptionalIntro,
  SCRIPT_VERSION,
} = require("../bookkit-file-manager.user.js");

test("SCRIPT_VERSION is 1.4.4", () => {
  assert.equal(SCRIPT_VERSION, "1.4.4");
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
});

test("pageHaystack survives cyclic object references", () => {
  const page = { name: "Cycle", body: [{ content: "cycle-code" }] };
  page.self = page;
  page.body[0].parent = page;

  assert.doesNotThrow(() => pageHaystack(page));
  assert.match(pageHaystack(page), /cycle-code/);
});

test("safeSerializeForHaystack produces cycle-safe JSON", () => {
  const value = { code: "a", nested: { src: "b" } };
  value.nested.parent = value;

  const serialized = safeSerializeForHaystack(value);
  assert.match(serialized, /"src":"b"/);
  assert.doesNotThrow(() => JSON.parse(serialized));
});

test("normalizeHaystackText decodes common HTML entities", () => {
  assert.equal(normalizeHaystackText("&amp;quot;code&amp;quot;"), '"code"');
});

test("structureRev reads sys.rev", () => {
  assert.equal(structureRev({ sys: { rev: 12 } }), "12");
  assert.equal(structureRev({}), "");
});

test("shouldWriteUsageCache requires clean completed scan with hits", () => {
  const paths = new Map([["a", ["Intro"]]]);
  assert.equal(shouldWriteUsageCache({ completed: true, failedCount: 0, pathsByCode: paths }), true);
  assert.equal(shouldWriteUsageCache({ completed: true, failedCount: 1, pathsByCode: paths }), false);
  assert.equal(shouldWriteUsageCache({ completed: false, failedCount: 0, pathsByCode: paths }), false);
  assert.equal(shouldWriteUsageCache({ completed: true, failedCount: 0, pathsByCode: new Map() }), false);
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
