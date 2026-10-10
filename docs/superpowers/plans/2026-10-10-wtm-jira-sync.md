# WTM ← Jira sync – plán implementace

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Userscript na stránce WTM „Výkazy za měsíc“, který spáruje položky WTM s worklogy v Jiře, označí stav (OK / liší se / chybí ve WTM / není v Jiře) a po kliknutí dorovná WTM podle Jiry.

**Architecture:** Jeden soubor `wtm-jira-sync.user.js` ve vzoru repa (factory → `module.exports` pro node testy, `run()` v prohlížeči). Čistá logika (časy, normalizace, párování, mapování, pravidla WTM) je testovaná v node. Do stránky se vkládá „page agent“ (inline `<script>`), který zachytává odpověď měsíce a token WTM a provádí zápisy; s userscriptem mluví přes `window.postMessage`. Jira se volá přes `GM_xmlhttpRequest` s cookies prohlížeče.

**Tech Stack:** vanilla JS (ES2020) userscript pro Tampermonkey, `node:test` + `node:assert/strict`, browser bridge (`tools/browser-bridge-*.mjs`) pro ladění v Chromu.

**Spec:** `docs/specs/2026-10-10-wtm-jira-sync-design.md`

## Global Constraints

- Nový skript jen jako `wtm-jira-sync.user.js` (žádný ne-`.user.js` shim) – `agent.md`.
- Při každé změně skriptu zvýšit `@version` i `SCRIPT_VERSION` (patch). Start `0.1.0`.
- `@match https://uuapp.plus4u.net/uu-specialistwtm-maing01/*`, `@connect jira.indsoft.local`, `@run-at document-start`.
- Časová zóna všech dnů a časů: `Europe/Prague`.
- Jira je zdroj pravdy; skript nikdy nezapisuje do Jiry a nikdy nemaže ve WTM.
- Potvrzené položky WTM (`state !== "active"`) se nemění.
- Popisky UI česky; stránku testovat v češtině i angličtině.
- Repo je veřejné (GitHub sedlacl/GreaseMonkey): do testů ani fixtures nedávat reálná data z WTM/Jiry.
- Commity jen se souhlasem uživatele (uživatelské pravidlo má přednost před „Commit“ kroky níže).
- Testy: `node --test test/wtm-jira-sync.test.js` (z kořene repa `R:\External\GreaseMonkey`).

## Struktura souborů

- Create: `wtm-jira-sync.user.js` – celý skript; sekce v tomto pořadí:
  `PURE: time` → `PURE: normalize` → `PURE: match` → `PURE: mapping & rules` → `PURE: wtm capture` →
  `PURE: jira` → `PURE: dom text` → `BROWSER: agent` → `BROWSER: settings & transport` →
  `BROWSER: dom` → `BROWSER: render` → `BROWSER: actions` → `BROWSER: panel` → `run()`.
- Create: `test/wtm-jira-sync.test.js` – node testy čisté logiky.
- Modify: `README.md`, `changelogs.md` – zmínka o novém skriptu (Task 11).

Každý task přidává funkce **nad** komentář `// --- BROWSER ---` (čisté) nebo **nad** `function run()` (prohlížečové) a rozšiřuje objekt `return { … }` na konci factory.

---

### Task 1: Kostra skriptu a časové funkce

**Files:**
- Create: `wtm-jira-sync.user.js`
- Create: `test/wtm-jira-sync.test.js`

**Interfaces:**
- Produces: `SCRIPT_VERSION: string`, `toPragueParts(input: string|number|Date) → {date:"YYYY-MM-DD", hm:"HH:MM"}`,
  `pragueToUtcIso(date: string, hm: string) → string`, `minutesOf(hm: string) → number`,
  `durationMinutes(from: string, to: string) → number`, `formatMinutes(min: number) → "H:MM"`,
  `monthRange(yearMonth: "YYYYMM") → {from, to}`, `previousYearMonthDash("YYYY-MM") → "YYYY-MM"`,
  `todayPrague() → "YYYY-MM-DD"`, `run()`.

- [ ] **Step 1: Napiš failing test**

`test/wtm-jira-sync.test.js`:
```js
const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../wtm-jira-sync.user.js");

test("SCRIPT_VERSION is 0.1.0", () => {
  assert.equal(api.SCRIPT_VERSION, "0.1.0");
});

test("toPragueParts converts UTC to Prague (summer time)", () => {
  assert.deepEqual(api.toPragueParts("2026-10-09T05:45:00.000Z"), { date: "2026-10-09", hm: "07:45" });
});

test("toPragueParts handles winter time and day boundary", () => {
  assert.deepEqual(api.toPragueParts("2026-11-02T23:30:00.000Z"), { date: "2026-11-03", hm: "00:30" });
});

test("pragueToUtcIso is the inverse in summer and winter", () => {
  assert.equal(api.pragueToUtcIso("2026-10-09", "07:45"), "2026-10-09T05:45:00.000Z");
  assert.equal(api.pragueToUtcIso("2026-11-02", "08:00"), "2026-11-02T07:00:00.000Z");
});

test("minutes helpers", () => {
  assert.equal(api.minutesOf("08:15"), 495);
  assert.equal(api.durationMinutes("08:15", "10:00"), 105);
  assert.equal(api.formatMinutes(645), "10:45");
  assert.equal(api.formatMinutes(15), "0:15");
});

test("monthRange and previousYearMonthDash", () => {
  assert.deepEqual(api.monthRange("202610"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(api.monthRange("202602"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(api.previousYearMonthDash("2026-01"), "2025-12");
  assert.equal(api.previousYearMonthDash("2026-10"), "2026-09");
});
```

- [ ] **Step 2: Spusť test, musí selhat**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: FAIL – `Cannot find module '../wtm-jira-sync.user.js'`

- [ ] **Step 3: Napiš kostru a časové funkce**

`wtm-jira-sync.user.js`:
```js
// ==UserScript==
// @name         WTM ← Jira sync
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      0.1.0
// @description  Na stránce WTM „Výkazy za měsíc“ spáruje položky s worklogy v Jiře (jira.indsoft.local) a dorovná WTM podle Jiry.
// @author       Lukáš Sedláček
// @match        https://uuapp.plus4u.net/uu-specialistwtm-maing01/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      jira.indsoft.local
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/wtm-jira-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/wtm-jira-sync.user.js
// ==/UserScript==

(function factory(rootFactory) {
  const api = rootFactory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    api.run();
  }
})(function createWtmJiraSyncApi() {
  "use strict";

  const SCRIPT_VERSION = "0.1.0";
  const SCRIPT_FLAG = "__gmWtmJiraSync";
  const TZ = "Europe/Prague";

  // --- PURE: time ---

  function toPragueParts(input) {
    const d = input instanceof Date ? input : new Date(input);
    const s = d.toLocaleString("sv-SE", { timeZone: TZ, hour12: false });
    return { date: s.slice(0, 10), hm: s.slice(11, 16) };
  }

  function pragueOffsetMinutes(utcMs) {
    const minuteMs = Math.floor(utcMs / 60000) * 60000;
    const p = toPragueParts(minuteMs);
    return Math.round((Date.parse(`${p.date}T${p.hm}:00Z`) - minuteMs) / 60000);
  }

  function pragueToUtcIso(date, hm) {
    const guess = Date.parse(`${date}T${hm}:00Z`);
    let utc = guess - pragueOffsetMinutes(guess) * 60000;
    const check = pragueOffsetMinutes(utc);
    utc = guess - check * 60000;
    return new Date(utc).toISOString();
  }

  function minutesOf(hm) {
    const [h, m] = String(hm).split(":").map(Number);
    return h * 60 + m;
  }

  function durationMinutes(from, to) {
    return minutesOf(to) - minutesOf(from);
  }

  function formatMinutes(min) {
    const sign = min < 0 ? "-" : "";
    const abs = Math.abs(min);
    return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
  }

  function monthRange(yearMonth) {
    const y = Number(yearMonth.slice(0, 4));
    const m = Number(yearMonth.slice(4, 6));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, "0");
    return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
  }

  function previousYearMonthDash(ym) {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  }

  function todayPrague() {
    return toPragueParts(Date.now()).date;
  }

  // --- BROWSER ---

  function run() {
    if (window[SCRIPT_FLAG]) return;
    window[SCRIPT_FLAG] = true;
  }

  return {
    SCRIPT_VERSION,
    toPragueParts,
    pragueToUtcIso,
    minutesOf,
    durationMinutes,
    formatMinutes,
    monthRange,
    previousYearMonthDash,
    todayPrague,
    run,
  };
});
```

- [ ] **Step 4: Spusť testy, musí projít**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (6 testů)

- [ ] **Step 5: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): scaffold userscript with Prague time helpers"
```

---

### Task 2: Normalizace položek WTM a worklogů Jiry

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `PURE: normalize` nad `// --- BROWSER ---`, rozšířit `return`)
- Test: `test/wtm-jira-sync.test.js`

