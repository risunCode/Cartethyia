import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/transport/gateway-error";
import type { RedisClient } from "../../src/persistence/redis";
import {
  InMemoryIpAbuseStore,
  IpAbuseProtectionService,
  RedisIpAbuseStore,
  type ClientIdentity,
} from "../../src/security/abuse";

function identity(addr: string): ClientIdentity {
  return { address: addr, source: "tcp-peer" };
}

describe("IpAbuseProtectionService", () => {
  test("independent counters per route — /v1 paths do not interfere", async () => {
    let now = 0;
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => now, {
      maxRequestsPerWindow: 2,
      banThreshold: 10,
    });
    const ip = identity("1.1.1.1");

    // 2 allowed on one route
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    await expect(
      svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" }),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
    } as unknown as GatewayError);

    // same IP on another route should still be allowed (independent)
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/messages" });
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/messages" });
    // third route also independent
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/embeddings" });
    expect(await store.getCount(ip.address, "/v1/messages", now)).toBe(2);
    expect(await store.getCount(ip.address, "/v1/embeddings", now)).toBe(1);
    // Rejected attempts stay in the window: they are what drives ban escalation.
    expect(await store.getCount(ip.address, "/v1/chat/completions", now)).toBe(3);

    // different IP on same route is independent
    const ip2 = identity("2.2.2.2");
    await svc.checkBeforeAccess({ identity: ip2, route: "/v1/chat/completions" });
    expect(await store.getCount(ip2.address, "/v1/chat/completions", now)).toBe(1);
  });

  test("window expiry resets counters deterministically with fake clock", async () => {
    let now = 0;
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => now, {
      maxRequestsPerWindow: 2,
    });
    const ip = identity("3.3.3.3");
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    await expect(
      svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" }),
    ).rejects.toBeDefined();

    now += 60_001;
    // window slid, should allow again
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    expect(await store.getCount(ip.address, "/v1/chat/completions", now)).toBe(1);
  });

  test("enforces a window limit above the ring's default capacity", async () => {
    let now = 0;
    // Default `capacityPerKey` is 256; a 300 RPM limit must still be enforced.
    const store = new InMemoryIpAbuseStore({ windowMs: 60_000 });
    const svc = new IpAbuseProtectionService(store, () => now, {
      maxRequestsPerWindow: 300,
      banThreshold: 10_000,
    });
    const ip = identity("5.5.5.5");

    for (let attempt = 0; attempt < 300; attempt += 1) {
      await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    }
    expect(await store.getCount(ip.address, "/v1/chat/completions", now)).toBe(300);
    await expect(
      svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" }),
    ).rejects.toMatchObject({ code: "quota_exceeded" } as unknown as GatewayError);
  });

  test("escalates to a ban once over-limit attempts reach the threshold", async () => {
    let now = 0;
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => now, {
      maxRequestsPerWindow: 2,
      banThreshold: 5,
      banDurationMs: 60_000,
    });
    const ip = identity("6.6.6.6");

    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    // Over-limit attempts keep counting toward the ban threshold.
    for (let attempt = 3; attempt <= 5; attempt += 1) {
      await expect(
        svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" }),
      ).rejects.toThrow("ip rate limit exceeded");
    }
    expect(await store.isBanned(ip.address, now)).toBe(true);
    // A ban is per identity, not per route.
    await expect(svc.checkBeforeAccess({ identity: ip, route: "/v1/messages" })).rejects.toThrow(
      "ip banned",
    );
  });

  test("banDurationMs is authoritative for the store", async () => {
    let now = 0;
    const store = new InMemoryIpAbuseStore({ windowMs: 1_000 });
    const svc = new IpAbuseProtectionService(store, () => now, {
      maxRequestsPerWindow: 1,
      banThreshold: 2,
      banDurationMs: 1_000,
    });
    const ip = identity("9.9.9.9");

    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    await expect(
      svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" }),
    ).rejects.toThrow("ip rate limit exceeded");
    expect(await store.isBanned(ip.address, now)).toBe(true);

    now += 1_001;
    expect(await store.isBanned(ip.address, now)).toBe(false);
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
  });

  test("fail-closed on store outage — bounded admission_unavailable, zero dispatches", async () => {
    const store = new InMemoryIpAbuseStore();
    store.simulateFailure(true);
    const svc = new IpAbuseProtectionService(store);
    const ip = identity("4.4.4.4");

    let dispatchCount = 0;
    const tryAccess = async (route: string) => {
      await svc.checkBeforeAccess({ identity: ip, route });
      dispatchCount++;
    };

    await expect(tryAccess("/v1/chat/completions")).rejects.toMatchObject({
      code: "admission_unavailable",
    } as unknown as GatewayError);
    await expect(tryAccess("/v1/messages")).rejects.toMatchObject({
      code: "admission_unavailable",
    } as unknown as GatewayError);
    await expect(tryAccess("/v1/embeddings")).rejects.toMatchObject({
      code: "admission_unavailable",
    } as unknown as GatewayError);
    expect(dispatchCount).toBe(0);
    // recovery
    store.simulateFailure(false);
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    dispatchCount++;
    expect(dispatchCount).toBe(1);
  });

  test("each /v1 route is rate limited independently", async () => {
    let now = 0;
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => now, {
      maxRequestsPerWindow: 1,
      banThreshold: 10,
    });
    const ip = identity("7.7.7.7");

    await svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" });
    await expect(
      svc.checkBeforeAccess({ identity: ip, route: "/v1/chat/completions" }),
    ).rejects.toBeDefined();

    // another route still allows 1 even though the first is exhausted
    await svc.checkBeforeAccess({ identity: ip, route: "/v1/messages" });
    await expect(
      svc.checkBeforeAccess({ identity: ip, route: "/v1/messages" }),
    ).rejects.toBeDefined();
  });

  test("abort signal is respected and does not increment counters", async () => {
    const store = new InMemoryIpAbuseStore();
    const svc = new IpAbuseProtectionService(store);
    const ip = identity("8.8.8.8");
    const controller = new AbortController();
    controller.abort();
    await expect(
      svc.checkBeforeAccess({
        identity: ip,
        route: "/v1/chat/completions",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "admission_unavailable",
    } as unknown as GatewayError);
    expect(await store.getCount(ip.address, "/v1/chat/completions", Date.now())).toBe(0);
  });
});

