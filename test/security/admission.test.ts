/**
 * Admission: the counter that decides whether a request is allowed to cost
 * money.
 *
 * Two layers are covered here, both without I/O:
 *
 * - `InMemoryAdmissionCounterStore` — the atomic accounting primitive. Its
 *   whole job is that a reservation is charged exactly once and settled
 *   exactly once, so the tests concentrate on **idempotency**, **counter
 *   reversal**, and **bucket identity**. A bug in any of those either lets a
 *   key overspend (reservation charged but never released) or locks a key out
 *   of its own budget (double-charged).
 * - `ApiKeyAdmissionService` — the translation from an authorization snapshot
 *   to a lease. The tests pin the rejection reason each limit produces, because
 *   that reason is the operator's only explanation for a 429, and the
 *   `finalized` flag, because a second commit must not charge twice.
 *
 * The properties are chosen so that a regression breaks a test rather than a
 * tenant's billing: every assertion is about a *state* the operator can
 * observe (a counter value, a rejection reason, a released flag).
 */
import { describe, expect, test } from "bun:test";
import { ApiKeyAdmissionService } from "../../src/security/admission/service";
import { InMemoryAdmissionCounterStore } from "../../src/security/admission/in-memory-store";
import { LEASE_KEY_TTL_SECONDS, LEASE_REAP_HORIZON_SECONDS } from "../../src/security/admission/ttl";
import type {
  AdmissionCounterStore,
  AdmissionReserveRequest,
} from "../../src/security/admission/contracts";
import type { ApiKeyAuthorizationSnapshot } from "../../src/security/api-key-auth";
import { GatewayError } from "../../src/transport/gateway-error";
import type { UsageRecord } from "../../src/transport/canonical-model";

/** Midnight UTC on 2026-03-15, so the daily and monthly buckets are unambiguous. */
const NOW = Date.UTC(2026, 2, 15, 12, 0, 0);
const DAY_MS = 86_400_000;

function usage(input: { input?: number; output?: number } = {}): UsageRecord {
  const inputTokens = input.input ?? 0;
  const outputTokens = input.output ?? 0;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    uncached_input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    estimated_cost: null,
    total_tokens: inputTokens + outputTokens,
  };
}

/** Every limit absent unless the caller names it. */
function reserveRequest(
  overrides: Partial<AdmissionReserveRequest> & { reservationId: string },
): AdmissionReserveRequest {
  return {
    apiKeyId: "key-a",
    now: NOW,
    estimatedTokens: 100,
    rpmLimit: null,
    dailyLimit: null,
    monthlyLimit: null,
    lifetimeBudget: null,
    lifetimeConsumed: 0,
    concurrencyLimit: null,
    tenantId: "tenant-a",
    tenantConcurrencyLimit: null,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<ApiKeyAuthorizationSnapshot> = {},
): ApiKeyAuthorizationSnapshot {
  return { api_key_id: "key-a", tenant_id: "tenant-a", ...overrides };
}

describe("InMemoryAdmissionCounterStore — reservation idempotency", () => {
  test("re-reserving the same id is a no-op, not a second charge", async () => {
    // A retried admission must not consume two slots: the lease is keyed by
    // reservation id, so the second call has to short-circuit before any
    // counter write. This is the difference between "retry-safe" and "a retry
    // costs the tenant a second request".
    const store = new InMemoryAdmissionCounterStore();
    const request = reserveRequest({
      reservationId: "r-1",
      estimatedTokens: 100,
      dailyLimit: 10_000,
      concurrencyLimit: 5,
    });
    await store.reserve(request);
    await store.reserve(request);
    expect(await store.getDailyTokens("key-a", NOW)).toBe(100);
    expect(await store.getConcurrent("key-a")).toBe(1);
  });

  test("a committed reservation is still recognised as a replay", async () => {
    // The lease state machine is checked for all three terminal states, so a
    // late duplicate arriving after the request finished must also be inert —
    // otherwise a slow retry double-charges a request that already completed.
    const store = new InMemoryAdmissionCounterStore();
    const request = reserveRequest({ reservationId: "r-1", dailyLimit: 10_000 });
    await store.reserve(request);
    await store.reconcile("key-a", 100, 40, "r-1");
    await store.reserve(request);
    expect(await store.getDailyTokens("key-a", NOW)).toBe(40);
  });

  test("a released reservation is still recognised as a replay", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const request = reserveRequest({ reservationId: "r-1", dailyLimit: 10_000 });
    await store.reserve(request);
    await store.release("key-a", 100, "r-1");
    await store.reserve(request);
    // Released means refunded: the replay must not re-charge the estimate.
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
  });

  test("reconcile and release are each idempotent", async () => {
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({ reservationId: "r-1", dailyLimit: 10_000, concurrencyLimit: 3 }),
    );
    await store.reconcile("key-a", 100, 250, "r-1");
    await store.reconcile("key-a", 100, 250, "r-1");
    // A second reconcile with a *different* actual must also be ignored — the
    // reservation is committed and its delta already applied.
    await store.reconcile("key-a", 100, 9_999, "r-1");
    expect(await store.getDailyTokens("key-a", NOW)).toBe(250);
    expect(await store.getConcurrent("key-a")).toBe(0);
    await store.release("key-a", 100, "r-1");
    expect(await store.getDailyTokens("key-a", NOW)).toBe(250);
  });
});