**Interfaces:**
- Consumes: `toPragueParts`
- Produces:
  - `buildWtmDescription(key: string, comment: string) → string`
  - `normalizeWtmItems(list: WtmRawItem[]) → WtmItem[]`, kde
    `WtmItem = {id, date, from, to, key, comment, description, subject, subjectName, state}`
  - `normalizeJiraWorklogs({issues, worklogsByKey, meName, range}) → Worklog[]`, kde
    `Worklog = {key, summary, labels: string[], date, from, to, comment, worklogId}` seřazené podle `date+from`

- [ ] **Step 1: Napiš failing testy** (přidej na konec testovacího souboru)

```js
test("buildWtmDescription joins key and comment", () => {
  assert.equal(api.buildWtmDescription("CS-1", "Analýza"), "CS-1 Analýza");
  assert.equal(api.buildWtmDescription("CS-1", ""), "CS-1");
  assert.equal(api.buildWtmDescription("CS-1", "  "), "CS-1");
});

test("normalizeWtmItems maps raw WTM items to Prague times", () => {
  const items = api.normalizeWtmItems([
    {
      id: "a1",
      datetimeFrom: "2026-10-09T05:45:00.000Z",
      datetimeTo: "2026-10-09T06:15:00.000Z",
      category: "CS-1",
      description: "CS-1 Analýza, Vývoj",
      subject: "https://example.test/artifactInfo?id=1",
      subjectName: "W_SLA",
      state: "active",
    },
    { id: "a2", datetimeFrom: "2026-10-09T07:00:00.000Z", datetimeTo: "2026-10-09T07:30:00.000Z", description: "IDS-2", state: "confirmed" },
  ]);
  assert.deepEqual(items[0], {
    id: "a1", date: "2026-10-09", from: "07:45", to: "08:15", key: "CS-1", comment: "Analýza, Vývoj",
    description: "CS-1 Analýza, Vývoj", subject: "https://example.test/artifactInfo?id=1", subjectName: "W_SLA", state: "active",
  });
  assert.equal(items[1].key, "IDS-2");
  assert.equal(items[1].comment, "");
  assert.equal(items[1].subjectName, "");
});

test("normalizeJiraWorklogs keeps only my worklogs inside the month", () => {
  const issues = [{ key: "CS-1", fields: { summary: "Ticket 1", labels: ["AFLEX", "W_SLA"] } }];
  const worklogsByKey = {
    "CS-1": [
      { id: "10", author: { name: "me" }, started: "2026-10-09T07:45:00.000+0200", timeSpentSeconds: 1800, comment: " Analýza " },
      { id: "11", author: { name: "other" }, started: "2026-10-09T09:00:00.000+0200", timeSpentSeconds: 600, comment: "x" },
      { id: "12", author: { name: "me" }, started: "2026-09-30T09:00:00.000+0200", timeSpentSeconds: 600, comment: "old" },
    ],
  };
  const out = api.normalizeJiraWorklogs({ issues, worklogsByKey, meName: "me", range: { from: "2026-10-01", to: "2026-10-31" } });
  assert.deepEqual(out, [
    { key: "CS-1", summary: "Ticket 1", labels: ["AFLEX", "W_SLA"], date: "2026-10-09", from: "07:45", to: "08:15", comment: "Analýza", worklogId: "10" },
  ]);
});
```

- [ ] **Step 2: Spusť testy, nové musí selhat**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: FAIL – `api.buildWtmDescription is not a function`

- [ ] **Step 3: Implementuj** (vlož nad `// --- BROWSER ---`)

```js
  // --- PURE: normalize ---

  function buildWtmDescription(key, comment) {
    const c = String(comment || "").trim();
    return c ? `${key} ${c}` : key;
  }

  function normalizeWtmItems(list) {
    return (list || []).map((i) => {
      const from = toPragueParts(i.datetimeFrom);
      const to = toPragueParts(i.datetimeTo);
      const description = String(i.description || "").trim();
      const key = String(i.category || description.split(/\s+/)[0] || "").trim();
      let comment = "";
      if (description.startsWith(`${key} `)) comment = description.slice(key.length + 1).trim();
      else if (description !== key) comment = description;
      return {
        id: i.id,
        date: from.date,
        from: from.hm,
        to: to.hm,
        key,
        comment,
        description,
        subject: i.subject || "",
        subjectName: i.subjectName || "",
        state: i.state || "",
      };
    });
  }

  function parseJiraDate(s) {
    return Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  }

  function normalizeJiraWorklogs({ issues, worklogsByKey, meName, range }) {
    const out = [];
    for (const issue of issues || []) {
      const labels = (issue.fields && issue.fields.labels) || [];
      const summary = (issue.fields && issue.fields.summary) || "";
      for (const wl of (worklogsByKey && worklogsByKey[issue.key]) || []) {
        if (!wl.author || wl.author.name !== meName) continue;
        const startMs = parseJiraDate(wl.started);
        const from = toPragueParts(startMs);
        const to = toPragueParts(startMs + wl.timeSpentSeconds * 1000);
        if (from.date < range.from || from.date > range.to) continue;
        out.push({
          key: issue.key,
          summary,
          labels,
          date: from.date,
          from: from.hm,
          to: to.hm,
          comment: String(wl.comment || "").trim(),
          worklogId: String(wl.id),
        });
      }
    }
    return out.sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from));
  }
```
Do `return { … }` přidej: `buildWtmDescription, normalizeWtmItems, normalizeJiraWorklogs,`

- [ ] **Step 4: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (9 testů)

- [ ] **Step 5: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): normalize WTM items and Jira worklogs"
```

---

### Task 3: Párování

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `PURE: match`)
- Test: `test/wtm-jira-sync.test.js`

**Interfaces:**
- Consumes: `buildWtmDescription`, `WtmItem`, `Worklog`
- Produces:
  - `matchDay(worklogs: Worklog[], items: WtmItem[]) → {ok: Pair[], diff: Pair[], missing: Worklog[], extra: WtmItem[]}`, `Pair = {worklog, item}`
  - `matchMonth(worklogs, items) → Record<date, ReturnType<matchDay>>` (klíče = všechny dny z obou vstupů)

- [ ] **Step 1: Napiš failing testy**

```js
const W = (key, date, from, to, comment = "Analýza") => ({ key, summary: "", labels: ["W_SLA"], date, from, to, comment, worklogId: `${key}-${from}` });
const I = (id, key, date, from, to, comment = "Analýza", state = "active") => ({
  id, date, from, to, key, comment, description: comment ? `${key} ${comment}` : key, subject: "s", subjectName: "W_SLA", state,
});

test("matchDay classifies ok, diff, missing and extra", () => {
  const d = "2026-10-09";
  const res = api.matchDay(
    [W("CS-1", d, "08:00", "09:00"), W("CS-2", d, "09:00", "10:00"), W("CS-3", d, "10:00", "10:30"), W("CS-4", d, "11:00", "11:15", "Vývoj")],
    [I("i1", "CS-1", d, "08:00", "09:00"), I("i2", "CS-2", d, "09:15", "10:00"), I("i4", "CS-4", d, "11:00", "11:15", "Jiný"), I("i9", "CS-9", d, "12:00", "12:30")],
  );
  assert.deepEqual(res.ok.map((p) => p.item.id), ["i1"]);
  assert.deepEqual(res.diff.map((p) => p.item.id).sort(), ["i2", "i4"]);
  assert.deepEqual(res.missing.map((w) => w.key), ["CS-3"]);
  assert.deepEqual(res.extra.map((i) => i.id), ["i9"]);
});

test("matchDay pairs repeated tickets in start order", () => {
  const d = "2026-10-06";
  const res = api.matchDay(
    [W("CS-7", d, "08:00", "08:30"), W("CS-7", d, "15:00", "16:00")],
    [I("a", "CS-7", d, "15:00", "16:00"), I("b", "CS-7", d, "08:30", "09:00")],
  );
  assert.deepEqual(res.ok.map((p) => p.item.id), ["a"]);
  assert.deepEqual(res.diff.map((p) => [p.worklog.from, p.item.id]), [["08:00", "b"]]);
  assert.equal(res.missing.length, 0);
  assert.equal(res.extra.length, 0);
});

test("matchMonth groups by day across both sources", () => {
  const res = api.matchMonth([W("CS-1", "2026-10-05", "08:00", "09:00")], [I("x", "CS-2", "2026-10-06", "08:00", "09:00")]);
  assert.deepEqual(Object.keys(res).sort(), ["2026-10-05", "2026-10-06"]);
  assert.equal(res["2026-10-05"].missing.length, 1);
  assert.equal(res["2026-10-06"].extra.length, 1);
});
```

- [ ] **Step 2: Spusť testy, nové musí selhat**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: FAIL – `api.matchDay is not a function`

- [ ] **Step 3: Implementuj**

```js
  // --- PURE: match ---

  function byFrom(a, b) {
    return a.from.localeCompare(b.from);
  }

  function pairBy(worklogs, items, predicate, out) {
    for (const w of [...worklogs]) {
      const idx = items.findIndex((i) => predicate(w, i));
      if (idx < 0) continue;
      out.push({ worklog: w, item: items[idx] });
      items.splice(idx, 1);
      worklogs.splice(worklogs.indexOf(w), 1);
    }
  }

  function matchDay(worklogs, items) {
    const W = [...worklogs].sort(byFrom);
    const I = [...items].sort(byFrom);
    const ok = [];
    const diff = [];
    pairBy(W, I, (w, i) => w.key === i.key && w.from === i.from && w.to === i.to && buildWtmDescription(w.key, w.comment) === i.description, ok);
    pairBy(W, I, (w, i) => w.key === i.key && w.from === i.from && w.to === i.to, diff);
    pairBy(W, I, (w, i) => w.key === i.key, diff);
    return { ok, diff, missing: W, extra: I };
  }

  function matchMonth(worklogs, items) {
    const dates = new Set([...worklogs.map((w) => w.date), ...items.map((i) => i.date)]);
    const out = {};
    for (const date of [...dates].sort()) {
      out[date] = matchDay(worklogs.filter((w) => w.date === date), items.filter((i) => i.date === date));
    }
    return out;
  }
