/**
 * Configuration backup export/restore.
 *
 * A backup is a JSON snapshot of the config tables — deliberately including
 * secrets (api keys, provider credentials, JWT material) because it is the
 * configuration snapshot, exactly like the file the dashboard downloads.
 * Runtime metadata (usage history, console logs) is never part of a
 * configuration backup; restore never touches the runtime database.
 *
 * Security model (mirrors the legacy implementation; tightened for
 * the current schema):
 * - The payload is size-bounded (checked at the API boundary) and validated
 *   structurally here before any write happens.
 * - Table and column allowlists: a hostile or stale payload can never write
 *   into an arbitrary table or column.
 * - Application is delete+insert per table inside ONE transaction, so any
 *   SQL error rolls the whole restore back and leaves the database untouched.
 * - Error strings carry only table/column *names*, never cell values, so a
 *   failed restore does not leak credentials.
 */
import { Database } from "bun:sqlite";

export const BACKUP_APP = "cartethyia";
export const BACKUP_VERSION = 1;

/** Max accepted restore payload size (bytes). Sidebar icon data URLs alone can reach ~36 MiB. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** Defense-in-depth cap on rows per table after the byte bound. */
const MAX_ROWS_PER_TABLE = 100_000;

/** Config tables included in a backup — mirrors the current CONFIG_SCHEMA_SQL. */
export const BACKUP_TABLES = [
  "settings",
  "api_keys",
  "share_links",
  "model_aliases",
  "cli_tool_mapping_settings",
  "cli_model_mappings",
  "combos",
  "access_rules",
  "provider_accounts",
  "custom_providers",
  "warp_accounts",
  "proxies",
  "proxy_settings",
  "ip_bans",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/** Validates that a table name is in the hardcoded allowlist before interpolation. */
function assertBackupTable(table: string): asserts table is BackupTable {
  if (!BACKUP_TABLES.includes(table as BackupTable)) throw new Error(`Refusing to query unknown table: ${table}`);
}

/** Column allowlists — reject unknown columns so a hostile/old payload can't write arbitrary data. */
const TABLE_COLUMNS: Record<BackupTable, readonly string[]> = {
  settings: ["id", "password_hash", "password_version", "jwt_secret", "settings_json", "initialized_at", "updated_at"],
  api_keys: [
    "id", "name", "key", "key_prefix", "active", "rate_limit_rpm", "daily_token_limit",
    "monthly_token_limit", "one_time_token_limit", "one_time_tokens_used", "quote_big_text", "quote_sub_text", "quote_body",
    "max_concurrent_requests", "provider_allowlist", "model_allowlist", "model_denylist",
    "last_used_at", "created_at", "revoked_at",
  ],
  share_links: ["id", "api_key_id", "token_hash", "kind", "active", "created_at", "expires_at", "used_at", "last_viewed_at"],
  model_aliases: ["alias", "model", "created_at"],
  cli_tool_mapping_settings: ["tool_id", "enabled", "updated_at"],
  cli_model_mappings: ["tool_id", "slot_key", "source_model", "target_model", "enabled", "created_at", "updated_at"],
  combos: ["id", "name", "models_json", "strategy", "sticky_limit", "created_at", "updated_at"],
  access_rules: ["scope", "mode", "entries_json", "created_at", "updated_at"],
  provider_accounts: [
    "id", "provider", "name", "credential_kind", "credential", "credential_hint",
    "priority", "active", "cooldown_until", "cooldown_level",
    "consecutive_use_count", "last_used_at",
    "created_at", "updated_at",
  ],
  custom_providers: ["id", "slug", "name", "type", "base_url", "credential", "timeout_seconds", "models_json", "headers_json", "created_at", "updated_at"],
  warp_accounts: [
    "id", "label", "device_id", "access_token", "license_key", "private_key",
    "address_v4", "address_v6", "public_key", "endpoint", "endpoint_port",
    "dns", "mtu", "socks_port", "enabled", "running", "pid",
    "prefer_ipv6", "custom_endpoint", "persistent_keepalive", "created_at", "updated_at",
  ],
  proxies: [
    "id", "name", "protocol", "is_relay", "host", "port", "username", "password",
    "priority", "weight", "active", "cooldown_until", "cooldown_level", "max_concurrency",
    "consecutive_use_count", "last_used_at",
    "created_at", "updated_at",
    "last_test_at", "last_test_success_at", "last_test_success_latency_ms", "last_test_error_at", "last_test_error", "last_test_status_code",
  ],
  proxy_settings: ["id", "enabled", "excluded_providers_json", "smart_dynamic_routing", "smart_dynamic_proxy_count", "routing_preset", "target_concurrent", "updated_at"],
  ip_bans: ["ip", "reason", "created_at"],
};

type Row = Record<string, unknown>;

export interface BackupPayload {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  tables: Record<string, unknown>;
}

export type RestoreValidation =
  | { ok: true; tables: Map<BackupTable, Row[]> }
  | { ok: false; error: string };

export interface RestoreResult {
  restored: Record<string, number>;
}
/** Delete dependent configuration before its providers, then restore in reverse. */
const DELETE_ORDER: BackupTable[] = [
  "warp_accounts", "provider_accounts", "custom_providers", "access_rules",
  "cli_model_mappings", "cli_tool_mapping_settings", "combos", "model_aliases", "share_links", "api_keys", "proxies", "proxy_settings", "ip_bans", "settings",
];
const INSERT_ORDER: BackupTable[] = [...DELETE_ORDER].reverse();

/** Export a JSON backup payload from the current config database state. */
export function exportConfigBackup(db: Database): BackupPayload {
  const tables = db.transaction(() => {
    const snapshot: Record<string, unknown> = {};
    for (const table of BACKUP_TABLES) {
      assertBackupTable(table);
      if (table === "settings" || table === "proxy_settings") {
        const row = db.query(`SELECT * FROM ${table} WHERE id = 1`).get();
        snapshot[table] = row ?? {};
      } else {
        snapshot[table] = db.query(`SELECT * FROM ${table} LIMIT ${MAX_ROWS_PER_TABLE}`).all();
      }
    }
    return snapshot;
  })();

  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

/** Normalize one table payload to a row array (settings/proxy_settings may be a single object). */
function normalizeRows(table: string, value: unknown): Row[] | null {
  if (table === "settings" || table === "proxy_settings") {
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
  const entries = Object.entries(p.tables);
  if (entries.length > BACKUP_TABLES.length) return { ok: false, error: "backup contains unknown tables" };

  for (const [key, value] of entries) {
    if (!(key in TABLE_COLUMNS)) return { ok: false, error: `unknown table "${key}" in backup` };
    const table = key as BackupTable;
    const rows = normalizeRows(table, value);
    if (!rows) return { ok: false, error: `table "${table}" must be ${table === "settings" || table === "proxy_settings" ? "an object or array" : "an array"}` };

    if (rows.length > MAX_ROWS_PER_TABLE) return { ok: false, error: `table "${table}" exceeds the ${MAX_ROWS_PER_TABLE} row limit` };

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

function insertRow(db: Database, table: BackupTable, row: Row): void {
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => "?").join(", ");
  const values = cols.map((col) => {
    const value = row[col];
    return typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null);
  });
  db.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`).run(...values);
}

/**
 * Apply a pre-validated backup inside a single transaction.
 * Throws on any SQL error → the transaction rolls back and the DB is untouched.
 */
export function applyConfigRestore(db: Database, validation: Extract<RestoreValidation, { ok: true }>): RestoreResult {
  const counts: Record<string, number> = {};

  const run = db.transaction((tables: Map<BackupTable, Row[]>) => {
    for (const table of DELETE_ORDER) {
      if (!tables.has(table)) continue;
      db.query(`DELETE FROM ${table}`).run();
      counts[table] = 0;
    }
    for (const table of INSERT_ORDER) {
      const rows = tables.get(table);
      if (!rows) continue;
      for (const row of rows) insertRow(db, table, row);
      counts[table] = rows.length;
    }
  });

  run(validation.tables);
  return { restored: counts };
}