import { describe, expect, test } from "bun:test";
import {
  createProviderCatalogOperations,
  sanitizeProviderResponse,
} from "../../../../src/console/providers/catalog/provider-operations";
import type {
  CreateProviderAccountRequest,
  ModelCatalogEntry,
  ProviderAccountResponse,
  ProviderCatalogStore,
  ProviderRecord,
  UpdateProviderAccountRequest,
} from "../../../../src/console/providers/catalog/contracts";
import type { AccountHealthEventRecord } from "../../../../src/providers/operations/account-health-service";
import type { AuditSink } from "../../../../src/console/domains/audit/contracts";
import type { AccessDecision } from "../../../../src/security/access-control";
import type { ProviderRegistry } from "../../../../src/providers/provider-registry";

const tenantAccess: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "providers:read", "providers:write", "models:read", "models:write"],
  admissionIdentity: "key-1",
};

const platformAdmin: AccessDecision = {
  id: "admin",
  tenantId: "tenant-1",
  scopes: ["platform:admin", "providers:read", "providers:write"],
  admissionIdentity: "admin",
};

/**
 * Only the two registry methods `attachProviderCapabilities` reaches. Complete
 * rather than a bare cast so a passing assertion cannot be a TypeError in
 * disguise; `discovery` selects the `resolveModelDiscovery` arm under test.
 */
function registryWith(options: { discovery?: boolean } = {}): ProviderRegistry {
  return {
    async resolveLoginClient() {
      return undefined;
    },
    async resolveModelDiscovery() {
      return options.discovery ? ({} as unknown as object) : undefined;
    },
    hasQuotaCollector() {
      return false;
    },
  } as unknown as ProviderRegistry;
}

