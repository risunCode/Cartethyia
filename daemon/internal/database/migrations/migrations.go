package migrations

import "fmt"

// Migration is one ordered, versioned DDL step applied during database
// initialization. Statements are run in declaration order inside a single
// transaction; an error rolls the migration back so the schema never ends
// up half-applied.
type Migration struct {
	// Version is a monotonically increasing integer starting at 1.
	Version int
	// Name is a short operator-readable label ("settings", "api_keys", …).
	Name string
	// Statements is the ordered DDL for this step.
	Statements []string
}

// All returns the migrations in deterministic order. The order is the
// schema dependency order: tables that other tables reference come first.
func All() []Migration {
	migs := []Migration{
		settings(),
		apiKeys(),
		shareLinks(),
		modelAliases(),
		cliMappings(),
		combos(),
		accessRules(),
		providerAccounts(),
		providerAccountHealth(),
		accountModelLocks(),
		oauthRefreshLeases(),
		customProviders(),
		providerModels(),
		proxies(),
		proxyHealth(),
		proxySettings(),
		warpAccounts(),
		filterRules(),
		ipBans(),
		securityOffenses(),
		backupMetadata(),
		requestHistory(),
		requestPayloads(),
		consoleLogs(),
		warpMetrics(),
		customProviderCredentialRefs(),
		customProviderWireFields(),
		accountAuthority(),
		apiKeyTokenReservations(),
		proxyHealthConvergence(),
	}
	for i, m := range migs {
		if m.Version != i+1 {
			panic(fmt.Sprintf("migration %q has version %d, expected %d", m.Name, m.Version, i+1))
		}
	}
	return migs
}

func proxyHealthConvergence() Migration {
	return Migration{Version: 30, Name: "proxy_health_convergence", Statements: []string{
		`ALTER TABLE proxy_health ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;`,
		`ALTER TABLE proxy_health ADD COLUMN IF NOT EXISTS probe_until TIMESTAMPTZ;`,
		`ALTER TABLE proxy_health ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0);`,
		`ALTER TABLE proxy_health ADD COLUMN IF NOT EXISTS backoff_level INTEGER NOT NULL DEFAULT 0 CHECK (backoff_level BETWEEN 0 AND 30);`,
		`CREATE INDEX IF NOT EXISTS idx_proxy_health_probe ON proxy_health (probe_until) WHERE probe_until IS NOT NULL;`,
	}}
}

func apiKeyTokenReservations() Migration {
	return Migration{Version: 29, Name: "api_key_token_reservations", Statements: []string{
		`ALTER TABLE api_keys ALTER COLUMN one_time_tokens_used TYPE BIGINT;`,
		`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS one_time_tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (one_time_tokens_reserved >= 0);`,
		`CREATE TABLE IF NOT EXISTS api_key_token_windows (
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('daily', 'monthly')),
  window_start DATE NOT NULL,
  committed_tokens BIGINT NOT NULL DEFAULT 0 CHECK (committed_tokens >= 0),
  reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_id, window_kind, window_start)
);`,
		`CREATE TABLE IF NOT EXISTS api_key_token_reservations (
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 96),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 8),
  window_at TIMESTAMPTZ NOT NULL,
  daily_window_start DATE NOT NULL,
  monthly_window_start DATE NOT NULL,
  estimate_tokens BIGINT NOT NULL CHECK (estimate_tokens BETWEEN 1 AND 1000000000),
  committed_tokens BIGINT NOT NULL DEFAULT 0 CHECK (committed_tokens BETWEEN 0 AND 1000000000),
  input_tokens BIGINT CHECK (input_tokens BETWEEN 0 AND 1000000000),
  output_tokens BIGINT CHECK (output_tokens BETWEEN 0 AND 1000000000),
  cached_read_tokens BIGINT CHECK (cached_read_tokens BETWEEN 0 AND 1000000000),
  cached_write_tokens BIGINT CHECK (cached_write_tokens BETWEEN 0 AND 1000000000),
  reasoning_tokens BIGINT CHECK (reasoning_tokens BETWEEN 0 AND 1000000000),
  total_tokens BIGINT CHECK (total_tokens BETWEEN 0 AND 1000000000),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released')),
  release_reason TEXT CHECK (release_reason IS NULL OR release_reason = 'unaccepted'),
  CHECK ((status = 'released') = (release_reason IS NOT NULL)),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_id, request_id, attempt)
);`,
		`CREATE INDEX IF NOT EXISTS idx_api_key_token_reservations_expired ON api_key_token_reservations (expires_at, key_id, request_id, attempt) WHERE status = 'reserved';`,
	}}
}

