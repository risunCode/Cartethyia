import { describe, expect, test } from "bun:test";
import { NetworkSelector, ProxyHealthManager, ProxyPool, type ProxyConfig, type ProxyHealthStore } from "../../src/traffic/network";

const proxies: readonly ProxyConfig[] = Array.from({ length: 32 }, (_, index) => ({
  id: `proxy-${index}`,
  url: `http://proxy-${index}.test`,
  enabled: true,
  maxConcurrency: 1_000,
  priority: index,
  weight: 100,
  excludedProviderIds: [],
}));

const healthStore: ProxyHealthStore = {
  get: async () => undefined,
  set: async () => {},
  list: async () => [],
};

describe("routing benchmark", () => {
  test("measures repeated proxy selection without semantic drift", async () => {
    const pool = new ProxyPool({
      getProxy: async (id) => proxies.find((proxy) => proxy.id === id),
      listProxies: async () => proxies,
    });
    const selector = new NetworkSelector(pool, new ProxyHealthManager(healthStore));
    const iterations = 5_000;
    const startedAt = performance.now();
    let selected = 0;

    for (let index = 0; index < iterations; index += 1) {
      const result = await selector.select({
        providerId: "openai",
        affinityKey: `client-${index % 128}`,
        sticky: true,
      });
      expect(result).not.toBeNull();
      if (result === null) continue;
      selected += 1;
      await result.selection.release();
    }

    const elapsedMs = performance.now() - startedAt;
    console.log(`[benchmark] ${JSON.stringify({
      stage: "network-selection",
      iterations,
      selected,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      operationsPerSecond: Math.round(iterations / Math.max(elapsedMs / 1_000, 0.001)),
    })}`);
    expect(selected).toBe(iterations);
  });
});
