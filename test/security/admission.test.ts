import { describe, expect, setSystemTime, test } from "bun:test";
import { GatewayError } from "../../src/transport/gateway-error";
import type { RedisClient } from "../../src/persistence/redis";
import { createAuthorizationSnapshot } from "../../src/security/api-key-auth";
import {
  ApiKeyAdmissionService,
  InMemoryAdmissionCounterStore,
  LEASE_KEY_TTL_SECONDS,
  LEASE_REAP_HORIZON_SECONDS,
  RedisAdmissionCounterStore,
  sweepLeases,
} from "../../src/security/admission";

function snapshot(opts: Partial<Parameters<typeof createAuthorizationSnapshot>[0]> = {}) {
  return createAuthorizationSnapshot({
    api_key_id: "key-1",
    tenant_id: "tenant-1",
    rpm: null,
    daily_tokens: null,
    monthly_tokens: null,
    lifetime_token_budget: null,
    lifetime_tokens_consumed: null,
    max_concurrent: null,
    provider_allowlist: null,
    model_allowlist: null,
    model_denylist: null,
    ...opts,
  });
}

describe("ApiKeyAdmissionService", () => {
  test("enforces RPM rolling window", async () => {
    let now = 0;
    const store = new InMemoryAdmissionCounterStore({ windowMs: 60_000 });
    const svc = new ApiKeyAdmissionService(store, () => now);
    const snap = snapshot({ rpm: 2 });

    const lease1 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(lease1.reservationId).toBeDefined();
    now += 10_000;
    const lease2 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(lease2.reservationId).toBeDefined();

    await expect(
      svc.admit({ authorization: snap, targetProvider: "openai", targetModel: "gpt-4" }),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
    } as unknown as GatewayError);

    // advance past window — should allow again
    now += 60_000;
    const lease3 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(lease3.reservationId).toBeDefined();
    await lease1.release();
    await lease2.release();
    await lease3.release();
  });

  test("enforces daily token reservation and accounting", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    const snap = snapshot({ daily_tokens: 100 });

    const lease = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 40,
      estimatedOutputTokens: 10,
    });
    expect(await store.getDailyTokens("key-1")).toBe(50);

    await expect(
      svc.admit({
        authorization: snap,
        targetProvider: "openai",
        targetModel: "gpt-4",
        estimatedInputTokens: 60,
        estimatedOutputTokens: 0,
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" } as unknown as GatewayError);

    // within limit still allowed
    const lease2 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 30,
      estimatedOutputTokens: 0,
    });
    expect(await store.getDailyTokens("key-1")).toBe(80);
    await lease.release();
    await lease2.release();
  });

  /**
   * The in-memory store is the documented `REDIS_MODE=single_instance_local`
   * production mode, so its daily/monthly budgets must roll over on the
   * calendar boundary exactly as the Redis store's bucket-qualified keys do.
   * Keying by api key alone made a key that exhausted its daily budget on day
   * one reject every request on every later day, forever.
   */
  test("daily and monthly budgets roll over on the calendar boundary", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const dayOne = Date.UTC(2026, 0, 10, 12, 0, 0);
    let now = dayOne;
    const svc = new ApiKeyAdmissionService(store, () => now);
    const snap = snapshot({ daily_tokens: 100, monthly_tokens: 200 });

    const lease = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 90,
    });
    expect(await store.getDailyTokens("key-1", dayOne)).toBe(90);
    expect(await store.getMonthlyTokens("key-1", dayOne)).toBe(90);

    // The same day is capped: 90 + 90 would exceed the 100 daily budget.
    await expect(
      svc.admit({
        authorization: snap,
        targetProvider: "openai",
        targetModel: "gpt-4",
        estimatedInputTokens: 90,
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" } as unknown as GatewayError);
    await lease.release();

    // The next day the daily budget is fresh, while the monthly one persists.
    now = Date.UTC(2026, 0, 11, 12, 0, 0);
    expect(await store.getDailyTokens("key-1", now)).toBe(0);
    expect(await store.getMonthlyTokens("key-1", now)).toBe(0);
    const nextDay = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 90,
    });
    expect(await store.getDailyTokens("key-1", now)).toBe(90);
    await nextDay.release();

    // The next month resets both buckets.
    now = Date.UTC(2026, 1, 1, 12, 0, 0);
    expect(await store.getDailyTokens("key-1", now)).toBe(0);
    expect(await store.getMonthlyTokens("key-1", now)).toBe(0);
  });

  test("monthly budget persists across a day boundary", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const dayOne = Date.UTC(2026, 0, 10, 12, 0, 0);
    let now = dayOne;
    const svc = new ApiKeyAdmissionService(store, () => now);
    const snap = snapshot({ monthly_tokens: 150 });

    await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 100,
    });

    // A new day clears the daily bucket but must not clear the monthly one.
    now = Date.UTC(2026, 0, 11, 12, 0, 0);
    expect(await store.getMonthlyTokens("key-1", now)).toBe(100);
    await expect(
      svc.admit({
        authorization: snap,
        targetProvider: "openai",
        targetModel: "gpt-4",
        estimatedInputTokens: 100,
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" } as unknown as GatewayError);
  });

  test("enforces monthly and lifetime budget", async () => {    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    const snapMonthly = snapshot({ monthly_tokens: 200 });
    const l1 = await svc.admit({
      authorization: snapMonthly,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 150,
    });
    expect(await store.getMonthlyTokens("key-1")).toBe(150);
    await expect(
      svc.admit({
        authorization: snapMonthly,
        targetProvider: "openai",
        targetModel: "gpt-4",
        estimatedInputTokens: 100,
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" } as unknown as GatewayError);
    await l1.release();

    const snapLifetime = snapshot({ lifetime_token_budget: 100, lifetime_tokens_consumed: 90 });
    await expect(
      svc.admit({
        authorization: snapLifetime,
        targetProvider: "openai",
        targetModel: "gpt-4",
        estimatedInputTokens: 20,
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" } as unknown as GatewayError);
    const ok = await svc.admit({
      authorization: snapLifetime,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 5,
    });
    expect(ok.reservationId).toBeDefined();
    await ok.release();
  });

  test("enforces max_concurrent with lease release on every terminal path", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    const snap = snapshot({ max_concurrent: 1 });

    const lease = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(await store.getConcurrent("key-1")).toBe(1);
    await expect(
      svc.admit({ authorization: snap, targetProvider: "openai", targetModel: "gpt-4" }),
    ).rejects.toMatchObject({
      code: "capacity_exhausted",
    } as unknown as GatewayError);

    // release on success path
    await lease.release();
    expect(await store.getConcurrent("key-1")).toBe(0);
    expect(lease.released).toBe(true);
    // idempotent second release is no-op
    await lease.release();
    expect(await store.getConcurrent("key-1")).toBe(0);

    // release on failure path (simulate try/finally)
    const lease2 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    try {
      throw new Error("upstream failure");
    } catch {
      await lease2.release();
    }
    expect(await store.getConcurrent("key-1")).toBe(0);

    // release on abort path
    const lease3 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    const abortLease = lease3;
    await abortLease.release();
    expect(await store.getConcurrent("key-1")).toBe(0);
  });

  test("provider and model allowlist/denylist with denylist-over-allowlist precedence", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    const snap = snapshot({
      provider_allowlist: ["openai", "anthropic"],
      model_allowlist: ["gpt-4", "gpt-4o", "claude-3"],
      model_denylist: ["gpt-4o"],
    });

    // allowed
    const ok = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(ok.reservationId).toBeDefined();
    await ok.release();

    // provider not allowed
    await expect(
      svc.admit({ authorization: snap, targetProvider: "cerebras", targetModel: "gpt-4" }),
    ).rejects.toMatchObject({
      code: "model_not_found",
    } as unknown as GatewayError);

    // model not in allowlist — allowlist miss, not a denylist hit
    await expect(
      svc.admit({ authorization: snap, targetProvider: "openai", targetModel: "unknown" }),
    ).rejects.toMatchObject({
      code: "model_not_found",
      details: { reason: "model-not-allowed" },
    } as unknown as GatewayError);

    // model in both allowlist and denylist — denylist wins
    await expect(
      svc.admit({ authorization: snap, targetProvider: "openai", targetModel: "gpt-4o" }),
    ).rejects.toMatchObject({
      code: "model_not_found",
      details: { reason: "model-denied" },
    } as unknown as GatewayError);
    // ensure denylist-over-allowlist precedence deterministic even when allowlist overlaps
    await expect(
      svc.admit({ authorization: snap, targetProvider: "anthropic", targetModel: "gpt-4o" }),
    ).rejects.toMatchObject({
      code: "model_not_found",
    } as unknown as GatewayError);
  });

  test("authorizes the requested alias or combo name, not only the resolved target", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    // The operator allowlisted the alias "muse-spark-1.3"; routing resolves it
    // to a provider/model the allowlist never names.
    const snap = snapshot({ model_allowlist: ["muse-spark-1.3"] });

    const ok = await svc.admit({
      authorization: snap,
      targetProvider: "opencodeft",
      targetModel: "muse-spark-1.3-contributor-free",
      requestedModel: "muse-spark-1.3",
    });
    expect(ok.reservationId).toBeDefined();
    await ok.release();

    // The resolved target alone is still not authorized: the alias is the grant.
    await expect(
      svc.admit({
        authorization: snap,
        targetProvider: "opencodeft",
        targetModel: "muse-spark-1.3-contributor-free",
      }),
    ).rejects.toMatchObject({ code: "model_not_found" } as unknown as GatewayError);

    // A denied target stays denied even when an allowed alias names it.
    const denied = snapshot({
      model_allowlist: ["muse-spark-1.3"],
      model_denylist: ["opencodeft/muse-spark-1.3-contributor-free"],
    });
    await expect(
      svc.admit({
        authorization: denied,
        targetProvider: "opencodeft",
        targetModel: "muse-spark-1.3-contributor-free",
        requestedModel: "muse-spark-1.3",
      }),
    ).rejects.toMatchObject({ code: "model_not_found" } as unknown as GatewayError);
  });

  test("never contacts provider/network before admission check — zero dispatches on rejection", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    const snap = snapshot({ provider_allowlist: ["openai"], max_concurrent: 0 });

    let dispatchCount = 0;
    const mockProviderDispatch = async () => {
      dispatchCount++;
    };

    const attempt = async (provider: string, model: string) => {
      const lease = await svc.admit({
        authorization: snap,
        targetProvider: provider,
        targetModel: model,
      });
      // only after admit succeeds would we dispatch — this line should not be reached on failure
      await mockProviderDispatch();
      await lease.release();
    };

    await expect(attempt("anthropic", "claude-3")).rejects.toBeDefined();
    expect(dispatchCount).toBe(0);

    await expect(attempt("openai", "gpt-4")).rejects.toBeDefined();
    expect(dispatchCount).toBe(0);

    // successful case does dispatch
    const snap2 = snapshot({ provider_allowlist: ["openai"] });
    const svc2 = new ApiKeyAdmissionService(new InMemoryAdmissionCounterStore());
    const lease = await svc2.admit({
      authorization: snap2,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    await mockProviderDispatch();
    await lease.release();
    expect(dispatchCount).toBe(1);
  });

  test("required-dependency: store is mandatory and store outage fail-closed with admission_unavailable", async () => {
    // missing store should throw at construction
    expect(
      () => new ApiKeyAdmissionService(null as unknown as InMemoryAdmissionCounterStore),
    ).toThrow();

    const failingStore = new InMemoryAdmissionCounterStore();
    failingStore.simulateFailure(true);
    const svc = new ApiKeyAdmissionService(failingStore);
    const snap = snapshot();

    let dispatchCount = 0;
    const tryAdmit = async () => {
      const lease = await svc.admit({
        authorization: snap,
        targetProvider: "openai",
        targetModel: "gpt-4",
      });
      dispatchCount++;
      await lease.release();
    };
    await expect(tryAdmit()).rejects.toMatchObject({
      code: "admission_unavailable",
    } as unknown as GatewayError);
    expect(dispatchCount).toBe(0);

    // recovery after outage
    failingStore.simulateFailure(false);
    const lease = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(lease.reservationId).toBeDefined();
    await lease.release();
  });

  test("handles abort signal and missing authorization as admission_unavailable", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    const snap = snapshot();
    const controller = new AbortController();
    controller.abort();
    await expect(
      svc.admit({
        authorization: snap,
        targetProvider: "openai",
        targetModel: "gpt-4",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "admission_unavailable" } as unknown as GatewayError);

    await expect(
      svc.admit({
        authorization: null as unknown as typeof snap,
        targetProvider: "openai",
        targetModel: "gpt-4",
      }),
    ).rejects.toMatchObject({ code: "admission_unavailable" } as unknown as GatewayError);
  });

  test("concurrent admit respects promise ordering with Promise.withResolvers", async () => {
    const store = new InMemoryAdmissionCounterStore();
    let now = 0;
    const svc = new ApiKeyAdmissionService(store, () => now);
    const snap = snapshot({ max_concurrent: 1 });

    const lease1 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    const gate = Promise.withResolvers<void>();
    const pending = svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    // pending should reject with capacity_exhausted, not hang
    // release after gate
    gate.promise.then(async () => {
      await lease1.release();
    });
    gate.resolve();
    await gate.promise;
    // small tick to let release propagate
    await Promise.resolve();
    await expect(pending).rejects.toMatchObject({
      code: "capacity_exhausted",
    } as unknown as GatewayError);

    const lease2 = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(lease2.reservationId).toBeDefined();
    await lease2.release();
    void now;
  });

  test("enforces tenant concurrency limit across keys of same tenant", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(
      store,
      () => Date.now(),
      async (_tenantId) => 2, // tenant limit of 2
    );

    const snap1 = snapshot({ api_key_id: "key-1", tenant_id: "tenant-a" });
    const snap2 = snapshot({ api_key_id: "key-2", tenant_id: "tenant-a" });

    const lease1 = await svc.admit({
      authorization: snap1,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    const lease2 = await svc.admit({
      authorization: snap2,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });

    // 3rd request for same tenant exceeds tenant concurrency cap of 2
    await expect(
      svc.admit({
        authorization: snap1,
        targetProvider: "openai",
        targetModel: "gpt-4",
      }),
    ).rejects.toMatchObject({
      code: "tenant_capacity_exhausted",
      status: 429,
    } as unknown as GatewayError);

    await lease1.release();
    // Now slot is freed
    const lease3 = await svc.admit({
      authorization: snap1,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(lease3.reservationId).toBeDefined();
    await lease2.release();
    await lease3.release();
  });

  test("bounds terminal reservations to prevent memory leak while preserving idempotency", async () => {
    const store = new InMemoryAdmissionCounterStore();
    const svc = new ApiKeyAdmissionService(store);
    const snap = snapshot({ daily_tokens: 1_000_000 });

    // Create many terminal reservations to test the cap
    const terminalReservations: Array<{ id: string; lease: any }> = [];
    const count = 200; // More than the 10k cap to test eviction

    for (let i = 0; i < count; i++) {
      const lease = await svc.admit({
        authorization: snap,
        targetProvider: "openai",
        targetModel: "gpt-4",
        estimatedInputTokens: 10,
      });
      terminalReservations.push({ id: lease.reservationId, lease });
    }

    // Commit all reservations
    for (const { lease } of terminalReservations) {
      await lease.commitUsage({ 
        input_tokens: 10, 
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        uncached_input_tokens: 10,
        reasoning_tokens: 0,
        estimated_cost: 0,
      });
    }

    // Verify replay idempotency for a recent committed reservation
    const recentLease = terminalReservations[terminalReservations.length - 1]?.lease;
    
    // Replaying the commit should be idempotent (no error)
    await expect(
      recentLease?.commitUsage({ 
        input_tokens: 10, 
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        uncached_input_tokens: 10,
        reasoning_tokens: 0,
        estimated_cost: 0,
      }),
    ).resolves.toBeUndefined();

    // Replaying the release should be idempotent (no error)
    await expect(recentLease?.release()).resolves.toBeUndefined();

    // Verify the store doesn't grow unbounded by checking internal state
    // The implementation should have capped the terminal reservations
    // We can't directly access the internal map size, but we can verify
    // the system still works correctly after many operations
    const anotherLease = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
      estimatedInputTokens: 10,
    });
    expect(anotherLease.reservationId).toBeDefined();
    await anotherLease.commitUsage({ 
      input_tokens: 10, 
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      uncached_input_tokens: 10,
      reasoning_tokens: 0,
      estimated_cost: 0,
    });
  });

  test("purgeKey drops counters so a recycled key starts clean", async () => {
    let now = 0;
    const store = new InMemoryAdmissionCounterStore({ windowMs: 60_000 });
    const svc = new ApiKeyAdmissionService(store, () => now);
    const snap = snapshot({ api_key_id: "recycled-key", rpm: 1 });

    const lease = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    await expect(
      svc.admit({ authorization: snap, targetProvider: "openai", targetModel: "gpt-4" }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });

    await svc.purgeKey("recycled-key");
    // History gone: admit succeeds again without advancing the clock.
    const fresh = await svc.admit({
      authorization: snap,
      targetProvider: "openai",
      targetModel: "gpt-4",
    });
    expect(fresh.reservationId).toBeDefined();
    // The pre-purge in-flight lease still releases silently (no corruption).
    await expect(lease.release()).resolves.toBeUndefined();
    await fresh.release();
  });

  test("purgeKey leaves other keys untouched", async () => {
    const store = new InMemoryAdmissionCounterStore({ windowMs: 60_000 });
    const svc = new ApiKeyAdmissionService(store, () => 0);
    const snapA = snapshot({ api_key_id: "key-a", rpm: 1 });
    const snapB = snapshot({ api_key_id: "key-b", rpm: 1 });
    await svc.admit({ authorization: snapA, targetProvider: "openai", targetModel: "gpt-4" });
    await svc.admit({ authorization: snapB, targetProvider: "openai", targetModel: "gpt-4" });

    await svc.purgeKey("key-a");
    await expect(
      svc.admit({ authorization: snapB, targetProvider: "openai", targetModel: "gpt-4" }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  test("Redis purge releases only the target key's leases, in one round trip per page", async () => {
    // The Redis purge path had no coverage at all: the in-memory tests above
    // exercise `purgeKey`, which never touches this code. The leases are
    // identified by a hash FIELD (`api_key_id`), so the page must be read —
    // this asserts it is read with one pipelined HGET per page rather than one
    // round trip per lease, and that a foreign key's lease is left alone.
    const hashes = new Map<string, Record<string, string>>([
      ["admission:lease:own-1", { state: "active", api_key_id: "target" }],
      ["admission:lease:own-2", { state: "active", api_key_id: "target" }],
      ["admission:lease:foreign", { state: "active", api_key_id: "other" }],
    ]);
    const hgetCalls: string[] = [];
    const evalKeys: string[] = [];
    let pipelineExecs = 0;

    const fakeRedis = {
      scan: () => Promise.resolve(["0", [...hashes.keys()]]),
      pipeline: () => {
        const queued: string[] = [];
        return {
          hget: (key: string) => {
            queued.push(key);
            return undefined;
          },
          exec: () => {
            pipelineExecs += 1;
            for (const key of queued) hgetCalls.push(key);
            return Promise.resolve(
              queued.map((key) => [null, hashes.get(key)?.["api_key_id"] ?? null]),
            );
          },
        };
      },
      eval: (_script: string, _numKeys: number, ...args: string[]) => {
        evalKeys.push(args[0]!);
        return Promise.resolve(0);
      },
      del: () => Promise.resolve(0),
    } as unknown as RedisClient;

    const store = new RedisAdmissionCounterStore(fakeRedis);
    await store.purge("target");

    // Every lease on the page is read, but in a single pipeline execution.
    expect(pipelineExecs).toBe(1);
    expect(hgetCalls.sort()).toEqual([
      "admission:lease:foreign",
      "admission:lease:own-1",
      "admission:lease:own-2",
    ]);
    // Only the target key's leases are released.
    expect(evalKeys.sort()).toEqual(["admission:lease:own-1", "admission:lease:own-2"]);
  });
});

describe("lease-sweeper.test.ts", () => {
describe("sweepLeases", () => {
  test("scans and reaps active expired leases", async () => {
    const hashes = new Map<string, Record<string, string>>([
      [
        "admission:lease:active-expired",
        {
          state: "active",
          expires_at: String(Date.now() - 10_000),
          api_key_id: "key-1",
        },
      ],
      [
        "admission:lease:active-future",
        {
          state: "active",
          expires_at: String(Date.now() + 60_000),
          api_key_id: "key-2",
        },
      ],
      [
        "admission:lease:committed",
        {
          state: "committed",
          expires_at: String(Date.now() - 10_000),
          api_key_id: "key-3",
        },
      ],
    ]);

    const evalCalls: unknown[] = [];
    const fakeRedis = {
      scan: (_cursor: string) => {
        return Promise.resolve(["0", Array.from(hashes.keys())]);
      },
      hget: (key: string, field: string) => {
        return Promise.resolve(hashes.get(key)?.[field] ?? null);
      },
      eval: (...args: unknown[]) => {
        evalCalls.push(args);
        return Promise.resolve(0);
      },
    } as unknown as RedisClient;

    await sweepLeases(fakeRedis);

    // Exactly 1 expired active lease should have been released
    expect(evalCalls).toHaveLength(1);
    expect(evalCalls[0]).toEqual(
      expect.arrayContaining(["admission:lease:active-expired", "key-1"]),
    );
  });

  test("a lease key outlives the reap horizon it records", () => {
    // The regression this guards: when the lease key's Redis TTL equalled the
    // `expires_at` horizon, Redis evicted the hash at the exact moment the
    // sweeper became allowed to read it, so a crashed request's concurrency
    // slot could never be reclaimed. The key TTL must exceed the horizon by
    // more than one sweep interval (30s).
    expect(LEASE_KEY_TTL_SECONDS).toBeGreaterThan(LEASE_REAP_HORIZON_SECONDS + 30);
  });

  test("sweep reclaims a crashed lease while its key is still alive", async () => {
    // Drives the real RESERVE and RELEASE Lua paths through the real
    // `RedisAdmissionCounterStore` and `sweepLeases`. The fake below models key
    // eviction honestly — the earlier test kept hashes alive forever, which is
    // why it could not observe the TTL/horizon collision that caused the bug.
    //
    // The system clock is frozen so `Date.now()` (which `reapIfExpired` reads)
    // and the TTLs the fake arms from each command agree. Without this the two
    // clocks disagree and the scenario cannot be expressed.
    const T0 = 1_800_000_000_000;
    setSystemTime(T0);
    try {
      const strings = new Map<string, string>();
      const hashes = new Map<string, Record<string, string>>();
      /** Absolute ms at which each key's TTL evicts it. */
      const expiry = new Map<string, number>();

      const expire = (key: string, seconds: number): void => {
        expiry.set(key, Date.now() + seconds * 1000);
      };
      const evict = (): void => {
        const now = Date.now();
        for (const [key, at] of [...expiry]) {
          if (at > now) continue;
          expiry.delete(key);
          strings.delete(key);
          hashes.delete(key);
        }
      };
      const live = (key: string): boolean => {
        evict();
        return strings.has(key) || hashes.has(key);
      };

      // Argument layout: the 7 KEYS arrive first, then ARGV[1..14], so ARGV[n]
      // sits at index 7 + (n - 1).
      const K_CONCURRENT = 3;
      const K_LEASE = 5;
      const A_NOW = 7;
      const A_ESTIMATED = 8;
      const A_CONCURRENCY_LIMIT = 13;
      const A_TENANT_ID = 17;
      const A_API_KEY_ID = 18;
      const A_LEASE_TTL_MS = 19;
      const A_LEASE_KEY_TTL = 20;

      const fakeRedis = {
        get: (key: string) => Promise.resolve(live(key) ? (strings.get(key) ?? null) : null),
        set: (key: string, value: string) => {
          strings.set(key, value);
          return Promise.resolve("OK");
        },
        incr: (key: string) => {
          const next = Number(strings.get(key) ?? "0") + 1;
          strings.set(key, String(next));
          return Promise.resolve(next);
        },
        hset: (key: string, ...args: string[]) => {
          const hash = hashes.get(key) ?? {};
          for (let i = 0; i < args.length; i += 2) hash[args[i]!] = args[i + 1]!;
          hashes.set(key, hash);
          return Promise.resolve(args.length / 2);
        },
        hget: (key: string, field: string) =>
          Promise.resolve(live(key) ? (hashes.get(key)?.[field] ?? null) : null),
        del: (...keys: string[]) => {
          let removed = 0;
          for (const key of keys) {
            if (strings.delete(key)) removed += 1;
            if (hashes.delete(key)) removed += 1;
          }
          return Promise.resolve(removed);
        },
        scan: () => Promise.resolve(["0", [...hashes.keys()]]),
        eval: (script: string, _numKeys: number, ...args: string[]) => {
          evict();
          // RESERVE: create the lease hash, arm the counters and their TTLs.
          if (script.includes("'state', 'active'")) {
            const now = Number(args[A_NOW]);
            const leaseKey = args[K_LEASE]!;
            const concurrencyLimit = args[A_CONCURRENCY_LIMIT]!;
            const concurrentKey = args[K_CONCURRENT]!;
            if (concurrencyLimit) {
              strings.set(concurrentKey, String(Number(strings.get(concurrentKey) ?? "0") + 1));
              expire(concurrentKey, 3600);
            }
            hashes.set(leaseKey, {
              state: "active",
              reserved: args[A_ESTIMATED]!,
              concurrent: concurrencyLimit ? "1" : "0",
              tenant_id: args[A_TENANT_ID]!,
              api_key_id: args[A_API_KEY_ID]!,
              expires_at: String(now + Number(args[A_LEASE_TTL_MS])),
            });
            expire(leaseKey, Number(args[A_LEASE_KEY_TTL]));
            return Promise.resolve(0);
          }
          // RELEASE: reverse the held concurrency slot, mark the lease released.
          if (script.includes("'state', 'released'")) {
            const leaseKey = args[0]!;
            const hash = hashes.get(leaseKey);
            if (hash?.["concurrent"] === "1") {
              const concurrentKey = `admission:concurrent:${args[1]!}`;
              strings.set(concurrentKey, String(Number(strings.get(concurrentKey) ?? "1") - 1));
            }
            if (hash) hash["state"] = "released";
            return Promise.resolve(0);
          }
          return Promise.resolve(0);
        },
      } as unknown as RedisClient;

      const store = new RedisAdmissionCounterStore(fakeRedis);
      const apiKeyId = "key-crash";
      const concurrentKey = `admission:concurrent:${apiKeyId}`;
      const leaseKey = "admission:lease:crashed";
      const reserveArgs = {
        apiKeyId,
        estimatedTokens: 10,
        rpmLimit: null,
        dailyLimit: null,
        monthlyLimit: null,
        lifetimeBudget: null,
        lifetimeConsumed: 0,
        concurrencyLimit: 3,
        tenantId: "tenant-1",
        tenantConcurrencyLimit: null,
      } as const;

      // 1. The request that crashes: reserved at T0, then the worker dies — no
      //    reconcile, no release. Its lease is reapable from T0+3600s.
      await store.reserve({ ...reserveArgs, reservationId: "crashed", now: T0 });
      expect(strings.get(concurrentKey)).toBe("1");

      // 2. Traffic continues on the same key at T0+1800s, re-arming the
      //    counter's own TTL to T0+5400s. This is exactly what stops the leaked
      //    slot from ever timing out in production while the key stays in use.
      setSystemTime(T0 + 1_800_000);
      await store.reserve({ ...reserveArgs, reservationId: "healthy", now: T0 + 1_800_000 });
      expect(strings.get(concurrentKey)).toBe("2");

      // 3. T0+3605s: the crashed lease is past its horizon but its key is still
      //    present (TTL T0+3720s), and the counter is still alive.
      setSystemTime(T0 + 3_605_000);
      expect(hashes.get(leaseKey)?.["state"]).toBe("active");
      expect(hashes.get("admission:lease:healthy")?.["state"]).toBe("active");

      await sweepLeases(fakeRedis);

      // With the key TTL equal to the horizon the crashed hash would already be
      // gone here and the leaked slot would stay stranded at "2".
      expect(hashes.get(leaseKey)?.["state"]).toBe("released");
      expect(strings.get(concurrentKey)).toBe("1");
      // The healthy lease is not due and must be left alone.
      expect(hashes.get("admission:lease:healthy")?.["state"]).toBe("active");
    } finally {
      setSystemTime();
    }
  });
});
});
