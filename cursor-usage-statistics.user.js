// ==UserScript==
// @name         Cursor Usage Statistics
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.3.13
// @description  Adds on-demand spend from native Cursor Cost, usage-value charts, optional catalog fallback, and per-model statistics to the Cursor usage dashboard.
// @author       Lukáš Sedláček
// The dashboard is a SPA: matching only /dashboard/usage skips client-side navigation into it.
// @match        https://cursor.com/dashboard*
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/cursor-usage-statistics.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/cursor-usage-statistics.user.js
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "1.3.13";
  const USAGE_ENDPOINT = "/api/dashboard/get-filtered-usage-events";
  const AGG_ENDPOINT = "/api/dashboard/get-aggregated-usage-events";
  const SUMMARY_ENDPOINT = "/api/usage-summary";
  const UNAVAILABLE = null;

  /** Native event `kind` for usage billed on-demand (dashboard column "Type" = On-Demand). */
  const ON_DEMAND_KIND = "USAGE_EVENT_KIND_USAGE_BASED";
  const INCLUDED_KIND = "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS";
  const ERRORED_KIND = "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED";

  /**
   * Public catalog rates from https://cursor.com/docs/models-and-pricing (2026-07-31).
   * JSON-compatible, editable data only — no invented rates.
   * Prices are USD per 1M tokens. `cacheWrite: null` = no separate cache-write fee in docs.
   * Emergency fallback only — see PRICE_ESTIMATION_FALLBACK_ENABLED.
   */
  const MODEL_PRICING = {
    currency: "USD",
    unit: "per 1M tokens",
    source: "https://cursor.com/docs/models-and-pricing",
    effectiveDate: "2026-07-31",
    cursorTokenRatePerMillion: 0.25,
    models: {
      "claude-4-sonnet": { provider: "Anthropic", input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15, thirdParty: true, notes: "Hidden by default; Thinking = 2 requests on legacy plans" },
      "claude-4-sonnet-1m": { provider: "Anthropic", input: 6, cacheWrite: 7.5, cacheRead: 0.6, output: 22.5, thirdParty: true, notes: "2x when input exceeds 200k tokens" },
      "claude-4.5-haiku": { provider: "Anthropic", input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5, thirdParty: true },
      "claude-4.5-opus": { provider: "Anthropic", input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25, thirdParty: true },
      "claude-4.5-sonnet": { provider: "Anthropic", input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15, thirdParty: true },
      "claude-4.6-opus": { provider: "Anthropic", input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25, thirdParty: true },
      "claude-4.6-sonnet": { provider: "Anthropic", input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15, thirdParty: true },
      "claude-4.7-opus": { provider: "Anthropic", input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25, thirdParty: true },
      "claude-fable-5": { provider: "Anthropic", input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50, thirdParty: true },
      "claude-opus-4.7-fast": { provider: "Anthropic", input: 30, cacheWrite: 37.5, cacheRead: 3, output: 150, thirdParty: true, notes: "Claude Opus 4.7 (fast mode) table row" },
      "claude-opus-4.8": { provider: "Anthropic", input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25, thirdParty: true, notes: "Fast mode rates not listed as absolute — unpriced when -fast" },
      "claude-opus-5": { provider: "Anthropic", input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25, thirdParty: true, notes: "Fast mode mentioned without absolute rates — unpriced when -fast" },
      "claude-sonnet-5": { provider: "Anthropic", input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15, thirdParty: true, notes: "Launch promo $2/$10 input/output through 2026-08-31 not applied; table columns used" },
      "gemini-2.5-flash": { provider: "Google", input: 0.3, cacheWrite: null, cacheRead: 0.03, output: 2.5, thirdParty: true },
      "gemini-3-flash": { provider: "Google", input: 0.5, cacheWrite: null, cacheRead: 0.05, output: 3, thirdParty: true },
      "gemini-3-pro": { provider: "Google", input: 2, cacheWrite: null, cacheRead: 0.2, output: 12, thirdParty: true },
      "gemini-3-pro-image-preview": { provider: "Google", input: 2, cacheWrite: null, cacheRead: 0.2, output: 12, thirdParty: true },
      "gemini-3.1-pro": { provider: "Google", input: 2, cacheWrite: null, cacheRead: 0.2, output: 12, thirdParty: true },
      "gemini-3.5-flash": { provider: "Google", input: 1.5, cacheWrite: null, cacheRead: 0.15, output: 9, thirdParty: true },
      "gemini-3.6-flash": { provider: "Google", input: 1.5, cacheWrite: null, cacheRead: 0.15, output: 7.5, thirdParty: true },
      "glm-5.2": { provider: "Z.ai", input: 1.4, cacheWrite: null, cacheRead: 0.26, output: 4.4, thirdParty: true },
      "gpt-5": { provider: "OpenAI", input: 1.25, cacheWrite: null, cacheRead: 0.125, output: 10, thirdParty: true },
      "gpt-5-fast": { provider: "OpenAI", input: 2.5, cacheWrite: null, cacheRead: 0.25, output: 20, thirdParty: true, notes: "Dedicated fast row (2x GPT-5)" },
      "gpt-5-mini": { provider: "OpenAI", input: 0.25, cacheWrite: null, cacheRead: 0.025, output: 2, thirdParty: true },
      "gpt-5-codex": { provider: "OpenAI", input: 1.25, cacheWrite: null, cacheRead: 0.125, output: 10, thirdParty: true },
      "gpt-5.1-codex": { provider: "OpenAI", input: 1.25, cacheWrite: null, cacheRead: 0.125, output: 10, thirdParty: true },
      "gpt-5.1-codex-max": { provider: "OpenAI", input: 1.25, cacheWrite: null, cacheRead: 0.125, output: 10, thirdParty: true },
      "gpt-5.1-codex-mini": { provider: "OpenAI", input: 0.25, cacheWrite: null, cacheRead: 0.025, output: 2, thirdParty: true },
      "gpt-5.2": { provider: "OpenAI", input: 1.75, cacheWrite: null, cacheRead: 0.175, output: 14, thirdParty: true },
      "gpt-5.2-codex": { provider: "OpenAI", input: 1.75, cacheWrite: null, cacheRead: 0.175, output: 14, thirdParty: true },
      "gpt-5.3-codex": { provider: "OpenAI", input: 1.75, cacheWrite: null, cacheRead: 0.175, output: 14, thirdParty: true },
      "gpt-5.4": { provider: "OpenAI", input: 2.5, cacheWrite: null, cacheRead: 0.25, output: 15, thirdParty: true, fastMultiplier: 2, notes: "Fast mode 2x; long-context 2x input not auto-applied" },
      "gpt-5.4-mini": { provider: "OpenAI", input: 0.75, cacheWrite: null, cacheRead: 0.075, output: 4.5, thirdParty: true },
      "gpt-5.4-nano": { provider: "OpenAI", input: 0.2, cacheWrite: null, cacheRead: 0.02, output: 1.25, thirdParty: true },
      "gpt-5.5": { provider: "OpenAI", input: 5, cacheWrite: null, cacheRead: 0.5, output: 30, thirdParty: true, notes: "Fast mode at higher rates — no exact multiplier; -fast stays unpriced" },
      "gpt-5.6-luna": { provider: "OpenAI", input: 0.2, cacheWrite: 0.25, cacheRead: 0.02, output: 1.2, thirdParty: true, fastMultiplier: 2 },
      "gpt-5.6-sol": { provider: "OpenAI", input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30, thirdParty: true, fastMultiplier: 2 },
      "gpt-5.6-terra": { provider: "OpenAI", input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 12, thirdParty: true, fastMultiplier: 2 },
      "kimi-k2.7-code": { provider: "Moonshot", input: 0.95, cacheWrite: null, cacheRead: 0.19, output: 4, thirdParty: true },
      "kimi-k3": { provider: "Moonshot", input: 3, cacheWrite: null, cacheRead: 0.3, output: 15, thirdParty: true },
      "cursor-grok-4.5": { provider: "Cursor", input: null, cacheWrite: null, cacheRead: null, output: null, thirdParty: false, unpriced: true, notes: "Cursor Models pool — no public per-token API rates" },
      "composer-2.5": { provider: "Cursor", input: null, cacheWrite: null, cacheRead: null, output: null, thirdParty: false, unpriced: true, notes: "Cursor Models pool — no public per-token API rates" },
    },
    aliases: {
      "claude 4 sonnet": "claude-4-sonnet",
      "claude 4 sonnet 1m": "claude-4-sonnet-1m",
      "claude 4.5 haiku": "claude-4.5-haiku",
      "claude 4.5 opus": "claude-4.5-opus",
      "claude 4.5 sonnet": "claude-4.5-sonnet",
      "claude 4.6 opus": "claude-4.6-opus",
      "claude 4.6 sonnet": "claude-4.6-sonnet",
      "claude 4.7 opus": "claude-4.7-opus",
      "claude fable 5": "claude-fable-5",
      "claude opus 4.7 (fast mode)": "claude-opus-4.7-fast",
      "claude-opus-4-7-fast": "claude-opus-4.7-fast",
      "claude opus 4.8": "claude-opus-4.8",
      "claude opus 5": "claude-opus-5",
      "opus 5": "claude-opus-5",
      "claude sonnet 5": "claude-sonnet-5",
      "gemini 2.5 flash": "gemini-2.5-flash",
      "gemini 3 flash": "gemini-3-flash",
      "gemini 3 pro": "gemini-3-pro",
      "gemini 3 pro image preview": "gemini-3-pro-image-preview",
      "gemini 3.1 pro": "gemini-3.1-pro",
      "gemini 3.5 flash": "gemini-3.5-flash",
      "gemini 3.6 flash": "gemini-3.6-flash",
      "glm 5.2": "glm-5.2",
      "gpt-5 fast": "gpt-5-fast",
      "gpt 5": "gpt-5",
      "gpt 5 fast": "gpt-5-fast",
      "gpt 5 mini": "gpt-5-mini",
      "gpt-5-codex": "gpt-5-codex",
      "gpt 5.1 codex": "gpt-5.1-codex",
      "gpt 5.1 codex max": "gpt-5.1-codex-max",
      "gpt 5.1 codex mini": "gpt-5.1-codex-mini",
      "gpt 5.2": "gpt-5.2",
      "gpt 5.2 codex": "gpt-5.2-codex",
      "gpt 5.3 codex": "gpt-5.3-codex",
      "gpt 5.4": "gpt-5.4",
      "gpt 5.4 mini": "gpt-5.4-mini",
      "gpt 5.4 nano": "gpt-5.4-nano",
      "gpt 5.5": "gpt-5.5",
      "gpt 5.6 luna": "gpt-5.6-luna",
      "gpt 5.6 sol": "gpt-5.6-sol",
      "gpt 5.6 terra": "gpt-5.6-terra",
      "kimi k2.7 code": "kimi-k2.7-code",
      "kimi k3": "kimi-k3",
      "cursor grok 4.5": "cursor-grok-4.5",
      "composer 2.5": "composer-2.5",
      "opus 5 (auto balanced)": { model: "claude-opus-5", autoRouted: true },
      "opus 5 (auto intelligence)": { model: "claude-opus-5", autoRouted: true },
      "gpt-5.6 sol (auto balanced)": { model: "gpt-5.6-sol", autoRouted: true },
      "gpt-5.6 sol (auto intelligence)": { model: "gpt-5.6-sol", autoRouted: true },
      "gpt-5.4 nano (auto balanced)": { model: "gpt-5.4-nano", autoRouted: true },
      "cursor grok 4.5 (auto balanced)": { model: "cursor-grok-4.5", autoRouted: true },
      "cursor grok 4.5 (auto intelligence)": { model: "cursor-grok-4.5", autoRouted: true },
      "cursor grok 4.5 fast? (auto balanced)": { model: "cursor-grok-4.5", wantsFast: true, autoRouted: true },
      "cursor grok 4.5 fast? (auto intelligence)": { model: "cursor-grok-4.5", wantsFast: true, autoRouted: true },
      "composer 2.5 (auto balanced)": { model: "composer-2.5", autoRouted: true },
      "composer 2.5 fast (auto balanced)": { model: "composer-2.5", wantsFast: true, autoRouted: true },
      "auto": { unpriced: true, reason: "auto-unresolved" },
      "auto-smart": { unpriced: true, reason: "auto-unresolved" },
      "default": { unpriced: true, reason: "unknown-model" },
      "agent_review": { unpriced: true, reason: "unknown-model" },
    },
  };

  /**
   * Local MODEL_PRICING estimator is suppressed by default.
   * Daily/model/graph costs use native per-event Cost (`chargedCents`).
   * Set true only as an emergency fallback when native Cost is missing.
   */
  const PRICE_ESTIMATION_FALLBACK_ENABLED = false;

  const PRICE_DISCLAIMER_CS =
    "Denní a modelové částky pocházejí z nativního sloupce Cost (API chargedCents). Included / Errored = $0. Exact cyklus = usage-summary.onDemand.used. Lokální ceníkový odhad je vypnutý.";

  const SHORT_NOTICE_CS =
    "Čísla z nativního Cursor Cost; Included = $0; exact cyklus z billing API; lokální odhad vypnutý.";

  const CHANGELOG = [
    {
      version: "1.3.13",
      text: "SPA routing: panel se nasadí i po klientském přechodu na /dashboard/usage, bez ručního refreshe stránky.",
    },
    {
      version: "1.3.12",
      text: "Oprava Firefox Xray: bezpečné čtení request body a cloneInto fetch init mezi userscript a page compartmentem.",
    },
    {
      version: "1.3.11",
      text: "Nativní per-event Cost (chargedCents) pro denní/modelové sumy; lokální ceníkový odhad vypnutý (opt-in fallback).",
    },
    {
      version: "1.3.10",
      text: "Zjednodušené UI podle původního panelu.",
    },
    {
      version: "1.3.9",
      text: "Odhad denní/modelové on-demand ceny z tokenů dle veřejného ceníku, coverage, disclaimer a nápověda (?).",
    },
    {
      version: "1.3.8",
      text: "Autoritativní cyklická útrata z usage-summary.onDemand.used (centy); aggregate jen Included.",
    },
    {
      version: "1.3.7",
      text: "Oddělení zaplacené útraty od hodnoty zahrnuté spotřeby; KPI N/A místo dohadů z chargedCents.",
    },
    {
      version: "1.3.4",
      text: "Promise-safe fetch interceptor (bez .then na návratové hodnotě) pro GM/Firefox Xray.",
    },
  ];

  function centsToDollars(value) {
    return (Number(value) || 0) / 100;
  }

  function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
  }

  /**
   * Legacy helper for On-Demand `chargedCents` only.
   * Prefer resolveEventPaidCost — Included events may also carry non-zero
   * chargedCents that must not count as paid Cost.
   */
  function getChargedDollars(event) {
    if (event?.kind !== "USAGE_EVENT_KIND_USAGE_BASED") return 0;
    return centsToDollars(event.chargedCents);
  }

  function sumEventChargedDollars(events) {
    let sum = 0;
    for (const event of events || []) {
      sum += getChargedDollars(event);
    }
    return sum;
  }

  function hasNativeChargedCents(event) {
    return event != null && isFiniteNumber(event.chargedCents);
  }

  /**
   * Live-verified 2026-08-03 on cursor.com/dashboard/usage:
   * native table Cost (USD) === chargedCents / 100 for On-Demand rows.
   * usageBasedCosts ("$X.YY") omits cursorTokenFee and does not match Cost
   * when fee > 0. tokenUsage.totalCents + cursorTokenFee ≈ chargedCents.
   * No top-level `cost` field. Included may have non-zero chargedCents — not paid.
   */
  function parseNativeChargedCostDollars(event) {
    if (!hasNativeChargedCents(event)) return null;
    return centsToDollars(event.chargedCents);
  }

  /**
   * Units verified against the native team-admin endpoint `/api/dashboard/get-team-spend`,
   * fetched in the same snapshot as `/api/usage-summary`:
   *
   *   individualUsage.onDemand.used      === teamMemberSpend[].spendCents          (cents)
   *   individualUsage.plan.breakdown.total === teamMemberSpend[].includedSpendCents (cents)
   *   subscriptionCycleStart / nextCycleStart === billingCycleStart / billingCycleEnd
   *
   * So both values are cents and cover exactly the same billing cycle. They are
   * complementary, not alternative: `onDemand.used` is the paid overage, while
   * `plan.breakdown.total` is the usage consumed from the included pool.
   *
   * The aggregate endpoint prices *included* events only — on-demand events come
   * back as 0 cents — which is why `aggregate.totalCostCents` tracks
   * `plan.breakdown.total` and is far below the on-demand spend.
   *
   * Daily / per-model paid breakdown is not provided by any of these payloads.
   */
  function parseUsageSummary(summary) {
    const individual = summary?.individualUsage && typeof summary.individualUsage === "object"
      ? summary.individualUsage
      : summary;
    const onDemandUsed = individual?.onDemand?.used ?? summary?.onDemand?.used;
    const planTotal = individual?.plan?.breakdown?.total ?? summary?.plan?.breakdown?.total;
    const cycleStartRaw = summary?.billingCycleStart ?? individual?.billingCycleStart;
    const cycleEndRaw = summary?.billingCycleEnd ?? individual?.billingCycleEnd;
    const cycleStart = cycleStartRaw != null ? Date.parse(cycleStartRaw) : NaN;
    const cycleEnd = cycleEndRaw != null ? Date.parse(cycleEndRaw) : NaN;

    const paidSpendCycle = isFiniteNumber(onDemandUsed) ? centsToDollars(onDemandUsed) : UNAVAILABLE;
    const includedUsageCycle = isFiniteNumber(planTotal) ? centsToDollars(planTotal) : UNAVAILABLE;

    return {
      paidSpendCycle,
      includedUsageCycle,
      totalUsageCycle:
        paidSpendCycle == null || includedUsageCycle == null
          ? UNAVAILABLE
          : paidSpendCycle + includedUsageCycle,
      // Back-compat alias: older callers/tests read the included pool under this name.
      planUsageValueCycle: includedUsageCycle,
      billingCycleStart: Number.isFinite(cycleStart) ? cycleStart : UNAVAILABLE,
      billingCycleEnd: Number.isFinite(cycleEnd) ? cycleEnd : UNAVAILABLE,
      // API gives cycle totals only — do not invent daily/model paid spend.
      paidSpendDailyAvailable: false,
      paidSpendPerModelAvailable: false,
    };
  }

  /** Mirrors the dashboard "Type" column: On-Demand vs Included. */
  function isOnDemandEvent(event) {
    const kind = event?.kind;
    return kind === ON_DEMAND_KIND || kind === "On-Demand";
  }

  function isIncludedEvent(event) {
    const kind = event?.kind;
    return kind === INCLUDED_KIND || kind === "Included";
  }

  function isErroredNoChargeEvent(event) {
    const kind = event?.kind;
    return kind === ERRORED_KIND || kind === "Errored, No Charge";
  }

  /**
   * Live filtered API `tokenUsage` fields (verified 2026-07-31):
   *   inputTokens       ↔ CSV "Input (w/o Cache Write)"  → uncached input rate
   *   cacheWriteTokens  ↔ CSV "Input (w/ Cache Write)"   → cache-write rate
   *   cacheReadTokens   ↔ CSV "Cache Read"
   *   outputTokens      ↔ CSV "Output Tokens"
   */
  function getEventTokenBreakdown(event) {
    const usage = event?.tokenUsage && typeof event.tokenUsage === "object" ? event.tokenUsage : event || {};
    const uncachedInputTokens = Number(
      usage.uncachedInputTokens ?? usage.inputTokens ?? event?.uncachedInputTokens,
    ) || 0;
    const cacheWriteTokens = Number(usage.cacheWriteTokens ?? event?.cacheWriteTokens) || 0;
    const cacheReadTokens = Number(usage.cacheReadTokens ?? event?.cacheReadTokens) || 0;
    const outputTokens = Number(usage.outputTokens ?? event?.outputTokens) || 0;
    return {
      uncachedInputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens: uncachedInputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
    };
  }

  function normalizePricingKey(name) {
    return String(name || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function lookupAlias(key, pricing) {
    const aliases = pricing?.aliases || {};
    if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
    return undefined;
  }

  function materializeResolved(catalogKey, entry, options, pricing) {
    if (!entry || entry.unpriced || entry.input == null) {
      return {
        catalogKey: catalogKey || null,
        unpriced: true,
        reason: entry?.reason || entry?.notes || "unknown-model",
        thirdParty: Boolean(entry?.thirdParty),
        wantsFast: Boolean(options.wantsFast),
        autoRouted: Boolean(options.autoRouted),
        modelName: options.modelName,
      };
    }

    let ratesEntry = entry;
    let appliedFastMultiplier = 1;
    const wantsFast = Boolean(options.wantsFast);

    if (wantsFast) {
      const fastKey = `${catalogKey}-fast`;
      if (pricing.models[fastKey] && pricing.models[fastKey].input != null) {
        ratesEntry = pricing.models[fastKey];
        catalogKey = fastKey;
      } else if (Number.isFinite(Number(entry.fastMultiplier)) && Number(entry.fastMultiplier) > 0) {
        appliedFastMultiplier = Number(entry.fastMultiplier);
      } else {
        return {
          catalogKey,
          unpriced: true,
          reason: "unknown-fast-rate",
          thirdParty: Boolean(entry.thirdParty),
          wantsFast: true,
          autoRouted: Boolean(options.autoRouted),
          modelName: options.modelName,
        };
      }
    }

    return {
      catalogKey,
      unpriced: false,
      reason: null,
      thirdParty: Boolean(ratesEntry.thirdParty),
      wantsFast,
      autoRouted: Boolean(options.autoRouted),
      appliedFastMultiplier,
      input: Number(ratesEntry.input),
      cacheWrite: ratesEntry.cacheWrite == null ? null : Number(ratesEntry.cacheWrite),
      cacheRead: Number(ratesEntry.cacheRead),
      output: Number(ratesEntry.output),
      modelName: options.modelName,
    };
  }

  function resolveModelPricing(modelName, pricing = MODEL_PRICING) {
    const original = String(modelName || "").trim();
    if (!original) {
      return { unpriced: true, reason: "empty-model", modelName: original };
    }

    const lower = normalizePricingKey(original);
    const aliasHit = lookupAlias(lower, pricing);
    if (aliasHit != null) {
      if (typeof aliasHit === "string") {
        return materializeResolved(aliasHit, pricing.models[aliasHit], { modelName: original }, pricing);
      }
      if (aliasHit.unpriced) {
        return {
          catalogKey: null,
          unpriced: true,
          reason: aliasHit.reason || "unpriced-alias",
          thirdParty: false,
          wantsFast: Boolean(aliasHit.wantsFast),
          autoRouted: Boolean(aliasHit.autoRouted),
          modelName: original,
        };
      }
      return materializeResolved(
        aliasHit.model,
        pricing.models[aliasHit.model],
        {
          modelName: original,
          wantsFast: Boolean(aliasHit.wantsFast),
          autoRouted: Boolean(aliasHit.autoRouted),
        },
        pricing,
      );
    }

    const autoMatch = lower.match(/^(.*?)\s*\(auto(?:\s+(balanced|intelligence|cost))?\)$/);
    if (autoMatch) {
      const mode = autoMatch[2] || "";
      if (!mode || mode === "cost") {
        return {
          catalogKey: null,
          unpriced: true,
          reason: mode === "cost" ? "auto-cost-no-public-rates" : "auto-unresolved",
          thirdParty: false,
          autoRouted: true,
          modelName: original,
        };
      }
      const inner = autoMatch[1].trim();
      const innerResolved = resolveModelPricing(inner, pricing);
      return {
        ...innerResolved,
        autoRouted: true,
        modelName: original,
        reason: innerResolved.unpriced
          ? innerResolved.reason || "auto-unresolved-third-party"
          : innerResolved.reason,
      };
    }

    if (pricing.models[lower]) {
      return materializeResolved(lower, pricing.models[lower], { modelName: original }, pricing);
    }

    let key = lower.replace(/_/g, "-");
    let wantsFast = false;
    if (/(?:^|[\s-])fast\??$/.test(key) || key.endsWith("-fast") || key.includes("-fast-")) {
      wantsFast = true;
      key = key
        .replace(/-fast(?=-|$)/g, "")
        .replace(/\s*fast\??$/g, "")
        .replace(/--+/g, "-")
        .replace(/^-|-$/g, "")
        .trim();
    }

    const stripped = key
      .replace(/-thinking(?:-(?:high|medium|low))?/g, "")
      .replace(/-(?:high|medium|low)$/g, "")
      .replace(/--+/g, "-")
      .replace(/^-|-$/g, "");

    const candidates = [key, stripped, stripped.replace(/\s+/g, "-")];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const candidateAlias = lookupAlias(candidate, pricing);
      if (typeof candidateAlias === "string" && pricing.models[candidateAlias]) {
        return materializeResolved(
          candidateAlias,
          pricing.models[candidateAlias],
          { modelName: original, wantsFast },
          pricing,
        );
      }
      if (pricing.models[candidate]) {
        return materializeResolved(
          candidate,
          pricing.models[candidate],
          { modelName: original, wantsFast },
          pricing,
        );
      }
    }

    return {
      catalogKey: null,
      unpriced: true,
      reason: "unknown-model",
      thirdParty: false,
      wantsFast,
      modelName: original,
    };
  }

  /**
   * Catalog estimate for a single usage event (emergency fallback only).
   * Paid estimate only for On-Demand / USAGE_BASED. Included & Errored → $0 paid.
   * Max Mode +20 % is legacy-only and is never applied here (new pricing).
   */
  function estimateEventOnDemandPrice(event, pricing = MODEL_PRICING) {
    if (isIncludedEvent(event)) {
      return { status: "included", dollars: 0, paidEstimate: 0, source: "included", model: event?.model || null };
    }
    if (isErroredNoChargeEvent(event)) {
      return { status: "errored", dollars: 0, paidEstimate: 0, source: "errored", model: event?.model || null };
    }
    if (!isOnDemandEvent(event)) {
      return {
        status: "unpriced",
        dollars: null,
        paidEstimate: null,
        reason: "not-on-demand",
        source: null,
        model: event?.model || null,
      };
    }

    const resolved = resolveModelPricing(event?.model, pricing);
    if (resolved.unpriced) {
      return {
        status: "unpriced",
        dollars: null,
        paidEstimate: null,
        reason: resolved.reason || "unknown-model",
        source: null,
        model: event?.model || null,
        catalogKey: resolved.catalogKey,
      };
    }

    const tokens = getEventTokenBreakdown(event);
    const mult = resolved.appliedFastMultiplier || 1;
    const cacheWriteRate = resolved.cacheWrite == null ? resolved.input : resolved.cacheWrite;
    let dollars =
      (tokens.cacheWriteTokens * cacheWriteRate * mult +
        tokens.uncachedInputTokens * resolved.input * mult +
        tokens.cacheReadTokens * resolved.cacheRead * mult +
        tokens.outputTokens * resolved.output * mult) /
      1_000_000;

    let cursorTokenFee = 0;
    if (resolved.thirdParty) {
      cursorTokenFee = (tokens.totalTokens * Number(pricing.cursorTokenRatePerMillion || 0)) / 1_000_000;
      dollars += cursorTokenFee;
    }

    return {
      status: "priced",
      dollars,
      paidEstimate: dollars,
      reason: null,
      source: "catalog-estimate",
      model: event?.model || null,
      catalogKey: resolved.catalogKey,
      appliedFastMultiplier: mult,
      appliedCursorTokenRate: Boolean(resolved.thirdParty),
      cursorTokenFee,
      autoRouted: Boolean(resolved.autoRouted),
      tokens,
    };
  }

  /**
   * Primary paid-cost resolver for UI sums.
   * 1) Included / Errored → $0
   * 2) On-Demand native chargedCents → Cost dollars (unknown model still priced)
   * 3) Missing native Cost → catalog estimator only if PRICE_ESTIMATION_FALLBACK_ENABLED
   * 4) Otherwise unpriced (`—`), never invent $0
   */
  function resolveEventPaidCost(event, pricing = MODEL_PRICING, options = {}) {
    const fallbackEnabled = options.fallbackEnabled ?? PRICE_ESTIMATION_FALLBACK_ENABLED;

    if (isIncludedEvent(event)) {
      return {
        status: "included",
        dollars: 0,
        paidEstimate: 0,
        source: "included",
        model: event?.model || null,
      };
    }
    if (isErroredNoChargeEvent(event)) {
      return {
        status: "errored",
        dollars: 0,
        paidEstimate: 0,
        source: "errored",
        model: event?.model || null,
      };
    }
    if (!isOnDemandEvent(event)) {
      return {
        status: "unpriced",
        dollars: null,
        paidEstimate: null,
        reason: "not-on-demand",
        source: null,
        model: event?.model || null,
      };
    }

    const nativeDollars = parseNativeChargedCostDollars(event);
    if (nativeDollars != null) {
      return {
        status: "priced",
        dollars: nativeDollars,
        paidEstimate: nativeDollars,
        source: "native-chargedCents",
        model: event?.model || null,
      };
    }

    if (fallbackEnabled) {
      return estimateEventOnDemandPrice(event, pricing);
    }

    return {
      status: "unpriced",
      dollars: null,
      paidEstimate: null,
      reason: "missing-native-cost",
      source: null,
      model: event?.model || null,
    };
  }

  function summarizeOnDemandEstimates(events, pricing = MODEL_PRICING, options = {}) {
    let pricedCount = 0;
    let unpricedCount = 0;
    let onDemandCount = 0;
    let estimatedDollars = 0;
    const unpricedModels = new Set();

    for (const event of events || []) {
      if (!isOnDemandEvent(event)) continue;
      onDemandCount += 1;
      const estimate = resolveEventPaidCost(event, pricing, options);
      if (estimate.status === "priced") {
        pricedCount += 1;
        estimatedDollars += estimate.dollars;
      } else {
        unpricedCount += 1;
        if (event?.model) unpricedModels.add(String(event.model));
      }
    }

    return {
      onDemandCount,
      pricedCount,
      unpricedCount,
      estimatedDollars,
      coverageRatio: onDemandCount ? pricedCount / onDemandCount : null,
      unpricedModels: [...unpricedModels].sort(),
    };
  }

  /** Token API-rate value (not invoice). Sum duplicate modelIntent across tiers. */
  function accumulateModelUsageValue(aggregations) {
    const modelUsageValue = {};
    for (const row of aggregations || []) {
      const name = String(row.modelIntent || "").trim();
      if (!name) continue;
      modelUsageValue[name] = (modelUsageValue[name] || 0) + centsToDollars(row.totalCents);
    }
    return modelUsageValue;
  }

  // Back-compat alias for tests / callers that still say "spend" meaning usage value.
  function accumulateModelSpend(aggregations) {
    return accumulateModelUsageValue(aggregations);
  }

  function parseAggregatedDay(aggResponse) {
    return {
      usageValue: centsToDollars(aggResponse?.totalCostCents),
      modelUsageValue: accumulateModelUsageValue(aggResponse?.aggregations),
      // Legacy keys kept so older tests / overlays keep working if referenced.
      spend: centsToDollars(aggResponse?.totalCostCents),
      modelSpend: accumulateModelUsageValue(aggResponse?.aggregations),
    };
  }

  function monthModelSpendFromAggregated(aggResponse) {
    return accumulateModelUsageValue(aggResponse?.aggregations);
  }

  function formatDollars(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value) || 0);
  }

  function formatMoneyOrUnavailable(value) {
    if (value == null || !Number.isFinite(Number(value))) return "N/A";
    return formatDollars(Number(value));
  }

  /**
   * Greasemonkey/Firefox sandbox `window.fetch` is often read-only.
   * Page requests use the page window (`unsafeWindow`); install the interceptor there.
   */
  function resolvePageWindow(scopeWindow, grantedUnsafeWindow) {
    try {
      if (grantedUnsafeWindow != null) {
        return grantedUnsafeWindow;
      }
    } catch {
      // unsafeWindow can throw in locked-down environments
    }
    return scopeWindow;
  }

  function isRequestLike(input) {
    return Boolean(
      input &&
        typeof input === "object" &&
        typeof input.url === "string" &&
        typeof input.clone === "function" &&
        typeof input.text === "function",
    );
  }

  function isUsageRequest(input, baseOrigin) {
    const url = typeof input === "string" ? input : input?.url;
    if (!url) return false;

    try {
      return new URL(url, baseOrigin || "https://cursor.com").pathname === USAGE_ENDPOINT;
    } catch {
      return false;
    }
  }

  async function readRequestBody(input, init) {
    // Firefox Xray may deny reading Request/init `.body` across compartments.
    try {
      let body;
      try {
        body = init == null ? undefined : init.body;
      } catch {
        body = undefined;
      }
      if (typeof body === "string") {
        return body;
      }
    } catch {
      // ignore
    }

    // Duck-type Request: `instanceof Request` fails across sandbox/page compartments.
    if (isRequestLike(input)) {
      try {
        return await input.clone().text();
      } catch {
        return "";
      }
    }

    return "";
  }

  /**
   * Clone fetch init into the page compartment so Firefox's native fetch can read
   * `.body` / headers. Sandbox plain objects throw
   * `Permission denied to access property "body"`.
   */
  function cloneFetchInitForPage(pageWindow, init) {
    if (init == null) return init;
    if (typeof cloneInto === "function") {
      try {
        return cloneInto(init, pageWindow, { cloneFunctions: true });
      } catch {
        // fall through
      }
    }
    return init;
  }

  function installPageFetchInterceptor(pageWindow, hooks, options = {}) {
    if (typeof pageWindow?.fetch !== "function") {
      throw new Error("Cursor Usage Statistics: page fetch is unavailable.");
    }

    const originalFetch = pageWindow.fetch;
    const boundFetch = originalFetch.bind(pageWindow);
    function nativeFetch(input, init) {
      return boundFetch(input, cloneFetchInitForPage(pageWindow, init));
    }

    /**
     * Must stay non-async and must return the page-compartment Promise from native
     * fetch unmodified. Calling `.then()` / using `async` here creates a sandbox
     * Promise; Firefox then throws "Permission denied to access object" when page
     * code (Statsig, analytics, Next.js) touches it.
     * @see https://aweirdimagination.net/2024/05/19/monkey-patching-async-functions-in-user-scripts/
     * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts#promise_cloning
     */
    function cursorUsageFetchInterceptor(input, init) {
      if (hooks.isUsageRequest(input)) {
        void Promise.resolve(hooks.readRequestBody(input, init))
          .then(hooks.captureRequestContext)
          .catch(() => {});
      }

      return nativeFetch(input, init);
    }

    const exportFn = typeof options.exportFunction === "function"
      ? options.exportFunction
      : typeof exportFunction === "function"
        ? exportFunction
        : null;

    let installed = cursorUsageFetchInterceptor;
    if (exportFn) {
      try {
        installed = exportFn(cursorUsageFetchInterceptor, pageWindow);
      } catch {
        installed = cursorUsageFetchInterceptor;
      }
    }

    try {
      pageWindow.fetch = installed;
    } catch {
      try {
        Object.defineProperty(pageWindow, "fetch", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: installed,
        });
      } catch {
        // Final equality check below surfaces a clear error.
      }
    }

    if (pageWindow.fetch === originalFetch) {
      throw new Error(
        "Cursor Usage Statistics: unable to install fetch interceptor on the page window (fetch is not patchable).",
      );
    }

    return { nativeFetch, interceptor: installed, pageWindow };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      VERSION,
      USAGE_ENDPOINT,
      AGG_ENDPOINT,
      SUMMARY_ENDPOINT,
      UNAVAILABLE,
      ON_DEMAND_KIND,
      INCLUDED_KIND,
      ERRORED_KIND,
      MODEL_PRICING,
      PRICE_ESTIMATION_FALLBACK_ENABLED,
      PRICE_DISCLAIMER_CS,
      SHORT_NOTICE_CS,
      CHANGELOG,
      centsToDollars,
      getChargedDollars,
      sumEventChargedDollars,
      hasNativeChargedCents,
      parseNativeChargedCostDollars,
      parseUsageSummary,
      isOnDemandEvent,
      isIncludedEvent,
      isErroredNoChargeEvent,
      getEventTokenBreakdown,
      resolveModelPricing,
      estimateEventOnDemandPrice,
      resolveEventPaidCost,
      summarizeOnDemandEstimates,
      accumulateModelUsageValue,
      accumulateModelSpend,
      parseAggregatedDay,
      monthModelSpendFromAggregated,
      formatDollars,
      formatMoneyOrUnavailable,
      resolvePageWindow,
      isUsageRequest,
      readRequestBody,
      isRequestLike,
      installPageFetchInterceptor,
      cloneFetchInitForPage,
    };
    return;
  }

  const PANEL_ID = "gm-cursor-usage-statistics";
  const STYLE_ID = `${PANEL_ID}-style`;
  const USAGE_PATH = "/dashboard/usage";
  const PAGE_SIZE = 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MODEL_COLORS = ["#7c3aed", "#2563eb", "#0891b2", "#16a34a", "#f59e0b"];
  const OTHER_MODEL_COLOR = "#9ca3af";

  const pageWindow = resolvePageWindow(
    window,
    typeof unsafeWindow !== "undefined" ? unsafeWindow : undefined,
  );

  let requestContext = null;
  let currentData = null;
  let chartRangeDays = 7;
  let chartMetric = "tokens";
  const hiddenChartModels = new Set();
  let loading = false;
  let reloadTimer = null;

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

  const { nativeFetch } = installPageFetchInterceptor(pageWindow, {
    isUsageRequest: (input) => isUsageRequest(input, location.origin),
    readRequestBody,
    captureRequestContext,
  });

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

  async function fetchAggregatedUsage(startDate, endDate) {
    const response = await nativeFetch(AGG_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...requestContext,
        startDate: String(startDate),
        endDate: String(endDate),
      }),
    });

    if (!response.ok) {
      throw new Error(`Cursor aggregate API vrátilo HTTP ${response.status}.`);
    }

    return response.json();
  }

  async function fetchUsageSummary() {
    const response = await nativeFetch(SUMMARY_ENDPOINT, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error(`Cursor usage-summary API vrátilo HTTP ${response.status}.`);
    }
    return response.json();
  }

  function applyUsageValueOverlay(data, dailyByKey, cycleModelUsageValue) {
    for (const day of data.days) {
      const agg = dailyByKey[day.key];
      if (!agg) continue;
      day.usageValue = agg.usageValue;
      day.modelUsageValue = { ...agg.modelUsageValue };
      // Keep day.spend / modelSpend as native on-demand Cost sums (not aggregate).
      if (day.estimatedOnDemandSpend == null) day.estimatedOnDemandSpend = 0;
      day.spend = day.estimatedOnDemandSpend;
      day.modelSpend = { ...(day.modelEstimatedOnDemandSpend || {}) };
    }

    const seen = new Set();
    for (const model of data.models) {
      seen.add(model.name);
      if (!Object.prototype.hasOwnProperty.call(cycleModelUsageValue, model.name)) continue;
      model.usageValue = cycleModelUsageValue[model.name];
      if (model.usageValue > 0 && model.valuedCalls === 0) {
        model.valuedCalls = model.calls;
      }
      model.paidCalls = model.valuedCalls;
      // model.spend stays as native on-demand Cost dollars when present.
      if (model.estimatedOnDemandSpend == null) model.estimatedOnDemandSpend = 0;
      model.spend = model.estimatedOnDemandSpend;
    }

    for (const [name, usageValue] of Object.entries(cycleModelUsageValue)) {
      if (usageValue <= 0 || seen.has(name)) continue;
      data.models.push({
        name,
        calls: 0,
        onDemandCalls: 0,
        pricedOnDemandCalls: 0,
        unpricedOnDemandCalls: 0,
        valuedCalls: 0,
        paidCalls: 0,
        tokens: 0,
        usageValue,
        estimatedOnDemandSpend: 0,
        spend: 0,
      });
    }

    data.models.sort(
      (left, right) =>
        (right.estimatedOnDemandSpend || 0) - (left.estimatedOnDemandSpend || 0) ||
        (right.usageValue || 0) - (left.usageValue || 0) ||
        right.tokens - left.tokens,
    );

    const todayStart = utcDayStart(new Date(data.updatedAt));
    const sevenDayStart = todayStart - 6 * DAY_MS;
    const cycleDays = data.days.filter((day) => day.timestamp >= data.billingCycleStart);
    const sevenDays = data.days.filter((day) => day.timestamp >= sevenDayStart);
    const today = data.days.find((day) => day.key === utcDayKey(todayStart));
    const sumUsageValue = (days) => days.reduce((sum, day) => sum + (day.usageValue || 0), 0);
    const elapsedDays = Math.max(1, Math.floor((todayStart - data.billingCycleStart) / DAY_MS) + 1);

    data.todayUsageValue = today ? today.usageValue || 0 : 0;
    data.sevenDayUsageValue = sumUsageValue(sevenDays);
    data.cycleUsageValue = sumUsageValue(cycleDays);
    data.dailyAverageUsageValue = data.cycleUsageValue / elapsedDays;
    // Compatibility aliases used by older probes — always usage value, never paid.
    data.todaySpend = data.todayUsageValue;
    data.sevenDaySpend = data.sevenDayUsageValue;
    data.monthSpend = data.cycleUsageValue;
    data.dailyAverage = data.dailyAverageUsageValue;
    data.sevenDays = sevenDays;
    data.usageValueSource = "aggregated";
    // Paid Cost remains native chargedCents; aggregate overlay is included usage value only.
    if (!data.costSource) data.costSource = "native-chargedCents";
    return data;
  }

  async function loadUsageValueOverlay(dataStart, todayStart, cycleStart, now) {
    const dayStarts = [];
    for (let timestamp = dataStart; timestamp <= todayStart; timestamp += DAY_MS) {
      dayStarts.push(timestamp);
    }

    const [cycleAgg, ...dayAggs] = await Promise.all([
      fetchAggregatedUsage(cycleStart, now),
      ...dayStarts.map((timestamp) => fetchAggregatedUsage(timestamp, Math.min(timestamp + DAY_MS - 1, now))),
    ]);

    const dailyByKey = {};
    dayStarts.forEach((timestamp, index) => {
      dailyByKey[utcDayKey(timestamp)] = parseAggregatedDay(dayAggs[index]);
    });

    return {
      dailyByKey,
      cycleModelUsageValue: monthModelSpendFromAggregated(cycleAgg),
      cycleUsageValueTotal: centsToDollars(cycleAgg?.totalCostCents),
    };
  }

  async function loadStatistics() {
    // Sibling dashboard routes also hit the usage API; don't fetch every page there.
    if (!requestContext || loading || !isUsagePage()) return;

    loading = true;
    renderLoading();

    try {
      const now = Date.now();
      const todayStart = utcDayStart(new Date(now));
      const calendarMonthStart = utcMonthStart(new Date(now));

      let summaryInfo = parseUsageSummary(null);
      try {
        summaryInfo = parseUsageSummary(await fetchUsageSummary());
      } catch {
        // Paid KPIs stay N/A; usage-value path can still work from aggregate.
      }

      const billingCycleStart = summaryInfo.billingCycleStart ?? calendarMonthStart;
      const startDate = Math.min(billingCycleStart, todayStart - 29 * DAY_MS);
      const firstPage = await fetchUsagePage(1, startDate, now);
      const total = Number(firstPage.totalUsageEventsCount) || 0;
      const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const remainingPages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, index) => fetchUsagePage(index + 2, startDate, now)),
      );
      const events = [
        ...(firstPage.usageEventsDisplay || []),
        ...remainingPages.flatMap((page) => page.usageEventsDisplay || []),
      ];

      let statistics = buildStatistics(events, now, {
        billingCycleStart,
        billingCycleEnd: summaryInfo.billingCycleEnd,
        paidSpendCycle: summaryInfo.paidSpendCycle,
        includedUsageCycle: summaryInfo.includedUsageCycle,
        totalUsageCycle: summaryInfo.totalUsageCycle,
        paidSpendDailyAvailable: summaryInfo.paidSpendDailyAvailable,
        paidSpendPerModelAvailable: summaryInfo.paidSpendPerModelAvailable,
      });

      // Aggregate totalCostCents prices *included* events only (on-demand events
      // return 0 cents), so it tracks plan.breakdown.total, not the invoice.
      // Never promote it to “Útrata” / paid spend.
      try {
        const overlay = await loadUsageValueOverlay(startDate, todayStart, billingCycleStart, now);
        statistics = applyUsageValueOverlay(statistics, overlay.dailyByKey, overlay.cycleModelUsageValue);
        if (statistics.includedUsageCycle == null && overlay.cycleUsageValueTotal != null) {
          statistics.includedUsageCycle = overlay.cycleUsageValueTotal;
          statistics.planUsageValueCycle = overlay.cycleUsageValueTotal;
        }
      } catch (aggregateError) {
        // Aggregate overlay is optional; native Cost sums from events already apply.
        statistics.usageValueSource = null;
        if (!statistics.costSource) statistics.costSource = "native-chargedCents";
        statistics.usageValueError = String(aggregateError?.message || aggregateError);
      }

      currentData = statistics;
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

  function createEmptyDay(timestamp) {
    return {
      key: utcDayKey(timestamp),
      timestamp,
      tokens: 0,
      usageValue: 0,
      estimatedOnDemandSpend: 0,
      spend: 0,
      calls: 0,
      modelTokens: {},
      modelUsageValue: {},
      modelEstimatedOnDemandSpend: {},
      modelSpend: {},
    };
  }

  function buildStatistics(events, now, summaryMeta = {}) {
    const todayStart = utcDayStart(new Date(now));
    const sevenDayStart = todayStart - 6 * DAY_MS;
    const thirtyDayStart = todayStart - 29 * DAY_MS;
    const billingCycleStart = summaryMeta.billingCycleStart ?? utcMonthStart(new Date(now));
    const dataStart = Math.min(billingCycleStart, thirtyDayStart);
    const daily = new Map();
    const models = new Map();
    let cycleEventCount = 0;
    let cycleOnDemandCalls = 0;
    let cyclePricedOnDemandCalls = 0;
    let cycleUnpricedOnDemandCalls = 0;
    let estimatedOnDemandCycle = 0;
    let estimatedOnDemandToday = 0;
    let estimatedOnDemandSevenDay = 0;
    const unpricedModels = new Set();

    for (let timestamp = dataStart; timestamp <= todayStart; timestamp += DAY_MS) {
      const day = createEmptyDay(timestamp);
      daily.set(day.key, day);
    }

    for (const event of events) {
      const timestamp = Number(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < dataStart || timestamp > now) continue;

      const tokens = getTokenCount(event);
      const modelName = String(event.model || "Neznámý model");
      const estimate = resolveEventPaidCost(event);
      const day = daily.get(utcDayKey(timestamp));
      if (day) {
        day.tokens += tokens;
        day.calls += 1;
        day.modelTokens[modelName] = (day.modelTokens[modelName] || 0) + tokens;
        if (estimate.status === "priced") {
          day.estimatedOnDemandSpend += estimate.dollars;
          day.modelEstimatedOnDemandSpend[modelName] =
            (day.modelEstimatedOnDemandSpend[modelName] || 0) + estimate.dollars;
          // Chart "Cena" metric reads spend / modelSpend (native Cost sums).
          day.spend = day.estimatedOnDemandSpend;
          day.modelSpend[modelName] = day.modelEstimatedOnDemandSpend[modelName];
        }
      }

      if (estimate.status === "priced") {
        if (timestamp >= todayStart) estimatedOnDemandToday += estimate.dollars;
        if (timestamp >= sevenDayStart) estimatedOnDemandSevenDay += estimate.dollars;
      }

      if (timestamp < billingCycleStart) continue;
      cycleEventCount += 1;
      const model = models.get(modelName) || {
        name: modelName,
        calls: 0,
        onDemandCalls: 0,
        pricedOnDemandCalls: 0,
        unpricedOnDemandCalls: 0,
        valuedCalls: 0,
        paidCalls: 0,
        tokens: 0,
        usageValue: 0,
        estimatedOnDemandSpend: 0,
        spend: 0,
      };
      model.calls += 1;
      model.tokens += tokens;

      if (isOnDemandEvent(event)) {
        cycleOnDemandCalls += 1;
        model.onDemandCalls += 1;
        if (estimate.status === "priced") {
          cyclePricedOnDemandCalls += 1;
          model.pricedOnDemandCalls += 1;
          model.estimatedOnDemandSpend += estimate.dollars;
          estimatedOnDemandCycle += estimate.dollars;
        } else {
          cycleUnpricedOnDemandCalls += 1;
          model.unpricedOnDemandCalls += 1;
          unpricedModels.add(modelName);
        }
      }

      models.set(modelName, model);
    }

    const allDays = [...daily.values()];
    const sevenDays = allDays.filter((day) => day.timestamp >= sevenDayStart);
    const coverageRatio = cycleOnDemandCalls ? cyclePricedOnDemandCalls / cycleOnDemandCalls : null;

    return {
      updatedAt: now,
      billingCycleStart,
      billingCycleEnd: summaryMeta.billingCycleEnd ?? UNAVAILABLE,
      monthStart: billingCycleStart,
      // Exact cycle KPI from billing API — may differ from event-sum below (range/pagination/timing).
      paidSpendCycle: summaryMeta.paidSpendCycle ?? UNAVAILABLE,
      paidSpendToday: estimatedOnDemandToday,
      paidSpendSevenDay: estimatedOnDemandSevenDay,
      paidSpendDailyAvailable: true,
      paidSpendPerModelAvailable: true,
      estimatedOnDemandToday,
      estimatedOnDemandSevenDay,
      estimatedOnDemandCycle,
      estimateCoverage: {
        onDemandCount: cycleOnDemandCalls,
        pricedCount: cyclePricedOnDemandCalls,
        unpricedCount: cycleUnpricedOnDemandCalls,
        coverageRatio,
        unpricedModels: [...unpricedModels].sort(),
      },
      includedUsageCycle: summaryMeta.includedUsageCycle ?? UNAVAILABLE,
      totalUsageCycle: summaryMeta.totalUsageCycle ?? UNAVAILABLE,
      planUsageValueCycle: summaryMeta.includedUsageCycle ?? UNAVAILABLE,
      todayUsageValue: 0,
      sevenDayUsageValue: 0,
      cycleUsageValue: 0,
      dailyAverageUsageValue: 0,
      todaySpend: estimatedOnDemandToday,
      sevenDaySpend: estimatedOnDemandSevenDay,
      monthSpend: 0,
      dailyAverage: 0,
      sevenDays,
      days: allDays,
      models: [...models.values()].sort(
        (left, right) =>
          (right.estimatedOnDemandSpend || 0) - (left.estimatedOnDemandSpend || 0) ||
          right.tokens - left.tokens,
      ),
      eventCount: cycleEventCount,
      onDemandCallCount: cycleOnDemandCalls,
      usageValueSource: null,
      costSource: "native-chargedCents",
    };
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
    let style = document.getElementById(STYLE_ID);
    if (style?.dataset?.gmVersion === VERSION) return;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.dataset.gmVersion = VERSION;
    style.textContent = `
      #${PANEL_ID} {
        --gm-bg: #ffffff;
        --gm-bg-subtle: #f5f5f5;
        --gm-text: #141414;
        --gm-muted: #6b7280;
        --gm-border: #e5e7eb;
        --gm-accent: #7c3aed;
        --gm-accent-soft: #ede9fe;
        margin-bottom: 20px;
        padding: 18px 20px 16px;
        border-radius: 12px;
        background: var(--gm-bg);
        color: var(--gm-text);
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 0 0 1px var(--gm-border);
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
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      #${PANEL_ID} .gm-cus-title {
        margin: 0;
        font-size: 16px;
        font-weight: 650;
        line-height: 1.25;
      }
      #${PANEL_ID} .gm-cus-subtitle {
        margin-top: 2px;
        color: var(--gm-muted);
        font-size: 12px;
        line-height: 1.35;
      }
      #${PANEL_ID} .gm-cus-header-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
      }
      #${PANEL_ID} .gm-cus-refresh,
      #${PANEL_ID} .gm-cus-help-button {
        min-width: 30px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--gm-border);
        border-radius: 7px;
        background: var(--gm-bg-subtle);
        color: var(--gm-text);
        cursor: pointer;
        font: inherit;
        line-height: 1;
      }
      #${PANEL_ID} .gm-cus-help-button {
        font-weight: 700;
      }
      #${PANEL_ID} .gm-cus-refresh:hover,
      #${PANEL_ID} .gm-cus-help-button:hover { border-color: var(--gm-accent); }
      #${PANEL_ID} .gm-cus-notice {
        margin: 0 0 12px;
        color: var(--gm-muted);
        font-size: 11px;
        line-height: 1.4;
      }
      #${PANEL_ID} .gm-cus-disclaimer {
        margin: 8px 2px 12px;
        color: var(--gm-muted);
        font-size: 11px;
        line-height: 1.4;
      }
      #${PANEL_ID} .gm-cus-disclaimer a {
        color: var(--gm-accent);
      }
      #${PANEL_ID} .gm-cus-disclaimer .gm-cus-help-button {
        min-width: 22px;
        height: 20px;
        margin-left: 4px;
        padding: 0 6px;
        vertical-align: middle;
        font-size: 11px;
      }
      #${PANEL_ID} .gm-cus-help-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.45);
      }
      #${PANEL_ID} .gm-cus-help-modal {
        width: min(560px, 100%);
        max-height: min(80vh, 720px);
        overflow: auto;
        padding: 18px 18px 16px;
        border-radius: 12px;
        background: var(--gm-bg);
        color: var(--gm-text);
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
        border: 1px solid var(--gm-border);
      }
      #${PANEL_ID} .gm-cus-help-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      #${PANEL_ID} .gm-cus-help-title {
        margin: 0;
        font-size: 15px;
        font-weight: 650;
      }
      #${PANEL_ID} .gm-cus-help-close {
        min-width: 32px;
        height: 30px;
        border: 1px solid var(--gm-border);
        border-radius: 7px;
        background: var(--gm-bg-subtle);
        color: var(--gm-text);
        cursor: pointer;
        font: inherit;
      }
      #${PANEL_ID} .gm-cus-help-section {
        margin: 0 0 12px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--gm-text);
      }
      #${PANEL_ID} .gm-cus-help-section h4 {
        margin: 0 0 6px;
        font-size: 12px;
        font-weight: 650;
      }
      #${PANEL_ID} .gm-cus-help-section p,
      #${PANEL_ID} .gm-cus-help-section ul {
        margin: 0 0 6px;
        color: var(--gm-muted);
      }
      #${PANEL_ID} .gm-cus-help-section ul {
        padding-left: 18px;
      }
      #${PANEL_ID} .gm-cus-help-section a {
        color: var(--gm-accent);
      }
      #${PANEL_ID} .gm-cus-help-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
      }
      #${PANEL_ID} .gm-cus-kpis {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .gm-cus-kpi {
        min-width: 0;
        padding: 12px 13px;
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
      #${PANEL_ID} .gm-cus-kpi-value[data-na="true"] {
        color: var(--gm-muted);
        font-size: 18px;
        font-weight: 600;
      }
      #${PANEL_ID} .gm-cus-kpi-hint {
        margin-top: 3px;
        color: var(--gm-muted);
        font-size: 10px;
        line-height: 1.3;
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
        margin: 8px 2px 0;
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
        max-height: 280px;
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
        padding: 7px 10px;
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
        #${PANEL_ID} { padding: 14px; }
        #${PANEL_ID} .gm-cus-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        #${PANEL_ID} .gm-cus-section-head { align-items: flex-start; flex-direction: column; }
        #${PANEL_ID} .gm-cus-chart { gap: 3px; padding-inline: 5px; }
        #${PANEL_ID} .gm-cus-day { grid-template-rows: 18px 100px 18px 16px; }
        #${PANEL_ID} .gm-cus-bar-slot { height: 100px; }
        #${PANEL_ID} .gm-cus-table-wrap { overflow-x: auto; }
      }
    `;
  }

  function isUsagePage() {
    return location.pathname === USAGE_PATH || location.pathname.startsWith(`${USAGE_PATH}/`);
  }

  function findMountAnchor() {
    const description = document.getElementById("table-description");
    return description?.closest(".dashboard-table-card")?.parentElement || null;
  }

  function ensurePanel() {
    // Other dashboard routes render similar tables, so the panel must stay usage-only.
    if (!isUsagePage()) return null;

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
        <div class="gm-cus-header-actions">
          <button class="gm-cus-help-button" type="button" title="Nápověda a changelog" aria-label="Nápověda a changelog">?</button>
          <button class="gm-cus-refresh" type="button" title="Obnovit statistiky" aria-label="Obnovit statistiky">↻</button>
        </div>
      </div>
    `;
  }

  function closeHelpModal(panel) {
    panel?.querySelector(".gm-cus-help-backdrop")?.remove();
    if (panel?._gmHelpEscape) {
      document.removeEventListener("keydown", panel._gmHelpEscape);
      panel._gmHelpEscape = null;
    }
  }

  function openHelpModal(panel, data) {
    if (!panel) return;
    closeHelpModal(panel);

    const coverage = data?.estimateCoverage || {};
    const priced = coverage.pricedCount || 0;
    const total = coverage.onDemandCount || 0;
    const pct = total ? Math.round((priced / total) * 1000) / 10 : null;
    const unpriced = coverage.unpricedModels || [];

    const backdrop = document.createElement("div");
    backdrop.className = "gm-cus-help-backdrop";
    backdrop.setAttribute("role", "presentation");

    const modal = document.createElement("div");
    modal.className = "gm-cus-help-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Nápověda k usage statistikám");

    const head = document.createElement("div");
    head.className = "gm-cus-help-head";
    const title = document.createElement("h3");
    title.className = "gm-cus-help-title";
    title.textContent = `Nápověda · v${VERSION}`;
    const closeBtn = document.createElement("button");
    closeBtn.className = "gm-cus-help-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Zavřít nápovědu");
    closeBtn.textContent = "×";
    head.append(title, closeBtn);

    function addSection(heading, build) {
      const section = document.createElement("section");
      section.className = "gm-cus-help-section";
      const h = document.createElement("h4");
      h.textContent = heading;
      section.appendChild(h);
      build(section);
      modal.appendChild(section);
    }

    modal.appendChild(head);

    addSection("Exact vs nativní Cost", (section) => {
      const p1 = document.createElement("p");
      p1.textContent =
        "Skutečná útrata · cyklus pochází z usage-summary.onDemand.used (centy; ověřeno proti get-team-spend.spendCents).";
      const p2 = document.createElement("p");
      p2.textContent =
        "Denní, 7denní a modelové sumy = součet nativního sloupce Cost z get-filtered-usage-events (pole chargedCents / 100). Included a Errored/No Charge = $0 paid.";
      const p3 = document.createElement("p");
      p3.textContent =
        "Součet eventů za cyklus se může lišit od exact KPI kvůli rozsahu stránky, paginaci nebo timingu. Zahrnutá spotřeba (v tarifu · bez on-demand) = plan.breakdown.total / aggregate totalCostCents (jen Included), $0 paid.";
      const p4 = document.createElement("p");
      p4.className = "gm-cus-help-code";
      p4.textContent =
        "Cost (USD) = chargedCents / 100 · usageBasedCosts („$X.YY“) vynechává cursorTokenFee a nemusí sedět na Cost";
      section.append(p1, p2, p3, p4);
    });

    addSection("Ceník (vypnutý fallback)", (section) => {
      const p = document.createElement("p");
      const link = document.createElement("a");
      link.href = MODEL_PRICING.source;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = MODEL_PRICING.source;
      p.append(
        "Lokální katalog je nouzový fallback (PRICE_ESTIMATION_FALLBACK_ENABLED = ",
        String(PRICE_ESTIMATION_FALLBACK_ENABLED),
        "). Zdroj: ",
        link,
        ` · snapshot ${MODEL_PRICING.effectiveDate}.`,
      );
      section.appendChild(p);
    });

    addSection("Coverage nativního Cost", (section) => {
      const p = document.createElement("p");
      p.textContent = total
        ? `On-Demand eventy s vyplněným nativním Cost: ${priced} / ${total}${pct == null ? "" : ` (${pct} %).`}`
        : "V cyklu zatím nejsou on-demand eventy.";
      section.appendChild(p);
      if (unpriced.length) {
        const label = document.createElement("p");
        label.textContent = "Modely s chybějícím nativním Cost:";
        const ul = document.createElement("ul");
        for (const name of unpriced) {
          const li = document.createElement("li");
          li.textContent = name;
          ul.appendChild(li);
        }
        section.append(label, ul);
      }
    });

    addSection("Changelog", (section) => {
      const ul = document.createElement("ul");
      for (const entry of CHANGELOG) {
        const li = document.createElement("li");
        li.textContent = `${entry.version}: ${entry.text}`;
        ul.appendChild(li);
      }
      section.appendChild(ul);
    });

    backdrop.appendChild(modal);
    panel.appendChild(backdrop);

    const close = () => closeHelpModal(panel);
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    panel._gmHelpEscape = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", panel._gmHelpEscape);
    closeBtn.focus();
  }

  function bindPanelActions(panel, data) {
    panel.querySelector(".gm-cus-refresh")?.addEventListener("click", () => scheduleLoad());
    panel.querySelectorAll(".gm-cus-help-button").forEach((button) => {
      button.addEventListener("click", () => openHelpModal(panel, data || currentData));
    });
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
    panel.innerHTML = `${headerHtml("Načítám billing cyklus…")}<div class="gm-cus-status">Počítám usage události…</div>`;
  }

  function renderKpi(label, value, hint, title, options = {}) {
    const textValue = options.textValue;
    const incomplete = Boolean(options.incomplete);
    const available = textValue != null
      ? true
      : value != null && Number.isFinite(Number(value));
    let display = textValue != null
      ? String(textValue)
      : available
        ? formatDollars(Number(value))
        : "N/A";
    if (available && incomplete && textValue == null) display = `${display}*`;
    return `
      <div class="gm-cus-kpi" title="${escapeHtml(title || hint || label)}">
        <div class="gm-cus-kpi-label">${escapeHtml(label)}</div>
        <div class="gm-cus-kpi-value" data-na="${available ? "false" : "true"}">${escapeHtml(display)}</div>
        ${hint ? `<div class="gm-cus-kpi-hint">${escapeHtml(hint)}</div>` : ""}
      </div>
    `;
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
    bindPanelActions(panel, null);
  }

  function formatCoverageLabel(coverage) {
    if (!coverage || !coverage.onDemandCount) return "žádné on-demand eventy v cyklu";
    const pct = coverage.coverageRatio == null
      ? ""
      : ` (${Math.round(coverage.coverageRatio * 1000) / 10} %)`;
    return `${formatInteger(coverage.pricedCount)} / ${formatInteger(coverage.onDemandCount)} on-demand s nativním Cost${pct}`;
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
    const estimateByModel = day.modelEstimatedOnDemandSpend || day.modelSpend || {};
    return Object.entries(day.modelTokens).reduce(
      (result, [name, tokens]) => {
        if (!hiddenChartModels.has(name)) {
          result.tokens += tokens;
          result.spend += estimateByModel[name] || 0;
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
        const estimateByModel = day.modelEstimatedOnDemandSpend || day.modelSpend || {};
        const title = `${formatDay(day.timestamp, true)}: ${formatTokens(visible.tokens)} tokenů, účtovaná cena ${formatDollars(visible.spend)}`;
        const segments = series
          .map((item) => {
            let tokens = 0;
            let spend = 0;
            if (item.other) {
              for (const [name, value] of Object.entries(day.modelTokens)) {
                if (topNames.has(name) || hiddenChartModels.has(name)) continue;
                tokens += value;
                spend += estimateByModel[name] || 0;
              }
            } else if (!hiddenChartModels.has(item.name)) {
              tokens = day.modelTokens[item.name] || 0;
              spend = estimateByModel[item.name] || 0;
            }
            const segmentValue = chartMetric === "spend" ? spend : tokens;
            if (!segmentValue || !visibleValue) return "";

            const segmentTitle = `${item.name}: ${formatTokens(tokens)} tokenů, účtovaná cena ${formatDollars(spend)}`;
            return `<div class="gm-cus-segment" style="height:${(segmentValue / visibleValue) * 100}%;background:${item.color}" title="${escapeHtml(segmentTitle)}"></div>`;
          })
          .join("");
        const topLabel = chartMetric === "spend"
          ? formatDollars(visible.spend)
          : formatTokens(visible.tokens);
        return `
          <div class="gm-cus-day" title="${escapeHtml(title)}">
            <div class="gm-cus-day-cost">${escapeHtml(String(topLabel))}</div>
            <div class="gm-cus-bar-slot"><div class="gm-cus-bar" style="height:${height}%">${segments}</div></div>
            <div class="gm-cus-day-tokens">${chartMetric === "spend" ? `${formatTokens(visible.tokens)} tok.` : formatDollars(visible.spend)}</div>
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
        const estimated = model.estimatedOnDemandSpend || 0;
        const pricedOnDemand = model.pricedOnDemandCalls || 0;
        const unpricedOnDemand = model.unpricedOnDemandCalls || 0;
        const color = colorByModel.get(model.name) || OTHER_MODEL_COLOR;
        const active = !hiddenChartModels.has(model.name);
        const onDemandCalls = model.onDemandCalls || 0;
        const callsTitle = onDemandCalls
          ? `${formatInteger(model.calls)} volání · ${formatInteger(onDemandCalls)} on-demand`
          : `${formatInteger(model.calls)} volání · bez on-demand`;
        let estimateCell = "—";
        let estimateTitle = "On-demand volání bez nativního Cost (chargedCents chybí)";
        let avgOnDemandCell = "—";
        let pricePerMillionCell = "—";
        if (onDemandCalls === 0) {
          estimateCell = formatDollars(0);
          estimateTitle = "Included / bez on-demand = $0 paid";
        } else if (pricedOnDemand > 0 && unpricedOnDemand === 0) {
          estimateCell = formatDollars(estimated);
          estimateTitle = "Součet nativních On-Demand Cost (chargedCents)";
          avgOnDemandCell = formatDollars(estimated / pricedOnDemand);
          if (model.tokens) pricePerMillionCell = formatDollars((estimated / model.tokens) * 1_000_000);
        } else if (pricedOnDemand > 0) {
          estimateCell = `${formatDollars(estimated)}*`;
          estimateTitle = `Částečný nativní Cost: ${pricedOnDemand}/${onDemandCalls} on-demand s vyplněným Cost`;
          avgOnDemandCell = `${formatDollars(estimated / pricedOnDemand)}*`;
          if (model.tokens) {
            pricePerMillionCell = `${formatDollars((estimated / model.tokens) * 1_000_000)}*`;
          }
        }
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
            <td title="${escapeHtml(callsTitle)}">${formatInteger(model.calls)}</td>
            <td>${formatTokens(model.tokens)}</td>
            <td title="${escapeHtml(estimateTitle)}">${escapeHtml(estimateCell)}</td>
            <td title="Průměr nativního Cost na oceněné on-demand volání">${escapeHtml(avgOnDemandCell)}</td>
            <td title="Účtovaná cena na 1M tokenů (jen on-demand s nativním Cost)">${escapeHtml(pricePerMillionCell)}</td>
          </tr>
        `;
      })
      .join("");
  }

  function formatCycleRange(start, end) {
    const opts = { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" };
    const startLabel = new Intl.DateTimeFormat("cs-CZ", opts).format(new Date(start));
    if (end == null || !Number.isFinite(Number(end))) return startLabel;
    const endLabel = new Intl.DateTimeFormat("cs-CZ", opts).format(new Date(end));
    return `${startLabel} – ${endLabel}`;
  }

  function renderStatistics(data) {
    const panel = ensurePanel();
    if (!panel) return;
    closeHelpModal(panel);
    const chartDays = data.days.slice(-chartRangeDays);
    const chartSeries = getChartSeries(chartDays, data.models);
    const allModelsHidden = areAllChartModelsHidden(data.models);

    const cycleLabel = formatCycleRange(data.billingCycleStart, data.billingCycleEnd);
    const updatedLabel = new Intl.DateTimeFormat("cs-CZ", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(data.updatedAt));
    const coverage = data.estimateCoverage || {};
    const coverageLabel = formatCoverageLabel(coverage);
    const coverageIncomplete = Boolean(
      coverage.onDemandCount && coverage.pricedCount < coverage.onDemandCount,
    );
    const estimateUnavailable = Boolean(coverage.onDemandCount && !coverage.pricedCount);
    const todayStart = utcDayStart(new Date(data.updatedAt));
    const elapsedDays = Math.max(
      1,
      Math.floor((todayStart - data.billingCycleStart) / DAY_MS) + 1,
    );
    const estimatedDailyAverage = estimateUnavailable
      ? null
      : (data.estimatedOnDemandCycle || 0) / elapsedDays;
    const estimateHint = coverage.onDemandCount
      ? (coverageIncomplete ? `* coverage ${coverageLabel}` : null)
      : null;
    const estimateTitleSuffix = coverage.onDemandCount
      ? ` Coverage: ${coverageLabel}.`
      : " V cyklu nejsou on-demand eventy.";

    panel.innerHTML = `
      ${headerHtml(`Billing cyklus ${cycleLabel} · ${formatInteger(data.eventCount)} událostí · aktualizováno ${updatedLabel}`)}
      <div class="gm-cus-kpis">
        ${renderKpi(
          "Dnes (UTC)",
          estimateUnavailable ? null : data.estimatedOnDemandToday,
          estimateHint,
          `Součet nativních On-Demand Cost dnes (UTC).${estimateTitleSuffix}`,
          { incomplete: coverageIncomplete && !estimateUnavailable },
        )}
        ${renderKpi(
          "Posledních 7 dní",
          estimateUnavailable ? null : data.estimatedOnDemandSevenDay,
          estimateHint,
          `Součet nativních On-Demand Cost za posledních 7 dní (UTC).${estimateTitleSuffix}`,
          { incomplete: coverageIncomplete && !estimateUnavailable },
        )}
        ${renderKpi(
          "Útrata · cyklus",
          data.paidSpendCycle,
          null,
          "Exact on-demand útrata za billing cyklus z usage-summary.onDemand.used (kontrolní reference vůči get-team-spend.spendCents). Eventový součet se může lišit. Included = $0.",
        )}
        ${renderKpi(
          "Průměr / den",
          estimatedDailyAverage,
          estimateHint,
          `Součet nativních On-Demand Cost za cyklus dělený ${elapsedDays} uplynulými dny (ne exact billing KPI).${estimateTitleSuffix}`,
          { incomplete: coverageIncomplete && !estimateUnavailable },
        )}
      </div>
      <p class="gm-cus-notice">${escapeHtml(SHORT_NOTICE_CS)}</p>
      <div class="gm-cus-section-head">
        <h3 class="gm-cus-section-title">Tokeny a účtovaná cena · posledních ${chartRangeDays} dní (UTC)</h3>
        <div class="gm-cus-chart-controls">
          <div class="gm-cus-range" aria-label="Metrika grafu">
            <button class="gm-cus-metric-button" type="button" data-metric="tokens" data-active="${chartMetric === "tokens"}" aria-pressed="${chartMetric === "tokens"}">Tokeny</button>
            <button class="gm-cus-metric-button" type="button" data-metric="spend" data-active="${chartMetric === "spend"}" aria-pressed="${chartMetric === "spend"}" title="Nativní On-Demand Cost (chargedCents)">Cena</button>
          </div>
          <div class="gm-cus-range" aria-label="Rozsah grafu">
            <button class="gm-cus-range-button" type="button" data-range="7" data-active="${chartRangeDays === 7}" aria-pressed="${chartRangeDays === 7}">7 dní</button>
            <button class="gm-cus-range-button" type="button" data-range="30" data-active="${chartRangeDays === 30}" aria-pressed="${chartRangeDays === 30}">30 dní</button>
          </div>
        </div>
      </div>
      <div class="gm-cus-chart" data-metric="${chartMetric}" style="--gm-day-count:${chartDays.length}" role="img" aria-label="Skládaný denní graf ${chartMetric === "tokens" ? "tokenů" : "účtované ceny"} za posledních ${chartRangeDays} dní">
        ${renderChart(chartDays, chartSeries)}
      </div>
      <div class="gm-cus-legend">${renderLegend(chartSeries)}</div>
      <p class="gm-cus-disclaimer">
        ${escapeHtml(PRICE_DISCLAIMER_CS)}
        <button class="gm-cus-help-button" type="button" title="Nápověda a changelog" aria-label="Nápověda a changelog">?</button>
      </p>
      <div class="gm-cus-section-head"><h3 class="gm-cus-section-title">Modely · billing cyklus</h3></div>
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
              <th title="Celková volání; počet on-demand je v tooltipu">Volání</th>
              <th>Tokeny</th>
              <th title="Součet nativních On-Demand Cost (chargedCents); Included = $0; chybějící Cost = —">Útrata</th>
              <th title="Průměr nativního Cost na oceněné on-demand volání">Ø placené volání</th>
              <th title="Účtovaná cena na 1M tokenů (jen on-demand s nativním Cost)">Cena / 1M tok.</th>
            </tr>
          </thead>
          <tbody>${renderModelRows(data.models, chartSeries)}</tbody>
        </table>
      </div>
    `;
    bindPanelActions(panel, data);
  }

  function renderCurrentState() {
    if (currentData) renderStatistics(currentData);
    else if (loading) renderLoading();
    else renderWaiting();
  }

  function removePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    closeHelpModal(panel);
    panel.remove();
  }

  function handleRouteChange() {
    if (!isUsagePage()) {
      removePanel();
      return;
    }

    // The native table mounts asynchronously; the MutationObserver retries the mount.
    renderCurrentState();
    setTimeout(renderCurrentState, 300);
    if (requestContext && !currentData && !loading) scheduleLoad(50);
  }

  /**
   * Router changes are detected by watching `location.href` instead of patching
   * `history.pushState`: writing sandbox functions into page objects is the same
   * Xray hazard the fetch interceptor has to work around in Firefox.
   */
  function observeRouteChanges() {
    let lastHref = location.href;

    const checkRoute = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      handleRouteChange();
    };

    window.addEventListener("popstate", checkRoute);
    window.addEventListener("hashchange", checkRoute);
    setInterval(checkRoute, 400);
    return checkRoute;
  }

  function startUi() {
    const checkRoute = observeRouteChanges();

    const observer = new MutationObserver(() => {
      checkRoute();

      if (!isUsagePage()) {
        removePanel();
        return;
      }

      if (!document.getElementById(PANEL_ID)) {
        renderCurrentState();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    renderCurrentState();
    setTimeout(renderWaiting, 1500);
  }

  pageWindow.__cursorUsageStats = {
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
