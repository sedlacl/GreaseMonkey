const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../wtm-jira-sync.user.js");

test("SCRIPT_VERSION is 0.6.0", () => {
  assert.equal(api.SCRIPT_VERSION, "0.6.0");
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
      highRate: true,
    },
    { id: "a2", datetimeFrom: "2026-10-09T07:00:00.000Z", datetimeTo: "2026-10-09T07:30:00.000Z", description: "IDS-2", state: "confirmed" },
  ]);
  assert.deepEqual(items[0], {
    id: "a1", date: "2026-10-09", from: "07:45", to: "08:15", key: "CS-1", comment: "Analýza, Vývoj",
    description: "CS-1 Analýza, Vývoj", subject: "https://example.test/artifactInfo?id=1", subjectName: "W_SLA", state: "active", highRate: true,
  });
  assert.equal(items[1].highRate, false);
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

test("matchDay falls back to day + label for WTM items without a ticket key", () => {
  const d = "2026-10-01";
  const mapping = { W_RTO_PS: { url: "https://bt.test/artifactInfo?id=rto" } };
  const w = { ...W("CS-9768", d, "13:00", "19:15", "Schůzky"), labels: ["W_RTO_PS"] };
  const wOther = { ...W("CS-1", d, "08:00", "09:00"), labels: ["W_RTO_PS"] };
  const keyless = { ...I("i1", "", d, "13:00", "19:15", ""), subject: "https://bt.test/userGate/artifactInfo?id=rto", subjectName: "psd.rto Presale" };
  const wordKey = { ...I("i2", "Schůzky", d, "08:00", "09:00", ""), subject: "https://bt.test/artifactInfo?id=other", subjectName: "Jiný" };
  const res = api.matchDay([w, wOther], [keyless, wordKey], mapping);
  assert.deepEqual(res.ok.map((p) => [p.worklog.key, p.item.id, p.loose]), [["CS-9768", "i1", true]]);
  assert.deepEqual(res.missing.map((x) => x.key), ["CS-1"]);
  assert.deepEqual(res.extra.map((x) => x.id), ["i2"]);
});

test("matchDay fallback with a different time is a diff that can be updated", () => {
  const d = "2026-10-01";
  const w = { ...W("CS-9768", d, "13:00", "19:15", "Schůzky"), labels: ["W_RTO_PS"] };
  const item = { ...I("i1", "", d, "13:30", "19:00", ""), subjectName: "W_RTO_PS" };
  const res = api.matchDay([w], [item], {});
  assert.equal(res.ok.length, 0);
  assert.deepEqual(res.diff.map((p) => [p.worklog.key, p.item.id, p.loose]), [["CS-9768", "i1", true]]);
  assert.equal(res.missing.length + res.extra.length, 0);
});

test("matchDay does not loosely pair items that carry another ticket key", () => {
  const d = "2026-10-01";
  const w = W("CS-2", d, "08:00", "09:00");
  const res = api.matchDay([w], [I("i1", "CS-3", d, "08:00", "09:00")], { W_SLA: { url: "s" } });
  assert.equal(res.ok.length, 0);
  assert.equal(res.missing.length, 1);
  assert.equal(res.extra.length, 1);
});

test("matchMonth passes the mapping to the fallback", () => {
  const w = W("CS-1", "2026-10-05", "08:00", "09:00");
  const res = api.matchMonth([w], [I("x", "", "2026-10-05", "08:00", "09:00", "")], { W_SLA: { url: "s" } });
  assert.equal(res["2026-10-05"].ok[0].loose, true);
});

test("seedMappingFromWtm adds W_ subjects without overwriting", () => {
  const items = [I("1", "CS-1", "2026-10-01", "08:00", "09:00"), { ...I("2", "X-1", "2026-10-01", "09:00", "10:00"), subjectName: "Projekt", subject: "p" }];
  items[0].subject = "sla-url";
  assert.deepEqual(api.seedMappingFromWtm(items, { W_DR: { url: "dr-url" } }), { W_DR: { url: "dr-url" }, W_SLA: { url: "sla-url" } });
  assert.deepEqual(api.seedMappingFromWtm(items, { W_SLA: { url: "keep" } }), { W_SLA: { url: "keep" } });
});

