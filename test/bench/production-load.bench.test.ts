import { describe, expect, test } from "bun:test";
import { getInFlightCount } from "../../src/traffic/in-flight";
import { NetworkSelector, ProxyHealthManager, ProxyPool, type ProxyConfig } from "../../src/traffic";
import { MemoryProxyHealthStore } from "../traffic/helpers";
import { runProxyRequest, type ProxyRequestDependencies } from "../../src/app/request";
import { assertBenchmarkHealthy, benchmarkRequest, createBenchmarkAdapter, createBenchmarkDependencies, createRouteCandidate, scaledCount } from "./helpers";

const REQUESTS = scaledCount(10_000);

function proxyConfig(id: string, maxConcurrency: number): ProxyConfig {
  return { id, url: `http://${id}.load.test:8080`, enabled: true, maxConcurrency, priority: 0, weight: 100, excludedProviderIds: [] };
}

function providerFailure(): { readonly statusCode: 503; readonly kind: "provider_unavailable"; readonly retryable: true; readonly routeScope: "provider"; readonly sanitizedMessage: string; readonly retryAt: string } {
  return {
    statusCode: 503,
    kind: "provider_unavailable",
    retryable: true,
    routeScope: "provider",
    sanitizedMessage: "synthetic provider failure",
    retryAt: new Date(Date.now() - 1).toISOString(),
  };
}

interface LoadProfileResult {
  readonly scenario: string;
  readonly users: number;
  readonly requests: number;
  readonly elapsedMs: number;
  readonly requestsPerSecond: number;
  readonly p95Ms: number;
  readonly errors: number;
  readonly proxySelections: number;
  readonly providerCalls: { readonly opencodeFree: number; readonly deepseek: number };
  readonly failovers: number;
  readonly inFlight: number;
  readonly activeProxySlots: number;
}