func accountAuthority() Migration {
	return Migration{Version: 28, Name: "account_authority", Statements: []string{
		`CREATE TABLE IF NOT EXISTS account_configs (
  id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL, kind TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  labels_json JSONB NOT NULL DEFAULT '{}'::jsonb, credential_ref TEXT NOT NULL DEFAULT '',
  oauth_client_id TEXT NOT NULL DEFAULT '', redirect_uri TEXT NOT NULL DEFAULT '',
  scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
		`CREATE INDEX IF NOT EXISTS idx_account_configs_provider_enabled ON account_configs(provider_id, enabled, id);`,
		`CREATE TABLE IF NOT EXISTS oauth_token_records (
  account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL DEFAULT '',
  access_fingerprint TEXT NOT NULL DEFAULT '', refresh_fingerprint TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ, scope TEXT NOT NULL DEFAULT '', provider_account_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', org_id TEXT NOT NULL DEFAULT '', org_name TEXT NOT NULL DEFAULT '',
  issued_at TIMESTAMPTZ, reauthentication_required BOOLEAN NOT NULL DEFAULT FALSE,
  version BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
		`CREATE TABLE IF NOT EXISTS account_secret_blobs (
  account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  access_blob BYTEA, refresh_blob BYTEA, key_version INTEGER NOT NULL DEFAULT 1,
  version BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
	},
	}
}

func customProviderCredentialRefs() Migration {
	return Migration{
		Version: 26,
		Name:    "custom_provider_credential_refs",
		Statements: []string{
			`ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS credential_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb;`,
			`UPDATE custom_providers SET credential_refs_json = jsonb_build_array(credential_ref) WHERE jsonb_array_length(credential_refs_json) = 0 AND credential_ref <> '';`,
		},
	}
}

func customProviderWireFields() Migration {
	return Migration{
		Version: 27,
		Name:    "custom_provider_wire_fields",
		Statements: []string{
			`ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'openai';`,
			`ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'openai-chat';`,
			`UPDATE custom_providers SET protocol = 'anthropic', surface = 'anthropic-messages' WHERE type = 'anthropic-compatible';`,
			`ALTER TABLE custom_providers ADD CONSTRAINT custom_providers_protocol_check CHECK (protocol IN ('openai','anthropic'));`,
			`ALTER TABLE custom_providers ADD CONSTRAINT custom_providers_surface_check CHECK (surface IN ('openai-chat','openai-responses','anthropic-messages'));`,
		},
	}
}

func settings() Migration {
	return Migration{
		Version: 1,
		Name:    "settings",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash   TEXT,
  password_version INTEGER NOT NULL DEFAULT 1,
  jwt_secret      TEXT,
  settings_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  initialized_at  TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);`,
		},
	}
}

func apiKeys() Migration {
	return Migration{
		Version: 2,
		Name:    "api_keys",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS api_keys (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL UNIQUE,
  key                      TEXT NOT NULL,
  key_prefix               TEXT NOT NULL,
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit_rpm           INTEGER,
  daily_token_limit        INTEGER,
  monthly_token_limit      INTEGER,
  one_time_token_limit     INTEGER,
  one_time_tokens_used     INTEGER NOT NULL DEFAULT 0,
  quote_big_text           TEXT,
  quote_sub_text           TEXT,
  quote_body               TEXT,
  max_concurrent_requests  INTEGER,
  provider_allowlist       TEXT,
  model_allowlist          TEXT,
  model_denylist           TEXT,
  disable_remote_mapping   BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL,
  revoked_at               TIMESTAMPTZ
);`,
			`CREATE INDEX IF NOT EXISTS idx_api_keys_key        ON api_keys (key);`,
			`CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys (key_prefix);`,
		},
	}
}

func shareLinks() Migration {
	return Migration{
		Version: 3,
		Name:    "share_links",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS share_links (
  id            TEXT PRIMARY KEY,
  api_key_id    TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'monitor',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ,
  used_at       TIMESTAMPTZ,
  last_viewed_at TIMESTAMPTZ
);`,
			`CREATE INDEX IF NOT EXISTS idx_share_links_api_key ON share_links (api_key_id);`,
			`CREATE INDEX IF NOT EXISTS idx_share_links_active  ON share_links (active, kind, expires_at);`,
		},
	}
}

