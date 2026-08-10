import { describe, expect, test } from "vitest";
import { buildKeyLimitsInput } from "../../../src/features/overview/api-keys-panel";
import { parseOverviewData } from "../../../src/features/overview/page";

// Regression: API key access uses one model whitelist. Every selected model,
// alias, combo, or qualified provider/model is sent to modelAllowlist; an
// empty selection leaves the allowlist unset so every model remains available.
describe("parseOverviewData — current console response contract", () => {
  test("normalizes the registered provider and usage summary fields", () => {
    expect(parseOverviewData({ totals: { requests: 2, inputTokens: 10, outputTokens: 4, cachedTokens: 1, errors: 0 }, inFlight: 1, providers: [{ providerId: "openai", requests: 2, inputTokens: 10, cachedTokens: 1, outputTokens: 4, errors: 0 }], proxyAuthMode: "api_key", registered: ["openai"] })).toMatchObject({ registered: ["openai"], totals: { requests: 2, avgDurationMs: 0, estimatedCostUsd: 0 }, providers: [{ id: "openai", requestsToday: 2, status: "ok" }] });
  });

  test("rejects missing required collections instead of rendering a false success", () => {
    expect(parseOverviewData({ totals: { requests: 0 }, registered: [] })).toBeNull();
  });
});

describe("buildKeyLimitsInput — model whitelist and budgets", () => {
  test("sends all selected models, aliases, combos, and qualified ids to one allowlist", () => {
    const input = buildKeyLimitsInput("", "", "", "", ["openai/gpt-5", "fast", "fast-combo"]);
    expect(input.modelAllowlist).toEqual(["openai/gpt-5", "fast", "fast-combo"]);
  });

  test("leaves the model allowlist unset when no models are selected", () => {
    expect(buildKeyLimitsInput("", "", "", "", [])).toEqual({});
  });

  test("selects a one-time budget without sending recurring limits", () => {
    const input = buildKeyLimitsInput("", "1000000", "30000000", "", [], "1000000000", "one-time");
    expect(input).toMatchObject({ oneTimeTokenLimit: 1_000_000_000 });
    expect(input.dailyTokenLimit).toBeUndefined();
    expect(input.monthlyTokenLimit).toBeUndefined();
  });

  test("keeps daily and monthly limits for the default recurring budget", () => {
    const input = buildKeyLimitsInput("", "1000000", "1000000000000", "", []);
    expect(input.dailyTokenLimit).toBe(1_000_000);
    expect(input.monthlyTokenLimit).toBe(1_000_000_000_000);
    expect(input.oneTimeTokenLimit).toBeUndefined();
  });

  test("ignores invalid negative and fractional limits", () => {
    const input = buildKeyLimitsInput("-1", "1.5", "not-a-number", "-2", []);
    expect(input).toEqual({});
  });
});
