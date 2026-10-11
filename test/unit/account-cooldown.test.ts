/**
 * The account cooldown write: monotonic deadlines and the fallback escalation
 * ladder.
 *
 * `recordAccountFailure` is the only writer of an account's cooling state, and
 * it recomputes its deadline from *now* on every call. Two properties keep that
 * recomputation from doing damage, and both are pinned here because neither is
 * visible from the outside — they are properties of a single UPDATE.
 *
 * 1. **A deadline may only move later.** A fresh short failure used to overwrite
 *    a longer window already in force, so a 60-second unclassified cooldown
 *    released an account the provider had parked for hours — where it failed
 *    again, once a minute, forever. (An account-scoped and a model-scoped write,
 *    because they are two separate columns with two separate histories.)
 *
 * 2. **`consecutiveFailures` is a backoff level.** The column had been
 *    incremented on every failure for as long as the health machine existed and
 *    read by nothing, so a broken upstream was re-dialled once a minute
 *    indefinitely. Each further consecutive failure now doubles a *fallback*
 *    duration — never one the provider stated, which is the truth.
 *
 * A database double stands in for the handle. That is deliberate: the behavior
 * under test is exactly which values reach `.set()`, and a real database would
 * only obscure it. Every assertion reads a captured UPDATE payload.
 */
import { describe, expect, test } from "bun:test";
import { recordAccountFailure } from "../../src/providers/operations/account-health-service";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { AccountFailureEvidence } from "../../src/providers/operations/account-health-service";

interface Captured {
  readonly updates: Record<string, unknown>[];
  readonly events: Record<string, unknown>[];
}

/**
 * A drizzle-shaped double over one in-memory account row.
 *
 * Chainable and awaitable at each link the production path uses
 * (`select().from().where().limit()`, `update().set().where()`,
 * `insert().values()`), with `transaction()` invoking its callback against the
 * same client so the captured payloads are the ones production wrote.
 */
function dbDouble(account: Record<string, unknown>): { db: CartethyiaDatabase; captured: Captured } {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const client = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [account],
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        events.push(row);
      },
    }),
  };
  const db = {
    ...client,
    transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  } as unknown as CartethyiaDatabase;
  return { db, captured: { updates, events } };
}

/** An account in a long provider-stated window, already failing repeatedly. */
function coolingAccount(): Record<string, unknown> {
  return {
    id: "acc-1",
    status: "cooldown",
    consecutiveFailures: 3,
    staticToken: false,
    // The provider's own statement: "Try again in 11h".
    cooldownUntil: new Date(Date.now() + 11 * 3600_000),
    modelCooldowns: {},
    lastErrorCategory: "quota_exhausted",
    lastError: null,
    lastErrorAt: null,
  };
}

/** A rate limit the provider gave no reset for. */
function unstatedRateLimit(extra: AccountFailureEvidence = {}): AccountFailureEvidence {
  return { origin: "upstream", scope: "provider", statusCode: 429, ...extra };
}

/** The single account-wide UPDATE a run produced. */
function onlyUpdate(captured: Captured): Record<string, unknown> {
  expect(captured.updates).toHaveLength(1);
  return captured.updates[0]!;
}

function deadlineMsOf(payload: Record<string, unknown>): number {
  const until = payload.cooldownUntil;
  expect(until).toBeInstanceOf(Date);
  return (until as Date).getTime();
}

