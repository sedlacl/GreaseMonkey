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
