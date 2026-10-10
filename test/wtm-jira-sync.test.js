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
