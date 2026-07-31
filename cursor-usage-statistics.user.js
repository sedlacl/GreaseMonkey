// ==UserScript==
// @name         Cursor Usage Statistics
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.3.2
// @description  Adds daily spend, token charts, and per-model statistics to the Cursor usage dashboard.
// @author       Lukáš Sedláček
// @match        https://cursor.com/dashboard/usage*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/cursor-usage-statistics.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/cursor-usage-statistics.user.js
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "1.3.2";
  const PANEL_ID = "gm-cursor-usage-statistics";
  const STYLE_ID = `${PANEL_ID}-style`;
  const USAGE_ENDPOINT = "/api/dashboard/get-filtered-usage-events";
  const PAGE_SIZE = 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MODEL_COLORS = ["#7c3aed", "#2563eb", "#0891b2", "#16a34a", "#f59e0b"];
  const OTHER_MODEL_COLOR = "#9ca3af";
  const nativeFetch = window.fetch.bind(window);

  let requestContext = null;
  let currentData = null;
  let chartRangeDays = 7;
  let chartMetric = "tokens";
  const hiddenChartModels = new Set();
  let loading = false;
  let reloadTimer = null;

  function isUsageRequest(input) {
    const url = typeof input === "string" ? input : input?.url;
    if (!url) return false;

    try {
      return new URL(url, location.origin).pathname === USAGE_ENDPOINT;
    } catch {
      return false;
    }
  }

  async function readRequestBody(input, init) {
    if (typeof init?.body === "string") {
      return init.body;
    }

    if (input instanceof Request) {
      return input.clone().text();
    }

    return "";
  }

  window.fetch = async function cursorUsageFetchInterceptor(input, init) {
    const shouldCapture = isUsageRequest(input);
    const bodyPromise = shouldCapture ? readRequestBody(input, init).catch(() => "") : null;
    const response = await nativeFetch(input, init);

    if (shouldCapture && bodyPromise) {
      void bodyPromise.then(captureRequestContext);
    }

    return response;
  };

  function captureRequestContext(bodyText) {
    if (!bodyText) return;

    try {
      const body = JSON.parse(bodyText);
      if (!body.teamId || !body.userId) return;

      const nextContext = {
        teamId: body.teamId,
        userId: body.userId,
      };
      const changed = !requestContext || requestContext.teamId !== nextContext.teamId || requestContext.userId !== nextContext.userId;

      requestContext = nextContext;
      if (changed || !currentData) {
        scheduleLoad(50);
      }
    } catch {
      // Ignore unrelated or malformed requests.
    }
  }

  function scheduleLoad(delay = 0) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void loadStatistics(), delay);
  }

  function utcDayStart(date = new Date()) {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }

  function utcMonthStart(date = new Date()) {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }

  function utcDayKey(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  async function fetchUsagePage(page, startDate, endDate) {
    const response = await nativeFetch(USAGE_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...requestContext,
        startDate: String(startDate),
        endDate: String(endDate),
        page,
        pageSize: PAGE_SIZE,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cursor API vrátilo HTTP ${response.status}.`);
    }

    return response.json();
  }

  async function loadStatistics() {
    if (!requestContext || loading) return;

    loading = true;
    renderLoading();

    try {
      const now = Date.now();
      const todayStart = utcDayStart(new Date(now));
      const startDate = Math.min(utcMonthStart(new Date(now)), todayStart - 29 * DAY_MS);
      const firstPage = await fetchUsagePage(1, startDate, now);
      const total = Number(firstPage.totalUsageEventsCount) || 0;
      const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const remainingPages = await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => fetchUsagePage(index + 2, startDate, now)));
      const events = [...(firstPage.usageEventsDisplay || []), ...remainingPages.flatMap((page) => page.usageEventsDisplay || [])];

      currentData = buildStatistics(events, now);
      renderStatistics(currentData);
    } catch (error) {
      renderError(error);
    } finally {
      loading = false;
    }
  }

  function getTokenCount(event) {
    const usage = event?.tokenUsage;
    if (!usage) return 0;
    if (Number.isFinite(Number(usage.totalTokens))) return Number(usage.totalTokens);

    return ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"].reduce((sum, field) => sum + (Number(usage[field]) || 0), 0);
  }

  function getChargedDollars(event) {
    if (event?.kind !== "USAGE_EVENT_KIND_USAGE_BASED") return 0;
    return (Number(event.chargedCents) || 0) / 100;
  }

  function createEmptyDay(timestamp) {
    return {
      key: utcDayKey(timestamp),
      timestamp,
      tokens: 0,
      spend: 0,
      calls: 0,
      modelTokens: {},
      modelSpend: {},
    };
  }

  function buildStatistics(events, now) {
    const todayStart = utcDayStart(new Date(now));
    const sevenDayStart = todayStart - 6 * DAY_MS;
    const thirtyDayStart = todayStart - 29 * DAY_MS;
    const monthStart = utcMonthStart(new Date(now));
    const dataStart = Math.min(monthStart, thirtyDayStart);
    const daily = new Map();
    const models = new Map();
    let monthEventCount = 0;

    for (let timestamp = dataStart; timestamp <= todayStart; timestamp += DAY_MS) {
      const day = createEmptyDay(timestamp);
      daily.set(day.key, day);
    }

    for (const event of events) {
      const timestamp = Number(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < dataStart || timestamp > now) continue;

      const tokens = getTokenCount(event);
      const spend = getChargedDollars(event);
      const modelName = String(event.model || "Neznámý model");
      const day = daily.get(utcDayKey(timestamp));
      if (day) {
        day.tokens += tokens;
        day.spend += spend;
        day.calls += 1;
        day.modelTokens[modelName] = (day.modelTokens[modelName] || 0) + tokens;
        day.modelSpend[modelName] = (day.modelSpend[modelName] || 0) + spend;
      }

      if (timestamp < monthStart) continue;
      monthEventCount += 1;
      const model = models.get(modelName) || {
        name: modelName,
        calls: 0,
        paidCalls: 0,
        tokens: 0,
        spend: 0,
      };
      model.calls += 1;
      model.tokens += tokens;
      model.spend += spend;
      if (spend > 0) model.paidCalls += 1;
      models.set(modelName, model);
    }

    const allDays = [...daily.values()];
    const monthDays = allDays.filter((day) => day.timestamp >= monthStart);
    const sevenDays = allDays.filter((day) => day.timestamp >= sevenDayStart);
    const today = daily.get(utcDayKey(todayStart)) || createEmptyDay(todayStart);
    const sumSpend = (days) => days.reduce((sum, day) => sum + day.spend, 0);
    const elapsedDays = Math.max(1, Math.floor((todayStart - monthStart) / DAY_MS) + 1);

    return {
      updatedAt: now,
      monthStart,
      todaySpend: today.spend,
      sevenDaySpend: sumSpend(sevenDays),
      monthSpend: sumSpend(monthDays),
      dailyAverage: sumSpend(monthDays) / elapsedDays,
      sevenDays,
      days: allDays,
      models: [...models.values()].sort((left, right) => right.spend - left.spend || right.tokens - left.tokens),
      eventCount: monthEventCount,
    };
  }

  function formatDollars(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value || 0);
  }

  function formatTokens(value) {
    return new Intl.NumberFormat("cs-CZ", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value || 0);
  }

  function formatInteger(value) {
    return new Intl.NumberFormat("cs-CZ").format(value || 0);
  }

  function formatDay(timestamp, includeDate = false) {
    return new Intl.DateTimeFormat("cs-CZ", {
      weekday: "short",
      ...(includeDate ? { day: "numeric", month: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(timestamp));
  }

  function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        --gm-bg: #fcfcfc;
        --gm-bg-subtle: #f5f5f5;
        --gm-text: #141414;
        --gm-muted: #6b7280;
        --gm-border: #e5e7eb;
        --gm-accent: #7c3aed;
        --gm-accent-soft: #ede9fe;
        margin-bottom: 24px;
        padding: 24px;
        border-radius: 12px;
        background: var(--gm-bg);
        color: var(--gm-text);
        box-shadow: 0 0 0 1px var(--gm-border);
        font: inherit;
      }
      html.dark #${PANEL_ID} {
        --gm-bg: #181818;
        --gm-bg-subtle: #222;
        --gm-text: #f3f4f6;
        --gm-muted: #9ca3af;
        --gm-border: #333;
        --gm-accent: #a78bfa;
        --gm-accent-soft: #2e2350;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .gm-cus-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      #${PANEL_ID} .gm-cus-title {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        line-height: 1.3;
      }
      #${PANEL_ID} .gm-cus-subtitle {
        margin-top: 3px;
        color: var(--gm-muted);
        font-size: 12px;
      }
      #${PANEL_ID} .gm-cus-refresh {
        min-width: 34px;
        height: 32px;
        padding: 0 11px;
        border: 1px solid var(--gm-border);
        border-radius: 7px;
        background: var(--gm-bg-subtle);
        color: var(--gm-text);
        cursor: pointer;
        font: inherit;
      }
      #${PANEL_ID} .gm-cus-refresh:hover { border-color: var(--gm-accent); }
      #${PANEL_ID} .gm-cus-kpis {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 20px;
      }
      #${PANEL_ID} .gm-cus-kpi {
        min-width: 0;
        padding: 13px 14px;
        border: 1px solid var(--gm-border);
        border-radius: 9px;
        background: var(--gm-bg-subtle);
      }
      #${PANEL_ID} .gm-cus-kpi-label {
        color: var(--gm-muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      #${PANEL_ID} .gm-cus-kpi-value {
        margin-top: 4px;
        font-size: 22px;
        font-variant-numeric: tabular-nums;
        font-weight: 650;
      }
      #${PANEL_ID} .gm-cus-section-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      #${PANEL_ID} .gm-cus-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .gm-cus-chart-controls {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 7px;
      }
      #${PANEL_ID} .gm-cus-range {
        display: inline-flex;
        padding: 2px;
        border: 1px solid var(--gm-border);
        border-radius: 7px;
        background: var(--gm-bg-subtle);
      }
      #${PANEL_ID} .gm-cus-range-button,
      #${PANEL_ID} .gm-cus-metric-button {
        height: 25px;
        padding: 0 9px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--gm-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
      }
      #${PANEL_ID} .gm-cus-range-button[data-active="true"],
      #${PANEL_ID} .gm-cus-metric-button[data-active="true"] {
        background: var(--gm-bg);
        color: var(--gm-text);
        box-shadow: 0 0 0 1px var(--gm-border);
        font-weight: 600;
      }
      #${PANEL_ID} .gm-cus-chart {
        display: grid;
        grid-template-columns: repeat(var(--gm-day-count), minmax(42px, 1fr));
        align-items: end;
        gap: 8px;
        min-height: 190px;
        overflow-x: auto;
        padding: 12px 12px 8px;
        border: 1px solid var(--gm-border);
        border-radius: 9px;
        background:
          linear-gradient(to top, transparent 49%, var(--gm-border) 50%, transparent 51%),
          var(--gm-bg-subtle);
      }
      #${PANEL_ID} .gm-cus-day {
        display: grid;
        grid-template-rows: 18px 120px 18px 16px;
        align-items: end;
        min-width: 0;
        text-align: center;
      }
      #${PANEL_ID} .gm-cus-day-cost {
        overflow: hidden;
        color: var(--gm-text);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${PANEL_ID} .gm-cus-bar-slot {
        display: flex;
        align-items: end;
        justify-content: center;
        height: 120px;
      }
      #${PANEL_ID} .gm-cus-bar {
        display: flex;
        flex-direction: column-reverse;
        width: min(34px, 72%);
        min-height: 2px;
        overflow: hidden;
        border-radius: 5px 5px 2px 2px;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--gm-accent), transparent 45%);
      }
      #${PANEL_ID} .gm-cus-segment {
        flex: 0 0 auto;
        width: 100%;
      }
      #${PANEL_ID} .gm-cus-day-tokens {
        overflow: hidden;
        color: var(--gm-muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${PANEL_ID} .gm-cus-day-label {
        color: var(--gm-muted);
        font-size: 10px;
        text-transform: capitalize;
      }
      #${PANEL_ID} .gm-cus-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 7px 14px;
        margin: 9px 2px 22px;
        color: var(--gm-muted);
        font-size: 10px;
      }
      #${PANEL_ID} .gm-cus-legend-item {
        display: inline-flex;
        align-items: center;
        min-width: 0;
        gap: 5px;
      }
      #${PANEL_ID} .gm-cus-legend-item[data-hidden="true"] {
        opacity: .35;
        text-decoration: line-through;
      }
      #${PANEL_ID} .gm-cus-legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        flex: 0 0 auto;
      }
      #${PANEL_ID} .gm-cus-legend-label {
        overflow: hidden;
        max-width: 230px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${PANEL_ID} .gm-cus-table-wrap {
        max-height: 330px;
        overflow: auto;
        border: 1px solid var(--gm-border);
        border-radius: 9px;
      }
      #${PANEL_ID} table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      #${PANEL_ID} th,
      #${PANEL_ID} td {
        padding: 9px 11px;
        border-bottom: 1px solid var(--gm-border);
        text-align: right;
        white-space: nowrap;
      }
      #${PANEL_ID} th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--gm-bg-subtle);
        color: var(--gm-muted);
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: .035em;
      }
      #${PANEL_ID} th:first-child,
      #${PANEL_ID} td:first-child {
        max-width: 280px;
        overflow: hidden;
        text-align: left;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .gm-cus-model-cell,
      #${PANEL_ID} .gm-cus-model-head {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 7px;
      }
      #${PANEL_ID} .gm-cus-model-toggle,
      #${PANEL_ID} .gm-cus-models-toggle-all {
        position: relative;
        width: 13px;
        height: 13px;
        padding: 0;
        border: 0;
        border-radius: 2px;
        background: transparent;
        cursor: pointer;
        flex: 0 0 auto;
      }
      #${PANEL_ID} .gm-cus-model-toggle:hover,
      #${PANEL_ID} .gm-cus-model-toggle:focus-visible,
      #${PANEL_ID} .gm-cus-models-toggle-all:hover,
      #${PANEL_ID} .gm-cus-models-toggle-all:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--gm-accent), transparent 45%);
        outline-offset: 2px;
      }
      #${PANEL_ID} .gm-cus-model-dot {
        display: block;
        width: 100%;
        height: 100%;
        border-radius: inherit;
        transition: opacity .12s ease;
      }
      #${PANEL_ID} .gm-cus-models-toggle-all .gm-cus-model-dot {
        background:
          linear-gradient(90deg, ${MODEL_COLORS[0]} 0 25%, ${MODEL_COLORS[1]} 25% 50%, ${MODEL_COLORS[2]} 50% 75%, ${MODEL_COLORS[3]} 75% 100%);
      }
      #${PANEL_ID} .gm-cus-model-toggle[data-active="false"] .gm-cus-model-dot,
      #${PANEL_ID} .gm-cus-models-toggle-all[data-active="false"] .gm-cus-model-dot {
        opacity: .2;
      }
      #${PANEL_ID} .gm-cus-model-toggle[data-active="false"]::after,
      #${PANEL_ID} .gm-cus-models-toggle-all[data-active="false"]::after {
        position: absolute;
        top: 5px;
        left: -1px;
        width: 15px;
        height: 2px;
        background: var(--gm-text);
        content: "";
        transform: rotate(-45deg);
      }
      #${PANEL_ID} .gm-cus-model-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${PANEL_ID} tbody tr:last-child td { border-bottom: 0; }
      #${PANEL_ID} tbody tr:hover { background: var(--gm-accent-soft); }
      #${PANEL_ID} .gm-cus-status {
        padding: 28px 12px;
        color: var(--gm-muted);
        text-align: center;
      }
      #${PANEL_ID} .gm-cus-error { color: #dc2626; }
      @media (max-width: 820px) {
        #${PANEL_ID} { padding: 16px; }
        #${PANEL_ID} .gm-cus-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        #${PANEL_ID} .gm-cus-section-head { align-items: flex-start; flex-direction: column; }
        #${PANEL_ID} .gm-cus-chart { gap: 3px; padding-inline: 5px; }
        #${PANEL_ID} .gm-cus-day { grid-template-rows: 18px 100px 18px 16px; }
        #${PANEL_ID} .gm-cus-bar-slot { height: 100px; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function findMountAnchor() {
    const description = document.getElementById("table-description");
    return description?.closest(".dashboard-table-card")?.parentElement || null;
  }

  function ensurePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing?.isConnected) return existing;

    const anchor = findMountAnchor();
    if (!anchor?.parentElement) return null;

    ensureStyles();
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "Cursor usage statistics");
    anchor.parentElement.insertBefore(panel, anchor);
    return panel;
  }

  function headerHtml(subtitle) {
    return `
      <div class="gm-cus-header">
        <div>
          <h2 class="gm-cus-title">Moje usage statistiky</h2>
          <div class="gm-cus-subtitle">${escapeHtml(subtitle)}</div>
        </div>
        <button class="gm-cus-refresh" type="button" title="Obnovit statistiky" aria-label="Obnovit statistiky">↻</button>
      </div>
    `;
  }

  function bindPanelActions(panel) {
    panel.querySelector(".gm-cus-refresh")?.addEventListener("click", () => scheduleLoad());
    panel.querySelectorAll(".gm-cus-range-button").forEach((button) => {
      button.addEventListener("click", () => {
        const nextRange = Number(button.dataset.range);
        if (!currentData || nextRange === chartRangeDays || ![7, 30].includes(nextRange)) return;
        chartRangeDays = nextRange;
        renderStatistics(currentData);
        if (nextRange === 30) {
          const chart = document.getElementById(PANEL_ID)?.querySelector(".gm-cus-chart");
          if (chart) chart.scrollLeft = chart.scrollWidth;
        }
      });
    });
    panel.querySelectorAll(".gm-cus-metric-button").forEach((button) => {
      button.addEventListener("click", () => {
        const nextMetric = button.dataset.metric;
        if (!currentData || nextMetric === chartMetric || !["tokens", "spend"].includes(nextMetric)) return;
        chartMetric = nextMetric;
        renderStatistics(currentData);
      });
    });
    panel.querySelectorAll(".gm-cus-model-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const model = button.dataset.model;
        if (!currentData || !model) return;

        const tableScrollTop = panel.querySelector(".gm-cus-table-wrap")?.scrollTop || 0;
        if (hiddenChartModels.has(model)) hiddenChartModels.delete(model);
        else hiddenChartModels.add(model);
        renderStatistics(currentData);
        const table = document.getElementById(PANEL_ID)?.querySelector(".gm-cus-table-wrap");
        if (table) table.scrollTop = tableScrollTop;
      });
    });
    panel.querySelector(".gm-cus-models-toggle-all")?.addEventListener("click", () => {
      if (!currentData?.models?.length) return;

      const tableScrollTop = panel.querySelector(".gm-cus-table-wrap")?.scrollTop || 0;
      if (areAllChartModelsHidden(currentData.models)) {
        for (const model of currentData.models) hiddenChartModels.delete(model.name);
      } else {
        for (const model of currentData.models) hiddenChartModels.add(model.name);
      }
      renderStatistics(currentData);
      const table = document.getElementById(PANEL_ID)?.querySelector(".gm-cus-table-wrap");
      if (table) table.scrollTop = tableScrollTop;
    });
  }

  function areAllChartModelsHidden(models) {
    return models.length > 0 && models.every((model) => hiddenChartModels.has(model.name));
  }

  function renderLoading() {
    const panel = ensurePanel();
    if (!panel) return;
    panel.innerHTML = `${headerHtml("Načítám kalendářní měsíc…")}<div class="gm-cus-status">Počítám usage události…</div>`;
  }

  function renderWaiting() {
    const panel = ensurePanel();
    if (!panel || currentData || loading) return;
    panel.innerHTML = `${headerHtml("Čekám na Cursor Usage API…")}<div class="gm-cus-status">Pokud se data nenačtou, změňte jednou časový filtr na stránce.</div>`;
  }

  function renderError(error) {
    const panel = ensurePanel();
    if (!panel) return;
    panel.innerHTML = `
      ${headerHtml("Statistiky se nepodařilo načíst")}
      <div class="gm-cus-status gm-cus-error">${escapeHtml(error?.message || error)}</div>
    `;
    bindPanelActions(panel);
  }

  function getChartSeries(days, models) {
    const totals = new Map();
    for (const day of days) {
      for (const [model, tokens] of Object.entries(day.modelTokens)) {
        totals.set(model, (totals.get(model) || 0) + tokens);
      }
    }

    const topModels = models.slice(0, 5).map((model, index) => ({
      name: model.name,
      tokens: totals.get(model.name) || 0,
      color: MODEL_COLORS[index],
      hidden: hiddenChartModels.has(model.name),
    }));
    const topNames = new Set(topModels.map((model) => model.name));
    const otherModels = [...totals.entries()].filter(([name]) => !topNames.has(name));
    const otherTokens = otherModels.reduce((sum, [, tokens]) => sum + tokens, 0);

    return otherTokens > 0
      ? [
          ...topModels,
          {
            name: "Ostatní modely",
            tokens: otherTokens,
            color: OTHER_MODEL_COLOR,
            other: true,
            members: otherModels.map(([name]) => name),
            hidden: otherModels.every(([name]) => hiddenChartModels.has(name)),
          },
        ]
      : topModels;
  }

  function getVisibleDayMetrics(day) {
    return Object.entries(day.modelTokens).reduce(
      (result, [name, tokens]) => {
        if (!hiddenChartModels.has(name)) {
          result.tokens += tokens;
          result.spend += day.modelSpend[name] || 0;
        }
        return result;
      },
      { tokens: 0, spend: 0 },
    );
  }

  function renderChart(days, series) {
    const visibleMetrics = new Map(days.map((day) => [day.key, getVisibleDayMetrics(day)]));
    const maxValue = Math.max(1, ...[...visibleMetrics.values()].map((metrics) => metrics[chartMetric]));
    const topNames = new Set(series.filter((item) => !item.other).map((item) => item.name));

    return days
      .map((day) => {
        const visible = visibleMetrics.get(day.key);
        const visibleValue = visible[chartMetric];
        const height = visibleValue > 0 ? Math.max(2, Math.round((visibleValue / maxValue) * 100)) : 2;
        const title = `${formatDay(day.timestamp, true)}: ${formatTokens(visible.tokens)} tokenů, ${formatDollars(visible.spend)}`;
        const segments = series
          .map((item) => {
            let tokens = 0;
            let spend = 0;
            if (item.other) {
              for (const [name, value] of Object.entries(day.modelTokens)) {
                if (topNames.has(name) || hiddenChartModels.has(name)) continue;
                tokens += value;
                spend += day.modelSpend[name] || 0;
              }
            } else if (!hiddenChartModels.has(item.name)) {
              tokens = day.modelTokens[item.name] || 0;
              spend = day.modelSpend[item.name] || 0;
            }
            const segmentValue = chartMetric === "spend" ? spend : tokens;
            if (!segmentValue || !visibleValue) return "";

            const segmentTitle = `${item.name}: ${formatTokens(tokens)} tokenů, ${formatDollars(spend)}`;
            return `<div class="gm-cus-segment" style="height:${(segmentValue / visibleValue) * 100}%;background:${item.color}" title="${escapeHtml(segmentTitle)}"></div>`;
          })
          .join("");
        return `
          <div class="gm-cus-day" title="${escapeHtml(title)}">
            <div class="gm-cus-day-cost">${formatDollars(visible.spend)}</div>
            <div class="gm-cus-bar-slot"><div class="gm-cus-bar" style="height:${height}%">${segments}</div></div>
            <div class="gm-cus-day-tokens">${formatTokens(visible.tokens)} tok.</div>
            <div class="gm-cus-day-label">${escapeHtml(formatDay(day.timestamp, true))}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderLegend(series) {
    return series
      .map(
        (item) => `
          <span class="gm-cus-legend-item" data-hidden="${item.hidden}" title="${escapeHtml(item.name)}">
            <span class="gm-cus-legend-dot" style="background:${item.color}"></span>
            <span class="gm-cus-legend-label">${escapeHtml(item.name)}</span>
          </span>
        `,
      )
      .join("");
  }

  function renderModelRows(models, series) {
    const colorByModel = new Map(series.filter((item) => !item.other).map((item) => [item.name, item.color]));

    return models
      .map((model) => {
        const averageCall = model.paidCalls ? model.spend / model.paidCalls : 0;
        const pricePerMillion = model.tokens ? (model.spend / model.tokens) * 1_000_000 : 0;
        const color = colorByModel.get(model.name) || OTHER_MODEL_COLOR;
        const active = !hiddenChartModels.has(model.name);
        return `
          <tr>
            <td title="${escapeHtml(model.name)}">
              <span class="gm-cus-model-cell">
                <button
                  class="gm-cus-model-toggle"
                  type="button"
                  data-model="${escapeHtml(model.name)}"
                  data-active="${active}"
                  aria-pressed="${active}"
                  title="${active ? "Skrýt model v grafu" : "Zobrazit model v grafu"}"
                ><span class="gm-cus-model-dot" style="background:${color}"></span></button>
                <span class="gm-cus-model-name">${escapeHtml(model.name)}</span>
              </span>
            </td>
            <td>${formatInteger(model.calls)}</td>
            <td>${formatTokens(model.tokens)}</td>
            <td>${formatDollars(model.spend)}</td>
            <td>${model.paidCalls ? formatDollars(averageCall) : "—"}</td>
            <td>${model.spend ? formatDollars(pricePerMillion) : "—"}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderStatistics(data) {
    const panel = ensurePanel();
    if (!panel) return;
    const chartDays = data.days.slice(-chartRangeDays);
    const chartSeries = getChartSeries(chartDays, data.models);
    const allModelsHidden = areAllChartModelsHidden(data.models);

    const monthLabel = new Intl.DateTimeFormat("cs-CZ", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(data.monthStart));
    const updatedLabel = new Intl.DateTimeFormat("cs-CZ", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(data.updatedAt));

    panel.innerHTML = `
      ${headerHtml(`${monthLabel} · ${formatInteger(data.eventCount)} událostí · aktualizováno ${updatedLabel}`)}
      <div class="gm-cus-kpis">
        <div class="gm-cus-kpi">
          <div class="gm-cus-kpi-label">Dnes (UTC)</div>
          <div class="gm-cus-kpi-value">${formatDollars(data.todaySpend)}</div>
        </div>
        <div class="gm-cus-kpi">
          <div class="gm-cus-kpi-label">Posledních 7 dní</div>
          <div class="gm-cus-kpi-value">${formatDollars(data.sevenDaySpend)}</div>
        </div>
        <div class="gm-cus-kpi">
          <div class="gm-cus-kpi-label">Tento měsíc</div>
          <div class="gm-cus-kpi-value">${formatDollars(data.monthSpend)}</div>
        </div>
        <div class="gm-cus-kpi">
          <div class="gm-cus-kpi-label">Průměr / den</div>
          <div class="gm-cus-kpi-value">${formatDollars(data.dailyAverage)}</div>
        </div>
      </div>
      <div class="gm-cus-section-head">
        <h3 class="gm-cus-section-title">${chartMetric === "tokens" ? "Tokeny" : "Účtovaná cena"} podle modelu · posledních ${chartRangeDays} dní (UTC)</h3>
        <div class="gm-cus-chart-controls">
          <div class="gm-cus-range" aria-label="Metrika grafu">
            <button class="gm-cus-metric-button" type="button" data-metric="tokens" data-active="${chartMetric === "tokens"}" aria-pressed="${chartMetric === "tokens"}">Tokeny</button>
            <button class="gm-cus-metric-button" type="button" data-metric="spend" data-active="${chartMetric === "spend"}" aria-pressed="${chartMetric === "spend"}">Cena</button>
          </div>
          <div class="gm-cus-range" aria-label="Rozsah grafu">
            <button class="gm-cus-range-button" type="button" data-range="7" data-active="${chartRangeDays === 7}" aria-pressed="${chartRangeDays === 7}">7 dní</button>
            <button class="gm-cus-range-button" type="button" data-range="30" data-active="${chartRangeDays === 30}" aria-pressed="${chartRangeDays === 30}">30 dní</button>
          </div>
        </div>
      </div>
      <div class="gm-cus-chart" data-metric="${chartMetric}" style="--gm-day-count:${chartDays.length}" role="img" aria-label="Skládaný denní graf ${chartMetric === "tokens" ? "tokenů" : "nákladů"} za posledních ${chartRangeDays} dní">
        ${renderChart(chartDays, chartSeries)}
      </div>
      <div class="gm-cus-legend">${renderLegend(chartSeries)}</div>
      <div class="gm-cus-section-head"><h3 class="gm-cus-section-title">Modely · tento kalendářní měsíc</h3></div>
      <div class="gm-cus-table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <span class="gm-cus-model-head">
                  <button
                    class="gm-cus-models-toggle-all"
                    type="button"
                    data-active="${!allModelsHidden}"
                    aria-pressed="${!allModelsHidden}"
                    title="${allModelsHidden ? "Zobrazit všechny modely v grafu" : "Skrýt všechny modely v grafu"}"
                  ><span class="gm-cus-model-dot"></span></button>
                  <span>Model</span>
                </span>
              </th>
              <th>Volání</th>
              <th>Tokeny</th>
              <th>Útrata</th>
              <th>Ø placené volání</th>
              <th>Cena / 1M tok.</th>
            </tr>
          </thead>
          <tbody>${renderModelRows(data.models, chartSeries)}</tbody>
        </table>
      </div>
    `;
    bindPanelActions(panel);
  }

  function startUi() {
    const observer = new MutationObserver(() => {
      if (!document.getElementById(PANEL_ID)) {
        if (currentData) renderStatistics(currentData);
        else if (loading) renderLoading();
        else renderWaiting();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (currentData) renderStatistics(currentData);
    else if (loading) renderLoading();
    else renderWaiting();
    setTimeout(renderWaiting, 1500);
  }

  window.__cursorUsageStats = {
    version: VERSION,
    refresh: () => scheduleLoad(),
    getData: () => currentData,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startUi, { once: true });
  } else {
    startUi();
  }
})();
