/**
 * Schema — embedded SQL (not a .sql file) so the compiled binary keeps working
 * without shipping asset files. All statements are idempotent (IF NOT EXISTS).
 */

export const INIT_SQL = `
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
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  rate_limit_rpm INTEGER,
  daily_token_limit INTEGER,
  provider_allowlist TEXT,
  model_allowlist TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

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

CREATE TABLE IF NOT EXISTS proxy_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  entries_json TEXT NOT NULL,
  no_proxy TEXT NOT NULL DEFAULT '',
  strict_proxy INTEGER NOT NULL DEFAULT 0,
  platform TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_rules (
  scope TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'open',
  entries_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_routing (
  provider TEXT PRIMARY KEY,
  strategy TEXT NOT NULL DEFAULT 'priority',
  sticky_limit INTEGER NOT NULL DEFAULT 0,
  proxy_mode TEXT NOT NULL DEFAULT 'direct',
  proxy_pool_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_kind TEXT NOT NULL,
  credential_enc TEXT NOT NULL,
  credential_hint TEXT NOT NULL,
  proxy_pool_id TEXT,
  use_direct INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, name)
);

CREATE TABLE IF NOT EXISTS provider_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);

CREATE TABLE IF NOT EXISTS filter_rules (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Outbound-text sanitizer rules (console "Filter Rules" page, REQ-9). Named
-- distinctly from filter_rules above (an unrelated allow/deny model-eligibility
-- concept, console/db/repos/combos.ts) to avoid two different things sharing
-- one name in the codebase.
CREATE TABLE IF NOT EXISTS sanitizer_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,
  pattern TEXT NOT NULL,
  replacement TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_regex INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sanitizer_rules_sort ON sanitizer_rules(sort_order);

-- Console-registered OpenAI/Anthropic-compatible providers (REQ-8).
CREATE TABLE IF NOT EXISTS custom_providers (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('openai-compatible','anthropic-compatible')),
  base_url        TEXT NOT NULL,
  credential_enc  TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  models_json     TEXT NOT NULL DEFAULT '[]',
  headers_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`;