describe("recordAccountFailure — a cooling deadline only ever moves later", () => {
  test("an unstated 429 cannot shorten a provider-stated 11h window", async () => {
    // The bug: the new deadline was written unconditionally, so the recomputed
    // 15-minute fallback replaced the provider's 11-hour statement and put the
    // account straight back into rotation inside a closed window.
    const { db, captured } = dbDouble(coolingAccount());
    await recordAccountFailure(db, "acc-1", new Error("429 too many requests"), unstatedRateLimit());
    const deadline = deadlineMsOf(onlyUpdate(captured));
    const providerWindowEnd = Date.now() + 11 * 3600_000;
    expect(deadline).toBeGreaterThanOrEqual(providerWindowEnd - 1_000);
  });

  test("escalation does not smuggle the shortening back in", async () => {
    // The streak is 3, so the fallback escalates to 15m * 2^3 = 2h — still far
    // inside the provider's 11h. Asserting only "the window grew" would pass
    // while the account was released eight hours early.
    const { db, captured } = dbDouble(coolingAccount());
    await recordAccountFailure(db, "acc-1", new Error("429 too many requests"), unstatedRateLimit());
    const escalatedFallback = Date.now() + 15 * 60_000 * 2 ** 3;
    expect(deadlineMsOf(onlyUpdate(captured))).toBeGreaterThan(escalatedFallback);
  });

  test("a model-scoped failure cannot shorten that model's window either", async () => {
    // Separate column, separate history, same rule. This is the more common
    // throttle: a model-scoped rate limit takes the model path, which never
    // touched the account-wide deadline at all.
    const account = coolingAccount();
    account["modelCooldowns"] = { "gpt-5": new Date(Date.now() + 11 * 3600_000).toISOString() };
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("429 too many requests"),
      unstatedRateLimit({ modelId: "gpt-5" }),
    );
    const written = onlyUpdate(captured).modelCooldowns as Record<string, string>;
    expect(new Date(written["gpt-5"]!).getTime()).toBeGreaterThanOrEqual(Date.now() + 11 * 3600_000 - 1_000);
  });

  test("a longer new verdict still wins over a shorter one in force", async () => {
    // Monotonic means *not earlier*, not *never changes*: a provider that
    // re-parked the account for longer must be able to extend the window.
    const account = coolingAccount();
    account["cooldownUntil"] = new Date(Date.now() + 60_000);
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("429 too many requests"),
      unstatedRateLimit(),
    );
    expect(deadlineMsOf(onlyUpdate(captured))).toBeGreaterThan(Date.now() + 60_000);
  });
});

describe("recordAccountFailure — consecutiveFailures is a backoff level", () => {
  test("each further consecutive failure doubles an unstated fallback", async () => {
    // The base rate-limit fallback is 15m. Level 2 doubles it twice.
    const account = coolingAccount();
    account["cooldownUntil"] = null;
    account["consecutiveFailures"] = 2;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(db, "acc-1", new Error("429 too many requests"), unstatedRateLimit());
    const expected = Date.now() + 15 * 60_000 * 4;
    // A minute of slack for the clock ticking between the write and the assert.
    expect(deadlineMsOf(onlyUpdate(captured))).toBeGreaterThanOrEqual(expected - 1_000);
    expect(deadlineMsOf(onlyUpdate(captured))).toBeLessThan(expected + 5_000);
  });

  test("a first failure is not escalated", async () => {
    // Level 0 must be the untouched fallback, or every ordinary one-off rate
    // limit would come back doubled.
    const account = coolingAccount();
    account["cooldownUntil"] = null;
    account["consecutiveFailures"] = 0;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(db, "acc-1", new Error("429 too many requests"), unstatedRateLimit());
    const expected = Date.now() + 15 * 60_000;
    expect(deadlineMsOf(onlyUpdate(captured))).toBeGreaterThanOrEqual(expected - 1_000);
    expect(deadlineMsOf(onlyUpdate(captured))).toBeLessThan(expected + 5_000);
  });

  test("the ladder is capped, so escalation cannot outlive the window", async () => {
    // A very long streak must clamp to the configured ceiling rather than
    // parking a recovered account indefinitely.
    const account = coolingAccount();
    account["cooldownUntil"] = null;
    account["consecutiveFailures"] = 99;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(db, "acc-1", new Error("429 too many requests"), unstatedRateLimit());
    expect(deadlineMsOf(onlyUpdate(captured))).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);
  });

  test("a duration the provider stated is never multiplied", async () => {
    // The provider's own reset is the truth about its window; doubling it would
    // hold a perfectly good account out of rotation for twice as long as the
    // upstream asked.
    const account = coolingAccount();
    account["cooldownUntil"] = null;
    account["consecutiveFailures"] = 8;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("429 quota will reset in 2 hours"),
      unstatedRateLimit(),
    );
    const expected = Date.now() + 2 * 3600_000;
    expect(deadlineMsOf(onlyUpdate(captured))).toBeGreaterThanOrEqual(expected - 2_000);
    expect(deadlineMsOf(onlyUpdate(captured))).toBeLessThanOrEqual(expected + 5_000);
  });

  test("a Retry-After header is honoured verbatim over any escalation", async () => {
    const account = coolingAccount();
    account["cooldownUntil"] = null;
    account["consecutiveFailures"] = 6;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("429 too many requests"),
      unstatedRateLimit({ retryAfterMs: 300_000 }),
    );
    const expected = Date.now() + 300_000;
    expect(deadlineMsOf(onlyUpdate(captured))).toBeGreaterThanOrEqual(expected - 2_000);
    expect(deadlineMsOf(onlyUpdate(captured))).toBeLessThanOrEqual(expected + 5_000);
  });
});