describe("InMemoryAdmissionCounterStore — reconciliation arithmetic", () => {
  test("an over-estimate refunds the difference", async () => {
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(reserveRequest({ reservationId: "r-1", estimatedTokens: 1_000, dailyLimit: 10_000 }));
    await store.reconcile("key-a", 1_000, 120, "r-1");
    expect(await store.getDailyTokens("key-a", NOW)).toBe(120);
  });

  test("an under-estimate charges the difference", async () => {
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(reserveRequest({ reservationId: "r-1", estimatedTokens: 100, dailyLimit: 10_000 }));
    await store.reconcile("key-a", 100, 4_000, "r-1");
    expect(await store.getDailyTokens("key-a", NOW)).toBe(4_000);
  });

  test("actual usage of zero refunds the whole estimate", async () => {
    // A provider that reports no usage at all must not leave the estimate
    // standing; the tenant paid nothing.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(reserveRequest({ reservationId: "r-1", estimatedTokens: 500, dailyLimit: 10_000 }));
    await store.reconcile("key-a", 500, 0, "r-1");
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
  });

  test("a non-integer actual is rejected as corrupt rather than rounded", async () => {
    // `finiteNonNegative` demands an integer. Rounding silently would let a
    // fractional delta accumulate into a counter the next reserve rejects.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(reserveRequest({ reservationId: "r-1", dailyLimit: 10_000 }));
    await expect(store.reconcile("key-a", 100, 1.5, "r-1")).rejects.toThrow(
      /corrupt admission counter|admission store unavailable/,
    );
  });

  test("reconcile against an unknown reservation fails closed", async () => {
    // The guard compares id, key, AND the reserved amount, so a reconcile that
    // remembers the wrong estimate cannot corrupt a live counter.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(reserveRequest({ reservationId: "r-1", estimatedTokens: 100, dailyLimit: 10_000 }));
    await expect(store.reconcile("key-a", 100, 50, "nope")).rejects.toBeInstanceOf(GatewayError);
    await expect(store.reconcile("other-key", 100, 50, "r-1")).rejects.toBeInstanceOf(GatewayError);
    await expect(store.reconcile("key-a", 999, 50, "r-1")).rejects.toBeInstanceOf(GatewayError);
    expect(await store.getDailyTokens("key-a", NOW)).toBe(100);
  });
});

