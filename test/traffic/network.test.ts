import { describe, expect, test } from "bun:test";
import { ProxyHealthManager, envBoolean, envNumber, proxyEnvSuffix, proxyIdFromSuffix } from "../../src/traffic/network";
import { EnvProxyPoolConfigStore, MemoryProxyHealthStore } from "./helpers";
import type { ProviderCallError } from "../../src/domain/contracts";

describe("env helper parsing", () => {
  test("envBoolean accepts true, 1, yes and false, 0, no with a fallback", () => {
    expect(envBoolean("true", false)).toBe(true);
    expect(envBoolean("1", false)).toBe(true);
    expect(envBoolean("yes", false)).toBe(true);
    expect(envBoolean("false", true)).toBe(false);
    expect(envBoolean("0", true)).toBe(false);
    expect(envBoolean("no", true)).toBe(false);
    expect(envBoolean(undefined, true)).toBe(true);
    expect(envBoolean("junk", true)).toBe(true);
  });

  test("envNumber parses finite numbers and falls back otherwise", () => {
    expect(envNumber("12", 0)).toBe(12);
    expect(envNumber("4.5", 0)).toBe(4.5);
    expect(envNumber(undefined, 7)).toBe(7);
    expect(envNumber("abc", 7)).toBe(7);
  });

  test("proxyEnvSuffix and proxyIdFromSuffix convert id <-> env suffix losslessly", () => {
    expect(proxyEnvSuffix("my-proxy-1")).toBe("MY_PROXY_1");
    expect(proxyIdFromSuffix("MY_PROXY_1")).toBe("my-proxy-1");
  });
});

describe("EnvProxyPoolConfigStore", () => {
  const env: Record<string, string | undefined> = {
    CARTETHYIA_PROXY_POOL_ENABLED: "true",
    CARTETHYIA_PROXY_PROXY_1_URL: "http://p1.example.com:1080",
    CARTETHYIA_PROXY_PROXY_1_MAX_CONCURRENCY: "16",
    CARTETHYIA_PROXY_PROXY_1_PRIORITY: "3",
    CARTETHYIA_PROXY_PROXY_1_EXCLUDED_PROVIDERS: "openai, anthropic",
    CARTETHYIA_PROXY_PROXY_2_URL: "http://p2.example.com:1080",
    CARTETHYIA_PROXY_PROXY_2_ENABLED: "false",
  };

  test("parses a configured proxy with defaults and overrides", async () => {
    const store = new EnvProxyPoolConfigStore(env);
    const proxy = await store.getProxy("proxy-1");
    expect(proxy).toMatchObject({
      id: "proxy-1",
      url: "http://p1.example.com:1080",
      enabled: true,
      maxConcurrency: 16,
      priority: 3,
      excludedProviderIds: ["openai", "anthropic"],
    });
  });

  test("defaults max concurrency for a proxy without explicit settings", async () => {
    const store = new EnvProxyPoolConfigStore(env);
    const proxy = await store.getProxy("proxy-2");
    expect(proxy?.enabled).toBe(false);
    expect(proxy?.maxConcurrency).toBe(8);
  });

  test("returns undefined for an unconfigured proxy", async () => {
    const store = new EnvProxyPoolConfigStore(env);
    expect(await store.getProxy("missing")).toBeUndefined();
  });

  test("honors an empty url (no proxy configured)", async () => {
    const store = new EnvProxyPoolConfigStore({ CARTETHYIA_PROXY_POOL_ENABLED: "true" });
    expect(await store.getProxy("x")).toBeUndefined();
  });

  test("listProxies enumerates only configured proxies", async () => {
    const store = new EnvProxyPoolConfigStore(env);
    const proxies = await store.listProxies();
    expect(proxies.map((p) => p.id)).toEqual(["proxy-1", "proxy-2"]);
  });
});

describe("MemoryProxyHealthStore + ProxyHealthManager", () => {
  function failure(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
    return { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "proxy", source: "internal", sanitizedMessage: "upstream down", retryAt: null, ...overrides };
  }

  test("MemoryProxyHealthStore round-trips get/set/list", async () => {
    const store = new MemoryProxyHealthStore();
    expect(await store.get("p")).toBeUndefined();
    await store.set({ proxyId: "p", status: "cooling_down", statusCode: 429, failureKind: "provider_rate_limited", sanitizedMessage: "slow", occurredAt: "2026-08-05T00:00:00.000Z", retryAt: null, disabledUntilMs: null, failureCount: 1, generation: 1 });
    expect((await store.get("p"))?.failureCount).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  test("recordSuccess marks healthy and clears failure state", async () => {
    const store = new MemoryProxyHealthStore();
    const manager = new ProxyHealthManager(store, { nowMs: () => 1_000 });
    const healthy = await manager.recordSuccess("p");
    expect(healthy.status).toBe("healthy");
    expect(healthy.failureCount).toBe(0);
    expect((await manager.getHealth("p"))?.status).toBe("healthy");
  });

  test("recordFailure increments failure count and computes a cooldown", async () => {
    const store = new MemoryProxyHealthStore();
    const manager = new ProxyHealthManager(store, { nowMs: () => 1_000 });
    const record = await manager.recordFailure("p", failure({ kind: "provider_rate_limited", retryable: true }));
    expect(record?.status).toBe("cooling_down");
    expect(record?.failureCount).toBe(1);
    expect(record?.disabledUntilMs).not.toBeNull();
  });

  test("recordFailure returns null and does not write for non-retryable errors", async () => {
    const store = new MemoryProxyHealthStore();
    const manager = new ProxyHealthManager(store, { nowMs: () => 1_000 });
    expect(await manager.recordFailure("p", failure({ retryable: false }))).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  test("isUsable reports false while cooling down and true when healthy or absent", async () => {
    const store = new MemoryProxyHealthStore();
    const manager = new ProxyHealthManager(store, { nowMs: () => 1_000 });
    expect(await manager.isUsable("absent")).toBe(true);
    await manager.recordSuccess("ok");
    expect(await manager.isUsable("ok")).toBe(true);
  });
});
