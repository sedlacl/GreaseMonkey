const test = require("node:test");
const assert = require("node:assert/strict");

const { parseBookContextFromUrl, mergeBookRegistries, createPageListFromStructure, extractSearchText } = require("../bookkit-fulltext-search.user.js");

test("parseBookContextFromUrl extracts baseUri, awid and pageCode", () => {
  const context = parseBookContextFromUrl("https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3/book/page?code=intro");

  assert.equal(context.origin, "https://uuapp.plus4u.net");
  assert.equal(context.awid, "10b5c8ef37b74c11a7a4d7e566ec00b3");
  assert.equal(context.baseUri, "https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3");
  assert.equal(context.pageCode, "intro");
  assert.equal(context.bookId, "https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3");
});

test("parseBookContextFromUrl accepts prefixed workspace ids", () => {
  const context = parseBookContextFromUrl("https://uuapp.plus4u.net/uu-bookkit-maing01/78462435-e884539c8511447a977c7ff070e7f2cf/book/page?code=home");

  assert.equal(context.awid, "78462435-e884539c8511447a977c7ff070e7f2cf");
  assert.equal(context.baseUri, "https://uuapp.plus4u.net/uu-bookkit-maing01/78462435-e884539c8511447a977c7ff070e7f2cf");
  assert.equal(context.pageCode, "home");
});

test("mergeBookRegistries keeps existing metadata and applies seed defaults", () => {
  const merged = mergeBookRegistries(
    [
      {
        bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/a/book",
        baseUri: "https://uuapp.plus4u.net/uu-bookkit-maing01/a/book",
        title: "Seed title",
        seed: true,
      },
    ],
    [
      {
        bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/a/book",
        baseUri: "https://uuapp.plus4u.net/uu-bookkit-maing01/a/book",
        title: "Runtime title",
        lastIndexedAt: 123,
        pageCount: 42,
      },
      {
        bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/b/book",
        baseUri: "https://uuapp.plus4u.net/uu-bookkit-maing01/b/book",
        title: "Another book",
      },
    ],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, "Runtime title");
  assert.equal(merged[0].seed, true);
  assert.equal(merged[0].pageCount, 42);
  assert.equal(merged[1].title, "Another book");
});

test("createPageListFromStructure rebuilds ordered paths from itemMap", () => {
  const pages = createPageListFromStructure(
    {
      itemMap: {
        home: {
          next: "intro",
          previous: "",
          indent: 0,
          label: { cs: "Home" },
        },
        intro: {
          next: "topic1",
          previous: "home",
          indent: 0,
          label: { cs: "Intro" },
        },
        topic1: {
          next: "topic1a",
          previous: "intro",
          indent: 1,
          label: { cs: "Topic 1" },
        },
        topic1a: {
          next: "",
          previous: "topic1",
          indent: 2,
          label: { cs: "Topic 1A" },
        },
      },
    },
    "https://example.com/uu-bookkit-maing01/awid",
  );

  assert.deepEqual(
    pages.map((item) => ({ code: item.code, path: item.path })),
    [
      { code: "home", path: "/Home" },
      { code: "intro", path: "/Intro" },
      { code: "topic1", path: "/Intro/Topic 1" },
      { code: "topic1a", path: "/Intro/Topic 1/Topic 1A" },
    ],
  );
});

test("extractSearchText strips uu5 markup noise and keeps visible text", () => {
  const text = extractSearchText(
    "<uu5string/>" +
      '<UU5.Bricks.Section header="Sekce A">' +
      '<UU5.Bricks.Text content="Ahoj &amp; nazdar" />' +
      "<p> Viditelný text </p>" +
      '<UuDcc.Bricks.Block data=\"ignored\" />' +
      "</UU5.Bricks.Section>",
  );

  assert.match(text, /Sekce A/);
  assert.match(text, /Ahoj & nazdar/);
  assert.match(text, /Viditelný text/);
  assert.doesNotMatch(text, /UU5\.Bricks/);
  assert.doesNotMatch(text, /uu5string/);
});

test("extractSearchText extracts useful strings from embedded uu5json payloads", () => {
  const text = extractSearchText(
    "<uu5string/>" +
      '<UU5.Bricks.Section header="Základní informace">' +
      '<UuApp.DesignKit.BulletList data="<uu5json/>{\n' +
      '  \\"itemList\\": [\n' +
      "    {\n" +
      '      \\"type\\": \\"bulletItem\\",\n' +
      '      \\"id\\": \\"abc\\",\n' +
      '      \\"name\\": \\"Týmový portál\\",\n' +
      '      \\"desc\\": \\"<uu5string /><UU5.Bricks.Div>IndSoft Maintenance Project Portal</UU5.Bricks.Div>\\"\n' +
      "    }\n" +
      "  ]\n" +
      '}" />' +
      "</UU5.Bricks.Section>",
  );

  assert.match(text, /Základní informace/);
  assert.match(text, /Týmový portál/);
  assert.match(text, /IndSoft Maintenance Project Portal/);
  assert.doesNotMatch(text, /\\"itemList\\"/);
  assert.doesNotMatch(text, /\bbulletItem\b/);
});

