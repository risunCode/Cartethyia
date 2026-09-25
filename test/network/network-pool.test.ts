import { describe, expect, test } from "bun:test";
import { createHttpProxyAgent, isProxyAgentPair } from "../../src/network/pool/agent";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import type { RedisClient } from "../../src/persistence/redis";

/**
 * Minimal Redis double for the selector's coordinated cooldown store: the
 * provider set plus the per-provider entry keys, with call counters so a test
 * can prove the read is batched.
 */
interface CooldownRedisDouble {
  readonly calls: { mget: number; get: number };
  readonly sets: Map<string, Set<string>>;
  readonly entries: Map<string, string>;
}

function cooldownRedis(): CooldownRedisDouble & RedisClient {
  const sets = new Map<string, Set<string>>();
  const entries = new Map<string, string>();
  const calls = { mget: 0, get: 0 };
  return {
    calls,
    sets,
    entries,
    async smembers(key: string): Promise<string[]> {
      return [...(sets.get(key) ?? [])];
    },
    async sadd(key: string, ...members: string[]): Promise<number> {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      for (const member of members) set.add(member);
      return members.length;
    },
    async srem(key: string, ...members: string[]): Promise<number> {
      const set = sets.get(key);
      let removed = 0;
      for (const member of members) {
        if (set?.delete(member)) removed += 1;
      }
      return removed;
    },
    async get(key: string): Promise<string | null> {
      calls.get += 1;
      return entries.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<string> {
      entries.set(key, value);
      return "OK";
    },
    async mget(...keys: string[]): Promise<(string | null)[]> {
      calls.mget += 1;
      // Real Redis rejects `MGET` with no keys, and a double that quietly
      // accepts it hides the bug this mirrors: a pool with no cooling
      // providers lists no members, so the empty call is the *common* case,
      // not an edge one.
      if (keys.length === 0) throw new Error("ERR wrong number of arguments for 'mget' command");
      return keys.map((key) => entries.get(key) ?? null);
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const key of keys) {
        if (entries.delete(key)) removed += 1;
      }
      return removed;
    },
    /**
     * Emulates the two cooldown scripts the selector now issues.
     *
     * Flagging and clearing are each one atomic script rather than a
     * `SET`/`SADD` (or `DEL`/`SREM`) pair, so a double without `eval` would
     * make every flag call throw into the selector's best-effort catch — the
     * tests would pass while asserting nothing about the write path.
     */
    async eval(script: string, _numKeys: number, ...args: unknown[]): Promise<number> {
      const [key, indexKey] = args.slice(0, 2) as [string, string];
      const rest = args.slice(2) as string[];
      if (script.includes("SADD")) {
        // KEYS[1]=marker, KEYS[2]=index; ARGV[1]=json, ARGV[2]=ttlSec, ARGV[3]=providerId.
        entries.set(key, rest[0]!);
        const set = sets.get(indexKey) ?? new Set<string>();
        sets.set(indexKey, set);
        set.add(rest[2]!);
        return 1;
      }
      if (script.includes("SREM")) {
        entries.delete(key);
        sets.get(indexKey)?.delete(rest[0]!);
        return 1;
      }
      throw new Error(`cooldownRedis double: unrecognized script`);
    },
  } as unknown as CooldownRedisDouble & RedisClient;
}

describe("NetworkPoolSelector coordinated cooldowns", () => {
  test("getPoolCooldowns reads every member in one mget and keeps the same shape", async () => {
    const redis = cooldownRedis();
    const selector = new NetworkPoolSelector(redis);
    await selector.flagProviderCooldown("pool-mg", "openai", 60_000, "rate limited");
    await selector.flagProviderCooldown("pool-mg", "xai", 60_000, "rate limited");
    const before = redis.calls.mget;
    const active = await selector.getPoolCooldowns("pool-mg");
    expect(active.map((c) => c.providerId).sort()).toEqual(["openai", "xai"]);
    expect(active.every((c) => c.poolId === "pool-mg" && c.reason === "rate limited")).toBe(true);
    expect(redis.calls.mget).toBe(before + 1);
    expect(redis.calls.get).toBe(0);
  });

  test("getPoolCooldowns drops a member whose entry is missing and prunes the set", async () => {
    const redis = cooldownRedis();
    const selector = new NetworkPoolSelector(redis);
    await selector.flagProviderCooldown("pool-miss", "openai", 60_000, "r");
    // A listed member with no entry: the read must skip it and clean the set.
    redis.sets.set("proxy:cooldown:providers:pool-miss", new Set(["openai", "ghost"]));
    const active = await selector.getPoolCooldowns("pool-miss");
    expect(active.map((c) => c.providerId)).toEqual(["openai"]);
    expect(redis.sets.get("proxy:cooldown:providers:pool-miss")?.has("ghost")).toBe(false);
    expect(redis.calls.mget).toBe(1);
  });

  test("getPoolCooldowns ignores an expired remote entry and prunes it", async () => {
    const redis = cooldownRedis();
    const selector = new NetworkPoolSelector(redis);
    await selector.flagProviderCooldown("pool-exp", "openai", -1, "expired");
    const active = await selector.getPoolCooldowns("pool-exp");
    expect(active).toHaveLength(0);
    expect(redis.sets.get("proxy:cooldown:providers:pool-exp")?.size).toBe(0);
  });

  test("getPoolCooldowns returns empty for a pool with no cooling providers", async () => {
    // The regression this test exists for: a healthy pool lists no cooldown
    // members, and `MGET` with zero keys is a Redis error. The read used to
    // issue it anyway, so every pool overview failed with "ERR wrong number of
    // arguments for 'mget' command" whenever nothing was throttled — which is
    // the normal state. Zero cooldowns must be an empty list, not a failure.
    const redis = cooldownRedis();
    const selector = new NetworkPoolSelector(redis);
    await expect(selector.getPoolCooldowns("pool-clean")).resolves.toEqual([]);
    // Nothing to read, so nothing was read: the empty case skips the round trip
    // entirely rather than issuing the command that cannot be issued.
    expect(redis.calls.mget).toBe(0);
  });
});