describe("recordAccountFailure — the streak counts every throttle", () => {
  test("a model-scoped throttle advances the account streak too", async () => {
    // The counter used to be incremented only on the account-wide path, so the
    // most common throttle — a model-scoped rate limit — could never escalate
    // and a broken (account, model) pair was retried once a minute forever.
    const account = coolingAccount();
    account["consecutiveFailures"] = 0;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("429 too many requests"),
      unstatedRateLimit({ modelId: "gpt-5" }),
    );
    const written = onlyUpdate(captured).modelCooldowns as Record<string, string>;
    // Level 0 on the first failure: the untouched 15-minute fallback.
    const expected = Date.now() + 15 * 60_000;
    expect(new Date(written["gpt-5"]!).getTime()).toBeGreaterThanOrEqual(expected - 1_000);
    expect(onlyUpdate(captured).consecutiveFailures).toBeDefined();
  });
});

describe("recordAccountFailure — an auth rejection writes a cooldown, not a disable", () => {
  test("an expired OAuth token cools the account", async () => {
    // `disabled` is the one state no sweep recovers, and an expiry is the
    // clearest case that must never reach it: there is a refresh to run. This
    // pins the auth split at the write, so a regression that parks expiries
    // again fails here rather than in production.
    const account = coolingAccount();
    account["status"] = "active";
    account["cooldownUntil"] = null;
    account["credentialKind"] = "oauth";
    account["consecutiveFailures"] = 0;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("token expired"),
      { origin: "upstream", scope: "account", statusCode: 401 },
    );
    const payload = onlyUpdate(captured);
    expect(payload.status).toBe("cooldown");
    expect(payload.cooldownUntil).toBeInstanceOf(Date);
  });

  test("a bare 401 cools the account", async () => {
    // The weak-evidence case the old branch got wrong: clock skew, a key rotated
    // upstream a moment ago, an edge answering before the credential loads.
    const account = coolingAccount();
    account["status"] = "active";
    account["cooldownUntil"] = null;
    account["consecutiveFailures"] = 0;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("401 Unauthorized"),
      { origin: "upstream", scope: "account", statusCode: 401 },
    );
    expect(onlyUpdate(captured).status).toBe("cooldown");
  });

  test("a named revocation still disables the account", async () => {
    // The carve-out the split must preserve: a dead credential has no window to
    // wait out and no refresh to run, so a cooldown only returns it to rotation
    // to fail again.
    const account = coolingAccount();
    account["status"] = "active";
    account["cooldownUntil"] = null;
    account["credentialKind"] = "oauth";
    account["consecutiveFailures"] = 0;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("token_revoked"),
      { origin: "upstream", scope: "account", statusCode: 401 },
    );
    expect(onlyUpdate(captured).status).toBe("disabled");
  });

  test("the disable carries a deadline, so the sweep can undo the machine's verdict", async () => {
    // `disabled` used to be terminal: a key revoked once — or a refresh grant
    // the upstream had since re-authorized — left rotation until an operator
    // noticed by hand. The deadline is what makes automating the recovery safe,
    // and it is the only thing distinguishing an automatic disable from an
    // operator's (which keeps `cooldownUntil` null and is never swept).
    const account = coolingAccount();
    account["status"] = "active";
    account["cooldownUntil"] = null;
    account["credentialKind"] = "oauth";
    account["consecutiveFailures"] = 0;
    const { db, captured } = dbDouble(account);
    await recordAccountFailure(
      db,
      "acc-1",
      new Error("token_revoked"),
      { origin: "upstream", scope: "account", statusCode: 401 },
    );
    const deadline = deadlineMsOf(onlyUpdate(captured));
    expect(deadline).toBeGreaterThan(Date.now() + 80_000_000);
    expect(deadline).toBeLessThan(Date.now() + 90_000_000);
  });

  test("CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS=0 writes no deadline — terminal again", async () => {
    // The documented escape hatch. It has to change the write, or the comment
    // promising the old behavior is a lie.
    process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS = "0";
    try {
      const account = coolingAccount();
      account["status"] = "active";
      account["cooldownUntil"] = null;
      account["credentialKind"] = "oauth";
      account["consecutiveFailures"] = 0;
      const { db, captured } = dbDouble(account);
      await recordAccountFailure(
        db,
        "acc-1",
        new Error("token_revoked"),
        { origin: "upstream", scope: "account", statusCode: 401 },
      );
      expect(onlyUpdate(captured).status).toBe("disabled");
      expect(onlyUpdate(captured).cooldownUntil).toBeNull();
    } finally {
      delete process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
    }
  });
});
