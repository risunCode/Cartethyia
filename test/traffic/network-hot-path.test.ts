import { describe, expect, test } from "bun:test";
import type { ApplicationErrorKind, ProviderCallError } from "../../src/application/contracts";
import type { ProviderErrorOptions } from "../../src/traffic/network";
import type {
  ProxyConfig,
  ProxyHealthRecord,
  ProxyHealthStore,
  ProxyPoolConfigStore,
} from "../../src/traffic/network";
import {
  ACCOUNT_AUTH_BACKOFF_BASE_MS,
  ACCOUNT_AUTH_BACKOFF_CAP_MS,
  ACCOUNT_QUOTA_COOLDOWN_MS,
  ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  PROXY_AUTH_BACKOFF_BASE_MS,
  PROXY_AUTH_BACKOFF_CAP_MS,
  PROXY_RATE_LIMIT_COOLDOWN_MS,
  ProxyHealthManager,
  ProxyPool,
  ProxySlotManager,
  NetworkSelector,
  accountCooldownPolicyFor,
  boundedRetryDelayMs,
  buildProxyFetcher,
  cooldownDelayMs,
  createProviderError,
  deriveRouteHealth,
  envBoolean,
  envNumber,
  exponentialBackoffMs,
  isRecordUsable,
  isTransientErrorKind,
  networkUnavailableError,
  proxyCooldownPolicyFor,
  proxyEnvSuffix,
  proxyIdFromSuffix,
} from "../../src/traffic/network";

function proxy(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id: "proxy-a",
    url: "http://proxy-a.test:8080",
    enabled: true,
    maxConcurrency: 2,
    priority: 0,
    weight: 100,
    excludedProviderIds: [],
    ...overrides,
  };
}

class MemoryProxyStore implements ProxyPoolConfigStore {
  proxies: ProxyConfig[];
  listCalls = 0;

  constructor(proxies: ProxyConfig[]) {
    this.proxies = proxies;
  }

  async getProxy(id: string): Promise<ProxyConfig | undefined> {
    return this.proxies.find((candidate) => candidate.id === id);
  }

  async listProxies(): Promise<readonly ProxyConfig[]> {
    this.listCalls += 1;
    return this.proxies;
  }
}

class MemoryHealthStore implements ProxyHealthStore {
  readonly records = new Map<string, ProxyHealthRecord>();
  listCalls = 0;
  setCalls = 0;

  async get(proxyId: string): Promise<ProxyHealthRecord | undefined> {
    return this.records.get(proxyId);
  }

  async set(record: ProxyHealthRecord): Promise<void> {
    this.setCalls += 1;
    this.records.set(record.proxyId, record);
  }

  async list(): Promise<readonly ProxyHealthRecord[]> {
    this.listCalls += 1;
    return [...this.records.values()];
  }
}

function errorFor(
  kind: ApplicationErrorKind,
  message: string,
  options: ProviderErrorOptions = {},
): ProviderCallError {
  return createProviderError(kind, message, {
    retryable: true,
    routeScope: "proxy",
    ...options,
  });
}

