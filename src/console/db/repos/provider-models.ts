import { getDb } from "../client";

export interface ProviderModelState {
  modelId: string;
  enabled: boolean;
  source: "built-in" | "manual" | "imported";
}

interface ProviderModelRow {
  model_id: string;
  enabled: number;
  source: ProviderModelState["source"];
}

export function listProviderModelStates(provider: string): ProviderModelState[] {
  return (getDb().query("SELECT model_id, enabled, source FROM provider_models WHERE provider = ? ORDER BY model_id").all(provider) as ProviderModelRow[])
    .map((row) => ({ modelId: row.model_id, enabled: row.enabled === 1, source: row.source }));
}

export function isProviderModelEnabled(provider: string, modelId: string): boolean {
  const row = getDb().query("SELECT enabled FROM provider_models WHERE provider = ? AND model_id = ?").get(provider, modelId) as { enabled: number } | null;
  return row?.enabled !== 0;
}

export function upsertProviderModel(provider: string, modelId: string, source: "manual" | "imported", enabled = true): void {
  const now = new Date().toISOString();
  getDb().query(
    `INSERT INTO provider_models (provider, model_id, enabled, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model_id) DO UPDATE SET enabled = excluded.enabled, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(provider, modelId, enabled ? 1 : 0, source, now, now);
}

export function deleteProviderModel(provider: string, modelId: string): boolean {
  return getDb().query("DELETE FROM provider_models WHERE provider = ? AND model_id = ?").run(provider, modelId).changes > 0;
}

export function setProviderModelEnabled(
  provider: string,
  modelId: string,
  enabled: boolean,
  source: ProviderModelState["source"] = "manual",
): void {
  const now = new Date().toISOString();
  getDb().query(
    `INSERT INTO provider_models (provider, model_id, enabled, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(provider, modelId, enabled ? 1 : 0, source, now, now);
}

export function setAllKnownProviderModels(provider: string, modelIds: string[], enabled: boolean): void {
  for (const modelId of modelIds) setProviderModelEnabled(provider, modelId, enabled, "built-in");
}