func modelAliases() Migration {
	return Migration{
		Version: 4,
		Name:    "model_aliases",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS model_aliases (
  alias      TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);`,
		},
	}
}

func cliMappings() Migration {
	return Migration{
		Version: 5,
		Name:    "cli_mappings",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS cli_tool_mapping_settings (
  tool_id    TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL
);`,
			`CREATE TABLE IF NOT EXISTS cli_model_mappings (
  tool_id      TEXT NOT NULL,
  slot_key     TEXT NOT NULL,
  source_model TEXT NOT NULL,
  target_model TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tool_id, slot_key)
);`,
			`CREATE INDEX IF NOT EXISTS idx_cli_model_mappings_source
  ON cli_model_mappings (tool_id, source_model);`,
		},
	}
}

func combos() Migration {
	return Migration{
		Version: 6,
		Name:    "combos",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS combos (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  models_json JSONB NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'fallback',
  sticky_limit INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);`,
		},
	}
}

func accessRules() Migration {
	return Migration{
		Version: 7,
		Name:    "access_rules",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS access_rules (
  scope        TEXT PRIMARY KEY,
  mode         TEXT NOT NULL DEFAULT 'open',
  entries_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL
);`,
		},
	}
}

func providerAccounts() Migration {
	return Migration{
		Version: 8,
		Name:    "provider_accounts",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS provider_accounts (
  id                     TEXT PRIMARY KEY,
  provider               TEXT NOT NULL,
  name                   TEXT NOT NULL,
  credential_kind        TEXT NOT NULL,
  credential_ref         TEXT NOT NULL,
  credential_hint        TEXT NOT NULL,
  priority               INTEGER NOT NULL DEFAULT 100,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_until         TIMESTAMPTZ,
  cooldown_level         INTEGER NOT NULL DEFAULT 0,
  consecutive_use_count  INTEGER NOT NULL DEFAULT 0,
  last_used_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  UNIQUE (provider, name)
);`,
			`CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_priority
  ON provider_accounts (provider, priority, name, id);`,
			`CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_id
  ON provider_accounts (provider, id);`,
			`CREATE INDEX IF NOT EXISTS idx_provider_accounts_cooldown
  ON provider_accounts (cooldown_until) WHERE cooldown_until IS NOT NULL;`,
		},
	}
}

func providerAccountHealth() Migration {
	return Migration{
		Version: 9,
		Name:    "provider_account_health",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS provider_account_health (
  account_id         TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'healthy',
  error_kind         TEXT,
  status_code        INTEGER,
  sanitized_message  TEXT,
  occurred_at        TIMESTAMPTZ,
  retry_at           TIMESTAMPTZ,
  last_refresh_at    TIMESTAMPTZ,
  quota_json         JSONB,
  quota_error        TEXT,
  quota_fetched_at   TIMESTAMPTZ,
  provider_id        TEXT,
  disabled_until_ms  BIGINT,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  generation         INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_provider_account_health_retry
  ON provider_account_health (retry_at) WHERE retry_at IS NOT NULL;`,
			`CREATE INDEX IF NOT EXISTS idx_account_health_provider
  ON provider_account_health (provider_id);`,
		},
	}
}

func accountModelLocks() Migration {
	return Migration{
		Version: 10,
		Name:    "account_model_locks",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS account_model_locks (
  account_id        TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  model_id          TEXT NOT NULL,
  retry_at          TIMESTAMPTZ NOT NULL,
  error_kind        TEXT,
  status_code       INTEGER,
  sanitized_message TEXT,
  failure_count     INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, model_id)
);`,
			`CREATE INDEX IF NOT EXISTS idx_account_model_locks_retry
  ON account_model_locks (retry_at) WHERE retry_at IS NOT NULL;`,
		},
	}
}

func oauthRefreshLeases() Migration {
	return Migration{
		Version: 11,
		Name:    "oauth_refresh_leases",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS oauth_refresh_leases (
  account_id        TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL,
  generation        INTEGER NOT NULL,
  token_fingerprint TEXT NOT NULL,
  lease_until_ms    BIGINT NOT NULL,
  acquired_at_ms    BIGINT NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_oauth_refresh_leases_expiry
  ON oauth_refresh_leases (lease_until_ms);`,
		},
	}
}

func customProviders() Migration {
	return Migration{
		Version: 12,
		Name:    "custom_providers",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS custom_providers (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('openai-compatible','anthropic-compatible')),
  base_url        TEXT NOT NULL,
  credential_ref  TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  models_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  headers_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);`,
		},
	}
}

func providerModels() Migration {
	return Migration{
		Version: 13,
		Name:    "provider_models",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS provider_models (
  provider   TEXT NOT NULL,
  model_id   TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, model_id)
);`,
		},
	}
}

