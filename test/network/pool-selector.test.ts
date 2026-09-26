import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROXY_CONCURRENCY,
  NetworkPoolSelector,
  effectiveConcurrency,
} from "../../src/network/pool/selector";
import type { RedisClient } from "../../src/persistence/redis";

interface SelectorRedis {
  readonly redis: RedisClient;
  readonly state: Map<string, string>;
  readonly indexes: Map<string, Set<string>>;
}

/**
 * In-memory Redis double covering exactly the pool-selector call shapes: `GET`
 * for cooldown markers and inflight counters, `SMEMBERS`/`DEL`/`MGET` for the
 * cooldown index, and the four admission/cooldown scripts. Scripts are
 * recognised by their distinctive bodies, so a selector change that stops
 * issuing one of them fails loudly here instead of silently passing.
 */
function selectorRedis(initial: Record<string, string> = {}): SelectorRedis {
  const state = new Map(Object.entries(initial));
  const indexes = new Map<string, Set<string>>();
  const redis = {
    get: async (key: string): Promise<string | null> => state.get(key) ?? null,
    smembers: async (key: string): Promise<string[]> => [...(indexes.get(key) ?? [])],
    mget: async (...keys: string[]): Promise<Array<string | null>> =>
      keys.map((key) => state.get(key) ?? null),
    del: async (...keys: string[]): Promise<number> => {
      let removed = 0;
      for (const key of keys) {
        if (state.delete(key)) removed += 1;
        indexes.delete(key);
      }
      return removed;
    },
    srem: async (key: string, member: string): Promise<number> =>
      indexes.get(key)?.delete(member) ? 1 : 0,
    eval: async (
      script: string,
      _numKeys: number,
      ...args: Array<string | number>
    ): Promise<number> => {
      const key = String(args[0]);
      const current = Number(state.get(key) ?? "0");
      if (script.includes("SADD")) {
        // Cooldown flag: marker + index entry written together. Keys are
        // (marker, index); the args are (json, ttlSec, providerId).
        state.set(key, String(args[2]));
        const indexKey = String(args[1]);
        const set = indexes.get(indexKey) ?? new Set<string>();
        set.add(String(args[4]));
        indexes.set(indexKey, set);
        return 1;
      }
      if (script.includes("SREM")) {
        state.delete(key);
        indexes.get(String(args[1]))?.delete(String(args[2]));
        return 1;
      }
      if (script.includes("ARGV[1]")) {
        if (current >= Number(args[1])) return 0;
        state.set(key, String(current + 1));
        return 1;
      }
      if (script.includes("<= 1")) {
        if (current <= 1) {
          state.delete(key);
          return 0;
        }
        state.set(key, String(current - 1));
        return 1;
      }
      throw new Error("selectorRedis double: unrecognized script");
    },
  };
  return { redis: redis as unknown as RedisClient, state, indexes };
}

describe("effectiveConcurrency", () => {
  test("a non-positive or fractional limit is a disabled pool, not a small one", () => {
    expect(effectiveConcurrency(0)).toBe(0);
    expect(effectiveConcurrency(-4)).toBe(0);
    expect(effectiveConcurrency(1.5)).toBe(0);
    expect(effectiveConcurrency(Number.NaN)).toBe(0);
  });

  test("a positive integer passes through", () => {
    expect(effectiveConcurrency(1)).toBe(1);
    expect(effectiveConcurrency(37)).toBe(37);
  });
});

describe("NetworkPoolSelector inflight accounting", () => {
  test("acquire refuses past capacity and release is idempotent", () => {
    const selector = new NetworkPoolSelector();
    const first = selector.acquire("pool-cap", 1);
    expect(first.acquired).toBe(true);
    expect(selector.getInflight("pool-cap")).toBe(1);
    const second = selector.acquire("pool-cap", 1);
    expect(second.acquired).toBe(false);
    first.release();
    first.release();
    expect(selector.getInflight("pool-cap")).toBe(0);
  });

  test("snapshotPoolUsage lists one row per locally tracked pool and drops idle ones", () => {
    const selector = new NetworkPoolSelector();
    const heldA = selector.acquire("pool-snap-a", 4);
    const heldA2 = selector.acquire("pool-snap-a", 4);
    const heldB = selector.acquire("pool-snap-b", 4);
    expect(selector.snapshotPoolUsage()).toEqual([
      { poolId: "pool-snap-a", currentInflight: 2 },
      { poolId: "pool-snap-b", currentInflight: 1 },
    ]);
    heldA.release();
    heldA2.release();
    heldB.release();
    expect(selector.snapshotPoolUsage()).toEqual([]);
  });

  test("the local inflight map evicts its oldest counter past the bound", () => {
    const selector = new NetworkPoolSelector();
    const firstId = "pool-bound-0";
    selector.acquire(firstId, 4);
    for (let index = 1; index <= 10_000; index += 1) selector.acquire(`pool-bound-${index}`, 4);
    expect(selector.getInflight(firstId)).toBe(0);
    expect(selector.getInflight("pool-bound-10000")).toBe(1);
  });

  test("getInflightAuthoritative reads the local map without Redis", async () => {
    const selector = new NetworkPoolSelector();
    expect(await selector.getInflightAuthoritative("pool-auth-local")).toBe(0);
    selector.acquire("pool-auth-local", 4);
    expect(await selector.getInflightAuthoritative("pool-auth-local")).toBe(1);
  });

  test("getInflightAuthoritative prefers the Redis counter and rejects a corrupt one", async () => {
    const { redis } = selectorRedis({ "proxy:inflight:pool-auth-redis": "3" });
    const selector = new NetworkPoolSelector(redis);
    expect(await selector.getInflightAuthoritative("pool-auth-redis")).toBe(3);
    expect(await selector.getInflightAuthoritative("pool-auth-absent")).toBe(0);

    const corrupt = selectorRedis({ "proxy:inflight:pool-auth-bad": "not-a-number" });
    const corruptSelector = new NetworkPoolSelector(corrupt.redis);
    await expect(corruptSelector.getInflightAuthoritative("pool-auth-bad")).rejects.toThrow(
      "invalid pool inflight counter: pool-auth-bad",
    );
  });
});

