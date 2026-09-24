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

  test("usageSummary separates 499 cancellations from errors and counts wire statuses", async () => {
    const summary = await store.usageSummary(tenantId, "24h");
    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.errors).toBe(1);
    expect(summary.totals.cancelled).toBe(1);
    expect(summary.totals.truncated).toBe(0);
    expect(summary.totals.statusCounts).toEqual([
      { status: 200, count: 1 },
      { status: 499, count: 1 },
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