describe("network hot paths", () => {
  test("normalizes environment values and proxy identifiers", () => {
    expect(envBoolean(undefined, true)).toBe(true);
    expect(envBoolean(" YES ", false)).toBe(true);
    expect(envBoolean("0", true)).toBe(false);
    expect(envBoolean("not-a-boolean", true)).toBe(true);
    expect(envNumber(" 4.5 ", 0)).toBe(4.5);
    expect(envNumber("not-a-number", 7)).toBe(7);
    expect(proxyEnvSuffix("eu-west_1")).toBe("EU_WEST_1");
    expect(proxyIdFromSuffix("EU_WEST_1")).toBe("eu-west-1");
  });

  test("bounds per-proxy slot leases and makes release idempotent", async () => {
    const slots = new ProxySlotManager();

    expect(slots.tryAcquire("invalid", 0)).toBeNull();
    const first = slots.tryAcquire("proxy-a", 1);
    expect(first).not.toBeNull();
    expect(slots.activeCount("proxy-a")).toBe(1);
    expect(slots.tryAcquire("proxy-a", 1)).toBeNull();

    await first?.release();
    await first?.release();
    expect(slots.activeCount("proxy-a")).toBe(0);

    const second = slots.tryAcquire("proxy-a", 2);
    const third = slots.tryAcquire("proxy-a", 2);
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(slots.activeCount("proxy-a")).toBe(2);
    await Promise.all([second?.release(), third?.release()]);
    expect(slots.activeCount("proxy-a")).toBe(0);
  });

  test("sorts and caches proxy configuration, filters disabled and excluded routes", async () => {
    const store = new MemoryProxyStore([
      proxy({ id: "proxy-b", priority: 2 }),
      proxy({ id: "proxy-a", priority: 2 }),
      proxy({ id: "proxy-disabled", enabled: false, priority: 9 }),
      proxy({ id: "proxy-excluded", excludedProviderIds: ["provider-a"], priority: 1 }),
    ]);
    const pool = new ProxyPool(store);

    expect((await pool.list()).map((candidate) => candidate.id)).toEqual([
      "proxy-disabled",
      "proxy-a",
      "proxy-b",
      "proxy-excluded",
    ]);
    expect((await pool.list()).map((candidate) => candidate.id)).toEqual([
      "proxy-disabled",
      "proxy-a",
      "proxy-b",
      "proxy-excluded",
    ]);
    expect(store.listCalls).toBe(1);
    expect(await pool.get("proxy-b")).toMatchObject({ id: "proxy-b" });

    const enabled = await pool.enabledFor("provider-a");
    expect(enabled.map((candidate) => candidate.id)).toEqual(["proxy-a", "proxy-b"]);
    expect(await pool.enabledFor("provider-a")).toBe(enabled);
    expect(store.listCalls).toBe(1);

    store.proxies = [proxy({ id: "proxy-new", priority: 10 })];
    expect((await pool.list()).map((candidate) => candidate.id)).toEqual([
      "proxy-disabled",
      "proxy-a",
      "proxy-b",
      "proxy-excluded",
    ]);
    pool.invalidate();
    expect((await pool.list()).map((candidate) => candidate.id)).toEqual(["proxy-new"]);
    expect(store.listCalls).toBe(2);
  });

  test("returns direct routes when direct is forced or no enabled proxy remains", async () => {
    const store = new MemoryProxyStore([
      proxy({ id: "proxy-disabled", enabled: false }),
      proxy({ id: "proxy-excluded", excludedProviderIds: ["provider-a"] }),
    ]);
    const pool = new ProxyPool(store);
    const health = new ProxyHealthManager(new MemoryHealthStore(), { nowMs: () => 1_000 });
    const selector = new NetworkSelector(pool, health);

    const forced = await selector.select({ providerId: "provider-a", preferDirect: true });
    expect(forced).toMatchObject({ mode: "direct", proxyId: null, reason: "direct_forced" });
    await forced?.selection.release();

    const fallback = await selector.select({ providerId: "provider-a" });
    expect(fallback).toMatchObject({ mode: "direct", proxyId: null, reason: "proxy_disabled_direct" });
    expect(await selector.select({ providerId: "provider-a", allowDirectFallback: false })).toBeNull();
  });

  test("selects relay and ordinary proxies while preserving preferred and sticky affinity", async () => {
    const store = new MemoryProxyStore([
      proxy({ id: "proxy-a", priority: 1 }),
      proxy({ id: "proxy-relay", url: "http://relay.test:9000", isRelay: true, priority: 0 }),
      proxy({ id: "proxy-b", priority: 0 }),
    ]);
    const pool = new ProxyPool(store);
    const health = new ProxyHealthManager(new MemoryHealthStore(), { nowMs: () => 2_000 });
    const selector = new NetworkSelector(pool, health);

    const preferred = await selector.select({ providerId: "provider-a", preferredProxyId: "proxy-relay" });
    expect(preferred).toMatchObject({ mode: "proxy", proxyId: "proxy-relay", reason: "proxy" });
    expect(preferred?.selection).toMatchObject({ proxyId: "proxy-relay", url: "http://relay.test:9000", isRelay: true });
    await preferred?.selection.release();
    await preferred?.selection.release();
    expect(pool.activeCount("proxy-relay")).toBe(0);

    const stickyFirst = await selector.select({ providerId: "provider-a", affinityKey: "user-42", sticky: true });
    const stickyProxyId = stickyFirst?.proxyId;
    await stickyFirst?.selection.release();
    const stickySecond = await selector.select({ providerId: "provider-a", affinityKey: "user-42", sticky: true });
    expect(stickySecond?.proxyId).toBe(stickyProxyId);
    await stickySecond?.selection.release();

    const targetUser = new NetworkSelector(pool, health, () => ({ preset: "target-user", targetConcurrent: 0 }));
    const targetFirst = await targetUser.select({ providerId: "provider-a", affinityKey: "user-42" });
    const targetProxyId = targetFirst?.proxyId;
    await targetFirst?.selection.release();
    const targetSecond = await targetUser.select({ providerId: "provider-a", affinityKey: "user-42" });
    expect(targetSecond?.proxyId).toBe(targetProxyId);
    await targetSecond?.selection.release();
  });

  test("uses least-loaded candidates and enforces target-concurrent overrides", async () => {
    const leastLoadedStore = new MemoryProxyStore([
      proxy({ id: "proxy-a", maxConcurrency: 4, priority: 2 }),
      proxy({ id: "proxy-b", maxConcurrency: 4, priority: 1 }),
    ]);
    const leastLoadedPool = new ProxyPool(leastLoadedStore);
    const health = new ProxyHealthManager(new MemoryHealthStore(), { nowMs: () => 3_000 });
    const leastLoaded = new NetworkSelector(leastLoadedPool, health);
    const busyLease = leastLoadedPool.acquireSlot(await leastLoadedPool.get("proxy-a") as ProxyConfig);
    const selected = await leastLoaded.select({ providerId: "provider-a" });
    expect(selected?.proxyId).toBe("proxy-b");
    await selected?.selection.release();
    await busyLease?.release();

    const targetStore = new MemoryProxyStore([
      proxy({ id: "proxy-a", maxConcurrency: 3 }),
      proxy({ id: "proxy-b", maxConcurrency: 3 }),
    ]);
    const targetPool = new ProxyPool(targetStore);
    const targetHealth = new ProxyHealthManager(new MemoryHealthStore(), { nowMs: () => 3_000 });
    const targetSelector = new NetworkSelector(targetPool, targetHealth, () => ({ preset: "target-concurrent", targetConcurrent: 1 }));
    const targetA = await targetPool.get("proxy-a");
    const targetLease = targetA === undefined ? null : targetPool.acquireSlot(targetA, 1);
    expect(targetLease).not.toBeNull();
    const targetSelected = await targetSelector.select({ providerId: "provider-a", allowDirectFallback: false });
    expect(targetSelected?.proxyId).toBe("proxy-b");
    await targetSelected?.selection.release();
    await targetLease?.release();
    expect(targetPool.activeCount("proxy-a")).toBe(0);
    expect(targetPool.activeCount("proxy-b")).toBe(0);
  });

  test("scopes health failures to one proxy and admits it again at cooldown expiry", async () => {
    let now = 10_000;
    const healthStore = new MemoryHealthStore();
    const health = new ProxyHealthManager(healthStore, { nowMs: () => now, cacheTtlMs: 0 });
    const store = new MemoryProxyStore([
      proxy({ id: "proxy-a", priority: 2 }),
      proxy({ id: "proxy-b", priority: 1 }),
    ]);
    const selector = new NetworkSelector(new ProxyPool(store), health);

    const failed = await health.recordFailure("proxy-a", errorFor("authentication_failed", "invalid credential", { statusCode: 401 }));
    expect(failed).toMatchObject({ proxyId: "proxy-a", status: "cooling_down", failureCount: 1 });
    expect(failed?.disabledUntilMs).toBeGreaterThan(now);

    const duringCooldown = await selector.select({ providerId: "provider-a", nowMs: (failed?.disabledUntilMs ?? now) - 1 });
    expect(duringCooldown?.proxyId).toBe("proxy-b");
    await duringCooldown?.selection.release();

    const atExpiry = await selector.select({ providerId: "provider-a", nowMs: failed?.disabledUntilMs ?? now });
    expect(atExpiry?.proxyId).toBe("proxy-a");
    await atExpiry?.selection.release();

    const recovered = await health.recordSuccess("proxy-a");
    expect(recovered).toMatchObject({ status: "healthy", failureCount: 0, generation: 2 });
    expect(await health.getHealth("proxy-a")).toMatchObject({ scope: "proxy", status: "healthy", retryAt: null });

    const transient = await health.recordFailure("proxy-b", errorFor("provider_unavailable", "temporary upstream outage"));
    expect(transient).toMatchObject({ status: "error", disabledUntilMs: null, failureCount: 1 });
    expect(await health.isUsable("proxy-b", now)).toBe(true);
  });

  test("refreshes persisted health after cache expiry and ignores non-retryable failures", async () => {
    let now = 100;
    const store = new MemoryHealthStore();
    const health = new ProxyHealthManager(store, { nowMs: () => now, cacheTtlMs: 50 });

    expect(await health.list()).toEqual([]);
    expect(await health.list()).toEqual([]);
    expect(store.listCalls).toBe(1);
    now = 151;
    expect(await health.list()).toEqual([]);
    expect(store.listCalls).toBe(2);

    const ignored = await health.recordFailure("proxy-a", errorFor("authentication_failed", "permanent", { retryable: false }));
    expect(ignored).toBeNull();
    expect(store.setCalls).toBe(0);
  });

  test("covers cooldown policy, retry-after bounds, route health, and typed errors", () => {
    expect(isTransientErrorKind("provider_unavailable")).toBe(true);
    expect(isTransientErrorKind("authentication_failed")).toBe(false);
    expect(accountCooldownPolicyFor("provider_rate_limited")).toMatchObject({
      defaultMs: ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
      baseMs: ACCOUNT_AUTH_BACKOFF_BASE_MS,
      capMs: ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
    });
    expect(accountCooldownPolicyFor("quota_exceeded").defaultMs).toBe(ACCOUNT_QUOTA_COOLDOWN_MS);
    expect(proxyCooldownPolicyFor("provider_rate_limited")).toMatchObject({
      defaultMs: PROXY_RATE_LIMIT_COOLDOWN_MS,
      baseMs: PROXY_AUTH_BACKOFF_BASE_MS,
      capMs: PROXY_RATE_LIMIT_COOLDOWN_MS,
    });
    expect(proxyCooldownPolicyFor("quota_exceeded").defaultMs).toBe(PROXY_RATE_LIMIT_COOLDOWN_MS);

    expect(exponentialBackoffMs(100, 1, 1_000)).toBe(100);
    expect(exponentialBackoffMs(100, 99, 250)).toBeGreaterThanOrEqual(100);
    expect(exponentialBackoffMs(100, 99, 250)).toBeLessThanOrEqual(250);
    expect(boundedRetryDelayMs(null, 1_000, 5_000)).toBeNull();
    expect(boundedRetryDelayMs("not-a-date", 1_000, 5_000)).toBeNull();
    expect(boundedRetryDelayMs(new Date(500).toISOString(), 1_000, 5_000)).toBeNull();
    expect(boundedRetryDelayMs(new Date(6_000).toISOString(), 1_000, 5_000)).toBe(5_000);
    expect(boundedRetryDelayMs(new Date(7_001).toISOString(), 1_000, 5_000)).toBeNull();

    const auth = errorFor("authentication_failed", "bad auth");
    expect(cooldownDelayMs({ ...auth, retryable: false }, proxyCooldownPolicyFor(auth.kind), 1, 1_000)).toBe(0);
    expect(cooldownDelayMs(errorFor("provider_unavailable", "temporary"), proxyCooldownPolicyFor(auth.kind), 1, 1_000)).toBe(0);
    expect(cooldownDelayMs(errorFor("provider_rate_limited", "too many requests"), proxyCooldownPolicyFor("provider_rate_limited"), 1, 1_000)).toBe(30_000);
    expect(cooldownDelayMs(errorFor("quota_exceeded", "quota exceeded"), proxyCooldownPolicyFor("quota_exceeded"), 1, 1_000)).toBe(300_000);
    expect(cooldownDelayMs({ ...auth, retryAt: new Date(4_000).toISOString() }, proxyCooldownPolicyFor(auth.kind), 1, 1_000)).toBe(3_000);
    expect(cooldownDelayMs(auth, proxyCooldownPolicyFor(auth.kind), 2, 1_000)).toBeGreaterThanOrEqual(2_000);
    expect(cooldownDelayMs(auth, proxyCooldownPolicyFor(auth.kind), 2, 1_000)).toBeLessThanOrEqual(5_000);

    const cooling = {
      status: "cooling_down" as const,
      statusCode: 502,
      failureKind: "provider_unavailable" as const,
      sanitizedMessage: "temporary",
      occurredAt: new Date(1_000).toISOString(),
      retryAt: new Date(6_000).toISOString(),
      disabledUntilMs: 6_000,
    };
    expect(isRecordUsable({ ...cooling, status: "healthy", disabledUntilMs: null }, 1_000)).toBe(true);
    expect(isRecordUsable({ ...cooling, status: "disabled" }, 1_000)).toBe(false);
    expect(isRecordUsable(cooling, 5_999)).toBe(false);
    expect(isRecordUsable(cooling, 6_000)).toBe(true);
    expect(isRecordUsable({ ...cooling, status: "error", disabledUntilMs: null }, 1_000)).toBe(true);

    expect(deriveRouteHealth(cooling, "proxy", 5_000)).toMatchObject({
      scope: "proxy",
      status: "cooling_down",
      statusCode: 502,
      retryAt: new Date(6_000).toISOString(),
    });
    expect(deriveRouteHealth({ ...cooling, status: "disabled", disabledUntilMs: null }, "proxy", 5_000)).toMatchObject({
      status: "disabled",
      statusCode: 502,
      retryAt: null,
    });
    expect(deriveRouteHealth({ ...cooling, status: "healthy", disabledUntilMs: null }, "proxy", 5_000)).toMatchObject({
      status: "healthy",
      statusCode: null,
      failureKind: null,
      sanitizedMessage: null,
    });

    const unavailable = networkUnavailableError("provider-a", new Date(8_000).toISOString());
    expect(unavailable).toMatchObject({
      kind: "network_unavailable",
      retryable: true,
      routeScope: "proxy",
      retryAt: new Date(8_000).toISOString(),
    });
    expect(createProviderError("internal_error", "token=secret-value", { retryable: true }).sanitizedMessage).toBe("credential=[redacted]");
    expect(PROXY_AUTH_BACKOFF_CAP_MS).toBeGreaterThan(PROXY_AUTH_BACKOFF_BASE_MS);
    expect(ACCOUNT_AUTH_BACKOFF_CAP_MS).toBeGreaterThan(ACCOUNT_AUTH_BACKOFF_BASE_MS);
  });

  test("builds relay and HTTP proxy fetchers without external network calls", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    const mockedFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    };
    globalThis.fetch = mockedFetch as typeof globalThis.fetch;

    try {
      const relayFetcher = buildProxyFetcher({ url: "http://relay-user:relay-pass@relay.test:9000/base", isRelay: true });
      const relayResponse = await relayFetcher("https://target.test/v1/messages?stream=true", {
        method: "POST",
        headers: { Host: "target.test", "x-client": "yes" },
        body: "payload",
      });
      expect(relayResponse.status).toBe(200);
      expect(calls[0]?.url).toBe("http://relay.test:9000/base");
      const relayInit = calls[0]?.init;
      const relayHeaders = new Headers(relayInit?.headers);
      expect(relayHeaders.get("host")).toBeNull();
      expect(relayHeaders.get("x-relay-target")).toBe("https://target.test");
      expect(relayHeaders.get("x-relay-path")).toBe("/v1/messages?stream=true");
      expect(relayHeaders.get("x-relay-auth")).toBe(`Basic ${Buffer.from("relay-user:relay-pass").toString("base64")}`);

      const httpFetcher = buildProxyFetcher({ url: "http://proxy.test:8080/" });
      await httpFetcher("https://target.test/v1/models", { method: "GET" });
      expect(calls[1]?.url).toBe("https://target.test/v1/models");
      expect((calls[1]?.init as RequestInit & { proxy?: string }).proxy).toBe("http://proxy.test:8080");

      expect(() => buildProxyFetcher({ url: "ftp://proxy.test:21" })).toThrow("Unsupported outbound proxy protocol");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
