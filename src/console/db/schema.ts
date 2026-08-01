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
  key TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  rate_limit_rpm INTEGER,
  daily_token_limit INTEGER,
  monthly_token_limit INTEGER,
  max_concurrent_requests INTEGER,
  provider_allowlist TEXT,
  model_allowlist TEXT,
  model_denylist TEXT,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, name)
);

CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_priority ON provider_accounts(provider, priority, name, id);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_cooldown ON provider_accounts(cooldown_until) WHERE cooldown_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);

CREATE TABLE IF NOT EXISTS account_model_locks (
  account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  locked_until TEXT NOT NULL,
  PRIMARY KEY (account_id, model_id),
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
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

-- Combo model-eligibility allow/deny (console/db/repos/combos.ts) — unrelated
-- to the removed "Filter Rules" outbound-text sanitizer feature; the name
-- collision is historical, kept as-is since this table is still in use.
CREATE TABLE IF NOT EXISTS filter_rules (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filter_rules_provider ON filter_rules(provider);

-- Console-registered OpenAI/Anthropic-compatible providers (REQ-8).
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

-- Model Studio — saved chat sessions for the console's built-in model tester
-- (system prompt + message history, so switching sessions preserves
-- provider prompt caching across turns).
CREATE TABLE IF NOT EXISTS model_studio_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  messages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_studio_sessions_updated ON model_studio_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_model_locks_expiry ON account_model_locks(locked_until);
CREATE INDEX IF NOT EXISTS idx_custom_providers_slug ON custom_providers(slug);
`;