```
Do `return` přidej: `matchDay, matchMonth,`

- [ ] **Step 4: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (12 testů)

- [ ] **Step 5: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): pair Jira worklogs with WTM items"
```

---

### Task 4: Mapování artefaktů, dtoIn a pravidla WTM

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `PURE: mapping & rules`)
- Test: `test/wtm-jira-sync.test.js`

**Interfaces:**
- Consumes: `pragueToUtcIso`, `minutesOf`, `previousYearMonthDash`, `buildWtmDescription`
- Produces:
  - `DEFAULT_MAPPING: Record<label, subjectUrl>` (jen výjimka `W_RTO_PS`)
  - `seedMappingFromWtm(items: WtmItem[], current: Record) → Record` (doplní jen chybějící labely)
  - `resolveSubject(labels: string[], mapping: Record) → {label: string|null, subject: string|null}`
  - `buildCreateDtoIn(worklog, subject) → {datetimeFrom, datetimeTo, subject, category, description, highRate}`
  - `buildUpdateDtoIn(item, worklog, subject|null) → {id, …createDtoIn}` (bez `subject` použije `item.subject`)
  - `checkWtmRules({date, from, to}, dayItems: WtmItem[], today: "YYYY-MM-DD", ignoreItemId?) → string|null`

- [ ] **Step 1: Napiš failing testy**

```js
test("seedMappingFromWtm adds W_ subjects without overwriting", () => {
  const items = [I("1", "CS-1", "2026-10-01", "08:00", "09:00"), { ...I("2", "X-1", "2026-10-01", "09:00", "10:00"), subjectName: "Projekt", subject: "p" }];
  items[0].subject = "sla-url";
  assert.deepEqual(api.seedMappingFromWtm(items, { W_DR: "dr-url" }), { W_DR: "dr-url", W_SLA: "sla-url" });
  assert.deepEqual(api.seedMappingFromWtm(items, { W_SLA: "keep" }), { W_SLA: "keep" });
});

test("resolveSubject prefers a mapped W_ label", () => {
  const m = { W_SLA: "sla" };
  assert.deepEqual(api.resolveSubject(["AFLEX", "W_SLA"], m), { label: "W_SLA", subject: "sla" });
  assert.deepEqual(api.resolveSubject(["W_RE_RE2"], m), { label: "W_RE_RE2", subject: null });
  assert.deepEqual(api.resolveSubject(["AFLEX"], m), { label: null, subject: null });
});

test("buildCreateDtoIn and buildUpdateDtoIn", () => {
  const w = W("CS-1", "2026-10-09", "07:45", "08:15", "Analýza");
  assert.deepEqual(api.buildCreateDtoIn(w, "sla"), {
    datetimeFrom: "2026-10-09T05:45:00.000Z", datetimeTo: "2026-10-09T06:15:00.000Z",
    subject: "sla", category: "CS-1", description: "CS-1 Analýza", highRate: false,
  });
  const item = I("i1", "CS-1", "2026-10-09", "08:00", "08:30");
  item.subject = "old";
  assert.deepEqual(api.buildUpdateDtoIn(item, w, null), { id: "i1", ...api.buildCreateDtoIn(w, "old") });
});

test("checkWtmRules blocks invalid, old, out-of-month and overlapping entries", () => {
  const day = [I("a", "CS-1", "2026-10-09", "08:00", "09:00")];
  assert.equal(api.checkWtmRules({ date: "2026-10-09", from: "09:00", to: "09:30" }, day, "2026-10-10"), null);
  assert.match(api.checkWtmRules({ date: "2026-10-09", from: "10:00", to: "10:00" }, day, "2026-10-10"), /Neplatný/);
  assert.match(api.checkWtmRules({ date: "2026-10-01", from: "09:00", to: "09:30" }, [], "2026-10-10"), /7 dní/);
  assert.match(api.checkWtmRules({ date: "2026-11-02", from: "09:00", to: "09:30" }, [], "2026-10-30"), /měsíc/);
  assert.match(api.checkWtmRules({ date: "2026-10-09", from: "08:30", to: "09:30" }, day, "2026-10-10"), /Překryv s 08:00–09:00 CS-1/);
  assert.equal(api.checkWtmRules({ date: "2026-10-09", from: "08:30", to: "09:30" }, day, "2026-10-10", "a"), null);
});
```

- [ ] **Step 2: Spusť testy, nové musí selhat**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: FAIL – `api.seedMappingFromWtm is not a function`

- [ ] **Step 3: Implementuj**

```js
  // --- PURE: mapping & rules ---

  const DEFAULT_MAPPING = Object.freeze({
    W_RTO_PS: "https://uuapp.plus4u.net/uu-businessterritory-maing01/0e0e8e476f374ee0b6edd7f262ba0ff6/artifactInfo?id=6ab0d68c86377525f536a4fd",
  });

  function seedMappingFromWtm(items, current) {
    const out = { ...current };
    for (const i of items || []) {
      if (/^W_/.test(i.subjectName) && i.subject && !out[i.subjectName]) out[i.subjectName] = i.subject;
    }
    return out;
  }

  function resolveSubject(labels, mapping) {
    const wLabels = (labels || []).filter((l) => /^W_/.test(l));
    const mapped = wLabels.find((l) => mapping[l]);
    if (mapped) return { label: mapped, subject: mapping[mapped] };
    return { label: wLabels[0] || null, subject: null };
  }

  function buildCreateDtoIn(worklog, subject) {
    return {
      datetimeFrom: pragueToUtcIso(worklog.date, worklog.from),
      datetimeTo: pragueToUtcIso(worklog.date, worklog.to),
      subject,
      category: worklog.key,
      description: buildWtmDescription(worklog.key, worklog.comment),
      highRate: false,
    };
  }

  function buildUpdateDtoIn(item, worklog, subject) {
    return { id: item.id, ...buildCreateDtoIn(worklog, subject || item.subject) };
  }

  function checkWtmRules(entry, dayItems, today, ignoreItemId) {
    const a = minutesOf(entry.from);
    const b = minutesOf(entry.to);
    if (b <= a) return "Neplatný časový rozsah";
    const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${entry.date}T00:00:00Z`)) / 86400000);
    if (ageDays > 7) return "Starší než 7 dní – WTM to odmítne";
    const ym = entry.date.slice(0, 7);
    const current = today.slice(0, 7);
    if (ym !== current && ym !== previousYearMonthDash(current)) return "Mimo aktuální nebo předchozí měsíc";
    const clash = (dayItems || []).find((i) => i.id !== ignoreItemId && minutesOf(i.from) < b && a < minutesOf(i.to));
    if (clash) return `Překryv s ${clash.from}–${clash.to} ${clash.key}`;
    return null;
  }
```
Do `return` přidej: `DEFAULT_MAPPING, seedMappingFromWtm, resolveSubject, buildCreateDtoIn, buildUpdateDtoIn, checkWtmRules,`

- [ ] **Step 4: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (16 testů)

- [ ] **Step 5: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): artifact mapping, WTM dtoIn and rule checks"
```

---

### Task 5: Page agent (zachycení měsíce, token, zápis do WTM)

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `PURE: wtm capture` a `BROWSER: agent`)
- Test: `test/wtm-jira-sync.test.js`

**Interfaces:**
- Produces:
  - `MSG = {fromAgent: "gm-wjs-agent", toAgent: "gm-wjs-cmd", agentFlag: "__gmWjsAgent"}`
  - `extractMonthResponse(url: string, bodyText: string) → {yearMonth: string|null, items: WtmRawItem[]} | null`
  - `buildAgentSource() → string` (spustitelný kód agenta pro inline `<script>`)
  - `createAgentClient(win, {onMonth(payload), onAuth()}) → {call(cmd, dtoIn) → Promise<{id, ok, data?, error?}>}`
  - `injectAgent()` (prohlížeč)

- [ ] **Step 1: Napiš failing testy**