func proxies() Migration {
	return Migration{
		Version: 14,
		Name:    "proxies",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS proxies (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  protocol                    TEXT NOT NULL CHECK (protocol IN ('http','https','socks5')),
  is_relay                    BOOLEAN NOT NULL DEFAULT FALSE,
  host                        TEXT NOT NULL,
  port                        INTEGER NOT NULL,
  username                    TEXT,
  password                    TEXT,
  priority                    INTEGER NOT NULL DEFAULT 100,
  weight                      INTEGER NOT NULL DEFAULT 100,
  max_concurrency             INTEGER NOT NULL DEFAULT 8,
  active                      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL,
  cooldown_until              TIMESTAMPTZ,
  cooldown_level              INTEGER NOT NULL DEFAULT 0,
  consecutive_use_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at                TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL,
  last_test_at                TIMESTAMPTZ,
  last_test_success_at        TIMESTAMPTZ,
  last_test_success_latency_ms INTEGER,
  last_test_error_at          TIMESTAMPTZ,
  last_test_error             TEXT,
  last_test_status_code       INTEGER
);`,
			`CREATE INDEX IF NOT EXISTS idx_proxies_priority
  ON proxies (priority, name, id);`,
			`CREATE INDEX IF NOT EXISTS idx_proxies_cooldown
  ON proxies (cooldown_until) WHERE cooldown_until IS NOT NULL;`,
		},
	}
}

func proxyHealth() Migration {
	return Migration{
		Version: 15,
		Name:    "proxy_health",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS proxy_health (
  proxy_id          TEXT PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'healthy',
  error_kind        TEXT,
  status_code       INTEGER,
  sanitized_message TEXT,
  occurred_at       TIMESTAMPTZ,
  retry_at          TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_proxy_health_retry
  ON proxy_health (retry_at) WHERE retry_at IS NOT NULL;`,
		},
	}
}

func proxySettings() Migration {
	return Migration{
		Version: 16,
		Name:    "proxy_settings",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS proxy_settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled                     BOOLEAN NOT NULL DEFAULT FALSE,
  excluded_providers_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  smart_dynamic_routing       BOOLEAN NOT NULL DEFAULT FALSE,
  smart_dynamic_proxy_count   INTEGER NOT NULL DEFAULT 2,
  routing_preset              TEXT NOT NULL DEFAULT 'auto',
  target_concurrent           INTEGER NOT NULL DEFAULT 0,
  web_search_preference       TEXT NOT NULL DEFAULT 'auto',
  updated_at                  TIMESTAMPTZ NOT NULL
);`,
		},
	}
}

func warpAccounts() Migration {
	return Migration{
		Version: 17,
		Name:    "warp_accounts",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS warp_accounts (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL DEFAULT '',
  device_id             TEXT NOT NULL,
  access_token          TEXT NOT NULL,
  license_key           TEXT NOT NULL,
  private_key           TEXT NOT NULL,
  address_v4            TEXT NOT NULL,
  address_v6            TEXT NOT NULL,
  public_key            TEXT NOT NULL,
  endpoint              TEXT NOT NULL,
  endpoint_port         INTEGER NOT NULL DEFAULT 2408,
  dns                   TEXT NOT NULL DEFAULT '1.1.1.1',
  mtu                   INTEGER NOT NULL DEFAULT 1280,
  socks_port            INTEGER NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  running               BOOLEAN NOT NULL DEFAULT FALSE,
  pid                   INTEGER,
  prefer_ipv6           BOOLEAN NOT NULL DEFAULT TRUE,
  custom_endpoint       TEXT,
  persistent_keepalive  INTEGER NOT NULL DEFAULT 15,
  created_at            TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ
);`,
			`CREATE INDEX IF NOT EXISTS idx_warp_accounts_socks_port
  ON warp_accounts (socks_port);`,
		},
	}
}

func filterRules() Migration {
	return Migration{
		Version: 18,
		Name:    "filter_rules",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS filter_rules (
  id          BIGSERIAL PRIMARY KEY,
  rule_id     TEXT NOT NULL UNIQUE,
  pattern     TEXT NOT NULL,
  replacement TEXT NOT NULL DEFAULT '',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_regex    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ
);`,
			`CREATE INDEX IF NOT EXISTS idx_filter_rules_sort_order
  ON filter_rules (sort_order);`,
		},
	}
}

func ipBans() Migration {
	return Migration{
		Version: 19,
		Name:    "ip_bans",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS ip_bans (
  ip         TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_ip_bans_created_at
  ON ip_bans (created_at);`,
		},
	}
}

