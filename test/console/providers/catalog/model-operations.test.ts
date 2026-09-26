import { describe, expect, test } from "bun:test";
import { createModelCatalogOperations } from "../../../../src/console/providers/catalog/model-operations";
import type {
  ModelCatalogEntry,
  ProviderAccountResponse,
  ProviderCatalogStore,
  ProviderRecord,
  SetModelEnabledRequest,
} from "../../../../src/console/providers/catalog/contracts";
import type { AuditSink } from "../../../../src/console/domains/audit/contracts";
import { ConsoleDomainError } from "../../../../src/console/shared/errors";
import type { AccessDecision } from "../../../../src/security/access-control";
import type { ProviderRegistry } from "../../../../src/providers/provider-registry";

const readAccess: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["models:read"],
  admissionIdentity: "key-1",
};

const writeAccess: AccessDecision = {
  id: "key-2",
  tenantId: "tenant-1",
  scopes: ["models:read", "models:write"],
  admissionIdentity: "key-2",
};

const adminAccess: AccessDecision = {
  id: "admin",
  tenantId: "tenant-1",
  scopes: ["platform:admin", "models:read", "models:write"],
  admissionIdentity: "admin",
};

const registry = {
  async resolveLoginClient() {
    return undefined;
  },
  async resolveModelDiscovery() {
    return undefined;
  },
  hasQuotaCollector() {
    return false;
  },
} as unknown as ProviderRegistry;

function entry(overrides: Partial<ModelCatalogEntry> & { modelId: string }): ModelCatalogEntry {
  return {
    route: "",
    provider: "vendor",
    wireFamily: "chat",
    enabled: true,
    contextLimit: null,
    outputLimit: null,
    reasoning: false,
    toolCall: false,
    vision: false,
    document: false,
    audio: false,
    mediaGeneration: false,
    webSearch: false,
    cost: null,
    source: null,
    sourceUpdatedAt: null,
    ...overrides,
  };
}

function account(overrides: Partial<ProviderAccountResponse> & { id: string }): ProviderAccountResponse {
  const usage = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    providerId: "vendor",
    tenantId: "tenant-1",
    label: overrides.id,
    credentialKind: "api_key",
    status: "active",
    usageToday: usage,
    usageAllTime: usage,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderRecord> & { providerId: string }): ProviderRecord {
  return {
    tenantId: "tenant-1",
    enabled: true,
    isBuiltIn: false,
    requiresAccount: true,
    supportsModelDiscovery: true,
    ...overrides,
  };
}

interface ModelState {
  providers: readonly ProviderRecord[];
  accounts: readonly ProviderAccountResponse[];
  modelsByProvider: Map<string, readonly ModelCatalogEntry[]>;
  deleted: SetModelEnabledRequest[];
  deleteResults: Map<string, boolean>;
  deleteErrors: Map<string, Error>;
  enabled: Array<{ tenantId: string; providerId: string; request: SetModelEnabledRequest }>;
  synced: Array<{ tenantId: string; providerId: string }>;
  registered: Array<{ tenantId: string; providerId: string; modelIds: readonly string[] }>;
  connectionTests: Array<Record<string, unknown>>;
  probes: Array<{ providerId: string; request: { modelId: string } }>;
  probeAllModels: string[];
  probeAllAccounts: Array<{ providerId: string; request: { modelId: string } }>;
}