describe("NetworkPoolSelector local selection", () => {
  test("a disabled capacity or weight removes a pool from eligibility", async () => {
    const selector = new NetworkPoolSelector();
    expect(await selector.tryAcquireAvailablePool(["p0"], "openai", { p0: 0 })).toBeUndefined();
    expect(
      await selector.tryAcquireAvailablePool(["p0"], "openai", undefined, { p0: 0 }),
    ).toBeUndefined();
    expect(
      await selector.tryAcquireAvailablePool(["p0"], "openai", undefined, { p0: 1.5 }),
    ).toBeUndefined();
    const slot = await selector.tryAcquireAvailablePool(["p0"], "openai", undefined, { p0: 7 });
    expect(slot?.poolId).toBe("p0");
    slot?.release();
  });

  test("the default capacity applies when a pool declares no limit", async () => {
    const selector = new NetworkPoolSelector();
    const held: Array<() => void> = [];
    for (let index = 0; index < DEFAULT_PROXY_CONCURRENCY; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(["p0"], "openai");
      if (!slot) throw new Error(`expected admission ${index}`);
      held.push(slot.release);
    }
    expect(await selector.tryAcquireAvailablePool(["p0"], "openai")).toBeUndefined();
    held[0]?.();
    expect((await selector.tryAcquireAvailablePool(["p0"], "openai"))?.poolId).toBe("p0");
  });

  test("a cooling pool is skipped while a healthy sibling serves", async () => {
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown("p0", "openai", 60_000, "test");
    const slot = await selector.tryAcquireAvailablePool(["p0", "p1"], "openai");
    expect(slot?.poolId).toBe("p1");
    slot?.release();
  });

  test("an empty eligible list is never admitted", async () => {
    const selector = new NetworkPoolSelector();
    expect(await selector.tryAcquireAvailablePool([], "openai")).toBeUndefined();
  });
});

