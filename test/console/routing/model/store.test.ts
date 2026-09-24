import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../../src/persistence/postgres";
import { dbDescribe } from "../../../helpers/db-gate";
import { tenants, providers, modelAliases, modelCombos, models } from "../../../../src/persistence/schema";
import { DrizzleModelRoutingStore } from "../../../../src/console/routing/model/store";
dbDescribe("DrizzleModelRoutingStore — real DB", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleModelRoutingStore;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const providerId = `model-routing-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleModelRoutingStore(db);
    await db
      .insert(tenants)
      .values([
        { id: tenantA, name: "model-routing-test-a", status: "active" },
        { id: tenantB, name: "model-routing-test-b", status: "active" },
      ])
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId: tenantA, enabled: true });
    await db.insert(models).values({
      providerId,
      modelId: "known-model",
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
  });

  afterAll(async () => {
    await db.delete(modelAliases).where(inArray(modelAliases.tenantId, [tenantA, tenantB]));
    await db.delete(modelCombos).where(inArray(modelCombos.tenantId, [tenantA, tenantB]));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });

  test("isKnownModel matches an enabled model for its owning tenant only", async () => {
    expect(await store.isKnownModel(tenantA, "known-model")).toBe(true);
    expect(await store.isKnownModel(tenantB, "known-model")).toBe(false);
    expect(await store.isKnownModel(tenantA, "missing-model")).toBe(false);
  });

  test("createAlias/listAliases is tenant-scoped", async () => {
    const created = await store.createAlias(tenantA, {
      alias: "fast",
      targetModel: "known-model",
    });
    expect(created.alias).toBe("fast");
    expect(created.tenantId).toBe(tenantA);
    const rowsA = await store.listAliases(tenantA);
    expect(rowsA.map((r) => r.alias)).toEqual(["fast"]);
    const rowsB = await store.listAliases(tenantB);
    expect(rowsB).toEqual([]);
  });

  test("createAlias rejects duplicate (tenant, alias) via unique index", async () => {
    await expect(
      store.createAlias(tenantA, { alias: "fast", targetModel: "known-model" }),
    ).rejects.toThrow();
  });

  test("updateAlias is tenant-scoped; returns undefined for wrong tenant", async () => {
    const [row] = await store.listAliases(tenantA);
    const wrongTenant = await store.updateAlias(tenantB, row!.id, { targetModel: "other" });
    expect(wrongTenant).toBeUndefined();
    const updated = await store.updateAlias(tenantA, row!.id, { targetModel: "known-model-2" });
    expect(updated?.targetModel).toBe("known-model-2");
  });

  test("deleteAlias is tenant-scoped and returns false for missing", async () => {
    const [row] = await store.listAliases(tenantA);
    expect(await store.deleteAlias(tenantB, row!.id)).toBe(false);
    expect(await store.deleteAlias(tenantA, row!.id)).toBe(true);
  });

  test("createCombo/listCombos is tenant-scoped", async () => {
    const created = await store.createCombo(tenantA, {
      name: "pool",
      members: ["a", "b"],
      strategy: "round_robin",
    });
    expect(created.members).toEqual(["a", "b"]);
    expect(created.strategy).toBe("round_robin");
    const rowsA = await store.listCombos(tenantA);
    expect(rowsA.map((r) => r.name)).toEqual(["pool"]);
    const rowsB = await store.listCombos(tenantB);
    expect(rowsB).toEqual([]);
  });

  test("createCombo defaults strategy to fallback when omitted", async () => {
    const created = await store.createCombo(tenantA, { name: "pool2", members: ["a"] });
    expect(created.strategy).toBe("fallback");
  });

  test("createCombo rejects duplicate (tenant, name) via unique index", async () => {
    await expect(store.createCombo(tenantA, { name: "pool", members: ["a"] })).rejects.toThrow();
  });

  test("updateCombo patches members/strategy; tenant-scoped", async () => {
    const rows = await store.listCombos(tenantA);
    const row = rows.find((r) => r.name === "pool");
    const wrongTenant = await store.updateCombo(tenantB, row!.id, { strategy: "fallback" });
    expect(wrongTenant).toBeUndefined();
    const updated = await store.updateCombo(tenantA, row!.id, { members: ["c", "d"] });
    expect(updated?.members).toEqual(["c", "d"]);
  });

  test("deleteCombo is tenant-scoped and returns false for missing", async () => {
    const rows = await store.listCombos(tenantA);
    const row = rows.find((r) => r.name === "pool");
    expect(await store.deleteCombo(tenantB, row!.id)).toBe(false);
    expect(await store.deleteCombo(tenantA, row!.id)).toBe(true);
  });

  test("cascade delete of tenant cascades model_aliases and model_combos rows", async () => {
    const tenantX = randomUUID();
    await db
      .insert(tenants)
      .values({ id: tenantX, name: "model-routing-cascade-test", status: "active" });
    await store.createAlias(tenantX, { alias: "gone", targetModel: "known-model" });
    await store.createCombo(tenantX, { name: "gone-combo", members: ["known-model"] });
    await db.delete(tenants).where(eq(tenants.id, tenantX));
    const remainingAliases = await db
      .select()
      .from(modelAliases)
      .where(eq(modelAliases.tenantId, tenantX));
    const remainingCombos = await db
      .select()
      .from(modelCombos)
      .where(eq(modelCombos.tenantId, tenantX));
    expect(remainingAliases).toEqual([]);
    expect(remainingCombos).toEqual([]);
  });
});