function emptyUsage() {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function account(overrides: Partial<ProviderAccountResponse> & { id: string }): ProviderAccountResponse {
  return {
    providerId: "openai",
    tenantId: "tenant-1",
    label: overrides.id,
    credentialKind: "api_key",
    status: "active",
    usageToday: emptyUsage(),
    usageAllTime: emptyUsage(),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAuditSink(): { sink: AuditSink; entries: Array<{ action: string; target: string; detail?: Record<string, unknown> }> } {
  const entries: Array<{ action: string; target: string; detail?: Record<string, unknown> }> = [];
  const sink: AuditSink = {
    async record(entry) {
      entries.push({
        action: entry.action,
        target: entry.target,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      });
    },
  };
  return { sink, entries };
}

interface ProviderStoreState {
  providers: Map<string, ProviderRecord>;
  accounts: ProviderAccountResponse[];
  healthEvents: readonly AccountHealthEventRecord[];
  created: ProviderRecord[];
  updated: Array<{ tenantId: string; providerId: string; patch: Partial<ProviderRecord> }>;
  deleted: Array<{ tenantId: string; providerId: string }>;
  globalUpdated: Array<{ providerId: string; patch: Partial<ProviderRecord> }>;
  globalDeleted: string[];
  registered: Array<{
    tenantId: string;
    providerId: string;
    modelIds: readonly string[];
    wireFamily: string | undefined;
  }>;
  createdAccounts: Array<{
    tenantId: string;
    providerId: string;
    request: CreateProviderAccountRequest;
  }>;
  accountUpdates: Array<{
    tenantId: string;
    providerId: string;
    accountId: string;
    patch: UpdateProviderAccountRequest;
  }>;
  recovered: Array<{ tenantId: string; providerId: string; accountId: string }>;
}

/** In-memory `ProviderCatalogStore` so the operations run their real bodies. */
function makeStore(): { store: ProviderCatalogStore; state: ProviderStoreState } {
  const state: ProviderStoreState = {
    providers: new Map<string, ProviderRecord>(),
    accounts: [],
    healthEvents: [],
    created: [],
    updated: [],
    deleted: [],
    globalUpdated: [],
    globalDeleted: [],
    registered: [],
    createdAccounts: [],
    accountUpdates: [],
    recovered: [],
  };
  const key = (tenantId: string | null, providerId: string) =>
    `${tenantId ?? "\u0000"}::${providerId}`;
  const store = {
    async list(tenantId: string) {
      return [...state.providers.values()].filter((record) => record.tenantId === tenantId);
    },
    async get(tenantId: string, providerId: string) {
      return state.providers.get(key(tenantId, providerId));
    },
    async create(record: ProviderRecord) {
      state.created.push(record);
      state.providers.set(key(record.tenantId, record.providerId), record);
    },
    async update(tenantId: string, providerId: string, patch: Partial<ProviderRecord>) {
      state.updated.push({ tenantId, providerId, patch });
      const existing = state.providers.get(key(tenantId, providerId));
      if (!existing) return undefined;
      const next = { ...existing, ...patch };
      state.providers.set(key(tenantId, providerId), next);
      return next;
    },
    async delete(tenantId: string, providerId: string) {
      state.deleted.push({ tenantId, providerId });
      return state.providers.delete(key(tenantId, providerId));
    },
    async updateGlobal(providerId: string, patch: Partial<ProviderRecord>) {
      state.globalUpdated.push({ providerId, patch });
      const existing = state.providers.get(key(null, providerId));
      if (!existing) return undefined;
      const next = { ...existing, ...patch };
      state.providers.set(key(null, providerId), next);
      return next;
    },
    async deleteGlobal(providerId: string) {
      state.globalDeleted.push(providerId);
      return state.providers.delete(key(null, providerId));
    },
    async listModels(): Promise<readonly ModelCatalogEntry[]> {
      return [];
    },
    async listModelsForTenant() {
      return new Map<string, readonly ModelCatalogEntry[]>();
    },
    async registerModels(
      tenantId: string,
      providerId: string,
      modelIds: readonly string[],
      wireFamily?: string,
    ) {
      state.registered.push({ tenantId, providerId, modelIds, wireFamily });
    },
    async syncModels() {
      return { synced: 0 };
    },
    async listAccounts(_tenantId: string, providerId: string) {
      // The real store also returns pool-wide global rows (tenantId null);
      // exportAccounts is what filters those out.
      return state.accounts.filter(
        (row) => row.providerId === providerId && (row.tenantId === _tenantId || row.tenantId === null),
      );
    },
    async listAllAccounts(tenantId: string) {
      return state.accounts.filter((row) => row.tenantId === tenantId);
    },
    async createAccount(tenantId: string, providerId: string, request: CreateProviderAccountRequest) {
      state.createdAccounts.push({ tenantId, providerId, request });
      return account({ id: "acct-new", providerId, tenantId, label: request.label ?? "account", credentialKind: request.credentialKind });
    },
    async updateAccount(
      tenantId: string,
      providerId: string,
      accountId: string,
      patch: UpdateProviderAccountRequest,
    ) {
      state.accountUpdates.push({ tenantId, providerId, accountId, patch });
      const existing = state.accounts.find((row) => row.id === accountId && row.providerId === providerId);
      if (!existing) return undefined;
      return { ...existing, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.status === undefined ? {} : { status: patch.status }) };
    },
    async listAccountHealthEvents() {
      return state.healthEvents;
    },
    async recoverAccount(tenantId: string, providerId: string, accountId: string) {
      state.recovered.push({ tenantId, providerId, accountId });
      return state.accounts.some((row) => row.id === accountId && row.providerId === providerId);
    },
    async probeModel() {
      return { ok: true, latencyMs: 1 };
    },
    async testByokConnection() {
      return { ok: true, latencyMs: 1 };
    },
    async probeAllModels(_tenantId: string, providerId: string) {
      return { providerId, results: [] };
    },
    async probeAllAccounts(_tenantId: string, providerId: string) {
      return { providerId, modelId: "gpt-5.6", results: [] };
    },
    async setModelEnabled() {
      return true;
    },
    async deleteModel() {
      return true;
    },
  } satisfies ProviderCatalogStore;
  return { store, state };
}

function makeInvalidator() {
  const calls: number[] = [];
  return {
    calls,
    invalidator: {
      async invalidate() {
        calls.push(1);
        return calls.length;
      },
    },
  };
}

describe("sanitizeProviderResponse", () => {
  test("requires a non-empty providerId and boolean flags", () => {
    for (const bad of [{}, { providerId: "" }]) {
      try {
        sanitizeProviderResponse(bad);
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_provider", status: 400, message: "Provider providerId is required" });
      }
    }
    for (const [field, value] of [
      ["enabled", "yes"],
      ["isBuiltIn", 1],
      ["requiresAccount", "no"],
    ] as const) {
      try {
        sanitizeProviderResponse({ providerId: "vendor", [field]: value });
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toMatchObject({
          code: "invalid_provider",
          status: 400,
          message: `Provider ${field} must be a boolean`,
        });
      }
    }
  });

  test("applies defaults and omits label/timestamps that are absent or the wrong type", () => {
    const response = sanitizeProviderResponse({
      providerId: "vendor",
      label: "",
      createdAt: 5,
      updatedAt: null,
    });
    expect(response).toEqual({
      providerId: "vendor",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: true,
    });
  });

  test("projects wireFamilyDefault only for a known family and filters supportedWireFamilies", () => {
    const kept = sanitizeProviderResponse({
      providerId: "vendor",
      isBuiltIn: true,
      wireFamilyDefault: "chat",
      supportedWireFamilies: ["chat", "bogus", "messages"],
    });
    expect(kept.wireFamilyDefault).toBe("chat");
    expect(kept.supportedWireFamilies).toEqual(["chat", "messages"]);
    expect(kept.supportsModelDiscovery).toBe(false);

    const dropped = sanitizeProviderResponse({
      providerId: "vendor",
      wireFamilyDefault: "banana",
      supportedWireFamilies: ["bogus"],
    });
    expect(dropped.wireFamilyDefault).toBeUndefined();
    expect(dropped.supportedWireFamilies).toBeUndefined();
  });

  test("gates capabilityProfile, baseUrl, and compatibilityProfile on includeSecrets", () => {
    const record = {
      providerId: "vendor",
      capabilityProfile: { vision: true },
      baseUrl: "https://vendor.test/v1",
      compatibilityProfile: { cli_identity: true },
    };
    const hidden = sanitizeProviderResponse(record, false);
    expect(hidden.capabilityProfile).toBeUndefined();
    expect(hidden.baseUrl).toBeUndefined();
    expect(hidden.compatibilityProfile).toBeUndefined();

    const revealed = sanitizeProviderResponse(record, true);
    expect(revealed.capabilityProfile).toEqual({ vision: true });
    expect(revealed.baseUrl).toBe("https://vendor.test/v1");
    expect(revealed.compatibilityProfile).toEqual({ cli_identity: true });

    // A non-string baseUrl is not a URL the operator can use; it must not be echoed.
    expect(sanitizeProviderResponse({ providerId: "vendor", baseUrl: 5 }, true).baseUrl).toBeUndefined();
  });
});

describe("listProviders", () => {
  test("marks configured from the tenant's accounts and resolves builtin discovery from the registry", async () => {
    const { store, state } = makeStore();
    state.providers.set("tenant-1::openai", {
      providerId: "openai",
      tenantId: "tenant-1",
      enabled: true,
      isBuiltIn: true,
      requiresAccount: true,
      supportsModelDiscovery: false,
    });
    state.accounts.push(account({ id: "acct-1", providerId: "openai" }));
    const factory = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith({ discovery: true }),
    });
    const [provider] = await factory.listProviders(tenantAccess);
    expect(provider).toMatchObject({ providerId: "openai", configured: true, supportsModelDiscovery: true });
  });
});