test("extractSearchText keeps code attribute values", () => {
  const text = extractSearchText(
    '<uu5string/><UU5.Bricks.Section header="Docker">' + '<UU5.Bricks.Code code="RUN update-ca-certificates" />' + "</UU5.Bricks.Section>",
  );

  assert.match(text, /update-ca-certificates/);
});

test("extractSearchText extracts nested uu5string attribute markup", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const samplePath = path.join(__dirname, "sample-section0.json");
  if (!fs.existsSync(samplePath)) {
    return;
  }

  const payload = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const text = extractSearchText(payload.result);

  assert.match(text, /CA \/Ubuntu/);
  assert.match(text, /update-ca-certificates/);
  assert.doesNotMatch(text, /RichText\.Block/);
});

test("searchDocuments prefers exact phrase matches over fuzzy update hits", () => {
  const { searchDocuments } = require("../bookkit-fulltext-search.user.js");
  const documents = [
    {
      id: "1",
      pageTitle: "IDS-4684 uuCloud update process",
      path: "/Cloud/update",
      sectionTitle: "Process",
      text: "This page describes the update process only.",
      excerpt: "update process",
      url: "https://example.com/1",
    },
    {
      id: "2",
      pageTitle: "Base image build",
      path: "/Docker/base",
      sectionTitle: "Packages",
      text: "Before build run update-ca-certificates inside the container.",
      excerpt: "update-ca-certificates",
      url: "https://example.com/2",
    },
  ];

  const results = searchDocuments(null, documents, "update-ca-certificates");

  assert.equal(results.length, 1);
  assert.equal(results[0].pageTitle, "Base image build");
});

test("buildResultSnippet centers excerpt around query and highlights match", () => {
  const { buildResultSnippet } = require("../bookkit-fulltext-search.user.js");
  const html = buildResultSnippet(
    {
      pageTitle: "Deploy uuDiCK",
      path: "/Technologies/Deploy uuDiCK",
      sectionTitle: "Pile of commands",
      text: "GIT: http.allowNTLMAuth = true git config http.example.com.allowNTLMAuth true NPM: npm config set registry https://repo.plus4u.net/repository/npm/ update-ca-certificates before deploy",
      excerpt: "GIT: http.allowNTLMAuth = true git config http.example.com.allowNTLMAuth true NPM: npm config set registry https://",
    },
    "update-ca-certificates",
  );

  assert.match(html, /<mark class="gm-bookkit-fulltext__hit">update-ca-certificates<\/mark>/);
  assert.match(html, /before deploy/);
  assert.doesNotMatch(html, /^GIT:/);
});

test("groupSearchResultsByPage merges hits from the same page", () => {
  const { groupSearchResultsByPage } = require("../bookkit-fulltext-search.user.js");
  const grouped = groupSearchResultsByPage([
    {
      id: "1",
      bookId: "book-a",
      pageCode: "85891038",
      url: "https://example.com/book/page?code=85891038",
      pageTitle: "Správa modelu IDS",
      path: "/Znalostní báze IDS/Správa modelu IDS",
      sectionTitle: "",
      score: 10,
    },
    {
      id: "2",
      bookId: "book-a",
      pageCode: "85891038",
      url: "https://example.com/book/page?code=85891038",
      pageTitle: "Správa modelu IDS",
      path: "/Znalostní báze IDS/Správa modelu IDS",
      sectionTitle: "Základní koncepce",
      score: 8,
    },
    {
      id: "3",
      bookId: "book-a",
      pageCode: "other",
      url: "https://example.com/book/page?code=other",
      pageTitle: "Jiná stránka",
      path: "/Jiná stránka",
      sectionTitle: "",
      score: 5,
    },
  ]);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].pageTitle, "Správa modelu IDS");
  assert.equal(grouped[0].hits.length, 2);
  assert.equal(grouped[1].pageTitle, "Jiná stránka");
});

test("extractBookTitleFromBookDto reads book name from getBook payload", () => {
  const { extractBookTitleFromBookDto } = require("../bookkit-fulltext-search.user.js");

  assert.equal(
    extractBookTitleFromBookDto({
      name: { en: "GMA2 Application Model", cs: "GMA2 Application Model" },
    }),
    "GMA2 Application Model",
  );
});

