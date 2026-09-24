import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { cliToolMappings, cliToolSettings } from "../../persistence/schema";
import type {
  CliMappingMode,
  CliModelMapping,
} from "./contracts";
// ── mapping-store.ts ──
/**
 * Drizzle-backed persistence for CLI Tools per-tenant mappings and settings.
 * The API-layer service owns validation against the registry; this store
 * only serializes rows in and out of Postgres.
 */
export interface StoredMappingRow extends CliModelMapping {
  readonly toolId: string;
  readonly tenantId: string;
}

export interface StoredSettings {
  readonly tenantId: string;
  readonly toolId: string;
  readonly mappingsEnabled: boolean;
  readonly mode: CliMappingMode;
}

export class CliToolMappingStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async list(tenantId: string, toolId: string): Promise<readonly StoredMappingRow[]> {
    const rows = await this.db
      .select()
      .from(cliToolMappings)
      .where(and(eq(cliToolMappings.tenantId, tenantId), eq(cliToolMappings.toolId, toolId)));
    return rows.map((row) => ({
      tenantId: row.tenantId,
      toolId: row.toolId,
      slotKey: row.slotKey,
      sourceModel: row.sourceModel,
      targetModel: row.targetModel,
      enabled: row.enabled,
    }));
  }

  async upsert(row: StoredMappingRow): Promise<void> {
    const now = new Date();
    await this.db
      .insert(cliToolMappings)
      .values({
        tenantId: row.tenantId,
        toolId: row.toolId,
        slotKey: row.slotKey,
        sourceModel: row.sourceModel,
        targetModel: row.targetModel,
        enabled: row.enabled,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [cliToolMappings.tenantId, cliToolMappings.toolId, cliToolMappings.slotKey],
        set: {
          sourceModel: row.sourceModel,
          targetModel: row.targetModel,
          enabled: row.enabled,
          updatedAt: now,
        },
      });
  }

  async remove(tenantId: string, toolId: string, slotKey: string): Promise<void> {
    await this.db
      .delete(cliToolMappings)
      .where(
        and(
          eq(cliToolMappings.tenantId, tenantId),
          eq(cliToolMappings.toolId, toolId),
          eq(cliToolMappings.slotKey, slotKey),
        ),
      );
  }

  async reset(tenantId: string, toolId: string): Promise<void> {
    await this.db
      .delete(cliToolMappings)
      .where(and(eq(cliToolMappings.tenantId, tenantId), eq(cliToolMappings.toolId, toolId)));
    await this.db
      .delete(cliToolSettings)
      .where(and(eq(cliToolSettings.tenantId, tenantId), eq(cliToolSettings.toolId, toolId)));
  }

  async getSettings(tenantId: string, toolId: string): Promise<StoredSettings | null> {
    const rows = await this.db
      .select()
      .from(cliToolSettings)
      .where(and(eq(cliToolSettings.tenantId, tenantId), eq(cliToolSettings.toolId, toolId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenantId,
      toolId: row.toolId,
      mappingsEnabled: row.mappingsEnabled,
      mode: row.mode === "custom" ? "custom" : "remote",
    };
  }

  async setSettings(
    tenantId: string,
    toolId: string,
    mappingsEnabled: boolean,
    mode: CliMappingMode = "remote",
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(cliToolSettings)
      .values({ tenantId, toolId, mappingsEnabled, mode, updatedAt: now })
      .onConflictDoUpdate({
        target: [cliToolSettings.tenantId, cliToolSettings.toolId],
        set: { mappingsEnabled, mode, updatedAt: now },
      });
  }
}
