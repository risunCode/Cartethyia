import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import type { AccessRuleRow, CustomProviderRow } from "../mappers";
import type { AccessRuleRecord, AccessRuleRepository, CustomProviderRecord, CustomProviderRepository } from "../records";

export function createConsoleCustomProviderRepository(db: () => Database): CustomProviderRepository { const toRecord = (row: CustomProviderRow): CustomProviderRecord => {
  let models: readonly unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.models_json);
    if (Array.isArray(parsed)) models = parsed;
  } catch {
    // malformed legacy JSON — empty list
  }
  let customHeaders: Readonly<Record<string, string>> = {};
  try {
    const parsed: unknown = JSON.parse(row.headers_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      customHeaders = parsed as Record<string, string>;
    }
  } catch {
    // malformed legacy JSON — empty object
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type === "anthropic-compatible" ? "anthropic-compatible" : "openai-compatible",
    baseUrl: row.base_url,
    credential: row.credential,
    timeoutSeconds: row.timeout_seconds,
    models,
    customHeaders,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
return {
  list(): CustomProviderRecord[] {
    return (db().query("SELECT * FROM custom_providers ORDER BY name ASC").all() as CustomProviderRow[]).map(toRecord);
  },
  get(id: string): CustomProviderRecord | null {
    const row = db().query("SELECT * FROM custom_providers WHERE id = ?").get(id) as CustomProviderRow | null;
    return row ? toRecord(row) : null;
  },
  getBySlug(slug: string): CustomProviderRecord | null {
    const row = db().query("SELECT * FROM custom_providers WHERE slug = ?").get(slug) as CustomProviderRow | null;
    return row ? toRecord(row) : null;
  },
  upsert(input: {
    id: string;
    slug: string;
    name: string;
    type: "openai-compatible" | "anthropic-compatible";
    baseUrl: string;
    credential: string;
    timeoutSeconds?: number;
    models?: readonly unknown[];
    customHeaders?: Readonly<Record<string, string>>;
  }): CustomProviderRecord {
    const now = nowIso();
    db().query(
      "INSERT INTO custom_providers (id, slug, name, type, base_url, credential, timeout_seconds, models_json, headers_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, type = excluded.type, base_url = excluded.base_url, credential = excluded.credential, timeout_seconds = excluded.timeout_seconds, models_json = excluded.models_json, headers_json = excluded.headers_json, updated_at = excluded.updated_at",
    ).run(input.id, input.slug, input.name, input.type, input.baseUrl, input.credential, input.timeoutSeconds ?? 30, JSON.stringify(input.models ?? []), JSON.stringify(input.customHeaders ?? {}), now, now);
    return toRecord(db().query("SELECT * FROM custom_providers WHERE id = ?").get(input.id) as CustomProviderRow);
  },
  delete(id: string): boolean {
    const result = db().query("DELETE FROM custom_providers WHERE id = ?").run(id);
    return result.changes > 0;
  },
  updateModels(id: string, models: readonly unknown[]): CustomProviderRecord | null {
    const now = nowIso();
    const result = db().query("UPDATE custom_providers SET models_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(models), now, id);
    if (result.changes === 0) return null;
    return toRecord(db().query("SELECT * FROM custom_providers WHERE id = ?").get(id) as CustomProviderRow);
  },
}; }

export function createConsoleAccessRuleRepository(db: () => Database): AccessRuleRepository { const toRecord = (row: AccessRuleRow): AccessRuleRecord => {
  let entries: readonly unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.entries_json);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // malformed legacy JSON — empty list
  }
  return { scope: row.scope, mode: row.mode, entries, updatedAt: row.updated_at };
};
return {
  get(scope: string): AccessRuleRecord | null {
    const row = db().query("SELECT * FROM access_rules WHERE scope = ?").get(scope) as AccessRuleRow | null;
    return row ? toRecord(row) : null;
  },
  upsert(scope: string, input: { mode: string; entries: readonly unknown[] }): AccessRuleRecord {
    const now = nowIso();
    db().query("INSERT INTO access_rules (scope, mode, entries_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET mode = excluded.mode, entries_json = excluded.entries_json, updated_at = excluded.updated_at").run(scope, input.mode, JSON.stringify(input.entries), now);
    return toRecord(db().query("SELECT * FROM access_rules WHERE scope = ?").get(scope) as AccessRuleRow);
  },
}; }
