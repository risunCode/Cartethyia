import { describe, expect, test } from "bun:test";
import { NetworkSelector, ProxyHealthManager, ProxyPool, type ProxyConfig, type ProxyHealthStore } from "./network";

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