describe("InMemoryAdmissionCounterStore — limit enforcement", () => {
  test("the estimate is checked against the limit before it is charged", async () => {
    // Boundary: `daily + estimated > limit` rejects, so spending exactly the
    // limit is allowed. Pin the inclusive edge — an operator who sets a 1000
    // budget expects 1000 tokens to be spendable.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({ reservationId: "r-1", estimatedTokens: 600, dailyLimit: 1_000 }),
    );
    await expect(
      store.reserve(reserveRequest({ reservationId: "r-2", estimatedTokens: 401, dailyLimit: 1_000 })),
    ).rejects.toBeInstanceOf(GatewayError);
    await store.reserve(
      reserveRequest({ reservationId: "r-3", estimatedTokens: 400, dailyLimit: 1_000 }),
    );
    expect(await store.getDailyTokens("key-a", NOW)).toBe(1_000);
  });

  test("each limit produces its own reason", async () => {
    // The reason is what the operator sees in the 429 body and in the metric
    // label, so a mixed-up mapping sends them tuning the wrong limit.
    // The first reserve must fit, so the token limits sit between 100 and 200
    // while the count-based limits admit exactly one.
    const cases: readonly {
      readonly overrides: Partial<AdmissionReserveRequest>;
      readonly expected: string;
    }[] = [
      { overrides: { rpmLimit: 1 }, expected: "rpm-exhausted" },
      { overrides: { dailyLimit: 150 }, expected: "daily-token-limit" },
      { overrides: { monthlyLimit: 150 }, expected: "monthly-token-limit" },
      { overrides: { lifetimeBudget: 150 }, expected: "lifetime-token-budget" },
      { overrides: { concurrencyLimit: 1 }, expected: "concurrency-limit" },
      { overrides: { tenantConcurrencyLimit: 1 }, expected: "tenant-capacity-exhausted" },
    ];
    for (const { overrides, expected } of cases) {
      const store = new InMemoryAdmissionCounterStore();
      await store.reserve(reserveRequest({ reservationId: "r-1", estimatedTokens: 100, ...overrides }));
      const failure = await store
        .reserve(reserveRequest({ reservationId: "r-2", estimatedTokens: 100, ...overrides }))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(GatewayError);
      expect((failure as GatewayError).details.reason).toBe(expected);
    }
  });

  test("a rejected reserve charges nothing", async () => {
    // The check must precede every write. If a limit check ran after a counter
    // write, a rejected request would still consume budget.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        estimatedTokens: 100,
        dailyLimit: 150,
        concurrencyLimit: 5,
      }),
    );
    await expect(
      store.reserve(
        reserveRequest({
          reservationId: "r-2",
          estimatedTokens: 100,
          dailyLimit: 150,
          concurrencyLimit: 5,
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(await store.getDailyTokens("key-a", NOW)).toBe(100);
    expect(await store.getConcurrent("key-a")).toBe(1);
  });

  test("a null limit is unrestricted, not zero", async () => {
    // `null` and `0` are different: a null limit must never reject. Getting
    // this backwards would block every key with no configured budget.
    const store = new InMemoryAdmissionCounterStore();
    for (let index = 0; index < 5; index += 1) {
      await store.reserve(
        reserveRequest({ reservationId: `r-${index}`, estimatedTokens: 1_000_000 }),
      );
    }
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
  });

  test("rpm counts requests inside the window and forgets older ones", async () => {
    const store = new InMemoryAdmissionCounterStore({ windowMs: 60_000 });
    await store.reserve(reserveRequest({ reservationId: "r-1", now: NOW, rpmLimit: 2 }));
    await store.reserve(reserveRequest({ reservationId: "r-2", now: NOW + 1_000, rpmLimit: 2 }));
    await expect(
      store.reserve(reserveRequest({ reservationId: "r-3", now: NOW + 2_000, rpmLimit: 2 })),
    ).rejects.toBeInstanceOf(GatewayError);
    // The first timestamp falls out of the window, so a slot frees up.
    await store.reserve(reserveRequest({ reservationId: "r-4", now: NOW + 60_001, rpmLimit: 2 }));
  });

  test("the rpm window drops a request exactly one window old", async () => {
    // `timestamp > cutoff` keeps entries strictly newer than the cutoff, so a
    // request exactly one window old is already forgotten and its slot is free.
    // Pin the edge so a refactor to `>=` — which would hold one request too
    // many, and is the off-by-one an operator would report as "the limit
    // drifts down over time" — is caught.
    const store = new InMemoryAdmissionCounterStore({ windowMs: 60_000 });
    await store.reserve(reserveRequest({ reservationId: "r-1", now: NOW, rpmLimit: 1 }));
    await store.reserve(reserveRequest({ reservationId: "r-2", now: NOW + 60_000, rpmLimit: 1 }));
    // One millisecond earlier and the first timestamp is still in the window.
    await expect(
      store.reserve(reserveRequest({ reservationId: "r-3", now: NOW + 60_000, rpmLimit: 1 })),
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("InMemoryAdmissionCounterStore — bucket identity", () => {
  test("daily counters are per calendar day and monthly per calendar month", async () => {
    // The bucket is part of the key so a budget rolls over instead of
    // accumulating forever. A shared key would let one day's spend exhaust the
    // next day's budget before it began.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        now: NOW,
        estimatedTokens: 500,
        dailyLimit: 10_000,
        monthlyLimit: 50_000,
      }),
    );
    expect(await store.getDailyTokens("key-a", NOW + DAY_MS)).toBe(0);
    expect(await store.getDailyTokens("key-a", NOW)).toBe(500);
    // April is a different month bucket; March's spend must not follow it.
    const april = Date.UTC(2026, 3, 2, 12, 0, 0);
    expect(await store.getMonthlyTokens("key-a", april)).toBe(0);
    expect(await store.getMonthlyTokens("key-a", NOW)).toBe(500);
  });

  test("a counter is only written when its own limit is configured", async () => {
    // The three token counters are written independently. A key with only a
    // daily budget must not accrue a monthly or lifetime total, or the operator
    // would later see spend they never enabled a limit for.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({ reservationId: "r-1", estimatedTokens: 500, dailyLimit: 10_000 }),
    );
    expect(await store.getDailyTokens("key-a", NOW)).toBe(500);
    expect(await store.getMonthlyTokens("key-a", NOW)).toBe(0);
  });

  test("a reservation admitted before midnight settles against its own bucket", async () => {
    // The comment on `dailyKey`/`monthlyKey` states the reason this is stored
    // on the reservation: a request admitted at 23:59 that releases after
    // midnight must refund the day it charged, not the new day's counter.
    const store = new InMemoryAdmissionCounterStore();
    const beforeMidnight = Date.UTC(2026, 2, 15, 23, 59, 0);
    const afterMidnight = Date.UTC(2026, 2, 16, 0, 1, 0);
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        now: beforeMidnight,
        estimatedTokens: 400,
        dailyLimit: 10_000,
      }),
    );
    await store.release("key-a", 400, "r-1");
    expect(await store.getDailyTokens("key-a", beforeMidnight)).toBe(0);
    // The new day's counter must be untouched — and, in particular, not
    // decremented below zero into a corrupt state.
    expect(await store.getDailyTokens("key-a", afterMidnight)).toBe(0);
  });

  test("lifetime counters are not bucketed", async () => {
    // The lifetime budget has no bucket to expire on, so it must survive the
    // calendar rollovers that reset daily and monthly.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        now: NOW,
        estimatedTokens: 700,
        lifetimeBudget: 10_000,
        lifetimeConsumed: 0,
      }),
    );
    await expect(
      store.reserve(
        reserveRequest({
          reservationId: "r-2",
          now: NOW + DAY_MS,
          estimatedTokens: 9_301,
          lifetimeBudget: 10_000,
          lifetimeConsumed: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("InMemoryAdmissionCounterStore — lifetime seeding", () => {
  test("the snapshot value seeds a missing counter", async () => {
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        estimatedTokens: 100,
        lifetimeBudget: 1_000,
        lifetimeConsumed: 900,
      }),
    );
    // 900 + 100 fits exactly; one more token would not.
    await expect(
      store.reserve(
        reserveRequest({
          reservationId: "r-2",
          estimatedTokens: 1,
          lifetimeBudget: 1_000,
          lifetimeConsumed: 900,
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("a fresh read replaces the snapshot seed only on the creating write", async () => {
    // The documented mechanism: a cached auth snapshot can understate the
    // persisted total, and once the counter exists it is never re-seeded, so
    // the fresh read must happen on exactly the write that creates it.
    const store = new InMemoryAdmissionCounterStore();
    let reads = 0;
    const freshLifetimeConsumed = async (): Promise<number> => {
      reads += 1;
      return 5_000;
    };
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        estimatedTokens: 100,
        lifetimeBudget: 10_000,
        lifetimeConsumed: 0,
        freshLifetimeConsumed,
      }),
    );
    expect(reads).toBe(1);
    // The counter now exists at 5_100, so a second reserve must read the
    // counter, not the persisted store.
    await store.reserve(
      reserveRequest({
        reservationId: "r-2",
        estimatedTokens: 100,
        lifetimeBudget: 10_000,
        lifetimeConsumed: 0,
        freshLifetimeConsumed,
      }),
    );
    expect(reads).toBe(1);
    await expect(
      store.reserve(
        reserveRequest({
          reservationId: "r-3",
          estimatedTokens: 4_900,
          lifetimeBudget: 10_000,
          lifetimeConsumed: 0,
          freshLifetimeConsumed,
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("an unusable fresh read falls back to the snapshot value", async () => {
    // The reader is optional and may legitimately fail; the fallback must be
    // the snapshot, not zero — seeding zero would hand the key a fresh budget.
    const cases: readonly (number | undefined)[] = [undefined, Number.NaN, -1];
    for (const fresh of cases) {
      const store = new InMemoryAdmissionCounterStore();
      await store.reserve(
        reserveRequest({
          reservationId: "r-1",
          estimatedTokens: 100,
          lifetimeBudget: 1_000,
          lifetimeConsumed: 800,
          freshLifetimeConsumed: async () => fresh,
        }),
      );
      // 800 seeded + 100 reserved = 900; one token past the budget must fail.
      await expect(
        store.reserve(
          reserveRequest({
            reservationId: "r-2",
            estimatedTokens: 101,
            lifetimeBudget: 1_000,
            lifetimeConsumed: 800,
            freshLifetimeConsumed: async () => fresh,
          }),
        ),
      ).rejects.toBeInstanceOf(GatewayError);
    }
  });

  test("a non-integer fresh read is floored rather than trusted", async () => {
    // A fractional token count would make every later `finiteNonNegative`
    // check fail, so the seed has to be an integer.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        estimatedTokens: 100,
        lifetimeBudget: 10_000,
        lifetimeConsumed: 0,
        freshLifetimeConsumed: async () => 5_000.9,
      }),
    );
    // Seeded at the floor (5000), so the counter stands at 5100.
    await expect(
      store.reserve(
        reserveRequest({
          reservationId: "r-2",
          estimatedTokens: 4_901,
          lifetimeBudget: 10_000,
          lifetimeConsumed: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  /**
   * KNOWN DEFECT — the fresh lifetime read is issued even when there is no
   * lifetime counter to seed.
   *
   * `AdmissionReserveRequest.freshLifetimeConsumed`'s doc comment states the
   * contract: "This callback is invoked *only when the store is about to create
   * the counter* … The hot path — an existing counter — never calls it."
   * `RedisAdmissionCounterStore` honours it with an explicit
   * `request.lifetimeBudget != null` guard before it reads.
   * `InMemoryAdmissionCounterStore.reserve` has no such guard: it awaits the
   * callback first and only afterwards discovers it has no key to write the
   * value to, so the result is discarded.
   *
   * Reachable impact: this store is the implementation used whenever Redis is
   * absent (`runtime/dependencies.ts` picks it for single-instance mode). The
   * callback wired there is not free — it runs `findActiveById` plus
   * `sumChildrenConsumed`, two Postgres round trips — so a key with no lifetime
   * budget pays both on every admitted request, for a value nothing consumes.
   *
   * Written with `test.failing` so it flips to a failure the moment the guard
   * is added, which is the signal to drop the marker and keep the assertion.
   */
  test("the fresh reader is not called when no lifetime budget is set", async () => {
    // The guard this pins: the callback is consulted only when a lifetime budget
    // exists, matching the Redis store. Without it every admitted request paid the
    // callback's cost — the wired one runs two Postgres round trips — for a value
    // the store then discarded, because it had no key to write it to.
    const store = new InMemoryAdmissionCounterStore();
    let reads = 0;
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        lifetimeBudget: null,
        freshLifetimeConsumed: async () => {
          reads += 1;
          return 1;
        },
      }),
    );
    expect(reads).toBe(0);
  });

  test("the fresh reader IS called when a lifetime budget is set", async () => {
    // The other half of the same contract, so the `test.failing` above cannot
    // be satisfied by disabling the callback outright.
    const store = new InMemoryAdmissionCounterStore();
    let reads = 0;
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        estimatedTokens: 10,
        lifetimeBudget: 10_000,
        freshLifetimeConsumed: async () => {
          reads += 1;
          return 500;
        },
      }),
    );
    expect(reads).toBe(1);
  });
});

describe("InMemoryAdmissionCounterStore — corrupt state fails closed", () => {
  test("a non-integer estimate is rejected before any counter write", async () => {
    const store = new InMemoryAdmissionCounterStore();
    await expect(
      store.reserve(reserveRequest({ reservationId: "r-1", estimatedTokens: 1.5, dailyLimit: 10_000 })),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
  });

  test("negative and non-finite counters are rejected", async () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5];
    for (const value of bad) {
      const store = new InMemoryAdmissionCounterStore();
      await expect(
        store.reserve(
          reserveRequest({
            reservationId: "r-1",
            estimatedTokens: value,
            dailyLimit: 10_000,
          }),
        ),
      ).rejects.toBeInstanceOf(GatewayError);
      await expect(
        store.reserve(
          reserveRequest({
            reservationId: "r-1",
            estimatedTokens: 100,
            dailyLimit: 10_000,
            lifetimeConsumed: value,
            lifetimeBudget: 10_000,
          }),
        ),
      ).rejects.toBeInstanceOf(GatewayError);
    }
  });

  test("an unavailable store rejects as admission-unavailable, never as allowed", async () => {
    // Fail-closed: a store outage must not read as "no limit".
    const store = new InMemoryAdmissionCounterStore();
    store.simulateFailure(true);
    const failure = await store
      .reserve(reserveRequest({ reservationId: "r-1" }))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GatewayError);
  });
});

describe("InMemoryAdmissionCounterStore — purge", () => {
  test("revocation drops every counter and every bucket", async () => {
    // A recycled key id must not inherit RPM history, bucket spend, or a held
    // concurrency slot from the key that previously owned the id.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        now: NOW,
        estimatedTokens: 400,
        dailyLimit: 10_000,
        monthlyLimit: 50_000,
        lifetimeBudget: 90_000,
        concurrencyLimit: 4,
        rpmLimit: 10,
      }),
    );
    await store.reserve(
      reserveRequest({
        reservationId: "r-2",
        now: NOW + 3 * DAY_MS,
        estimatedTokens: 700,
        dailyLimit: 10_000,
        monthlyLimit: 50_000,
        lifetimeBudget: 90_000,
        concurrencyLimit: 4,
        rpmLimit: 10,
      }),
    );
    await store.purge("key-a");
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
    expect(await store.getDailyTokens("key-a", NOW + 3 * DAY_MS)).toBe(0);
    expect(await store.getMonthlyTokens("key-a", NOW)).toBe(0);
    expect(await store.getConcurrent("key-a")).toBe(0);
  });

  test("purging one key leaves another key's counters alone", async () => {
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(reserveRequest({ reservationId: "a-1", apiKeyId: "key-a", estimatedTokens: 300, dailyLimit: 10_000 }));
    await store.reserve(reserveRequest({ reservationId: "b-1", apiKeyId: "key-b", estimatedTokens: 900, dailyLimit: 10_000 }));
    await store.purge("key-a");
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
    expect(await store.getDailyTokens("key-b", NOW)).toBe(900);
  });

  test("a release arriving after a purge is a silent no-op", async () => {
    // The documented ordering: in-flight reservations settle during the purge,
    // so the request that still holds a lease must not corrupt the zeroed
    // counters or throw an unknown-reservation error into the request path.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({
        reservationId: "r-1",
        estimatedTokens: 400,
        dailyLimit: 10_000,
        concurrencyLimit: 4,
      }),
    );
    await store.purge("key-a");
    await expect(store.release("key-a", 400, "r-1")).resolves.toBeUndefined();
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
    expect(await store.getConcurrent("key-a")).toBe(0);
  });
});

