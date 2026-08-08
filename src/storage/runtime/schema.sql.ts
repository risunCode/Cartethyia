/**
 * Runtime database DDL — raw SQL only, no helpers or migration logic.
 *
 * Fresh runtime schema: the direct-cutover `request_history` (client labels,
 * bounded status fields, compact counts) plus operational `console_logs`.
 * Legacy detail/asset/tool tables are intentionally not created here; legacy
 * databases that already have them keep them for read/retention migration.
 *
 * Running `db.exec(RUNTIME_SCHEMA_SQL)` once at startup is all a fresh DB
 * needs. The `trace_id` UNIQUE promotion happens in `ensureRuntimeSchema`
 * only when legacy DBs have no duplicates.
 */
export const RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS request_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  surface TEXT NOT NULL,
  api_key_id TEXT,
  api_key_prefix TEXT,
  provider TEXT,
  model TEXT,
  status INTEGER NOT NULL,
  error_kind TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_tokens INTEGER,
  usage_source TEXT NOT NULL DEFAULT 'unknown',
  meta_json TEXT NOT NULL DEFAULT '{}',
  client_name TEXT NOT NULL DEFAULT 'unknown',
  client_source TEXT NOT NULL DEFAULT 'unknown',
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0,
  tfft_ms INTEGER,
  client_ip TEXT
);
CREATE TABLE IF NOT EXISTS request_payloads (
  request_id TEXT PRIMARY KEY,
  client_request TEXT,
  provider_request TEXT,
  provider_response TEXT,
  client_response TEXT,
  client_request_meta TEXT,
  provider_request_meta TEXT,
  provider_response_meta TEXT,
  client_response_meta TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_payloads_updated_at ON request_payloads(updated_at);
CREATE TABLE IF NOT EXISTS console_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_console_logs_ts ON console_logs(ts);
CREATE INDEX IF NOT EXISTS idx_console_logs_scope_ts ON console_logs(scope, ts);
CREATE TABLE IF NOT EXISTS warp_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  pid INTEGER NOT NULL,
  socks_port INTEGER NOT NULL,
  rss_kb INTEGER NOT NULL DEFAULT 0,
  rx_bytes INTEGER NOT NULL DEFAULT 0,
  tx_bytes INTEGER NOT NULL DEFAULT 0,
  healthy INTEGER NOT NULL DEFAULT 0,
  egress_ip TEXT,
  collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warp_metrics_account_time ON warp_metrics(account_id, collected_at);

CREATE INDEX IF NOT EXISTS idx_console_logs_level_ts ON console_logs(level, ts);
CREATE INDEX IF NOT EXISTS idx_request_history_started_at ON request_history(started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_status_id ON request_history(status, id);
CREATE INDEX IF NOT EXISTS idx_request_history_provider_status_id ON request_history(provider, status, id);
CREATE INDEX IF NOT EXISTS idx_request_history_api_key_started ON request_history(api_key_id, started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_provider_started ON request_history(provider, started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_model_started ON request_history(model, started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_api_key_prefix ON request_history(api_key_prefix, started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_client_ip ON request_history(client_ip, started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_trace_id ON request_history(trace_id);
`;
