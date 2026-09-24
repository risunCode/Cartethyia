import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
// Model routing control-plane contracts and routes.
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { Elysia, t } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import { modelComboStrategy, type ComboStrategy } from "../../../persistence/schema";

export type { ComboStrategy };

export interface ModelAliasRow {
  readonly id: string;
  readonly tenantId: string;
  readonly alias: string;
  readonly targetModel: string;
  readonly contextLimit?: number | null;
  readonly outputLimit?: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModelAliasCreateInput {
  readonly alias: string;
  readonly targetModel: string;
}

export interface ModelAliasPatchInput {
  readonly targetModel: string;
}

export interface ModelComboRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly members: readonly string[];
  readonly strategy: ComboStrategy;
  readonly contextLimit?: number | null;
  readonly outputLimit?: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModelComboCreateInput {
  readonly name: string;
  readonly members: readonly string[];
  readonly strategy?: ComboStrategy;
}

export interface ModelComboPatchInput {
  readonly members?: readonly string[];
  readonly strategy?: ComboStrategy;
}

export interface ModelRoutingStore {
  listAliases(tenantId: string): Promise<readonly ModelAliasRow[]>;
  createAlias(tenantId: string, input: ModelAliasCreateInput): Promise<ModelAliasRow>;
  updateAlias(
    tenantId: string,
    id: string,
    patch: ModelAliasPatchInput,
  ): Promise<ModelAliasRow | undefined>;
  deleteAlias(tenantId: string, id: string): Promise<boolean>;
  listCombos(tenantId: string): Promise<readonly ModelComboRow[]>;
  createCombo(tenantId: string, input: ModelComboCreateInput): Promise<ModelComboRow>;
  updateCombo(
    tenantId: string,
    id: string,
    patch: ModelComboPatchInput,
  ): Promise<ModelComboRow | undefined>;
  deleteCombo(tenantId: string, id: string): Promise<boolean>;
  isKnownModel(tenantId: string, modelId: string): Promise<boolean>;
  areKnownModels(tenantId: string, modelIds: readonly string[]): Promise<ReadonlySet<string>>;
}

/** Structurally satisfied by `InMemoryRouteSnapshotService` as-is — no import
 * of routing internals into the console domain layer. */
export interface ModelRoutingSnapshotInvalidator {
  invalidate(): Promise<number>;
}

export interface ModelRoutingConfig {
  readonly store: ModelRoutingStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
  readonly snapshotInvalidator?: ModelRoutingSnapshotInvalidator;
}

const MAX_ALIAS_DEPTH = 16;

/** Walks the alias chain from `targetModel`; `true` if `aliasName` would be
 * revisited or the chain exceeds the engine's own bound (mirrors `resolveAlias`). */
function aliasCycleExists(
  existing: readonly ModelAliasRow[],
  aliasName: string,
  targetModel: string,
): boolean {
  const byAlias = new Map(existing.map((row) => [row.alias, row.targetModel]));
  let current = targetModel;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    if (current === aliasName) return true;
    const next = byAlias.get(current);
    if (next === undefined) return false;
    current = next;
  }
  return true;
}

/** Walks the alias chain from `targetModel`; resolves `true` once it lands on
 * a known combo name or a known model (bounded depth 16). */
async function targetResolves(
  store: ModelRoutingStore,
  tenantId: string,
  targetModel: string,
  existing: readonly ModelAliasRow[],
  combos: readonly ModelComboRow[],
): Promise<boolean> {
  const byAlias = new Map(existing.map((row) => [row.alias, row.targetModel]));
  const comboNames = new Set(combos.map((c) => c.name));
  let current = targetModel;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    if (comboNames.has(current)) return true;
    const next = byAlias.get(current);
    if (next === undefined) return store.isKnownModel(tenantId, current);
    current = next;
  }
  return false;
}

