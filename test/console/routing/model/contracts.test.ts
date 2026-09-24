import { describe, expect, test } from "bun:test";
import {
  createModelRoutingOperations,
  type ModelAliasCreateInput,
  type ModelAliasPatchInput,
  type ModelAliasRow,
  type ModelComboCreateInput,
  type ModelComboPatchInput,
  type ModelComboRow,
  type ModelRoutingStore,
} from "../../../../src/console/routing/model/contracts";
import type { AccessDecision } from "../../../../src/security/access-control";

describe("model-routing.test.ts", () => {
const access: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
    admissionIdentity: "key-1",
};

const readOnly: AccessDecision = {
  ...access,
  scopes: ["dashboard:read"],
};

const platformAccess: AccessDecision = {
  ...access,
  tenantId: null,
  scopes: ["platform:admin", "dashboard:read", "dashboard:write"],
};

function makeStore(knownModels: readonly string[] = ["claude-sonnet-4-5", "gpt-4"]): {
  store: ModelRoutingStore;
  aliasRows: ModelAliasRow[];
  comboRows: ModelComboRow[];
} {
  const aliasRows: ModelAliasRow[] = [];
  const comboRows: ModelComboRow[] = [];
  const store: ModelRoutingStore = {
    async listAliases(tenantId) {
      return aliasRows.filter((r) => r.tenantId === tenantId);
    },
    async createAlias(tenantId, input: ModelAliasCreateInput) {
      const row: ModelAliasRow = {
        id: crypto.randomUUID(),
        tenantId,
        alias: input.alias,
        targetModel: input.targetModel,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      aliasRows.push(row);
      return row;
    },
    async updateAlias(tenantId, id, patch: ModelAliasPatchInput) {
      const idx = aliasRows.findIndex((r) => r.tenantId === tenantId && r.id === id);
      if (idx === -1) return undefined;
      const merged: ModelAliasRow = {
        ...aliasRows[idx]!,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      aliasRows[idx] = merged;
      return merged;
    },
    async deleteAlias(tenantId, id) {
      const idx = aliasRows.findIndex((r) => r.tenantId === tenantId && r.id === id);
      if (idx === -1) return false;
      aliasRows.splice(idx, 1);
      return true;
    },
    async listCombos(tenantId) {
      return comboRows.filter((r) => r.tenantId === tenantId);
    },
    async createCombo(tenantId, input: ModelComboCreateInput) {
      const row: ModelComboRow = {
        id: crypto.randomUUID(),
        tenantId,
        name: input.name,
        members: [...input.members],
        strategy: input.strategy ?? "fallback",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      comboRows.push(row);
      return row;
    },
    async updateCombo(tenantId, id, patch: ModelComboPatchInput) {
      const idx = comboRows.findIndex((r) => r.tenantId === tenantId && r.id === id);
      if (idx === -1) return undefined;
      const merged: ModelComboRow = {
        ...comboRows[idx]!,
        ...(patch.members === undefined ? {} : { members: [...patch.members] }),
        ...(patch.strategy === undefined ? {} : { strategy: patch.strategy }),
        updatedAt: new Date().toISOString(),
      };
      comboRows[idx] = merged;
      return merged;
    },
    async deleteCombo(tenantId, id) {
      const idx = comboRows.findIndex((r) => r.tenantId === tenantId && r.id === id);
      if (idx === -1) return false;
      comboRows.splice(idx, 1);
      return true;
    },
    async isKnownModel(_tenantId, modelId) {
      return knownModels.includes(modelId);
    },
    async areKnownModels(_tenantId, modelIds) {
      return new Set(modelIds.filter((id) => knownModels.includes(id)));
    },
  };
  return { store, aliasRows, comboRows };
}

describe("model routing domain factory — aliases", () => {
  test("listAliases requires dashboard:read + tenant", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(factory.listAliases(undefined)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
    await expect(factory.listAliases(platformAccess)).rejects.toMatchObject({
      code: "tenant_required",
      status: 403,
    });
    await expect(factory.listAliases(access)).resolves.toEqual([]);
  });

  test("createAlias rejects empty fields, self-reference, unresolved target; succeeds for known model", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(
      factory.createAlias(access, { alias: "", targetModel: "gpt-4" }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 422 });
    await expect(
      factory.createAlias(access, { alias: "fast", targetModel: "fast" }),
    ).rejects.toMatchObject({ code: "self_reference", status: 422 });
    await expect(
      factory.createAlias(access, { alias: "fast", targetModel: "unknown-model" }),
    ).rejects.toMatchObject({ code: "unresolved_target", status: 422 });
    const created = await factory.createAlias(access, { alias: "fast", targetModel: "gpt-4" });
    expect(created.alias).toBe("fast");
    expect(created.targetModel).toBe("gpt-4");
  });

  test("createAlias rejects duplicate alias and alias cycles", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await factory.createAlias(access, { alias: "fast", targetModel: "gpt-4" });
    await expect(
      factory.createAlias(access, { alias: "fast", targetModel: "claude-sonnet-4-5" }),
    ).rejects.toMatchObject({ code: "alias_conflict", status: 409 });
    await factory.createAlias(access, { alias: "quick", targetModel: "fast" });
    // quick -> fast -> gpt-4; creating gpt-4 -> quick would close the loop.
    await expect(
      factory.createAlias(access, { alias: "gpt-4", targetModel: "quick" }),
    ).rejects.toMatchObject({ code: "alias_cycle", status: 422 });
  });

  test("updateAlias validates self-reference/cycle/unresolved target; 404 on missing", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    const row = await factory.createAlias(access, { alias: "fast", targetModel: "gpt-4" });
    await expect(
      factory.updateAlias(access, crypto.randomUUID(), { targetModel: "gpt-4" }),
    ).rejects.toMatchObject({ code: "alias_not_found", status: 404 });
    await expect(
      factory.updateAlias(access, row.id, { targetModel: "fast" }),
    ).rejects.toMatchObject({ code: "self_reference", status: 422 });
    await expect(
      factory.updateAlias(access, row.id, { targetModel: "unknown-model" }),
    ).rejects.toMatchObject({ code: "unresolved_target", status: 422 });
    const updated = await factory.updateAlias(access, row.id, { targetModel: "claude-sonnet-4-5" });
    expect(updated.targetModel).toBe("claude-sonnet-4-5");
  });

  test("deleteAlias returns 404 for missing, success otherwise", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(factory.deleteAlias(access, crypto.randomUUID())).rejects.toMatchObject({
      code: "alias_not_found",
      status: 404,
    });
    const row = await factory.createAlias(access, { alias: "fast", targetModel: "gpt-4" });
    await expect(factory.deleteAlias(access, row.id)).resolves.toEqual({ success: true });
  });

  test("write routes reject read-only scope", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(
      factory.createAlias(readOnly, { alias: "fast", targetModel: "gpt-4" }),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
  });
});

