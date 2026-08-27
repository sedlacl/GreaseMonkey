const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBookBaseFromUrl,
  formatSize,
  itemSize,
  extractMentionedCodes,
  pageHaystack,
  structureRev,
  shouldWriteUsageCache,
  compareBySize,
  usagePathsForCode,
  unusedCodes,
  addCodesToSelection,
  SCRIPT_VERSION,
} = require("../bookkit-file-manager.user.js");

test("SCRIPT_VERSION is 1.4.2", () => {
  assert.equal(SCRIPT_VERSION, "1.4.2");
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

test("pageHaystack collects nested string content", () => {
  const haystack = pageHaystack({
    name: { cs: "Úvod" },
    desc: "Popis",
    body: [{ content: 'src="used-attachment"' }, { content: { nested: "ignored-object-string" } }],
  });

  assert.match(haystack, /Úvod/);
  assert.match(haystack, /Popis/);
  assert.match(haystack, /used-attachment/);
  assert.match(haystack, /ignored-object-string/);
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