function makeStore(state: ModelState): ProviderCatalogStore {
  return {
    async list() {
      return state.providers;
    },
    async get() {
      return undefined;
    },
    async create() {},
    async update() {
      return undefined;
    },
    async delete() {
      return false;
    },
    async updateGlobal() {
      return undefined;
    },
    async deleteGlobal() {
      return false;
    },
    async listModels(_tenantId, providerId) {
      return state.modelsByProvider.get(providerId) ?? [];
    },
    async listModelsForTenant() {
      return state.modelsByProvider;
    },
    async syncModels(tenantId, providerId) {
      state.synced.push({ tenantId, providerId });
      return { synced: 2 };
    },
    async registerModels(tenantId, providerId, modelIds) {
      state.registered.push({ tenantId, providerId, modelIds });
    },
    async listAccounts() {
      return [];
    },
    async listAllAccounts() {
      return state.accounts;
    },
    async createAccount() {
      throw new Error("not implemented");
    },
    async updateAccount() {
      return undefined;
    },
    async listAccountHealthEvents() {
      return [];
    },
    async recoverAccount() {
      return true;
    },
    async setModelEnabled(tenantId, providerId, request) {
      state.enabled.push({ tenantId, providerId, request });
      return true;
    },
    async deleteModel(_tenantId, _providerId, request) {
      const failure = state.deleteErrors.get(request.modelId);
      if (failure) throw failure;
      state.deleted.push(request);
      return state.deleteResults.get(request.modelId) ?? true;
    },
    async probeModel(_tenantId, providerId, request) {
      state.probes.push({ providerId, request });
      return { ok: true, latencyMs: 3 };
    },
    async testByokConnection(_tenantId, request) {
      state.connectionTests.push({ ...request });
      return { ok: true, latencyMs: 12, modelCount: 4 };
    },
    async probeAllModels(_tenantId, providerId) {
      state.probeAllModels.push(providerId);
      return { providerId, results: [] };
    },
    async probeAllAccounts(_tenantId, providerId, request) {
      state.probeAllAccounts.push({ providerId, request });
      return { providerId, modelId: request.modelId, results: [] };
    },
  };
}

function emptyState(overrides: Partial<ModelState> = {}): ModelState {
  return {
    providers: [],
    accounts: [],
    modelsByProvider: new Map(),
    deleted: [],
    deleteResults: new Map(),
    deleteErrors: new Map(),
    enabled: [],
    synced: [],
    registered: [],
    connectionTests: [],
    probes: [],
    probeAllModels: [],
    probeAllAccounts: [],
    ...overrides,
  };
}

function makeOps(state: ModelState, extra: { auditSink?: AuditSink; snapshotInvalidator?: { invalidate(): Promise<number> }; listRoutingTargets?: (tenantId: string) => Promise<{ aliases: readonly { alias: string; targetModel: string }[]; combos: readonly { name: string; members: readonly string[] }[] }> } = {}) {
  return createModelCatalogOperations({
    store: makeStore(state),
    accessResolver: () => writeAccess,
    providerRegistry: registry,
    ...extra,
  });
}