describe("InMemoryIpAbuseStore bounds", () => {
  test("evicts the oldest tracked keys past maxKeys", async () => {
    const store = new InMemoryIpAbuseStore({ windowMs: 60_000, maxKeys: 3, clock: () => 0 });
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"]) {
      await store.checkAndRecord({
        identity: ip,
        route: "/v1/chat/completions",
        now: 0,
        limit: 10,
        banThreshold: 20,
        banDurationMs: 60_000,
      });
    }

    expect(store.keyCount()).toBe(3);
    // The two oldest identities were evicted and restart from zero.
    expect(await store.getCount("1.1.1.1", "/v1/chat/completions", 0)).toBe(0);
    expect(await store.getCount("2.2.2.2", "/v1/chat/completions", 0)).toBe(0);
    expect(await store.getCount("5.5.5.5", "/v1/chat/completions", 0)).toBe(1);
  });

  test("evicts the oldest recorded bans past maxKeys", async () => {
    // Each identity bans itself on its first attempt, so the ban map is what
    // the bound has to hold; `maxKeys` is shared by the counters and the bans.
    const store = new InMemoryIpAbuseStore({ windowMs: 60_000, maxKeys: 2, clock: () => 0 });
    const banOnFirst = (identity: string) =>
      store.checkAndRecord({
        identity,
        route: "/v1/chat/completions",
        now: 0,
        limit: 1,
        banThreshold: 1,
        banDurationMs: 60_000,
      });
    await banOnFirst("1.1.1.1");
    await banOnFirst("2.2.2.2");
    await banOnFirst("3.3.3.3");

    expect(await store.isBanned("1.1.1.1", 0)).toBe(false);
    expect(await store.isBanned("2.2.2.2", 0)).toBe(true);
    expect(await store.isBanned("3.3.3.3", 0)).toBe(true);
  });

  test("grows a key's ring to the ban ceiling past its preallocated capacity", async () => {
    const store = new InMemoryIpAbuseStore({ windowMs: 60_000, capacityPerKey: 2 });
    let count = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const outcome = await store.checkAndRecord({
        identity: "1.1.1.1",
        route: "/v1/chat/completions",
        now: 0,
        limit: 1,
        banThreshold: 6,
        banDurationMs: 60_000,
      });
      count = outcome.count;
    }
    expect(count).toBe(6);
  });

  test("reports the real remaining wait for a rate-limited window", async () => {
    // The wait is how long until the oldest attempt leaves the window, not a
    // fixed value. A hardcoded `retry-after` told a client facing a 60-second
    // window to wait an hour.
    const store = new InMemoryIpAbuseStore({ windowMs: 60_000, clock: () => 0 });
    const first = await store.checkAndRecord({
      identity: "1.1.1.1",
      route: "/v1/chat/completions",
      now: 0,
      limit: 1,
      banThreshold: 100,
      banDurationMs: 60_000,
    });
    expect(first.retryAfterMs).toBe(0); // admitted

    // Second attempt at t=10s is over the limit; the oldest attempt ages out
    // at t=60s, so 50s remain.
    const second = await store.checkAndRecord({
      identity: "1.1.1.1",
      route: "/v1/chat/completions",
      now: 10_000,
      limit: 1,
      banThreshold: 100,
      banDurationMs: 60_000,
    });
    expect(second.count).toBe(2);
    expect(second.retryAfterMs).toBe(50_000);
  });

  test("reports the real remaining wait for a live ban", async () => {
    const store = new InMemoryIpAbuseStore({ windowMs: 60_000, clock: () => 0 });
    const attempt = (now: number) =>
      store.checkAndRecord({
        identity: "1.1.1.1",
        route: "/v1/chat/completions",
        now,
        limit: 1,
        banThreshold: 2,
        banDurationMs: 3_600_000,
      });
    await attempt(0);
    const banned = await attempt(0);
    expect(banned.bannedNow).toBe(true);
    expect(banned.retryAfterMs).toBe(3_600_000);

    // A later attempt sees the ban's shrinking remainder, not the full hour.
    const later = await attempt(3_000_000);
    expect(later.banned).toBe(true);
    expect(later.retryAfterMs).toBe(600_000);
  });
});