```js
test("extractMonthResponse accepts only the month list command", () => {
  const body = JSON.stringify({ workerMonthlyTimesheet: { yearMonth: "202610" }, timesheetItemList: [{ id: "1" }] });
  assert.deepEqual(api.extractMonthResponse("https://x/uu-specialistwtm-maing01/a-b/listWorkerTimesheetItemsByMonth", body), {
    yearMonth: "202610", items: [{ id: "1" }],
  });
  assert.equal(api.extractMonthResponse("https://x/uu-specialistwtm-maing01/a-b/getSubjectInfo", body), null);
  assert.equal(api.extractMonthResponse("https://x/listWorkerTimesheetItemsByMonth", "not json"), null);
  assert.equal(api.extractMonthResponse("https://x/listWorkerTimesheetItemsByMonth", "{}"), null);
});

test("buildAgentSource embeds the agent and the extractor", () => {
  const src = api.buildAgentSource();
  assert.match(src, /listWorkerTimesheetItemsByMonth/);
  assert.match(src, /gm-wjs-agent/);
  assert.doesNotThrow(() => new Function(src));
});

test("createAgentClient round-trips a WTM call and forwards month/auth", async () => {
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => listeners.push(fn),
    postMessage: (data) => setTimeout(() => listeners.forEach((fn) => fn({ data })), 0),
  };
  const seen = { month: null, auth: 0 };
  const client = api.createAgentClient(win, { onMonth: (m) => (seen.month = m), onAuth: () => seen.auth++ });
  // fake agent answering every command
  win.addEventListener("message", (e) => {
    if (e.data.source === api.MSG.toAgent) win.postMessage({ source: api.MSG.fromAgent, type: "wtm-result", payload: { id: e.data.id, ok: true, data: { id: "new" } } });
  });
  const res = await client.call("createTimesheetItem", { a: 1 });
  assert.deepEqual(res, { id: res.id, ok: true, data: { id: "new" } });
  win.postMessage({ source: api.MSG.fromAgent, type: "month", payload: { yearMonth: "202610", items: [] } });
  win.postMessage({ source: api.MSG.fromAgent, type: "auth", payload: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen.month, { yearMonth: "202610", items: [] });
  assert.equal(seen.auth, 1);
});
```

- [ ] **Step 2: Spusť testy, nové musí selhat**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: FAIL – `api.extractMonthResponse is not a function`

- [ ] **Step 3: Implementuj čistou část** (nad `// --- BROWSER ---`)

```js
  // --- PURE: wtm capture ---

  const MSG = Object.freeze({ fromAgent: "gm-wjs-agent", toAgent: "gm-wjs-cmd", agentFlag: "__gmWjsAgent" });

  function extractMonthResponse(url, bodyText) {
    if (!/\/listWorkerTimesheetItemsByMonth(\?|$)/.test(String(url))) return null;
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch (e) {
      return null;
    }
    if (!json || !Array.isArray(json.timesheetItemList)) return null;
    return { yearMonth: (json.workerMonthlyTimesheet && json.workerMonthlyTimesheet.yearMonth) || null, items: json.timesheetItemList };
  }

  function pageAgent(extractMonthResponse, MSG) {
    if (window[MSG.agentFlag]) return;
    window[MSG.agentFlag] = true;
    const isWtm = (url) => /\/uu-specialistwtm-maing01\//.test(url);
    let lastAuth = null;
    const post = (type, payload) => window.postMessage({ source: MSG.fromAgent, type, payload }, "*");
    const rememberAuth = (value) => {
      if (!value || value === lastAuth) return;
      lastAuth = value;
      post("auth", true);
    };

    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR) {
      const open = XHR.open;
      const send = XHR.send;
      const setHeader = XHR.setRequestHeader;
      XHR.open = function (method, url) {
        this.__gmWjsUrl = String(url);
        return open.apply(this, arguments);
      };
      XHR.setRequestHeader = function (name, value) {
        if (/^authorization$/i.test(name) && isWtm(this.__gmWjsUrl || "")) rememberAuth(value);
        return setHeader.apply(this, arguments);
      };
      XHR.send = function () {
        this.addEventListener("load", () => {
          try {
            const m = extractMonthResponse(this.__gmWjsUrl || "", this.responseText);
            if (m) post("month", m);
          } catch (e) {
            /* foreign response */
          }
        });
        return send.apply(this, arguments);
      };
    }

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const headers = (init && init.headers) || (input && input.headers);
        if (headers && isWtm(url)) {
          rememberAuth(typeof headers.get === "function" ? headers.get("Authorization") : headers.Authorization || headers.authorization);
        }
        const promise = origFetch.apply(this, arguments);
        if (/listWorkerTimesheetItemsByMonth/.test(url)) {
          promise
            .then((res) => res.clone().text())
            .then((text) => {
              const m = extractMonthResponse(url, text);
              if (m) post("month", m);
            })
            .catch(() => {});
        }
        return promise;
      };
    }

    window.addEventListener("message", async (event) => {
      const data = event.data;
      if (!data || data.source !== MSG.toAgent || data.type !== "wtm-call") return;
      const reply = (body) => window.postMessage({ source: MSG.fromAgent, type: "wtm-result", payload: Object.assign({ id: data.id }, body) }, "*");
      if (!lastAuth) {
        reply({ ok: false, error: "Chybí přihlášení WTM – obnov stránku." });
        return;
      }
      const base = location.pathname.match(/^\/uu-specialistwtm-maing01\/[^/]+/);
      try {
        const res = await origFetch.call(window, `${location.origin}${base[0]}/${data.cmd}`, {
          method: "POST",
          headers: { Authorization: lastAuth, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(data.dtoIn),
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          json = null;
        }
        const errMap = (json && json.uuAppErrorMap) || {};
        const errKey = Object.keys(errMap).find((k) => errMap[k] && errMap[k].type === "error");
        if (!res.ok || errKey) reply({ ok: false, error: (errKey && (errMap[errKey].message || errKey)) || `HTTP ${res.status}` });
        else reply({ ok: true, data: json });
      } catch (e) {
        reply({ ok: false, error: String((e && e.message) || e) });
      }
    });

    post("ready", true);
  }

  function buildAgentSource() {
    return `(${pageAgent.toString()})(${extractMonthResponse.toString()}, ${JSON.stringify(MSG)});`;
  }

  function createAgentClient(win, handlers) {
    const pending = new Map();
    let seq = 0;
    win.addEventListener("message", (event) => {
      const d = event.data;
      if (!d || d.source !== MSG.fromAgent) return;
      if (d.type === "month") handlers.onMonth(d.payload);
      else if (d.type === "auth") handlers.onAuth();
      else if (d.type === "wtm-result") {
        const resolve = pending.get(d.payload.id);
        if (resolve) {
          pending.delete(d.payload.id);
          resolve(d.payload);
        }
      }
    });
    return {
      call(cmd, dtoIn) {
        const id = `c${++seq}`;
        return new Promise((resolve) => {
          pending.set(id, resolve);
          win.postMessage({ source: MSG.toAgent, type: "wtm-call", id, cmd, dtoIn }, "*");
        });
      },
    };
  }
```

- [ ] **Step 4: Implementuj prohlížečovou část** (pod `// --- BROWSER ---`, nad `function run()`)

```js
  // --- BROWSER: agent ---

  function injectAgent() {
    const script = document.createElement("script");
    script.textContent = buildAgentSource();
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }
```
Do `return` přidej: `MSG, extractMonthResponse, buildAgentSource, createAgentClient,`

- [ ] **Step 5: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (19 testů)

- [ ] **Step 6: Spike v Chromu přes browser bridge – zachytí agent odpověď měsíce?**

Spusť server (na pozadí) a ověř stránku:
```powershell
cd R:\External\GreaseMonkey
node tools/browser-bridge-cli.mjs health ; exit $LASTEXITCODE
node tools/browser-bridge-cli.mjs eval "JSON.stringify({url: location.href, title: document.title})" ; exit $LASTEXITCODE
```
Když `health` hlásí `fetch failed`, spusť `node tools/browser-bridge-server.mjs` na pozadí a zopakuj. Aktivní tab musí být
`https://uuapp.plus4u.net/uu-specialistwtm-maing01/99923616732453117-8031926f783d4aaba733af73c1974840/workerMonthlyDetail`.

Vlož agenta a sběrač zpráv:
```powershell
node tools/browser-bridge-cli.mjs eval "(()=>{window.__wjsSeen=[];window.addEventListener('message',e=>{if(e.data&&e.data.source==='gm-wjs-agent')window.__wjsSeen.push(e.data.type)});const s=document.createElement('script');s.src='http://127.0.0.1:8766/wtm-jira-sync.user.js?'+Date.now();document.head.appendChild(s);return 'ok'})()" ; exit $LASTEXITCODE
```
V Chromu přepni ve WTM měsíc na září a zpět na říjen (výběr „Tento měsíc“). Pak:
```powershell
node tools/browser-bridge-cli.mjs eval "JSON.stringify(window.__wjsSeen)" ; exit $LASTEXITCODE
```
Expected: pole obsahuje `"month"` a `"auth"`. Pokud `month` chybí, stránka volá měsíc jinak (např. z workeru) – STOP a nahlas
uživateli; plán pokračuje jen po dohodě (záloha: číst měsíc vlastním voláním přes zachycený token).

