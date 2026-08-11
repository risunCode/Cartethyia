/**
 * Configuration database DDL — raw SQL only, no helpers or migration logic.
 *
 * All `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` statements.
 * Running `db.exec(CONFIG_SCHEMA_SQL)` once at startup is all a fresh DB
 * needs. Existing DBs keep their orphaned tables (no error, negligible space).
 *
 * Includes the direct-cutover `proxy_health` table keyed by `proxy_id`
 * (parallel to `provider_account_health`) so proxy error text never sits
 * beside proxy credentials.
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

CREATE TABLE IF NOT EXISTS cli_tool_mapping_settings (
  tool_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cli_model_mappings (
  tool_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  source_model TEXT NOT NULL,
  target_model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tool_id, slot_key)
);
CREATE INDEX IF NOT EXISTS idx_cli_model_mappings_source ON cli_model_mappings(tool_id, source_model);

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
CREATE TABLE IF NOT EXISTS oauth_refresh_leases (
  account_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  token_fingerprint TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_leases_expiry ON oauth_refresh_leases(lease_until_ms);


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
  provider_id TEXT,
  disabled_until_ms INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_provider_account_health_retry ON provider_account_health(retry_at) WHERE retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_health_provider ON provider_account_health(provider_id);

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
  kind TEXT NOT NULL DEFAULT 'monitor',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  used_at TEXT,
  last_viewed_at TEXT,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_links_api_key ON share_links(api_key_id);
CREATE INDEX IF NOT EXISTS idx_share_links_active ON share_links(active, kind, expires_at);

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
  max_concurrency INTEGER NOT NULL DEFAULT 8,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  cooldown_until TEXT,
  cooldown_level INTEGER NOT NULL DEFAULT 0,
  consecutive_use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
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
CREATE TABLE IF NOT EXISTS warp_accounts (
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
  prefer_ipv6 INTEGER NOT NULL DEFAULT 1,
  custom_endpoint TEXT,
  persistent_keepalive INTEGER NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_warp_accounts_socks_port ON warp_accounts(socks_port);


CREATE TABLE IF NOT EXISTS proxy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  excluded_providers_json TEXT NOT NULL DEFAULT '[]',
  smart_dynamic_routing INTEGER NOT NULL DEFAULT 0,
  smart_dynamic_proxy_count INTEGER NOT NULL DEFAULT 2,
  routing_preset TEXT NOT NULL DEFAULT 'auto',
  target_concurrent INTEGER NOT NULL DEFAULT 0,
  web_search_preference TEXT NOT NULL DEFAULT 'auto',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS filter_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,
  pattern TEXT NOT NULL,
  replacement TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_regex INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_filter_rules_sort_order ON filter_rules(sort_order);

CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS security_offenses (
  ip TEXT NOT NULL,
  category TEXT NOT NULL,
  strike_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  PRIMARY KEY (ip, category)
);
`;
