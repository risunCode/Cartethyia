import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { eq } from "drizzle-orm";
import { tenants, telemetryEvents } from "../../../src/persistence/schema";
import { DrizzleObservabilityStore } from "../../../src/console/domains/stats/store";

dbDescribe("DrizzleObservabilityStore", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleObservabilityStore;
  const tenantId = randomUUID();
  const requestId = randomUUID();
  const cancelledRequestId = randomUUID();
  const unavailableRequestId = randomUUID();
  const internalErrorRequestId = randomUUID();
  const unauthorizedRequestId = randomUUID();

  const fakeRedis = {
    ping: async () => "PONG",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleObservabilityStore(db, fakeRedis);
    await db.insert(tenants).values({ id: tenantId, name: "stats-store-test", status: "active" }).onConflictDoNothing();
    await db.insert(telemetryEvents).values([
      {
        tenantId,
        requestId,
        sourceSurface: "chat",
        requestedModel: "test-model",
        providerId: "openai",
        status: "completed",
        httpStatus: 200,
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 120,
      },
      {
        tenantId,
        requestId: cancelledRequestId,
        sourceSurface: "chat",
        requestedModel: "test-model",
        providerId: "openai",
        status: "cancelled",
        httpStatus: 499,
      },
      {
        tenantId,
        requestId: unavailableRequestId,
        sourceSurface: "chat",
        requestedModel: "test-model",
        providerId: "openai",
        status: "failed",
        httpStatus: 503,
        errorCategory: "platform_unavailable",
      },
      // A genuine gateway defect. Present so the error count is pinned in both
      // directions: the 500 counts, the 503 and the 499 above do not.
      {
        tenantId,
        requestId: internalErrorRequestId,
        sourceSurface: "chat",
        requestedModel: "test-model",
        providerId: "openai",
        status: "failed",
        httpStatus: 500,
        errorCategory: "internal_error",
      },
      // The strongest inflation vector: a bogus API key costs the sender
      // nothing and reaches no provider, so a 401 must not raise the error
      // count. It was counted before the rule became a class rule.
      {
        tenantId,
        requestId: unauthorizedRequestId,
        sourceSurface: "chat",
        requestedModel: "test-model",
        providerId: "openai",
        status: "failed",
        httpStatus: 401,
        errorCategory: "invalid_request",
      },
    ]);
  });

  test("health reports healthy with live db and redis", async () => {
    const health = await store.health(tenantId);
    expect(health.database_healthy).toBe(true);
    expect(health.redis_healthy).toBe(true);
    expect(health.status).toBe("healthy");
    expect(health.request_count).toBeGreaterThanOrEqual(1);
  });

  test("health degrades when redis is down", async () => {
    const down = new DrizzleObservabilityStore(db, {
      ping: async () => {
        throw new Error("redis down");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const health = await down.health(tenantId);
    expect(health.redis_healthy).toBe(false);
    expect(health.status).toBe("degraded");
  });

  test("usage aggregates the seeded window", async () => {
    const summary = await store.usage(tenantId, "24h");
    expect(summary.requestsTotal).toBeGreaterThanOrEqual(1);
    expect(summary.tokensUsed).toBeGreaterThanOrEqual(150);
  });

  test("usage counts only gateway defects in requestsFailed", async () => {
    // The same rule as the summary's `errors`, on the `/system/usage` shape.
    // Of the five seeded rows only the 500 is a gateway defect; the 401, the
    // 404-style refusal, the 499 abort and the 503 capacity response are all
    // excluded. This field used to carry its own copy of the old predicate.
    const usage = await store.usage(tenantId, "24h");
    expect(usage.requestsTotal).toBe(5);
    expect(usage.requestsSucceeded).toBe(1);
    expect(usage.requestsFailed).toBe(1);
  });

  test("usageRequests lists the seeded event", async () => {
    const page = await store.usageRequests(tenantId, "24h", 10);
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    expect(page.items.some((i) => i.requestId === requestId)).toBe(true);
  });

  test("usageRequestDetail returns the event with proxy label", async () => {
    const detail = await store.usageRequestDetail(tenantId, requestId);
    expect(detail?.requestId).toBe(requestId);
    expect(detail?.providerId).toBe("openai");
    expect(detail?.proxy).toBe("direct");
  });

  test("usageSummary counts only gateway defects as errors", async () => {
    const summary = await store.usageSummary(tenantId, "24h");
    expect(summary.totals.requests).toBe(5);
    // Only the 500 is a gateway error. The 503 is the gateway correctly
    // refusing work (`platform_unavailable`, retryable), the 499 is a client
    // abort, and the 401 is a caller with a bad key — all recorded and shown,
    // none counted. Pinning this in both directions is what stops a caller from
    // inflating the error rate with 401s, 404 probes, or 503 capacity
    // responses, all of which are free to generate.
    expect(summary.totals.errors).toBe(1);
    expect(summary.totals.cancelled).toBe(1);
    expect(summary.totals.truncated).toBe(0);
    // Every status is still counted and still filterable, excluded or not.
    expect(summary.totals.statusCounts).toEqual([
      { status: 200, count: 1 },
      { status: 401, count: 1 },
      { status: 499, count: 1 },
      { status: 500, count: 1 },
      { status: 503, count: 1 },
    ]);
  });

  test("usageRequests filters by actual HTTP status", async () => {
    const page = await store.usageRequests(tenantId, "24h", 10, 503);
    expect(page.items.map((item) => item.requestId)).toEqual([unavailableRequestId]);
    expect(page.items[0]?.httpStatus).toBe(503);
  });

  test("usageBy groups by the requested dimension", async () => {
    const by = await store.usageBy(tenantId, "model", "24h");
    expect(by.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("usageChart buckets the window", async () => {
    const chart = await store.usageChart(tenantId, "24h");
    expect(Array.isArray(chart.buckets)).toBe(true);
  });

  test("usageSummary totals the window", async () => {
    const summary = await store.usageSummary(tenantId, "24h");
    expect(summary.totals.requests).toBeGreaterThanOrEqual(1);
  });

  test("usageCache reports hit rate shape", async () => {
    const cache = await store.usageCache(tenantId, "24h");
    expect(typeof cache.hitRate).toBe("number");
  });
  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });
});