describe("InMemoryAdmissionCounterStore — seedBuckets", () => {
  test("seeds an empty bucket from recorded spend", async () => {
    // An operator adding a limit to a key that already spent today must not
    // hand it a fresh budget: the seed is the honest baseline.
    const store = new InMemoryAdmissionCounterStore();
    await store.seedBuckets({ apiKeyId: "key-a", now: NOW, daily: 900, monthly: 12_000 });
    await expect(
      store.reserve(
        reserveRequest({ reservationId: "r-1", estimatedTokens: 101, dailyLimit: 1_000 }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
    await store.reserve(
      reserveRequest({ reservationId: "r-2", estimatedTokens: 100, dailyLimit: 1_000 }),
    );
  });

  test("never overwrites a live counter", async () => {
    // SETNX semantics: an existing counter is the running total. Overwriting
    // it would erase spend and reopen the budget the operator just closed.
    const store = new InMemoryAdmissionCounterStore();
    await store.reserve(
      reserveRequest({ reservationId: "r-1", estimatedTokens: 500, dailyLimit: 10_000 }),
    );
    await store.seedBuckets({ apiKeyId: "key-a", now: NOW, daily: 10 });
    expect(await store.getDailyTokens("key-a", NOW)).toBe(500);
  });

  test("an omitted budget seeds nothing and a fractional seed is floored", async () => {
    const store = new InMemoryAdmissionCounterStore();
    await store.seedBuckets({ apiKeyId: "key-a", now: NOW, monthly: 1_000.9 });
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
    expect(await store.getMonthlyTokens("key-a", NOW)).toBe(1_000);
  });
});

describe("InMemoryAdmissionCounterStore — terminal reservation ring", () => {
  test("stays bounded while keeping recent replays idempotent", async () => {
    // The ring exists so single-process mode cannot grow without bound. It must
    // evict terminal entries only — an active reservation dropped from the map
    // would turn its own release into an unknown-reservation error.
    const cap = 10_000;
    const store = new InMemoryAdmissionCounterStore();
    const total = cap + 50;
    for (let index = 0; index < total; index += 1) {
      await store.reserve(
        reserveRequest({ reservationId: `r-${index}`, estimatedTokens: 1, dailyLimit: 10_000_000 }),
      );
      await store.release("key-a", 1, `r-${index}`);
    }
    // Every release refunded, so the counter is back at zero despite `total`
    // reservations having passed through.
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
    // A recent reservation is still a replay no-op...
    await store.reserve(reserveRequest({ reservationId: `r-${total - 1}`, estimatedTokens: 1, dailyLimit: 10_000_000 }));
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
  });
});

describe("InMemoryAdmissionCounterStore — serialisation", () => {
  test("concurrent reserves cannot over-admit the last slot", async () => {
    // The store serialises every operation through a gate, which is what makes
    // it a faithful stand-in for the Redis Lua script. Firing them without
    // awaiting proves the gate, not the caller, enforces the limit.
    const store = new InMemoryAdmissionCounterStore();
    const attempts = Array.from({ length: 10 }, (_, index) =>
      store.reserve(
        reserveRequest({
          reservationId: `r-${index}`,
          estimatedTokens: 100,
          concurrencyLimit: 3,
        }),
      ),
    );
    const settled = await Promise.allSettled(attempts);
    const admitted = settled.filter((result) => result.status === "fulfilled").length;
    expect(admitted).toBe(3);
    expect(await store.getConcurrent("key-a")).toBe(3);
  });
});

describe("admission lease TTLs", () => {
  test("a lease key outlives the reap horizon by more than one sweep interval", async () => {
    // The comment on LEASE_TTL_GRACE_SECONDS explains the failure this guards:
    // if the key TTL equalled the horizon, Redis would evict the hash exactly
    // when the sweeper wanted to read it and a crashed lease would strand its
    // concurrency slot. The sweep interval is 30s, so the grace must exceed it.
    expect(LEASE_KEY_TTL_SECONDS).toBeGreaterThan(LEASE_REAP_HORIZON_SECONDS);
    expect(LEASE_KEY_TTL_SECONDS - LEASE_REAP_HORIZON_SECONDS).toBeGreaterThan(30);
  });
});

describe("ApiKeyAdmissionService", () => {
  test("a successful admit returns a lease that reports itself released once settled", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const lease = await service.admit({
      authorization: snapshot(),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
    });
    expect(lease.released).toBe(false);
    await lease.release();
    expect(lease.released).toBe(true);
  });

  test("commitUsage reconciles against the estimate and persists the delta", async () => {
    // The persister is attributed to the authenticating key, not the admission
    // identity, so a share child's usage lands on the child row.
    const store = new InMemoryAdmissionCounterStore();
    const persisted: { apiKeyId: string; delta: number }[] = [];
    const service = new ApiKeyAdmissionService(
      store,
      () => NOW,
      () => null,
      async (input) => {
        persisted.push(input);
      },
    );
    const lease = await service.admit({
      authorization: snapshot({ daily_tokens: 10_000, api_key_id: "child-key", admission_identity: "parent-key" }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
      estimatedInputTokens: 400,
      estimatedOutputTokens: 100,
    });
    // Charged to the admission identity...
    expect(await store.getDailyTokens("parent-key", NOW)).toBe(500);
    await lease.commitUsage(usage({ input: 300, output: 80 }));
    expect(await store.getDailyTokens("parent-key", NOW)).toBe(380);
    // ...but persisted against the authenticating key.
    expect(persisted).toEqual([{ apiKeyId: "child-key", delta: 380 }]);
  });

  test("a second commit or release is inert", async () => {
    // The `finalized` flag is the only thing preventing a retried commit from
    // double-charging; `released` is the observable half of that contract.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const lease = await service.admit({
      authorization: snapshot({ daily_tokens: 10_000 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
      estimatedInputTokens: 500,
    });
    await lease.commitUsage(usage({ input: 200, output: 100 }));
    expect(await store.getDailyTokens("key-a", NOW)).toBe(300);
    await lease.commitUsage(usage({ input: 9_999, output: 9_999 }));
    await lease.release();
    expect(await store.getDailyTokens("key-a", NOW)).toBe(300);
  });

  test("release after commit is inert and refunds nothing", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const lease = await service.admit({
      authorization: snapshot({ daily_tokens: 10_000 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
      estimatedInputTokens: 500,
    });
    await lease.commitUsage(usage({ input: 200 }));
    await lease.release();
    expect(await store.getDailyTokens("key-a", NOW)).toBe(200);
  });

  test("commitUsage counts only input and output tokens", async () => {
    // Reasoning tokens are a breakdown *of* output on both wire families, and
    // cache writes are already folded into input by `normalizeUsage`. Charging
    // them again made a key hit its budget while it still had headroom.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const lease = await service.admit({
      authorization: snapshot({ daily_tokens: 10_000 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
    });
    await lease.commitUsage({
      ...usage({ input: 100, output: 50 }),
      cached_input_tokens: 9_000,
      cache_write_tokens: 8_000,
      uncached_input_tokens: 100,
      reasoning_tokens: 7_000,
      total_tokens: 30_000,
    });
    expect(await store.getDailyTokens("key-a", NOW)).toBe(150);
  });

  test("an unavailable usage count charges zero for that side", async () => {
    // `"unavailable"` is not zero usage, but it is also not a number the
    // counter can hold; `knownTokens` treats it as zero rather than throwing
    // in the middle of a completed request.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const lease = await service.admit({
      authorization: snapshot({ daily_tokens: 10_000 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
    });
    await lease.commitUsage({
      ...usage({ input: 120, output: 30 }),
      cached_input_tokens: "unavailable",
      cache_write_tokens: "unavailable",
      uncached_input_tokens: "unavailable",
      reasoning_tokens: "unavailable",
      total_tokens: "unavailable",
    });
    expect(await store.getDailyTokens("key-a", NOW)).toBe(150);
  });

  test("a persister failure does not fail the request", async () => {
    // Persisting is best-effort by contract: the transient counter already
    // reflects reality, and a later request overwrites the row.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(
      store,
      () => NOW,
      () => null,
      async () => {
        throw new Error("database is down");
      },
    );
    const lease = await service.admit({
      authorization: snapshot({ daily_tokens: 10_000 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
    });
    await expect(lease.commitUsage(usage({ input: 10 }))).resolves.toBeUndefined();
    expect(await store.getDailyTokens("key-a", NOW)).toBe(10);
  });

  test("a store failure surfaces as admission_unavailable", async () => {
    const store = new InMemoryAdmissionCounterStore();
    store.simulateFailure(true);
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const failure = await service
      .admit({ authorization: snapshot(), targetProvider: "anthropic", targetModel: "claude-sonnet-4-6" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("admission_unavailable");
    expect((failure as GatewayError).status).toBe(503);
  });

  test("an aborted signal is refused before any counter is touched", async () => {
    // A cancelled request must not hold a concurrency slot while it unwinds.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.admit({
        authorization: snapshot({ max_concurrent: 5 }),
        targetProvider: "anthropic",
        targetModel: "claude-sonnet-4-6",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(await store.getConcurrent("key-a")).toBe(0);
  });

  test("a model the key may not use is refused with the model reason", async () => {
    // `modelRejectionReason` runs inside admission as a second gate, after the
    // routing-time check. The reason must be the model reason, not a generic
    // one, or the operator sees a quota error for a permissions problem.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const failure = await service
      .admit({
        authorization: snapshot({ model_denylist: ["claude-opus-4-7"] }),
        targetProvider: "anthropic",
        targetModel: "claude-opus-4-7",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("model_not_found");
    expect((failure as GatewayError).details.reason).toBe("model-denied");
  });

  test("a qualified allowlist entry authorizes the target through admission", async () => {
    // The admission call passes the provider, unlike the routing-time check, so
    // this path is the one that makes a `provider/model` allowlist entry work.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    await expect(
      service.admit({
        authorization: snapshot({ model_allowlist: ["anthropic/claude-sonnet-4-6"] }),
        targetProvider: "anthropic",
        targetModel: "claude-sonnet-4-6",
      }),
    ).resolves.toBeDefined();
  });

  test("the estimated token count is floored as a sum, never per term", async () => {
    // MEASURED: `Math.max(0, Math.floor(input + output))` floors the SUM, so
    // 10.9 + (-5) reserves 5, not 10. Pinned because the difference is a real
    // budget question: a caller that sends a negative output estimate reduces
    // the reservation rather than being clamped to zero on its own side.
    // The result is still a non-negative integer, which is what the store's
    // `finiteNonNegative` guard requires.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const lease = await service.admit({
      authorization: snapshot({ daily_tokens: 10_000 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
      estimatedInputTokens: 10.9,
      estimatedOutputTokens: -5,
    });
    expect(lease.released).toBe(false);
    expect(await store.getDailyTokens("key-a", NOW)).toBe(5);
  });

  test("a negative sum floors at zero rather than going negative", async () => {
    // The `Math.max(0, …)` is what keeps a wildly negative pair of estimates
    // from reaching the store, whose own guard would reject the reserve as
    // corrupt and fail the request closed.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    await service.admit({
      authorization: snapshot({ daily_tokens: 10_000 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
      estimatedInputTokens: -100,
      estimatedOutputTokens: -100,
    });
    expect(await store.getDailyTokens("key-a", NOW)).toBe(0);
  });

  test("the tenant concurrency limit is resolved per admit, including async providers", async () => {
    // The provider is read on every admit because the setting can change while
    // the process runs; a cached value would keep enforcing a stale cap.
    const store = new InMemoryAdmissionCounterStore();
    let limit: number | null = 1;
    const service = new ApiKeyAdmissionService(store, () => NOW, () => Promise.resolve(limit));
    await service.admit({
      authorization: snapshot(),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
    });
    await expect(
      service.admit({
        authorization: snapshot(),
        targetProvider: "anthropic",
        targetModel: "claude-sonnet-4-6",
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    limit = null;
    await expect(
      service.admit({
        authorization: snapshot(),
        targetProvider: "anthropic",
        targetModel: "claude-sonnet-4-6",
      }),
    ).resolves.toBeDefined();
  });

  test("purgeKey and seedBuckets swallow store failures", async () => {
    // Both are declared best-effort: revocation has already succeeded by the
    // time they run, and a stale counter expires via TTL.
    const store = new InMemoryAdmissionCounterStore();
    store.simulateFailure(true);
    const service = new ApiKeyAdmissionService(store, () => NOW);
    await expect(service.purgeKey("key-a")).resolves.toBeUndefined();
    await expect(service.seedBuckets({ apiKeyId: "key-a", daily: 10 })).resolves.toBeUndefined();
  });

  test("seedBuckets defaults its clock to the service clock", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    await service.seedBuckets({ apiKeyId: "key-a", daily: 900 });
    expect(await store.getDailyTokens("key-a", NOW)).toBe(900);
    expect(await store.getDailyTokens("key-a", NOW + DAY_MS)).toBe(0);
  });

  test("a store without seedBuckets is tolerated", async () => {
    // The method is optional on the interface; a store that omits it must not
    // turn seeding into a crash.
    const inner = new InMemoryAdmissionCounterStore();
    const minimal: AdmissionCounterStore = {
      reserve: (request) => inner.reserve(request),
      reconcile: (apiKeyId, reserved, actual, reservationId) =>
        inner.reconcile(apiKeyId, reserved, actual, reservationId),
      release: (apiKeyId, reserved, reservationId) =>
        inner.release(apiKeyId, reserved, reservationId),
      purge: (apiKeyId) => inner.purge(apiKeyId),
    };
    const service = new ApiKeyAdmissionService(minimal, () => NOW);
    await expect(service.seedBuckets({ apiKeyId: "key-a", daily: 10 })).resolves.toBeUndefined();
  });

  test("a snapshot with no key id is refused as unavailable", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const failure = await service
      .admit({
        authorization: { api_key_id: "", tenant_id: "tenant-a" },
        targetProvider: "anthropic",
        targetModel: "claude-sonnet-4-6",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("admission_unavailable");
  });

  test("reservation ids are unique per admit", async () => {
    // Two admits at the same clock reading must not collide on the lease key,
    // which would make the second a replay of the first.
    const store = new InMemoryAdmissionCounterStore();
    const service = new ApiKeyAdmissionService(store, () => NOW);
    const first = await service.admit({
      authorization: snapshot({ max_concurrent: 10 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
    });
    const second = await service.admit({
      authorization: snapshot({ max_concurrent: 10 }),
      targetProvider: "anthropic",
      targetModel: "claude-sonnet-4-6",
    });
    expect(first.reservationId).not.toBe(second.reservationId);
    expect(await store.getConcurrent("key-a")).toBe(2);
  });
});