export function createModelRoutingOperations(deps: ModelRoutingConfig) {
  const operations = {
    async listAliases(access: AccessDecision | undefined): Promise<readonly ModelAliasRow[]> {
        const a = requireTenantScope(access, "dashboard:read");
        return deps.store.listAliases(a.tenantId);
      },
    async createAlias(
        access: AccessDecision | undefined,
        input: ModelAliasCreateInput,
      ): Promise<ModelAliasRow> {
        const a = requireTenantScope(access, "dashboard:write");
        const tenantId = a.tenantId;
        const alias = input.alias?.trim();
        const targetModel = input.targetModel?.trim();
        if (!alias || !targetModel)
          throw new ConsoleDomainError("invalid_request", 422, "alias and targetModel are required");
        if (alias === targetModel)
          throw new ConsoleDomainError("self_reference", 422, "alias cannot target itself");
        const existing = await deps.store.listAliases(tenantId);
        if (existing.some((row) => row.alias === alias))
          throw new ConsoleDomainError(
            "alias_conflict",
            409,
            `Alias ${alias} already exists for this tenant`,
          );
        if (aliasCycleExists(existing, alias, targetModel))
          throw new ConsoleDomainError("alias_cycle", 422, "alias target introduces a cycle");
        const combos = await deps.store.listCombos(tenantId);
        if (!(await targetResolves(deps.store, tenantId, targetModel, existing, combos)))
          throw new ConsoleDomainError(
            "unresolved_target",
            422,
            `targetModel ${targetModel} does not resolve to a known model or combo`,
          );
        const created = await deps.store.createAlias(tenantId, { alias, targetModel });
        await deps.auditSink?.record({
          access: a,
          action: "model_alias.created",
          target: created.id,
          detail: { alias: created.alias, targetModel: created.targetModel },
        });
        await deps.snapshotInvalidator?.invalidate();
        return created;
      },
    async updateAlias(
        access: AccessDecision | undefined,
        id: string,
        patch: ModelAliasPatchInput,
      ): Promise<ModelAliasRow> {
        const a = requireTenantScope(access, "dashboard:write");
        const tenantId = a.tenantId;
        const targetModel = patch.targetModel?.trim();
        if (!targetModel)
          throw new ConsoleDomainError("invalid_request", 422, "targetModel is required");
        const existing = await deps.store.listAliases(tenantId);
        const current = existing.find((row) => row.id === id);
        if (!current) throw new ConsoleDomainError("alias_not_found", 404, `Alias ${id} not found`);
        if (current.alias === targetModel)
          throw new ConsoleDomainError("self_reference", 422, "alias cannot target itself");
        if (aliasCycleExists(existing, current.alias, targetModel))
          throw new ConsoleDomainError("alias_cycle", 422, "alias target introduces a cycle");
        const combos = await deps.store.listCombos(tenantId);
        if (!(await targetResolves(deps.store, tenantId, targetModel, existing, combos)))
          throw new ConsoleDomainError(
            "unresolved_target",
            422,
            `targetModel ${targetModel} does not resolve to a known model or combo`,
          );
        const updated = await deps.store.updateAlias(tenantId, id, { targetModel });
        if (!updated) throw new ConsoleDomainError("alias_not_found", 404, `Alias ${id} not found`);
        await deps.auditSink?.record({
          access: a,
          action: "model_alias.updated",
          target: id,
          detail: { targetModel: updated.targetModel },
        });
        await deps.snapshotInvalidator?.invalidate();
        return updated;
      },
    async deleteAlias(access: AccessDecision | undefined, id: string): Promise<{ success: boolean }> {
        const a = requireTenantScope(access, "dashboard:write");
        const ok = await deps.store.deleteAlias(a.tenantId, id);
        if (!ok) throw new ConsoleDomainError("alias_not_found", 404, `Alias ${id} not found`);
        await deps.auditSink?.record({ access: a, action: "model_alias.deleted", target: id });
        await deps.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async listCombos(access: AccessDecision | undefined): Promise<readonly ModelComboRow[]> {
        const a = requireTenantScope(access, "dashboard:read");
        return deps.store.listCombos(a.tenantId);
      },
    async createCombo(
        access: AccessDecision | undefined,
        input: ModelComboCreateInput,
      ): Promise<ModelComboRow> {
        const a = requireTenantScope(access, "dashboard:write");
        const tenantId = a.tenantId;
        const name = input.name?.trim();
        if (!name) throw new ConsoleDomainError("invalid_request", 422, "name is required");
        if (!Array.isArray(input.members) || input.members.length === 0)
          throw new ConsoleDomainError("invalid_request", 422, "members must be a non-empty array");
        const members = input.members.map((m) => m?.trim());
        if (members.some((m) => !m))
          throw new ConsoleDomainError("invalid_request", 422, "members cannot be empty");
        const [existingAliases, existingCombos] = await Promise.all([
          deps.store.listAliases(tenantId),
          deps.store.listCombos(tenantId),
        ]);
        if (existingCombos.some((c) => c.name === name))
          throw new ConsoleDomainError(
            "combo_conflict",
            409,
            `Combo ${name} already exists for this tenant`,
          );
        const aliasSet = new Set(existingAliases.map((r) => r.alias));
        const comboSet = new Set(existingCombos.map((c) => c.name));
        const needingDbCheck = [
          ...new Set(members.filter((m) => m !== name && !aliasSet.has(m) && !comboSet.has(m))),
        ];
        const knownModels =
          needingDbCheck.length > 0
            ? await deps.store.areKnownModels(tenantId, needingDbCheck)
            : new Set<string>();
        // Runtime combo expansion (`routing/engine.ts` RoutingEngine.plan) only
        // resolves one level of nested combo membership — a member that is
        // itself a combo has ITS members expanded once, but a member of THAT
        // combo which is in turn a combo is never expanded further. Allowing
        // deeper nesting at write time would silently produce dangling
        // "model ids" at dispatch time that never match a candidate. Reject
        // it here instead of letting it fail opaquely at request time.
        for (const member of members) {
          if (member === name)
            throw new ConsoleDomainError(
              "unresolved_member",
              422,
              `member ${member} does not resolve to a known alias, combo, or model`,
              { member },
            );
          if (comboSet.has(member)) {
            const nested = existingCombos.find((c) => c.name === member);
            if (nested?.members.some((nestedMember) => comboSet.has(nestedMember)))
              throw new ConsoleDomainError(
                "combo_nesting_too_deep",
                422,
                `member ${member} is a combo containing another combo; combos support only one level of nesting`,
                { member },
              );
            continue;
          }
          if (aliasSet.has(member)) continue;
          if (!knownModels.has(member))
            throw new ConsoleDomainError(
              "unresolved_member",
              422,
              `member ${member} does not resolve to a known alias, combo, or model`,
              { member },
            );
        }
        const strategy = input.strategy ?? "fallback";
        const created = await deps.store.createCombo(tenantId, { name, members, strategy });
        await deps.auditSink?.record({
          access: a,
          action: "model_combo.created",
          target: created.id,
          detail: { name: created.name, strategy: created.strategy },
        });
        await deps.snapshotInvalidator?.invalidate();
        return created;
      },
    async updateCombo(
        access: AccessDecision | undefined,
        id: string,
        patch: ModelComboPatchInput,
      ): Promise<ModelComboRow> {
        const a = requireTenantScope(access, "dashboard:write");
        const tenantId = a.tenantId;
        const existing = await deps.store.listCombos(tenantId);
        const current = existing.find((c) => c.id === id);
        if (!current) throw new ConsoleDomainError("combo_not_found", 404, `Combo ${id} not found`);
        let members: readonly string[] | undefined;
        if (patch.members !== undefined) {
          if (!Array.isArray(patch.members) || patch.members.length === 0)
            throw new ConsoleDomainError("invalid_request", 422, "members must be a non-empty array");
          const trimmed = patch.members.map((m) => m?.trim());
          if (trimmed.some((m) => !m))
            throw new ConsoleDomainError("invalid_request", 422, "members cannot be empty");
          members = trimmed;
          const existingAliases = await deps.store.listAliases(tenantId);
          const aliasSetUp = new Set(existingAliases.map((r) => r.alias));
          const comboSetUp = new Set(existing.map((c) => c.name));
          const needingDbCheckUp = [
            ...new Set(
              trimmed.filter((m) => m !== current.name && !aliasSetUp.has(m) && !comboSetUp.has(m)),
            ),
          ];
          const knownModelsUp =
            needingDbCheckUp.length > 0
              ? await deps.store.areKnownModels(tenantId, needingDbCheckUp)
              : new Set<string>();
          for (const member of trimmed) {
            if (member === current.name)
              throw new ConsoleDomainError(
                "unresolved_member",
                422,
                `member ${member} does not resolve to a known alias, combo, or model`,
                { member },
              );
            if (comboSetUp.has(member)) {
              const nested = existing.find((c) => c.name === member);
              if (nested?.members.some((nestedMember) => comboSetUp.has(nestedMember)))
                throw new ConsoleDomainError(
                  "combo_nesting_too_deep",
                  422,
                  `member ${member} is a combo containing another combo; combos support only one level of nesting`,
                  { member },
                );
              continue;
            }
            if (aliasSetUp.has(member)) continue;
            if (!knownModelsUp.has(member))
              throw new ConsoleDomainError(
                "unresolved_member",
                422,
                `member ${member} does not resolve to a known alias, combo, or model`,
                { member },
              );
          }
        }
        const updated = await deps.store.updateCombo(tenantId, id, {
          ...(members === undefined ? {} : { members }),
          ...(patch.strategy === undefined ? {} : { strategy: patch.strategy }),
        });
        if (!updated) throw new ConsoleDomainError("combo_not_found", 404, `Combo ${id} not found`);
        await deps.auditSink?.record({
          access: a,
          action: "model_combo.updated",
          target: id,
          detail: { fields: Object.keys(patch) },
        });
        await deps.snapshotInvalidator?.invalidate();
        return updated;
      },
    async deleteCombo(access: AccessDecision | undefined, id: string): Promise<{ success: boolean }> {
        const a = requireTenantScope(access, "dashboard:write");
        const ok = await deps.store.deleteCombo(a.tenantId, id);
        if (!ok) throw new ConsoleDomainError("combo_not_found", 404, `Combo ${id} not found`);
        await deps.auditSink?.record({ access: a, action: "model_combo.deleted", target: id });
        await deps.snapshotInvalidator?.invalidate();
        return { success: true };
      },
  };
  return operations;
}

function modelRoutingErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "Model routing operation failed");
}

