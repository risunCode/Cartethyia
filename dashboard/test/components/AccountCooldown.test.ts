import { describe, expect, test } from "bun:test";
import {
  activeModelCooldowns,
  lastModelCooldownAt,
} from "../../src/components/AccountCooldown";

/**
 * A model-scoped throttle (a 429 for one model) writes `modelCooldowns` and
 * deliberately leaves `cooldownUntil` untouched, because the account stays
 * routable for every other model. The UI therefore has to read the per-model
 * map to answer "when can this be retried?" — the badge previously showed only
 * a count and computed the deadline without ever rendering it, and the health
 * dialog showed nothing at all.
 */
describe("per-model cooldown display", () => {
  const inMinutes = (minutes: number): string =>
    new Date(Date.now() + minutes * 60_000).toISOString();

  test("reports the count and the soonest deadline, not just the count", () => {
    const result = activeModelCooldowns({
      modelCooldowns: {
        "slow-model": inMinutes(240),
        "quick-model": inMinutes(5),
      },
    });
    expect(result?.count).toBe(2);
    // The soonest — not the first key, and not the largest — is what the
    // operator can act on first.
    expect(result?.modelId).toBe("quick-model");
    expect(new Date(result?.until ?? 0).getTime()).toBeLessThan(Date.now() + 6 * 60_000);
  });

  test("ignores deadlines that have already passed", () => {
    const result = activeModelCooldowns({
      modelCooldowns: {
        expired: new Date(Date.now() - 60_000).toISOString(),
        live: inMinutes(10),
      },
    });
    expect(result?.count).toBe(1);
    expect(result?.modelId).toBe("live");
  });

  test("reports nothing when every deadline has passed or the map is absent", () => {
    expect(
      activeModelCooldowns({ modelCooldowns: { gone: new Date(Date.now() - 1).toISOString() } }),
    ).toBeUndefined();
    expect(activeModelCooldowns({ modelCooldowns: undefined })).toBeUndefined();
    expect(activeModelCooldowns({})).toBeUndefined();
  });

  test("countdown target is the last deadline, so the tick outlives every badge", () => {
    // The timer must run until the longest backoff expires; stopping at the
    // soonest would freeze the remaining badges mid-count.
    const now = Date.now();
    const target = lastModelCooldownAt({
      modelCooldowns: { a: inMinutes(5), b: inMinutes(240) },
    });
    expect(target).not.toBeNull();
    expect((target ?? 0) - now).toBeGreaterThan(200 * 60_000);
  });

  test("a malformed stored value does not become the countdown target", () => {
    expect(
      lastModelCooldownAt({ modelCooldowns: { broken: "not-a-date", ok: inMinutes(3) } }),
    ).toBeGreaterThan(Date.now());
    expect(lastModelCooldownAt({ modelCooldowns: { broken: "not-a-date" } })).toBeNull();
  });
});
