import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { tenants, providers, healthEvents, providerAccounts, providerRoutingSettings } from "../../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../../src/console/providers/catalog/store";
import { DrizzleProviderDetailStore } from "../../../src/console/providers/detail/store";
import { CLINE_MODELS } from "../../../src/providers/integrations/cline/cline";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
function storeOptions() {
  return {
    telemetryBuffer: {} as never,
    bundledModelCatalog: {
      modelsByProvider: new Map([["cline", CLINE_MODELS]]),
    },
    providerRegistry: createDefaultProviderRegistry(),
    outboundFetchFor: () => (async () => new Response("{}")) as never,
    snapshotInvalidator: { invalidate: async () => 0 },
  };
}
describe("provider-catalog.test.ts", () => {
dbDescribe("DrizzleProviderCatalogStore — account ownership boundary", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const providerId = `provider-catalog-store-test-${randomUUID().slice(0, 8)}`;
  let accountId: string;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db
      .insert(tenants)
      .values([
        { id: tenantA, name: "provider-catalog-store-test-a", status: "active" },
        { id: tenantB, name: "provider-catalog-store-test-b", status: "active" },
      ])
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId: tenantA, enabled: true });
    const created = await store.createAccount(tenantA, providerId, {
      label: "tenant-a-account",
      secret: "sk-test-secret",
      credentialKind: "api_key",
    });
    accountId = created.id;
  });

  afterAll(async () => {
    await db.delete(healthEvents).where(eq(healthEvents.accountId, accountId));
    await db.delete(providerAccounts).where(eq(providerAccounts.id, accountId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });

  test("rejects duplicate API-key credentials with a stable domain conflict", async () => {
    await expect(
      store.createAccount(tenantA, providerId, {
        label: "duplicate",
        secret: "sk-test-secret",
        credentialKind: "api_key",
      }),
    ).rejects.toMatchObject({
      code: "provider_account_duplicate",
      status: 409,
    });

    const [row] = await db
      .select({ credentialFingerprint: providerAccounts.credentialFingerprint })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    expect(row?.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.credentialFingerprint).not.toBe("sk-test-secret");
  });

  test("lists accounts in creation order with id as the stable tie-breaker", async () => {
    const second = await store.createAccount(tenantA, providerId, {
      label: "created-second",
      secret: "sk-second-secret",
      credentialKind: "api_key",
    });
    try {
      const listed = await store.listAccounts(tenantA, providerId);
      expect(listed.map((account) => account.id)).toEqual([accountId, second.id]);
    } finally {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, second.id));
    }
  });


  test("updateAccount from the owning tenant succeeds", async () => {
    const result = await store.updateAccount(tenantA, providerId, accountId, {
      label: "renamed",
    });
    expect(result?.label).toBe("renamed");
  });

  test("enabling an account or replacing its secret clears the recorded failure", async () => {
    // `auth_invalidated` excludes an account from the quota sweep, so a stale
    // mark outlives the condition it described: a re-authed account would never
    // be probed again. Replacing the credential or re-enabling the account is
    // the operator asserting it should work, so the failure state resets.
    await db
      .update(providerAccounts)
      .set({
        status: "disabled",
        consecutiveFailures: 2,
        cooldownUntil: new Date(Date.now() + 60_000),
        modelCooldowns: { "gpt-5": new Date(Date.now() + 60_000).toISOString() },
        lastError: "Provider credential rejected",
        lastErrorCategory: "auth_invalidated",
        lastErrorAt: new Date(),
      })
      .where(eq(providerAccounts.id, accountId));

    const result = await store.updateAccount(tenantA, providerId, accountId, {
      secret: "sk-fresh-secret",
    });
    expect(result).toBeDefined();

    const [row] = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    expect(row?.lastErrorCategory).toBeNull();
    expect(row?.lastError).toBeNull();
    expect(row?.lastErrorAt).toBeNull();
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.cooldownUntil).toBeNull();
    expect(row?.modelCooldowns).toEqual({});
  });

  test("a label-only update leaves the recorded failure intact", async () => {
    // Renaming says nothing about the credential, so it must not silently
    // un-park an account the health machine disabled.
    await db
      .update(providerAccounts)
      .set({ status: "disabled", lastErrorCategory: "auth_invalidated" })
      .where(eq(providerAccounts.id, accountId));

    await store.updateAccount(tenantA, providerId, accountId, { label: "still-disabled" });

    const [row] = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    expect(row?.status).toBe("disabled");
    expect(row?.lastErrorCategory).toBe("auth_invalidated");
  });

  test("listAccountHealthEvents from another tenant returns nothing", async () => {
    const events = await store.listAccountHealthEvents(tenantB, providerId, accountId);
    expect(events).toEqual([]);
  });

  test("recoverAccount from another tenant fails and never touches the real account", async () => {
    // Force the account into a state recovery would visibly change.
    await db
      .update(providerAccounts)
      .set({ status: "cooldown", consecutiveFailures: 3 })
      .where(eq(providerAccounts.id, accountId));

    const recoveredByOther = await store.recoverAccount(tenantB, providerId, accountId);
    expect(recoveredByOther).toBe(false);

    const stillCoolingDown = await store.listAccounts(tenantA, providerId);
    expect(stillCoolingDown.find((a) => a.id === accountId)?.status).toBe("cooldown");
  });

  test("recoverAccount from the owning tenant succeeds and is visible via health events", async () => {
    const recovered = await store.recoverAccount(tenantA, providerId, accountId);
    expect(recovered).toBe(true);

    const events = await store.listAccountHealthEvents(tenantA, providerId, accountId);
    expect(events.some((event) => event.toStatus === "active")).toBe(true);
  });

});
});

