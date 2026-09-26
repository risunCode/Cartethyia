import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../../src/persistence/postgres";
import { healthEvents, networkPools, tenants } from "../../src/persistence/schema";
import {
  disablePoolForProxyHttpStatus,
  listNetworkPoolHealthEvents,
  recordPoolDispatchOutcome,
  recoverNetworkPool,
} from "../../src/network/pool-health-machine";
import { dbDescribe } from "../helpers/db-gate";

dbDescribe("network pool health machine", () => {
  const tenantId = randomUUID();
  const poolId = randomUUID();

  beforeAll(async () => {
    const db = getDb();
    await db.insert(tenants).values({ id: tenantId, name: "pool-health-machine-test", status: "active" });
    await db.insert(networkPools).values({
      id: poolId,
      tenantId,
      kind: "http",
      endpointConfig: { endpoint: "https://pool-health.example:443" },
      status: "active",
    });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(healthEvents).where(eq(healthEvents.networkPoolId, poolId));
    await db.delete(networkPools).where(eq(networkPools.id, poolId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("flags a failed proxy tunnel, recovers on success, and journals both transitions", async () => {
    const db = getDb();
    await recordPoolDispatchOutcome(db, poolId, {
      succeeded: false,
      error: new Error("proxy connection refused"),
      errorOrigin: "network",
    });
    let row = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0];
    expect(row).toMatchObject({
      status: "cooldown",
      consecutiveFailures: 1,
      lastErrorCategory: "proxy_unreachable",
    });
    expect(row?.cooldownUntil?.getTime()).toBeGreaterThan(Date.now());

    await recordPoolDispatchOutcome(db, poolId, { succeeded: true });
    row = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0];
    expect(row).toMatchObject({
      status: "active",
      consecutiveFailures: 0,
      lastError: null,
      lastErrorCategory: null,
    });
    const events = await listNetworkPoolHealthEvents(db, tenantId, poolId);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      fromStatus: "active",
      toStatus: "cooldown",
      errorCategory: "proxy_unreachable",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      fromStatus: "cooldown",
      toStatus: "active",
      errorCategory: null,
    }));
  });

  test("402 and 407 disable a reachable proxy and record exact response reasons", async () => {
    const db = getDb();
    const disabledPoolId = randomUUID();
    await db.insert(networkPools).values({
      id: disabledPoolId,
      tenantId,
      kind: "http",
      endpointConfig: { endpoint: "https://proxy-response.example:443" },
      status: "active",
    });
    let invalidations = 0;
    try {
      for (const [statusCode, category] of [
        [402, "proxy_payment_required"],
        [407, "proxy_auth_required"],
      ] as const) {
        if (statusCode === 407) {
          await db.update(networkPools).set({
            status: "active",
            lastError: null,
            lastErrorCategory: null,
            lastErrorAt: null,
          }).where(eq(networkPools.id, disabledPoolId));
        }
        expect(
          await disablePoolForProxyHttpStatus(db, disabledPoolId, statusCode, {
            invalidate: () => {
              invalidations += 1;
            },
          }),
        ).toBe(true);
        const row = (await db.select().from(networkPools).where(eq(networkPools.id, disabledPoolId)))[0];
        expect(row).toMatchObject({
          status: "disabled",
          lastErrorCategory: category,
          lastError: expect.stringContaining(`HTTP ${statusCode}`),
        });
      }
      const events = await listNetworkPoolHealthEvents(db, tenantId, disabledPoolId);
      expect(events.map((event) => event.errorCategory).sort()).toEqual([
        "proxy_auth_required",
        "proxy_payment_required",
      ]);
      expect(invalidations).toBe(2);
    } finally {
      await db.delete(healthEvents).where(eq(healthEvents.networkPoolId, disabledPoolId));
      await db.delete(networkPools).where(eq(networkPools.id, disabledPoolId));
    }
  });

  test("operator recovery restores an auto-flagged pool and records the action", async () => {
    const db = getDb();
    await recordPoolDispatchOutcome(db, poolId, {
      succeeded: false,
      error: new Error("proxy down"),
      errorOrigin: "network",
    });
    expect(await recoverNetworkPool(db, tenantId, poolId)).toBe(true);
    const row = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0];
    expect(row).toMatchObject({ status: "active", consecutiveFailures: 0, cooldownUntil: null });
  });
});
