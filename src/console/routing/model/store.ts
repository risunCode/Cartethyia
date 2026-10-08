// Drizzle-backed console persistence for model routing (aliases + combos).
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { globalOrOwnedBy } from "../../../persistence/tenant-scope";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import {
  modelAliases,
  modelCombos,
  models,
  providers,
  type ModelAlias,
  type ModelCombo,
} from "../../../persistence/schema";
import type {
  ModelAliasCreateInput,
  ModelAliasPatchInput,
  ModelAliasRow,
  ModelComboCreateInput,
  ModelComboPatchInput,
  ModelComboRow,
  ModelRoutingStore,
} from "./contracts";
import { modelsDevCatalog } from "../../../providers/discovery/models-dev-catalog";
function mapAliasRow(row: ModelAlias): ModelAliasRow {
  const meta = modelsDevCatalog.resolve("", row.targetModel);
  return {
    id: row.id,
    tenantId: row.tenantId,
    alias: row.alias,
    targetModel: row.targetModel,
    contextLimit: meta?.contextLimit ?? 200_000,
    outputLimit: meta?.outputLimit ?? 64_192,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapComboRow(row: ModelCombo): ModelComboRow {
  const metas = row.members
    .map((m) => modelsDevCatalog.resolve("", m))
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  const contextLimit =
    metas.length > 0
      ? Math.min(...metas.map((m) => m.contextLimit ?? 200_000))
      : 200_000;

  const outputLimit =
    metas.length > 0
      ? Math.min(...metas.map((m) => m.outputLimit ?? 64_192))
      : 64_192;

  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    members: row.members,
    strategy: row.strategy,
    contextLimit,
    outputLimit,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Real Drizzle-backed model-aliasing/combos repository. */
export class DrizzleModelRoutingStore implements ModelRoutingStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async listAliases(tenantId: string): Promise<readonly ModelAliasRow[]> {
    // Ordered by the explicit `sort_index` so rows keep a stable position
    // across reloads instead of shifting on equal timestamps or updates.
    const rows = await this.db
      .select()
      .from(modelAliases)
      .where(eq(modelAliases.tenantId, tenantId))
      .orderBy(modelAliases.sortIndex, modelAliases.createdAt, modelAliases.id);
    return rows.map(mapAliasRow);
  }

  /** Rewrites alias order for one tenant; `ids` is the full desired order. */
  async reorderAliases(tenantId: string, ids: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [index, id] of ids.entries()) {
        await tx
          .update(modelAliases)
          .set({ sortIndex: index })
          .where(and(eq(modelAliases.tenantId, tenantId), eq(modelAliases.id, id)));
      }
    });
  }

  /** Next free list position for a new alias in this tenant. */
  private async nextAliasSortIndex(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({ max: sql<number>`coalesce(max(${modelAliases.sortIndex}), -1)` })
      .from(modelAliases)
      .where(eq(modelAliases.tenantId, tenantId));
    return Number(rows[0]?.max ?? -1) + 1;
  }

  async createAlias(tenantId: string, input: ModelAliasCreateInput): Promise<ModelAliasRow> {
    // Append rather than key off creation time, so existing rows never move.
    const sortIndex = await this.nextAliasSortIndex(tenantId);
    const rows = await this.db
      .insert(modelAliases)
      .values({ tenantId, alias: input.alias, targetModel: input.targetModel, sortIndex })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("model alias insert returned no row");
    return mapAliasRow(row);
  }

  /**
   * Renames an alias and rewrites every reference to its old name.
   *
   * Two referrer shapes point at an alias by name: another alias's
   * `target_model` (a single value) and a combo's `members` (a JSONB array).
   * Both are rewritten in one transaction — a rename that left a stale
   * reference would silently break resolution for whoever used the old name.
   */
  async renameAlias(
    tenantId: string,
    id: string,
    nextAlias: string,
  ): Promise<ModelAliasRow | undefined> {
    return this.db.transaction(async (tx) => {
      const currentRows = await tx
        .select()
        .from(modelAliases)
        .where(and(eq(modelAliases.tenantId, tenantId), eq(modelAliases.id, id)))
        .limit(1);
      const current = currentRows[0];
      if (!current) return undefined;
      const oldAlias = current.alias;
      if (oldAlias === nextAlias) return mapAliasRow(current);

      const updatedRows = await tx
        .update(modelAliases)
        .set({ alias: nextAlias, updatedAt: new Date() })
        .where(and(eq(modelAliases.tenantId, tenantId), eq(modelAliases.id, id)))
        .returning();
      const updated = updatedRows[0];
      if (!updated) return undefined;

      // Alias chains: another alias targeting this one by name now points at
      // the new name, so the chain stays intact.
      await tx
        .update(modelAliases)
        .set({ targetModel: nextAlias, updatedAt: new Date() })
        .where(
          and(eq(modelAliases.tenantId, tenantId), eq(modelAliases.targetModel, oldAlias)),
        );

      // Combo members: `members` is a JSONB text array, so the rewrite has to
      // replace the element in place rather than overwrite the whole column.
      const comboRows = await tx
        .select({ id: modelCombos.id, members: modelCombos.members })
        .from(modelCombos)
        .where(eq(modelCombos.tenantId, tenantId));
      for (const combo of comboRows) {
        if (!combo.members.includes(oldAlias)) continue;
        const nextMembers = combo.members.map((m) => (m === oldAlias ? nextAlias : m));
        await tx
          .update(modelCombos)
          .set({ members: nextMembers, updatedAt: new Date() })
          .where(and(eq(modelCombos.tenantId, tenantId), eq(modelCombos.id, combo.id)));
      }

      return mapAliasRow(updated);
    });
  }

  async updateAlias(
    tenantId: string,
    id: string,
    patch: ModelAliasPatchInput,
  ): Promise<ModelAliasRow | undefined> {
    if (patch.alias !== undefined) return this.renameAlias(tenantId, id, patch.alias);
    const rows = await this.db
      .update(modelAliases)
      .set({ targetModel: patch.targetModel, updatedAt: new Date() })
      .where(and(eq(modelAliases.tenantId, tenantId), eq(modelAliases.id, id)))
      .returning();
    const row = rows[0];
    return row ? mapAliasRow(row) : undefined;
  }

  async deleteAlias(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(modelAliases)
      .where(and(eq(modelAliases.tenantId, tenantId), eq(modelAliases.id, id)))
      .returning({ id: modelAliases.id });
    return rows.length > 0;
  }

  async listCombos(tenantId: string): Promise<readonly ModelComboRow[]> {
    const rows = await this.db
      .select()
      .from(modelCombos)
      .where(eq(modelCombos.tenantId, tenantId))
      .orderBy(modelCombos.sortIndex, modelCombos.createdAt, modelCombos.id);
    return rows.map(mapComboRow);
  }

  /** Rewrites combo order for one tenant; `ids` is the full desired order. */
  async reorderCombos(tenantId: string, ids: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [index, id] of ids.entries()) {
        await tx
          .update(modelCombos)
          .set({ sortIndex: index })
          .where(and(eq(modelCombos.tenantId, tenantId), eq(modelCombos.id, id)));
      }
    });
  }

  /** Next free list position for a new combo in this tenant. */
  private async nextComboSortIndex(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({ max: sql<number>`coalesce(max(${modelCombos.sortIndex}), -1)` })
      .from(modelCombos)
      .where(eq(modelCombos.tenantId, tenantId));
    return Number(rows[0]?.max ?? -1) + 1;
  }

  async createCombo(tenantId: string, input: ModelComboCreateInput): Promise<ModelComboRow> {
    const sortIndex = await this.nextComboSortIndex(tenantId);
    const rows = await this.db
      .insert(modelCombos)
      .values({
        tenantId,
        name: input.name,
        members: [...input.members],
        strategy: input.strategy ?? "fallback",
        sortIndex,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("model combo insert returned no row");
    return mapComboRow(row);
  }

  async updateCombo(
    tenantId: string,
    id: string,
    patch: ModelComboPatchInput,
  ): Promise<ModelComboRow | undefined> {
    const rows = await this.db
      .update(modelCombos)
      .set({
        updatedAt: new Date(),
        ...(patch.members === undefined ? {} : { members: [...patch.members] }),
        ...(patch.strategy === undefined ? {} : { strategy: patch.strategy }),
      })
      .where(and(eq(modelCombos.tenantId, tenantId), eq(modelCombos.id, id)))
      .returning();
    const row = rows[0];
    return row ? mapComboRow(row) : undefined;
  }

  async deleteCombo(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(modelCombos)
      .where(and(eq(modelCombos.tenantId, tenantId), eq(modelCombos.id, id)))
      .returning({ id: modelCombos.id });
    return rows.length > 0;
  }

  /**
   * Renames a combo and rewrites every reference to its old name in one
   * transaction: an alias that targets the old name now targets the new one,
   * and another combo that lists the old name as a member does too. A rename
   * that skipped the rewrite would leave aliases and nested combos pointing at
   * a name that no longer resolves.
   */
  async renameCombo(
    tenantId: string,
    id: string,
    nextName: string,
  ): Promise<ModelComboRow | undefined> {
    return this.db.transaction(async (tx) => {
      const currentRows = await tx
        .select()
        .from(modelCombos)
        .where(and(eq(modelCombos.tenantId, tenantId), eq(modelCombos.id, id)))
        .limit(1);
      const current = currentRows[0];
      if (!current) return undefined;
      const oldName = current.name;
      if (oldName === nextName) return mapComboRow(current);

      const updatedRows = await tx
        .update(modelCombos)
        .set({ name: nextName, updatedAt: new Date() })
        .where(and(eq(modelCombos.tenantId, tenantId), eq(modelCombos.id, id)))
        .returning();
      const updated = updatedRows[0];
      if (!updated) return undefined;

      // Alias targets are single values; a rename only matters when the alias
      // pointed at this combo by name.
      await tx
        .update(modelAliases)
        .set({ targetModel: nextName, updatedAt: new Date() })
        .where(and(eq(modelAliases.tenantId, tenantId), eq(modelAliases.targetModel, oldName)));

      // Other combos list members as a JSON array. Read the tenant's combos,
      // rewrite any that name the old combo, and write back only those — a
      // JSON array cannot be updated in place with a plain string replace.
      const others = await tx
        .select({ id: modelCombos.id, members: modelCombos.members })
        .from(modelCombos)
        .where(eq(modelCombos.tenantId, tenantId));
      for (const other of others) {
        if (other.id === id) continue;
        if (!other.members.includes(oldName)) continue;
        await tx
          .update(modelCombos)
          .set({
            members: other.members.map((member) => (member === oldName ? nextName : member)),
            updatedAt: new Date(),
          })
          .where(and(eq(modelCombos.tenantId, tenantId), eq(modelCombos.id, other.id)));
      }
      return mapComboRow(updated);
    });
  }

  async isKnownModel(tenantId: string, modelId: string): Promise<boolean> {
    const known = await this.areKnownModels(tenantId, [modelId]);
    return known.has(modelId);
  }

  async areKnownModels(
    tenantId: string,
    modelIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (modelIds.length === 0) return new Set<string>();
    const unique = [...new Set(modelIds)];
    const bare: string[] = [];
    const qualified: Array<{ raw: string; providerId: string; bare: string }> = [];
    for (const id of unique) {
      const slash = id.indexOf("/");
      if (slash === -1) {
        bare.push(id);
      } else {
        const providerId = id.slice(0, slash);
        const b = id.slice(slash + 1);
        if (!providerId || !b) continue;
        qualified.push({ raw: id, providerId, bare: b });
      }
    }
    const known = new Set<string>();
    if (bare.length > 0) {
      const rows = await this.db
        .select({ modelId: models.modelId })
        .from(models)
        .innerJoin(providers, eq(models.providerId, providers.id))
        .where(
          and(
            inArray(models.modelId, bare),
            eq(models.enabled, true),
            eq(providers.enabled, true),
            globalOrOwnedBy(providers.tenantId, tenantId),
          ),
        );
      for (const row of rows) known.add(row.modelId);
    }
    if (qualified.length > 0) {
      const conditions = qualified.map(({ providerId, bare: b }) =>
        and(eq(models.providerId, providerId), eq(models.modelId, b)),
      );
      const rows = await this.db
        .select({ providerId: models.providerId, modelId: models.modelId })
        .from(models)
        .innerJoin(providers, eq(models.providerId, providers.id))
        .where(
          and(
            or(...conditions),
            eq(models.enabled, true),
            eq(providers.enabled, true),
            globalOrOwnedBy(providers.tenantId, tenantId),
          ),
        );
      const foundPairs = new Set(rows.map((r) => `${r.providerId}/${r.modelId}`));
      for (const q of qualified) {
        if (foundPairs.has(q.raw)) known.add(q.raw);
      }
    }
    return known;
  }
}

