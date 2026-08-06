"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const USERSCRIPT_PATH = path.resolve(__dirname, "..", "cursor-usage-statistics.user.js");
const source = fs.readFileSync(USERSCRIPT_PATH, "utf8");

const {
  VERSION,
  USAGE_ENDPOINT,
  AGG_ENDPOINT,
  SUMMARY_ENDPOINT,
  UNAVAILABLE,
  resolvePageWindow,
  isUsageRequest,
  installPageFetchInterceptor,
  cloneFetchInitForPage,
  getChargedDollars,
  sumEventChargedDollars,
  parseUsageSummary,
  isOnDemandEvent,
  ON_DEMAND_KIND,
  INCLUDED_KIND,
  ERRORED_KIND,
  MODEL_PRICING,
  PRICE_ESTIMATION_FALLBACK_ENABLED,
  PRICE_DISCLAIMER_CS,
  SHORT_NOTICE_CS,
  CHANGELOG,
  getEventTokenBreakdown,
  resolveModelPricing,
  estimateEventOnDemandPrice,
  resolveEventPaidCost,
  parseNativeChargedCostDollars,
  hasNativeChargedCents,
  summarizeOnDemandEstimates,
  accumulateModelUsageValue,
  accumulateModelSpend,
  parseAggregatedDay,
  monthModelSpendFromAggregated,
  centsToDollars,
  formatMoneyOrUnavailable,
} = require(USERSCRIPT_PATH);

/** Simulates Greasemonkey/Firefox sandbox `window.fetch` (getter-only / read-only). */
function createReadonlyFetchSandbox(nativeFetch) {
  const sandbox = {};
  Object.defineProperty(sandbox, "fetch", {
    get() {
      return nativeFetch;
    },
    enumerable: true,
    configurable: false,
  });
  return sandbox;
}

function createWritablePageWindow(nativeFetch) {
  return { fetch: nativeFetch };
}

/**
 * Anonymized live shape from get-filtered-usage-events (2026-08-03).
 * Native dashboard Cost for this On-Demand row: 0,38 US$.
 * usageBasedCosts "$0.32" deliberately differs (omits cursorTokenFee).
 */
const SCREENSHOT_ON_DEMAND_FIXTURE = {
  timestamp: "1785768736236",
  model: "gpt-5.6-sol-high-fast",
  kind: ON_DEMAND_KIND,
  requestsCosts: 7.900000095367432,
  usageBasedCosts: "$0.32",
  isTokenBasedCall: true,
  tokenUsage: {
    inputTokens: 1200,
    outputTokens: 800,
    cacheWriteTokens: 0,
    cacheReadTokens: 252898,
    totalCents: 31.662700653076172,
  },
  cursorTokenFee: 6.37244987487793,
  isChargeable: true,
  chargedCents: 38.03514862060547,
};

const SCREENSHOT_GROK_FIXTURE = {
  timestamp: "1785768551468",
  model: "cursor-grok-4.5-high-fast",
  kind: ON_DEMAND_KIND,
  requestsCosts: 33.29999923706055,
  usageBasedCosts: "$1.33",
  isTokenBasedCall: true,
  tokenUsage: {
    inputTokens: 50000,
    outputTokens: 4000,
    cacheWriteTokens: 0,
    cacheReadTokens: 857917,
    totalCents: 133.3092041015625,
  },
  cursorTokenFee: 0,
  isChargeable: true,
  chargedCents: 133.3092041015625,
};

