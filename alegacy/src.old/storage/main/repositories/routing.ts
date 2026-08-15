import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import type { AliasRow, CliMappingSettingsRow, CliModelMappingRow, ComboRow, ProviderModelRow } from "../mappers";
import type { AliasRecord, AliasRepository, CliMappingSettingsRecord, CliModelMappingRecord, CliModelMappingRepository, ComboRecord, ComboRepository, ProviderModelRecord, ProviderModelRepository } from "../records";

export function createConsoleProviderModelRepository(db: () => Database): ProviderModelRepository { const toRecord = (row: ProviderModelRow): ProviderModelRecord => ({
  provider: row.provider,
  modelId: row.model_id,
  enabled: row.enabled === 1,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
return {
  list(provider: string): ProviderModelRecord[] {
    return (db().query("SELECT * FROM provider_models WHERE provider = ? ORDER BY model_id ASC").all(provider) as ProviderModelRow[]).map(toRecord);
  },
  get(provider: string, modelId: string): ProviderModelRecord | null {
    // Try exact match first, then a prefix-qualified match so lookups work
    // whether the caller passes the bare ID or the legacy qualified ID.
    const direct = db().query("SELECT * FROM provider_models WHERE provider = ? AND model_id = ?").get(provider, modelId) as ProviderModelRow | null;
    if (direct) return toRecord(direct);
    const qualified = db().query("SELECT * FROM provider_models WHERE provider = ? AND model_id = ?").get(provider, `${provider}/${modelId}`) as ProviderModelRow | null;
    return qualified ? toRecord(qualified) : null;
  },
  upsert(provider: string, modelId: string, input: { enabled?: boolean; source?: string }): ProviderModelRecord {
    const now = nowIso();
    db().query(
      "INSERT INTO provider_models (provider, model_id, enabled, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model_id) DO UPDATE SET enabled = excluded.enabled, source = excluded.source, updated_at = excluded.updated_at",
    ).run(provider, modelId, input.enabled === false ? 0 : 1, input.source ?? "manual", now, now);
    return toRecord(db().query("SELECT * FROM provider_models WHERE provider = ? AND model_id = ?").get(provider, modelId) as ProviderModelRow);
  },
  delete(provider: string, modelId: string): boolean {
    // Also handle legacy qualified IDs on delete.
    const result = db().query("DELETE FROM provider_models WHERE provider = ? AND model_id = ?").run(provider, modelId);
    if (result.changes > 0) return true;
    const qualified = db().query("DELETE FROM provider_models WHERE provider = ? AND model_id = ?").run(provider, `${provider}/${modelId}`);
    return qualified.changes > 0;
  },
}; }

export function createConsoleAliasRepository(db: () => Database): AliasRepository { const toRecord = (row: AliasRow): AliasRecord => ({ alias: row.alias, model: row.model, createdAt: row.created_at });
return {
  list(): AliasRecord[] {
    return (db().query("SELECT * FROM model_aliases ORDER BY alias ASC").all() as AliasRow[]).map(toRecord);
  },
  get(alias: string): AliasRecord | null {
    const row = db().query("SELECT * FROM model_aliases WHERE alias = ?").get(alias) as AliasRow | null;
    return row ? toRecord(row) : null;
  },
  upsert(alias: string, model: string): AliasRecord {
    const now = nowIso();
    db().query("INSERT INTO model_aliases (alias, model, created_at) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET model = excluded.model").run(alias, model, now);
    return toRecord(db().query("SELECT * FROM model_aliases WHERE alias = ?").get(alias) as AliasRow);
  },
  delete(alias: string): boolean {
    const result = db().query("DELETE FROM model_aliases WHERE alias = ?").run(alias);
    return result.changes > 0;
  },
}; }

export function createConsoleCliModelMappingRepository(db: () => Database): CliModelMappingRepository { const toMapping = (row: CliModelMappingRow): CliModelMappingRecord => ({
  toolId: row.tool_id,
  slotKey: row.slot_key,
  sourceModel: row.source_model,
  targetModel: row.target_model,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const toSettings = (row: CliMappingSettingsRow): CliMappingSettingsRecord => ({
  toolId: row.tool_id,
  enabled: row.enabled === 1,
  updatedAt: row.updated_at,
});
return {
  list(toolId: string): CliModelMappingRecord[] {
    return (db().query("SELECT * FROM cli_model_mappings WHERE tool_id = ? ORDER BY slot_key ASC").all(toolId) as CliModelMappingRow[]).map(toMapping);
  },
  upsert(input): CliModelMappingRecord {
    const now = nowIso();
    db().query(
      "INSERT INTO cli_model_mappings (tool_id, slot_key, source_model, target_model, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tool_id, slot_key) DO UPDATE SET source_model = excluded.source_model, target_model = excluded.target_model, enabled = excluded.enabled, updated_at = excluded.updated_at",
    ).run(input.toolId, input.slotKey, input.sourceModel, input.targetModel, input.enabled ? 1 : 0, now, now);
    return toMapping(db().query("SELECT * FROM cli_model_mappings WHERE tool_id = ? AND slot_key = ?").get(input.toolId, input.slotKey) as CliModelMappingRow);
  },
  delete(toolId: string, slotKey: string): boolean {
    return db().query("DELETE FROM cli_model_mappings WHERE tool_id = ? AND slot_key = ?").run(toolId, slotKey).changes > 0;
  },
  getSettings(toolId: string): CliMappingSettingsRecord | null {
    const row = db().query("SELECT * FROM cli_tool_mapping_settings WHERE tool_id = ?").get(toolId) as CliMappingSettingsRow | null;
    return row ? toSettings(row) : null;
  },
  setEnabled(toolId: string, enabled: boolean): CliMappingSettingsRecord {
    const now = nowIso();
    db().query(
      "INSERT INTO cli_tool_mapping_settings (tool_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(tool_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
    ).run(toolId, enabled ? 1 : 0, now);
    return toSettings(db().query("SELECT * FROM cli_tool_mapping_settings WHERE tool_id = ?").get(toolId) as CliMappingSettingsRow);
  },
  reset(toolId: string): void {
    db().transaction(() => {
      db().query("DELETE FROM cli_model_mappings WHERE tool_id = ?").run(toolId);
      db().query("DELETE FROM cli_tool_mapping_settings WHERE tool_id = ?").run(toolId);
    })();
  },
}; }

export function createConsoleComboRepository(db: () => Database): ComboRepository { const toRecord = (row: ComboRow): ComboRecord => {
  let models: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.models_json);
    if (Array.isArray(parsed)) models = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // malformed legacy JSON — empty list
  }
  return { id: row.id, name: row.name, models, strategy: row.strategy, stickyLimit: row.sticky_limit, createdAt: row.created_at, updatedAt: row.updated_at };
};
return {
  list(): ComboRecord[] {
    return (db().query("SELECT * FROM combos ORDER BY name ASC").all() as ComboRow[]).map(toRecord);
  },
  get(id: string): ComboRecord | null {
    const row = db().query("SELECT * FROM combos WHERE id = ?").get(id) as ComboRow | null;
    return row ? toRecord(row) : null;
  },
  upsert(input: { id: string; name: string; models: readonly string[]; strategy?: string; stickyLimit?: number }): ComboRecord {
    const now = nowIso();
    db().query(
      "INSERT INTO combos (id, name, models_json, strategy, sticky_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, models_json = excluded.models_json, strategy = excluded.strategy, sticky_limit = excluded.sticky_limit, updated_at = excluded.updated_at",
    ).run(input.id, input.name, JSON.stringify(input.models), input.strategy ?? "fallback", input.stickyLimit ?? 0, now, now);
    return toRecord(db().query("SELECT * FROM combos WHERE id = ?").get(input.id) as ComboRow);
  },
  delete(id: string): boolean {
    const result = db().query("DELETE FROM combos WHERE id = ?").run(id);
    return result.changes > 0;
  },
}; }