test("resolveSubject prefers a mapped W_ label", () => {
  const m = { W_SLA: { url: "sla" }, W_OLD: "old" };
  assert.deepEqual(api.resolveSubject(["AFLEX", "W_SLA"], m), { label: "W_SLA", subject: "sla" });
  assert.deepEqual(api.resolveSubject(["W_OLD"], m), { label: "W_OLD", subject: "old" });
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

test("buildUpdateDtoIn keeps highRate of the existing item", () => {
  const w = W("CS-1", "2026-10-09", "07:45", "08:15", "Analýza");
  const item = { ...I("i1", "CS-1", "2026-10-09", "08:00", "08:30"), highRate: true };
  assert.equal(api.buildUpdateDtoIn(item, w, null).highRate, true);
  assert.equal(api.buildUpdateDtoIn({ ...item, highRate: false }, w, null).highRate, false);
  assert.equal(api.buildCreateDtoIn(w, "s").highRate, false);
});

test("isOwnMonthlyPage accepts only the own monthly page", () => {
  const p = "/uu-specialistwtm-maing01/abc/workerMonthlyDetail";
  assert.equal(api.isOwnMonthlyPage(p, ""), true);
  assert.equal(api.isOwnMonthlyPage(p, "?yearMonth=202610"), true);
  assert.equal(api.isOwnMonthlyPage(p, "?workerUuIdentity=1-2"), false);
  assert.equal(api.isOwnMonthlyPage(p, "?yearMonth=202610&workerUuIdentity=1-2"), false);
  assert.equal(api.isOwnMonthlyPage("/uu-specialistwtm-maing01/abc/other", ""), false);
});

test("isOwnMonthlyPage accepts the app root, which shows the monthly detail by default", () => {
  assert.equal(api.isOwnMonthlyPage("/uu-specialistwtm-maing01/99923616732453117-8031926f783d4aaba733af73c1974840/", ""), true);
  assert.equal(api.isOwnMonthlyPage("/uu-specialistwtm-maing01/abc", "?yearMonth=202610"), true);
  assert.equal(api.isOwnMonthlyPage("/uu-specialistwtm-maing01/abc/", "?workerUuIdentity=1-2"), false);
  assert.equal(api.isOwnMonthlyPage("/uu-specialistwtm-maing01/", ""), false);
});

test("planDayActions blocks confirmed diff items and unknown artifacts, honours choices", () => {
  const d = "2026-10-09";
  const today = "2026-10-10";
  const confirmed = I("c1", "CS-1", d, "08:00", "09:00", "Jiný", "confirmed");
  const wDiff = W("CS-1", d, "08:00", "09:00");
  const wUnknown = { ...W("CS-2", d, "10:00", "10:30"), labels: ["W_NEW"] };
  const wOk = W("CS-3", d, "11:00", "11:30");
  const result = { ok: [], diff: [{ worklog: wDiff, item: confirmed }], missing: [wOk, wUnknown], extra: [] };
  const mapping = { W_SLA: "sla" };
  const plan = (choices) => api.planDayActions({ result, dayItems: [confirmed], mapping, choices, today });

  const actions = plan({});
  assert.deepEqual(actions.map((a) => a.worklog.from), ["08:00", "10:00", "11:00"]);
  assert.equal(actions[0].type, "update");
  assert.equal(actions[0].blocked, "Položka je potvrzená");
  assert.match(actions[1].blocked, /Neznámý artefakt pro W_NEW/);
  assert.equal(actions[2].type, "create");
  assert.equal(actions[2].blocked, null);
  assert.equal(actions[2].subject, "sla");

  const chosen = plan({ [wUnknown.worklogId]: "picked" });
  assert.equal(chosen[1].subject, "picked");
  assert.equal(chosen[1].blocked, null);
});

test("planDayActions blocks writes for blocked and expired labels", () => {
  const d = "2026-10-09";
  const wExpired = { ...W("CS-4", d, "08:00", "09:00"), labels: ["W_OLD"] };
  const wBlocked = { ...W("CS-5", d, "10:00", "11:00"), labels: ["W_STOP"] };
  const wValid = { ...W("CS-6", d, "12:00", "13:00"), labels: ["W_FUT"] };
  const result = { ok: [], diff: [], missing: [wExpired, wBlocked, wValid], extra: [] };
  const mapping = {
    W_OLD: { url: "old", validTo: "2026-09-30" },
    W_STOP: { url: "stop", blocked: true, note: "Jen na povolení" },
    W_FUT: { url: "fut", validTo: "2026-10-09" },
  };
  const actions = api.planDayActions({ result, dayItems: [], mapping, choices: {}, today: "2026-10-10" });
  assert.equal(actions[0].blocked, "Label W_OLD platí jen do 30. 9. 2026");
  assert.equal(actions[1].blocked, "Label W_STOP je blokovaný: Jen na povolení");
  assert.equal(actions[2].blocked, null);
  const picked = api.planDayActions({ result, dayItems: [], mapping, choices: { [wExpired.worklogId]: "fut" }, today: "2026-10-10" });
  assert.equal(picked[0].blocked, null);
});

test("labelRuleBlock explains blocked and expired labels", () => {
  assert.equal(api.labelRuleBlock("W_A", { url: "a" }, "2026-10-01"), null);
  assert.equal(api.labelRuleBlock("W_A", { url: "a", blocked: true }, "2026-10-01"), "Label W_A je blokovaný");
  assert.equal(api.labelRuleBlock("W_A", { url: "a", validTo: "2026-10-01" }, "2026-10-01"), null);
  assert.equal(api.labelRuleBlock("W_A", { url: "a", validTo: "2026-10-01" }, "2026-10-02"), "Label W_A platí jen do 1. 10. 2026");
});

test("parseToml reads the mappings subset", () => {
  const doc = api.parseToml([
    "# komentář",
    "schema_version = 1",
    "revision = 7 # inline",
    "updated_at = 2026-10-08T12:00:00+02:00",
    'updated_by = "Někdo \\"Q\\""',
    "",
    "[[mapping]]",
    'label = "W_A"',
    "subject_url = 'https://example.test/artifactInfo?id=1#x'",
    "valid_to = 2026-09-30",
    "blocked = true",
    'approvers = ["A", "B"]',
    "",
    "[[mapping]]",
    'label = "W_B"',
    "allowed_users = [",
    '  "x", # první',
    '  "y",',
    "]",
    "ratio = -1.5",
  ].join("\n"));
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.revision, 7);
  assert.equal(doc.updated_at, "2026-10-08T12:00:00+02:00");
  assert.equal(doc.updated_by, 'Někdo "Q"');
  assert.deepEqual(doc.mapping, [
    { label: "W_A", subject_url: "https://example.test/artifactInfo?id=1#x", valid_to: "2026-09-30", blocked: true, approvers: ["A", "B"] },
    { label: "W_B", allowed_users: ["x", "y"], ratio: -1.5 },
  ]);
});

test("parseToml reports the failing line", () => {
  assert.throws(() => api.parseToml('a = 1\nb = "unterminated'), /řádek 2/);
  assert.throws(() => api.parseToml("a = 1\njen text"), /řádek 2/);
  assert.throws(() => api.parseToml("a = 1\na = 2"), /řádek 2.*a/);
});

test("normalizeSubjectUrl drops the userGate segment", () => {
  assert.equal(api.normalizeSubjectUrl("https://h.test/bt/awid/userGate/artifactInfo?id=1"), "https://h.test/bt/awid/artifactInfo?id=1");
  assert.equal(api.normalizeSubjectUrl(" https://h.test/bt/awid/artifactInfo?id=1 "), "https://h.test/bt/awid/artifactInfo?id=1");
});

test("normalizeMapping upgrades string values and drops entries without url", () => {
  assert.deepEqual(api.normalizeMapping({ W_A: "a", W_B: { url: "b", note: "n" }, W_C: { url: "" }, X: "x" }), {
    W_A: { url: "a" },
    W_B: { url: "b", note: "n" },
  });
});

test("mappingFromToml converts entries and lists skipped labels", () => {
  const doc = {
    schema_version: 1, revision: 3, updated_at: "2026-10-08T12:00:00+02:00", updated_by: "X",
    mapping: [
      { label: "W_A", project: "P", artifact: "A", subject_url: "https://h.test/userGate/artifactInfo?id=1", valid_to: "2026-09-30", note: "n", requires_approval: true, approvers: ["L"] },
      { label: "W_B", subject_url: "https://h.test/artifactInfo?id=2", blocked: true },
      { label: "W_C", note: "bez url" },
      { label: "BAD", subject_url: "https://h.test/artifactInfo?id=3" },
    ],
  };
  const out = api.mappingFromToml(doc);
  assert.deepEqual(out.meta, { revision: 3, updatedAt: "2026-10-08T12:00:00+02:00", updatedBy: "X" });
  assert.deepEqual(out.entries, {
    W_A: { url: "https://h.test/artifactInfo?id=1", project: "P", artifact: "A", validTo: "2026-09-30", note: "n", requiresApproval: true, approvers: ["L"], fromFile: true },
    W_B: { url: "https://h.test/artifactInfo?id=2", blocked: true, fromFile: true },
  });
  assert.deepEqual(out.skipped, [{ label: "W_C", reason: "chybí subject_url" }, { label: "BAD", reason: "label nezačíná W_" }]);
  assert.throws(() => api.mappingFromToml({ schema_version: 2, mapping: [] }), /schema_version/);
  assert.throws(() => api.mappingFromToml({ schema_version: 1 }), /mapping/);
});

test("planMappingImport merges file entries and keeps labels not in the file", () => {
  const current = { W_A: { url: "a" }, W_B: { url: "b-old" }, W_KEEP: { url: "k", fromFile: true } };
  const entries = { W_A: { url: "a", fromFile: true }, W_B: { url: "b-new", fromFile: true }, W_N: { url: "n", fromFile: true } };
  const plan = api.planMappingImport(current, entries);
  assert.deepEqual(plan.added, ["W_N"]);
  assert.deepEqual(plan.changed, ["W_B"]);
  assert.deepEqual(plan.same, ["W_A"]);
  assert.deepEqual(plan.notInFile, ["W_KEEP"]);
  assert.deepEqual(plan.merged, {
    W_A: { url: "a", fromFile: true },
    W_B: { url: "b-new", fromFile: true },
    W_KEEP: { url: "k", fromFile: false },
    W_N: { url: "n", fromFile: true },
  });
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

test("buildAgentSource embeds the agent, the extractor and the session nonce", () => {
  const src = api.buildAgentSource("n0nce");
  assert.match(src, /listWorkerTimesheetItemsByMonth/);
  assert.match(src, /gm-wjs-agent/);
  assert.match(src, /"n0nce"/);
  assert.doesNotThrow(() => new Function(src));
});

// Tampermonkey sandbox: event.source is the page window, not the sandbox window proxy.
function fakeSandboxWindow(origin) {
  const listeners = [];
  const pageWindow = {};
  const win = {
    location: { origin },
    posted: [],
    addEventListener: (type, fn) => listeners.push(fn),
    dispatch: (data, eventOrigin = origin) => setTimeout(() => listeners.forEach((fn) => fn({ data, source: pageWindow, origin: eventOrigin })), 0),
    postMessage: (data, targetOrigin) => {
      win.posted.push(targetOrigin);
      win.dispatch(data);
    },
  };
  return win;
}

test("createAgentClient round-trips a WTM call and forwards month/auth from the sandbox", async () => {
  const win = fakeSandboxWindow("https://uuapp.test");
  const seen = { month: null, auth: 0 };
  const client = api.createAgentClient(win, { onMonth: (m) => (seen.month = m), onAuth: () => seen.auth++ }, "n1");
  // fake agent answering every command
  win.addEventListener("message", (e) => {
    if (e.data.source === api.MSG.toAgent && e.data.nonce === "n1") win.dispatch({ source: api.MSG.fromAgent, nonce: "n1", type: "wtm-result", payload: { id: e.data.id, ok: true, data: { id: "new" } } });
  });
  const res = await client.call("createTimesheetItem", { a: 1 });
  assert.deepEqual(res, { id: res.id, ok: true, data: { id: "new" } });
  assert.deepEqual(win.posted, ["https://uuapp.test"]);
  win.dispatch({ source: api.MSG.fromAgent, nonce: "n1", type: "month", payload: { yearMonth: "202610", items: [] } });
  win.dispatch({ source: api.MSG.fromAgent, nonce: "n1", type: "auth", payload: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen.month, { yearMonth: "202610", items: [] });
  assert.equal(seen.auth, 1);
});

test("createAgentClient ignores messages with a wrong nonce or origin", async () => {
  const win = fakeSandboxWindow("https://uuapp.test");
  const seen = { month: 0, auth: 0 };
  api.createAgentClient(win, { onMonth: () => seen.month++, onAuth: () => seen.auth++ }, "n1");
  win.dispatch({ source: api.MSG.fromAgent, nonce: "other", type: "month", payload: { items: [] } });
  win.dispatch({ source: api.MSG.fromAgent, type: "auth", payload: true });
  win.dispatch({ source: api.MSG.fromAgent, nonce: "n1", type: "auth", payload: true }, "https://evil.test");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, { month: 0, auth: 0 });
});

test("isTimesheetMutation matches page-side item changes only", () => {
  const base = "https://uuapp.test/uu-specialistwtm-maing01/awid";
  assert.equal(api.isTimesheetMutation(`${base}/deleteTimesheetItems`), true);
  assert.equal(api.isTimesheetMutation(`${base}/createTimesheetItem`), true);
  assert.equal(api.isTimesheetMutation(`${base}/updateTimesheetItem?x=1`), true);
  assert.equal(api.isTimesheetMutation(`${base}/listWorkerTimesheetItemsByMonth`), false);
  assert.equal(api.isTimesheetMutation(`${base}/getTimesheetItem`), false);
  assert.equal(api.isTimesheetMutation(`${base}/loadConfigAndUserInfo`), false);
});

test("pageAgent refetches the month after a page-side delete", async () => {
  const base = "https://uuapp.test/uu-specialistwtm-maing01/awid";
  const monthUrl = `${base}/listWorkerTimesheetItemsByMonth`;
  const lists = [[{ id: "a" }, { id: "b" }], [{ id: "a" }]];
  const calls = [];
  const response = (text) => ({ ok: true, status: 200, text: async () => text, clone() { return response(text); } });
  const posted = [];
  const saved = { window: globalThis.window, location: globalThis.location };
  globalThis.location = { origin: "https://uuapp.test", pathname: "/uu-specialistwtm-maing01/awid/workerMonthlyDetail" };
  globalThis.window = {
    postMessage: (data) => posted.push(data),
    addEventListener: () => {},
    fetch: async (url, init) => {
      calls.push({ url, body: init && init.body, auth: init && init.headers && init.headers.Authorization });
      if (url === monthUrl) return response(JSON.stringify({ workerMonthlyTimesheet: { yearMonth: "202610" }, timesheetItemList: lists.shift() }));
      return response("{}");
    },
  };
  try {
    api.pageAgent(api.extractMonthResponse, api.isTimesheetMutation, api.MSG, "n1");
    const auth = { Authorization: "Bearer t" };
    await window.fetch(monthUrl, { method: "POST", headers: auth, body: '{"yearMonth":"202610"}' });
    await window.fetch(`${base}/deleteTimesheetItems`, { method: "POST", headers: auth, body: '{"itemList":[{"id":"b"}]}' });
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    globalThis.window = saved.window;
    globalThis.location = saved.location;
  }
  const months = posted.filter((m) => m.type === "month");
  assert.deepEqual(months.map((m) => m.payload.items.map((i) => i.id)), [["a", "b"], ["a"]]);
  assert.ok(posted.every((m) => m.nonce === "n1"));
  assert.deepEqual(calls[2], { url: monthUrl, body: '{"yearMonth":"202610"}', auth: "Bearer t" });
});

test("pageAgent reloadMonth calls the page's own month loader", async () => {
  let reloads = 0;
  const loaderFiber = { type: { tagName: "Uu.SpecialistWtm.WorkerMonthlyDetail" }, stateNode: { reload: () => reloads++ }, return: null };
  const el = { "__reactInternalInstance$abc": { type: "div", stateNode: null, return: { type: { tagName: "Uu.SpecialistWtm.WorkerMonthlyDetailReady" }, stateNode: {}, return: loaderFiber } } };
  const posted = [];
  let onMessage = null;
  const saved = { window: globalThis.window, location: globalThis.location, document: globalThis.document };
  globalThis.location = { origin: "https://uuapp.test", pathname: "/uu-specialistwtm-maing01/awid/workerMonthlyDetail" };
  globalThis.document = { querySelector: (sel) => (sel === ".uu-specialistwtm-worker-monthly-detail-ready" ? el : null) };
  globalThis.window = { postMessage: (data) => posted.push(data), addEventListener: (type, fn) => (onMessage = fn), fetch: async () => ({ ok: true, text: async () => "{}" }) };
  try {
    api.pageAgent(api.extractMonthResponse, api.isTimesheetMutation, api.MSG, "n1");
    await onMessage({ origin: "https://uuapp.test", data: { source: api.MSG.toAgent, nonce: "n1", type: "wtm-call", id: "c1", cmd: "reloadMonth" } });
    globalThis.document = { querySelector: () => null };
    await onMessage({ origin: "https://uuapp.test", data: { source: api.MSG.toAgent, nonce: "n1", type: "wtm-call", id: "c2", cmd: "reloadMonth" } });
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.equal(reloads, 1);
  const results = posted.filter((m) => m.type === "wtm-result").map((m) => m.payload);
  assert.deepEqual(results[0], { id: "c1", ok: true });
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /nenalezena/);
});

// Fictional data in the shape of the "SP53 Standardy vykazování" ManagementKit document (Uu5TilesBricks.Table).
const uu5json = (v) => `<uu5json/>${JSON.stringify(v)}`;
const table = (columns, rows) => ({ uu5Tag: "Uu5TilesBricks.Table", props: { columnList: uu5json(columns.map((header) => ({ header }))), data: uu5json(rows) } });
const section = (header, children) => ({ content: [{ uu5Tag: "Uu5Bricks.Section", props: { header }, children }] });
const SP53_DOC = {
  name: "Standardy vykazování (test)",
  pages: [
    {
      name: "Seznam kódů",
      mts: "2026-10-01T08:00:00.000Z",
      mainPanel: {
        sectionList: [
          section("Projekty - vykazování", [table(
            ["<uu5string />Projekt/DU", "Kódy", "<uu5string />Label v JIRA*/<br/>Název v uuBT", "URI dokumentu v uuBT", "Poznámka", "Původní URI"],
            [
              [{ value: '<uu5string /><p><Plus4U5.Bricks.Plus4ULink uri="ues:T:ALFA" style="<uu5json/>{\\"fontWeight\\":\\"bold\\"}">Projekt Alfa</Plus4U5.Bricks.Plus4ULink><strong> ​</strong>- ALFA</p><ul><li><UuTBricks.Artifact.Link baseUri="https://bt.test" oid="1" altText="Projekt" stateSize="s"/></li></ul>', style: {} }, { value: "" }, { value: "" }, { value: "" }, { value: "" }, { value: "" }],
              [{ value: '<uu5string /><p style="<uu5json/>{\\"marginLeft\\":\\"24px\\"}">Artefakt A</p>' }, { value: "UNI-BT:T.ALFA/W_A" }, { value: "W_A" }, { value: "https://bt.test/userGate/artifactInfo?id=a1" }, { value: "" }, { value: "https://mk.test/document?oid=1" }],
              ["Release 1", "UNI-BT:T.ALFA/W_B", "W_B", "https://bt.test/artifactInfo?id=b1", "od 01.10.2026 nevykazovat", ""],
              ["Presale C", "-", '<uu5string /><Uu5Bricks.Link href="https://mk.test/document?oid=3" target="_blank">W_C</Uu5Bricks.Link>', "https://bt.test/artifactInfo?id=c1", "Na povolení od Lukáše", ""],
              ["Presale D", "UNI-BT:T.ALFA/W_D", "W_D", "", "NEVYKAZOVAT! presale jinde", ""],
              ["Role E", "UNI-BT:T.ALFA/W_E (role)", "", "presalové role", "", ""],
            ],
          )]),
          section('<uu5string/><Uu5Bricks.Link href="UNI-BT:T.S" target="_blank">Servis projekt</Uu5Bricks.Link>', [table(
            ["Artefakt", "Kód", "<uu5string />Label v JIRA*/<br/>Název v uuBT", "URI dokumentu v uuBT", "Poznámka", "Původní URI"],
            [["Provoz", "UNI-BT:T.S/W_OP", "W_OP", "https://bt.test/artifactInfo?id=op", "<uu5string /><p>Pro tým</p><ul><li>Údržba &amp; logy</li></ul>", ""]],
          )]),
        ],
      },
    },
    {
      name: "Pokyny pro vykazování",
      mainPanel: { sectionList: [section("Návod", [table(["Krok"], [["<uu5string /><p>Přihlas se na WTM</p>"]])])] },
    },
    {
      name: "Seznam kódů - uzavřené",
      mts: "2026-10-05T08:00:00.000Z",
      mainPanel: {
        sectionList: [section("Nevykazovat - přehled", [table(
          ["Vývojové projekty", "Kód", "Popis*", "Poznámka"],
          [
            { value: ["Starý projekt", "UNI-BT:T.OLD/W_OLD", { value: "W_OLD", style: {} }, { value: "NEVYKAZOVAT", style: {} }], style: {} },
            ["Migrace HW Realizace", "UNI-BT:T/W_RE", "W_HW_RE", "NEVYKAZOVAT od 16.02.2026 včetně"],
          ],
        )])],
      },
    },
  ],
};

test("uu5Text strips uu5 markup, nested uu5json attributes and entities", () => {
  assert.equal(api.uu5Text('<uu5string /><p style="<uu5json/>{\\"a\\":\\"b\\"}">Ahoj</p><ul><li>světe &amp; spol.</li></ul>'), "Ahoj světe & spol.");
  assert.equal(api.uu5Text('<uu5string /><Uu5Bricks.Link href="x">W_OP</Uu5Bricks.Link>'), "W_OP");
  assert.equal(api.uu5Text("prostý​ text"), "prostý text");
  assert.equal(api.uu5Text(null), "");
});

test("mappingFromSp53Doc reads labels, artifacts and rules from the document tables", () => {
  const out = api.mappingFromSp53Doc(SP53_DOC);
  assert.deepEqual(out.entries, {
    W_A: { url: "https://bt.test/artifactInfo?id=a1", project: "Projekt Alfa - ALFA", artifact: "Artefakt A", fromFile: true },
    W_B: { url: "https://bt.test/artifactInfo?id=b1", project: "Projekt Alfa - ALFA", artifact: "Release 1", note: "od 01.10.2026 nevykazovat", validTo: "2026-09-30", fromFile: true },
    W_C: { url: "https://bt.test/artifactInfo?id=c1", project: "Projekt Alfa - ALFA", artifact: "Presale C", note: "Na povolení od Lukáše", requiresApproval: true, fromFile: true },
    W_OP: { url: "https://bt.test/artifactInfo?id=op", project: "Servis projekt", artifact: "Provoz", note: "Pro tým Údržba & logy", fromFile: true },
  });
  assert.deepEqual(out.skipped, [{ label: "W_D", reason: "chybí URI" }, { label: "W_E", reason: "chybí URI" }]);
  assert.deepEqual(out.closed, {
    W_D: { note: "NEVYKAZOVAT! presale jinde", blocked: true },
    W_OLD: { note: "NEVYKAZOVAT", blocked: true },
    W_HW_RE: { note: "NEVYKAZOVAT od 16.02.2026 včetně", validTo: "2026-02-15" },
  });
  assert.deepEqual(out.meta, { revision: null, updatedAt: "2026-10-05T08:00:00.000Z", updatedBy: null });
});

test("mappingFromSp53Doc never treats a currently valid label as closed", () => {
  const doc = JSON.parse(JSON.stringify(SP53_DOC));
  const closedTable = doc.pages[2].mainPanel.sectionList[0].content[0].children[0];
  const rows = JSON.parse(closedTable.props.data.replace("<uu5json/>", ""));
  rows.push(["Starý servis", "UNI-BT:T.S.OLD/W_OP", "W_OP", "NEVYKAZOVAT"]);
  closedTable.props.data = `<uu5json/>${JSON.stringify(rows)}`;
  const out = api.mappingFromSp53Doc(doc);
  assert.equal(out.closed.W_OP, undefined);
  assert.equal(out.entries.W_OP.blocked, undefined);
});

test("mappingFromSp53Doc rejects a document without label tables", () => {
  assert.throws(() => api.mappingFromSp53Doc({ name: "x", pages: [] }), /žádné labely/);
});

test("applyClosedLabels blocks existing labels that the document lists as closed", () => {
  const merged = { W_A: { url: "a", fromFile: true }, W_OLD: { url: "old", fromFile: false } };
  const res = api.applyClosedLabels(merged, { W_OLD: { note: "NEVYKAZOVAT", blocked: true }, W_GONE: { blocked: true } });
  assert.deepEqual(res.affected, ["W_OLD"]);
  assert.deepEqual(res.merged.W_OLD, { url: "old", fromFile: false, note: "NEVYKAZOVAT", blocked: true });
  assert.deepEqual(res.merged.W_A, { url: "a", fromFile: true });
  assert.equal(merged.W_OLD.blocked, undefined);
});

test("pageAgent loadMngkitDoc reads all document pages with a uu5 call token", async () => {
  const base = "https://uuapp.test/uu-managementkit-maing02/abc123";
  const docUrl = `${base}/document?oid=0123456789abcdef01234567&pageOid=x`;
  const calls = [];
  const tokens = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const posted = [];
  let onMessage = null;
  const saved = { window: globalThis.window, location: globalThis.location, document: globalThis.document, UU5: globalThis.UU5 };
  globalThis.location = { origin: "https://uuapp.test", pathname: "/uu-specialistwtm-maing01/awid/workerMonthlyDetail" };
  globalThis.document = { querySelector: () => null };
  globalThis.UU5 = { Environment: { getSession: () => ({ getCallToken: async (uri) => { tokens.push(uri); return "Bearer tok"; } }) } };
  globalThis.window = {
    UU5: globalThis.UU5,
    postMessage: (data) => posted.push(data),
    addEventListener: (type, fn) => (onMessage = fn),
    fetch: async (url, init) => {
      calls.push({ url, auth: init && init.headers && init.headers.Authorization });
      if (!url.includes("/ecc/")) return json({ name: "Doc", data: { uuEccData: { documentOid: "ecc1" } } });
      if (url.includes("uuEccData.pageOid=p2")) return json({ requestedPage: { sys: { mts: "2026-10-02T00:00:00.000Z" }, mainPanel: { sectionList: ["two"] } } });
      if (url.includes("uuEccData.pageOid=p1")) return json({ requestedPage: { sys: { mts: "2026-10-01T00:00:00.000Z" }, mainPanel: { sectionList: ["one"] } } });
      return json({ name: "Doc", pageList: [{ pageOid: "p1", name: "Seznam kódů" }, { pageOid: "p2", name: "Seznam kódů - uzavřené" }] });
    },
  };
  const send = (id, url) => onMessage({ origin: "https://uuapp.test", data: { source: api.MSG.toAgent, nonce: "n1", type: "wtm-call", id, cmd: "loadMngkitDoc", dtoIn: { url } } });
  try {
    api.pageAgent(api.extractMonthResponse, api.isTimesheetMutation, api.MSG, "n1");
    await send("c1", docUrl);
    await send("c2", "https://evil.test/uu-managementkit-maing02/abc123/document?oid=0123456789abcdef01234567");
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.deepEqual(tokens, [base]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.auth === "Bearer tok" && c.url.startsWith(base)));
  const results = posted.filter((m) => m.type === "wtm-result").map((m) => m.payload);
  assert.deepEqual(results[0], {
    id: "c1",
    ok: true,
    data: {
      name: "Doc",
      pages: [
        { name: "Seznam kódů", mts: "2026-10-01T00:00:00.000Z", mainPanel: { sectionList: ["one"] } },
        { name: "Seznam kódů - uzavřené", mts: "2026-10-02T00:00:00.000Z", mainPanel: { sectionList: ["two"] } },
      ],
    },
  });
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /Neplatná adresa/);
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
  const progress = [];
  const out = await api.fetchJiraMonth({ from: "2026-10-01", to: "2026-10-31" }, request, (p) => progress.push(p));
  assert.deepEqual(progress[0], { phase: "search", done: 0, total: null });
  assert.deepEqual(progress[progress.length - 1], { phase: "worklogs", done: 2, total: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "CS-1");
  assert.equal(out[0].from, "08:00");
  assert.ok(calls.some((p) => p.includes(encodeURIComponent('worklogDate >= "2026-10-01"'))));
  assert.equal(calls.filter((p) => p.startsWith("/rest/api/2/search")).length, 2);
});

test("putJiraCache stores worklogs per month and keeps the newest months", () => {
  let cache = {};
  for (const ym of ["202607", "202608", "202609", "202610"]) cache = api.putJiraCache(cache, ym, [{ worklogId: ym }], "2026-10-10T10:00:00.000Z");
  assert.deepEqual(Object.keys(cache).sort(), ["202608", "202609", "202610"]);
  assert.deepEqual(cache["202610"], { at: "2026-10-10T10:00:00.000Z", worklogs: [{ worklogId: "202610" }] });
  assert.deepEqual(api.putJiraCache(null, "202610", [], "x"), { "202610": { at: "x", worklogs: [] } });
});

test("staleReason blocks writes while Jira data come from the cache", () => {
  assert.equal(api.staleReason({ status: "ok" }), null);
  assert.match(api.staleReason({ status: "ok", cachedAt: "x", refreshing: true }), /načítají/);
  assert.match(api.staleReason({ status: "ok", cachedAt: "x", refreshError: "boom" }), /nedostupná/);
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
