import { describe, expect, test } from "bun:test";
import { NetworkSelector, ProxyHealthManager, ProxyPool, type ProxyConfig, type ProxyHealthRecord, type ProxyHealthStore } from "./network";

const proxies: readonly ProxyConfig[] = [
  { id: "proxy-a", url: "http://proxy-a.test", enabled: true, maxConcurrency: 4, priority: 0, weight: 100, excludedProviderIds: [] },
  { id: "proxy-b", url: "http://proxy-b.test", enabled: true, maxConcurrency: 4, priority: 0, weight: 100, excludedProviderIds: [] },
];

const healthStore: ProxyHealthStore = {
  get: async () => undefined,
  set: async () => {},
  list: async () => [],
};

describe("proxy cache affinity", () => {
  test("keeps a cache-affine caller on the same proxy when slots are available", async () => {
    const pool = new ProxyPool({
      getProxy: async (id) => proxies.find((proxy) => proxy.id === id),
      listProxies: async () => proxies,
    });
    const selector = new NetworkSelector(pool, new ProxyHealthManager(healthStore));

    const first = await selector.select({ providerId: "openai", affinityKey: "api-key-1", sticky: true });
    expect(first).not.toBeNull();
    if (first === null) return;
    await first.selection.release();

    const second = await selector.select({ providerId: "openai", affinityKey: "api-key-1", sticky: true });
    expect(second?.proxyId).toBe(first.proxyId);
    if (second !== null) await second.selection.release();
  });
});

describe("proxy health persistence cache", () => {
  test("avoids repeated health reads within the cache window and refreshes after expiry", async () => {
    let now = 1_000;
    let listCalls = 0;
    const store: ProxyHealthStore = {
      get: async () => undefined,
      set: async () => {},
      list: async () => {
        listCalls += 1;
        return [];
      },
    };
    const manager = new ProxyHealthManager(store, { nowMs: () => now, cacheTtlMs: 100 });
    expect(await manager.list()).toEqual([]);
    expect(await manager.list()).toEqual([]);
    expect(listCalls).toBe(1);
    now += 101;
    expect(await manager.list()).toEqual([]);
    expect(listCalls).toBe(2);
  });
  test("publishes local health mutations without waiting for cache expiry", async () => {
    const records: ProxyHealthRecord[] = [];
    let listCalls = 0;
    const store: ProxyHealthStore = {
      get: async () => undefined,
      set: async (record) => {
        const index = records.findIndex((item) => item.proxyId === record.proxyId);
        if (index === -1) records.push(record);
        else records[index] = record;
      },
      list: async () => {
        listCalls += 1;
        return records;
      },
    };
    const manager = new ProxyHealthManager(store);
    expect(await manager.list()).toEqual([]);
    const healthy = await manager.recordSuccess("proxy-a");
    expect((await manager.list()).find((record) => record.proxyId === "proxy-a")).toEqual(healthy);
    expect(listCalls).toBe(1);
  });
});