describe("NetworkPoolSelector bounds", () => {
  test("local cooldown cache stays bounded under many unique pools", async () => {
    const selector = new NetworkPoolSelector();
    for (let index = 0; index < 5_200; index += 1) {
      await selector.flagProviderCooldown(`pool-${index}`, "openai", 15 * 60_000, "r");
    }
    const first = await selector.isProviderCooldown("pool-0", "openai");
    // The oldest entries were evicted to hold the 5_000-entry bound.
    expect(first.inCooldown).toBe(false);
    const last = await selector.isProviderCooldown("pool-5199", "openai");
    expect(last.inCooldown).toBe(true);
  });

  test("expired cooldowns are pruned before oldest-entry eviction", async () => {
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown("stale-pool", "openai", -1, "expired");
    const stale = await selector.isProviderCooldown("stale-pool", "openai");
    expect(stale.inCooldown).toBe(false);
  });
});

describe("HTTP CONNECT TLS wrap", () => {
  test("https flavor of createHttpProxyAgent wraps CONNECT in a TLSSocket", () => {
    const pair = createHttpProxyAgent("http://127.0.0.1:1");
    expect(isProxyAgentPair(pair)).toBe(true);
    const source = pair.https.createConnection.toString();
    expect(source).toContain("tls.connect");
    expect(source).toContain("secureConnect");
  });

  test("http flavor of createHttpProxyAgent does not wrap CONNECT in TLS", () => {
    const pair = createHttpProxyAgent("http://127.0.0.1:1");
    const source = pair.http.createConnection.toString();
    expect(source).not.toContain("tls.connect");
  });
});

describe("NetworkPoolSelector read paths", () => {
  test("getPoolCooldowns lists active flags and prunes expired ones", async () => {
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown("pool-rp", "openai", 60_000, "r");
    await selector.flagProviderCooldown("pool-rp", "xai", -1, "expired");
    const active = await selector.getPoolCooldowns("pool-rp");
    expect(active.map((c) => c.providerId)).toEqual(["openai"]);
  });

  test("getPoolCooldowns isolates pools", async () => {
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown("pool-iso-a", "openai", 60_000, "r");
    await selector.flagProviderCooldown("pool-iso-b", "openai", 60_000, "r");
    expect(await selector.getPoolCooldowns("pool-iso-a")).toHaveLength(1);
    expect(await selector.getPoolCooldowns("pool-iso-c")).toHaveLength(0);
  });

  test("clearProviderCooldown removes one provider flag", async () => {
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown("pool-clr", "openai", 60_000, "r");
    await selector.flagProviderCooldown("pool-clr", "xai", 60_000, "r");
    await selector.clearProviderCooldown("pool-clr", "OpenAI");
    expect(await selector.getPoolCooldowns("pool-clr")).toHaveLength(1);
  });

  test("getInflightAuthoritative reflects local admissions", async () => {
    const selector = new NetworkPoolSelector();
    expect(await selector.getInflightAuthoritative("pool-inf")).toBe(0);
    const slot = selector.acquire("pool-inf", 4);
    expect(slot.acquired).toBe(true);
    expect(await selector.getInflightAuthoritative("pool-inf")).toBe(1);
    slot.release();
    expect(await selector.getInflightAuthoritative("pool-inf")).toBe(0);
  });
});
