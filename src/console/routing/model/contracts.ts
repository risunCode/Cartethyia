// Model routing control-plane contracts: the alias/combo shapes, the store
// interface, and the shared alias-graph validation every surface uses.
// Elysia-free on purpose: the dashboard imports these types, and `routes.ts`
// is the only module allowed to touch the HTTP layer.
import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
import type { ComboStrategy } from "../../../persistence/schema";

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
  /** New alias name; references from other aliases and combos are rewritten. */
  readonly alias?: string;
  readonly targetModel?: string;
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
  /** New combo name; references from aliases and other combos are rewritten. */
  readonly name?: string;
  readonly members?: readonly string[];
  readonly strategy?: ComboStrategy;
}

/** Result of cloning a combo: the new row plus any members that were dropped. */
export interface ModelComboCloneResult {
  readonly combo: ModelComboRow;
  /**
   * Members of the source combo that no longer resolve to an alias, combo, or
   * model and were therefore left out of the clone. Empty when the source was
   * fully intact.
   */
  readonly skippedMembers: readonly string[];
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
  reorderAliases(tenantId: string, ids: readonly string[]): Promise<void>;
  listCombos(tenantId: string): Promise<readonly ModelComboRow[]>;
  createCombo(tenantId: string, input: ModelComboCreateInput): Promise<ModelComboRow>;
  updateCombo(
    tenantId: string,
    id: string,
    patch: ModelComboPatchInput,
  ): Promise<ModelComboRow | undefined>;
  /**
   * Renames a combo and rewrites every reference to its old name — aliases
   * whose `targetModel` names it, and other combos that list it as a member —
   * in one transaction, so no reference is left dangling.
   */
  renameCombo(
    tenantId: string,
    id: string,
    nextName: string,
  ): Promise<ModelComboRow | undefined>;
  deleteCombo(tenantId: string, id: string): Promise<boolean>;
  reorderCombos(tenantId: string, ids: readonly string[]): Promise<void>;
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
export function aliasCycleExists(
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
export async function targetResolves(
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

/**
 * Partitions a combo's member list into the members that still resolve and the
 * ones that do not, given the tenant's current aliases/combos/models.
 *
 * A combo stores its members as plain names, so a member that resolved when the
 * combo was written can go dangling later — the model was renamed, removed, or
 * disabled. Such a member is not an operator error to reject on every subsequent
 * edit: it must be skippable so an unrelated change (rename, strategy, clone) is
 * not blocked by a stale entry the operator cannot see. Members that name this
 * same combo are treated as unresolvable too (self-reference).
 */
export async function partitionResolvableMembers(
  deps: ModelRoutingConfig,
  tenantId: string,
  members: readonly string[],
  selfName: string,
  aliases: readonly ModelAliasRow[],
  combos: readonly ModelComboRow[],
): Promise<{ readonly resolvable: readonly string[]; readonly dangling: readonly string[] }> {
  const aliasSet = new Set(aliases.map((r) => r.alias));
  const comboSet = new Set(combos.map((c) => c.name));
  const needingDbCheck = [
    ...new Set(
      members.filter((m) => m !== selfName && !aliasSet.has(m) && !comboSet.has(m)),
    ),
  ];
  const knownModels =
    needingDbCheck.length > 0
      ? await deps.store.areKnownModels(tenantId, needingDbCheck)
      : new Set<string>();
  const resolvable: string[] = [];
  const dangling: string[] = [];
  for (const member of members) {
    if (member === selfName) {
      dangling.push(member);
      continue;
    }
    if (comboSet.has(member) || aliasSet.has(member) || knownModels.has(member)) {
      resolvable.push(member);
      continue;
    }
    dangling.push(member);
  }
  return { resolvable, dangling };
}

