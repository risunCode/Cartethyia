/**
 * Backup restore — full validation BEFORE the transaction, then delete+insert
 * per table inside one transaction so any failure leaves the DB untouched.
 */

import { getDb } from "../db/client";
import { BACKUP_APP, BACKUP_VERSION, CONFIG_TABLES, type BackupPayload, type BackupTable } from "./export";

type Row = Record<string, unknown>;

/** Column allowlists — reject unknown columns so a hostile/old payload can't write arbitrary data. */
const TABLE_COLUMNS: Record<BackupTable, string[]> = {
  settings: ["id", "password_hash", "password_version", "jwt_secret", "settings_json", "initialized_at", "updated_at"],
  api_keys: [
    "id", "name", "key", "key_prefix", "active", "rate_limit_rpm", "daily_token_limit",
    "provider_allowlist", "model_allowlist", "last_used_at", "created_at", "revoked_at",
  ],
  model_aliases: ["alias", "model", "created_at"],
  combos: ["id", "name", "models_json", "strategy", "sticky_limit", "created_at", "updated_at"],
  proxy_pools: ["id", "name", "entries_json", "no_proxy", "strict_proxy", "platform", "created_at", "updated_at"],
  access_rules: ["scope", "mode", "entries_json", "updated_at"],
  provider_routing: ["provider", "strategy", "sticky_limit", "proxy_mode", "proxy_pool_id", "updated_at"],
  provider_accounts: [
    "id", "provider", "name", "credential_kind", "credential", "credential_hint",
    "proxy_pool_id", "use_direct", "priority", "active", "created_at", "updated_at",
  ],
  filter_rules: ["id", "provider", "mode", "patterns_json", "created_at", "updated_at"],
  sanitizer_rules: ["id", "rule_id", "pattern", "replacement", "is_active", "is_regex", "sort_order", "created_at", "updated_at"],
  custom_providers: ["id", "slug", "name", "type", "base_url", "credential", "timeout_seconds", "models_json", "headers_json", "created_at", "updated_at"],
};

const KNOWN_TABLES = new Set<string>(CONFIG_TABLES);

/** Delete dependent configuration before its providers, then restore in reverse. */
const DELETE_ORDER: BackupTable[] = [
  "provider_accounts", "provider_routing", "filter_rules", "sanitizer_rules", "custom_providers", "access_rules",
  "proxy_pools", "combos", "model_aliases", "api_keys", "settings",
];
const INSERT_ORDER: BackupTable[] = [...DELETE_ORDER].reverse();

export type RestoreValidation =
  | { ok: true; tables: Map<BackupTable, Row[]> }
  | { ok: false; error: string };

/** Normalize one table payload to a row array (settings may be a single object). */
function normalizeRows(table: string, value: unknown): Row[] | null {
  if (table === "settings") {
    if (Array.isArray(value)) return value as Row[];
    if (value && typeof value === "object") {
      return Object.keys(value).length === 0 ? [] : [value as Row];
    }
    return null;
  }
  return Array.isArray(value) ? (value as Row[]) : null;
}

/** Validate the whole payload up front — no DB writes happen here. */
export function validateRestorePayload(payload: unknown): RestoreValidation {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "backup must be an object" };
  }
  const p = payload as Partial<BackupPayload>;
  if (p.app !== BACKUP_APP) return { ok: false, error: `backup.app must be "${BACKUP_APP}"` };
  if (p.version !== BACKUP_VERSION) return { ok: false, error: `unsupported backup version ${String(p.version)}` };
  if (typeof p.tables !== "object" || p.tables === null || Array.isArray(p.tables)) {
    return { ok: false, error: "backup.tables must be an object" };
  }

  const result = new Map<BackupTable, Row[]>();
  for (const [key, value] of Object.entries(p.tables)) {
    if (!KNOWN_TABLES.has(key)) return { ok: false, error: `unknown table "${key}" in backup` };
    const table = key as BackupTable;
    const rows = normalizeRows(table, value);
    if (!rows) return { ok: false, error: `table "${table}" must be ${table === "settings" ? "an object or array" : "an array"}` };

    const allowed = new Set(TABLE_COLUMNS[table]);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        return { ok: false, error: `${table}[${i}] must be a row object` };
      }
      for (const [col, cell] of Object.entries(row)) {
        if (!allowed.has(col)) return { ok: false, error: `${table}.${col} is not a known column` };
        const kind = typeof cell;
        if (cell !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
          return { ok: false, error: `${table}[${i}].${col} must be a primitive` };
        }
      }
    }
    result.set(table, rows);
  }

  return { ok: true, tables: result };
}

function insertRow(table: BackupTable, row: Row): void {
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => "?").join(", ");
  const values = cols.map((col) => {
    const v = row[col];
    return typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null);
  });
  getDb()
    .query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(...values);
}

export interface RestoreResult {
  restored: Record<string, number>;
}

/**
 * Apply a pre-validated backup inside a single transaction.
 * Throws on any SQL error → bun:sqlite rolls back automatically.
 */
export function applyRestore(validation: Extract<RestoreValidation, { ok: true }>): RestoreResult {
  const db = getDb();
  const counts: Record<string, number> = {};

  const run = db.transaction((tables: Map<BackupTable, Row[]>) => {
    for (const table of DELETE_ORDER) {
      if (!tables.has(table)) continue;
      db.run(`DELETE FROM ${table}`);
      counts[table] = 0;
    }
    for (const table of INSERT_ORDER) {
      const rows = tables.get(table);
      if (!rows) continue;
      for (const row of rows) insertRow(table, row);
      counts[table] = rows.length;
    }
  });

  run(validation.tables);
  return { restored: counts };
}
