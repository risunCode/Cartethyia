import { describe, expect, test } from "bun:test";
import type { ApiKeyPublic, ApiKeyRepository } from "../../src/storage";
import { ApiKeyAdmission } from "../../src/traffic/admission";
import { PerIpFlightTracker } from "../../src/traffic/per-ip";
import { runtimeMemoryLimits } from "../../src/traffic/limits";
import { isProtocolError, parseRequestBody, readBoundedJson } from "../../src/domain/protocols";
import { assertBenchmarkHealthy, measure, scaledConcurrency, scaledCount } from "./helpers";

const BODY_LIMIT = 64 * 1024;

function benchmarkKey(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "benchmark-key",
    name: "Benchmark key",
    keyPrefix: "bench",
    active: true,
    rateLimitRpm: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    oneTimeTokenLimit: null,
    oneTimeTokensUsed: 0,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: null,
    modelDenylist: null,
    lastUsedAt: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function admissionRepository(): ApiKeyRepository {
  return {
    sumOneTimeTokensUsed: () => 0,
    consumeOneTimeTokens: () => {},
  } as unknown as ApiKeyRepository;
}

function errorKind(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) return String(error.kind);
  return "unknown";
}

describe("defensive error-load benchmarks", () => {
  test("measures malformed and oversized body rejection throughput", async () => {
    const malformed = await measure("malformed-json-rejection", scaledCount(300), scaledConcurrency(32), async () => {
      const result = parseRequestBody("{ malformed", { maxBodyBytes: BODY_LIMIT, connectTimeoutMs: 100, firstByteTimeoutMs: 100, idleTimeoutMs: 100, totalTimeoutMs: 1_000 });
      if (!isProtocolError(result) || result.statusCode !== 400) throw new Error("malformed body was not rejected as a protocol error");
      return result.kind;
    });
    const oversizedText = "x".repeat(BODY_LIMIT + 1);
    const oversized = await measure("oversized-body-rejection", scaledCount(300), scaledConcurrency(32), async () => {
      const result = await readBoundedJson(new Request("http://benchmark.local", { method: "POST", body: oversizedText }), BODY_LIMIT);
      if (result.ok || result.reason !== "too_large") throw new Error("oversized body was not rejected at the body boundary");
      return result.reason;
    });

    assertBenchmarkHealthy(malformed.stats);
    assertBenchmarkHealthy(oversized.stats);
    expect(malformed.stats.errors).toBe(0);
    expect(oversized.stats.errors).toBe(0);
    expect(runtimeMemoryLimits.requestBodyBytes).toBeGreaterThanOrEqual(BODY_LIMIT);
  });

  test("measures API-key concurrency and RPM rejection under bounded pressure", async () => {
    const concurrencyAdmission = new ApiKeyAdmission(admissionRepository());
    const concurrencyKey = benchmarkKey({ maxConcurrentRequests: 4 });
    const concurrencyBurstSize = Math.max(5, scaledConcurrency(32));
    const concurrencyResult = await measure("api-key-concurrency-rejection", scaledCount(40), 1, async () => {
      const leases = [];
      let rejected = 0;
      const burstSize = concurrencyBurstSize;
      for (let index = 0; index < burstSize; index += 1) {
        try {
          leases.push(concurrencyAdmission.acquire(concurrencyKey, 8));
        } catch (error) {
          if (errorKind(error) !== "concurrency_exceeded") throw error;
          rejected += 1;
        }
      }
      for (const lease of leases) lease.release();
      return { accepted: leases.length, rejected };
    });

    const rpmAdmission = new ApiKeyAdmission(admissionRepository());
    const rpmKey = benchmarkKey({ id: "rpm-key", rateLimitRpm: 5 });
    const rpmResult = await measure("api-key-rpm-rejection", scaledCount(40), 1, async () => {
      try {
        const lease = rpmAdmission.acquire(rpmKey, 1);
        lease.release();
        return "accepted";
      } catch (error) {
        if (errorKind(error) !== "quota_exceeded") throw error;
        return "rejected";
      }
    });

    assertBenchmarkHealthy(concurrencyResult.stats);
    assertBenchmarkHealthy(rpmResult.stats);
    expect(concurrencyResult.values.every((value) => value.accepted === 4 && value.rejected === concurrencyBurstSize - 4)).toBe(true);
    expect(rpmResult.values.filter((value) => value === "accepted")).toHaveLength(5);
    expect(rpmResult.values.filter((value) => value === "rejected").length).toBe(rpmResult.stats.operations - 5);
  });

  test("measures per-IP flight rejection and leak-free recovery", async () => {
    const tracker = new PerIpFlightTracker();
    const burstSize = scaledCount(100);
    const result = await measure("per-ip-flight-rejection", scaledCount(20), 1, async () => {
      const handles = [];
      let rejected = 0;
      for (let index = 0; index < burstSize; index += 1) {
        const handle = tracker.tryAcquire("198.51.100.10", 8);
        if (handle === null) rejected += 1;
        else handles.push(handle);
      }
      for (const handle of handles) handle.release();
      if (handles.length !== 8 || rejected !== burstSize - 8 || tracker.size() !== 0) throw new Error("per-IP flight guard invariant failed");
      return { accepted: handles.length, rejected };
    });

    assertBenchmarkHealthy(result.stats);
    expect(result.values.every((value) => value.accepted === 8 && value.rejected === burstSize - 8)).toBe(true);
    expect(tracker.size()).toBe(0);
  });

  test("keeps an HTTP server responsive during bounded oversized-body bursts", async () => {
    const oversizedText = "x".repeat(BODY_LIMIT + 1);
    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const result = await readBoundedJson(request, BODY_LIMIT);
        if (!result.ok) return Response.json({ error: result.reason }, { status: result.reason === "too_large" ? 413 : 400 });
        return Response.json({ ok: true });
      },
    });

    try {
      const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
      const result = await measure("http-oversized-body-burst", scaledCount(200), scaledConcurrency(32), async () => {
        const response = await fetch(url, { method: "POST", body: oversizedText });
        await response.arrayBuffer();
        if (response.status !== 413) throw new Error(`expected 413, received ${response.status}`);
        return response.status;
      });
      const recovery = await fetch(url, { method: "POST", body: "{}" });
      await recovery.arrayBuffer();

      assertBenchmarkHealthy(result.stats);
      expect(result.stats.errors).toBe(0);
      expect(recovery.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});