test("parseBookTitleFromDocumentTitle extracts book name from browser title", () => {
  const { parseBookTitleFromDocumentTitle } = require("../bookkit-fulltext-search.user.js");

  assert.equal(parseBookTitleFromDocumentTitle("Intro - IDS Maintenance - Documentation - uuBookKit"), "IDS Maintenance - Documentation");
  assert.equal(parseBookTitleFromDocumentTitle("Page - uuBookKit"), "Page");
});

test("mergeBookRegistries drops generic uuBookKit titles from storage", () => {
  const { mergeBookRegistries } = require("../bookkit-fulltext-search.user.js");
  const merged = mergeBookRegistries([], [{ bookId: "https://example.com/awid", baseUri: "https://example.com/awid", title: "uuBookKit" }]);
  assert.equal(merged[0].title, undefined);
});

test("pickBetterBookTitle prefers Application Model over generic Documentation label", () => {
  const { pickBetterBookTitle } = require("../bookkit-fulltext-search.user.js");

  assert.equal(pickBetterBookTitle("uuBookKit Documentation", "uuBookKit Main g01 - Application Model"), "uuBookKit Main g01 - Application Model");
  assert.equal(pickBetterBookTitle("IDS", "IDS Business Model"), "IDS Business Model");
});

test("extractBookTitleFromBookDto prefers longest name with model kind", () => {
  const { extractBookTitleFromBookDto } = require("../bookkit-fulltext-search.user.js");

  assert.equal(
    extractBookTitleFromBookDto({
      name: { cs: "IDS", en: "IDS Business Model" },
    }),
    "IDS Business Model",
  );
});

test("pickBetterBookTitle keeps specific titles over generic page labels", () => {
  const { pickBetterBookTitle } = require("../bookkit-fulltext-search.user.js");

  assert.equal(pickBetterBookTitle("uuBookKit", "IDS Maintenance - Documentation"), "IDS Maintenance - Documentation");
  assert.equal(pickBetterBookTitle("IDS Maintenance - Documentation", "Page"), "IDS Maintenance - Documentation");
});

test("getNavBooks returns visited books sorted by recency", () => {
  const { getNavBooks } = require("../bookkit-fulltext-search.user.js");
  const books = getNavBooks({
    books: [
      {
        bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/10b5c8ef37b74c11a7a4d7e566ec00b3",
        title: "IDS Maintenance - aktualizovaný název",
        lastVisitedAt: 100,
        lastIndexedAt: 123,
      },
      {
        bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Návštívená kniha",
        lastVisitedAt: 500,
      },
      {
        bookId: "https://uuapp.plus4u.net/uu-bookkit-maing01/e3f5c648e85f4319bd8fc25ea5be6c2c",
        title: "uuBookKit Documentation",
        known: true,
        seed: true,
      },
    ],
  });

  assert.equal(books.length, 2);
  assert.equal(books[0].title, "Návštívená kniha");
  assert.equal(books[1].title, "IDS Maintenance - aktualizovaný název");
});

test("fingerprintStructure changes when book structure changes", () => {
  const { fingerprintStructure } = require("../bookkit-fulltext-search.user.js");

  const before = {
    itemMap: {
      home: { next: "", previous: "", indent: 0, label: { cs: "Home" } },
    },
  };
  const after = {
    itemMap: {
      home: { next: "intro", previous: "", indent: 0, label: { cs: "Home" } },
      intro: { next: "", previous: "home", indent: 0, label: { cs: "Intro" } },
    },
  };

  assert.equal(fingerprintStructure(before), fingerprintStructure(before));
  assert.notEqual(fingerprintStructure(before), fingerprintStructure(after));
});

test("formatBookIndexLabel describes index freshness", () => {
  const { formatBookIndexLabel } = require("../bookkit-fulltext-search.user.js");

  assert.equal(formatBookIndexLabel({}), "bez lokálního indexu");
  assert.match(formatBookIndexLabel({ lastIndexedAt: Date.now() - 3600000, pageCount: 42 }), /indexováno .* · 42 stránek/);
});

test("mergeBookRegistries omits dismissed seed books", () => {
  const { mergeBookRegistries } = require("../bookkit-fulltext-search.user.js");

  const merged = mergeBookRegistries(
    [
      {
        bookId: "seed-book",
        baseUri: "https://example.com/seed-book",
        title: "Seed title",
        seed: true,
      },
    ],
    [
      {
        bookId: "runtime-book",
        baseUri: "https://example.com/runtime-book",
        title: "Runtime title",
      },
    ],
    { dismissedBookIds: ["seed-book"] },
  );

  assert.deepEqual(
    merged.map((book) => book.bookId),
    ["runtime-book"],
  );
});