describe("provider-detail.test.ts", () => {
dbDescribe("DrizzleProviderDetailStore — global routing upsert", () => {
  // The global routing row is guarded by a *partial* unique index
  // (`WHERE tenant_id IS NULL`). An `onConflictDoUpdate` target of
  // `(provider_id)` alone cannot match a partial index, so Postgres rejects the
  // statement with `42P10` and every global routing write failed. The target
  // must carry `targetWhere` naming the predicate; this asserts the write
  // succeeds and that a second call updates rather than inserting a duplicate.
  let db: CartethyiaDatabase;
  let store: DrizzleProviderDetailStore;
  const tenantId = randomUUID();
  const providerId = `detail-global-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderDetailStore(db);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "detail-global-test", status: "active" })
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId, enabled: true });
  });

  afterAll(async () => {
    await db.delete(providerRoutingSettings).where(eq(providerRoutingSettings.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("upserts the global (tenant-less) routing row twice without a 42P10", async () => {
    const first = await store.updateRouting(providerId, null, {
      enabled: true,
      strategy: "round_robin",
    });
    expect(first.tenantId).toBeNull();
    expect(first.strategy).toBe("round_robin");

    // The second write is the one that used to fail: it must update in place.
    const second = await store.updateRouting(providerId, null, { enabled: false });
    expect(second.enabled).toBe(false);
    // Still one row — a failed conflict target would have thrown, and a
    // mismatched one would have inserted a second global row.
    expect(second.strategy).toBe("round_robin");

    const rows = await db
      .select()
      .from(providerRoutingSettings)
      .where(eq(providerRoutingSettings.providerId, providerId));
    expect(rows).toHaveLength(1);
  });
});

/**
 * Minimal Drizzle-compatible query builder stub covering the exact call
 * shapes used by DrizzleProviderDetailStore: select → where → limit, and
 * update → set → where → returning, plus insert → values → returning.
 */
function makeDb() {
  const rows: Array<{
    providerId: string;
    tenantId: string | null;
    strategy: string;
    rotateCount: number;
    
    maxInflight: number | null;
    enabled: boolean;
    bypassProxy: boolean;
  }> = [];

  function chain(result: unknown[]) {
    const builder = {
      from() {
        return builder;
      },
      set() {
        return builder;
      },
      values() {
        return builder;
      },
      where() {
        return builder;
      },
      limit() {
        return builder;
      },
      async returning() {
        return result;
      },
      async then(resolve: (v: unknown[]) => void) {
        resolve(result);
      },
    };
    return builder;
  }

  return {
    db: {
      select() {
        return chain(rows);
      },
      insert() {
        return chain([]);
      },
      update() {
        return chain([]);
      },
    },
    rows,
  };
}

describe("DrizzleProviderDetailStore call-shape", () => {
  test("getRouting filters by tenant id for tenant-bound access", async () => {
    const { db } = makeDb();
    const store = new DrizzleProviderDetailStore(db as never);
    // The builder stub returns no rows, so the default response must be used.
    const result = await store.getRouting("openai", "tenant-1");
    expect(result).toEqual({
      providerId: "openai",
      tenantId: "tenant-1",
      strategy: "fallback",
      rotateCount: 1,
      maxInflight: null,
      enabled: false,
      bypassProxy: false,
    });
  });

  test("getRouting defaults missing row with tenant null preserved", async () => {
    const { db } = makeDb();
    const store = new DrizzleProviderDetailStore(db as never);
    const result = await store.getRouting("openai", null);
    expect(result.tenantId).toBeNull();
    expect(result.strategy).toBe("fallback");
  });

  test("updateRouting upserts maxInflight and bypassProxy, not just strategy", async () => {
    let inserted: Record<string, unknown> | undefined;
    let conflictSet: Record<string, unknown> | undefined;
    const db = {
      insert: (_table?: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserted = values;
          return {
            onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
              conflictSet = config.set;
              return {
                returning: async () => [
                  {
                    providerId: "openai",
                    tenantId: "tenant-1",
                    strategy: "round_robin",
                    rotateCount: 1,
                    maxInflight: 8,
                    enabled: true,
                    bypassProxy: true,
                  },
                ],
              };
            },
          };
        },
      }),
    };
    const store = new DrizzleProviderDetailStore(db as never);
    const result = await store.updateRouting("openai", "tenant-1", {
      strategy: "round_robin",
      maxInflight: 8,
      enabled: true,
      bypassProxy: true,
    });
    // The insert payload is what a fresh row gets; the conflict set is what
    // an existing row is patched with. Both must carry every routing field —
    // a missing key here silently reverts the field to its default.
    expect(inserted?.maxInflight).toBe(8);
    expect(inserted?.bypassProxy).toBe(true);
    expect(conflictSet?.maxInflight).toBe(8);
    expect(conflictSet?.bypassProxy).toBe(true);
    expect(result.maxInflight).toBe(8);
    expect(result.bypassProxy).toBe(true);
  });

  test("updateRouting clears an existing maxInflight when the patch sends null", async () => {
    let conflictSet: Record<string, unknown> | undefined;
    const db = {
      insert: (_table?: unknown) => ({
        values: (_values: Record<string, unknown>) => ({
          onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
            conflictSet = config.set;
            return {
              returning: async () => [
                {
                  providerId: "openai",
                  tenantId: "tenant-1",
                  strategy: "round_robin",
                  rotateCount: 1,
                  maxInflight: null,
                  enabled: true,
                  bypassProxy: false,
                },
              ],
            };
          },
        }),
      }),
    };
    const store = new DrizzleProviderDetailStore(db as never);
    const result = await store.updateRouting("openai", "tenant-1", { maxInflight: null });
    // `undefined` would mean "leave unchanged"; only an explicit null clears
    // the ceiling back to unlimited.
    expect("maxInflight" in (conflictSet ?? {})).toBe(true);
    expect(conflictSet?.maxInflight).toBeNull();
    expect(result.maxInflight).toBeNull();
  });
});
});

describe("registerModels endpoint resolution (fake db)", () => {
  test("manual cline registration uses the static /chat/completions endpoint, not the /v1 default", async () => {
    const inserted: unknown[] = [];
    let upserted = false;
    const db = {
      select: (_columns?: unknown) => ({
        from: (_table?: unknown) => ({
          where: (_condition?: unknown) => ({
            limit: async (_n?: number) => [
              { id: "cline", baseUrl: null, compatibilityProfile: null },
            ],
          }),
        }),
      }),
      insert: (_table?: unknown) => ({
        values: (values: unknown) => {
          inserted.push(values);
          return {
            onConflictDoUpdate: async (_config?: unknown) => {
              upserted = true;
              return [] as unknown[];
            },
          };
        },
      }),
    };
    // Production wiring: the store is handed the same startup-built
    // `modelsByProvider` map the probing service reads its static
    // definitions from, so resolution sees the bundled cline catalog.
    const store = new DrizzleProviderCatalogStore(db as never, storeOptions());
    await store.registerModels("tenant-1", "cline", ["cline-free/deepseek-v4.1-flash"], "chat");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject([
      {
        providerId: "cline",
        modelId: "cline-free/deepseek-v4.1-flash",
        wireFamily: "chat",
        endpointPath: "/chat/completions",
        source: "manual",
        // A manual add declares tools/vision/reasoning up front: capability
        // preflight reads `toolCall`, so a false default would silently strip
        // `tools` from every request to this model.
        toolCall: true,
        reasoning: true,
      },
    ]);
    // Re-registering must repair capability flags on an existing row rather
    // than leaving a previously seeded `tool_call=false` in place.
    expect(upserted).toBe(true);
  });
});

describe("deleteModel builtin guard (fake db)", () => {
  test("refuses to delete a builtin row instead of hard-deleting shared catalog", async () => {
    // First select (tenant-owned lookup) finds nothing; second (global
    // lookup) finds a builtin row.
    const selectResults: unknown[][] = [[], [{ id: "row-1", source: "builtin" }]];
    const deleted: unknown[] = [];
    const db = {
      select: (_columns?: unknown) => ({
        from: (_table?: unknown) => ({
          innerJoin: (_other?: unknown, _on?: unknown) => ({
            where: (_condition?: unknown) => ({
              limit: async (_n?: number) => selectResults.shift() ?? [],
            }),
          }),
        }),
      }),
      delete: (_table?: unknown) => ({
        where: async (_condition?: unknown) => {
          deleted.push(true);
          return [];
        },
      }),
    };
    const store = new DrizzleProviderCatalogStore(db as never, storeOptions());
    const failure = await store
      .deleteModel("tenant-1", "cline", {
        modelId: "cline-free/solar-pro4",
        route: "/chat/completions",
        enabled: true,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ConsoleDomainError);
    expect((failure as ConsoleDomainError).status).toBe(403);
    expect((failure as ConsoleDomainError).code).toBe("builtin_model_immutable");
    expect(deleted).toHaveLength(0);
  });

  test("still hard-deletes a discovered global row", async () => {
    const selectResults: unknown[][] = [[], [{ id: "row-2", source: "discovered" }]];
    let deletes = 0;
    const db = {
      select: (_columns?: unknown) => ({
        from: (_table?: unknown) => ({
          innerJoin: (_other?: unknown, _on?: unknown) => ({
            where: (_condition?: unknown) => ({
              limit: async (_n?: number) => selectResults.shift() ?? [],
            }),
          }),
        }),
      }),
      delete: (_table?: unknown) => ({
        // delete(models).where().returning() for the row itself, then the
        // tenantDisabledModels cleanup (no returning).
        where: (_condition?: unknown) => ({
          returning: async (_columns?: unknown) => {
            deletes += 1;
            return [{ id: "row-2" }];
          },
        }),
      }),
    };
    const store = new DrizzleProviderCatalogStore(db as never, storeOptions());
    const result = await store.deleteModel("tenant-1", "cline", {
      modelId: "some-fetched-model",
      route: "/chat/completions",
      enabled: true,
    });
    expect(result).toBe(true);
    expect(deletes).toBe(1);
  });
});

describe("create persists the operator's wire family (fake db)", () => {
  test("a messages-wire custom provider stores wire_family_default = messages", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: (_table?: unknown) => ({
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
        },
      }),
    };
    const store = new DrizzleProviderCatalogStore(db as never, storeOptions());
    await store.create({
      providerId: "acme-anthropic",
      tenantId: "tenant-1",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: true,
      wireFamilyDefault: "messages",
      baseUrl: "https://anthropic.example.com",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      id: "acme-anthropic",
      wireFamilyDefault: "messages",
      baseUrl: "https://anthropic.example.com",
    });
  });

  test("omitting the wire family leaves the column default in place", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: (_table?: unknown) => ({
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
        },
      }),
    };
    const store = new DrizzleProviderCatalogStore(db as never, storeOptions());
    await store.create({
      providerId: "acme-plain",
      tenantId: "tenant-1",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: true,
      baseUrl: "https://api.example.com",
    });
    expect(inserted[0]).not.toHaveProperty("wireFamilyDefault");
  });
});

