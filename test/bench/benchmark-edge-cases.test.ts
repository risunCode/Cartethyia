import { describe, expect, test } from "bun:test";
import type { ProviderCallError } from "../../src/domain/contracts";
import type { ProxyConfig } from "../../src/traffic/network";
import { getInFlightCount } from "../../src/traffic/in-flight";
import { NetworkSelector, ProxyHealthManager, ProxyPool } from "../../src/traffic";
import { MemoryProxyHealthStore } from "../traffic/helpers";
import { runProxyRequest } from "../../src/app/request";
import {
  BENCH_LIMITS,
  benchmarkRequest,
  createBenchmarkAdapter,
  createBenchmarkDependencies,
  DIRECT_NETWORK,
  measure,
  scaledConcurrency,
  scaledCount,
  assertBenchmarkHealthy,
} from "./helpers";

function proxyConfig(id: string, maxConcurrency: number): ProxyConfig {
  return { id, url: `http://${id}.example.test:8080`, enabled: true, maxConcurrency, priority: 0, weight: 100, excludedProviderIds: [] };
}

function assertStatus(status: number, expected: number): number {
  if (status !== expected) throw new Error(`expected HTTP ${expected}, received ${status}`);
  return status;
}

describe("benchmark edge cases", () => {
  test("measures in-process pipeline speed without request errors", async () => {
    const adapter = createBenchmarkAdapter("benchmark-speed");
    const dependencies = createBenchmarkDependencies([adapter]);
    const result = await measure("pipeline-speed", scaledCount(250), scaledConcurrency(32), async () => {
      const response = await runProxyRequest(benchmarkRequest(), dependencies);
      return assertStatus(response.status, 200);
    });

    assertBenchmarkHealthy(result.stats);
    expect(result.stats.p95Ms).toBeGreaterThanOrEqual(0);
    expect(result.stats.errors).toBe(0);
  });

  test("measures HTTP server throughput and keeps bounded responses successful", async () => {
    const adapter = createBenchmarkAdapter("benchmark-http");
    const dependencies = createBenchmarkDependencies([adapter]);
    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        const body: unknown = await request.json();
        const response = await runProxyRequest({ ...benchmarkRequest(), request: { ...benchmarkRequest().request, body } }, dependencies);
        if (response.body.mode !== "json") return new Response("unexpected stream", { status: 500 });
        return Response.json(response.body.value, { status: response.status });
      },
    });

    try {
      const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
      const result = await measure("server-http-speed", scaledCount(150), scaledConcurrency(24), async () => {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "bench-model", messages: [{ role: "user", content: "ping" }] }) });
        await response.arrayBuffer();
        return assertStatus(response.status, 200);
      });
      assertBenchmarkHealthy(result.stats);
      expect(result.stats.errors).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("measures stability across valid and malformed request bursts", async () => {
    let providerCalls = 0;
    const adapter = createBenchmarkAdapter("benchmark-stability", { call: async (input) => { providerCalls += 1; return createBenchmarkAdapter("response").call(input); } });
    const dependencies = createBenchmarkDependencies([adapter]);
    const operations = scaledCount(300);
    const result = await measure("pipeline-stability", operations, scaledConcurrency(32), async (index) => {
      const base = benchmarkRequest();
      const request = index % 7 === 0
        ? { ...base, request: { ...base.request, body: "{ malformed" } }
        : base;
      const response = await runProxyRequest(request, dependencies);
      return assertStatus(response.status, index % 7 === 0 ? 400 : 200);
    });

    assertBenchmarkHealthy(result.stats);
    expect(providerCalls).toBe(operations - Math.ceil(operations / 7));
    expect(getInFlightCount()).toBe(0);
  });

  test("measures proxy slot balancing and proxy-only capacity behavior", async () => {
    const configs = ["proxy-a", "proxy-b", "proxy-c"].map((id) => proxyConfig(id, 4));
    const store = {
      async getProxy(id: string) { return configs.find((proxy) => proxy.id === id); },
      async listProxies() { return configs; },
    };
    const selector = new NetworkSelector(new ProxyPool(store), new ProxyHealthManager(new MemoryProxyHealthStore()));
    const batches = scaledCount(24);
    const capacity = configs.length * 4;
    const result = await measure("proxy-slot-balance", batches, 1, async () => {
      const selections = await Promise.all(Array.from({ length: capacity }, () => selector.select({ providerId: "benchmark", allowDirectFallback: false })));
      if (selections.some((selection) => selection === null)) throw new Error("proxy-only selection exhausted capacity unexpectedly");
      const concrete = selections.filter((selection): selection is NonNullable<typeof selection> => selection !== null);
      const ids = concrete.map((selection) => selection.proxyId);
      await Promise.all(concrete.map((selection) => selection.selection.release()));
      return ids;
    });

    assertBenchmarkHealthy(result.stats);
    const distribution = new Set(result.values.flat());
    expect(distribution).toEqual(new Set(configs.map((config) => config.id)));
  });

  test("measures provider failover and cleanup under repeated primary failures", async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const failure: ProviderCallError = {
      statusCode: 503,
      kind: "provider_unavailable",
      retryable: true,
      routeScope: "provider",
      source: "internal",
      sanitizedMessage: "benchmark primary unavailable",
      retryAt: new Date(Date.now() - 1).toISOString(),
    };
    const primary = createBenchmarkAdapter("benchmark-primary", { call: async () => { primaryCalls += 1; throw failure; } });
    const secondary = createBenchmarkAdapter("benchmark-secondary", { call: async (input) => { secondaryCalls += 1; return createBenchmarkAdapter("secondary-response").call(input); } });
    const dependencies = createBenchmarkDependencies([primary, secondary], 2);
    const operations = scaledCount(100);
    const result = await measure("provider-failover", operations, scaledConcurrency(16), async () => {
      const response = await runProxyRequest(benchmarkRequest(), dependencies);
      return assertStatus(response.status, 200);
    });

    assertBenchmarkHealthy(result.stats);
    expect(primaryCalls).toBe(operations);
    expect(secondaryCalls).toBe(operations);
    expect(getInFlightCount()).toBe(0);
    expect(DIRECT_NETWORK.proxyId).toBeNull();
    expect(BENCH_LIMITS.totalTimeoutMs).toBe(1_000);
  });
});
