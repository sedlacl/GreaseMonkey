const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../jira-attachment-preview.user.js");

test("SCRIPT_VERSION is 1.0.2", () => {
  assert.equal(api.SCRIPT_VERSION, "1.0.2");
});

test("classifyAttachment: known extension decides, case-insensitive, last suffix", () => {
  assert.equal(api.classifyAttachment({ filename: "dashboard.HTML" }), "html");
  assert.equal(api.classifyAttachment({ filename: "report.htm" }), "html");
  assert.equal(api.classifyAttachment({ filename: "06-ts-list-incident.json" }), "text");
  assert.equal(api.classifyAttachment({ filename: "07-manual-test-output-excerpt.txt" }), "text");
  assert.equal(api.classifyAttachment({ filename: "query.sql" }), "text");
  assert.equal(api.classifyAttachment({ filename: "screenshot-1.png" }), "image");
  assert.equal(api.classifyAttachment({ filename: "diagram.SVG" }), "image");
  assert.equal(api.classifyAttachment({ filename: "spec.pdf" }), "pdf");
  assert.equal(api.classifyAttachment({ filename: "archive.tar.gz" }), null);
  assert.equal(api.classifyAttachment({ filename: "data.json.zip" }), null);
});

test("classifyAttachment: extension wins over Jira MIME", () => {
  assert.equal(api.classifyAttachment({ filename: "a.json", mimeType: "text/plain" }), "text");
  assert.equal(api.classifyAttachment({ filename: "a.html", mimeType: "application/x-sql" }), "html");
  assert.equal(api.classifyAttachment({ filename: "a.pdf", mimeType: "application/octet-stream" }), "pdf");
});

test("classifyAttachment: MIME without parameters decides when extension is unknown", () => {
  assert.equal(api.classifyAttachment({ filename: "noext", mimeType: "text/plain; charset=UTF-8" }), "text");
  assert.equal(api.classifyAttachment({ filename: "page", mimeType: "TEXT/HTML" }), "html");
  assert.equal(api.classifyAttachment({ filename: "x.dat", mimeType: "application/json" }), "text");
  assert.equal(api.classifyAttachment({ filename: "x.dat", mimeType: "application/x-sql" }), "text");
  assert.equal(api.classifyAttachment({ filename: "x.dat", mimeType: "image/tiff" }), "image");
  assert.equal(api.classifyAttachment({ filename: "x.dat", mimeType: "application/pdf" }), "pdf");
});

test("classifyAttachment: unsupported types get no preview", () => {
  for (const filename of ["a.zip", "a.docx", "a.xlsx", "a.bin"]) {
    assert.equal(api.classifyAttachment({ filename }), null, filename);
  }
  assert.equal(api.classifyAttachment({ filename: "blob", mimeType: "application/octet-stream" }), null);
  assert.equal(api.classifyAttachment({}), null);
});

test("isWithinPreviewLimit: 10 MiB inclusive", () => {
  assert.equal(api.PREVIEW_LIMIT_BYTES, 10 * 1024 * 1024);
  assert.equal(api.isWithinPreviewLimit(0), true);
  assert.equal(api.isWithinPreviewLimit(10 * 1024 * 1024), true);
  assert.equal(api.isWithinPreviewLimit(10 * 1024 * 1024 + 1), false);
  assert.equal(api.isWithinPreviewLimit(Number.NaN), false);
});

test("sandboxAttribute: scripts allowed, no same-origin or top navigation", () => {
  const value = api.sandboxAttribute();
  assert.equal(value, "allow-scripts allow-popups allow-forms allow-modals allow-downloads");
  assert.ok(!value.includes("allow-same-origin"));
  assert.ok(!value.includes("allow-top-navigation"));
});

