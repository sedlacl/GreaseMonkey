const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../wtm-jira-sync.user.js");

test("SCRIPT_VERSION is 0.1.3", () => {
  assert.equal(api.SCRIPT_VERSION, "0.1.3");
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
