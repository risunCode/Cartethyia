/**
 * The Redis admission counter store: the distributed enforcement of every
 * token and concurrency budget.
 *
 * `InMemoryAdmissionCounterStore` is the local/fallback implementation and is
 * well covered in `test/security/admission.test.ts`. This store is the one a
 * deployed gateway actually uses, and it was, measured before this file
 * existed, covered by nothing at all: ~400 lines of Lua that decide whether a
 * request is admitted, how many tokens it charges, and whether a crashed
 * process leaks a concurrency slot. A defect here is either an over-charge, a
 * budget that never refuses, or a slot that never comes back.
 *
 * The store's contract has one property that everything else follows from:
 * **every operation is idempotent on its reservation id.** `reserve` on an
 * already-active id must not charge twice; `reconcile` and `release` after
 * either has run must be silent no-ops. That is what makes a retried dispatch
 * safe, so it is the first thing tested.
 *
 * The second property is that a reservation settles the bucket it was *admitted
 * in*, not whatever bucket is current when it finishes. A request admitted at
 * 23:59 and reconciled after midnight must charge the previous day's counter —
 * the Redis store records the bucket keys inside the lease hash for exactly
 * this reason. That case is tested with a real day boundary.
 *
 * These tests need a live Redis (`CARTETHYIA_TEST_REDIS_URL`) and skip with a
 * stated reason when one is not configured. Every key is namespaced under a
 * per-run prefix and deleted afterwards, so two files cannot observe each
 * other.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { RedisAdmissionCounterStore } from "../../src/security/admission/redis-store";
import type { AdmissionReserveRequest } from "../../src/security/admission/contracts";
import { GatewayError } from "../../src/transport/gateway-error";
import { testRedisUrl } from "../helpers/database";

const redisDescribe = testRedisUrl ? describe : describe.skip;
if (!testRedisUrl) {
  console.info(
    "[test-redis] skipped: set CARTETHYIA_TEST_REDIS_URL to run the admission store suite",
  );
}

/** One day in ms, for the bucket-boundary cases. */
const DAY_MS = 86_400_000;