test("formatJsonPreview: pretty prints valid JSON, keeps invalid text", () => {
  assert.equal(api.formatJsonPreview('{"a":1,"b":[true]}'), '{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
  assert.equal(api.formatJsonPreview('{"a":1}\n{"a":2}'), '{"a":1}\n{"a":2}');
  assert.equal(api.formatJsonPreview("not json"), "not json");
});

test("shouldFormatJson: only .json or application/json, not jsonl/ndjson", () => {
  assert.equal(api.shouldFormatJson({ filename: "a.json", mimeType: "text/plain" }), true);
  assert.equal(api.shouldFormatJson({ filename: "a", mimeType: "application/json; charset=UTF-8" }), true);
  assert.equal(api.shouldFormatJson({ filename: "a.jsonl", mimeType: "text/plain" }), false);
  assert.equal(api.shouldFormatJson({ filename: "a.ndjson", mimeType: "" }), false);
});

test("resolvePreviewUrl: same origin http(s) only", () => {
  const page = "http://jira.indsoft.local/browse/IDSM-6362";
  assert.equal(
    api.resolvePreviewUrl("/secure/attachment/1/a.html", page),
    "http://jira.indsoft.local/secure/attachment/1/a.html",
  );
  assert.equal(
    api.resolvePreviewUrl("http://jira.indsoft.local/secure/attachment/1/a.html", page),
    "http://jira.indsoft.local/secure/attachment/1/a.html",
  );
  assert.equal(api.resolvePreviewUrl("https://evil.example/secure/attachment/1/a.html", page), null);
  assert.equal(api.resolvePreviewUrl("javascript:alert(1)", page), null);
  assert.equal(api.resolvePreviewUrl("https://jira.indsoft.local/secure/attachment/1/a", page), null);
});

test("filenameFromUrl and mimeTypeFromDownloadUrl", () => {
  assert.equal(api.filenameFromUrl("http://jira/secure/attachment/1/m%C4%9B%C5%99en%C3%AD.txt"), "měření.txt");
  assert.equal(
    api.mimeTypeFromDownloadUrl("text/html:dashboard.html:http://jira.indsoft.local/secure/attachment/1/dashboard.html"),
    "text/html",
  );
  assert.equal(api.mimeTypeFromDownloadUrl(null), "");
});

test("decodeText: charset from Content-Type, UTF-8 by default", () => {
  const utf8 = new TextEncoder().encode("Příliš žluťoučký");
  assert.equal(api.decodeText(utf8, "text/plain"), "Příliš žluťoučký");
  assert.equal(api.decodeText(Uint8Array.from([0xe8]), "text/plain; charset=windows-1250"), "č");
  assert.equal(api.decodeText(Uint8Array.from([0xe8]), "text/plain; charset=iso-8859-2"), "č");
  assert.equal(api.decodeText(utf8, "text/plain; charset=bogus"), "Příliš žluťoučký");
  assert.equal(api.charsetOfMimeType('text/html; charset="UTF-8"'), "UTF-8");
});

test("attachmentIdFromHref", () => {
  assert.equal(api.attachmentIdFromHref("/secure/attachment/51156/01-get.sql"), "51156");
  assert.equal(api.attachmentIdFromHref("http://jira.indsoft.local/secure/attachment/7/"), "7");
  assert.equal(api.attachmentIdFromHref("/secure/attachmentzip/51156.zip"), "");
  assert.equal(api.attachmentIdFromHref("/secure/attachment/abc/x"), "");
});

test("previewAttachmentId accepts only digits", () => {
  assert.equal(api.previewAttachmentId("?viewAttachment=51156"), "51156");
  assert.equal(api.previewAttachmentId("?a=1&viewAttachment=7"), "7");
  assert.equal(api.previewAttachmentId("?viewAttachment=../../rest"), "");
  assert.equal(api.previewAttachmentId("?viewAttachment=1%2F2"), "");
  assert.equal(api.previewAttachmentId("?viewAttachement=51156"), "");
  assert.equal(api.previewAttachmentId(""), "");
});

test("previewPageUrl: issue page with ?viewAttachment, path fallback", () => {
  assert.equal(
    api.previewPageUrl({ origin: "http://jira.indsoft.local", issueKey: "idsm-6362", pathname: "/issues/", attachmentId: "51156" }),
    "http://jira.indsoft.local/browse/IDSM-6362?viewAttachment=51156",
  );
  assert.equal(
    api.previewPageUrl({ origin: "http://jira.indsoft.local", issueKey: "", pathname: "/projects/IDSM/issues/", attachmentId: "1" }),
    "http://jira.indsoft.local/projects/IDSM/issues/?viewAttachment=1",
  );
  assert.equal(
    api.previewPageUrl({ origin: "http://jira.indsoft.local", issueKey: "x/../y", pathname: "", attachmentId: "1" }),
    "http://jira.indsoft.local/?viewAttachment=1",
  );
});

test("attachmentContentPath encodes the file name", () => {
  assert.equal(api.attachmentContentPath("5", "a b#č.html"), "/secure/attachment/5/a%20b%23%C4%8D.html");
});