async function runLoadProfile(name: string, users: number, proxies: number, proxyConcurrency: number): Promise<LoadProfileResult> {
  const opencodeModel = "opencodeft-default";
  const deepseekModel = "deepseek-v4-flash";
  let opencodeCalls = 0;
  let deepseekCalls = 0;
  let failovers = 0;
  const opencodeBase = createBenchmarkAdapter("opencodeft", { modelId: opencodeModel, credentialKind: "none" });
  const deepseekBase = createBenchmarkAdapter("deepseek", { modelId: deepseekModel, credentialKind: "none" });
  const opencode = createBenchmarkAdapter("opencodeft", {
    modelId: opencodeModel,
    credentialKind: "none",
    call: async (input) => {
      opencodeCalls += 1;
      if (opencodeCalls % 17 === 0) throw providerFailure();
      return opencodeBase.call(input);
    },
  });
  const deepseek = createBenchmarkAdapter("deepseek", {
    modelId: deepseekModel,
    credentialKind: "none",
    call: async (input) => {
      deepseekCalls += 1;
      return deepseekBase.call(input);
    },
  });
  const base = createBenchmarkDependencies([opencode, deepseek], 2);
  const candidates = {
    opencode: createRouteCandidate("opencodeft", opencodeModel),
    deepseek: createRouteCandidate("deepseek", deepseekModel),
  };
  const resolveRoutes: ProxyRequestDependencies["resolveRoutes"] = async (request, affinity) => {
    const useDeepseek = request.model.startsWith("deepseek/");
    const primary = useDeepseek ? candidates.deepseek : candidates.opencode;
    const fallback = useDeepseek ? candidates.opencode : candidates.deepseek;
    return { affinity, candidates: [primary, fallback] };
  };

  const configs = Array.from({ length: proxies }, (_, index) => proxyConfig(`load-proxy-${index + 1}`, proxyConcurrency));
  const proxyStore = {
    async getProxy(id: string) { return configs.find((proxy) => proxy.id === id); },
    async listProxies() { return configs; },
  };
  const pool = new ProxyPool(proxyStore);
  const selector = new NetworkSelector(pool, new ProxyHealthManager(new MemoryProxyHealthStore()));
  let proxySelections = 0;
  const network = {
    select: async (input: Parameters<NetworkSelector["select"]>[0]) => {
      const result = await selector.select({ ...input, allowDirectFallback: false });
      if (result?.proxyId !== null && result?.proxyId !== undefined) proxySelections += 1;
      return result;
    },
  } as unknown as ProxyRequestDependencies["network"];
  const dependencies: ProxyRequestDependencies = { ...base, network, resolveRoutes, onRouteFailure: async () => { failovers += 1; } };
  const perUser = Math.max(1, Math.floor(REQUESTS / users));
  const requestCount = users * perUser;
  const durations: number[] = [];
  let errors = 0;
  const started = performance.now();

  await Promise.all(Array.from({ length: users }, async (_, userIndex) => {
    for (let sequence = 0; sequence < perUser; sequence += 1) {
      const requestStarted = performance.now();
      const useDeepseek = (userIndex + sequence) % 5 === 0;
      const model = useDeepseek ? `deepseek/${deepseekModel}` : `opencodeft/${opencodeModel}`;
      try {
        const response = await runProxyRequest(
          { ...benchmarkRequest({ model, messages: [{ role: "user", content: `load-user-${userIndex}` }] }), authorization: { apiKeyId: null, trustedIdentity: `load-user-${userIndex}` } },
          dependencies,
        );
        if (response.status !== 200) errors += 1;
      } catch {
        errors += 1;
      } finally {
        durations.push(performance.now() - requestStarted);
      }
    }
  }));

  const elapsedMs = performance.now() - started;
  const sorted = [...durations].sort((left, right) => left - right);
  const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const result: LoadProfileResult = {
    scenario: name,
    users,
    requests: requestCount,
    elapsedMs,
    requestsPerSecond: requestCount / Math.max(elapsedMs / 1_000, Number.EPSILON),
    p95Ms,
    errors,
    proxySelections,
    providerCalls: { opencodeFree: opencodeCalls, deepseek: deepseekCalls },
    failovers,
    inFlight: getInFlightCount(),
    activeProxySlots: configs.reduce((total, proxy) => total + pool.activeCount(proxy.id), 0),
  };
  console.log(JSON.stringify({ benchmark: result }));
  return result;
}

describe("production-scale synthetic load benchmarks", () => {
  test("handles 5k concurrent users across 100 proxies", async () => {
    const users = scaledCount(5_000);
    const result = await runLoadProfile("5k-users-100-proxies", users, 100, 64);
    expect(result.users).toBe(users);
    expect(result.requests).toBe(users * Math.max(1, Math.floor(REQUESTS / users)));
    expect(result.errors).toBe(0);
    expect(result.proxySelections).toBe(result.providerCalls.opencodeFree + result.providerCalls.deepseek);
    expect(result.proxySelections).toBeGreaterThanOrEqual(result.requests);
    expect(result.failovers).toBeGreaterThan(0);
    expect(result.inFlight).toBe(0);
    expect(result.activeProxySlots).toBe(0);
    expect(result.requestsPerSecond).toBeGreaterThan(0);
  });

  test("handles 100 users across 10 proxies with sustained request volume", async () => {
    const users = scaledCount(100);
    const result = await runLoadProfile("100-users-10-proxies", users, 10, 512);
    expect(result.users).toBe(users);
    expect(result.requests).toBe(users * Math.max(1, Math.floor(REQUESTS / users)));
    expect(result.errors).toBe(0);
    expect(result.proxySelections).toBe(result.providerCalls.opencodeFree + result.providerCalls.deepseek);
    expect(result.proxySelections).toBeGreaterThanOrEqual(result.requests);
    expect(result.failovers).toBeGreaterThan(0);
    expect(result.inFlight).toBe(0);
    expect(result.activeProxySlots).toBe(0);
    expect(result.requestsPerSecond).toBeGreaterThan(0);
  });
});
