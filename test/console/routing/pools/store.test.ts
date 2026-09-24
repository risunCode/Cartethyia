import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../../src/persistence/postgres";
import { dbDescribe } from "../../../helpers/db-gate";
import { tenants, networkPools } from "../../../../src/persistence/schema";
import { DrizzleNetworkPoolStore } from "../../../../src/console/routing/pools/store";

dbDescribe("DrizzleNetworkPoolStore — tenant isolation", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleNetworkPoolStore;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let poolId: string;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleNetworkPoolStore(db);
    await db.insert(tenants)
      .values([
        { id: tenantA, name: "network-store-test-a", status: "active" },
        { id: tenantB, name: "network-store-test-b", status: "active" },
      ])
      .onConflictDoNothing();
    poolId = randomUUID();
    await store.create({
      id: poolId,
      tenantId: tenantA,
      kind: "http",
      endpoint: "http://proxy.example.com:8080",
      maxInflight: 8,
      weight: 100,
      status: "active",
      inflight: 0,
      consecutiveFailures: 0,
      createdAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await db.delete(networkPools).where(eq(networkPools.id, poolId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });

  test("list only returns the owning tenant's pools", async () => {
    const ownerList = await store.list(tenantA);
    expect(ownerList.map((pool) => pool.id)).toContain(poolId);
    const otherList = await store.list(tenantB);
    expect(otherList.map((pool) => pool.id)).not.toContain(poolId);
  });

  test("lists pools in persisted creation order with id tie-breaker", async () => {
    const secondId = randomUUID();
    await store.create({
      id: secondId,
      tenantId: tenantA,
      kind: "http",
      endpoint: "http://proxy-second.example.com:8080",
      maxInflight: 8,
      weight: 100,
      status: "active",
      inflight: 0,
      consecutiveFailures: 0,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    try {
      const listed = await store.list(tenantA);
      expect(listed.map((pool) => pool.id)).toEqual([poolId, secondId]);
    } finally {
      await db.delete(networkPools).where(eq(networkPools.id, secondId));
    }
  });


  test("update against another tenant's pool is a no-op", async () => {
    const result = await store.update(tenantB, poolId, { weight: 50 });
    expect(result).toBeUndefined();
    const unchanged = await store.get(tenantA, poolId);
    expect(unchanged?.weight).toBe(100);
  });

  test("delete against another tenant's pool fails and leaves it intact", async () => {
    expect(await store.delete(tenantB, poolId)).toBe(false);
    expect(await store.get(tenantA, poolId)).toBeDefined();
  });
});
