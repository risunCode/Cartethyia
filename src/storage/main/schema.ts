/**
 * Configuration database schema, idempotent column upgrades, and provider-id
 * migrations.
 *
 * Extracted from `config.ts` so the DDL and schema lifecycle own their own
 * file. The remaining record interfaces, repository builders, durable ports,
 * and lifecycle singletons live in `config.ts`.
 */

import { Database } from "bun:sqlite";
import { sanitizeMessage } from "../../domain/contracts";
import type { ApplicationErrorKind, RouteStatus } from "../../domain/contracts";

/**
 * Idempotent config schema. Includes the direct-cutover `proxy_health` table
 * keyed by `proxy_id` (parallel to `provider_account_health`) so proxy error
 * text never sits beside proxy credentials.
 */
export const CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT,
  password_version INTEGER NOT NULL DEFAULT 1,
  jwt_secret TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  key TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  rate_limit_rpm INTEGER,
  daily_token_limit INTEGER,
  monthly_token_limit INTEGER,
  one_time_token_limit INTEGER,
  one_time_tokens_used INTEGER NOT NULL DEFAULT 0,
  quote_big_text TEXT,
  quote_sub_text TEXT,
  quote_body TEXT,
  max_concurrent_requests INTEGER,
  provider_allowlist TEXT,
  model_allowlist TEXT,
  model_denylist TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  models_json TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'fallback',
  sticky_limit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_rules (
  scope TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'open',
  entries_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_kind TEXT NOT NULL,
  credential TEXT NOT NULL,
  credential_hint TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  cooldown_until TEXT,
  cooldown_level INTEGER NOT NULL DEFAULT 0,
  consecutive_use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, name)
);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_priority ON provider_accounts(provider, priority, name, id);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_id ON provider_accounts(provider, id);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_cooldown ON provider_accounts(cooldown_until) WHERE cooldown_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_account_health (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'healthy',
  error_kind TEXT,
  status_code INTEGER,
  sanitized_message TEXT,
  occurred_at TEXT,
  retry_at TEXT,
  last_refresh_at TEXT,
  quota_json TEXT,
  quota_error TEXT,
  quota_fetched_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_provider_account_health_retry ON provider_account_health(retry_at) WHERE retry_at IS NOT NULL;

-- Proxy route health — parallel to provider_account_health, keyed by
CREATE TABLE IF NOT EXISTS proxy_health (
  proxy_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'healthy',
  error_kind TEXT,
  status_code INTEGER,
  sanitized_message TEXT,
  occurred_at TEXT,
  retry_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_proxy_health_retry ON proxy_health(retry_at) WHERE retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_viewed_at TEXT,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_links_api_key ON share_links(api_key_id);

CREATE TABLE IF NOT EXISTS provider_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);

-- Per-model lock — an error on model A (e.g. claude/sonnet-4) does NOT
-- block model B (e.g. claude/haiku-4) on the same account. Parallel to
-- provider_account_health but keyed by (account_id, model_id). Only
-- bounded sanitized scalars are stored — never secrets.
CREATE TABLE IF NOT EXISTS account_model_locks (
  account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  error_kind TEXT,
  status_code INTEGER,
  sanitized_message TEXT,
  failure_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, model_id),
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_model_locks_retry ON account_model_locks(retry_at) WHERE retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS custom_providers (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('openai-compatible','anthropic-compatible')),
  base_url        TEXT NOT NULL,
  credential      TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  models_json     TEXT NOT NULL DEFAULT '[]',
  headers_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('http','https','socks5')),
  is_relay INTEGER NOT NULL DEFAULT 0,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT,
  password TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  cooldown_until TEXT,
  cooldown_level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_test_at TEXT,
  last_test_success_at TEXT,
  last_test_success_latency_ms INTEGER,
  last_test_error_at TEXT,
  last_test_error TEXT,
  last_test_status_code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proxies_priority ON proxies(priority, name, id);
CREATE INDEX IF NOT EXISTS idx_proxies_cooldown ON proxies(cooldown_until) WHERE cooldown_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS proxy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  excluded_providers_json TEXT NOT NULL DEFAULT '[]',
  smart_dynamic_routing INTEGER NOT NULL DEFAULT 0,
  smart_dynamic_proxy_count INTEGER NOT NULL DEFAULT 2,
  routing_preset TEXT NOT NULL DEFAULT 'auto',
  target_concurrent INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

// filter_rules table is created in ensureConfigSchema() because a legacy
// version with incompatible columns may need to be dropped first.

interface TableColumns {
  name: string;
}

interface TableNameRow {
  name: string;
}