describe("createProvider", () => {
  function factory(store: ProviderCatalogStore, registry: ProviderRegistry = registryWith()) {
    return createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registry,
    });
  }

  test("rejects a non-slug id and a reserved bundled id", async () => {
    const { store } = makeStore();
    const ops = factory(store);
    await expect(
      ops.createProvider(tenantAccess, { providerId: "Bad Slug" }),
    ).rejects.toMatchObject({
      code: "invalid_provider_id",
      status: 400,
      message: "Provider ID must be a lowercase slug",
    });
    await expect(
      ops.createProvider(tenantAccess, { providerId: "openai" }),
    ).rejects.toMatchObject({
      code: "slug_reserved",
      status: 409,
      message: "Provider ID is reserved",
      details: { providerId: "openai" },
    });
  });

  test("rejects a compatibility profile the validator refuses", async () => {
    const { store } = makeStore();
    const ops = factory(store);
    await expect(
      ops.createProvider(tenantAccess, {
        providerId: "vendor",
        compatibilityProfile: { extra_headers: { "x-bad header": "v" } },
      }),
    ).rejects.toMatchObject({
      code: "invalid_compatibility_profile",
      status: 400,
      message: "invalid header name x-bad header",
    });
  });

  test("rejects an unknown wire family", async () => {
    const { store } = makeStore();
    const ops = factory(store);
    await expect(
      ops.createProvider(tenantAccess, { providerId: "vendor", wireFamily: "banana" }),
    ).rejects.toMatchObject({
      code: "invalid_wire_family",
      status: 400,
      message: "wireFamily must be one of chat, responses, messages",
    });
  });

  test("persists BYOK defaults, registers the models, and records audit/invalidate/sync", async () => {
    const { store, state } = makeStore();
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const synced: string[] = [];
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
      auditSink: sink,
      snapshotInvalidator: invalidator,
      syncByokProvider: async (providerId) => {
        synced.push(providerId);
      },
    });

    const response = await ops.createProvider(tenantAccess, {
      providerId: "vendor",
      label: "Vendor",
      baseUrl: "https://vendor.test/v1",
      wireFamily: "messages",
      models: ["vendor-large", "vendor-small"],
    });

    const record = state.created.at(0);
    expect(record).toMatchObject({
      providerId: "vendor",
      tenantId: "tenant-1",
      label: "Vendor",
      enabled: true,
      isBuiltIn: false,
      supportsModelDiscovery: true,
      requiresAccount: true,
      baseUrl: "https://vendor.test/v1",
      wireFamilyDefault: "messages",
    });
    expect(typeof record?.createdAt).toBe("string");
    expect(state.registered).toEqual([
      {
        tenantId: "tenant-1",
        providerId: "vendor",
        modelIds: ["vendor-large", "vendor-small"],
        wireFamily: "messages",
      },
    ]);
    expect(entries).toEqual([
      { action: "provider.created", target: "vendor", detail: { wireFamily: "messages", modelCount: 2 } },
    ]);
    expect(calls).toHaveLength(1);
    expect(synced).toEqual(["vendor"]);
    expect(response).toMatchObject({ providerId: "vendor", wireFamilyDefault: "messages" });
  });

  test("does not register models when none are given and reports a zero model count", async () => {
    const { store, state } = makeStore();
    const { sink, entries } = makeAuditSink();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
      auditSink: sink,
    });
    await ops.createProvider(tenantAccess, { providerId: "vendor" });
    expect(state.registered).toEqual([]);
    expect(entries.at(0)?.detail).toEqual({ wireFamily: undefined, modelCount: 0 });
  });
});

