import { describe, expect, test } from "bun:test";
import { classifyAccountError } from "../../../src/providers/operations/account-health-service";

/**
 * Every classification that sets a non-`active` status must carry a `retryAt`,
 * because `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`. A
 * `cooldown` row with a null deadline is never swept back to `active`, so it
 * stays out of rotation until an operator restores it by hand — which is
 * exactly the "cooldown never clears" symptom.
 */
describe("account health always schedules its own recovery", () => {
  test("a 5xx upstream failure is a cooldown WITH a retry deadline", () => {
    const c = classifyAccountError(
      Object.assign(new Error("upstream returned 502"), { status: 502 }),
      { origin: "upstream", scope: "provider", statusCode: 502 },
    );
    expect(c.status).toBe("cooldown");
    expect(c.retryAt).not.toBeNull();
    expect(c.retryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(c.cooldownMs).toBeGreaterThan(0);
  });

  test("an unclassified failure is a cooldown WITH a retry deadline", () => {
    const c = classifyAccountError(new Error("something nobody mapped"), {
      origin: "upstream",
      scope: "provider",
    });
    expect(c.status).toBe("cooldown");
    expect(c.retryAt).not.toBeNull();
    expect(c.retryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("no non-active classification leaves the deadline unset", () => {
    // Sweep the whole taxonomy: quota, rate limit, capacity, timeout, server,
    // unknown. Every one of them must be recoverable without operator action.
    const cases: Array<[string, unknown, Parameters<typeof classifyAccountError>[1]]> = [
      ["quota", Object.assign(new Error("insufficient_quota"), { status: 402 }), { origin: "upstream", scope: "account", statusCode: 402, credentialEvidence: true }],
      ["rate limit", Object.assign(new Error("rate_limit_exceeded"), { status: 429 }), { origin: "upstream", scope: "account", statusCode: 429, credentialEvidence: true }],
      ["capacity", Object.assign(new Error("model overloaded"), { status: 503 }), { origin: "upstream", scope: "account", statusCode: 503, credentialEvidence: true, modelId: "m" }],
      ["timeout", new Error("upstream timeout"), { origin: "upstream", scope: "provider" }],
      ["server", Object.assign(new Error("502 bad gateway"), { status: 502 }), { origin: "upstream", scope: "provider", statusCode: 502 }],
      ["unknown", new Error("nobody mapped this"), { origin: "upstream", scope: "provider" }],
    ];
    for (const [label, error, evidence] of cases) {
      const c = classifyAccountError(error, evidence);
      expect({ label, hasRetry: c.retryAt !== null }).toEqual({ label, hasRetry: true });
    }
  });
});