- [ ] **Step 7: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): page agent capturing WTM month and token"
```

---

### Task 6: Načtení měsíce z Jiry

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `PURE: jira` a `BROWSER: settings & transport`)
- Test: `test/wtm-jira-sync.test.js`

**Interfaces:**
- Consumes: `normalizeJiraWorklogs`, `monthRange`
- Produces:
  - `fetchJiraMonth(range, request: (path) => Promise<json>) → Promise<Worklog[]>`
  - `createJiraRequest(baseUrl) → (path) => Promise<json>` (prohlížeč; chyba má `status`)
  - `loadSettings() → {jiraBaseUrl, mapping}`, `saveSettings(settings)` (prohlížeč)

- [ ] **Step 1: Napiš failing test**

```js
test("fetchJiraMonth pages the search and loads worklogs per issue", async () => {
  const calls = [];
  const responses = {
    "/rest/api/2/myself": { name: "me" },
    search0: { total: 2, issues: [{ key: "CS-1", fields: { summary: "A", labels: ["W_SLA"] } }] },
    search1: { total: 2, issues: [{ key: "IDS-2", fields: { summary: "B", labels: [] } }] },
    "/rest/api/2/issue/CS-1/worklog?maxResults=1000": { worklogs: [{ id: "1", author: { name: "me" }, started: "2026-10-09T08:00:00.000+0200", timeSpentSeconds: 900, comment: "Vývoj" }] },
    "/rest/api/2/issue/IDS-2/worklog?maxResults=1000": { worklogs: [] },
  };
  const request = async (path) => {
    calls.push(path);
    if (path.startsWith("/rest/api/2/search")) return path.includes("startAt=0") ? responses.search0 : responses.search1;
    return responses[path];
  };
  const out = await api.fetchJiraMonth({ from: "2026-10-01", to: "2026-10-31" }, request);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "CS-1");
  assert.equal(out[0].from, "08:00");
  assert.ok(calls.some((p) => p.includes(encodeURIComponent('worklogDate >= "2026-10-01"'))));
  assert.equal(calls.filter((p) => p.startsWith("/rest/api/2/search")).length, 2);
});
```

- [ ] **Step 2: Spusť testy, nový musí selhat**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: FAIL – `api.fetchJiraMonth is not a function`

- [ ] **Step 3: Implementuj čistou část**

```js
  // --- PURE: jira ---

  async function fetchJiraMonth(range, request) {
    const me = await request("/rest/api/2/myself");
    const jql = `worklogAuthor = currentUser() AND worklogDate >= "${range.from}" AND worklogDate <= "${range.to}"`;
    const issues = [];
    let startAt = 0;
    for (;;) {
      const page = await request(`/rest/api/2/search?maxResults=100&startAt=${startAt}&fields=summary,labels&jql=${encodeURIComponent(jql)}`);
      issues.push(...page.issues);
      startAt += page.issues.length;
      if (!page.issues.length || startAt >= page.total) break;
    }
    const worklogsByKey = {};
    for (const issue of issues) {
      const res = await request(`/rest/api/2/issue/${issue.key}/worklog?maxResults=1000`);
      worklogsByKey[issue.key] = res.worklogs || [];
    }
    return normalizeJiraWorklogs({ issues, worklogsByKey, meName: me.name, range });
  }
```

- [ ] **Step 4: Implementuj prohlížečovou část** (pod `// --- BROWSER ---`)

```js
  // --- BROWSER: settings & transport ---

  const SETTINGS_KEY = "gm-wjs-settings";
  const DEFAULT_SETTINGS = Object.freeze({ jiraBaseUrl: "http://jira.indsoft.local", mapping: { ...DEFAULT_MAPPING } });

  function storageGet() {
    if (typeof GM_getValue === "function") return GM_getValue(SETTINGS_KEY, null);
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function loadSettings() {
    const stored = storageGet() || {};
    return { jiraBaseUrl: stored.jiraBaseUrl || DEFAULT_SETTINGS.jiraBaseUrl, mapping: { ...DEFAULT_SETTINGS.mapping, ...(stored.mapping || {}) } };
  }

  function saveSettings(settings) {
    if (typeof GM_setValue === "function") GM_setValue(SETTINGS_KEY, settings);
    else localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function createJiraRequest(baseUrl) {
    return (path) =>
      new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== "function") {
          reject(Object.assign(new Error("GM_xmlhttpRequest není k dispozici (spusť skript v Tampermonkey)"), { status: 0 }));
          return;
        }
        GM_xmlhttpRequest({
          method: "GET",
          url: `${baseUrl.replace(/\/$/, "")}${path}`,
          headers: { Accept: "application/json" },
          onload: (r) => {
            if (r.status >= 200 && r.status < 300) {
              try {
                resolve(JSON.parse(r.responseText));
              } catch (e) {
                reject(Object.assign(new Error("Jira nevrátila JSON – nejsi přihlášený?"), { status: 401 }));
              }
            } else reject(Object.assign(new Error(`Jira HTTP ${r.status}`), { status: r.status }));
          },
          onerror: () => reject(Object.assign(new Error("Jira je nedostupná"), { status: 0 })),
        });
      });
  }
```
Do `return` přidej: `fetchJiraMonth,`

- [ ] **Step 5: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (20 testů)

- [ ] **Step 6: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): load month worklogs from Jira"
```

---

### Task 7: Kotvení v DOM výpisu WTM

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `PURE: dom text` a `BROWSER: dom`)
- Test: `test/wtm-jira-sync.test.js`

**Interfaces:**
- Produces:
  - `parseDayHeaderText(text) → "YYYY-MM-DD" | null` (např. „Pátek 09.10.2026“, „Friday 09.10.2026“)
  - `parseTimeRangeText(text) → {from, to} | null` (např. „18:00 - 18:30“)
  - `findDaySections(root) → [{date, headerEl, sectionEl}]` (prohlížeč)
  - `findItemCards(sectionEl) → [{from, to, el, timeEl}]` (prohlížeč)

Kotvení je čistě podle textu (bez CSS tříd WTM): hlavička dne = nejhlubší prvek s textem `<den> DD.MM.YYYY`,
karta položky = nejvyšší předek prvku s časem `HH:MM - HH:MM`, který obsahuje právě jeden časový rozsah.

- [ ] **Step 1: Napiš failing testy**

```js
test("parseDayHeaderText reads Czech and English day headers", () => {
  assert.equal(api.parseDayHeaderText("Pátek 09.10.2026"), "2026-10-09");
  assert.equal(api.parseDayHeaderText("  Friday   09.10.2026 "), "2026-10-09");
  assert.equal(api.parseDayHeaderText("09.10.2026"), null);
  assert.equal(api.parseDayHeaderText("Pátek 09.10.2026 Odpracováno"), null);
});

test("parseTimeRangeText reads item time ranges", () => {
  assert.deepEqual(api.parseTimeRangeText("18:00 - 18:30"), { from: "18:00", to: "18:30" });
  assert.deepEqual(api.parseTimeRangeText("8:15-9:00"), { from: "08:15", to: "09:00" });
  assert.equal(api.parseTimeRangeText("00h 30m"), null);
});
```

- [ ] **Step 2: Spusť testy, nové musí selhat**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: FAIL – `api.parseDayHeaderText is not a function`

- [ ] **Step 3: Implementuj čistou část**

```js
  // --- PURE: dom text ---

  const DAY_HEADER_RE = /^\p{L}+\s+(\d{2})\.(\d{2})\.(\d{4})$/u;
  const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
  const TIME_RANGE_ONLY_RE = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;

  function parseDayHeaderText(text) {
    const m = String(text).replace(/\s+/g, " ").trim().match(DAY_HEADER_RE);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  function parseTimeRangeText(text) {
    const m = String(text).match(TIME_RANGE_RE);
    if (!m) return null;
    const hm = (h, mm) => `${h.padStart(2, "0")}:${mm}`;
    return { from: hm(m[1], m[2]), to: hm(m[3], m[4]) };
  }

  function countTimeRanges(text) {
    return (String(text).match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g) || []).length;
  }
```

- [ ] **Step 4: Implementuj prohlížečovou část**

```js
  // --- BROWSER: dom ---

  const OWN_CLASS = "gm-wjs";

  function findDaySections(root) {
    const headers = [];
    for (const el of root.querySelectorAll("div,span,h1,h2,h3,h4,p")) {
      if (el.closest(`.${OWN_CLASS}`)) continue;
      const date = parseDayHeaderText(el.textContent);
      if (!date) continue;
      if ([...el.children].some((c) => parseDayHeaderText(c.textContent))) continue;
      headers.push({ date, el });
    }
    return headers.map(({ date, el }) => {
      let section = el;
      while (section.parentElement && section.parentElement !== document.body) {
        const parent = section.parentElement;
        if (headers.filter((h) => parent.contains(h.el)).length > 1) break;
        section = parent;
      }
      return { date, headerEl: el, sectionEl: section };
    });
  }

  function findItemCards(sectionEl) {
    const cards = [];
    for (const el of sectionEl.querySelectorAll("div,span")) {
      if (el.closest(`.${OWN_CLASS}`)) continue;
      const text = el.textContent.trim();
      if (!TIME_RANGE_ONLY_RE.test(text)) continue;
      let card = el;
      while (card.parentElement && card.parentElement !== sectionEl && countTimeRanges(card.parentElement.textContent) === 1) {
        card = card.parentElement;
      }
      if (cards.some((c) => c.el === card)) continue;
      cards.push({ ...parseTimeRangeText(text), el: card, timeEl: el });
    }
    return cards;
  }
