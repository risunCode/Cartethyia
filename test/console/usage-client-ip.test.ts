import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../src/persistence/postgres";
import { consoleSettings, telemetryEvents, tenants } from "../../src/persistence/schema";
import { dbDescribe } from "../helpers/db-gate";
import { DrizzleObservabilityStore } from "../../src/console/domains/stats/store";

/**
 * The `client_ip` breakdown dimension groups telemetry by stored address and
 * masks it on read, using the same fail-closed gate as the request list
 * (`privacyMode !== "full"` means masked). Storage keeps the raw value.
 */
dbDescribe("usageBy client_ip — real DB", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleObservabilityStore;
  const tenantId = randomUUID();
  const fullTenantId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    // The store takes a Redis client too; `usageBy` never reads it, and
    // `undefined` keeps this suite independent of a running Redis.
    store = new DrizzleObservabilityStore(db, undefined as never);
    await db
      .insert(tenants)
      .values([
        { id: tenantId, name: `ip-test-${tenantId.slice(0, 8)}`, status: "active" },
        { id: fullTenantId, name: `ip-full-${fullTenantId.slice(0, 8)}`, status: "active" },
      ])
      .onConflictDoNothing();
    // The masking gate reads `privacyMode`; "full" opts into raw display.
    await db
      .insert(consoleSettings)
      .values({ tenantId: fullTenantId, preferences: { privacyMode: "full" } })
      .onConflictDoNothing();

    const now = new Date();
    const event = (over: {
      tenantId: string;
      clientIp: string | null;
      status: "completed" | "failed";
      inputTokens?: number;
      outputTokens?: number;
    }) => ({
      id: randomUUID(),
      tenantId: over.tenantId,
      requestId: randomUUID(),
      createdAt: now,
      requestedModel: "m",
      providerId: "p",
      clientIp: over.clientIp,
      userAgent: "test-agent",
      status: over.status,
      inputTokens: over.inputTokens ?? 10,
      outputTokens: over.outputTokens ?? 5,
    });
    await db.insert(telemetryEvents).values([
      // Same host, one success + one failure: must group into one row.
      event({ tenantId, clientIp: "203.0.113.7", status: "completed" }),
      event({ tenantId, clientIp: "203.0.113.7", status: "failed" }),
      // A second host whose masked form collides with the first.
      event({ tenantId, clientIp: "203.0.113.9", status: "completed" }),
      // No address at all: excluded by the not-null / not-empty filter.
      event({ tenantId, clientIp: null, status: "completed" }),
      event({ tenantId: fullTenantId, clientIp: "198.51.100.4", status: "completed" }),
    ]);
  });

  afterAll(async () => {
    await db.delete(telemetryEvents).where(inArray(telemetryEvents.tenantId, [tenantId, fullTenantId]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, fullTenantId]));
  });

  test("groups by address and reports hits, failures, and tokens", async () => {
    const { rows } = await store.usageBy(tenantId, "client_ip", "24h");
    // One merged row: both .7 and .9 mask to the same name, so their counts
    // must be combined rather than shown as two indistinguishable rows.
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.name).toBe("203.0.113.xxx");
    expect(row!.requests).toBe(3);
    expect(row!.errors).toBe(1);
    expect(row!.total).toBe(45);
  });

  test("masks by default and never returns the raw address", async () => {
    const { rows } = await store.usageBy(tenantId, "client_ip", "24h");
    for (const row of rows) expect(row.name).not.toContain(".7");
    expect(rows[0]!.name).toBe("203.0.113.xxx");
  });

  test("returns the raw address only when privacyMode is full", async () => {
    const { rows } = await store.usageBy(fullTenantId, "client_ip", "24h");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("198.51.100.4");
  });
});