function makeAuditSink() {
  const entries: Array<{ action: string; target: string; detail?: Record<string, unknown> }> = [];
  const sink: AuditSink = {
    async record(record) {
      entries.push({
        action: record.action,
        target: record.target,
        ...(record.detail === undefined ? {} : { detail: record.detail }),
      });
    },
  };
  return { sink, entries };
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

describe("listModels", () => {
  test("requires models:read", async () => {
    const state = emptyState();
    await expect(makeOps(state).listModels(undefined, "vendor")).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });

  test("returns the store rows for the provider", async () => {
    const state = emptyState({
      modelsByProvider: new Map([["vendor", [entry({ modelId: "vendor-large" })]]]),
    });
    const rows = await makeOps(state).listModels(readAccess, "vendor");
    expect(rows.map((row) => row.modelId)).toEqual(["vendor-large"]);
  });
});

describe("listFlatModels", () => {
  test("skips a provider with no active account, and hides disabled models", async () => {
    const state = emptyState({
      providers: [
        provider({ providerId: "needs-account" }),
        provider({ providerId: "no-account-needed", requiresAccount: false }),
        provider({ providerId: "has-account" }),
      ],
      accounts: [account({ id: "acct-1", providerId: "has-account", status: "cooldown" })],
      modelsByProvider: new Map([
        ["needs-account", [entry({ modelId: "hidden" })]],
        ["no-account-needed", [entry({ modelId: "visible", source: "builtin" })]],
        ["has-account", [entry({ modelId: "disabled", enabled: false }), entry({ modelId: "cooldown-only" })]],
      ]),
    });
    const rows = await makeOps(state).listFlatModels(readAccess);
    expect(rows.map((row) => row.qualified)).toEqual(["no-account-needed/visible"]);
  });

  test("counts only active accounts toward the requiresAccount gate", async () => {
    const state = emptyState({
      providers: [provider({ providerId: "vendor" })],
      accounts: [account({ id: "acct-1", providerId: "vendor", status: "active" })],
      modelsByProvider: new Map([["vendor", [entry({ modelId: "vendor-large" })]]]),
    });
    const rows = await makeOps(state).listFlatModels(readAccess);
    expect(rows.map((row) => row.qualified)).toEqual(["vendor/vendor-large"]);
  });

  test("keeps the higher-ranked duplicate for the same qualified id", async () => {
    const state = emptyState({
      providers: [provider({ providerId: "vendor", requiresAccount: false })],
      modelsByProvider: new Map([
        ["vendor", [entry({ modelId: "dup", contextLimit: 1 }), entry({ modelId: "dup", contextLimit: 900, source: "builtin" })]],
      ]),
    });
    const rows = await makeOps(state).listFlatModels(readAccess);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.entry).toMatchObject({ contextLimit: 900, source: "builtin" });
  });

  test("appends aliases and combos as routing targets, preferring the real model row", async () => {
    const state = emptyState({
      providers: [provider({ providerId: "vendor", requiresAccount: false })],
      modelsByProvider: new Map([["vendor", [entry({ modelId: "vendor-large", contextLimit: 1000 })]]]),
    });
    const ops = makeOps(state, {
      listRoutingTargets: async () => ({
        aliases: [
          { alias: "fast", targetModel: "vendor/vendor-large" },
          { alias: "chained", targetModel: "other/unknown" },
        ],
        combos: [{ name: "combo-a", members: ["a", "b"] }],
      }),
    });
    const rows = await ops.listFlatModels(readAccess);
    expect(rows.map((row) => row.qualified)).toEqual([
      "chained",
      "combo-a",
      "fast",
      "vendor/vendor-large",
    ]);

    const fast = rows.find((row) => row.qualified === "fast");
    expect(fast).toMatchObject({ kind: "alias", providerLabel: "alias → vendor/vendor-large" });
    expect(fast?.entry.contextLimit).toBe(1000);

    const chained = rows.find((row) => row.qualified === "chained");
    expect(chained?.entry).toMatchObject({ source: "alias", contextLimit: null });

    const combo = rows.find((row) => row.qualified === "combo-a");
    expect(combo).toMatchObject({ kind: "combo", providerLabel: "combo · 2 members" });
    expect(combo?.entry).toMatchObject({ source: "combo" });
  });

  test("returns model rows only when no routing targets are configured", async () => {
    const state = emptyState({
      providers: [provider({ providerId: "vendor", requiresAccount: false })],
      modelsByProvider: new Map([["vendor", [entry({ modelId: "vendor-large" })]]]),
    });
    const rows = await makeOps(state).listFlatModels(readAccess);
    expect(rows.map((row) => row.kind)).toEqual(["model"]);
  });
});

describe("syncModels", () => {
  test("requires platform:admin before the tenant read scope", async () => {
    const state = emptyState();
    await expect(makeOps(state).syncModels(readAccess, "vendor")).rejects.toMatchObject({
      code: "insufficient_scope",
      status: 403,
      message: "platform:admin scope required",
    });
    expect(state.synced).toEqual([]);
  });

  test("delegates to the store and invalidates the snapshot", async () => {
    const state = emptyState();
    const { invalidator, calls } = makeInvalidator();
    const ops = makeOps(state, { snapshotInvalidator: invalidator });
    await expect(ops.syncModels(adminAccess, "vendor")).resolves.toEqual({ synced: 2 });
    expect(state.synced).toEqual([{ tenantId: "tenant-1", providerId: "vendor" }]);
    expect(calls).toHaveLength(1);
  });
});