redisDescribe("RedisAdmissionCounterStore", () => {
  let client: Redis;
  let store: RedisAdmissionCounterStore;
  /** Per-run namespace so concurrent files cannot collide. */
  const runId = `test-${crypto.randomUUID()}`;
  let seq = 0;

  beforeAll(async () => {
    client = new Redis(testRedisUrl as string, { maxRetriesPerRequest: 2 });
    await client.ping();
    store = new RedisAdmissionCounterStore(client);
  });

  afterEach(async () => {
    // The store builds its own keys, so cleanup is by pattern. Scoped to this
    // run's key prefix so nothing outside this file is touched.
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await client.scan(cursor, "MATCH", `admission:*${runId}*`, "COUNT", 200);
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
    if (keys.length > 0) await client.del(...keys);
  });

  afterAll(async () => {
    client.disconnect();
  });

  /** A fresh api key id per case, namespaced to this run. */
  function keyId(): string {
    seq += 1;
    return `${runId}-${seq}`;
  }

  /** A reserve request with every limit unset unless the case sets one. */
  function reserveRequest(overrides: Partial<AdmissionReserveRequest> & { apiKeyId: string }): AdmissionReserveRequest {
    return {
      reservationId: overrides.reservationId ?? `res-${crypto.randomUUID()}`,
      now: Date.now(),
      estimatedTokens: 0,
      rpmLimit: null,
      dailyLimit: null,
      monthlyLimit: null,
      lifetimeBudget: null,
      lifetimeConsumed: 0,
      concurrencyLimit: null,
      tenantId: `${runId}-tenant`,
      tenantConcurrencyLimit: null,
      ...overrides,
    };
  }

  describe("idempotency on the reservation id", () => {
    test("reserving the same id twice charges once", async () => {
      const apiKeyId = keyId();
      const request = reserveRequest({
        apiKeyId,
        estimatedTokens: 100,
        dailyLimit: 10_000,
        reservationId: `res-${apiKeyId}`,
      });
      await store.reserve(request);
      await store.reserve(request);
      // A second charge would leave 200 spent for one 100-token reservation.
      await store.reconcile(apiKeyId, 100, 100, request.reservationId);
      const daily = await client.get(`admission:daily:${apiKeyId}:${bucketOf(request.now)}`);
      expect(Number(daily ?? "0")).toBe(100);
    });

    test("releasing twice does not double-refund concurrency", async () => {
      const apiKeyId = keyId();
      const request = reserveRequest({
        apiKeyId,
        concurrencyLimit: 5,
        reservationId: `res-${apiKeyId}`,
      });
      await store.reserve(request);
      await store.release(apiKeyId, 0, request.reservationId);
      await store.release(apiKeyId, 0, request.reservationId);
      // A double decrement would drive the counter below zero and hand out
      // extra slots beyond the operator's ceiling.
      const held = Number((await client.get(`admission:concurrent:${apiKeyId}`)) ?? "0");
      expect(held).toBe(0);
    });

    test("reconcile after release is a silent no-op", async () => {
      const apiKeyId = keyId();
      const request = reserveRequest({
        apiKeyId,
        estimatedTokens: 50,
        dailyLimit: 10_000,
        reservationId: `res-${apiKeyId}`,
      });
      await store.reserve(request);
      await store.release(apiKeyId, 50, request.reservationId);
      // The lease is `released`; a late reconcile must not resurrect a charge.
      await store.reconcile(apiKeyId, 50, 999, request.reservationId);
      const daily = Number((await client.get(`admission:daily:${apiKeyId}:${bucketOf(request.now)}`)) ?? "0");
      expect(daily).toBe(0);
    });
  });

  describe("limits", () => {
    /**
     * The rejection reason, read from `details.reason`.
     *
     * `GatewayError.code` is the coarse wire code — every token budget maps to
     * `quota_exceeded` — so the precise reason an operator needs lives in the
     * error's details. Asserting on `code` alone cannot tell a daily limit from
     * a lifetime budget, which is the difference between "wait until tomorrow"
     * and "this key is out of budget for good".
     */
    function reasonOf(error: unknown): unknown {
      return (error as GatewayError).details["reason"];
    }

    test("the daily ceiling refuses the request that would cross it", async () => {
      const apiKeyId = keyId();
      await store.reserve(reserveRequest({ apiKeyId, estimatedTokens: 900, dailyLimit: 1000 }));
      const error = await store
        .reserve(reserveRequest({ apiKeyId, estimatedTokens: 200, dailyLimit: 1000 }))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GatewayError);
      expect(reasonOf(error)).toBe("daily-token-limit");
      // Every token budget is a 429 `quota_exceeded` on the wire.
      expect((error as GatewayError).code).toBe("quota_exceeded");
      expect((error as GatewayError).status).toBe(429);
    });

    test("the daily ceiling admits the request that lands exactly on it", async () => {
      // `>` not `>=`: a budget of 1000 must allow spending exactly 1000.
      const apiKeyId = keyId();
      await store.reserve(reserveRequest({ apiKeyId, estimatedTokens: 800, dailyLimit: 1000 }));
      await store.reserve(reserveRequest({ apiKeyId, estimatedTokens: 200, dailyLimit: 1000 }));
      const daily = Number((await client.get(`admission:daily:${apiKeyId}:${bucketOf(Date.now())}`)) ?? "0");
      expect(daily).toBe(1000);
    });

    test("the concurrency ceiling refuses once the slots are held", async () => {
      const apiKeyId = keyId();
      await store.reserve(reserveRequest({ apiKeyId, concurrencyLimit: 2 }));
      await store.reserve(reserveRequest({ apiKeyId, concurrencyLimit: 2 }));
      const error = await store
        .reserve(reserveRequest({ apiKeyId, concurrencyLimit: 2 }))
        .catch((caught: unknown) => caught);
      expect(reasonOf(error)).toBe("concurrency-limit");
      // Capacity has its own wire code, distinct from a token budget.
      expect((error as GatewayError).code).toBe("capacity_exhausted");
    });

    test("the tenant concurrency ceiling is enforced across keys", async () => {
      // The tenant bucket is shared, so two different API keys of one tenant
      // must contend for the same ceiling.
      const tenantId = `${runId}-shared-tenant`;
      await store.reserve(reserveRequest({ apiKeyId: keyId(), tenantId, tenantConcurrencyLimit: 1 }));
      const error = await store
        .reserve(reserveRequest({ apiKeyId: keyId(), tenantId, tenantConcurrencyLimit: 1 }))
        .catch((caught: unknown) => caught);
      expect(reasonOf(error)).toBe("tenant-capacity-exhausted");
      expect((error as GatewayError).code).toBe("tenant_capacity_exhausted");
    });

    test("the lifetime budget counts from the seed and refuses past it", async () => {
      const apiKeyId = keyId();
      await store.reserve(
        reserveRequest({ apiKeyId, estimatedTokens: 100, lifetimeBudget: 1000, lifetimeConsumed: 900 }),
      );
      const error = await store
        .reserve(reserveRequest({ apiKeyId, estimatedTokens: 100, lifetimeBudget: 1000, lifetimeConsumed: 900 }))
        .catch((caught: unknown) => caught);
      expect(reasonOf(error)).toBe("lifetime-token-budget");
    });

    test("a request with no limits at all is admitted", async () => {
      const apiKeyId = keyId();
      const request = reserveRequest({ apiKeyId, estimatedTokens: 10_000_000 });
      await store.reserve(request);
      // No ceiling means no counter to charge; the reservation still exists and
      // must release cleanly.
      await store.release(apiKeyId, 10_000_000, request.reservationId);
      const held = Number((await client.get(`admission:concurrent:${apiKeyId}`)) ?? "0");
      expect(held).toBe(0);
    });

    test("releasing a reservation id the store never saw throws", async () => {
      // Measured, not assumed: the Lua script returns -99 for an unknown lease
      // (`state ~= 'active'`), and `assertResult` turns that into a thrown
      // error rather than a silent no-op. Pinned here because it constrains
      // callers: a release must be paired with a reserve that really happened,
      // and the lease wrapper in `ApiKeyAdmissionService` sets its `finalized`
      // flag only *after* the await, so two concurrent `release()` calls on one
      // lease can both reach this store — the second would throw.
      const apiKeyId = keyId();
      const error = await store
        .release(apiKeyId, 0, `never-reserved-${runId}`)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("corrupt admission counter");
    });
  });

  describe("reconciliation arithmetic", () => {
    test("an over-estimate is refunded to the daily counter", async () => {
      const apiKeyId = keyId();
      const request = reserveRequest({ apiKeyId, estimatedTokens: 1000, dailyLimit: 100_000 });
      await store.reserve(request);
      await store.reconcile(apiKeyId, 1000, 250, request.reservationId);
      const daily = Number((await client.get(`admission:daily:${apiKeyId}:${bucketOf(request.now)}`)) ?? "0");
      expect(daily).toBe(250);
    });

    test("an under-estimate is charged to the daily counter", async () => {
      const apiKeyId = keyId();
      const request = reserveRequest({ apiKeyId, estimatedTokens: 100, dailyLimit: 100_000 });
      await store.reserve(request);
      await store.reconcile(apiKeyId, 100, 900, request.reservationId);
      const daily = Number((await client.get(`admission:daily:${apiKeyId}:${bucketOf(request.now)}`)) ?? "0");
      expect(daily).toBe(900);
    });

    test("reconciliation releases the concurrency slot it held", async () => {
      const apiKeyId = keyId();
      const request = reserveRequest({ apiKeyId, concurrencyLimit: 1 });
      await store.reserve(request);
      await store.reconcile(apiKeyId, 0, 0, request.reservationId);
      // The slot must be free again, or the key is locked out forever.
      await store.reserve(reserveRequest({ apiKeyId, concurrencyLimit: 1 }));
      expect(Number((await client.get(`admission:concurrent:${apiKeyId}`)) ?? "0")).toBe(1);
    });
  });

  describe("bucket identity", () => {
    test("a reservation admitted before midnight settles the previous day's bucket", async () => {
      // The case the lease hash exists for. A request admitted at 23:59 and
      // reconciled after midnight must charge the day it was admitted in;
      // charging the new day would corrupt a budget that has not been spent.
      const apiKeyId = keyId();
      const lateYesterday = Date.now() - DAY_MS;
      const request = reserveRequest({
        apiKeyId,
        now: lateYesterday,
        estimatedTokens: 500,
        dailyLimit: 100_000,
      });
      await store.reserve(request);
      await store.reconcile(apiKeyId, 500, 300, request.reservationId);
      const yesterday = Number((await client.get(`admission:daily:${apiKeyId}:${bucketOf(lateYesterday)}`)) ?? "0");
      const today = Number((await client.get(`admission:daily:${apiKeyId}:${bucketOf(Date.now())}`)) ?? "0");
      expect(yesterday).toBe(300);
      expect(today).toBe(0);
    });
  });

  describe("purge", () => {
    test("revocation clears the counters so the key starts clean", async () => {
      const apiKeyId = keyId();
      await store.reserve(reserveRequest({ apiKeyId, estimatedTokens: 500, dailyLimit: 100_000 }));
      await store.purge(apiKeyId);
      const daily = await client.get(`admission:daily:${apiKeyId}:${bucketOf(Date.now())}`);
      expect(daily).toBeNull();
    });

    test("purge on an unknown key is a no-op rather than a throw", async () => {
      // Revocation runs against keys that may never have made a request.
      await store.purge(`${runId}-never-used`);
    });
  });
});

