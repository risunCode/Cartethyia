import { beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { tenants } from "../../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../../src/console/providers/catalog/store";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";

function storeOptions() {
  return {
    telemetryBuffer: {} as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: createDefaultProviderRegistry(),
    outboundFetchFor: () => (async () => new Response("{}")) as never,
    snapshotInvalidator: { invalidate: async () => 0 },
  };
}

dbDescribe("DrizzleProviderCatalogStore CRUD", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantId = randomUUID();
  const providerId = `catalog-store-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db.insert(tenants).values({ id: tenantId, name: "catalog-store-test", status: "active" }).onConflictDoNothing();
  });

  test("create + get + list round-trips a BYOK provider", async () => {
    await store.create({
      providerId,
      tenantId,
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: false,
    });
    const got = await store.get(tenantId, providerId);
    expect(got?.providerId).toBe(providerId);
    const listed = await store.list(tenantId);
    expect(listed.some((p) => p.providerId === providerId)).toBe(true);
  });

  test("create rejects a builtin id", async () => {
    await expect(
      store.create({
        providerId: "openai",
        tenantId,
        enabled: true,
        isBuiltIn: true,
        requiresAccount: true,
        supportsModelDiscovery: false,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "provider_is_builtin" }));
  });

  test("update toggles enabled and delete removes the row", async () => {
    const id = `catalog-upd-${randomUUID().slice(0, 8)}`;
    await store.create({
      providerId: id,
      tenantId,
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: false,
    });
    const updated = await store.update(tenantId, id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(await store.delete(tenantId, id)).toBe(true);
    expect(await store.get(tenantId, id)).toBeUndefined();
    expect(await store.delete(tenantId, id)).toBe(false);
  });

  test("account lifecycle: create, list, update, health events", async () => {
    const created = await store.createAccount(tenantId, providerId, {
      label: "acct-1",
      secret: "sk-test-secret",
      credentialKind: "api_key",
    });
    expect(created.id).toBeTruthy();
    const accounts = await store.listAccounts(tenantId, providerId);
    expect(accounts.some((a) => a.id === created.id)).toBe(true);
    const all = await store.listAllAccounts(tenantId);
    expect(all.some((a) => a.id === created.id)).toBe(true);
    const events = await store.listAccountHealthEvents(tenantId, providerId, created.id);
    expect(Array.isArray(events)).toBe(true);
  });

  test("model rows: register, list, enable toggle, delete", async () => {
    await store.registerModels(tenantId, providerId, ["test-model-1"], "chat");
    const models = await store.listModels(tenantId, providerId);
    expect(models.some((m) => m.modelId === "test-model-1")).toBe(true);
    const route = models.find((m) => m.modelId === "test-model-1")?.route ?? "";
    await store.setModelEnabled(tenantId, providerId, {
      modelId: "test-model-1",
      route,
      enabled: false,
    });
    await store.deleteModel(tenantId, providerId, { modelId: "test-model-1", route, enabled: false });
    const after = await store.listModels(tenantId, providerId);
    expect(after.some((m) => m.modelId === "test-model-1")).toBe(false);
  });

  test("tenant scoping: another tenant cannot see the row", async () => {
    expect(await store.get(randomUUID(), providerId)).toBeUndefined();
  });
});

dbDescribe("DrizzleProviderCatalogStore account mutations", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantId = randomUUID();
  const providerId = `catalog-acct-${randomUUID().slice(0, 8)}`;
  let accountId: string;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db.insert(tenants).values({ id: tenantId, name: "catalog-acct-test", status: "active" }).onConflictDoNothing();
    await store.create({
      providerId,
      tenantId,
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: false,
    });
    const created = await store.createAccount(tenantId, providerId, {
      label: "acct-mut",
      secret: "sk-mut-secret",
      credentialKind: "api_key",
    });
    accountId = created.id;
  });

  test("updateAccount changes the label", async () => {
    const updated = await store.updateAccount(tenantId, providerId, accountId, { label: "renamed" });
    expect(updated?.label).toBe("renamed");
    expect(await store.updateAccount(tenantId, providerId, randomUUID(), { label: "x" })).toBeUndefined();
  });

  test("listAccountHealthEvents returns an array", async () => {
    expect(await store.listAccountHealthEvents(tenantId, providerId, accountId)).toEqual([]);
  });

  test("recoverAccount flips a disabled account back", async () => {
    await store.updateAccount(tenantId, providerId, accountId, { status: "disabled" } as never);
    expect(await store.recoverAccount(tenantId, providerId, accountId)).toBe(true);
    expect(await store.recoverAccount(tenantId, providerId, randomUUID())).toBe(false);
  });
});
