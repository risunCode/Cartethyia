import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabaseSnapshotBuilder } from "../../../src/transport/routing/route-catalog";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import {
  providers,
  tenants,
  models,
  modelAliases,
  modelCombos,
  networkPools,
  providerAccounts,
  providerRoutingSettings,
  poolRoutingSettings,
  cliToolMappings,
} from "../../../src/persistence/schema";

dbDescribe("createDatabaseSnapshotBuilder — model aliases/combos", () => {
  let db: CartethyiaDatabase;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const providerId = `snapshot-builder-test-${randomUUID().slice(0, 8)}`;
  const modelId = `known-model-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    await db.insert(tenants)
      .values([
        { id: tenantA, name: "snapshot-builder-test-a", status: "active" },
        { id: tenantB, name: "snapshot-builder-test-b", status: "active" },
      ])
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId: tenantA, enabled: true });
    await db.insert(models).values({
      providerId,
      modelId,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    await db.insert(modelAliases).values([
      { tenantId: tenantA, alias: "fast", targetModel: modelId },
      { tenantId: tenantB, alias: "quick", targetModel: modelId },
    ]);
    await db.insert(modelCombos).values([
      { tenantId: tenantA, name: "pool-a", members: [modelId], strategy: "fallback" },
      { tenantId: tenantB, name: "pool-b", members: [modelId], strategy: "round_robin" },
    ]);
    await db.insert(cliToolMappings).values([
      { tenantId: tenantA, toolId: "claude", slotKey: "sonnet", sourceModel: "claude-sonnet-4-5", targetModel: modelId, enabled: true },
      { tenantId: tenantA, toolId: "claude", slotKey: "opus", sourceModel: "claude-opus-4-5", targetModel: modelId, enabled: false },
      { tenantId: tenantB, toolId: "claude", slotKey: "haiku", sourceModel: "claude-haiku-4-5", targetModel: modelId, enabled: true },
    ]);
  });

  afterAll(async () => {
    await db.delete(cliToolMappings).where(inArray(cliToolMappings.tenantId, [tenantA, tenantB]));
    await db.delete(modelAliases).where(inArray(modelAliases.tenantId, [tenantA, tenantB]));
    await db.delete(modelCombos).where(inArray(modelCombos.tenantId, [tenantA, tenantB]));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });
  test("nests aliases and combos by tenantId without leaking across tenants", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();

    expect(built.aliases[tenantA]).toEqual({ fast: modelId });
    expect(built.aliases[tenantB]).toEqual({ quick: modelId });
    expect(built.aliases[tenantA]?.quick).toBeUndefined();

    // CLI-tool mappings are NOT tenant model aliases: they live in their own
    // bucket and merge in only for keys carrying the `routing:cli_mapping`
    // scope (see `aliasMapFor()` in routing/router.ts). Keeping them out of
    // `aliases` is what stops a CLI slot name from being routable by a key
    // without that scope.
    expect(built.cli_aliases?.[tenantA]).toEqual({
      "claude-sonnet-4-5": modelId,
      // `cliMappingSourceKeys()` also registers the family slot and
      // versioned aliases, so a bare family name resolves too.
      sonnet: modelId,
      "claude-sonnet-5": modelId,
      "claude-sonnet-5-1": modelId,
      "claude-sonnet-4-6": modelId,
    });
    expect(built.cli_aliases?.[tenantB]).toEqual({
      "claude-haiku-4-5": modelId,
      haiku: modelId,
      "claude-haiku-5": modelId,
      "claude-haiku-5-1": modelId,
      "claude-haiku-4-6": modelId,
    });
    expect(built.combos[tenantB]).toEqual({
      "pool-b": { members: [modelId], strategy: "round_robin" },
    });
    expect(built.combos[tenantA]?.["pool-b"]).toBeUndefined();
    expect(built.combos[tenantB]?.["pool-a"]).toBeUndefined();
  });

  test("candidates still carry the correct provider/tenant shape", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.model_id === modelId && c.provider_id === providerId,
    );
    expect(candidate).toBeDefined();
    expect(candidate?.tenant_id).toBe(tenantA);
  });
});

dbDescribe("createDatabaseSnapshotBuilder — automatic network pool selection", () => {
  let db: CartethyiaDatabase;
  const tenantId = randomUUID();
  const providerId = `snapshot-builder-pool-test-${randomUUID().slice(0, 8)}`;
  const modelId = `pool-model-${randomUUID().slice(0, 8)}`;
  const accountId = randomUUID();
  const activePoolId = randomUUID();
  const disabledPoolId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "snapshot-builder-pool-test", status: "active" })
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId: null, enabled: true });
    await db.insert(models).values({
      providerId,
      modelId,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    await db.insert(providerAccounts).values({
      id: accountId,
      providerId,
      tenantId,
      label: "pool-test-account",
      credentialKind: "api_key",
      status: "active",
    });
    await db.insert(networkPools).values([
      {
        id: activePoolId,
        kind: "http",
        endpointConfig: { endpoint: "https://proxy-a.example:443" },
        tenantId,
        status: "active",
        maxInflight: 12,
      },
      {
        id: disabledPoolId,
        kind: "http",
        endpointConfig: { endpoint: "https://proxy-b.example:443" },
        tenantId,
        status: "disabled",
        maxInflight: 8,
      },
    ]);
    await db.insert(providerRoutingSettings).values({
      providerId,
      tenantId,
      strategy: "fallback",
      enabled: true,
      bypassProxy: false,
    });
    await db.insert(poolRoutingSettings).values({
      tenantId,
      strategy: "round_robin",
      rotateCount: 2,
    });
  });

  afterAll(async () => {
    await db.delete(poolRoutingSettings).where(eq(poolRoutingSettings.tenantId, tenantId));
    await db
      .delete(providerRoutingSettings)
      .where(eq(providerRoutingSettings.providerId, providerId));
    await db.delete(networkPools).where(inArray(networkPools.id, [activePoolId, disabledPoolId]));
    await db.delete(providerAccounts).where(eq(providerAccounts.id, accountId));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("attaches every active pool (never a pinned single pool) with its concurrency limit, excluding disabled pools", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.model_id === modelId && c.provider_id === providerId,
    );
    expect(candidate).toBeDefined();
    expect(candidate?.network_pool_ids).toEqual([activePoolId]);
    expect(candidate?.network_pool_limits).toEqual({ [activePoolId]: 12 });
  });

  test("carries the pool routing strategy onto the snapshot and candidate", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    expect(built.poolRouting?.[tenantId]).toEqual({ strategy: "round_robin", rotateCount: 2 });
    const candidate = built.candidates.find(
      (c) => c.model_id === modelId && c.provider_id === providerId,
    );
    expect(candidate?.network_pool_routing).toEqual({
      strategy: "round_robin",
      rotateCount: 2,
      tenantId,
    });
  });

  test("keeps proxy routing fail-closed when every configured pool is unhealthy", async () => {
    await db.update(networkPools).set({ status: "cooldown" }).where(inArray(networkPools.id, [activePoolId]));
    try {
      const built = await createDatabaseSnapshotBuilder(db)();
      const candidate = built.candidates.find(
        (row) => row.model_id === modelId && row.provider_id === providerId,
      );
      expect(candidate?.network_pool_ids).toEqual([]);
      expect(candidate?.network_pool_required).toBe(true);
    } finally {
      await db.update(networkPools).set({ status: "active" }).where(inArray(networkPools.id, [activePoolId]));
    }
  });

  test("bypassProxy leaves the candidate with no network pools at all", async () => {
    await db
      .update(providerRoutingSettings)
      .set({ bypassProxy: true })
      .where(eq(providerRoutingSettings.providerId, providerId));
    try {
      const builder = createDatabaseSnapshotBuilder(db);
      const built = await builder();
      const candidate = built.candidates.find(
        (c) => c.model_id === modelId && c.provider_id === providerId,
      );
      expect(candidate).toBeDefined();
      expect(candidate?.network_pool_ids).toBeUndefined();
    } finally {
      await db
        .update(providerRoutingSettings)
        .set({ bypassProxy: false })
        .where(eq(providerRoutingSettings.providerId, providerId));
    }
  });
});

dbDescribe("createDatabaseSnapshotBuilder — global vs tenant routing precedence", () => {
  let db: CartethyiaDatabase;
  const tenantWithOverride = randomUUID();
  const tenantWithoutOverride = randomUUID();
  const providerId = `snapshot-builder-precedence-test-${randomUUID().slice(0, 8)}`;
  const modelId = `precedence-model-${randomUUID().slice(0, 8)}`;
  const overrideAccountId = randomUUID();
  const defaultAccountId = randomUUID();
  const inheritedAccountId = randomUUID();
  const tenantPoolId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values([
        { id: tenantWithOverride, name: "precedence-test-override", status: "active" },
        { id: tenantWithoutOverride, name: "precedence-test-default", status: "active" },
      ])
      .onConflictDoNothing();
    // Global provider: every tenant may dispatch to it, so per-account tenant
    // ownership (not the provider row) decides which routing setting applies.
    await db.insert(providers).values({ id: providerId, tenantId: null, enabled: true });
    await db.insert(models).values({
      providerId,
      modelId,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    await db.insert(providerAccounts).values([
      {
        id: overrideAccountId,
        providerId,
        tenantId: tenantWithOverride,
        label: "previously-overridden-account",
        credentialKind: "api_key",
        // The cutover must ignore this legacy row value: it would otherwise
        // still win over the common Routing Strategy ceiling below.
        maxInflight: 2,
      },
      {
        id: inheritedAccountId,
        providerId,
        tenantId: tenantWithOverride,
        label: "inherited-account",
        credentialKind: "api_key",
      },
      {
        id: defaultAccountId,
        providerId,
        tenantId: tenantWithoutOverride,
        label: "default-account",
        credentialKind: "api_key",
      },
    ]);
    // Global fallback: bypassProxy=false, so a tenant with an active pool and
    // no tenant-specific override gets network pools attached.
    await db.insert(providerRoutingSettings).values({
      providerId,
      tenantId: null,
      strategy: "fallback",
      enabled: true,
      bypassProxy: false,
      maxInflight: 8,
    });
    // Tenant-specific settings override the global ceiling. A stale legacy
    // account override must not remain the most specific admission limit.
    await db.insert(providerRoutingSettings).values({
      providerId,
      tenantId: tenantWithOverride,
      strategy: "fallback",
      enabled: true,
      bypassProxy: true,
      maxInflight: 6,
    });
    await db.insert(networkPools).values({
      id: tenantPoolId,
      kind: "http",
      endpointConfig: {},
      tenantId: tenantWithoutOverride,
      status: "active",
      maxInflight: 4,
      weight: 100,
    });
  });

  afterAll(async () => {
    await db.delete(networkPools).where(eq(networkPools.id, tenantPoolId));
    await db
      .delete(providerRoutingSettings)
      .where(eq(providerRoutingSettings.providerId, providerId));
    await db
      .delete(providerAccounts)
      .where(inArray(providerAccounts.id, [overrideAccountId, inheritedAccountId, defaultAccountId]));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantWithOverride, tenantWithoutOverride]));
  });

  test("a tenant-specific routing override wins over the global row for that tenant only", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();

    const overrideRouteCandidate = built.candidates.find(
      (candidate) => candidate.provider_account_id === overrideAccountId,
    );
    const inheritedRouteCandidate = built.candidates.find(
      (candidate) => candidate.provider_account_id === inheritedAccountId,
    );
    const defaultRouteCandidate = built.candidates.find(
      (candidate) => candidate.provider_account_id === defaultAccountId,
    );

    expect(overrideRouteCandidate).toBeDefined();
    expect(inheritedRouteCandidate).toBeDefined();
    expect(defaultRouteCandidate).toBeDefined();
    // Tenant-specific bypassProxy=true → no network pools attached.
    expect(overrideRouteCandidate?.network_pool_ids).toBeUndefined();
    // No tenant-specific row for this tenant → falls through to the global
    // bypassProxy=false row → its active pool is attached.
    expect(defaultRouteCandidate?.network_pool_ids).toEqual([tenantPoolId]);
    // Tenant-specific ceiling wins over global, and the legacy account override
    // is ignored rather than remaining most specific.
    expect(overrideRouteCandidate?.max_inflight).toBe(6);
    expect(inheritedRouteCandidate?.max_inflight).toBe(6);
    expect(defaultRouteCandidate?.max_inflight).toBe(8);
  });
});

dbDescribe("createDatabaseSnapshotBuilder — zero-account provider eligibility", () => {
  let db: CartethyiaDatabase;
  const publicProviderId = `snapshot-builder-public-${randomUUID().slice(0, 8)}`;
  const publicModelId = `public-model-${randomUUID().slice(0, 8)}`;
  const gatedProviderId = `snapshot-builder-gated-${randomUUID().slice(0, 8)}`;
  const gatedModelId = `gated-model-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    await db.insert(providers).values([
      { id: publicProviderId, tenantId: null, enabled: true, requiresAccount: false },
      { id: gatedProviderId, tenantId: null, enabled: true },
    ]);
    await db.insert(models).values([
      {
        providerId: publicProviderId,
        modelId: publicModelId,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        enabled: true,
      },
      {
        providerId: gatedProviderId,
        modelId: gatedModelId,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        enabled: true,
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(models)
      .where(inArray(models.providerId, [publicProviderId, gatedProviderId]));
    await db
      .delete(providers)
      .where(inArray(providers.id, [publicProviderId, gatedProviderId]));
  });

  test("requiresAccount:false provider is routable with zero provider_accounts rows", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.provider_id === publicProviderId && c.model_id === publicModelId,
    );
    expect(candidate).toBeDefined();
    expect(candidate?.requires_account).toBe(false);
    expect(candidate?.provider_account_id).toBeUndefined();
    expect((candidate as { health_status?: string })?.health_status).toBeUndefined();
  });

  test("default (requiresAccount:true) provider with zero accounts stays disabled", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.provider_id === gatedProviderId && c.model_id === gatedModelId,
    );
    expect(candidate).toBeDefined();
    expect((candidate as { health_status?: string })?.health_status).toBe("disabled");
  });

  test("an unexpired per-model cooldown excludes the candidate, and clearing it restores routing", async () => {
    // This is the boundary the reported symptom crossed: the account read
    // `active` but `/v1` still refused to route it, while a direct probe (which
    // addresses the account by id and never consults the catalog) succeeded.
    const accountId = randomUUID();
    await db.insert(providerAccounts).values({
      id: accountId,
      providerId: gatedProviderId,
      tenantId: null,
      label: "snapshot-model-cooldown",
      credentialCiphertext: null,
      credentialKind: "api_key",
      status: "active",
      modelCooldowns: { [gatedModelId]: new Date(Date.now() + 60_000).toISOString() },
    });
    try {
      const cooling = await createDatabaseSnapshotBuilder(db)();
      const coolingCandidate = cooling.candidates.find(
        (c) => c.provider_id === gatedProviderId && c.model_id === gatedModelId,
      );
      expect((coolingCandidate as { health_status?: string })?.health_status).toBe("cooldown");

      // Recovery clears the map, so the same (account, model) pair routes again.
      await db
        .update(providerAccounts)
        .set({ modelCooldowns: {} })
        .where(eq(providerAccounts.id, accountId));
      const recovered = await createDatabaseSnapshotBuilder(db)();
      const recoveredCandidate = recovered.candidates.find(
        (c) => c.provider_id === gatedProviderId && c.model_id === gatedModelId,
      );
      expect((recoveredCandidate as { health_status?: string })?.health_status).toBeUndefined();
    } finally {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, accountId));
    }
  });
});

