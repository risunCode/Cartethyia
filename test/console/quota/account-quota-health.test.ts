import { describe, expect, test } from "bun:test";
import { toQuotaAccountHealth } from "../../../src/console/quota/account-quota-view";

/**
 * The Quota page's health block.
 *
 * A model-scoped throttle (a 429 for one model) writes `modelCooldowns` and
 * deliberately leaves `cooldownUntil` null, because the account stays routable
 * for every other model. A view that carried only the error message left the
 * health dialog showing *why* an account was throttled but not *until when* —
 * the whole point of a detection-based cooldown. The live Cline shape is a
 * daily free limit with a stated reset, which lands here as a per-model entry.
 */
describe("toQuotaAccountHealth", () => {
  const row = {
    status: "active",
    lastError: "Provider rate limit: Error 429: Daily free limit reached on model x. Try again in 4h 13m",
    lastErrorCategory: "rate_limit_transient",
    cooldownUntil: null as Date | null,
    modelCooldowns: null as unknown,
  };

  test("carries the account-wide cooldown deadline as an ISO instant", () => {
    const until = new Date(Date.now() + 3600_000);
    const health = toQuotaAccountHealth({ ...row, cooldownUntil: until });
    expect(health.cooldownUntil).toBe(until.toISOString());
  });

  test("a model-scoped throttle reports its per-model deadline with no account deadline", () => {
    // The account reads `active` and `cooldownUntil` stays null: only the
    // (account, model) pair is parked.
    const until = new Date(Date.now() + 4 * 3600_000 + 13 * 60_000).toISOString();
    const health = toQuotaAccountHealth({
      ...row,
      modelCooldowns: { "deepseek/deepseek-v4.1-flash": until },
    });
    expect(health.cooldownUntil).toBeNull();
    expect(health.modelCooldowns["deepseek/deepseek-v4.1-flash"]).toBe(until);
    expect(health.sanitizedMessage).toContain("Try again in 4h 13m");
  });

  test("drops elapsed per-model entries rather than reporting a stale cooldown", () => {
    // The sweep prunes the column on a timer, so a read between the deadline
    // passing and the sweep still carries the entry. Returning it would render
    // a cooldown that no longer applies.
    const health = toQuotaAccountHealth({
      ...row,
      modelCooldowns: {
        expired: new Date(Date.now() - 60_000).toISOString(),
        live: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(health.modelCooldowns["expired"]).toBeUndefined();
    expect(health.modelCooldowns["live"]).toBeDefined();
  });

  test("a malformed column value yields no per-model cooldowns instead of throwing", () => {
    for (const bad of ["a string", 42, ["array"], { broken: 7 }, null, undefined]) {
      expect(toQuotaAccountHealth({ ...row, modelCooldowns: bad }).modelCooldowns).toEqual({});
    }
  });

  test("absent error fields become null, not undefined, for the JSON contract", () => {
    const health = toQuotaAccountHealth({
      ...row,
      lastError: null,
      lastErrorCategory: null,
      cooldownUntil: null,
    });
    expect(health.sanitizedMessage).toBeNull();
    expect(health.lastErrorCategory).toBeNull();
    expect(health.cooldownUntil).toBeNull();
  });
});