test("formatIndexManageInfo reports index age, section count and size", () => {
  const { estimateIndexSize, formatIndexManageInfo } = require("../bookkit-fulltext-search.user.js");
  const documents = [
    {
      pageTitle: "Application Model",
      path: "/Intro",
      sectionTitle: "Install",
      excerpt: "Short excerpt",
      text: "A".repeat(1800),
      url: "https://example.com/book/page?code=intro",
    },
  ];

  assert.match(estimateIndexSize(documents), /KB|MB/);
  assert.equal(formatIndexManageInfo({}, null), "bez lokálního indexu");
  assert.match(formatIndexManageInfo({ lastIndexedAt: Date.now() - 3600000 }, { documents }), /indexováno .* · 1 sekcí · .*B/);
});

test("enrichDocumentsWithBookTitle attaches book title by bookId", () => {
  const { enrichDocumentsWithBookTitle } = require("../bookkit-fulltext-search.user.js");
  const enriched = enrichDocumentsWithBookTitle(
    [
      { id: "a", bookId: "book-a", pageTitle: "Intro" },
      { id: "b", bookId: "book-b", pageTitle: "Install" },
    ],
    {
      "book-a": { title: "Application Model" },
      "book-b": { title: "Business Model" },
    },
  );

  assert.equal(enriched[0].bookTitle, "Application Model");
  assert.equal(enriched[1].bookTitle, "Business Model");
});

test("groupSearchResultsByPage keeps book title for cross-book rendering", () => {
  const { groupSearchResultsByPage } = require("../bookkit-fulltext-search.user.js");
  const grouped = groupSearchResultsByPage([
    {
      id: "1",
      bookId: "book-a",
      bookTitle: "Application Model",
      pageCode: "intro",
      url: "https://example.com/a?page=intro",
      pageTitle: "Install",
      path: "/Install",
      score: 10,
    },
  ]);

  assert.equal(grouped[0].bookTitle, "Application Model");
});

test("getProgressPercent clamps progress into 0-100 range", () => {
  const { getProgressPercent } = require("../bookkit-fulltext-search.user.js");

  assert.equal(getProgressPercent(0, 0), 0);
  assert.equal(getProgressPercent(1, 4), 25);
  assert.equal(getProgressPercent(5, 4), 100);
});

test("getManageButtonStates keeps remove-index disabled without index", () => {
  const { getManageButtonStates } = require("../bookkit-fulltext-search.user.js");

  assert.deepEqual(getManageButtonStates({ baseUri: "https://example.com/book" }, null, false), {
    refreshDisabled: false,
    removeIndexDisabled: true,
    removeBookDisabled: false,
  });

  assert.deepEqual(getManageButtonStates({ baseUri: "https://example.com/book" }, { documents: [{ id: "1" }] }, true), {
    refreshDisabled: true,
    removeIndexDisabled: true,
    removeBookDisabled: true,
  });
});

test("extractSearchText extracts Uu5TilesBricks.Table rows from single-quoted data attribute", () => {
  const { extractSearchText } = require("../bookkit-fulltext-search.user.js");

  const text = extractSearchText(
    "<uu5string/>" +
      "<Uu5TilesBricks.Table data='<uu5json/>[\n" +
      '  ["Prostředí", "Služba", "Connection String"],\n' +
      '  [{"value": "T1"}, "PM Tlustý klient", "http://T1-Transport1.sids.local:2558/Transport1", "Transport1.test"]\n' +
      "]' />",
  );

  assert.match(text, /Prostředí/);
  assert.match(text, /PM Tlustý klient/);
  assert.match(text, /Transport1\.test/);
  assert.match(text, /T1-Transport1/);
});

test("shouldSendDiag requires __gmBrowserBridge flag", () => {
  const { shouldSendDiag } = require("../bookkit-fulltext-search.user.js");

  assert.equal(shouldSendDiag(undefined), false);
  assert.equal(shouldSendDiag({}), false);
  assert.equal(shouldSendDiag({ __gmBrowserBridge: true }), true);
});

test("shouldPrepareAllScopeLoad only when switching to all without cache", () => {
  const { shouldPrepareAllScopeLoad } = require("../bookkit-fulltext-search.user.js");

  assert.equal(shouldPrepareAllScopeLoad("current", null), false);
  assert.equal(shouldPrepareAllScopeLoad("all", null), true);
  assert.equal(shouldPrepareAllScopeLoad("all", { documents: [] }), false);
});

test("getSearchActivityMessage returns labels for search transitions", () => {
  const { getSearchActivityMessage } = require("../bookkit-fulltext-search.user.js");

  assert.equal(getSearchActivityMessage("open"), "Připravuji vyhledávání…");
  assert.equal(getSearchActivityMessage("scope-all"), "Načítám indexy pro hledání všude…");
  assert.equal(getSearchActivityMessage("scope-current"), "Načítám aktuální BookKit…");
  assert.equal(getSearchActivityMessage("other"), "Načítám…");
});
