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
    buildWtmDescription,
    normalizeWtmItems,
    normalizeJiraWorklogs,
    matchDay,
    matchMonth,
    DEFAULT_MAPPING,
    seedMappingFromWtm,
    resolveSubject,
    buildCreateDtoIn,
    buildUpdateDtoIn,
    checkWtmRules,
    run,
  };
});