describe("updateProvider", () => {
  test("rejects an invalid compatibility profile before touching the store", async () => {
    const { store, state } = makeStore();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
    });
    await expect(
      ops.updateProvider(tenantAccess, "vendor", {
        // Deliberately the wrong type: the operation must reject it, so the
        // test has to hand it a value the compiler would otherwise refuse.
        compatibilityProfile: { gateway_user_agent: "yes" },
      } as unknown as Parameters<typeof ops.updateProvider>[2]),
    ).rejects.toMatchObject({
      code: "invalid_compatibility_profile",
      status: 400,
      message: "gateway_user_agent must be boolean",
    });
    expect(state.updated).toEqual([]);
  });

  test("404s when the store does not own the provider", async () => {
    const { store } = makeStore();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
    });
    await expect(ops.updateProvider(tenantAccess, "missing", { label: "x" })).rejects.toMatchObject({
      code: "provider_not_found",
      status: 404,
      message: "Provider missing not found",
    });
  });

  test("audits the changed fields, invalidates, syncs, and returns the sanitized record", async () => {
    const { store, state } = makeStore();
    state.providers.set("tenant-1::vendor", {
      providerId: "vendor",
      tenantId: "tenant-1",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: true,
      baseUrl: "https://vendor.test/v1",
    });
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const synced: string[] = [];
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
      auditSink: sink,
      snapshotInvalidator: invalidator,
      syncByokProvider: async (providerId) => {
        synced.push(providerId);
      },
    });

    const response = await ops.updateProvider(tenantAccess, "vendor", { label: "Renamed", enabled: false });
    expect(response).toMatchObject({ providerId: "vendor", label: "Renamed", enabled: false });
    expect(entries).toEqual([
      { action: "provider.updated", target: "vendor", detail: { fields: ["label", "enabled"] } },
    ]);
    expect(calls).toHaveLength(1);
    expect(synced).toEqual(["vendor"]);
  });
});