describe("model routing domain factory — combos", () => {
  test("listCombos requires dashboard:read + tenant", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(factory.listCombos(undefined)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
    await expect(factory.listCombos(platformAccess)).rejects.toMatchObject({
      code: "tenant_required",
      status: 403,
    });
    await expect(factory.listCombos(access)).resolves.toEqual([]);
  });

  test("createCombo rejects empty name, zero members, blank member, unresolved member; defaults strategy", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(
      factory.createCombo(access, { name: "", members: ["gpt-4"] }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 422 });
    await expect(factory.createCombo(access, { name: "pool", members: [] })).rejects.toMatchObject({
      code: "invalid_request",
      status: 422,
    });
    await expect(
      factory.createCombo(access, { name: "pool", members: ["  "] }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 422 });
    await expect(
      factory.createCombo(access, { name: "pool", members: ["unknown-model"] }),
    ).rejects.toMatchObject({
      code: "unresolved_member",
      status: 422,
      details: { member: "unknown-model" },
    });
    const created = await factory.createCombo(access, {
      name: "pool",
      members: ["gpt-4", "claude-sonnet-4-5"],
    });
    expect(created.strategy).toBe("fallback");
    expect(created.members).toEqual(["gpt-4", "claude-sonnet-4-5"]);
  });

  test("createCombo rejects duplicate name and honors explicit strategy", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    const created = await factory.createCombo(access, {
      name: "pool",
      members: ["gpt-4"],
      strategy: "round_robin",
    });
    expect(created.strategy).toBe("round_robin");
    await expect(
      factory.createCombo(access, { name: "pool", members: ["gpt-4"] }),
    ).rejects.toMatchObject({ code: "combo_conflict", status: 409 });
  });

  test("createCombo allows a member that is a known alias or another combo", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await factory.createAlias(access, { alias: "fast", targetModel: "gpt-4" });
    await factory.createCombo(access, { name: "base", members: ["gpt-4"] });
    const created = await factory.createCombo(access, { name: "pool", members: ["fast", "base"] });
    expect(created.members).toEqual(["fast", "base"]);
  });

  test("createCombo rejects a member that is a combo containing another combo (2+ level nesting)", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await factory.createCombo(access, { name: "inner", members: ["gpt-4"] });
    await factory.createCombo(access, { name: "middle", members: ["inner"] });
    await expect(
      factory.createCombo(access, { name: "outer", members: ["middle"] }),
    ).rejects.toMatchObject({ code: "combo_nesting_too_deep", status: 422 });
  });

  test("createCombo rejects a member equal to the combo being saved (self-reference)", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(
      factory.createCombo(access, { name: "pool", members: ["pool"] }),
    ).rejects.toMatchObject({ code: "unresolved_member", status: 422 });
  });

  test("updateCombo validates member changes; 404 on missing", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    const row = await factory.createCombo(access, { name: "pool", members: ["gpt-4"] });
    await expect(
      factory.updateCombo(access, crypto.randomUUID(), { strategy: "round_robin" }),
    ).rejects.toMatchObject({ code: "combo_not_found", status: 404 });
    await expect(
      factory.updateCombo(access, row.id, { members: ["unknown-model"] }),
    ).rejects.toMatchObject({ code: "unresolved_member", status: 422 });
    const updated = await factory.updateCombo(access, row.id, { strategy: "round_robin" });
    expect(updated.strategy).toBe("round_robin");
    expect(updated.members).toEqual(["gpt-4"]);
  });

  test("deleteCombo returns 404 for missing, success otherwise", async () => {
    const { store } = makeStore();
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(factory.deleteCombo(access, crypto.randomUUID())).rejects.toMatchObject({
      code: "combo_not_found",
      status: 404,
    });
    const row = await factory.createCombo(access, { name: "pool", members: ["gpt-4"] });
    await expect(factory.deleteCombo(access, row.id)).resolves.toEqual({ success: true });
  });
});

