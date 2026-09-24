import { afterEach, describe, expect, test } from "bun:test";
import {
  GLOBAL_QUOTA_LENS,
  clearQuotaCacheForTests,
  getCachedQuota,
  getCachedQuotaEntries,
  getCachedQuotaEntry,
  invalidateQuotaCache,
  invalidateQuotaCacheForAccount,
  quotaLens,
  setCachedQuota,
} from "../../../src/console/quota/quota-cache";
import type { RedisClient } from "../../../src/persistence/redis";
import type { ProviderQuotaResult } from "../../../src/providers/quota/quota-contracts";

const quota: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };

afterEach(() => {
  clearQuotaCacheForTests();
});

/** Minimal in-memory RedisClient fake covering the quota-cache call shapes. */
function fakeRedis(): RedisClient {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<string> {
      store.set(key, value);
      return "OK";
    },
    async mget(...keys: string[]): Promise<(string | null)[]> {
      return keys.map((key) => store.get(key) ?? null);
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
      }
      return removed;
    },
    async scan(
      cursor: string,
      ...args: (string | number)[]
    ): Promise<[string, string[]]> {
      void cursor;
      const matchIndex = args.indexOf("MATCH");
      const pattern = matchIndex === -1 ? "*" : String(args[matchIndex + 1] ?? "*");
      const prefix = pattern.split("*")[0] ?? "";
      const suffixPart = pattern.includes(":") ? pattern.slice(pattern.lastIndexOf(":") + 1).replaceAll("*", "") : "";
      const keys = [...store.keys()].filter(
        (key) => key.startsWith(prefix) && key.endsWith(suffixPart),
      );
      return ["0", keys];
    },
  } as unknown as RedisClient;
}

describe("quota cache", () => {
  test("round-trips a quota entry and misses unknown keys", async () => {
    const redis = fakeRedis();
    expect(await getCachedQuota("t", "missing", redis)).toBeNull();
    await setCachedQuota("t", "a", quota, redis);
    expect(await getCachedQuota("t", "a", redis)).toEqual(quota);
  });

  test("records the fetch time so the sweep can judge staleness", async () => {
    const redis = fakeRedis();
    const at = new Date("2026-09-20T04:00:00.000Z");
    await setCachedQuota("t", "a", quota, redis, at);

    const entry = await getCachedQuotaEntry("t", "a", redis);
    expect(entry?.fetchedAt).toBe(at.toISOString());
    expect(entry?.quota).toEqual(quota);
  });

  test("reads a legacy bare-value entry with an unknown fetch time", async () => {
    const redis = fakeRedis();
    // Pre-envelope writers stored the quota result as the whole value; such an
    // entry must still read as a hit rather than blanking the page on upgrade.
    await redis.set("quota:t:legacy", JSON.stringify(quota), "EX", 300);

    const entry = await getCachedQuotaEntry("t", "legacy", redis);
    expect(entry?.quota).toEqual(quota);
    expect(entry?.fetchedAt).toBeNull();
  });

  test("treats a malformed payload as a miss instead of throwing", async () => {
    const redis = fakeRedis();
    await redis.set("quota:t:broken", "{not json", "EX", 300);
    expect(await getCachedQuotaEntry("t", "broken", redis)).toBeNull();
  });

  test("maps a tenant-less account onto the shared lens", () => {
    expect(quotaLens(null)).toBe(GLOBAL_QUOTA_LENS);
    expect(quotaLens(undefined)).toBe(GLOBAL_QUOTA_LENS);
    expect(quotaLens("tenant-a")).toBe("tenant-a");
  });

  test("batch-reads many accounts in one pass", async () => {
    const redis = fakeRedis();
    await setCachedQuota("t", "a", quota, redis);
    await setCachedQuota("t", "b", quota, redis);

    const found = await getCachedQuotaEntries("t", ["a", "b", "missing"], redis);
    expect([...found.keys()].sort()).toEqual(["a", "b"]);
  });

  test("batch-read serves the memory tier without touching Redis", async () => {
    const redis = fakeRedis();
    await setCachedQuota("t", "a", quota, redis);
    // Break the client: a second read must be answered from memory.
    (redis as unknown as { mget: () => Promise<never> }).mget = async () => {
      throw new Error("redis down");
    };

    const found = await getCachedQuotaEntries("t", ["a"], redis);
    expect(found.get("a")?.quota).toEqual(quota);
  });

  test("invalidates one tenant lens", async () => {
    const redis = fakeRedis();
    await setCachedQuota("t", "a", quota, redis);
    await invalidateQuotaCache("t", "a", redis);
    expect(await getCachedQuota("t", "a", redis)).toBeNull();
  });

  test("invalidates every tenant lens for a global account", async () => {
    const redis = fakeRedis();
    await setCachedQuota("tenant-a", "shared", quota, redis);
    await setCachedQuota("tenant-b", "shared", quota, redis);
    await invalidateQuotaCacheForAccount("shared", redis);
    expect(await getCachedQuota("tenant-a", "shared", redis)).toBeNull();
    expect(await getCachedQuota("tenant-b", "shared", redis)).toBeNull();
  });
});
