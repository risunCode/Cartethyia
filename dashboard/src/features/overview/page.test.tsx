import { describe, expect, test } from "vitest";
import { buildKeyLimitsInput } from "./page";

// Regression: a bare (no "/") entry was always classified as a
// providerAllowlist entry, treating every alias/combo name (also bare) as if
// it were a provider id. That silently broke ACL for alias/combo allowlist
// entries - a qualified request never matches a provider id that's really an
// alias name, and a bare alias request skips the providerAllowlist check
// entirely (no provider prefix to check against), so modelAllowlist is the
// only list that actually gates it.
describe("buildKeyLimitsInput — provider vs model/alias/combo classification", () => {
  const providerIds = new Set(["kimchi", "openai", "anthropic"]);

  test("a real provider id goes to providerAllowlist", () => {
    const input = buildKeyLimitsInput("", "", "", "", ["kimchi"], providerIds);
    expect(input.providerAllowlist).toEqual(["kimchi"]);
    expect(input.modelAllowlist).toBeUndefined();
  });

  test("a bare alias name (not a registered provider id) goes to modelAllowlist, not providerAllowlist", () => {
    const input = buildKeyLimitsInput("", "", "", "", ["fast"], providerIds);
    expect(input.modelAllowlist).toEqual(["fast"]);
    expect(input.providerAllowlist).toBeUndefined();
  });

  test("a bare combo name (not a registered provider id) goes to modelAllowlist, not providerAllowlist", () => {
    const input = buildKeyLimitsInput("", "", "", "", ["fast-combo"], providerIds);
    expect(input.modelAllowlist).toEqual(["fast-combo"]);
    expect(input.providerAllowlist).toBeUndefined();
  });

  test("a qualified provider/model entry always goes to modelAllowlist regardless of provider id set", () => {
    const input = buildKeyLimitsInput("", "", "", "", ["kimchi/kimi-k2.7"], providerIds);
    expect(input.modelAllowlist).toEqual(["kimchi/kimi-k2.7"]);
    expect(input.providerAllowlist).toBeUndefined();
  });

  test("mixes providers, aliases/combos, and qualified models into their correct lists in one call", () => {
    const input = buildKeyLimitsInput("", "", "", "", ["openai", "fast", "fast-combo", "kimchi/kimi-k2.7"], providerIds);
    expect(input.providerAllowlist).toEqual(["openai"]);
    expect(input.modelAllowlist).toEqual(["fast", "fast-combo", "kimchi/kimi-k2.7"]);
  });

  test("selects a one-time budget without sending recurring limits", () => {
    const input = buildKeyLimitsInput("", "1000000", "30000000", "", [], providerIds, "1000000000", "one-time");
    expect(input).toMatchObject({ oneTimeTokenLimit: 1_000_000_000 });
    expect(input.dailyTokenLimit).toBeUndefined();
    expect(input.monthlyTokenLimit).toBeUndefined();
  });

  test("preset-sized recurring budgets remain independent", () => {
    const input = buildKeyLimitsInput("", "1000000", "1000000000000", "", [], providerIds);
    expect(input.dailyTokenLimit).toBe(1_000_000);
    expect(input.monthlyTokenLimit).toBe(1_000_000_000_000);
    expect(input.oneTimeTokenLimit).toBeUndefined();
  });
});