describe("registerModels", () => {
  test("rejects an empty list", async () => {
    const state = emptyState();
    await expect(makeOps(state).registerModels(writeAccess, "vendor", [])).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      message: "modelIds must be non-empty",
    });
    expect(state.registered).toEqual([]);
  });

  test("registers the ids, audits them, and invalidates", async () => {
    const state = emptyState();
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const ops = makeOps(state, { auditSink: sink, snapshotInvalidator: invalidator });
    await expect(ops.registerModels(writeAccess, "vendor", ["m-1", "m-2"])).resolves.toEqual({
      registered: 2,
    });
    expect(state.registered).toEqual([
      { tenantId: "tenant-1", providerId: "vendor", modelIds: ["m-1", "m-2"] },
    ]);
    expect(entries).toEqual([
      { action: "provider.models.registered", target: "vendor", detail: { modelIds: ["m-1", "m-2"] } },
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("connection and probe operations", () => {
  test("testByokConnection forwards the untrusted request verbatim to the store", async () => {
    const state = emptyState();
    const result = await makeOps(state).testByokConnection(readAccess, {
      baseUrl: "https://vendor.test/v1",
      apiKey: "sk-secret",
      wireFamily: "chat",
    });
    expect(result).toEqual({ ok: true, latencyMs: 12, modelCount: 4 });
    expect(state.connectionTests).toEqual([
      { baseUrl: "https://vendor.test/v1", apiKey: "sk-secret", wireFamily: "chat" },
    ]);
  });

  test("probeModel rejects a blank modelId before reaching the store", async () => {
    const state = emptyState();
    await expect(
      makeOps(state).probeModel(writeAccess, "vendor", { modelId: "   " }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      message: "modelId is required",
    });
    expect(state.probes).toEqual([]);
  });

  test("probeModel delegates a valid request", async () => {
    const state = emptyState();
    await expect(
      makeOps(state).probeModel(writeAccess, "vendor", { modelId: "vendor-large" }),
    ).resolves.toEqual({ ok: true, latencyMs: 3 });
    expect(state.probes).toEqual([{ providerId: "vendor", request: { modelId: "vendor-large" } }]);
  });

  test("probeAllModels delegates to the store", async () => {
    const state = emptyState();
    await expect(makeOps(state).probeAllModels(writeAccess, "vendor")).resolves.toEqual({
      providerId: "vendor",
      results: [],
    });
    expect(state.probeAllModels).toEqual(["vendor"]);
  });

  test("probeAllAccounts rejects a blank modelId and delegates a valid one", async () => {
    const state = emptyState();
    const ops = makeOps(state);
    await expect(ops.probeAllAccounts(writeAccess, "vendor", { modelId: "" })).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      message: "modelId is required",
    });
    await expect(
      ops.probeAllAccounts(writeAccess, "vendor", { modelId: "vendor-large" }),
    ).resolves.toEqual({ providerId: "vendor", modelId: "vendor-large", results: [] });
    expect(state.probeAllAccounts).toEqual([
      { providerId: "vendor", request: { modelId: "vendor-large" } },
    ]);
  });
});

describe("setModelEnabled", () => {
  test("404s when the store has no such model", async () => {
    const state = emptyState();
    const store = makeStore(state);
    const ops = createModelCatalogOperations({
      store: { ...store, async setModelEnabled() { return false; } },
      accessResolver: () => writeAccess,
      providerRegistry: registry,
    });
    await expect(
      ops.setModelEnabled(writeAccess, "vendor", { modelId: "missing", route: "", enabled: true }),
    ).rejects.toMatchObject({
      code: "model_not_found",
      status: 404,
      message: "Model missing not found",
    });
  });

  test("audits an enable and a disable with the distinct actions", async () => {
    const state = emptyState();
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const ops = makeOps(state, { auditSink: sink, snapshotInvalidator: invalidator });

    await ops.setModelEnabled(writeAccess, "vendor", { modelId: "m-1", route: "/v1", enabled: true });
    await ops.setModelEnabled(writeAccess, "vendor", { modelId: "m-1", route: "/v1", enabled: false });

    expect(entries).toEqual([
      { action: "provider.model.enabled", target: "vendor", detail: { modelId: "m-1", route: "/v1" } },
      { action: "provider.model.disabled", target: "vendor", detail: { modelId: "m-1", route: "/v1" } },
    ]);
    expect(calls).toHaveLength(2);
  });
});

describe("deleteModel", () => {
  test("404s when the store deletes nothing", async () => {
    const state = emptyState();
    const store = makeStore(state);
    const ops = createModelCatalogOperations({
      store: { ...store, async deleteModel() { return false; } },
      accessResolver: () => writeAccess,
      providerRegistry: registry,
    });
    await expect(
      ops.deleteModel(writeAccess, "vendor", { modelId: "missing", route: "", enabled: false }),
    ).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });

  test("audits the deletion and invalidates", async () => {
    const state = emptyState();
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const ops = makeOps(state, { auditSink: sink, snapshotInvalidator: invalidator });
    await expect(
      ops.deleteModel(writeAccess, "vendor", { modelId: "m-1", route: "/v1", enabled: true }),
    ).resolves.toEqual({ success: true });
    expect(entries).toEqual([
      { action: "provider.model.deleted", target: "vendor", detail: { modelId: "m-1", route: "/v1" } },
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("deleteModelsBulk", () => {
  test("rejects an empty list and an oversized list", async () => {
    const state = emptyState();
    const ops = makeOps(state);
    await expect(ops.deleteModelsBulk(writeAccess, "vendor", [])).rejects.toMatchObject({
      code: "invalid_request",
      status: 422,
      message: "items must be a non-empty array up to 1000 entries",
    });
    const tooMany: SetModelEnabledRequest[] = Array.from({ length: 1001 }, (_unused, index) => ({
      modelId: `m-${index}`,
      route: "",
      enabled: false,
    }));
    await expect(ops.deleteModelsBulk(writeAccess, "vendor", tooMany)).rejects.toMatchObject({
      code: "invalid_request",
      status: 422,
    });
    expect(state.deleted).toEqual([]);
  });

  test("accumulates per-item failures and audits only when something was deleted", async () => {
    const state = emptyState({
      deleteResults: new Map([["gone", false]]),
    });
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const ops = makeOps(state, { auditSink: sink, snapshotInvalidator: invalidator });

    const result = await ops.deleteModelsBulk(writeAccess, "vendor", [
      { modelId: "kept", route: "/v1", enabled: false },
      { modelId: "gone", route: "/v1", enabled: false },
    ]);

    expect(result).toEqual({
      deleted: 1,
      total: 2,
      failures: [{ modelId: "gone", route: "/v1", code: "model_not_found", message: "Model gone not found" }],
    });
    expect(entries).toEqual([
      { action: "provider.models.bulk_deleted", target: "vendor", detail: { deleted: 1, total: 2 } },
    ]);
    expect(calls).toHaveLength(1);
  });

  test("records a ConsoleDomainError as a failure and rethrows anything else", async () => {
    const state = emptyState({
      deleteErrors: new Map([
        ["guarded", new ConsoleDomainError("model_in_use", 409, "still in use")],
      ]),
    });
    const { sink, entries } = makeAuditSink();
    const { invalidator, calls } = makeInvalidator();
    const ops = makeOps(state, { auditSink: sink, snapshotInvalidator: invalidator });

    // The rethrow case first: a plain Error is not a per-item failure.
    state.deleteErrors.set("boom", new Error("upstream exploded"));
    await expect(
      ops.deleteModelsBulk(writeAccess, "vendor", [{ modelId: "boom", route: "", enabled: false }]),
    ).rejects.toThrow("upstream exploded");
    expect(entries).toEqual([]);

    state.deleteErrors.delete("boom");
    const result = await ops.deleteModelsBulk(writeAccess, "vendor", [
      { modelId: "guarded", route: "/v1", enabled: false },
    ]);
    expect(result).toEqual({
      deleted: 0,
      total: 1,
      failures: [{ modelId: "guarded", route: "/v1", code: "model_in_use", message: "still in use" }],
    });
    // Nothing deleted, so no audit entry and no invalidation.
    expect(entries).toEqual([]);
    expect(calls).toEqual([]);
  });
});
