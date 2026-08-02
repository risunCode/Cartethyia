/**
 * Runtime schema - request/error/console-log history and per-request detail
 * metadata. Lives in a database file separate from `schema.ts`'s config db
 * (API keys, providers, settings) so high-frequency traffic logging never
 * contends with config reads/writes. See AGENTS.md "Persistence and logs".
 */

export const RUNTIME_INIT_SQL = `
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
  usage_source TEXT NOT NULL DEFAULT 'missing',
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_request_history_started_at ON request_history(started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_trace_id ON request_history(trace_id);
CREATE INDEX IF NOT EXISTS idx_request_history_api_key_started ON request_history(api_key_id, started_at);
CREATE INDEX IF NOT EXISTS idx_request_history_provider ON request_history(provider);
CREATE INDEX IF NOT EXISTS idx_request_history_model ON request_history(model);

-- Per-request payload/tool metadata, keyed 1:1 to request_history.id.
-- Request/response body columns remain nullable for legacy database
-- compatibility, but new tracking writes metadata only and never stores body
-- contents.
CREATE TABLE IF NOT EXISTS request_details (
  request_id INTEGER PRIMARY KEY,
  redacted_request TEXT,
  redacted_response TEXT,
  payload_mode TEXT,
  payload_sha256 TEXT,
  message_count INTEGER,
  tool_names TEXT,
  image_count INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_details_created_at ON request_details(created_at);

CREATE TABLE IF NOT EXISTS request_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  sha256 TEXT,
  storage_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_assets_request_id ON request_assets(request_id);
CREATE INDEX IF NOT EXISTS idx_request_assets_created_at ON request_assets(created_at);

CREATE TABLE IF NOT EXISTS request_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER,
  sha256 TEXT,
  duration_ms INTEGER,
  status TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_tool_calls_request_id ON request_tool_calls(request_id);
CREATE INDEX IF NOT EXISTS idx_request_tool_calls_created_at ON request_tool_calls(created_at);

CREATE TABLE IF NOT EXISTS console_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_console_logs_ts ON console_logs(ts);
`;