func securityOffenses() Migration {
	return Migration{
		Version: 20,
		Name:    "security_offenses",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS security_offenses (
  ip                TEXT NOT NULL,
  category          TEXT NOT NULL,
  strike_count      INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL,
  last_event_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (ip, category)
);`,
		},
	}
}

func backupMetadata() Migration {
	return Migration{
		Version: 21,
		Name:    "backup_metadata",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS backup_metadata (
  id              TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL,
  size_bytes      BIGINT NOT NULL,
  source_app      TEXT NOT NULL,
  source_version  INTEGER NOT NULL,
  label           TEXT NOT NULL DEFAULT '',
  storage_path    TEXT NOT NULL,
  content_hash    TEXT NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_backup_metadata_created_at
  ON backup_metadata (created_at);`,
		},
	}
}

func requestHistory() Migration {
	return Migration{
		Version: 22,
		Name:    "request_history",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS request_history (
  id                 BIGSERIAL PRIMARY KEY,
  trace_id           TEXT NOT NULL UNIQUE,
  endpoint           TEXT NOT NULL,
  surface            TEXT NOT NULL,
  api_key_id         TEXT,
  api_key_prefix     TEXT,
  provider           TEXT,
  model              TEXT,
  status             INTEGER NOT NULL,
  error_kind         TEXT,
  stream             BOOLEAN NOT NULL DEFAULT FALSE,
  started_at         TIMESTAMPTZ NOT NULL,
  finished_at        TIMESTAMPTZ NOT NULL,
  duration_ms        INTEGER NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cached_tokens      INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens   INTEGER,
  total_tokens       INTEGER,
  usage_source       TEXT NOT NULL DEFAULT 'unknown',
  meta_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_name        TEXT NOT NULL DEFAULT 'unknown',
  client_source      TEXT NOT NULL DEFAULT 'unknown',
  message_count      INTEGER NOT NULL DEFAULT 0,
  tool_count         INTEGER NOT NULL DEFAULT 0,
  image_count        INTEGER NOT NULL DEFAULT 0,
  tfft_ms            INTEGER,
  client_ip          TEXT
);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_started_at
  ON request_history (started_at);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_status_id
  ON request_history (status, id);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_provider_status_id
  ON request_history (provider, status, id);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_api_key_started
  ON request_history (api_key_id, started_at);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_provider_started
  ON request_history (provider, started_at);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_model_started
  ON request_history (model, started_at);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_api_key_prefix
  ON request_history (api_key_prefix, started_at);`,
			`CREATE INDEX IF NOT EXISTS idx_request_history_client_ip
  ON request_history (client_ip, started_at);`,
		},
	}
}

func requestPayloads() Migration {
	return Migration{
		Version: 23,
		Name:    "request_payloads",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS request_payloads (
  request_id           TEXT PRIMARY KEY,
  client_request       BYTEA,
  provider_request     BYTEA,
  provider_response    BYTEA,
  client_response      BYTEA,
  client_request_meta  BYTEA,
  provider_request_meta BYTEA,
  provider_response_meta BYTEA,
  client_response_meta BYTEA,
  created_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_request_payloads_updated_at
  ON request_payloads (updated_at);`,
		},
	}
}

func consoleLogs() Migration {
	return Migration{
		Version: 24,
		Name:    "console_logs",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS console_logs (
  id    BIGSERIAL PRIMARY KEY,
  ts    TIMESTAMPTZ NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  msg   TEXT NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_console_logs_ts         ON console_logs (ts);`,
			`CREATE INDEX IF NOT EXISTS idx_console_logs_scope_ts   ON console_logs (scope, ts);`,
			`CREATE INDEX IF NOT EXISTS idx_console_logs_level_ts   ON console_logs (level, ts);`,
		},
	}
}

func warpMetrics() Migration {
	return Migration{
		Version: 25,
		Name:    "warp_metrics",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS warp_metrics (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  label        TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  socks_port   INTEGER NOT NULL,
  rss_kb       INTEGER NOT NULL DEFAULT 0,
  rx_bytes     INTEGER NOT NULL DEFAULT 0,
  tx_bytes     INTEGER NOT NULL DEFAULT 0,
  healthy      BOOLEAN NOT NULL DEFAULT FALSE,
  egress_ip    TEXT,
  collected_at TIMESTAMPTZ NOT NULL
);`,
			`CREATE INDEX IF NOT EXISTS idx_warp_metrics_account_time
  ON warp_metrics (account_id, collected_at);`,
		},
	}
}