/** `YYYY-MM-DD` in UTC, matching the store's own bucket key. */
function bucketOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The ordering constraint that keeps the response path synchronous.
 *
 * `completeAttempt` awaits `lease.commitUsage()` *before* the dispatch handler
 * returns its `Response`, which reads like bookkeeping that could be deferred
 * to shave latency off the client's first byte. It cannot: `RECONCILE_SCRIPT`
 * returns `1` (a silent no-op) when the lease is already `released`, and on the
 * non-streaming path the attempt loop releases the lease in its `finally` the
 * moment the handler returns. Deferring the commit past that point therefore
 * discards the charge with no error anywhere.
 *
 * Measured: a reservation for 100 tokens released before its 9,999-token
 * reconcile leaves the daily counter at 0. This test exists so that ordering
 * is not "optimized" away by someone reading the await as latency to remove.
 */
redisDescribe("charge ordering", () => {
  let client: Redis;
  let store: RedisAdmissionCounterStore;

  beforeAll(async () => {
    client = new Redis(testRedisUrl as string, { maxRetriesPerRequest: 2 });
    await client.ping();
    store = new RedisAdmissionCounterStore(client);
  });

  afterAll(async () => {
    client.disconnect();
  });

  test("releasing before reconciling silently discards the charge", async () => {
    const apiKeyId = `order-${crypto.randomUUID()}`;
    const now = Date.now();
    const reservationId = `res-${apiKeyId}`;
    await store.reserve({
      reservationId,
      apiKeyId,
      now,
      estimatedTokens: 100,
      rpmLimit: null,
      dailyLimit: 1_000_000,
      monthlyLimit: null,
      lifetimeBudget: null,
      lifetimeConsumed: 0,
      concurrencyLimit: null,
      tenantId: `tenant-${apiKeyId}`,
      tenantConcurrencyLimit: null,
    });

    // The order that must never happen on the response path.
    await store.release(apiKeyId, 100, reservationId);
    // No throw: the script treats an already-released lease as an idempotent
    // replay, which is correct for a retried commit and catastrophic for one
    // that was merely deferred.
    await store.reconcile(apiKeyId, 100, 9_999, reservationId);

    const daily = await client.get(`admission:daily:${apiKeyId}:${bucketOf(now)}`);
    expect(Number(daily ?? "0")).toBe(0);

    // Cleanup this case's keys.
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await client.scan(cursor, "MATCH", `admission:*${apiKeyId}*`, "COUNT", 200);
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
    if (keys.length > 0) await client.del(...keys);
  });
});