describe("RedisIpAbuseStore", () => {
  test("one call issues exactly one eval over the route, escalation, and ban keys", async () => {
    // The whole point of the merged store method: the per-request cost is one
    // round trip. If a future change re-splits it into separate reads and
    // writes, this assertion fails on the count, not just on the shape.
    const evals: Array<{ script: string; numKeys: number; keys: unknown[] }> = [];
    const redis = {
      eval: (script: string, numKeys: number, ...args: unknown[]) => {
        evals.push({ script, numKeys, keys: args.slice(0, numKeys) });
        return Promise.resolve([0, 1, 0, 0]);
      },
    } as unknown as RedisClient;
    const store = new RedisIpAbuseStore(redis);

    const outcome = await store.checkAndRecord({
      identity: "1.2.3.4",
      route: "/v1/chat/completions",
      now: 1_000,
      limit: 240,
      banThreshold: 480,
      banDurationMs: 2_500,
    });

    expect(evals).toHaveLength(1);
    expect(evals[0]?.numKeys).toBe(3);
    expect(evals[0]?.keys).toEqual([
      "cartethyia:ip:1.2.3.4:/v1/chat/completions",
      "cartethyia:ip:ban-count:1.2.3.4",
      "cartethyia:ip:ban:1.2.3.4",
    ]);
    expect(outcome).toEqual({ banned: false, count: 1, bannedNow: false, retryAfterMs: 0 });
  });

  test("decodes the banned short-circuit without inventing a count", async () => {
    const redis = {
      eval: () => Promise.resolve([1, 0, 0, 45_000]),
    } as unknown as RedisClient;
    const store = new RedisIpAbuseStore(redis);

    const outcome = await store.checkAndRecord({
      identity: "1.2.3.4",
      route: "/v1/chat/completions",
      now: 1_000,
      limit: 240,
      banThreshold: 480,
      banDurationMs: 2_500,
    });

    // The ban's remaining TTL rides through as the wait hint; the count stays
    // 0 because a banned attempt records nothing.
    expect(outcome).toEqual({ banned: true, count: 0, bannedNow: false, retryAfterMs: 45_000 });
  });

  test("a garbled script reply throws instead of reading as a bogus decision", async () => {
    // A reply that is not a 4-tuple means the script/response pair drifted.
    // Reading it as `banned: false, count: NaN` would admit on garbage.
    const redis = {
      eval: () => Promise.resolve("nonsense"),
    } as unknown as RedisClient;
    const store = new RedisIpAbuseStore(redis);

    await expect(
      store.checkAndRecord({
        identity: "1.2.3.4",
        route: "/v1/chat/completions",
        now: 1_000,
        limit: 240,
        banThreshold: 480,
        banDurationMs: 2_500,
      }),
    ).rejects.toThrow("non-array");
  });
});
