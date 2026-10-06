import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { cliToolMappings, cliToolSettings } from "../../persistence/schema";
import type {
  CliMappingMode,
  CliModelMapping,
} from "./contracts";
// ── mapping-store.ts ──
/**
 * Drizzle-backed persistence for CLI Tools per-(tenant, key) mappings and
 * settings. Each API key can independently configure source→target routes
 * for any CLI tool slot — different keys target different models.
 *
 * The API-layer service owns validation against the registry; this store
 * only serializes rows in and out of Postgres.
 */
export interface StoredMappingRow extends CliModelMapping {
  readonly toolId: string;
  readonly tenantId: string;
  readonly apiKeyId: string;
}

export interface StoredSettings {
  readonly tenantId: string;
  readonly toolId: string;
  readonly apiKeyId: string;
  readonly mappingsEnabled: boolean;
  readonly mode: CliMappingMode;
}

export class CliToolMappingStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async list(tenantId: string, toolId: string, apiKeyId: string): Promise<readonly StoredMappingRow[]> {
    const rows = await this.db
      .select()
      .from(cliToolMappings)
      .where(
        and(
          eq(cliToolMappings.tenantId, tenantId),
          eq(cliToolMappings.toolId, toolId),
          eq(cliToolMappings.apiKeyId, apiKeyId),
        ),
      );
    return rows.map((row) => ({
      tenantId: row.tenantId,
      toolId: row.toolId,
      apiKeyId: row.apiKeyId,
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
        apiKeyId: row.apiKeyId,
        toolId: row.toolId,
        slotKey: row.slotKey,
        sourceModel: row.sourceModel,
        targetModel: row.targetModel,
        enabled: row.enabled,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          cliToolMappings.tenantId,
          cliToolMappings.toolId,
          cliToolMappings.apiKeyId,
          cliToolMappings.slotKey,
        ],
        set: {
          sourceModel: row.sourceModel,
          targetModel: row.targetModel,
          enabled: row.enabled,
          updatedAt: now,
        },
      });
  }

  async remove(tenantId: string, toolId: string, apiKeyId: string, slotKey: string): Promise<void> {
    await this.db
      .delete(cliToolMappings)
      .where(
        and(
          eq(cliToolMappings.tenantId, tenantId),
          eq(cliToolMappings.toolId, toolId),
          eq(cliToolMappings.apiKeyId, apiKeyId),
          eq(cliToolMappings.slotKey, slotKey),
        ),
      );
  }

  async reset(tenantId: string, toolId: string, apiKeyId: string): Promise<void> {
    await this.db
      .delete(cliToolMappings)
      .where(
        and(
          eq(cliToolMappings.tenantId, tenantId),
          eq(cliToolMappings.toolId, toolId),
          eq(cliToolMappings.apiKeyId, apiKeyId),
        ),
      );
    await this.db
      .delete(cliToolSettings)
      .where(
        and(
          eq(cliToolSettings.tenantId, tenantId),
          eq(cliToolSettings.toolId, toolId),
          eq(cliToolSettings.apiKeyId, apiKeyId),
        ),
      );
  }

  async getSettings(tenantId: string, toolId: string, apiKeyId: string): Promise<StoredSettings | null> {
    const rows = await this.db
      .select()
      .from(cliToolSettings)
      .where(
        and(
          eq(cliToolSettings.tenantId, tenantId),
          eq(cliToolSettings.toolId, toolId),
          eq(cliToolSettings.apiKeyId, apiKeyId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenantId,
      toolId: row.toolId,
      apiKeyId: row.apiKeyId,
      mappingsEnabled: row.mappingsEnabled,
      mode: row.mode === "local" ? "local" : "remote",
    };
  }

  async setSettings(
    tenantId: string,
    toolId: string,
    apiKeyId: string,
    mappingsEnabled: boolean,
    mode: CliMappingMode = "remote",
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(cliToolSettings)
      .values({ tenantId, apiKeyId, toolId, mappingsEnabled, mode, updatedAt: now })
      .onConflictDoUpdate({
        target: [cliToolSettings.tenantId, cliToolSettings.toolId, cliToolSettings.apiKeyId],
        set: { mappingsEnabled, mode, updatedAt: now },
      });
  }

  /** Lists ALL mappings for a tenant across all keys — used by the route
   * catalog snapshot so the gateway can look up any key's routes. */
  async listAll(tenantId?: string): Promise<readonly StoredMappingRow[]> {
    const rows = tenantId
      ? await this.db
          .select()
          .from(cliToolMappings)
          .where(eq(cliToolMappings.tenantId, tenantId))
      : await this.db.select().from(cliToolMappings);
    return rows.map((row) => ({
      tenantId: row.tenantId,
      toolId: row.toolId,
      apiKeyId: row.apiKeyId,
      slotKey: row.slotKey,
      sourceModel: row.sourceModel,
      targetModel: row.targetModel,
      enabled: row.enabled,
    }));
  }
}
