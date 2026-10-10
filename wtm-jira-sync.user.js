// ==UserScript==
// @name         WTM ← Jira sync
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      0.1.1
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

  const SCRIPT_VERSION = "0.1.1";
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

  function injectAgent() {
    const script = document.createElement("script");
    script.textContent = buildAgentSource();
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

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

  function recompute() {
    state.results = matchMonth(state.worklogs, state.items);
    render();
  }

  // Temporary: replaced by the panel in Task 10.
  function renderPanel() {
    console.info("[wtm-jira-sync] jira", state.jira.status, state.jira.error || "");
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
    parseDayHeaderText,
    parseTimeRangeText,
    matchDay,
    matchMonth,
    DEFAULT_MAPPING,
    seedMappingFromWtm,
    resolveSubject,
    buildCreateDtoIn,
    buildUpdateDtoIn,
    checkWtmRules,
    MSG, extractMonthResponse, buildAgentSource, createAgentClient,
    run,
  };
});