// Compile-time parity: the combo validation schemas below must accept exactly
// the canonical ComboStrategy. Adding a combo strategy to the schema enum
// without updating these literals fails here.
type ExpectComboParity<T extends true> = T;
export type ComboSchemaParity = ExpectComboParity<
  [ComboStrategy] extends ["fallback" | "round_robin"]
    ? (["fallback" | "round_robin"] extends [ComboStrategy] ? true : false)
    : false
>;

const createAliasBody = t.Object({ alias: t.String(), targetModel: t.String() });
const updateAliasBody = t.Object({ targetModel: t.String() });
/** The combo-strategy enum's own values; see `ComboSchemaParity` above. */
const comboStrategySchema = literalUnion(modelComboStrategy.enumValues);
const createComboBody = t.Object({
  name: t.String(),
  members: t.Array(t.String(), { minItems: 1 }),
  strategy: t.Optional(comboStrategySchema),
});
const updateComboBody = t.Object({
  members: t.Optional(t.Array(t.String(), { minItems: 1 })),
  strategy: t.Optional(comboStrategySchema),
});

export function createModelRoutingRoutes(config: ModelRoutingConfig): Elysia {
  const factory = createModelRoutingOperations(config);
  return new Elysia({ prefix: "/routing" })
    .get("/aliases", async ({ request, set }) => {
      try {
        return await factory.listAliases(config.accessResolver(request));
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .post("/aliases", { body: createAliasBody }, async ({ request, body, set }) => {
      try {
        set.status = 201;
        return await factory.createAlias(config.accessResolver(request), body);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .patch("/aliases/:id", { body: updateAliasBody }, async ({ request, params, body, set }) => {
      try {
        return await factory.updateAlias(config.accessResolver(request), params.id, body);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .delete("/aliases/:id", async ({ request, params, set }) => {
      try {
        return await factory.deleteAlias(config.accessResolver(request), params.id);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .get("/combos", async ({ request, set }) => {
      try {
        return await factory.listCombos(config.accessResolver(request));
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .post("/combos", { body: createComboBody }, async ({ request, body, set }) => {
      try {
        set.status = 201;
        return await factory.createCombo(
          config.accessResolver(request),
          body as ModelComboCreateInput,
        );
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .patch("/combos/:id", { body: updateComboBody }, async ({ request, params, body, set }) => {
      try {
        return await factory.updateCombo(
          config.accessResolver(request),
          params.id,
          body as ModelComboPatchInput,
        );
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .delete("/combos/:id", async ({ request, params, set }) => {
      try {
        return await factory.deleteCombo(config.accessResolver(request), params.id);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    }) as unknown as Elysia;
}


