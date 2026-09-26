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

dbDescribe("DrizzleNetworkPoolStore — routing strategy", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleNetworkPoolStore;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleNetworkPoolStore(db);
    await db
      .insert(tenants)
      .values([
        { id: tenantId, name: "pool-strategy-test", status: "active" },
        { id: otherTenantId, name: "pool-strategy-other", status: "active" },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    // `pool_routing_settings` cascades from `tenants`.
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
  });

  test("a tenant with no settings row gets the documented default", async () => {
    const setting = await store.getStrategy(tenantId);
    expect(setting).toEqual({ strategy: "least_loaded", rotateCount: 1 });
  });

  test("setStrategy upserts and getStrategy reads it back", async () => {
    const stored = await store.setStrategy(tenantId, {
      strategy: "round_robin",
      rotateCount: 5,
    });
    expect(stored).toEqual({ strategy: "round_robin", rotateCount: 5 });
    expect(await store.getStrategy(tenantId)).toEqual({
      strategy: "round_robin",
      rotateCount: 5,
    });
  });

  test("setStrategy replaces the previous value rather than adding a row", async () => {
    await store.setStrategy(tenantId, { strategy: "least_loaded", rotateCount: 2 });
    expect(await store.getStrategy(tenantId)).toEqual({
      strategy: "least_loaded",
      rotateCount: 2,
    });
  });

  test("one tenant's strategy does not leak to another", async () => {
    await store.setStrategy(tenantId, { strategy: "round_robin", rotateCount: 9 });
    // The other tenant never configured anything, so it still reads the default.
    expect(await store.getStrategy(otherTenantId)).toEqual({
      strategy: "least_loaded",
      rotateCount: 1,
    });
  });
});

dbDescribe("DrizzleNetworkPoolStore — tenant-scoped reads", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleNetworkPoolStore;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const poolId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleNetworkPoolStore(db);
    await db
      .insert(tenants)
      .values([
        { id: tenantId, name: "pool-read-test", status: "active" },
        { id: otherTenantId, name: "pool-read-other", status: "active" },
      ])
      .onConflictDoNothing();
    await store.create({
      id: poolId,
      tenantId,
      kind: "http",
      endpoint: "http://proxy-read.example.com:8080",
      maxInflight: 4,
      weight: 50,
      status: "active",
      inflight: 0,
      consecutiveFailures: 0,
      createdAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await db.delete(networkPools).where(eq(networkPools.id, poolId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
  });

  test("get returns the owning tenant's pool and nothing for another tenant", async () => {
    const owned = await store.get(tenantId, poolId);
    expect(owned?.id).toBe(poolId);
    expect(owned?.weight).toBe(50);
    expect(await store.get(otherTenantId, poolId)).toBeUndefined();
    expect(await store.get(tenantId, randomUUID())).toBeUndefined();
  });

  test("recover against another tenant's pool fails without touching it", async () => {
    expect(await store.recover(otherTenantId, poolId)).toBe(false);
    const unchanged = await store.get(tenantId, poolId);
    expect(unchanged?.status).toBe("active");
  });

  test("listHealthEvents is empty for a pool that has never transitioned", async () => {
    expect(await store.listHealthEvents(tenantId, poolId)).toEqual([]);
  });

  test("listHealthEvents does not expose another tenant's events", async () => {
    expect(await store.listHealthEvents(otherTenantId, poolId)).toEqual([]);
  });
});