describe("model routing domain factory — batched validation (N+1 fix)", () => {
  test("createCombo validates N members with exactly ONE areKnownModels call (not N)", async () => {
    const { store } = makeStore(["m1", "m2", "m3", "m4", "m5"]);
    let areKnownCalls = 0;
    let isKnownCalls = 0;
    const origAreKnown = store.areKnownModels.bind(store);
    store.areKnownModels = async (tenantId, modelIds) => {
      areKnownCalls++;
      // Ensure batch contains all needing DB check (deduplicated)
      expect(modelIds.length).toBeGreaterThan(1);
      return origAreKnown(tenantId, modelIds);
    };
    const origIsKnown = store.isKnownModel.bind(store);
    store.isKnownModel = async (tenantId, modelId) => {
      isKnownCalls++;
      return origIsKnown(tenantId, modelId);
    };
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    // 5 members, none are aliases/combos — the batch path would call isKnownModel 5 times.
    // New code must call areKnownModels exactly once and isKnownModel zero times for this path.
    const created = await factory.createCombo(access, {
      name: "pool",
      members: ["m1", "m2", "m3", "m4", "m5"],
    });
    expect(created.members).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(areKnownCalls).toBe(1);
    expect(isKnownCalls).toBe(0);
  });

  test("createCombo batch still throws same unresolved_member error on invalid model", async () => {
    const { store } = makeStore(["m1", "m2"]);
    let areKnownCalls = 0;
    const orig = store.areKnownModels.bind(store);
    store.areKnownModels = async (tenantId, modelIds) => {
      areKnownCalls++;
      return orig(tenantId, modelIds);
    };
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await expect(
      factory.createCombo(access, { name: "pool", members: ["m1", "unknown-model", "m2"] }),
    ).rejects.toMatchObject({
      code: "unresolved_member",
      status: 422,
      details: { member: "unknown-model" },
    });
    expect(areKnownCalls).toBe(1);
  });

  test("updateCombo validates N members with exactly ONE areKnownModels call", async () => {
    const { store } = makeStore(["m1", "m2", "m3"]);
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    const combo = await factory.createCombo(access, { name: "pool", members: ["m1"] });
    let areKnownCalls = 0;
    const orig = store.areKnownModels.bind(store);
    store.areKnownModels = async (tenantId, modelIds) => {
      areKnownCalls++;
      return orig(tenantId, modelIds);
    };
    const updated = await factory.updateCombo(access, combo.id, {
      members: ["m1", "m2", "m3"],
    });
    expect(updated.members).toEqual(["m1", "m2", "m3"]);
    expect(areKnownCalls).toBe(1);
  });

  test("createCombo skips DB call entirely when all members are aliases/combos", async () => {
    const { store } = makeStore(["m1"]);
    const factory = createModelRoutingOperations({ store, accessResolver: () => access });
    await factory.createAlias(access, { alias: "fast", targetModel: "m1" });
    await factory.createCombo(access, { name: "base", members: ["m1"] });
    let areKnownCalls = 0;
    const orig = store.areKnownModels.bind(store);
    store.areKnownModels = async (tenantId, modelIds) => {
      areKnownCalls++;
      return orig(tenantId, modelIds);
    };
    const created = await factory.createCombo(access, { name: "pool", members: ["fast", "base"] });
    expect(created.members).toEqual(["fast", "base"]);
    expect(areKnownCalls).toBe(0);
  });
});