```
Do `return` přidej: `parseDayHeaderText, parseTimeRangeText,`

- [ ] **Step 5: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (22 testů)

- [ ] **Step 6: Ověř kotvení na živé stránce přes bridge** (WTM říjen 2026, dny rozbalené)

```powershell
node tools/browser-bridge-cli.mjs eval "(()=>{const s=document.createElement('script');s.src='http://127.0.0.1:8766/wtm-jira-sync.user.js?'+Date.now();s.onload=()=>{};document.head.appendChild(s);return 'ok'})()" ; exit $LASTEXITCODE
```
Skript se v page world exportuje jen přes `module` – pro inspekci dočasně v konzoli bridge použij:
```powershell
node tools/browser-bridge-cli.mjs eval "(()=>{const H=[...document.querySelectorAll('div,span,h1,h2,h3,h4,p')].filter(e=>/^\p{L}+\s+\d{2}\.\d{2}\.\d{4}$/u.test(e.textContent.replace(/\s+/g,' ').trim())&&![...e.children].some(c=>/^\p{L}+\s+\d{2}\.\d{2}\.\d{4}$/u.test(c.textContent.replace(/\s+/g,' ').trim())));const T=[...document.querySelectorAll('div,span')].filter(e=>/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(e.textContent.trim()));return JSON.stringify({headers:H.map(h=>h.textContent.trim()),times:T.length})})()" ; exit $LASTEXITCODE
```
Expected: `headers` obsahuje rozbalené dny (např. „Pátek 09.10.2026“), `times` = počet zobrazených položek. Pokud hlavičky nebo časy
nesedí s tím, co je vidět, uprav regulární výrazy v `PURE: dom text` (a testy) podle skutečných textů a ověř znovu.

- [ ] **Step 7: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): anchor day sections and item cards by text"
```

---

### Task 8: Vykreslení stavů a virtuálních řádků

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `BROWSER: render`, rozšířit `run()`)

**Interfaces:**
- Consumes: `findDaySections`, `findItemCards`, `matchMonth`, `resolveSubject`, `checkWtmRules`, `formatMinutes`, `durationMinutes`, `todayPrague`
- Produces:
  - `state` objekt: `{items: WtmItem[], worklogs: Worklog[], results, settings, jira: {status: "idle"|"loading"|"ok"|"error", error}, wtmAuth: boolean, busy: boolean, choices: Record<worklogId, subjectUrl>, messages: Record<rowId, string>}`
  - `render()` – idempotentní: smaže vše s třídou `gm-wjs` a vykreslí znovu
  - `rowActionsFor(date) → Action[]`, `Action = {type: "create"|"update", worklog, item?, subject, blocked: string|null}`
  - handler `onAction(action)` a `onDayAll(date)` dodá Task 9 (zatím volají `console.info`)

- [ ] **Step 1: Přidej styly a pomocníky**