describe("deleteProvider", () => {
  test("404s when the store deletes nothing", async () => {
    const { store } = makeStore();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
    });
    await expect(ops.deleteProvider(tenantAccess, "missing")).rejects.toMatchObject({
      code: "provider_not_found",
      status: 404,
    });
  });

  test("records the deletion and invalidates the snapshot", async () => {
    const { store, state } = makeStore();
    state.providers.set("tenant-1::vendor", {
      providerId: "vendor",
      tenantId: "tenant-1",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: true,
    });
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
      auditSink: sink,
      snapshotInvalidator: invalidator,
    });
    await expect(ops.deleteProvider(tenantAccess, "vendor")).resolves.toEqual({ success: true });
    expect(entries).toEqual([{ action: "provider.deleted", target: "vendor" }]);
    expect(calls).toHaveLength(1);
  });
});

describe("global provider operations", () => {
  test("require platform:admin", async () => {
    const { store } = makeStore();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
    });
    await expect(ops.updateGlobalProvider(tenantAccess, "openai", { enabled: false })).rejects.toMatchObject({
      code: "insufficient_scope",
      status: 403,
    });
    await expect(ops.deleteGlobalProvider(tenantAccess, "openai")).rejects.toMatchObject({
      code: "insufficient_scope",
      status: 403,
    });
  });

  test("404 when there is no global row to update or delete", async () => {
    const { store } = makeStore();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => platformAdmin,
      providerRegistry: registryWith(),
    });
    await expect(ops.updateGlobalProvider(platformAdmin, "openai", { enabled: false })).rejects.toMatchObject({
      code: "provider_not_found",
      status: 404,
    });
    await expect(ops.deleteGlobalProvider(platformAdmin, "openai")).rejects.toMatchObject({
      code: "provider_not_found",
      status: 404,
    });
  });

  test("updateGlobal audits fields, invalidates, syncs, and reveals the base URL", async () => {
    const { store, state } = makeStore();
    state.providers.set("\u0000::openai", {
      providerId: "openai",
      tenantId: null,
      enabled: true,
      isBuiltIn: true,
      requiresAccount: true,
      supportsModelDiscovery: true,
      baseUrl: "https://api.openai.test/v1",
    });
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const synced: string[] = [];
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => platformAdmin,
      providerRegistry: registryWith(),
      auditSink: sink,
      snapshotInvalidator: invalidator,
      syncByokProvider: async (providerId) => {
        synced.push(providerId);
      },
    });
    const response = await ops.updateGlobalProvider(platformAdmin, "openai", { enabled: false, baseUrl: "https://api.openai.test/v2" });
    expect(response).toMatchObject({ providerId: "openai", enabled: false, baseUrl: "https://api.openai.test/v2" });
    expect(entries).toEqual([
      { action: "provider.global.updated", target: "openai", detail: { fields: ["enabled", "baseUrl"] } },
    ]);
    expect(calls).toHaveLength(1);
    expect(synced).toEqual(["openai"]);
  });

  test("deleteGlobal audits the deletion and invalidates", async () => {
    const { store, state } = makeStore();
    state.providers.set("\u0000::openai", {
      providerId: "openai",
      tenantId: null,
      enabled: true,
      isBuiltIn: true,
      requiresAccount: true,
      supportsModelDiscovery: true,
    });
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => platformAdmin,
      providerRegistry: registryWith(),
      auditSink: sink,
      snapshotInvalidator: invalidator,
    });
    await expect(ops.deleteGlobalProvider(platformAdmin, "openai")).resolves.toEqual({ success: true });
    expect(entries).toEqual([{ action: "provider.global.deleted", target: "openai" }]);
    expect(calls).toHaveLength(1);
  });
});