describe("model routing domain factory — audit + snapshot invalidation", () => {
  test("snapshotInvalidator.invalidate is called exactly once per successful mutation", async () => {
    const { store } = makeStore();
    let invalidateCount = 0;
    const events: string[] = [];
    const factory = createModelRoutingOperations({
      store,
      accessResolver: () => access,
      auditSink: {
        async record(e) {
          events.push(e.action);
        },
      },
      snapshotInvalidator: {
        async invalidate() {
          invalidateCount += 1;
          return invalidateCount;
        },
      },
    });
    const alias = await factory.createAlias(access, { alias: "fast", targetModel: "gpt-4" });
    expect(invalidateCount).toBe(1);
    await factory.updateAlias(access, alias.id, { targetModel: "claude-sonnet-4-5" });
    expect(invalidateCount).toBe(2);
    const combo = await factory.createCombo(access, { name: "pool", members: ["gpt-4"] });
    expect(invalidateCount).toBe(3);
    await factory.updateCombo(access, combo.id, { strategy: "round_robin" });
    expect(invalidateCount).toBe(4);
    await factory.deleteCombo(access, combo.id);
    expect(invalidateCount).toBe(5);
    await factory.deleteAlias(access, alias.id);
    expect(invalidateCount).toBe(6);
    expect(events).toEqual([
      "model_alias.created",
      "model_alias.updated",
      "model_combo.created",
      "model_combo.updated",
      "model_combo.deleted",
      "model_alias.deleted",
    ]);
  });
});
});