export function clearAllDatabaseTables(database: Database): void {
  const tables = (database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as TableNameRow[]).map((row) => row.name);
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.transaction(() => {
      for (const table of tables) database.query(`DELETE FROM "${table.replaceAll('"', '""')}"`).run();
      if (database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !== null) database.query("DELETE FROM sqlite_sequence").run();
    })();
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

/** Adds a column when missing (idempotent legacy upgrade). */
export function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as TableColumns[]).map((row) => row.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** Idempotent column upgrades for legacy config databases. */
export function ensureConfigSchema(db: Database): void {
  ensureColumn(db, "proxy_settings", "routing_preset", "routing_preset TEXT NOT NULL DEFAULT 'auto'");
  ensureColumn(db, "proxy_settings", "target_concurrent", "target_concurrent INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "proxies", "max_concurrency", "max_concurrency INTEGER NOT NULL DEFAULT 8");
  ensureColumn(db, "proxies", "weight", "weight INTEGER NOT NULL DEFAULT 100");
  ensureColumn(db, "proxies", "last_test_at", "last_test_at TEXT");
  ensureColumn(db, "proxies", "last_test_success_at", "last_test_success_at TEXT");
  ensureColumn(db, "proxies", "last_test_success_latency_ms", "last_test_success_latency_ms INTEGER");
  ensureColumn(db, "proxies", "last_test_error_at", "last_test_error_at TEXT");
  ensureColumn(db, "proxies", "last_test_error", "last_test_error TEXT");
  ensureColumn(db, "proxies", "last_test_status_code", "last_test_status_code INTEGER");
  ensureColumn(db, "provider_account_health", "provider_id", "provider_id TEXT");
  ensureColumn(db, "provider_account_health", "disabled_until_ms", "disabled_until_ms INTEGER");
  ensureColumn(db, "provider_account_health", "failure_count", "failure_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "provider_account_health", "generation", "generation INTEGER NOT NULL DEFAULT 0");
  // Index the migration-added provider_id column: health-by-provider lookups
  // (e.g. migrateProviderIds UPDATE … WHERE provider_id = ?, and per-provider
  // health aggregates over 50k accounts) would otherwise full-scan the table.
  // Placed here, not in CONFIG_SCHEMA_SQL, because provider_id is added by
  // ensureColumn above — CONFIG_SCHEMA_SQL runs first on a fresh DB where the
  // column does not yet exist, so an index there would fail.
  db.exec("CREATE INDEX IF NOT EXISTS idx_account_health_provider ON provider_account_health(provider_id)");
  // Sticky round-robin tracking (9router pattern): consecutive_use_count
  // tracks how many requests in a row used this account; last_used_at
  // enables LRU rotation when the sticky limit is reached.
  ensureColumn(db, "provider_accounts", "consecutive_use_count", "consecutive_use_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "provider_accounts", "last_used_at", "last_used_at TEXT");
  ensureColumn(db, "proxies", "consecutive_use_count", "consecutive_use_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "proxies", "last_used_at", "last_used_at TEXT");
  // Intentional cleanup: UNIQUE(slug) already backs exact lookups.
  db.exec("DROP INDEX IF EXISTS idx_custom_providers_slug");
  // Timing-safe key lookup: index the prefix column for LIKE 'prefix%' queries.
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix)");
  // Keyset pagination index: /providers/:id/accounts pages by id within a
  // provider; the composite (provider, id) index backs the
  // WHERE provider = ? AND id > ? ORDER BY id scan efficiently.
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_id ON provider_accounts(provider, id)");
  // Migrate legacy filter_rules table (old schema had provider/mode/patterns_json
  // columns — incompatible with the new rule_id/pattern/replacement schema).
  const filterCols = new Set((db.query("PRAGMA table_info(filter_rules)").all() as TableColumns[]).map((row) => row.name));
  if (filterCols.has("patterns_json") && !filterCols.has("rule_id")) {
    db.exec("DROP TABLE IF EXISTS filter_rules");
  }
  // Always ensure the new filter_rules table exists (CREATE TABLE IF NOT EXISTS
  // is a no-op if it was already created with the correct schema).
  db.exec(`CREATE TABLE IF NOT EXISTS filter_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,
  pattern TEXT NOT NULL,
  replacement TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_regex INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_filter_rules_sort_order ON filter_rules(sort_order)");
  // Per-model lock table — relational (account_id, model_id) so an error
  // on one model never blocks another on the same account. Idempotent.
  db.exec(`CREATE TABLE IF NOT EXISTS account_model_locks (
  account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  error_kind TEXT,
  status_code INTEGER,
  sanitized_message TEXT,
  failure_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, model_id),
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_account_model_locks_retry ON account_model_locks(retry_at) WHERE retry_at IS NOT NULL");

  // MultiWarp pool — Cloudflare Warp accounts + wireproxy instances.
  db.exec(`CREATE TABLE IF NOT EXISTS warp_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  license_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  address_v4 TEXT NOT NULL,
  address_v6 TEXT NOT NULL,
  public_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_port INTEGER NOT NULL DEFAULT 2408,
  dns TEXT NOT NULL DEFAULT '1.1.1.1',
  mtu INTEGER NOT NULL DEFAULT 1280,
  socks_port INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  running INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_warp_accounts_socks_port ON warp_accounts(socks_port)");

  // IP ban table — blocks IPs from making proxy requests.
  db.exec(`CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)`);

  // Additive migration — new performance/tuning columns (safe, nullable).
  const warpColumns = db.prepare("PRAGMA table_info(warp_accounts)").all() as { name: string }[];
  const warpColNames = new Set(warpColumns.map((c) => c.name));
  if (!warpColNames.has("prefer_ipv6")) {
    db.exec("ALTER TABLE warp_accounts ADD COLUMN prefer_ipv6 INTEGER NOT NULL DEFAULT 1");
  }
  if (!warpColNames.has("custom_endpoint")) {
    db.exec("ALTER TABLE warp_accounts ADD COLUMN custom_endpoint TEXT");
  }
  if (!warpColNames.has("persistent_keepalive")) {
    db.exec("ALTER TABLE warp_accounts ADD COLUMN persistent_keepalive INTEGER NOT NULL DEFAULT 15");
  }
  // Migrate existing accounts: enable prefer_ipv6 by default (IPv6 first, IPv4 fallback).
  db.exec("UPDATE warp_accounts SET prefer_ipv6 = 1 WHERE prefer_ipv6 = 0");

  // Migrate account_model_locks: old schema had `locked_until`, new schema has
  // `retry_at` + error fields + `failure_count` + timestamps. Locks are ephemeral
  // — safe to drop and recreate (CREATE IF NOT EXISTS won't alter an existing table).
  const lockCols = db.prepare("PRAGMA table_info(account_model_locks)").all() as { name: string }[];
  const lockColNames = new Set(lockCols.map((c) => c.name));
  if (lockColNames.has("locked_until") && !lockColNames.has("retry_at")) {
    db.exec("DROP TABLE account_model_locks");
    db.exec(`CREATE TABLE IF NOT EXISTS account_model_locks (
      account_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      retry_at TEXT NOT NULL,
      error_kind TEXT,
      status_code INTEGER,
      sanitized_message TEXT,
      failure_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, model_id),
      FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_account_model_locks_retry ON account_model_locks(retry_at) WHERE retry_at IS NOT NULL");
  }
}

/** Migrates persisted provider identifiers after an active-runtime rename. */
export function migrateProviderIds(db: Database): void {
  const renames = [
    ["opencode-free", "opencodeft"],
    ["opencode-zen", "opencodezen"],
    ["opencode-go", "opencodego"],
    ["claude-code", "claude"],
    ["openai-codex", "codex"],
    ["blackbox", "blackboxai"],
  ] as const;
  for (const [from, to] of renames) {
    for (const table of ["provider_accounts", "provider_models"] as const) {
      db.query(`UPDATE ${table} SET provider = ? WHERE provider = ?`).run(to, from);
    }
    db.query("UPDATE provider_account_health SET provider_id = ? WHERE provider_id = ?").run(to, from);
    db.query("UPDATE proxy_settings SET excluded_providers_json = replace(excluded_providers_json, ?, ?)").run(from, to);
    db.query("UPDATE model_aliases SET model = replace(model, ?, ?)").run(from, to);
    db.query("UPDATE combos SET models_json = replace(models_json, ?, ?)").run(from, to);
    db.query("UPDATE access_rules SET entries_json = replace(entries_json, ?, ?)").run(from, to);
    // API key ACLs are persisted as comma-separated strings rather than
    // provider foreign keys. Keep old provider-qualified allow/deny entries
    // usable after a provider ID rename.
    for (const column of ["provider_allowlist", "model_allowlist", "model_denylist"] as const) {
      db.query(`UPDATE api_keys SET ${column} = replace(${column}, ?, ?) WHERE ${column} IS NOT NULL`).run(from, to);
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Sanitized persistence error — never leaks file paths or credentials. */
export function configError(message: string): Error {
  return new Error(sanitizeMessage(message));
}

export function toRouteStatus(value: string | null | undefined): RouteStatus {
  switch (value) {
    case "healthy":
    case "cooling_down":
    case "error":
    case "disabled":
      return value;
    default:
      return "error";
  }
}

export function toErrorKind(value: string | null | undefined): ApplicationErrorKind | null {
  if (value === null || value === undefined || value === "") return null;
  return value as ApplicationErrorKind;
}

export function orNullString(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}