describe("account operations", () => {
  function ops(store: ProviderCatalogStore, auditSink?: AuditSink, snapshotInvalidator?: { invalidate(): Promise<number> }) {
    return createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
      ...(auditSink === undefined ? {} : { auditSink }),
      ...(snapshotInvalidator === undefined ? {} : { snapshotInvalidator }),
    });
  }

  test("listAccounts returns the store's rows for the provider", async () => {
    const { store, state } = makeStore();
    state.accounts.push(account({ id: "acct-1" }), account({ id: "acct-global", tenantId: null }));
    const rows = await ops(store).listAccounts(tenantAccess, "openai");
    expect(rows.map((row) => row.id)).toEqual(["acct-1", "acct-global"]);
  });

  test("createAccount rejects an unknown credential kind", async () => {
    const { store, state } = makeStore();
    await expect(
      ops(store).createAccount(tenantAccess, "openai", {
        credentialKind: "workload_identity" as never,
        secret: "s",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      message: "credentialKind must be api_key, oauth, or none",
    });
    expect(state.createdAccounts).toEqual([]);
  });

  test("createAccount audits the provider and credential kind, and invalidates", async () => {
    const { store, state } = makeStore();
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const created = await ops(store, sink, invalidator).createAccount(tenantAccess, "openai", {
      label: "primary",
      credentialKind: "oauth",
      secret: "s",
    });
    expect(created).toMatchObject({ providerId: "openai", tenantId: "tenant-1", credentialKind: "oauth" });
    expect(state.createdAccounts).toEqual([
      { tenantId: "tenant-1", providerId: "openai", request: { label: "primary", credentialKind: "oauth", secret: "s" } },
    ]);
    expect(entries).toEqual([
      { action: "provider_account.created", target: "acct-new", detail: { providerId: "openai", credentialKind: "oauth" } },
    ]);
    expect(calls).toHaveLength(1);
  });

  test("updateAccount 404s when the account is not owned", async () => {
    const { store } = makeStore();
    await expect(
      ops(store).updateAccount(tenantAccess, "openai", "missing", { label: "x" }),
    ).rejects.toMatchObject({
      code: "account_not_found",
      status: 404,
      message: "Account missing not found",
    });
  });

  test("updateAccount records a revocation for a disabled status and an update otherwise", async () => {
    const { store, state } = makeStore();
    state.accounts.push(account({ id: "acct-1" }));
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const operations = ops(store, sink, invalidator);

    await operations.updateAccount(tenantAccess, "openai", "acct-1", { status: "disabled" });
    await operations.updateAccount(tenantAccess, "openai", "acct-1", { label: "renamed" });

    expect(entries).toEqual([
      { action: "provider_account.revoked", target: "acct-1", detail: { providerId: "openai", fields: ["status"] } },
      { action: "provider_account.updated", target: "acct-1", detail: { providerId: "openai", fields: ["label"] } },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("listAccountHealthEvents returns the store's events", async () => {
    const { store, state } = makeStore();
    state.healthEvents = [
      {
        id: "evt-1",
        accountId: "acct-1",
        fromStatus: "active",
        toStatus: "cooldown",
        reason: "rate_limit_transient",
        errorCategory: "rate_limit_transient",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const events = await ops(store).listAccountHealthEvents(tenantAccess, "openai", "acct-1");
    expect(events.map((event) => event.id)).toEqual(["evt-1"]);
  });

  test("recoverAccount 404s for an unknown account and audits a successful recovery", async () => {
    const { store, state } = makeStore();
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const operations = ops(store, sink, invalidator);

    await expect(operations.recoverAccount(tenantAccess, "openai", "missing")).rejects.toMatchObject({
      code: "account_not_found",
      status: 404,
    });
    state.accounts.push(account({ id: "acct-1" }));
    await expect(operations.recoverAccount(tenantAccess, "openai", "acct-1")).resolves.toEqual({
      success: true,
    });
    expect(entries).toEqual([
      { action: "provider_account.recovered", target: "acct-1", detail: { providerId: "openai" } },
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("exportAccounts", () => {
  test("projects optional health fields and the resolved secret, and audits only the ids", async () => {
    const { store, state } = makeStore();
    state.accounts.push(
      account({
        id: "acct-1",
        inflight: 3,
        cooldownUntil: "2026-01-02T00:00:00.000Z",
        lastErrorCategory: "rate_limit_transient",
      }),
      account({ id: "acct-2" }),
    );
    const { sink, entries } = makeAuditSink();
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
      auditSink: sink,
      resolveCredential: async (_providerId, accountId) => `secret-${accountId}`,
    });

    const result = await ops.exportAccounts(tenantAccess, "openai", ["acct-1", "acct-2"]);
    expect(result.accounts).toEqual([
      {
        id: "acct-1",
        providerId: "openai",
        label: "acct-1",
        credentialKind: "api_key",
        status: "active",
        secret: "secret-acct-1",
        inflight: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        cooldownUntil: "2026-01-02T00:00:00.000Z",
        lastErrorCategory: "rate_limit_transient",
      },
      {
        id: "acct-2",
        providerId: "openai",
        label: "acct-2",
        credentialKind: "api_key",
        status: "active",
        secret: "secret-acct-2",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(entries).toEqual([
      { action: "provider_account.exported", target: "openai", detail: { providerId: "openai", accountIds: ["acct-1", "acct-2"] } },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-");
  });

  test("exports an empty secret when credential resolution fails, without aborting the export", async () => {
    const { store, state } = makeStore();
    state.accounts.push(account({ id: "acct-1" }), account({ id: "acct-2" }));
    const ops = createProviderCatalogOperations({
      store,
      accessResolver: () => tenantAccess,
      providerRegistry: registryWith(),
      resolveCredential: async (_providerId, accountId) => {
        if (accountId === "acct-1") throw new Error("refresh failed");
        return "secret-acct-2";
      },
    });

    const result = await ops.exportAccounts(tenantAccess, "openai", ["acct-1", "acct-2"]);
    expect(result.accounts.map((row) => row.secret)).toEqual(["", "secret-acct-2"]);
  });
});
