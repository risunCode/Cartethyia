import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createPerformanceRoutes } from "../../../../src/console/domains/performance/routes";
import {
  resetPerformanceMetricsForTesting,
  trackAdapterLoad,
  trackMemoryUsage,
  trackModelCatalogLoad,
  trackNetworkCall,
} from "../../../../src/observability/performance-metrics";
import type { AccessDecision } from "../../../../src/security/access-control";

const adminAccess: AccessDecision = {
  id: "session-admin",
  tenantId: "tenant-1",
  scopes: ["platform:admin"],
  admissionIdentity: "admin@example.test",
};

const tenantAccess: AccessDecision = {
  id: "session-reader",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
  admissionIdentity: "reader@example.test",
};

function buildApp(access: AccessDecision | undefined): Elysia {
  return new Elysia().use(createPerformanceRoutes({ accessResolver: () => access }));
}

afterEach(() => {
  resetPerformanceMetricsForTesting();
});

describe("performance domain contract", () => {
  test("rejects unauthenticated requests with 401", async () => {
    const response = await buildApp(undefined).handle(
      new Request("http://localhost/system/performance"),
    );
    expect(response.status).toBe(401);
  });

  test("rejects callers without platform:admin scope", async () => {
    const response = await buildApp(tenantAccess).handle(
      new Request("http://localhost/system/performance"),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("insufficient_scope");
  });

  test("returns the recorded series for a platform admin", async () => {
    trackAdapterLoad("perf-route-adapter", 11);
    trackModelCatalogLoad("perf-route-catalog", 2);
    trackNetworkCall("perf-route.example.test", 42);
    trackMemoryUsage("perf-route-heap", 2048);

    const response = await buildApp(adminAccess).handle(
      new Request("http://localhost/system/performance"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      adapter_load_ms: Record<string, number>;
      model_catalog_load_ms: Record<string, number>;
      network_call_latency_ms: Record<string, number>;
      memory_bytes: Record<string, number>;
    };
    // The registry is process-global, so assert containment rather than exact equality.
    expect(body.adapter_load_ms["perf-route-adapter"]).toBe(11);
    expect(body.model_catalog_load_ms["perf-route-catalog"]).toBe(2);
    expect(body.network_call_latency_ms["perf-route.example.test"]).toBe(42);
    expect(body.memory_bytes["perf-route-heap"]).toBe(2048);
  });
});