```js
  // --- BROWSER: render ---

  const STYLE_ID = "gm-wjs-style";
  const CSS = `
    .gm-wjs-badge{display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:1px 7px;border-radius:4px;font:600 12px/18px system-ui,sans-serif;vertical-align:middle}
    .gm-wjs-badge a{color:inherit;text-decoration:none}
    .gm-wjs-ok{background:#e3f3ed;color:#1f7a5c}
    .gm-wjs-diff{background:#fbf0dc;color:#9a6216}
    .gm-wjs-extra{background:#fbe6e3;color:#b23b2e}
    .gm-wjs-note{display:block;margin-top:4px;font:12px/16px system-ui,sans-serif;color:#9a6216}
    .gm-wjs-btn{margin-left:8px;padding:2px 10px;border:1px solid currentColor;border-radius:4px;background:#fff;font:600 12px/18px system-ui,sans-serif;cursor:pointer}
    .gm-wjs-btn[disabled]{opacity:.5;cursor:not-allowed}
    .gm-wjs-row{margin:8px 0;padding:12px 16px;border:2px dashed #2f5bd3;border-radius:4px;background:repeating-linear-gradient(135deg,#f5f8ff 0 8px,#fff 8px 16px);font:14px/20px system-ui,sans-serif}
    .gm-wjs-row .gm-wjs-time{font-weight:700;margin-right:8px}
    .gm-wjs-row .gm-wjs-msg{display:block;margin-top:4px;color:#b23b2e;font-size:12px}
    .gm-wjs-row select{margin-left:8px;font-size:12px}
    .gm-wjs-day{margin-left:16px;font:600 13px/20px system-ui,sans-serif;color:#2f5bd3}
    .gm-wjs-vday{margin:12px 0;padding:12px 16px;border:2px dashed #2f5bd3;border-radius:4px}
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = `${OWN_CLASS} ${v}`;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
    if (!attrs || !attrs.class) el.classList.add(OWN_CLASS);
    for (const c of [].concat(children || [])) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  function jiraLink(key) {
    return h("a", { href: `${state.settings.jiraBaseUrl}/browse/${key}`, target: "_blank", rel: "noopener" }, key);
  }
```

- [ ] **Step 2: Přidej stav a výpočet akcí**

```js
  const state = {
    items: [],
    worklogs: [],
    results: {},
    settings: null,
    jira: { status: "idle", error: null },
    wtmAuth: false,
    busy: false,
    choices: {},
    messages: {},
  };

  function rowActionsFor(date) {
    const res = state.results[date];
    if (!res) return [];
    const dayItems = state.items.filter((i) => i.date === date);
    const today = todayPrague();
    const actions = [];
    for (const w of res.missing) {
      const resolved = resolveSubject(w.labels, state.settings.mapping);
      const subject = state.choices[w.worklogId] || resolved.subject;
      const blocked = !subject ? `Neznámý artefakt${resolved.label ? ` pro ${resolved.label}` : ""} – vyber ho` : checkWtmRules(w, dayItems, today);
      actions.push({ type: "create", worklog: w, subject, label: resolved.label, blocked });
    }
    for (const p of res.diff) {
      const blocked = p.item.state !== "active" ? "Položka je potvrzená" : checkWtmRules(p.worklog, dayItems, today, p.item.id);
      actions.push({ type: "update", worklog: p.worklog, item: p.item, subject: null, blocked });
    }
    return actions.sort((a, b) => a.worklog.from.localeCompare(b.worklog.from));
  }
```

- [ ] **Step 3: Přidej vykreslení**

```js
  function onAction(action) {
    console.info("[wtm-jira-sync] action", action);
  }

  function onDayAll(date) {
    console.info("[wtm-jira-sync] day all", date);
  }

  function minutesSum(list) {
    return list.reduce((s, x) => s + durationMinutes(x.from, x.to), 0);
  }

  function renderVirtualRow(action) {
    const w = action.worklog;
    const rowId = `w${w.worklogId}`;
    const children = [
      h("span", { class: "gm-wjs-time" }, `${w.from} - ${w.to}`),
      `${formatMinutes(durationMinutes(w.from, w.to))} · `,
      jiraLink(w.key),
      ` ${w.comment || ""} `,
      h("span", { class: "gm-wjs-badge gm-wjs-diff" }, "chybí ve WTM"),
    ];
    if (!action.subject) {
      const select = h("select", { onchange: (e) => { state.choices[w.worklogId] = e.target.value; render(); } }, [
        h("option", { value: "" }, "— artefakt —"),
        ...Object.entries(state.settings.mapping).map(([label, url]) => h("option", { value: url }, label)),
      ]);
      children.push(select);
    } else {
      const label = Object.keys(state.settings.mapping).find((l) => state.settings.mapping[l] === action.subject) || action.label || "";
      children.push(h("span", { class: "gm-wjs-badge gm-wjs-ok" }, label));
    }
    children.push(h("button", { class: "gm-wjs-btn", disabled: state.busy || Boolean(action.blocked), title: action.blocked || "", onclick: () => onAction(action) }, "Zapsat do WTM"));
    const msg = state.messages[rowId] || action.blocked;
    if (msg) children.push(h("span", { class: "gm-wjs-msg" }, msg));
    return h("div", { class: "gm-wjs-row", "data-from": w.from }, children);
  }

  function decorateCard(card, pairOrItem, kind, action) {
    const anchor = card.timeEl;
    if (kind === "ok") {
      anchor.after(h("span", { class: "gm-wjs-badge gm-wjs-ok" }, ["✓ ", jiraLink(pairOrItem.worklog.key)]));
    } else if (kind === "extra") {
      anchor.after(h("span", { class: "gm-wjs-badge gm-wjs-extra" }, "není v Jiře"));
    } else if (kind === "diff") {
      const w = pairOrItem.worklog;
      const badge = h("span", { class: "gm-wjs-badge gm-wjs-diff" }, ["≠ ", jiraLink(w.key)]);
      const btn = h("button", { class: "gm-wjs-btn", disabled: state.busy || Boolean(action && action.blocked), title: (action && action.blocked) || "", onclick: () => onAction(action) }, "Upravit podle Jiry");
      anchor.after(badge, btn);
      const msg = state.messages[`i${pairOrItem.item.id}`] || (action && action.blocked);
      card.el.append(h("span", { class: "gm-wjs-note" }, `Jira: ${w.from}–${w.to} · ${formatMinutes(durationMinutes(w.from, w.to))} · ${w.comment || "(bez komentáře)"}${msg ? ` – ${msg}` : ""}`));
    }
  }

  function takeCard(cards, item) {
    const idx = cards.findIndex((c) => c.from === item.from && c.to === item.to);
    return idx < 0 ? null : cards.splice(idx, 1)[0];
  }

  function renderDaySummary(date, headerEl, actions) {
    const res = state.results[date];
    const jira = minutesSum([...res.ok.map((p) => p.worklog), ...res.diff.map((p) => p.worklog), ...res.missing]);
    const wtm = minutesSum(state.items.filter((i) => i.date === date));
    const parts = [`Jira ${formatMinutes(jira)} · WTM ${formatMinutes(wtm)}`];
    if (res.missing.length) parts.push(`${res.missing.length} chybí`);
    if (res.diff.length) parts.push(`${res.diff.length} liší se`);
    if (res.extra.length) parts.push(`${res.extra.length} není v Jiře`);
    const runnable = actions.filter((a) => !a.blocked);
    const summary = h("span", { class: "gm-wjs-day" }, parts.join(" · "));
    if (runnable.length) summary.append(h("button", { class: "gm-wjs-btn", disabled: state.busy, onclick: () => onDayAll(date) }, `Zapsat vše (${runnable.length})`));
    headerEl.append(summary);
  }

  function render() {
    if (!document.body || state.jira.status !== "ok" || !state.settings) return;
    ensureStyle();
    for (const el of document.querySelectorAll(`.${OWN_CLASS}`)) el.remove();
    const sections = findDaySections(document.body);
    const known = new Set(sections.map((s) => s.date));
    for (const { date, headerEl, sectionEl } of sections) {
      const res = state.results[date];
      if (!res) continue;
      const actions = rowActionsFor(date);
      const cards = findItemCards(sectionEl);
      for (const p of res.ok) {
        const card = takeCard(cards, p.item);
        if (card) decorateCard(card, p, "ok");
      }
      for (const p of res.diff) {
        const card = takeCard(cards, p.item);
        if (card) decorateCard(card, p, "diff", actions.find((a) => a.type === "update" && a.item.id === p.item.id));
      }
      for (const i of res.extra) {
        const card = takeCard(cards, i);
        if (card) decorateCard(card, i, "extra");
      }
      const allCards = findItemCards(sectionEl);
      for (const action of actions.filter((a) => a.type === "create")) {
        const row = renderVirtualRow(action);
        const before = allCards.find((c) => c.from < action.worklog.from);
        if (before) before.el.before(row);
        else if (allCards.length) allCards[allCards.length - 1].el.after(row);
        else sectionEl.append(row);
      }
      renderDaySummary(date, headerEl, actions);
    }
    for (const date of Object.keys(state.results).filter((d) => !known.has(d) && state.results[d].missing.length)) {
      const actions = rowActionsFor(date);
      const block = h("div", { class: "gm-wjs-vday" }, [h("strong", {}, `${date} – v Jiře, ve WTM nic`)]);
      for (const action of actions) block.append(renderVirtualRow(action));
      const after = sections.find((s) => s.date < date);
      if (after) after.sectionEl.before(block);
      else if (sections.length) sections[sections.length - 1].sectionEl.after(block);
    }
  }
```

- [ ] **Step 4: Rozšiř `run()` o načtení dat, agenta a překreslování**

Nahraď tělo `run()`:
```js
  function recompute() {
    state.results = matchMonth(state.worklogs, state.items);
    render();
  }

  async function loadJira(yearMonth) {
    state.jira = { status: "loading", error: null };
    renderPanel();
    try {
      state.worklogs = await fetchJiraMonth(monthRange(yearMonth), createJiraRequest(state.settings.jiraBaseUrl));
      state.jira = { status: "ok", error: null };
    } catch (e) {
      state.jira = { status: "error", error: e.message, unauthorized: e.status === 401 };
    }
    renderPanel();
    recompute();
  }

  let agent = null;
  let currentYearMonth = null;

  function run() {
    if (window[SCRIPT_FLAG]) return;
    window[SCRIPT_FLAG] = true;
    state.settings = loadSettings();
    agent = createAgentClient(window, {
      onMonth: (payload) => {
        state.items = normalizeWtmItems(payload.items);
        const ym = payload.yearMonth || (state.items[0] && state.items[0].date.replace(/-/g, "").slice(0, 6));
        if (ym && ym !== currentYearMonth) {
          currentYearMonth = ym;
          loadJira(ym);
        } else recompute();
      },
      onAuth: () => {
        state.wtmAuth = true;
        renderPanel();
      },
    });
    injectAgent();
    let pending = 0;
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && n.classList && n.classList.contains(OWN_CLASS)))) return;
      clearTimeout(pending);
      pending = setTimeout(render, 300);
    });
    const start = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  }
```
`renderPanel()` dodá Task 10; do té doby přidej nad `run()` dočasnou verzi:
```js
  function renderPanel() {
    console.info("[wtm-jira-sync] jira", state.jira.status, state.jira.error || "");
  }
```

- [ ] **Step 5: Spusť testy (nic se nesmí rozbít)**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (22 testů)

- [ ] **Step 6: Ověř vykreslení v Tampermonkey**

Zvyš verzi na `0.1.1` (`@version` i `SCRIPT_VERSION` + test `SCRIPT_VERSION`). Uživatel nainstaluje skript v Tampermonkey z
`http://127.0.0.1:8766/wtm-jira-sync.user.js` (bridge server ho servíruje; Tampermonkey nabídne instalaci) a otevře WTM říjen 2026.
Kontrola přes bridge:
```powershell
node tools/browser-bridge-cli.mjs eval "JSON.stringify({ok:document.querySelectorAll('.gm-wjs-ok').length,diff:document.querySelectorAll('.gm-wjs-diff').length,extra:document.querySelectorAll('.gm-wjs-extra').length,rows:document.querySelectorAll('.gm-wjs-row').length,days:[...document.querySelectorAll('.gm-wjs-day')].map(e=>e.textContent)})" ; exit $LASTEXITCODE
```
Expected pro rozbalený týden 5.–9. 10. 2026 (data teď sedí): `ok` = počet zobrazených položek, `rows` = 0, `extra` = 0,
souhrny dnů „Jira X · WTM X“ se stejnými časy. Totéž ověř s anglickou lokalizací stránky.

- [ ] **Step 7: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): render pairing states and virtual rows"
```

---

### Task 9: Zápis do WTM (řádek, úprava, „Zapsat vše“)

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `BROWSER: actions`; nahradit dočasné `onAction` a `onDayAll` z Task 8)

**Interfaces:**
- Consumes: `agent.call`, `buildCreateDtoIn`, `buildUpdateDtoIn`, `rowActionsFor`, `state`
- Produces: `executeActions(actions) → Promise<{done: number, failed: {action, error}[]}>`, finální `onAction`, `onDayAll`

- [ ] **Step 1: Nahraď `onAction` a `onDayAll`**

Smaž dočasné funkce z Task 8 a vlož:
```js
  // --- BROWSER: actions ---

  function actionKey(action) {
    return action.type === "update" ? `i${action.item.id}` : `w${action.worklog.worklogId}`;
  }

  async function executeActions(actions) {
    const result = { done: 0, failed: [] };
    for (const action of actions) {
      if (action.blocked) {
        result.failed.push({ action, error: action.blocked });
        continue;
      }
      const cmd = action.type === "create" ? "createTimesheetItem" : "updateTimesheetItem";
      const dtoIn = action.type === "create" ? buildCreateDtoIn(action.worklog, action.subject) : buildUpdateDtoIn(action.item, action.worklog, null);
      const res = await agent.call(cmd, dtoIn);
      if (res.ok) result.done++;
      else {
        state.messages[actionKey(action)] = res.error;
        result.failed.push({ action, error: res.error });
      }
    }
    return result;
  }

  async function runBatch(actions) {
    if (state.busy || !actions.length) return;
    if (!state.wtmAuth) {
      alert("WTM zatím neposlalo přihlášení – obnov stránku a zkus to znovu.");
      return;
    }
    state.busy = true;
    render();
    const result = await executeActions(actions);
    state.busy = false;
    if (result.done) {
      const failed = result.failed.length ? `, ${result.failed.length} selhalo` : "";
      toast(`Zapsáno ${result.done}${failed}. Načítám stránku znovu…`);
      setTimeout(() => location.reload(), 1500);
    } else {
      toast(`Nic se nezapsalo: ${result.failed.map((f) => f.error).join("; ")}`);
      render();
    }
  }

  function onAction(action) {
    runBatch([action]);
  }

  function onDayAll(date) {
    runBatch(rowActionsFor(date).filter((a) => !a.blocked));
  }

  function toast(text) {
    const el = h("div", { class: "gm-wjs-toast", role: "status" }, text);
    el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;padding:10px 14px;border-radius:6px;background:#1b2230;color:#fff;font:14px/20px system-ui,sans-serif";
    document.body.append(el);
    setTimeout(() => el.remove(), 4000);
  }
```
Poznámka: `alert` v userscriptu je v pořádku (běží v kontextu stránky WTM, ne v artefaktu).

- [ ] **Step 2: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (22 testů)

- [ ] **Step 3: Ověř zápis naostro – jen se svolením uživatele**

Zvyš verzi na `0.1.2`. Postup s uživatelem:
1. Uživatel v Jiře založí testovací worklog 15 min na svém ticketu na dnešní den (časově volné místo).
2. Obnov WTM: u dne se musí objevit virtuální řádek „chybí ve WTM“ s artefaktem.
3. Uživatel klikne „Zapsat do WTM“ → toast „Zapsáno 1“ → stránka se načte znovu → položka je zelená ✓.
4. Uživatel v Jiře změní délku worklogu → po obnovení je položka oranžová → „Upravit podle Jiry“ → zelená ✓.
5. Uživatel worklog v Jiře smaže → položka je červená „není v Jiře“ → smaže ji ručně košem WTM.

Expected: každý krok odpovídá popisu; v konzoli žádné chyby.

- [ ] **Step 4: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): write missing and differing items to WTM"
```

---

### Task 10: Panel stavu a nastavení mapování

**Files:**
- Modify: `wtm-jira-sync.user.js` (sekce `BROWSER: panel`; nahradit dočasné `renderPanel` z Task 8)

**Interfaces:**
- Consumes: `state`, `loadSettings`, `saveSettings`, `seedMappingFromWtm`, `loadJira`, `currentYearMonth`
- Produces: finální `renderPanel()`, `openSettings()`

- [ ] **Step 1: Nahraď dočasné `renderPanel`**

```js
  // --- BROWSER: panel ---

  const PANEL_ID = "gm-wjs-panel";

  function monthTotals() {
    const all = Object.values(state.results);
    const count = (k) => all.reduce((s, r) => s + r[k].length, 0);
    return { ok: count("ok"), diff: count("diff"), missing: count("missing"), extra: count("extra") };
  }

  function renderPanel() {
    if (!document.body) return;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.style.cssText = "position:fixed;top:56px;right:16px;z-index:99998;padding:8px 12px;border-radius:6px;background:#fff;border:1px solid #dde1e8;box-shadow:0 2px 8px rgba(0,0,0,.12);font:13px/20px system-ui,sans-serif;max-width:340px";
      document.body.append(panel);
    }
    panel.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "WTM ← Jira ";
    panel.append(title);
    const status = document.createElement("span");
    if (state.jira.status === "loading") status.textContent = "načítám Jiru…";
    else if (state.jira.status === "error") {
      status.style.color = "#b23b2e";
      status.textContent = state.jira.error;
      if (state.jira.unauthorized) {
        const a = document.createElement("a");
        a.href = `${state.settings.jiraBaseUrl}/login.jsp`;
        a.target = "_blank";
        a.textContent = " Přihlásit do Jiry";
        status.append(a);
      }
    } else if (state.jira.status === "ok") {
      const t = monthTotals();
      status.textContent = `✓ ${t.ok} · ≠ ${t.diff} · chybí ${t.missing} · není v Jiře ${t.extra}`;
    } else status.textContent = "čekám na data WTM (přepni měsíc nebo obnov stránku)";
    panel.append(status, document.createElement("br"));
    const button = (text, fn) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "margin:4px 6px 0 0;padding:2px 10px;font:600 12px/18px system-ui,sans-serif;cursor:pointer";
      b.addEventListener("click", fn);
      panel.append(b);
    };
    button("Obnovit", () => currentYearMonth && loadJira(currentYearMonth));
    button("Nastavení", openSettings);
    if (!state.wtmAuth) {
      const warn = document.createElement("div");
      warn.style.color = "#9a6216";
      warn.textContent = "Zápis do WTM bude možný po prvním volání WTM (obnov stránku).";
      panel.append(warn);
    }
  }

  function openSettings() {
    const settings = loadSettings();
    settings.mapping = seedMappingFromWtm(state.items, settings.mapping);
    const overlay = document.createElement("div");
    overlay.className = OWN_CLASS;
    overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center";
    const box = document.createElement("div");
    box.style.cssText = "background:#fff;border-radius:8px;padding:16px;min-width:560px;max-width:90vw;max-height:80vh;overflow:auto;font:13px/20px system-ui,sans-serif";
    box.innerHTML = "<h3 style='margin:0 0 8px'>Nastavení WTM ← Jira</h3><label>Jira: <input data-k='jira' style='width:320px'></label><h4 style='margin:12px 0 4px'>Label → artefakt</h4><table data-k='rows' style='width:100%;border-collapse:collapse'></table>";
    box.querySelector("[data-k=jira]").value = settings.jiraBaseUrl;
    const table = box.querySelector("[data-k=rows]");
    const addRow = (label, url) => {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td><input data-k='label' style='width:140px'></td><td><input data-k='url' style='width:100%'></td><td><button data-k='del'>✕</button></td>";
      tr.querySelector("[data-k=label]").value = label;
      tr.querySelector("[data-k=url]").value = url;
      tr.querySelector("[data-k=del]").addEventListener("click", () => tr.remove());
      table.append(tr);
    };
    for (const [label, url] of Object.entries(settings.mapping)) addRow(label, url);
    const actionsBar = document.createElement("div");
    actionsBar.style.marginTop = "12px";
    const mk = (text, fn) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.marginRight = "8px";
      b.addEventListener("click", fn);
      actionsBar.append(b);
    };
    mk("Přidat řádek", () => addRow("W_", ""));
    mk("Uložit", () => {
      const mapping = {};
      for (const tr of table.querySelectorAll("tr")) {
        const label = tr.querySelector("[data-k=label]").value.trim();
        const url = tr.querySelector("[data-k=url]").value.trim();
        if (/^W_/.test(label) && url) mapping[label] = url;
      }
      state.settings = { jiraBaseUrl: box.querySelector("[data-k=jira]").value.trim() || DEFAULT_SETTINGS.jiraBaseUrl, mapping };
      saveSettings(state.settings);
      overlay.remove();
      if (currentYearMonth) loadJira(currentYearMonth);
    });
    mk("Zavřít", () => overlay.remove());
    box.append(actionsBar);
    overlay.append(box);
    document.body.append(overlay);
  }
```

- [ ] **Step 2: Spusť testy**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (22 testů)

- [ ] **Step 3: Ověř panel a nastavení v Tampermonkey**

Zvyš verzi na `0.1.3`. Kontrola:
1. Panel vpravo nahoře ukazuje „✓ N · ≠ 0 · chybí 0 · není v Jiře 0“ pro říjen 2026.
2. „Nastavení“ ukáže tabulku předvyplněnou z WTM (`W_SLA`, `W_DR`, `W_MIG_HW_ENE`, `W_IEDC`) a `W_RTO_PS`.
3. Odhlášení z Jiry (jiný profil nebo smazané cookies Jiry) → panel červeně „…“ + „Přihlásit do Jiry“, žádné značky.
4. Uložení nastavení přežije obnovení stránky.

- [ ] **Step 4: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js
git commit -m "feat(wtm-jira-sync): status panel and label mapping settings"
```

---

### Task 11: Dokumentace a vydání 0.2.0

**Files:**
- Modify: `wtm-jira-sync.user.js` (`@version` a `SCRIPT_VERSION` → `0.2.0`)
- Modify: `test/wtm-jira-sync.test.js` (test verze → `0.2.0`)
- Modify: `README.md`, `changelogs.md`

- [ ] **Step 1: Uprav verzi a test verze na `0.2.0`**

V `wtm-jira-sync.user.js`: `// @version      0.2.0` a `const SCRIPT_VERSION = "0.2.0";`.
V testu: `test("SCRIPT_VERSION is 0.2.0", () => { assert.equal(api.SCRIPT_VERSION, "0.2.0"); });`

- [ ] **Step 2: Přidej do `README.md` sekci** (ve stylu ostatních skriptů v README)

```markdown
### WTM ← Jira sync (`wtm-jira-sync.user.js`)

Na stránce WTM „Výkazy za měsíc“ spáruje položky s tvými worklogy v Jiře (`jira.indsoft.local`):
zelená = sedí, oranžová = liší se (tlačítko „Upravit podle Jiry“), virtuální řádek = chybí ve WTM
(„Zapsat do WTM“, „Zapsat vše“ za den), červená = ve WTM navíc (mažeš ručně). Jira je zdroj pravdy,
skript do Jiry nezapisuje a ve WTM nic nemaže. Artefakt WTM se bere z W_ labelu ticketu podle tabulky
v Nastavení. Potřebuje být přihlášený do Jiry ve stejném prohlížeči.
```

- [ ] **Step 3: Přidej záznam do `changelogs.md`** (na začátek, ve stylu souboru)

```markdown
## wtm-jira-sync.user.js 0.2.0 (2026-10-10)
- Nový skript: párování WTM ↔ Jira na stránce Výkazy za měsíc, zápis chybějících a rozdílných položek do WTM, nastavení label → artefakt.
```

- [ ] **Step 4: Spusť všechny testy skriptu**

Run: `node --test test/wtm-jira-sync.test.js`
Expected: PASS (22 testů)

- [ ] **Step 5: Commit (jen se souhlasem uživatele)**

```bash
git add wtm-jira-sync.user.js test/wtm-jira-sync.test.js README.md changelogs.md
git commit -m "docs(wtm-jira-sync): README and changelog for 0.2.0"
```
