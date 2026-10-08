// Model routing control-plane operations: the store-backed alias and combo
// mutations behind the routes. Depends only on the contracts; `routes.ts`
// is the only HTTP surface.
import { ConsoleDomainError, requireTenantScope } from "../../shared/errors";
import type { AccessDecision } from "../../../security/access-control";
import {
  aliasCycleExists,
  partitionResolvableMembers,
  targetResolves,
  type ModelAliasCreateInput,
  type ModelAliasPatchInput,
  type ModelAliasRow,
  type ModelComboCloneResult,
  type ModelComboCreateInput,
  type ModelComboPatchInput,
  type ModelComboRow,
  type ModelRoutingConfig,
} from "./contracts";

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
        const existing = await deps.store.listAliases(tenantId);
        const current = existing.find((row) => row.id === id);
        if (!current) throw new ConsoleDomainError("alias_not_found", 404, `Alias ${id} not found`);

        // Renaming: validate uniqueness up front (the DB unique index would
        // otherwise surface as an opaque 500) and let the store cascade the
        // reference rewrite through alias chains and combo members.
        let nextAlias: string | undefined;
        if (patch.alias !== undefined) {
          const trimmed = patch.alias.trim();
          if (!trimmed) throw new ConsoleDomainError("invalid_request", 422, "alias cannot be empty");
          if (trimmed !== current.alias) {
            if (existing.some((row) => row.alias === trimmed))
              throw new ConsoleDomainError(
                "alias_conflict",
                409,
                `Alias ${trimmed} already exists for this tenant`,
              );
            nextAlias = trimmed;
          }
        }

        const targetModel = patch.targetModel?.trim();
        // Validation must see the post-rename view: a target naming the alias's
        // own new name would otherwise look unrelated instead of self-referencing.
        const nameForValidation = nextAlias ?? current.alias;
        if (targetModel !== undefined) {
          if (!targetModel)
            throw new ConsoleDomainError("invalid_request", 422, "targetModel cannot be empty");
          if (nameForValidation === targetModel)
            throw new ConsoleDomainError("self_reference", 422, "alias cannot target itself");
          const aliasesForValidation =
            nextAlias === undefined
              ? existing
              : existing.map((row) => (row.id === id ? { ...row, alias: nextAlias } : row));
          if (aliasCycleExists(aliasesForValidation, nameForValidation, targetModel))
            throw new ConsoleDomainError("alias_cycle", 422, "alias target introduces a cycle");
          const combos = await deps.store.listCombos(tenantId);
          if (!(await targetResolves(deps.store, tenantId, targetModel, aliasesForValidation, combos)))
            throw new ConsoleDomainError(
              "unresolved_target",
              422,
              `targetModel ${targetModel} does not resolve to a known model or combo`,
            );
        }

        const updated = await deps.store.updateAlias(tenantId, id, {
          ...(nextAlias === undefined ? {} : { alias: nextAlias }),
          ...(targetModel === undefined ? {} : { targetModel }),
        });
        if (!updated) throw new ConsoleDomainError("alias_not_found", 404, `Alias ${id} not found`);
        await deps.auditSink?.record({
          access: a,
          action: "model_alias.updated",
          target: id,
          detail: { alias: updated.alias, targetModel: updated.targetModel },
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
    /** Persists a new alias order. `ids` must name every alias the tenant has,
        so a partial list cannot silently drop rows to index 0. */
    async reorderAliases(access: AccessDecision | undefined, ids: readonly string[]): Promise<void> {
        const a = requireTenantScope(access, "dashboard:write");
        const tenantId = a.tenantId;
        const existing = await deps.store.listAliases(tenantId);
        const existingIds = new Set(existing.map((row) => row.id));
        const seen = new Set<string>();
        for (const id of ids) {
          if (!existingIds.has(id))
            throw new ConsoleDomainError("unknown_alias", 404, `Alias not found: ${id}`);
          if (seen.has(id))
            throw new ConsoleDomainError("invalid_request", 422, `Duplicate alias id: ${id}`);
          seen.add(id);
        }
        if (seen.size !== existingIds.size)
          throw new ConsoleDomainError(
            "invalid_request",
            422,
            "Reorder must list every alias exactly once",
          );
        await deps.store.reorderAliases(tenantId, ids);
      },
    async listCombos(access: AccessDecision | undefined): Promise<readonly ModelComboRow[]> {
        const a = requireTenantScope(access, "dashboard:read");
        return deps.store.listCombos(a.tenantId);
      },
    /** Persists a new combo order; see {@link reorderAliases}. */
    async reorderCombos(access: AccessDecision | undefined, ids: readonly string[]): Promise<void> {
        const a = requireTenantScope(access, "dashboard:write");
        const tenantId = a.tenantId;
        const existing = await deps.store.listCombos(tenantId);
        const existingIds = new Set(existing.map((row) => row.id));
        const seen = new Set<string>();
        for (const id of ids) {
          if (!existingIds.has(id))
            throw new ConsoleDomainError("unknown_combo", 404, `Combo not found: ${id}`);
          if (seen.has(id))
            throw new ConsoleDomainError("invalid_request", 422, `Duplicate combo id: ${id}`);
          seen.add(id);
        }
        if (seen.size !== existingIds.size)
          throw new ConsoleDomainError(
            "invalid_request",
            422,
            "Reorder must list every combo exactly once",
          );
        await deps.store.reorderCombos(tenantId, ids);
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
    /**
     * Clones a combo: same strategy, and every member that still resolves.
     *
     * A clone is a copy of the source, not a re-validation of it. A source combo
     * can carry members that have since gone dangling (its model was renamed or
     * removed) — those are dropped from the clone and reported in
     * `skippedMembers` rather than failing the whole operation, because the
     * operator asked to copy a combo, not to be blocked by a stale entry they
     * cannot see. If every member is dangling the clone is refused: an empty
     * combo serves nothing, so there is no useful copy to make.
     *
     * The name is `${source}-clone`, suffixed `-2`, `-3`, … until free, resolved
     * here rather than in the client so two concurrent clones cannot pick the
     * same name.
     */
    async cloneCombo(
        access: AccessDecision | undefined,
        id: string,
      ): Promise<ModelComboCloneResult> {
        const a = requireTenantScope(access, "dashboard:write");
        const tenantId = a.tenantId;
        const [existingAliases, existingCombos] = await Promise.all([
          deps.store.listAliases(tenantId),
          deps.store.listCombos(tenantId),
        ]);
        const source = existingCombos.find((c) => c.id === id);
        if (!source) throw new ConsoleDomainError("combo_not_found", 404, `Combo ${id} not found`);

        const { resolvable, dangling } = await partitionResolvableMembers(
          deps,
          tenantId,
          source.members,
          source.name,
          existingAliases,
          existingCombos,
        );
        if (resolvable.length === 0)
          throw new ConsoleDomainError(
            "unresolved_member",
            422,
            `Every member of ${source.name} is unresolvable; nothing to clone`,
            { members: dangling },
          );

        const takenNames = new Set(existingCombos.map((c) => c.name));
        let name = `${source.name}-clone`;
        let suffix = 2;
        while (takenNames.has(name)) name = `${source.name}-clone-${suffix++}`;

        const created = await deps.store.createCombo(tenantId, {
          name,
          members: [...resolvable],
          strategy: source.strategy,
        });
        await deps.auditSink?.record({
          access: a,
          action: "model_combo.cloned",
          target: created.id,
          detail: { from: source.name, name: created.name, skippedMembers: dangling },
        });
        await deps.snapshotInvalidator?.invalidate();
        return { combo: created, skippedMembers: dangling };
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
        // Renaming: validate uniqueness up front (the DB unique index would
        // otherwise surface as an opaque 500) and cascade the reference rewrite
        // through `renameCombo` so aliases and nested combos follow the name.
        let nextName: string | undefined;
        if (patch.name !== undefined) {
          const trimmed = patch.name.trim();
          if (!trimmed) throw new ConsoleDomainError("invalid_request", 422, "name cannot be empty");
          if (trimmed !== current.name) {
            if (existing.some((c) => c.name === trimmed))
              throw new ConsoleDomainError(
                "combo_conflict",
                409,
                `Combo ${trimmed} already exists for this tenant`,
              );
            nextName = trimmed;
          }
        }
        if (nextName !== undefined) {
          const renamed = await deps.store.renameCombo(tenantId, id, nextName);
          if (!renamed) throw new ConsoleDomainError("combo_not_found", 404, `Combo ${id} not found`);
        }
        const renamedCurrent = nextName === undefined ? current : { ...current, name: nextName };
        // Validation must see the post-rename view: `existing` still carries the
        // old name, so a member naming the combo's new name would otherwise look
        // unknown, and a nested-combo check would test the stale name.
        const combosForValidation = nextName === undefined
          ? existing
          : existing.map((c) => (c.id === id ? { ...c, name: nextName } : c));
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
          const comboSetUp = new Set(combosForValidation.map((c) => c.name));
          // Grandfather the members the combo already had. A combo can carry a
          // member that resolved when it was written but has since gone dangling
          // (its model was renamed or removed). Re-validating the whole list on
          // every edit would block an unrelated change — a rename, a strategy
          // switch — behind a stale entry the operator never touched. Only the
          // members being newly introduced are validated.
          const alreadyMembers = new Set(current.members);
          const needingDbCheckUp = [
            ...new Set(
              trimmed.filter(
                (m) =>
                  m !== renamedCurrent.name &&
                  !alreadyMembers.has(m) &&
                  !aliasSetUp.has(m) &&
                  !comboSetUp.has(m),
              ),
            ),
          ];
          const knownModelsUp =
            needingDbCheckUp.length > 0
              ? await deps.store.areKnownModels(tenantId, needingDbCheckUp)
              : new Set<string>();
          for (const member of trimmed) {
            if (member === renamedCurrent.name)
              throw new ConsoleDomainError(
                "unresolved_member",
                422,
                `member ${member} does not resolve to a known alias, combo, or model`,
                { member },
              );
            // An existing member is kept as-is even if it no longer resolves.
            if (alreadyMembers.has(member)) continue;
            if (comboSetUp.has(member)) {
              const nested = combosForValidation.find((c) => c.name === member);
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
