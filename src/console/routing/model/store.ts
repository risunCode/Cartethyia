// Drizzle-backed console persistence for model routing (aliases + combos).
import { and, eq, inArray, or } from "drizzle-orm";
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
    const rows = await this.db
      .select()
      .from(modelAliases)
      .where(eq(modelAliases.tenantId, tenantId));
    return rows.map(mapAliasRow);
  }

  async createAlias(tenantId: string, input: ModelAliasCreateInput): Promise<ModelAliasRow> {
    const rows = await this.db
      .insert(modelAliases)
      .values({ tenantId, alias: input.alias, targetModel: input.targetModel })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("model alias insert returned no row");
    return mapAliasRow(row);
  }

  async updateAlias(
    tenantId: string,
    id: string,
    patch: ModelAliasPatchInput,
  ): Promise<ModelAliasRow | undefined> {
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
    const rows = await this.db.select().from(modelCombos).where(eq(modelCombos.tenantId, tenantId));
    return rows.map(mapComboRow);
  }

  async createCombo(tenantId: string, input: ModelComboCreateInput): Promise<ModelComboRow> {
    const rows = await this.db
      .insert(modelCombos)
      .values({
        tenantId,
        name: input.name,
        members: [...input.members],
        strategy: input.strategy ?? "fallback",
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