test("userscript metadata is 1.3.13 and grants unsafeWindow", () => {
  assert.equal(VERSION, "1.3.13");
  assert.match(source, /@version\s+1\.3\.13\b/);
  // SPA: the whole dashboard must be matched, not just the usage route.
  assert.match(source, /@match\s+https:\/\/cursor\.com\/dashboard\*/);
  assert.match(source, /@grant\s+unsafeWindow\b/);
  assert.doesNotMatch(source, /@grant\s+none\b/);
  assert.match(source, /installPageFetchInterceptor\s*\(/);
  assert.match(source, /resolvePageWindow\s*\(/);
  assert.match(source, /cloneFetchInitForPage\s*\(/);
  assert.match(source, /Permission denied to access property "body"/);
  assert.equal(AGG_ENDPOINT, "/api/dashboard/get-aggregated-usage-events");
  assert.equal(SUMMARY_ENDPOINT, "/api/usage-summary");
  // Paid spend and usage value must stay separated.
  assert.match(source, /parseUsageSummary/);
  assert.match(source, /Never promote it to/);
  assert.match(source, /Zahrnutá spotřeba/);
  assert.match(source, /usage-summary\.onDemand\.used/);
  assert.doesNotMatch(source, /Always prefer aggregate token spend/);
  // Must not fall back chargedCents into Útrata via aggregate overlay path.
  assert.doesNotMatch(source, /statistics\.costSource = "chargedCents"/);
  assert.match(source, /costSource: "native-chargedCents"/);
  // Regression: never wrap native fetch Promise with .then() / async (GM/Firefox Xray).
  assert.doesNotMatch(
    source,
    /return nativeFetch\(input, init\)\.then\s*\(/,
  );
  assert.match(source, /Permission denied to access object/);
  assert.equal(PRICE_ESTIMATION_FALLBACK_ENABLED, false);
  assert.match(source, /PRICE_ESTIMATION_FALLBACK_ENABLED = false/);
});

test("getChargedDollars keeps legacy chargedCents path but is not authoritative paid", () => {
  assert.equal(
    getChargedDollars({ kind: "USAGE_EVENT_KIND_USAGE_BASED", chargedCents: 250 }),
    2.5,
  );
  assert.equal(
    getChargedDollars({ kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS", chargedCents: 250 }),
    0,
  );
  assert.equal(centsToDollars(16250.98587), 162.5098587);
  assert.match(source, /Prefer resolveEventPaidCost/);
});

test("native Cost parser matches screenshot On-Demand Cost unit (chargedCents / 100)", () => {
  assert.equal(hasNativeChargedCents(SCREENSHOT_ON_DEMAND_FIXTURE), true);
  const dollars = parseNativeChargedCostDollars(SCREENSHOT_ON_DEMAND_FIXTURE);
  assert.ok(dollars != null);
  assert.equal(Number(dollars.toFixed(2)), 0.38);
  assert.equal(Number(parseNativeChargedCostDollars(SCREENSHOT_GROK_FIXTURE).toFixed(2)), 1.33);
  assert.equal(
    Number(
      (
        parseNativeChargedCostDollars(SCREENSHOT_ON_DEMAND_FIXTURE) +
        parseNativeChargedCostDollars(SCREENSHOT_GROK_FIXTURE)
      ).toFixed(2),
    ),
    1.71,
  );
  // usageBasedCosts string is NOT the Cost column when cursorTokenFee > 0.
  assert.equal(SCREENSHOT_ON_DEMAND_FIXTURE.usageBasedCosts, "$0.32");
  assert.notEqual(Number(String(SCREENSHOT_ON_DEMAND_FIXTURE.usageBasedCosts).replace(/[$,]/g, "")), 0.38);
  assert.equal(parseNativeChargedCostDollars({ kind: ON_DEMAND_KIND }), null);
  assert.equal(parseNativeChargedCostDollars({ kind: ON_DEMAND_KIND, chargedCents: "x" }), null);
});

test("resolveEventPaidCost prefers native Cost over catalog estimator", () => {
  const divergent = {
    ...SCREENSHOT_ON_DEMAND_FIXTURE,
    // Force a billed Cost that cannot equal the catalog token estimate.
    chargedCents: 999,
  };
  const native = resolveEventPaidCost(divergent);
  assert.equal(native.status, "priced");
  assert.equal(native.source, "native-chargedCents");
  assert.equal(native.dollars, 9.99);

  const catalog = estimateEventOnDemandPrice(divergent);
  assert.equal(catalog.status, "priced");
  assert.equal(catalog.source, "catalog-estimate");
  assert.notEqual(Number(catalog.dollars.toFixed(2)), 9.99);

  // Screenshot fixture still parses to the native Cost column value.
  assert.equal(Number(resolveEventPaidCost(SCREENSHOT_ON_DEMAND_FIXTURE).dollars.toFixed(2)), 0.38);

  // Unknown / unpriced catalog model with native Cost is still priced.
  const unknownNative = resolveEventPaidCost({
    kind: ON_DEMAND_KIND,
    model: "totally-unknown-model-xyz",
    chargedCents: 50,
    tokenUsage: { inputTokens: 1000, outputTokens: 1000 },
  });
  assert.equal(unknownNative.status, "priced");
  assert.equal(unknownNative.dollars, 0.5);
  assert.equal(unknownNative.source, "native-chargedCents");
});

test("default suppression: missing native Cost stays unpriced; Included/Errored = $0", () => {
  assert.equal(PRICE_ESTIMATION_FALLBACK_ENABLED, false);
  const missing = resolveEventPaidCost({
    kind: ON_DEMAND_KIND,
    model: "gpt-5.6-sol-high-fast",
    tokenUsage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(missing.status, "unpriced");
  assert.equal(missing.dollars, null);
  assert.equal(missing.reason, "missing-native-cost");

  const included = resolveEventPaidCost({
    kind: INCLUDED_KIND,
    model: "cursor-grok-4.5-high-fast",
    chargedCents: 214.19119262695312,
    usageBasedCosts: "-",
    tokenUsage: { totalCents: 214.19119262695312, inputTokens: 1000, outputTokens: 100 },
  });
  assert.equal(included.status, "included");
  assert.equal(included.dollars, 0);

  const errored = resolveEventPaidCost({
    kind: ERRORED_KIND,
    model: "cursor-grok-4.5-high",
    chargedCents: 0,
    usageBasedCosts: "$0.00",
  });
  assert.equal(errored.status, "errored");
  assert.equal(errored.dollars, 0);

  const summary = summarizeOnDemandEstimates([
    SCREENSHOT_ON_DEMAND_FIXTURE,
    {
      kind: ON_DEMAND_KIND,
      model: "gpt-5.6-terra-medium",
      tokenUsage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ]);
  assert.equal(summary.onDemandCount, 2);
  assert.equal(summary.pricedCount, 1);
  assert.equal(summary.unpricedCount, 1);
  assert.equal(Number(summary.estimatedDollars.toFixed(2)), 0.38);
});

test("opt-in PRICE_ESTIMATION_FALLBACK_ENABLED can still use catalog estimator", () => {
  const priced = resolveEventPaidCost(
    {
      kind: ON_DEMAND_KIND,
      model: "gpt-5.6-sol-high-fast",
      tokenUsage: {
        inputTokens: 834,
        cacheWriteTokens: 7390,
        cacheReadTokens: 225091,
        outputTokens: 2846,
      },
    },
    MODEL_PRICING,
    { fallbackEnabled: true },
  );
  assert.equal(priced.status, "priced");
  assert.equal(priced.source, "catalog-estimate");
  assert.ok(priced.dollars > 0);

  const summary = summarizeOnDemandEstimates(
    [
      {
        kind: ON_DEMAND_KIND,
        model: "gpt-5.6-terra-medium",
        tokenUsage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
    MODEL_PRICING,
    { fallbackEnabled: true },
  );
  assert.equal(summary.pricedCount, 1);
  assert.ok(Math.abs(summary.estimatedDollars - 2.25) < 1e-9);
});

test("parseUsageSummary separates paid on-demand from included pool usage", () => {
  const parsed = parseUsageSummary({
    billingCycleStart: "2026-07-03T12:00:00.000Z",
    billingCycleEnd: "2026-08-03T12:00:00.000Z",
    individualUsage: {
      onDemand: { used: 288981 },
      plan: { breakdown: { total: 85900 } },
    },
  });

  assert.equal(Number(parsed.paidSpendCycle.toFixed(2)), 2889.81);
  assert.equal(Number(parsed.includedUsageCycle.toFixed(2)), 859);
  assert.equal(Number(parsed.totalUsageCycle.toFixed(2)), 3748.81);
  assert.equal(parsed.planUsageValueCycle, parsed.includedUsageCycle);
  assert.equal(parsed.billingCycleStart, Date.parse("2026-07-03T12:00:00.000Z"));
  assert.equal(parsed.billingCycleEnd, Date.parse("2026-08-03T12:00:00.000Z"));
  assert.equal(parsed.paidSpendDailyAvailable, false);
  assert.equal(parsed.paidSpendPerModelAvailable, false);
  assert.notEqual(parsed.paidSpendCycle, parsed.includedUsageCycle);

  const topLevel = parseUsageSummary({
    onDemand: { used: 100 },
    plan: { breakdown: { total: 50 } },
  });
  assert.equal(topLevel.paidSpendCycle, 1);
  assert.equal(topLevel.includedUsageCycle, 0.5);
  assert.equal(topLevel.totalUsageCycle, 1.5);

  const missing = parseUsageSummary({});
  assert.equal(missing.paidSpendCycle, UNAVAILABLE);
  assert.equal(missing.includedUsageCycle, UNAVAILABLE);
  assert.equal(missing.totalUsageCycle, UNAVAILABLE);
  assert.equal(formatMoneyOrUnavailable(missing.paidSpendCycle), "N/A");
  assert.equal(formatMoneyOrUnavailable(12.5), "$12.50");

  const onlyOnDemand = parseUsageSummary({ individualUsage: { onDemand: { used: 4200 } } });
  assert.equal(onlyOnDemand.paidSpendCycle, 42);
  assert.equal(onlyOnDemand.totalUsageCycle, UNAVAILABLE);
});

/**
 * Live-verified units (cursor.com/dashboard/usage, cycle 2026-07-05 → 2026-08-05):
 * usage-summary and the native get-team-spend endpoint were fetched in one snapshot.
 *   individualUsage.onDemand.used        290417  <->  spendCents          290304
 *   individualUsage.plan.breakdown.total  87598  <->  includedSpendCents   87519
 *   billingCycleStart/End                       <->  subscriptionCycleStart/nextCycleStart
 * Both fields are cents over the identical cycle, so onDemand.used must be
 * divided by 100 and must never be conflated with the included pool.
 */
test("onDemand.used converts cents to dollars and matches native spendCents", () => {
  const nativeSpendCents = 290304;
  const nativeIncludedSpendCents = 87519;
  const parsed = parseUsageSummary({
    billingCycleStart: "2026-07-05T12:23:49.000Z",
    billingCycleEnd: "2026-08-05T12:23:49.000Z",
    individualUsage: {
      onDemand: { used: 290417, limit: null, remaining: null },
      plan: { used: 2000, limit: 2000, breakdown: { included: 2000, bonus: 85598, total: 87598 } },
    },
  });

  assert.equal(parsed.paidSpendCycle, 2904.17);
  assert.equal(parsed.includedUsageCycle, 875.98);
  // Same cycle, same unit: the two native sources may only drift by cache lag.
  assert.ok(Math.abs(parsed.paidSpendCycle - nativeSpendCents / 100) < 5);
  assert.ok(Math.abs(parsed.includedUsageCycle - nativeIncludedSpendCents / 100) < 5);
  // The included pool is roughly a third of the on-demand spend — never equal.
  assert.ok(parsed.paidSpendCycle > parsed.includedUsageCycle * 2);
  assert.equal(
    Number((parsed.totalUsageCycle - parsed.paidSpendCycle - parsed.includedUsageCycle).toFixed(6)),
    0,
  );
});

test("isOnDemandEvent mirrors the dashboard Type column", () => {
  assert.equal(ON_DEMAND_KIND, "USAGE_EVENT_KIND_USAGE_BASED");
  assert.equal(isOnDemandEvent({ kind: "USAGE_EVENT_KIND_USAGE_BASED" }), true);
  assert.equal(isOnDemandEvent({ kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS" }), false);
  assert.equal(isOnDemandEvent({ kind: "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED" }), false);
  assert.equal(isOnDemandEvent(undefined), false);
});

test("aggregate parsers expose usage value and sum duplicate modelIntent tiers", () => {
  assert.equal(sumEventChargedDollars([
    { kind: "USAGE_EVENT_KIND_USAGE_BASED", chargedCents: 0, requestsCosts: 18 },
    { kind: "USAGE_EVENT_KIND_USAGE_BASED", chargedCents: 0, requestsCosts: 40 },
  ]), 0);

  const parsed = parseAggregatedDay({
    totalCostCents: 16250.98587,
    aggregations: [
      { modelIntent: "cursor-grok-4.5-high-fast", totalCents: 14630.93155 },
      { modelIntent: "composer-2.5-fast", totalCents: 519.311 },
    ],
  });
  assert.ok(parsed.usageValue > 160);
  assert.equal(parsed.usageValue, parsed.spend);
  assert.ok(parsed.modelUsageValue["cursor-grok-4.5-high-fast"] > 140);

  const month = monthModelSpendFromAggregated({
    aggregations: [
      { modelIntent: "claude-opus-5-thinking-high", totalCents: 14041.71901 },
      { modelIntent: "auto-smart", totalCents: 5102.16369, tier: 1 },
      { modelIntent: "auto-smart", totalCents: 1649.33565, tier: 2 },
    ],
  });
  assert.equal(Number(month["claude-opus-5-thinking-high"].toFixed(2)), 140.42);
  assert.equal(Number(month["auto-smart"].toFixed(2)), 67.51);
  const summed = accumulateModelUsageValue([
    { modelIntent: "auto-smart", totalCents: 5102.16369 },
    { modelIntent: "auto-smart", totalCents: 1649.33565 },
  ]);
  assert.equal(Number(summed["auto-smart"].toFixed(2)), 67.51);
  assert.deepEqual(summed, accumulateModelSpend([
    { modelIntent: "auto-smart", totalCents: 5102.16369 },
    { modelIntent: "auto-smart", totalCents: 1649.33565 },
  ]));
});

test("UI copy uses native Cost labels without ODHAD in main panel", () => {
  assert.match(source, /Útrata · cyklus/);
  assert.match(source, /usage-summary\.onDemand\.used/);
  assert.match(source, /Zahrnutá spotřeba \(v tarifu · bez on-demand\)/);
  assert.match(source, /aggregate totalCostCents \(jen Included\)/);
  assert.match(source, /<th[^>]*>Útrata<\/th>/);
  assert.doesNotMatch(source, /Hodnota spotřeby<\/th>/);
  assert.doesNotMatch(source, /Odhad ceny<\/th>/);
  assert.match(source, />Cena</);
  assert.match(source, /Ø placené volání<\/th>/);
  assert.match(source, /Cena \/ 1M tok\.<\/th>/);
  assert.match(source, /Tokeny a účtovaná cena/);
  assert.doesNotMatch(source, /Tokeny a odhad ceny/);
});

test("UI explains aggregate vs on-demand and native Cost source", () => {
  assert.match(source, /prices \*included\* events only/);
  assert.match(source, /get-team-spend\.spendCents/);
  assert.match(source, /includedSpendCents/);
  assert.match(source, /onDemandCalls/);
  assert.match(source, /native-chargedCents/);
  assert.match(source, /chargedCents \/ 100/);
});

test("price catalog shape matches docs snapshot metadata", () => {
  assert.equal(MODEL_PRICING.currency, "USD");
  assert.equal(MODEL_PRICING.unit, "per 1M tokens");
  assert.equal(MODEL_PRICING.source, "https://cursor.com/docs/models-and-pricing");
  assert.equal(MODEL_PRICING.effectiveDate, "2026-07-31");
  assert.equal(MODEL_PRICING.cursorTokenRatePerMillion, 0.25);
  assert.ok(MODEL_PRICING.models["claude-opus-5"]);
  assert.ok(MODEL_PRICING.models["gpt-5.6-sol"]);
  assert.ok(MODEL_PRICING.models["gpt-5.6-terra"]);
  assert.ok(MODEL_PRICING.models["cursor-grok-4.5"]?.unpriced);
  assert.ok(MODEL_PRICING.models["composer-2.5"]?.unpriced);
  assert.equal(MODEL_PRICING.models["gemini-3-flash"].cacheWrite, null);
  assert.equal(MODEL_PRICING.models["gpt-5.6-sol"].fastMultiplier, 2);
  assert.equal(MODEL_PRICING.models["gpt-5.5"].fastMultiplier, undefined);
  // JSON-compatible: no functions / undefined nested weirdness in aliases values we rely on.
  assert.equal(typeof MODEL_PRICING.aliases["gpt-5.6 sol (auto balanced)"], "object");
  JSON.stringify(MODEL_PRICING);
});

test("alias resolution maps live/CSV model names", () => {
  assert.equal(resolveModelPricing("gpt-5.6-sol-high-fast").catalogKey, "gpt-5.6-sol");
  assert.equal(resolveModelPricing("gpt-5.6-sol-high-fast").appliedFastMultiplier, 2);
  assert.equal(resolveModelPricing("gpt-5.6-terra-medium").catalogKey, "gpt-5.6-terra");
  assert.equal(resolveModelPricing("claude-opus-5-thinking-high").catalogKey, "claude-opus-5");
  assert.equal(resolveModelPricing("claude-4.5-haiku-thinking").catalogKey, "claude-4.5-haiku");
  assert.equal(resolveModelPricing("Opus 5 (Auto Balanced)").catalogKey, "claude-opus-5");
  assert.equal(resolveModelPricing("Opus 5 (Auto Balanced)").autoRouted, true);
  assert.equal(resolveModelPricing("GPT-5.6 Sol (Auto Balanced)").catalogKey, "gpt-5.6-sol");
  assert.equal(resolveModelPricing("cursor-grok-4.5-high-fast").unpriced, true);
  assert.equal(resolveModelPricing("claude-opus-5-thinking-high-fast").unpriced, true);
  assert.equal(resolveModelPricing("claude-opus-5-thinking-high-fast").reason, "unknown-fast-rate");
  assert.equal(resolveModelPricing("auto-smart").unpriced, true);
  assert.equal(resolveModelPricing("agent_review").unpriced, true);
});

test("estimateEventOnDemandPrice computes synthetic on-demand event exactly", () => {
  const event = {
    kind: ON_DEMAND_KIND,
    model: "gpt-5.6-sol-high-fast",
    tokenUsage: {
      inputTokens: 834,
      cacheWriteTokens: 7390,
      cacheReadTokens: 225091,
      outputTokens: 2846,
    },
  };
  const tokens = getEventTokenBreakdown(event);
  assert.equal(tokens.uncachedInputTokens, 834);
  assert.equal(tokens.cacheWriteTokens, 7390);

  const rates = MODEL_PRICING.models["gpt-5.6-sol"];
  const mult = 2;
  const modelPart =
    (7390 * rates.cacheWrite + 834 * rates.input + 225091 * rates.cacheRead + 2846 * rates.output) *
    mult /
    1e6;
  const ctr = (834 + 7390 + 225091 + 2846) * 0.25 / 1e6;
  const expected = modelPart + ctr;

  const priced = estimateEventOnDemandPrice(event);
  assert.equal(priced.status, "priced");
  assert.equal(priced.appliedFastMultiplier, 2);
  assert.equal(priced.appliedCursorTokenRate, true);
  assert.ok(Math.abs(priced.dollars - expected) < 1e-9);
});

test("catalog estimator: Included/Errored $0; unknown unpriced without native Cost", () => {
  assert.equal(
    estimateEventOnDemandPrice({
      kind: INCLUDED_KIND,
      model: "gpt-5.6-sol",
      tokenUsage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }).dollars,
    0,
  );
  assert.equal(
    estimateEventOnDemandPrice({
      kind: "Included",
      model: "gpt-5.6-sol",
      tokenUsage: { inputTokens: 1000, outputTokens: 1000 },
    }).status,
    "included",
  );
  assert.equal(
    estimateEventOnDemandPrice({
      kind: "Errored, No Charge",
      model: "gpt-5.6-sol",
      tokenUsage: { inputTokens: 1000, outputTokens: 1000 },
    }).dollars,
    0,
  );
  const unknown = estimateEventOnDemandPrice({
    kind: ON_DEMAND_KIND,
    model: "totally-unknown-model-xyz",
    tokenUsage: { inputTokens: 1000, outputTokens: 1000 },
  });
  assert.equal(unknown.status, "unpriced");
  assert.equal(unknown.dollars, null);
});

test("Cursor Token Rate applies to third-party only; Cursor pool models stay unpriced in catalog", () => {
  const thirdParty = estimateEventOnDemandPrice({
    kind: ON_DEMAND_KIND,
    model: "gpt-5.4-medium",
    tokenUsage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(thirdParty.status, "priced");
  assert.equal(thirdParty.appliedCursorTokenRate, true);
  // $2.5/M input + $0.25/M CTR
  assert.ok(Math.abs(thirdParty.dollars - 2.75) < 1e-9);

  const cursor = estimateEventOnDemandPrice({
    kind: ON_DEMAND_KIND,
    model: "composer-2.5-fast",
    tokenUsage: { inputTokens: 1_000_000, outputTokens: 0 },
  });
  assert.equal(cursor.status, "unpriced");
});

test("UI disclaimer and changelog copy are present for 1.3.11 native Cost", () => {
  assert.match(PRICE_DISCLAIMER_CS, /nativního sloupce Cost/i);
  assert.match(PRICE_DISCLAIMER_CS, /chargedCents/);
  assert.match(PRICE_DISCLAIMER_CS, /Included \/ Errored = \$0/);
  assert.match(PRICE_DISCLAIMER_CS, /Lokální ceníkový odhad je vypnutý/);
  assert.match(SHORT_NOTICE_CS, /nativního Cursor Cost/i);
  assert.match(SHORT_NOTICE_CS, /Included = \$0/);
  assert.match(SHORT_NOTICE_CS, /lokální odhad vypnutý/i);
  assert.match(source, /PRICE_DISCLAIMER_CS/);
  assert.match(source, /SHORT_NOTICE_CS/);
  assert.match(source, /gm-cus-disclaimer/);
  assert.match(source, /gm-cus-notice/);
  assert.match(source, /gm-cus-help-button/);
  assert.match(source, /openHelpModal/);
  assert.match(source, /Escape/);
  const versions = CHANGELOG.map((entry) => entry.version);
  assert.deepEqual(versions.slice(0, 5), ["1.3.13", "1.3.12", "1.3.11", "1.3.10", "1.3.9"]);
  assert.match(CHANGELOG[0].text, /SPA|routing/i);
  assert.match(CHANGELOG[1].text, /Firefox Xray|cloneInto/i);
  assert.match(CHANGELOG[2].text, /nativní per-event Cost|chargedCents/i);
  assert.match(source, /Exact vs nativní Cost/);
  assert.match(source, /Coverage nativního Cost/);
  assert.match(source, /Ceník \(vypnutý fallback\)/);
});

test("compact main UI has exactly four KPIs and no bulky section cards", () => {
  const renderStart = source.indexOf("function renderStatistics");
  const renderEnd = source.indexOf("function startUi");
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderBody = source.slice(renderStart, renderEnd);

  const kpiLabels = [...renderBody.matchAll(/renderKpi\(\s*\n?\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(kpiLabels, [
    "Dnes (UTC)",
    "Posledních 7 dní",
    "Útrata · cyklus",
    "Průměr / den",
  ]);
  assert.equal((renderBody.match(/renderKpi\(/g) || []).length, 4);

  assert.match(renderBody, /gm-cus-notice/);
  assert.match(renderBody, /Tokeny a účtovaná cena · posledních/);
  assert.match(renderBody, /data-metric="tokens"/);
  assert.match(renderBody, /data-metric="spend"/);
  assert.match(renderBody, /data-range="7"/);
  assert.match(renderBody, /data-range="30"/);
  assert.match(renderBody, />Cena</);
  assert.match(renderBody, />Útrata</);
  assert.match(renderBody, />Ø placené volání</);
  assert.match(renderBody, />Cena \/ 1M tok\.</);
  assert.doesNotMatch(renderBody, /\(odhad\)/i);
  assert.doesNotMatch(renderBody, />Odhad ceny</);
  assert.doesNotMatch(renderBody, /ODHAD/);

  assert.doesNotMatch(renderBody, /gm-cus-kpi-group-title/);
  assert.doesNotMatch(renderBody, /Coverage odhadu/);
  assert.doesNotMatch(renderBody, /Neoceněné on-demand/);
  assert.doesNotMatch(renderBody, /Celkem · cyklus/);
  assert.doesNotMatch(renderBody, /Zahrnutá spotřeba \(v tarifu/);
  assert.doesNotMatch(renderBody, /Hodnota spotřeby/);
  assert.doesNotMatch(renderBody, /gm-cus-coverage/);

  // Bulky explainers stay available in the help modal, not as main-panel cards.
  assert.match(source, /Exact vs nativní Cost/);
  assert.match(source, /Coverage nativního Cost/);
  assert.match(source, /Modely s chybějícím nativním Cost/);
});

test("optional CSV coverage report (skipped when file missing)", (t) => {
  const csvPath = process.env.CURSOR_USAGE_CSV
    || "D:\\Downloads\\team-usage-events-10287858-2026-07-31 (1).csv";
  if (!fs.existsSync(csvPath)) {
    t.skip("CSV export not present on this machine");
    return;
  }

  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  const idx = Object.fromEntries(header.map((name, index) => [name.trim(), index]));
  const required = [
    "Kind",
    "Model",
    "Input (w/ Cache Write)",
    "Input (w/o Cache Write)",
    "Cache Read",
    "Output Tokens",
  ];
  for (const column of required) {
    assert.ok(idx[column] != null, `missing column ${column}`);
  }

  function parseCsvLine(line) {
    const cells = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  }

  const events = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return {
      kind: cells[idx.Kind],
      model: cells[idx.Model],
      tokenUsage: {
        cacheWriteTokens: Number(cells[idx["Input (w/ Cache Write)"]]) || 0,
        inputTokens: Number(cells[idx["Input (w/o Cache Write)"]]) || 0,
        cacheReadTokens: Number(cells[idx["Cache Read"]]) || 0,
        outputTokens: Number(cells[idx["Output Tokens"]]) || 0,
      },
    };
  });

  // CSV typically lacks chargedCents — catalog fallback is opt-in for this report.
  const summary = summarizeOnDemandEstimates(events, MODEL_PRICING, { fallbackEnabled: true });
  assert.ok(summary.onDemandCount > 0);
  assert.ok(summary.pricedCount > 0);
  assert.ok(summary.coverageRatio > 0);
  // Orientational only — do not assert equality to invoice.
  console.log(
    "[csv-estimate]",
    JSON.stringify({
      onDemandCount: summary.onDemandCount,
      pricedCount: summary.pricedCount,
      unpricedCount: summary.unpricedCount,
      coverageRatio: summary.coverageRatio,
      estimatedDollars: Number(summary.estimatedDollars.toFixed(2)),
      unpricedModels: summary.unpricedModels,
      note: "Catalog fallback opt-in for CSV without chargedCents; compare manually to billing API.",
    }),
  );
});

test("pre-fix reproduction: assigning to read-only sandbox fetch throws", () => {
  const nativeFetch = async () => ({ ok: true });
  const sandbox = createReadonlyFetchSandbox(nativeFetch);

  assert.throws(
    () => {
      sandbox.fetch = async function cursorUsageFetchInterceptor() {
        return nativeFetch();
      };
    },
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(String(error.message), /read-only|only a getter|Cannot set property/i);
      return true;
    },
  );
});

test("resolvePageWindow prefers unsafeWindow over sandbox window", () => {
  const sandbox = { id: "sandbox" };
  const page = { id: "page" };

  assert.equal(resolvePageWindow(sandbox, page), page);
  assert.equal(resolvePageWindow(sandbox, undefined), sandbox);
  assert.equal(resolvePageWindow(sandbox, null), sandbox);
});

test("cloneFetchInitForPage uses cloneInto when available", () => {
  const pageWindow = {};
  const init = { method: "POST", body: "{\"a\":1}" };
  const cloned = { method: "POST", body: "{\"a\":1}", cloned: true };
  const previous = global.cloneInto;
  global.cloneInto = (value, target, opts) => {
    assert.equal(target, pageWindow);
    assert.equal(opts.cloneFunctions, true);
    assert.equal(value, init);
    return cloned;
  };
  try {
    assert.equal(cloneFetchInitForPage(pageWindow, init), cloned);
    assert.equal(cloneFetchInitForPage(pageWindow, null), null);
  } finally {
    if (previous === undefined) delete global.cloneInto;
    else global.cloneInto = previous;
  }
});

test("cloneFetchInitForPage falls back to init without cloneInto", () => {
  const init = { method: "GET" };
  const previous = global.cloneInto;
  delete global.cloneInto;
  try {
    assert.equal(cloneFetchInitForPage({}, init), init);
  } finally {
    if (previous !== undefined) global.cloneInto = previous;
  }
});

test("installPageFetchInterceptor patches writable page window and keeps native fetch", async () => {
  const captured = [];
  let nativeCalls = 0;

  const nativeFetchImpl = async (input, init) => {
    nativeCalls += 1;
    return {
      ok: true,
      status: 200,
      url: typeof input === "string" ? input : "",
      init,
    };
  };

  const pageWindow = createWritablePageWindow(nativeFetchImpl);
  const sandbox = createReadonlyFetchSandbox(nativeFetchImpl);

  assert.throws(() => {
    sandbox.fetch = async () => nativeFetchImpl();
  }, TypeError);

  const { nativeFetch, interceptor } = installPageFetchInterceptor(pageWindow, {
    isUsageRequest: (input) => isUsageRequest(input, "https://cursor.com"),
    readRequestBody: async (_input, init) => (typeof init?.body === "string" ? init.body : ""),
    captureRequestContext: (bodyText) => {
      captured.push(bodyText);
    },
  });

  assert.equal(typeof interceptor, "function");
  assert.notEqual(pageWindow.fetch, nativeFetchImpl);
  assert.equal(pageWindow.fetch, interceptor);

  const body = JSON.stringify({ teamId: "team-1", userId: "user-1" });
  const response = await pageWindow.fetch(USAGE_ENDPOINT, {
    method: "POST",
    body,
  });

  assert.equal(response.ok, true);
  assert.equal(nativeCalls, 1);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captured, [body]);

  // Userscript API calls must keep using the unbound native implementation.
  const direct = await nativeFetch(USAGE_ENDPOINT, { method: "POST", body });
  assert.equal(direct.ok, true);
  assert.equal(nativeCalls, 2);
  assert.equal(captured.length, 1);
});

test("interceptor returns the same Promise instance as native fetch (no sandbox wrap)", () => {
  const pagePromise = Promise.resolve({ ok: true, status: 200 });
  const nativeFetchImpl = () => pagePromise;
  const pageWindow = createWritablePageWindow(nativeFetchImpl);

  installPageFetchInterceptor(pageWindow, {
    isUsageRequest: () => false,
    readRequestBody: async () => "",
    captureRequestContext: () => {},
  });

  const returned = pageWindow.fetch("/api/analytics");
  assert.equal(returned, pagePromise);
});

test("usage capture still fires without wrapping the returned Promise", async () => {
  const captured = [];
  const pagePromise = Promise.resolve({ ok: true });
  const nativeFetchImpl = () => pagePromise;
  const pageWindow = createWritablePageWindow(nativeFetchImpl);

  installPageFetchInterceptor(pageWindow, {
    isUsageRequest: (input) => isUsageRequest(input, "https://cursor.com"),
    readRequestBody: async (_input, init) => (typeof init?.body === "string" ? init.body : ""),
    captureRequestContext: (bodyText) => {
      captured.push(bodyText);
    },
  });

  const body = JSON.stringify({ teamId: "t", userId: "u" });
  const returned = pageWindow.fetch(USAGE_ENDPOINT, { method: "POST", body });
  assert.equal(returned, pagePromise);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captured, [body]);
});

test("installPageFetchInterceptor fails loudly when page fetch is not patchable", () => {
  const lockedPage = createReadonlyFetchSandbox(async () => ({ ok: true }));

  assert.throws(
    () =>
      installPageFetchInterceptor(lockedPage, {
        isUsageRequest: () => false,
        readRequestBody: async () => "",
        captureRequestContext: () => {},
      }),
    /unable to install fetch interceptor|not patchable/i,
  );
});