describe("NetworkPoolSelector with Redis coordination", () => {
  test("admission increments the distributed counter and release decrements it", async () => {
    const { redis, state } = selectorRedis();
    const selector = new NetworkPoolSelector(redis);
    const first = await selector.tryAcquireAvailablePool(["p0"], "openai", { p0: 2 });
    expect(first?.poolId).toBe("p0");
    expect(state.get("proxy:inflight:p0")).toBe("1");
    const second = await selector.tryAcquireAvailablePool(["p0"], "openai", { p0: 2 });
    expect(second?.poolId).toBe("p0");
    expect(state.get("proxy:inflight:p0")).toBe("2");
    // The distributed counter is the ceiling, so a third admission is refused.
    expect(await selector.tryAcquireAvailablePool(["p0"], "openai", { p0: 2 })).toBeUndefined();
    first?.release();
    expect(state.get("proxy:inflight:p0")).toBe("1");
    expect(selector.getInflight("p0")).toBe(1);
  });

  test("a release decrements the distributed counter to zero and deletes the key", async () => {
    const { redis, state } = selectorRedis();
    const selector = new NetworkPoolSelector(redis);
    const slot = await selector.tryAcquireAvailablePool(["p0"], "openai", { p0: 4 });
    if (!slot) throw new Error("expected admission");
    expect(state.get("proxy:inflight:p0")).toBe("1");
    slot.release();
    expect(state.has("proxy:inflight:p0")).toBe(false);
    expect(selector.getInflight("p0")).toBe(0);
  });

  test("scoring prefers the pool with the lower load per unit of weight", async () => {
    const { redis } = selectorRedis({ "proxy:inflight:p0": "5" });
    const selector = new NetworkPoolSelector(redis);
    const slot = await selector.tryAcquireAvailablePool(
      ["p0", "p1"],
      "openai",
      { p0: 10, p1: 10 },
      { p0: 100, p1: 100 },
    );
    expect(slot?.poolId).toBe("p1");
    slot?.release();
  });

  test("a corrupt distributed counter fails the selection instead of guessing", async () => {
    const { redis } = selectorRedis({ "proxy:inflight:p0": "-3" });
    const selector = new NetworkPoolSelector(redis);
    await expect(selector.tryAcquireAvailablePool(["p0"], "openai")).rejects.toThrow(
      "invalid pool inflight counter: p0",
    );
  });

  test("rotation orders the distributed candidates by the tenant cursor", async () => {
    const { redis } = selectorRedis();
    const selector = new NetworkPoolSelector(redis);
    const rotation = { key: "tenant-redis", rotateCount: 1 };
    const served: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        ["p0", "p1"],
        "openai",
        undefined,
        undefined,
        rotation,
      );
      if (!slot) throw new Error(`expected admission ${index}`);
      served.push(slot.poolId);
      slot.release();
    }
    expect(served).toEqual(["p0", "p1", "p0", "p1"]);
  });

  test("clearPoolCooldowns drops the pool's local and distributed markers", async () => {
    const { redis, state } = selectorRedis();
    const selector = new NetworkPoolSelector(redis);
    await selector.flagProviderCooldown("p0", "openai", 60_000, "test");
    await selector.flagProviderCooldown("p1", "openai", 60_000, "test");
    expect(state.has("proxy:cooldown:p0:openai")).toBe(true);
    await selector.clearPoolCooldowns("p0");
    expect((await selector.isProviderCooldown("p0", "openai")).inCooldown).toBe(false);
    expect((await selector.isProviderCooldown("p1", "openai")).inCooldown).toBe(true);
    expect(state.has("proxy:cooldown:p0:openai")).toBe(false);
  });
});

describe("NetworkPoolSelector.getSelectionFailure", () => {
  test("an empty eligible list reports no_active_pool with no pools", async () => {
    const selector = new NetworkPoolSelector();
    expect(await selector.getSelectionFailure([], "openai")).toEqual({
      reason: "no_active_pool",
      pools: [],
    });
  });

  test("a pool with a disabled capacity or weight is reported as inactive", async () => {
    const selector = new NetworkPoolSelector();
    const byCapacity = await selector.getSelectionFailure(["p0"], "openai", { p0: 0 });
    expect(byCapacity.reason).toBe("no_active_pool");
    expect(byCapacity.pools[0]?.maxInflight).toBe(0);
    const byWeight = await selector.getSelectionFailure(["p0"], "openai", undefined, { p0: 0 });
    expect(byWeight.reason).toBe("no_active_pool");
    expect(byWeight.pools[0]?.weight).toBe(0);
  });

  test("an at-capacity pool reports at_capacity with a full snapshot", async () => {
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("p0", 1);
    expect(slot.acquired).toBe(true);
    const failure = await selector.getSelectionFailure(["p0"], "openai", { p0: 1 });
    expect(failure.reason).toBe("at_capacity");
    expect(failure.pools).toEqual([
      { poolId: "p0", maxInflight: 1, currentInflight: 1, available: 0, weight: 100 },
    ]);
  });

  test("every pool cooling reports cooldown with the earliest reset", async () => {
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown("p0", "openai", 120_000, "test");
    await selector.flagProviderCooldown("p1", "openai", 30_000, "test");
    const failure = await selector.getSelectionFailure(["p0", "p1"], "openai");
    expect(failure.reason).toBe("cooldown");
    const retryAt = failure.retryAt;
    if (retryAt === undefined) throw new Error("expected a retryAt");
    // p1's 30s cooldown is the earliest, so it is the reported retry time.
    expect(failure.pools[1]?.retryAt).toBe(retryAt);
    expect(failure.pools[0]?.retryAt ?? 0).toBeGreaterThan(retryAt);
  });

  test("an unreadable cooldown store reports coordination_unavailable with the snapshot", async () => {
    const redis = {
      get: async (key: string): Promise<string | null> => {
        if (key.startsWith("proxy:cooldown:")) throw new Error("redis down");
        return null;
      },
    } as unknown as RedisClient;
    const selector = new NetworkPoolSelector(redis);
    const failure = await selector.getSelectionFailure(["p0"], "openai");
    expect(failure.reason).toBe("coordination_unavailable");
    expect(failure.pools).toHaveLength(1);
  });

  test("an unexpected read failure reports coordination_unavailable with no pools", async () => {
    const redis = {
      get: async (): Promise<string | null> => {
        throw new Error("redis down");
      },
    } as unknown as RedisClient;
    const selector = new NetworkPoolSelector(redis);
    expect(await selector.getSelectionFailure(["p0"], "openai")).toEqual({
      reason: "coordination_unavailable",
      pools: [],
    });
  });
});
