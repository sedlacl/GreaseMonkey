// ==UserScript==
// @name         WTM ← Jira sync
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      0.4.1
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

  const SCRIPT_VERSION = "0.4.1";
  const SCRIPT_FLAG = "__gmWtmJiraSync";
  const TZ = "Europe/Prague";

  // --- PURE: time ---

  function toPragueParts(input) {
    const d = input instanceof Date ? input : new Date(input);
    const s = d.toLocaleString("sv-SE", { timeZone: TZ, hourCycle: "h23" });
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
        highRate: Boolean(i.highRate),
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

  const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

  // Fallback for WTM items entered without a ticket key: same day and the worklog's label / artifact.
  function sameArtifact(worklog, item, mapping) {
    if (item.subjectName && (worklog.labels || []).includes(item.subjectName)) return true;
    const subject = mapping ? resolveSubject(worklog.labels, mapping).subject : null;
    return Boolean(subject && item.subject && normalizeSubjectUrl(subject) === normalizeSubjectUrl(item.subject));
  }

  function matchDay(worklogs, items, mapping) {
    const W = [...worklogs].sort(byFrom);
    const I = [...items].sort(byFrom);
    const ok = [];
    const diff = [];
    pairBy(W, I, (w, i) => w.key === i.key && w.from === i.from && w.to === i.to && buildWtmDescription(w.key, w.comment) === i.description, ok);
    pairBy(W, I, (w, i) => w.key === i.key && w.from === i.from && w.to === i.to, diff);
    pairBy(W, I, (w, i) => w.key === i.key, diff);
    const looseOk = [];
    const looseDiff = [];
    const keyless = (w, i) => !JIRA_KEY_RE.test(i.key) && sameArtifact(w, i, mapping);
    pairBy(W, I, (w, i) => keyless(w, i) && w.from === i.from && w.to === i.to, looseOk);
    pairBy(W, I, keyless, looseDiff);
    ok.push(...looseOk.map((p) => ({ ...p, loose: true })));
    diff.push(...looseDiff.map((p) => ({ ...p, loose: true })));
    return { ok, diff, missing: W, extra: I };
  }

  function matchMonth(worklogs, items, mapping) {
    const dates = new Set([...worklogs.map((w) => w.date), ...items.map((i) => i.date)]);
    const out = {};
    for (const date of [...dates].sort()) {
      out[date] = matchDay(worklogs.filter((w) => w.date === date), items.filter((i) => i.date === date), mapping);
    }
    return out;
  }

  // --- PURE: mapping & rules ---

  const DEFAULT_MAPPING = Object.freeze({
    W_RTO_PS: Object.freeze({ url: "https://uuapp.plus4u.net/uu-businessterritory-maing01/0e0e8e476f374ee0b6edd7f262ba0ff6/artifactInfo?id=6ab0d68c86377525f536a4fd" }),
  });

  function entryUrl(value) {
    if (typeof value === "string") return value;
    return (value && value.url) || "";
  }

  function normalizeSubjectUrl(url) {
    return String(url || "").trim().replace(/\/userGate\/artifactInfo\b/, "/artifactInfo");
  }

  function normalizeMapping(raw) {
    const out = {};
    for (const [label, value] of Object.entries(raw || {})) {
      const url = entryUrl(value);
      if (!/^W_/.test(label) || !url) continue;
      out[label] = typeof value === "string" ? { url } : { ...value };
    }
    return out;
  }

  function seedMappingFromWtm(items, current) {
    const out = { ...current };
    for (const i of items || []) {
      if (/^W_/.test(i.subjectName) && i.subject && !out[i.subjectName]) out[i.subjectName] = { url: i.subject };
    }
    return out;
  }

  function resolveSubject(labels, mapping) {
    const wLabels = (labels || []).filter((l) => /^W_/.test(l));
    const mapped = wLabels.find((l) => entryUrl(mapping[l]));
    if (mapped) return { label: mapped, subject: entryUrl(mapping[mapped]) };
    return { label: wLabels[0] || null, subject: null };
  }

  function formatCzDate(isoDate) {
    const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
    return `${d}. ${m}. ${y}`;
  }

  function labelRuleBlock(label, entry, date) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.blocked) return `Label ${label} je blokovaný${entry.note ? `: ${entry.note}` : ""}`;
    if (entry.validTo && date > String(entry.validTo).slice(0, 10)) return `Label ${label} platí jen do ${formatCzDate(entry.validTo)}`;
    return null;
  }

  function mappingLabelForUrl(mapping, url) {
    return Object.keys(mapping || {}).find((l) => entryUrl(mapping[l]) === url) || null;
  }

  // --- PURE: mapping import (TOML) ---

  function tomlError(lineNo, message) {
    return new Error(`TOML řádek ${lineNo}: ${message}`);
  }

  const TOML_ESCAPES = Object.freeze({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" });

  function parseTomlValue(src, lineNo) {
    let i = 0;
    const ws = () => {
      for (;;) {
        while (i < src.length && /[ \t\r\n]/.test(src[i])) i++;
        if (src[i] !== "#") return;
        while (i < src.length && src[i] !== "\n") i++;
      }
    };
    const basicString = () => {
      let out = "";
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") {
        if (src[i] !== "\\") {
          out += src[i++];
          continue;
        }
        const e = src[i + 1];
        if (TOML_ESCAPES[e] !== undefined) {
          out += TOML_ESCAPES[e];
          i += 2;
          continue;
        }
        const len = e === "u" ? 4 : e === "U" ? 8 : 0;
        const hex = src.slice(i + 2, i + 2 + len);
        if (!len || hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw tomlError(lineNo, "neplatná escape sekvence");
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + len;
      }
      if (src[i] !== '"') throw tomlError(lineNo, "neukončený řetězec");
      i++;
      return out;
    };
    const value = () => {
      ws();
      const c = src[i];
      if (c === '"') return basicString();
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0 || src.slice(i + 1, end).includes("\n")) throw tomlError(lineNo, "neukončený řetězec");
        const out = src.slice(i + 1, end);
        i = end + 1;
        return out;
      }
      if (c === "[") {
        i++;
        const arr = [];
        ws();
        while (src[i] !== "]") {
          if (i >= src.length) throw tomlError(lineNo, "neukončené pole");
          arr.push(value());
          ws();
          if (src[i] === ",") {
            i++;
            ws();
          } else if (src[i] !== "]") throw tomlError(lineNo, "v poli chybí čárka");
        }
        i++;
        return arr;
      }
      const m = /^[^\s,\]#]+/.exec(src.slice(i));
      if (!m) throw tomlError(lineNo, "chybí hodnota");
      const tok = m[0];
      i += tok.length;
      if (tok === "true") return true;
      if (tok === "false") return false;
      if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(tok)) return tok;
      if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok.replace(/_/g, ""));
      throw tomlError(lineNo, `neznámá hodnota „${tok}“`);
    };
    const v = value();
    ws();
    if (i < src.length) throw tomlError(lineNo, "nečekaný text za hodnotou");
    return v;
  }

  function bracketDepth(text) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote || c === "\n") quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "#") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "[") depth++;
      else if (c === "]") depth--;
    }
    return depth;
  }

  function parseToml(text) {
    const root = {};
    let target = root;
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      const lineNo = n + 1;
      const line = lines[n].trim();
      if (!line || line.startsWith("#")) continue;
      const arrTable = /^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]\s*(#.*)?$/.exec(line);
      if (arrTable) {
        const name = arrTable[1];
        if (root[name] !== undefined && !Array.isArray(root[name])) throw tomlError(lineNo, `klíč ${name} už existuje`);
        root[name] = root[name] || [];
        target = {};
        root[name].push(target);
        continue;
      }
      const table = /^\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$/.exec(line);
      if (table) {
        if (root[table[1]] !== undefined) throw tomlError(lineNo, `klíč ${table[1]} už existuje`);
        target = root[table[1]] = {};
        continue;
      }
      const kv = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
      if (!kv) throw tomlError(lineNo, "očekávám klíč = hodnota");
      const key = kv[1].startsWith('"') ? JSON.parse(kv[1]) : kv[1];
      let valueSrc = kv[2];
      while (bracketDepth(valueSrc) > 0 && n + 1 < lines.length) valueSrc += `\n${lines[++n]}`;
      if (Object.prototype.hasOwnProperty.call(target, key)) throw tomlError(lineNo, `klíč ${key} je uveden dvakrát`);
      target[key] = parseTomlValue(valueSrc, lineNo);
    }
    return root;
  }

  const IMPORT_FIELDS = Object.freeze([
    ["project", "project"],
    ["artifact", "artifact"],
    ["valid_to", "validTo"],
    ["blocked", "blocked"],
    ["note", "note"],
    ["requires_approval", "requiresApproval"],
    ["approvers", "approvers"],
    ["allowed_users", "allowedUsers"],
  ]);

  function mappingFromToml(doc) {
    if (!doc || doc.schema_version !== 1) throw new Error(`Nepodporovaná schema_version ${doc && doc.schema_version} (umím 1)`);
    if (!Array.isArray(doc.mapping)) throw new Error("Soubor neobsahuje žádné [[mapping]]");
    const entries = {};
    const skipped = [];
    for (const m of doc.mapping) {
      const label = String(m.label || "").trim();
      if (!/^W_/.test(label)) {
        skipped.push({ label, reason: "label nezačíná W_" });
        continue;
      }
      const url = normalizeSubjectUrl(m.subject_url);
      if (!url) {
        skipped.push({ label, reason: "chybí subject_url" });
        continue;
      }
      const entry = { url };
      for (const [from, to] of IMPORT_FIELDS) {
        if (m[from] !== undefined && m[from] !== false && m[from] !== "") entry[to] = m[from];
      }
      entry.fromFile = true;
      entries[label] = entry;
    }
    return { entries, skipped, meta: { revision: doc.revision ?? null, updatedAt: doc.updated_at ?? null, updatedBy: doc.updated_by ?? null } };
  }

  function sameEntry(a, b) {
    const strip = (e) => JSON.stringify(Object.entries(e || {}).filter(([k]) => k !== "fromFile").sort(([x], [y]) => x.localeCompare(y)));
    return strip(a) === strip(b);
  }

  function planMappingImport(current, entries) {
    const existing = normalizeMapping(current);
    const added = [];
    const changed = [];
    const same = [];
    const notInFile = [];
    const merged = {};
    for (const [label, value] of Object.entries(existing)) {
      if (entries[label]) continue;
      notInFile.push(label);
      merged[label] = { ...value, fromFile: false };
    }
    for (const [label, entry] of Object.entries(entries)) {
      if (!existing[label]) added.push(label);
      else if (sameEntry(existing[label], entry)) same.push(label);
      else changed.push(label);
      merged[label] = entry;
    }
    const sorted = {};
    for (const label of Object.keys(merged).sort()) sorted[label] = merged[label];
    return { added: added.sort(), changed: changed.sort(), same: same.sort(), notInFile: notInFile.sort(), merged: sorted };
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
    return { id: item.id, ...buildCreateDtoIn(worklog, subject || item.subject), highRate: item.highRate === true };
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

  function planDayActions({ result, dayItems, mapping, choices, today }) {
    if (!result) return [];
    const actions = [];
    for (const w of result.missing) {
      const resolved = resolveSubject(w.labels, mapping);
      const subject = choices[w.worklogId] || resolved.subject;
      const ruleLabel = choices[w.worklogId] ? mappingLabelForUrl(mapping, subject) : resolved.label;
      const blocked = !subject
        ? `Neznámý artefakt${resolved.label ? ` pro ${resolved.label}` : ""} – vyber ho`
        : labelRuleBlock(ruleLabel, mapping[ruleLabel], w.date) || checkWtmRules(w, dayItems, today);
      actions.push({ type: "create", worklog: w, subject, label: resolved.label, blocked });
    }
    for (const p of result.diff) {
      const blocked = p.item.state !== "active" ? "Položka je potvrzená" : checkWtmRules(p.worklog, dayItems, today, p.item.id);
      actions.push({ type: "update", worklog: p.worklog, item: p.item, subject: null, blocked });
    }
    return actions.sort((a, b) => a.worklog.from.localeCompare(b.worklog.from));
  }

  function isOwnMonthlyPage(pathname, search) {
    if (!String(pathname).endsWith("/workerMonthlyDetail")) return false;
    return [...new URLSearchParams(search).keys()].every((k) => k === "yearMonth");
  }

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

  // Page-side changes (delete/create/update) do not reload the month list; the agent refetches it.
  function isTimesheetMutation(url) {
    return /\/(?!list|get)[a-z]+TimesheetItems?(\?|$)/.test(String(url));
  }

  function pageAgent(extractMonthResponse, isTimesheetMutation, MSG, nonce) {
    if (window[MSG.agentFlag]) return;
    window[MSG.agentFlag] = true;
    const isWtm = (url) => /\/uu-specialistwtm-maing01\//.test(url);
    let lastAuth = null;
    let lastMonth = null;
    let refreshTimer = null;
    const post = (type, payload) => window.postMessage({ source: MSG.fromAgent, nonce, type, payload }, location.origin);
    const isMonthUrl = (url) => /\/listWorkerTimesheetItemsByMonth(\?|$)/.test(url);
    const rememberMonth = (url, body) => {
      if (isMonthUrl(url) && typeof body === "string") lastMonth = { url, body };
    };
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        if (!lastAuth || !lastMonth) return;
        try {
          const res = await origFetch.call(window, lastMonth.url, {
            method: "POST",
            headers: { Authorization: lastAuth, "Content-Type": "application/json", Accept: "application/json" },
            body: lastMonth.body,
          });
          const m = extractMonthResponse(lastMonth.url, await res.text());
          if (m) post("month", m);
        } catch (e) {
          /* the next page action retries */
        }
      }, 300);
    };
    const rememberAuth = (value) => {
      if (!value || value === lastAuth) return;
      lastAuth = value;
      post("auth", true);
    };

    const origFetch = window.fetch;
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
      XHR.send = function (body) {
        const url = this.__gmWjsUrl || "";
        rememberMonth(url, body);
        this.addEventListener("load", () => {
          try {
            const m = extractMonthResponse(url, this.responseText);
            if (m) post("month", m);
            else if (isWtm(url) && isTimesheetMutation(url) && this.status >= 200 && this.status < 300) scheduleRefresh();
          } catch (e) {
            /* foreign response */
          }
        });
        return send.apply(this, arguments);
      };
    }

    if (origFetch) {
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const headers = (init && init.headers) || (input && input.headers);
        if (headers && isWtm(url)) {
          rememberAuth(typeof headers.get === "function" ? headers.get("Authorization") : headers.Authorization || headers.authorization);
        }
        if (isWtm(url)) rememberMonth(url, init && init.body);
        const promise = origFetch.apply(this, arguments);
        if (isWtm(url) && isTimesheetMutation(url)) {
          promise.then((res) => res.ok && scheduleRefresh()).catch(() => {});
        }
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
      // Identity checks on event.source fail across the Tampermonkey sandbox; trust origin + session nonce instead.
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.source !== MSG.toAgent || data.nonce !== nonce || data.type !== "wtm-call") return;
      const reply = (body) => window.postMessage({ source: MSG.fromAgent, nonce, type: "wtm-result", payload: Object.assign({ id: data.id }, body) }, location.origin);
      if (data.cmd !== "createTimesheetItem" && data.cmd !== "updateTimesheetItem") {
        reply({ ok: false, error: "Nepovolený příkaz" });
        return;
      }
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

  function buildAgentSource(nonce) {
    return `(${pageAgent.toString()})(${extractMonthResponse.toString()}, ${isTimesheetMutation.toString()}, ${JSON.stringify(MSG)}, ${JSON.stringify(String(nonce))});`;
  }

  const CALL_TIMEOUT_MS = 20000;

  // In Tampermonkey `win` is a sandbox proxy, so event.source never equals it; check origin + session nonce.
  function createAgentClient(win, handlers, nonce) {
    const pending = new Map();
    let seq = 0;
    const origin = win.location && win.location.origin;
    win.addEventListener("message", (event) => {
      if (origin && event.origin !== origin) return;
      const d = event.data;
      if (!d || d.source !== MSG.fromAgent || d.nonce !== nonce) return;
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
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ id, ok: false, error: "WTM neodpovědělo (timeout)", timeout: true });
          }, CALL_TIMEOUT_MS);
          pending.set(id, (payload) => {
            clearTimeout(timer);
            resolve(payload);
          });
          win.postMessage({ source: MSG.toAgent, nonce, type: "wtm-call", id, cmd, dtoIn }, origin || "*");
        });
      },
    };
  }

  // --- PURE: jira ---

  const WORKLOG_CONCURRENCY = 4;

  async function fetchJiraMonth(range, request, onProgress) {
    const progress = typeof onProgress === "function" ? onProgress : () => {};
    progress({ phase: "search", done: 0, total: null });
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
    let done = 0;
    progress({ phase: "worklogs", done, total: issues.length });
    const queue = [...issues];
    const worker = async () => {
      for (let issue = queue.shift(); issue; issue = queue.shift()) {
        const res = await request(`/rest/api/2/issue/${issue.key}/worklog?maxResults=1000`);
        worklogsByKey[issue.key] = res.worklogs || [];
        progress({ phase: "worklogs", done: ++done, total: issues.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKLOG_CONCURRENCY, issues.length) }, worker));
    return normalizeJiraWorklogs({ issues, worklogsByKey, meName: me.name, range });
  }

  // --- PURE: jira cache ---

  function putJiraCache(cache, yearMonth, worklogs, at, keep = 3) {
    const out = { ...(cache || {}), [yearMonth]: { at, worklogs } };
    for (const ym of Object.keys(out).sort().reverse().slice(keep)) delete out[ym];
    return out;
  }

  function staleReason(jira) {
    if (!jira || !jira.cachedAt) return null;
    if (jira.refreshError) return "Jira je nedostupná – zobrazená data jsou z mezipaměti, zápis je vypnutý";
    return "Data z Jiry se načítají – zápis bude možný po aktualizaci";
  }

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

  // --- BROWSER ---

  // --- BROWSER: agent ---

  function injectAgent(nonce) {
    const script = document.createElement("script");
    script.textContent = buildAgentSource(nonce);
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // --- BROWSER: settings & transport ---

  const SETTINGS_KEY = "gm-wjs-settings";
  const DEFAULT_SETTINGS = Object.freeze({ jiraBaseUrl: "http://jira.indsoft.local", mapping: { ...DEFAULT_MAPPING }, mappingSource: null });

  function storageGet(key = SETTINGS_KEY) {
    if (typeof GM_getValue === "function") return GM_getValue(key, null);
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    if (typeof GM_setValue === "function") GM_setValue(key, value);
    else localStorage.setItem(key, JSON.stringify(value));
  }

  const JIRA_CACHE_KEY = "gm-wjs-jira-cache";

  function loadSettings() {
    const stored = storageGet() || {};
    return {
      jiraBaseUrl: stored.jiraBaseUrl || DEFAULT_SETTINGS.jiraBaseUrl,
      mapping: normalizeMapping({ ...DEFAULT_SETTINGS.mapping, ...(stored.mapping || {}) }),
      mappingSource: stored.mappingSource || null,
    };
  }

  function saveSettings(settings) {
    storageSet(SETTINGS_KEY, settings);
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

  // --- BROWSER: render ---

  // Tokens follow uu5g04 (Material palette) as used by the WTM page itself.
  const STYLE_ID = "gm-wjs-style";
  const CSS = `
    :root{--gm-wjs-font:Roboto,ClearSans,sans-serif;--gm-wjs-text:rgba(0,0,0,.87);--gm-wjs-text2:rgba(0,0,0,.54);--gm-wjs-strong:#212121;
      --gm-wjs-primary:#2196F3;--gm-wjs-primary-dark:#1976D2;--gm-wjs-primary-bg:#E3F2FD;
      --gm-wjs-success:#4CAF50;--gm-wjs-success-dark:#388E3C;--gm-wjs-success-bg:#E8F5E9;
      --gm-wjs-warning:#FF9800;--gm-wjs-warning-dark:#EF6C00;--gm-wjs-warning-bg:#FFF3E0;
      --gm-wjs-danger:#F44336;--gm-wjs-danger-dark:#D32F2F;--gm-wjs-danger-bg:#FFEBEE;
      --gm-wjs-grey:#9E9E9E;--gm-wjs-border:#E0E0E0;--gm-wjs-border2:#BDBDBD;--gm-wjs-surface:#FAFAFA;
      --gm-wjs-shadow:0 2px 10px 0 rgba(0,0,0,.16),0 2px 5px 0 rgba(0,0,0,.26)}
    .gm-wjs,#gm-wjs-panel,#gm-wjs-settings,#gm-wjs-toast{font-family:var(--gm-wjs-font);color:var(--gm-wjs-text);box-sizing:border-box}
    #gm-wjs-panel *,#gm-wjs-settings *,#gm-wjs-toast *{box-sizing:border-box}
    .gm-wjs a,#gm-wjs-panel a,#gm-wjs-settings a{color:var(--gm-wjs-primary-dark);text-decoration:none}
    .gm-wjs a:hover,#gm-wjs-panel a:hover,#gm-wjs-settings a:hover{text-decoration:underline}

    .gm-wjs-badge{display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:0 8px;height:24px;border-radius:2px;font-size:12px;font-weight:700;line-height:24px;color:#fff;vertical-align:middle;white-space:nowrap}
    .gm-wjs-badge a,.gm-wjs-badge a:hover{color:inherit}
    .gm-wjs-ok{background:var(--gm-wjs-success)}
    .gm-wjs-diff{background:var(--gm-wjs-warning)}
    .gm-wjs-extra{background:var(--gm-wjs-danger)}
    .gm-wjs-missing{background:var(--gm-wjs-primary)}
    .gm-wjs-muted{background:var(--gm-wjs-grey)}
    .gm-wjs-chip{display:inline-block;margin:0 4px 0 0;padding:1px 6px 2px;border-radius:3px;font-size:12px;line-height:16px;white-space:nowrap}
    .gm-wjs-chip-warning{background:var(--gm-wjs-warning-bg);color:var(--gm-wjs-warning-dark)}
    .gm-wjs-chip-danger{background:var(--gm-wjs-danger-bg);color:var(--gm-wjs-danger-dark)}
    .gm-wjs-chip-muted{background:#EEEEEE;color:var(--gm-wjs-text2)}
    .gm-wjs-chip-info{background:var(--gm-wjs-primary-bg);color:var(--gm-wjs-primary-dark)}
    .gm-wjs-note{display:block;margin-top:4px;font-size:13px;line-height:19.5px;color:var(--gm-wjs-warning-dark)}

    .gm-wjs-btn{display:inline-flex;align-items:center;justify-content:center;height:24px;margin-left:8px;padding:0 8px;border:0;border-radius:2px;background:#E0E0E0;color:var(--gm-wjs-text);font:400 12px/1 var(--gm-wjs-font);vertical-align:middle;cursor:pointer;transition:background-color .15s}
    .gm-wjs-btn:hover{background:#BDBDBD}
    .gm-wjs-btn-primary{background:var(--gm-wjs-primary);color:#fff}
    .gm-wjs-btn-primary:hover{background:var(--gm-wjs-primary-dark)}
    .gm-wjs-btn-m{height:32px;padding:0 16px;font-size:14px}
    .gm-wjs-btn-flat{background:transparent;color:var(--gm-wjs-primary-dark)}
    .gm-wjs-btn-flat:hover{background:var(--gm-wjs-primary-bg)}
    .gm-wjs-btn[disabled]{background:#EEEEEE;color:rgba(0,0,0,.38);cursor:not-allowed}

    .gm-wjs-row{margin:8px 0;padding:16px;border:1px dashed var(--gm-wjs-primary);border-radius:4px;background:repeating-linear-gradient(135deg,#F5FAFF 0 8px,#fff 8px 16px);font-size:14px;line-height:21px}
    .gm-wjs-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:0 8px}
    .gm-wjs-row .gm-wjs-time{font-size:18px;font-weight:700;line-height:27px;color:var(--gm-wjs-strong)}
    .gm-wjs-row .gm-wjs-dur{color:var(--gm-wjs-text2)}
    .gm-wjs-row .gm-wjs-badge{margin-left:0}
    .gm-wjs-row-desc{margin-top:4px}
    .gm-wjs-row-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
    .gm-wjs-row-foot .gm-wjs-btn{margin-left:auto}
    .gm-wjs-subject{font-size:13px;font-weight:700;line-height:19.5px;color:var(--gm-wjs-primary)}
    .gm-wjs-msg{display:block;margin-top:8px;font-size:13px;color:var(--gm-wjs-danger-dark)}
    .gm-wjs-select,.gm-wjs-input{height:32px;padding:0 8px;border:1px solid var(--gm-wjs-border2);border-radius:2px;background:#fff;color:var(--gm-wjs-text);font:14px var(--gm-wjs-font);transition:border-color .15s}
    .gm-wjs-select:focus,.gm-wjs-input:focus{border-color:var(--gm-wjs-primary);outline:0}
    .gm-wjs-day{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;margin-left:16px;font-size:13px;line-height:21px;color:var(--gm-wjs-text2)}
    .gm-wjs-vday{margin:8px;padding:16px;border:1px dashed var(--gm-wjs-primary);border-radius:4px;background:var(--gm-wjs-surface)}
    .gm-wjs-vday-title{font-size:14px;font-weight:700}

    #gm-wjs-panel{display:flex;align-items:center;flex-wrap:wrap;gap:4px 16px;flex:1;min-width:0;margin-left:24px;font-size:13px;line-height:21px;color:var(--gm-wjs-text2)}
    .gm-wjs-panel-title{font-size:14px;font-weight:700;color:var(--gm-wjs-text);white-space:nowrap}
    .gm-wjs-panel-title small{font-size:12px;font-weight:400;color:var(--gm-wjs-text2)}
    .gm-wjs-panel-status,.gm-wjs-panel-info{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px 8px}
    .gm-wjs-panel-status .gm-wjs-badge{margin:0}
    .gm-wjs-panel-actions{display:inline-flex;gap:8px;margin-left:auto}
    .gm-wjs-panel-actions .gm-wjs-btn{margin:0}
    .gm-wjs-spinner{display:inline-block;width:20px;height:20px;border:2px solid var(--gm-wjs-primary-bg);border-top-color:var(--gm-wjs-primary);border-radius:50%;animation:gm-wjs-spin .8s linear infinite;flex:none}
    .gm-wjs-spinner-s{width:14px;height:14px}
    @keyframes gm-wjs-spin{to{transform:rotate(360deg)}}
    .gm-wjs-text2{color:var(--gm-wjs-text2);font-size:13px}
    .gm-wjs-warn{color:var(--gm-wjs-warning-dark);font-size:13px}
    .gm-wjs-err{color:var(--gm-wjs-danger-dark)}

    #gm-wjs-settings{position:fixed;inset:0;z-index:100000;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;background:rgba(0,0,0,.24);overflow:auto;font-size:14px;line-height:21px}
    .gm-wjs-modal{display:flex;flex-direction:column;width:1100px;max-width:100%;max-height:calc(100vh - 64px);background:#fff;border-radius:2px;box-shadow:0 4px 20px 6px rgba(0,0,0,.2)}
    .gm-wjs-modal-head{display:flex;align-items:center;justify-content:space-between;min-height:48px;padding:8px 16px;font-size:1.3em}
    .gm-wjs-modal-close{display:flex;align-items:center;justify-content:center;width:32px;height:32px;margin-right:-8px;border:0;background:none;color:var(--gm-wjs-text2);font-size:20px;cursor:pointer}
    .gm-wjs-modal-body{padding:8px 16px 16px;overflow:auto;border-top:1px solid var(--gm-wjs-border);border-bottom:1px solid var(--gm-wjs-border)}
    .gm-wjs-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:8px 16px}
    .gm-wjs-modal-foot .gm-wjs-btn{margin:0}
    .gm-wjs-field{display:flex;align-items:center;gap:16px;margin:8px 0 16px}
    .gm-wjs-field>span{min-width:48px;color:var(--gm-wjs-text2)}
    .gm-wjs-field .gm-wjs-input{flex:1}
    .gm-wjs-section{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0}
    .gm-wjs-section h4{margin:0 auto 0 0;font-size:16px;font-weight:700}
    .gm-wjs-section .gm-wjs-btn{margin:0}
    .gm-wjs-alert{margin:8px 0;padding:12px 16px;border-radius:4px;border-left:4px solid var(--gm-wjs-primary);background:var(--gm-wjs-primary-bg)}
    .gm-wjs-alert-success{border-left-color:var(--gm-wjs-success);background:var(--gm-wjs-success-bg)}
    .gm-wjs-alert-danger{border-left-color:var(--gm-wjs-danger);background:var(--gm-wjs-danger-bg)}
    .gm-wjs-alert div+div{margin-top:2px}
    .gm-wjs-table{width:100%;border-collapse:collapse}
    .gm-wjs-table th{padding:8px;border-bottom:1px solid var(--gm-wjs-border2);color:var(--gm-wjs-text2);font-size:13px;font-weight:700;text-align:left}
    .gm-wjs-table td{padding:4px 8px;border-bottom:1px solid var(--gm-wjs-border);vertical-align:middle}
    .gm-wjs-table td .gm-wjs-input{width:100%}
    .gm-wjs-table td.gm-wjs-info{font-size:13px;line-height:19.5px;color:var(--gm-wjs-text2)}
    .gm-wjs-table td.gm-wjs-info div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}

    #gm-wjs-toast{position:fixed;right:16px;bottom:16px;z-index:100001;display:flex;align-items:center;gap:16px;max-width:480px;padding:15px 16px;border-left:4px solid var(--gm-wjs-primary);border-radius:4px;background:#fff;box-shadow:0 4px 7px 0 rgba(0,0,0,.2);font-size:14px;line-height:21px}
    #gm-wjs-toast.gm-wjs-toast-success{border-left-color:var(--gm-wjs-success)}
    #gm-wjs-toast.gm-wjs-toast-warning{border-left-color:var(--gm-wjs-warning)}
    #gm-wjs-toast.gm-wjs-toast-danger{border-left-color:var(--gm-wjs-danger)}
    #gm-wjs-toast .gm-wjs-btn{margin:0;flex:none}
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) || !document.head) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // Plain element builder; panel, settings and toast use it because render() wipes every OWN_CLASS node.
  function make(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children ?? [])) {
      if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function h(tag, attrs, children) {
    const el = make(tag, attrs, children);
    el.classList.add(OWN_CLASS);
    return el;
  }

  function jiraLink(key) {
    return h("a", { href: `${state.settings.jiraBaseUrl}/browse/${key}`, target: "_blank", rel: "noopener" }, key);
  }

  const state = {
    items: [],
    worklogs: [],
    results: {},
    settings: null,
    jira: { status: "idle", error: null },
    wtmAuth: false,
    foreign: false,
    missingDays: "",
    busy: false,
    choices: {},
    messages: {},
  };

  function rowActionsFor(date) {
    const actions = planDayActions({
      result: state.results[date],
      dayItems: state.items.filter((i) => i.date === date),
      mapping: state.settings.mapping,
      choices: state.choices,
      today: todayPrague(),
    });
    const stale = staleReason(state.jira);
    return stale ? actions.map((a) => ({ ...a, blocked: a.blocked || stale })) : actions;
  }

  function minutesSum(list) {
    return list.reduce((s, x) => s + durationMinutes(x.from, x.to), 0);
  }

  function artifactCaption(label, entry) {
    return entry && entry.artifact ? `${label} – ${entry.artifact}` : label;
  }

  function renderVirtualRow(action) {
    const w = action.worklog;
    const rowId = `w${w.worklogId}`;
    const mapping = state.settings.mapping;
    const foot = [];
    if (!action.subject) {
      foot.push(h("select", { class: "gm-wjs-select", "aria-label": "Artefakt", onchange: (e) => { state.choices[w.worklogId] = e.target.value; render(); } }, [
        h("option", { value: "" }, "— vyber artefakt —"),
        ...Object.keys(mapping).sort().map((label) => h("option", { value: entryUrl(mapping[label]) }, artifactCaption(label, mapping[label]))),
      ]));
    } else {
      const label = mappingLabelForUrl(mapping, action.subject) || action.label || "";
      const entry = mapping[label];
      foot.push(h("span", { class: "gm-wjs-subject", title: (entry && entry.note) || null }, label));
      if (entry && entry.artifact) foot.push(h("span", { class: "gm-wjs-text2" }, entry.artifact));
    }
    foot.push(h("button", { class: "gm-wjs-btn gm-wjs-btn-m gm-wjs-btn-primary", disabled: state.busy || Boolean(action.blocked), title: action.blocked || "", onclick: () => onAction(action) }, "Zapsat do WTM"));
    const msg = state.messages[rowId] || action.blocked;
    return h("div", { class: "gm-wjs-row", "data-from": w.from }, [
      h("div", { class: "gm-wjs-row-head" }, [
        h("span", { class: "gm-wjs-time" }, `${w.from} - ${w.to}`),
        h("span", { class: "gm-wjs-dur" }, formatMinutes(durationMinutes(w.from, w.to))),
        h("span", { class: "gm-wjs-badge gm-wjs-missing" }, "chybí ve WTM"),
      ]),
      h("div", { class: "gm-wjs-row-desc" }, [jiraLink(w.key), ` ${w.comment || ""}`]),
      h("div", { class: "gm-wjs-row-foot" }, foot),
      msg ? h("span", { class: "gm-wjs-msg" }, msg) : null,
    ]);
  }

  function decorateCard(card, pairOrItem, kind, action) {
    const anchor = card.timeEl;
    if (kind === "ok") {
      const loose = pairOrItem.loose === true;
      const title = loose ? "Spárováno podle dne a labelu – položka ve WTM nemá klíč ticketu" : "Sedí s Jirou";
      anchor.after(h("span", { class: "gm-wjs-badge gm-wjs-ok", title }, [loose ? "≈ " : "✓ ", jiraLink(pairOrItem.worklog.key)]));
    } else if (kind === "extra") {
      anchor.after(h("span", { class: "gm-wjs-badge gm-wjs-extra" }, "není v Jiře"));
    } else if (kind === "diff") {
      const w = pairOrItem.worklog;
      const badge = h("span", { class: "gm-wjs-badge gm-wjs-diff", title: pairOrItem.loose ? "Spárováno podle dne a labelu – položka ve WTM nemá klíč ticketu" : "Liší se od Jiry" }, ["≠ ", jiraLink(w.key)]);
      const btn = h("button", { class: "gm-wjs-btn gm-wjs-btn-primary", disabled: state.busy || Boolean(action && action.blocked), title: (action && action.blocked) || "", onclick: () => onAction(action) }, "Upravit podle Jiry");
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
    if (runnable.length) summary.append(h("button", { class: "gm-wjs-btn gm-wjs-btn-primary", disabled: state.busy, onclick: () => onDayAll(date) }, `Zapsat vše (${runnable.length})`));
    headerEl.append(summary);
  }

  // The SPA keeps this script alive across routes; act only on the own monthly page (not the yearly overview etc.).
  function isActivePage() {
    return isOwnMonthlyPage(location.pathname, location.search);
  }

  function render() {
    if (!document.body) return;
    for (const el of document.querySelectorAll(`.${OWN_CLASS}`)) el.remove();
    if (!isActivePage() || state.foreign || state.jira.status !== "ok" || !state.settings) return;
    ensureStyle();
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
    const emptyBlocks = [];
    const hasItems = (d) => state.items.some((i) => i.date === d);
    const notFound = Object.keys(state.results).filter((d) => !known.has(d) && hasItems(d)).sort();
    const notFoundText = notFound.join(",");
    if (notFoundText !== state.missingDays) {
      state.missingDays = notFoundText;
      renderPanel();
    }
    for (const date of Object.keys(state.results).filter((d) => !known.has(d) && !hasItems(d) && state.results[d].missing.length)) {
      const actions = rowActionsFor(date).filter((a) => a.type === "create");
      const block = h("div", { class: "gm-wjs-vday" }, [h("div", { class: "gm-wjs-vday-title" }, `${formatCzDate(date)} – v Jiře, ve WTM nic`)]);
      for (const action of actions) block.append(renderVirtualRow(action));
      const after = sections.find((s) => s.date < date);
      if (after) after.sectionEl.before(block);
      else if (sections.length) sections[sections.length - 1].sectionEl.after(block);
      else emptyBlocks.push({ date, block });
    }
    if (emptyBlocks.length) {
      const button = [...document.querySelectorAll("button")].find((b) => /Vytvořit položku výkazu|Create timesheet item/.test(b.textContent));
      let cursor = button && button.parentElement;
      for (const { block } of emptyBlocks.sort((a, b) => b.date.localeCompare(a.date))) {
        if (cursor) {
          cursor.after(block);
          cursor = block;
        } else document.body.append(block);
      }
    }
  }

  // --- BROWSER: actions ---

  function actionKey(action) {
    return action.type === "update" ? `i${action.item.id}` : `w${action.worklog.worklogId}`;
  }

  async function executeActions(actions) {
    const result = { done: 0, failed: [], timedOut: false };
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
        if (res.timeout) result.timedOut = true;
        state.messages[actionKey(action)] = res.error;
        result.failed.push({ action, error: res.error });
      }
    }
    return result;
  }

  async function runBatch(actions) {
    if (state.busy || !actions.length) return;
    if (!state.wtmAuth) {
      toast("WTM zatím neposlalo přihlášení – obnov stránku a zkus to znovu.", true, "warning");
      return;
    }
    state.busy = true;
    render();
    // After a late success or a partial write the page data is stale: stay busy until the user reloads.
    let keepBusy = false;
    try {
      const result = await executeActions(actions);
      if (result.timedOut) {
        keepBusy = true;
        toast("WTM neodpovědělo – načti stránku znovu a zkontroluj stav.", true, "warning");
      } else if (result.done && !result.failed.length) {
        keepBusy = true;
        toast(`Zapsáno ${result.done}. Načítám stránku znovu…`, false, "success");
        setTimeout(() => location.reload(), 1500);
      } else if (result.done) {
        keepBusy = true;
        toast(`Zapsáno ${result.done}, ${result.failed.length} selhalo: ${result.failed.map((f) => f.error).join("; ")}`, true, "warning");
      } else {
        toast(`Nic se nezapsalo: ${result.failed.map((f) => f.error).join("; ")}`, false, "danger");
      }
    } finally {
      state.busy = keepBusy;
      render();
    }
  }

  function onAction(action) {
    runBatch([action]);
  }

  function onDayAll(date) {
    runBatch(rowActionsFor(date).filter((a) => !a.blocked));
  }

  // Not an OWN_CLASS element: render() wipes those, and the toast must survive it.
  function toast(text, withReload, kind) {
    ensureStyle();
    const old = document.getElementById("gm-wjs-toast");
    if (old) old.remove();
    const el = make("div", { id: "gm-wjs-toast", role: "status", class: `gm-wjs-toast-${kind || "info"}` }, make("span", {}, text));
    if (withReload) el.append(make("button", { class: "gm-wjs-btn gm-wjs-btn-m gm-wjs-btn-primary", onclick: () => location.reload() }, "Načíst znovu"));
    document.body.append(el);
    setTimeout(() => el.remove(), 8000);
  }

  function recompute() {
    state.results = matchMonth(state.worklogs, state.items, state.settings && state.settings.mapping);
    render();
  }

  // --- BROWSER: panel ---

  const PANEL_ID = "gm-wjs-panel";
  const SETTINGS_ID = "gm-wjs-settings";
  const MAPPINGS_HINT = "d:\\Documents\\WTM\\mappings.toml";

  function monthTotals() {
    const all = Object.values(state.results);
    const count = (k) => all.reduce((s, r) => s + r[k].length, 0);
    return { ok: count("ok"), diff: count("diff"), missing: count("missing"), extra: count("extra") };
  }

  const PANEL_ANCHOR = ".uu-specialistwtm-worker-monthly-detail-top-photo-row";

  function progressText(progress) {
    if (!progress || progress.phase === "search") return "hledám tickety s worklogy…";
    return `načítám worklogy ${progress.done}/${progress.total}`;
  }

  // Zero counts are grey so the non-zero ones stand out.
  function countBadge(count, colorClass, title, text) {
    return make("span", { class: `gm-wjs-badge ${count ? colorClass : "gm-wjs-muted"}`, title }, text);
  }

  function loginLink() {
    return make("a", { href: `${state.settings.jiraBaseUrl}/login.jsp`, target: "_blank", rel: "noopener" }, "Přihlásit do Jiry");
  }

  // Inline bar in the page header (next to the worker name), styled like the page itself.
  function renderPanel() {
    if (!document.body) return;
    const anchor = isActivePage() ? document.querySelector(PANEL_ANCHOR) : null;
    let panel = document.getElementById(PANEL_ID);
    if (!anchor) {
      if (panel) panel.remove();
      return;
    }
    ensureStyle();
    if (!panel) panel = make("div", { id: PANEL_ID, role: "status" });
    if (panel.parentElement !== anchor) anchor.append(panel);
    const spinner = (small) => make("span", { class: `gm-wjs-spinner${small ? " gm-wjs-spinner-s" : ""}`, "aria-hidden": "true" });
    const status = [];
    const jira = state.jira;
    if (state.foreign) status.push(make("span", {}, "Cizí výkaz – skript je neaktivní"));
    else if (jira.status === "loading") status.push(spinner(), make("span", {}, `Jira: ${progressText(jira.progress)}`));
    else if (jira.status === "error") status.push(make("span", { class: "gm-wjs-err" }, [`Jira: ${jira.error}`, ...(jira.unauthorized ? [" · ", loginLink()] : [])]));
    else if (jira.status === "ok") {
      const t = monthTotals();
      status.push(
        countBadge(t.ok, "gm-wjs-ok", "Sedí s Jirou", `✓ ${t.ok}`),
        countBadge(t.diff, "gm-wjs-diff", "Liší se od Jiry", `≠ ${t.diff}`),
        countBadge(t.missing, "gm-wjs-missing", "Chybí ve WTM", `chybí ${t.missing}`),
        countBadge(t.extra, "gm-wjs-extra", "Ve WTM navíc, není v Jiře", `navíc ${t.extra}`),
      );
      if (jira.refreshing) status.push(spinner(true), make("span", {}, `aktualizuji z Jiry – ${progressText(jira.progress)}`));
      else if (jira.refreshError) status.push(make("span", { class: "gm-wjs-warn" }, [`Jira nedostupná, data z ${formatCzDateTime(jira.cachedAt)}`, ...(jira.unauthorized ? [" · ", loginLink()] : [])]));
    } else status.push(make("span", {}, "Čekám na data WTM…"));
    const info = [];
    if (state.settings) {
      const src = state.settings.mappingSource;
      info.push(make("span", { title: `Mapování: ${mappingSourceText(src)}` }, `Mapování: ${labelCount(Object.keys(state.settings.mapping).length)}${src && src.revision !== null && src.revision !== undefined ? ` (rev. ${src.revision})` : ""}`));
    }
    for (const d of state.missingDays ? state.missingDays.split(",") : []) info.push(make("span", { class: "gm-wjs-warn" }, `Den ${formatCzDate(d)} nenalezen na stránce`));
    if (!state.wtmAuth && !state.foreign) info.push(make("span", { class: "gm-wjs-warn", title: "Háček ve stránce zatím nezachytil přihlášení WTM." }, "Zápis po obnovení stránky"));
    const busy = jira.status === "loading" || jira.refreshing;
    panel.replaceChildren(
      make("span", { class: "gm-wjs-panel-title" }, ["WTM ← Jira ", make("small", {}, `v${SCRIPT_VERSION}`)]),
      make("span", { class: "gm-wjs-panel-status" }, status),
      make("span", { class: "gm-wjs-panel-info" }, info),
      make("span", { class: "gm-wjs-panel-actions" }, [
        make("button", { class: "gm-wjs-btn gm-wjs-btn-m", onclick: openSettings }, "Nastavení"),
        make("button", { class: "gm-wjs-btn gm-wjs-btn-m", disabled: busy || !currentYearMonth, onclick: () => currentYearMonth && loadJira(currentYearMonth) }, "Obnovit"),
      ]),
    );
  }

  function labelCount(n) {
    return `${n} ${n === 1 ? "label" : n >= 2 && n <= 4 ? "labely" : "labelů"}`;
  }

  function formatCzDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || "");
    const p = toPragueParts(d);
    return `${formatCzDate(p.date)} ${p.hm}`;
  }

  function mappingSourceText(source) {
    if (!source) return "ručně / z WTM";
    const rev = source.revision !== null && source.revision !== undefined ? ` rev. ${source.revision}` : "";
    return `soubor ${source.fileName || ""}${rev}, importováno ${formatCzDateTime(source.importedAt)}`;
  }

  function entryInfo(label, entry, source) {
    const chips = [];
    if (entry.blocked) chips.push(make("span", { class: "gm-wjs-chip gm-wjs-chip-danger" }, "blokováno"));
    if (entry.validTo) {
      const expired = todayPrague() > String(entry.validTo).slice(0, 10);
      chips.push(make("span", { class: `gm-wjs-chip ${expired ? "gm-wjs-chip-danger" : "gm-wjs-chip-warning"}` }, `platí do ${formatCzDate(entry.validTo)}`));
    }
    if (entry.requiresApproval) chips.push(make("span", { class: "gm-wjs-chip gm-wjs-chip-info" }, `se schválením${entry.approvers ? ` (${[].concat(entry.approvers).join(", ")})` : ""}`));
    if (source && entry.fromFile === false) chips.push(make("span", { class: "gm-wjs-chip gm-wjs-chip-muted" }, "není v souboru"));
    const caption = [entry.project, entry.artifact].filter(Boolean).join(" · ");
    const title = [caption, entry.note, entry.allowedUsers ? `jen: ${[].concat(entry.allowedUsers).join(", ")}` : ""].filter(Boolean).join("\n");
    return make("td", { class: "gm-wjs-info", title: title || null }, [caption ? make("div", {}, caption) : null, chips.length ? make("div", {}, chips) : null]);
  }

  function openSettings() {
    if (document.getElementById(SETTINGS_ID)) return;
    ensureStyle();
    const settings = loadSettings();
    settings.mapping = seedMappingFromWtm(state.items, settings.mapping);
    let source = settings.mappingSource || null;
    const rowMeta = new WeakMap();
    const tbody = make("tbody");
    const addRow = (label, entry) => {
      const meta = { ...(entry || {}) };
      const labelInput = make("input", { class: "gm-wjs-input", "aria-label": "Label" });
      const urlInput = make("input", { class: "gm-wjs-input", "aria-label": "URL artefaktu" });
      labelInput.value = label;
      urlInput.value = entryUrl(meta);
      urlInput.title = urlInput.value;
      // Artifact URLs share a long prefix; keep the distinguishing id visible.
      const showEnd = () => { urlInput.scrollLeft = urlInput.scrollWidth; };
      urlInput.addEventListener("blur", showEnd);
      requestAnimationFrame(showEnd);
      const tr = make("tr", {}, [
        make("td", { style: "width:180px" }, labelInput),
        make("td", {}, urlInput),
        entryInfo(label, meta, source),
        make("td", { style: "width:40px" }, make("button", { class: "gm-wjs-btn gm-wjs-btn-flat", title: "Odebrat", onclick: () => tr.remove() }, "✕")),
      ]);
      rowMeta.set(tr, { meta, labelInput, urlInput });
      tbody.append(tr);
      return labelInput;
    };
    const fillRows = (mapping) => {
      tbody.replaceChildren();
      for (const label of Object.keys(mapping).sort()) addRow(label, mapping[label]);
    };
    const collect = () => {
      const mapping = {};
      for (const tr of tbody.querySelectorAll("tr")) {
        const row = rowMeta.get(tr);
        const label = row.labelInput.value.trim();
        const url = normalizeSubjectUrl(row.urlInput.value);
        if (/^W_/.test(label) && url) mapping[label] = { ...row.meta, url };
      }
      return mapping;
    };

    const jiraInput = make("input", { class: "gm-wjs-input", "aria-label": "Jira" });
    jiraInput.value = settings.jiraBaseUrl;
    const sourceLine = make("div", { class: "gm-wjs-text2" });
    const showSource = () => sourceLine.replaceChildren(`Zdroj: ${mappingSourceText(source)}`);
    const report = make("div");
    const fileInput = make("input", { type: "file", accept: ".toml,text/plain", style: "display:none" });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const imported = mappingFromToml(parseToml(await file.text()));
        const plan = planMappingImport(collect(), imported.entries);
        source = { fileName: file.name, ...imported.meta, importedAt: new Date().toISOString() };
        fillRows(plan.merged);
        showSource();
        const list = (title, labels) => (labels.length ? make("div", {}, `${title} (${labels.length}): ${labels.join(", ")}`) : null);
        const m = imported.meta;
        report.replaceChildren(make("div", { class: "gm-wjs-alert gm-wjs-alert-success" }, [
          make("div", {}, make("strong", {}, `Načteno ${file.name}${m.revision !== null ? ` · revize ${m.revision}` : ""}${m.updatedAt ? ` · ${formatCzDateTime(m.updatedAt)}` : ""}${m.updatedBy ? ` (${m.updatedBy})` : ""}`)),
          list("Přidáno", plan.added),
          list("Změněno", plan.changed),
          plan.same.length ? make("div", {}, `Beze změny: ${plan.same.length}`) : null,
          imported.skipped.length ? make("div", {}, `Přeskočeno: ${imported.skipped.map((s) => `${s.label || "?"} (${s.reason})`).join(", ")}`) : null,
          list("Není v souboru – zůstává, můžeš smazat", plan.notInFile),
          make("div", { class: "gm-wjs-text2" }, "Změny se uloží tlačítkem Uložit."),
        ]));
      } catch (e) {
        report.replaceChildren(make("div", { class: "gm-wjs-alert gm-wjs-alert-danger" }, `Import selhal: ${e.message}`));
      }
    });

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    const save = () => {
      state.settings = { jiraBaseUrl: jiraInput.value.trim() || DEFAULT_SETTINGS.jiraBaseUrl, mapping: collect(), mappingSource: source };
      saveSettings(state.settings);
      close();
      renderPanel();
      if (currentYearMonth) loadJira(currentYearMonth);
    };

    const overlay = make("div", { id: SETTINGS_ID, role: "dialog", "aria-modal": "true", "aria-label": "Nastavení WTM ← Jira" }, make("div", { class: "gm-wjs-modal" }, [
      make("div", { class: "gm-wjs-modal-head" }, [make("span", {}, "Nastavení WTM ← Jira"), make("button", { class: "gm-wjs-modal-close", title: "Zavřít", onclick: () => close() }, "✕")]),
      make("div", { class: "gm-wjs-modal-body" }, [
        make("label", { class: "gm-wjs-field" }, [make("span", {}, "Jira"), jiraInput]),
        make("div", { class: "gm-wjs-section" }, [
          make("h4", {}, "Label → artefakt"),
          make("button", { class: "gm-wjs-btn gm-wjs-btn-m", onclick: () => addRow("W_", {}).focus() }, "Přidat řádek"),
          make("button", { class: "gm-wjs-btn gm-wjs-btn-m gm-wjs-btn-primary", title: `Např. ${MAPPINGS_HINT}`, onclick: () => fileInput.click() }, "Importovat ze souboru…"),
          fileInput,
        ]),
        sourceLine,
        make("div", { class: "gm-wjs-text2" }, `Soubor mapování (TOML, schema_version 1), např. ${MAPPINGS_HINT}`),
        report,
        make("table", { class: "gm-wjs-table" }, [
          make("thead", {}, make("tr", {}, [make("th", {}, "Label"), make("th", {}, "URL artefaktu (subject)"), make("th", {}, "Info"), make("th", {}, "")])),
          tbody,
        ]),
      ]),
      make("div", { class: "gm-wjs-modal-foot" }, [
        make("button", { class: "gm-wjs-btn gm-wjs-btn-m gm-wjs-btn-flat", onclick: () => close() }, "Zrušit"),
        make("button", { class: "gm-wjs-btn gm-wjs-btn-m gm-wjs-btn-primary", onclick: save }, "Uložit"),
      ]),
    ]));
    fillRows(settings.mapping);
    showSource();
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
  }

  let jiraSeq = 0;

  async function loadJira(yearMonth) {
    const seq = ++jiraSeq;
    const cached = (storageGet(JIRA_CACHE_KEY) || {})[yearMonth] || null;
    if (cached) {
      state.worklogs = cached.worklogs;
      state.jira = { status: "ok", error: null, cachedAt: cached.at, refreshing: true, progress: null };
      renderPanel();
      recompute();
    } else {
      state.jira = { status: "loading", error: null, progress: null };
      renderPanel();
    }
    const onProgress = (progress) => {
      if (seq !== jiraSeq) return;
      state.jira.progress = progress;
      renderPanel();
    };
    let worklogs = null;
    let error = null;
    try {
      worklogs = await fetchJiraMonth(monthRange(yearMonth), createJiraRequest(state.settings.jiraBaseUrl), onProgress);
    } catch (e) {
      error = e;
    }
    if (seq !== jiraSeq || yearMonth !== currentYearMonth) return;
    if (worklogs) {
      state.worklogs = worklogs;
      state.jira = { status: "ok", error: null };
      try {
        storageSet(JIRA_CACHE_KEY, putJiraCache(storageGet(JIRA_CACHE_KEY), yearMonth, worklogs, new Date().toISOString()));
      } catch (e) {
        /* cache is optional */
      }
    } else if (cached) {
      state.jira = { status: "ok", error: null, cachedAt: cached.at, refreshError: error.message, unauthorized: error.status === 401 };
    } else {
      state.jira = { status: "error", error: error.message, unauthorized: error.status === 401 };
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
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    agent = createAgentClient(window, {
      onMonth: (payload) => {
        if (!isOwnMonthlyPage(location.pathname, location.search)) {
          jiraSeq++;
          currentYearMonth = null;
          Object.assign(state, { foreign: true, items: [], worklogs: [], results: {}, jira: { status: "idle", error: null } });
          render();
          renderPanel();
          return;
        }
        state.foreign = false;
        state.items = normalizeWtmItems(payload.items);
        const seeded = seedMappingFromWtm(state.items, state.settings.mapping);
        if (Object.keys(seeded).length !== Object.keys(state.settings.mapping).length) {
          state.settings.mapping = seeded;
          saveSettings(state.settings);
        }
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
    }, nonce);
    injectAgent(nonce);
    let pending = 0;
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && n.classList && n.classList.contains(OWN_CLASS)))) return;
      if (mutations.every((m) => {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        return el && el.closest && el.closest("#gm-wjs-settings, #gm-wjs-panel");
      })) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        render();
        const panel = document.getElementById(PANEL_ID);
        const anchor = document.querySelector(PANEL_ANCHOR);
        if (panel ? !isActivePage() || panel.parentElement !== anchor : anchor && isActivePage()) renderPanel();
      }, 300);
    });
    const start = () => {
      observer.observe(document.body, { childList: true, subtree: true });
      renderPanel();
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
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
    fetchJiraMonth,
    putJiraCache,
    staleReason,
    parseDayHeaderText,
    parseTimeRangeText,
    matchDay,
    matchMonth,
    DEFAULT_MAPPING,
    normalizeSubjectUrl,
    normalizeMapping,
    seedMappingFromWtm,
    resolveSubject,
    labelRuleBlock,
    parseToml,
    mappingFromToml,
    planMappingImport,
    buildCreateDtoIn,
    buildUpdateDtoIn,
    checkWtmRules,
    planDayActions,
    isOwnMonthlyPage,
    MSG, extractMonthResponse, isTimesheetMutation, pageAgent, buildAgentSource, createAgentClient,
    run,
  };
});
