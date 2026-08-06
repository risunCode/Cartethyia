import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createConfigPersistence, createRuntimePersistence, type PersistenceEnv } from "../../src/storage";
import { buildSessionCookie, guardConsoleRequest, isSameOriginRequest, signSessionToken } from "../../src/console/services";
import { BACKUP_APP, BACKUP_TABLES, validateRestorePayload } from "../../src/storage/main/backup";

function testEnv(dataDir: string): PersistenceEnv {
  return { dataDir, dbPath: join(dataDir, "config.sqlite"), runtimeDbPath: join(dataDir, "runtime.sqlite"), assetDir: join(dataDir, "assets"), logRetentionDays: 14, assetRetentionDays: 7, maxFlightsPerIp: 40 };
}

// ── Legacy (src.old) shapes, embedded verbatim so tests exercise the exact
// databases a pre-cutover deployment would leave on disk. ──────────────

const LEGACY_CONFIG_SQL = `
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
  sticky_limit INTEGER NOT NULL DEFAULT 1,
  sticky_enabled INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
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
CREATE TABLE IF NOT EXISTS filter_rules (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filter_rules_provider ON filter_rules(provider);
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
  active INTEGER NOT NULL DEFAULT 1,
  cooldown_until TEXT,
  cooldown_level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxies_priority ON proxies(priority, name, id);
CREATE INDEX IF NOT EXISTS idx_proxies_cooldown ON proxies(cooldown_until) WHERE cooldown_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS proxy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  excluded_providers_json TEXT NOT NULL DEFAULT '[]',
  smart_dynamic_routing INTEGER NOT NULL DEFAULT 0,
  smart_dynamic_proxy_count INTEGER NOT NULL DEFAULT 2,
  updated_at TEXT NOT NULL
);
`;

const LEGACY_RUNTIME_SQL = `
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

const LEGACY_TS = "2024-01-01T00:00:00.000Z";
const LEGACY_UTC_TS = "2024-01-01 00:00:00";

/** Builds a config database exactly as the legacy release would have left it. */
function createLegacyConfigDb(env: PersistenceEnv): void {
  const db = new Database(env.dbPath, { create: true });
  db.exec(LEGACY_CONFIG_SQL);
  db.query("INSERT INTO settings (id, password_hash, password_version, jwt_secret, settings_json, initialized_at, updated_at) VALUES (1, ?, 1, NULL, ?, ?, ?)").run("legacy-hash", '{"a":1}', LEGACY_TS, LEGACY_TS);
  db.query("INSERT INTO api_keys (id, name, key, key_prefix, active, created_at) VALUES (?, ?, ?, ?, 1, ?)").run("legacy-key", "Legacy Key", "legacy-key-value", "sk-legacy", LEGACY_TS);
  db.query("INSERT INTO model_aliases (alias, model, created_at) VALUES (?, ?, ?)").run("legacy-alias", "openai/o1", LEGACY_TS);
  db.query("INSERT INTO combos (id, name, models_json, strategy, sticky_limit, created_at, updated_at) VALUES (?, ?, ?, 'fallback', 1, ?, ?)").run("legacy-combo", "Legacy Combo", '["gpt-4o","gpt-4o-mini"]', LEGACY_TS, LEGACY_TS);
  db.query("INSERT INTO access_rules (scope, mode, entries_json, updated_at) VALUES ('default', 'open', '[]', ?)").run(LEGACY_TS);
  db.query("INSERT INTO provider_routing (provider, strategy, sticky_limit, sticky_enabled, updated_at) VALUES ('openai', 'priority', 1, 0, ?)").run(LEGACY_TS);
  db.query("INSERT INTO provider_accounts (id, provider, name, credential_kind, credential, credential_hint, priority, active, created_at, updated_at) VALUES (?, 'openai', 'Legacy Account', 'api_key', 'legacy-account-secret', 'legacy-account-secret', 100, 1, ?, ?)").run("legacy-account", LEGACY_TS, LEGACY_TS);
  db.query("INSERT INTO provider_account_health (account_id, status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at) VALUES ('legacy-account', 'cooling_down', 'provider_rate_limited', 429, 'legacy-message', ?, NULL, ?)").run(LEGACY_TS, LEGACY_TS);
  db.query("INSERT INTO filter_rules (id, provider, mode, patterns_json, created_at, updated_at) VALUES ('filter-1', 'openai', 'allow', '[]', ?, ?)").run(LEGACY_TS, LEGACY_TS);
  db.query("INSERT INTO custom_providers (id, slug, name, type, base_url, credential, timeout_seconds, models_json, headers_json, created_at, updated_at) VALUES ('legacy-custom', 'legacy-custom', 'Legacy Custom', 'openai-compatible', 'https://legacy.test/v1', 'legacy-cred', 30, '[]', '{}', ?, ?)").run(LEGACY_TS, LEGACY_TS);
  db.query("INSERT INTO proxies (id, name, protocol, is_relay, host, port, username, password, priority, active, created_at, updated_at) VALUES ('legacy-proxy', 'Legacy Proxy', 'http', 0, '127.0.0.1', 8080, NULL, NULL, 100, 1, ?, ?)").run(LEGACY_TS, LEGACY_TS);
  db.query("INSERT INTO proxy_settings (id, enabled, excluded_providers_json, smart_dynamic_routing, smart_dynamic_proxy_count, updated_at) VALUES (1, 0, '[]', 0, 2, ?)").run(LEGACY_TS);
  db.close();
}

/** Builds a runtime database exactly as the legacy src.old would have left it (one row). */
function createLegacyRuntimeDb(env: PersistenceEnv): void {
  const db = new Database(env.runtimeDbPath, { create: true });
  db.exec(LEGACY_RUNTIME_SQL);
  db.query(
    "INSERT INTO request_history (trace_id, endpoint, surface, api_key_id, api_key_prefix, provider, model, status, error_kind, stream, started_at, finished_at, duration_ms, input_tokens, output_tokens, total_tokens, usage_source, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing', '{}')",
  ).run("legacy-trace-1", "/v1/chat/completions", "openai", "legacy-key", "sk-legacy", "openai", "gpt-4o", 200, null, 0, LEGACY_UTC_TS, LEGACY_UTC_TS, 150, 10, 20, 30);
  db.query("INSERT INTO request_details (request_id, redacted_request, redacted_response, payload_mode, payload_sha256, message_count, tool_names, image_count, created_at) VALUES (1, ?, NULL, 'store', NULL, 5, 'grep', 1, ?)").run('{"role":"user","content":"legacy-body"}', LEGACY_UTC_TS);
  db.query("INSERT INTO console_logs (ts, level, scope, msg) VALUES (?, 'info', 'boot', 'legacy boot log')").run(LEGACY_UTC_TS);
  db.close();
}

/** Builds a legacy runtime database whose request_history contains duplicate trace ids. */
function createLegacyDuplicateTraceRuntimeDb(env: PersistenceEnv): void {
  const db = new Database(env.runtimeDbPath, { create: true });
  db.exec(LEGACY_RUNTIME_SQL);
  for (const id of [1, 2]) {
    db.query(
      "INSERT INTO request_history (trace_id, endpoint, surface, provider, model, status, stream, started_at, finished_at, duration_ms) VALUES ('dup-trace', '/v1/chat/completions', 'openai', 'openai', 'gpt-4o', 200, 0, ?, ?, 10)",
    ).run(`2024-01-0${id} 00:00:00`, `2024-01-0${id} 00:00:00`);
  }
  db.query(
    "INSERT INTO request_history (trace_id, endpoint, surface, provider, model, status, stream, started_at, finished_at, duration_ms) VALUES ('other-trace', '/v1/messages', 'anthropic', 'anthropic', 'claude-3-5-sonnet', 200, 0, ?, ?, 10)",
  ).run("2024-01-01 00:00:00", "2024-01-01 00:00:00");
  db.close();
}

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function countRows(db: Database, table: string): number {
  const row: unknown = db.query(`SELECT COUNT(*) AS count FROM \"${table.replaceAll('"', '""')}\"`).get();
  if (typeof row !== "object" || row === null || !("count" in row) || typeof row.count !== "number") throw new Error(`unable to count table ${table}`);
  return row.count;
}

function utcSlot(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Windows defers releasing freshly-closed SQLite handles (WAL/-shm cleanup
 * races with the OS), so a single rmSync of a temp data dir can hit EBUSY.
 * Retry briefly — the files are always gone after the OS releases the handle.
 */
function removeTempDir(dir: string): void {
  // Force GC to release any lingering SQLite handles before attempting removal.
  try { Bun.gc(true); } catch {}
  Bun.sleepSync(300);
  // Windows holds freshly-closed bun:sqlite WAL/-shm file handles for a
  // non-deterministic period after Database.close(). Node's rmSync has
  // built-in retry support (maxRetries + retryDelay).
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 200 });
    return;
  } catch (err) {
    // If the only error is EBUSY/ENOTEMPTY from Windows file handle lag,
    // the test itself has already passed — the temp dir will be cleaned up
    // by the OS on the next reboot or temp sweep. Don't fail the test.
    if (err instanceof Error && "code" in err && (err.code === "EBUSY" || err.code === "ENOTEMPTY")) {
      console.warn(`[cleanup] deferring temp dir ${dir} — Windows file handle race`);
      return;
    }
    // Re-throw genuine errors (ENOENT is fine — dir already gone).
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}

describe("security and persistence contracts", () => {
  test("rejects cross-origin mutations and missing JSON content type", async () => {
    const crossOrigin = new Request("http://proxy.test/console/api/settings", { method: "POST", headers: { origin: "https://evil.test", host: "proxy.test", "content-type": "application/json" } });
    expect(isSameOriginRequest(crossOrigin)).toBe(false);
    const missingJson = new Request("http://proxy.test/console/api/settings", { method: "POST", headers: { origin: "http://proxy.test", host: "proxy.test" } });
    const verdict = await guardConsoleRequest(missingJson, { jwtSecret: "secret", passwordVersion: 1, trustProxy: false });
    expect(verdict).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  test("accepts a signed session only with the secure console cookie contract", async () => {
    const token = await signSessionToken({ secret: "secret", pv: 1, ttlSeconds: 60 });
    const cookie = buildSessionCookie(token, 60, true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    const request = new Request("https://proxy.test/console/api/settings", { method: "GET", headers: { cookie } });
    const verdict = await guardConsoleRequest(request, { jwtSecret: "secret", passwordVersion: 1, trustProxy: false });
    expect(verdict.ok).toBe(true);
  });

  test("keeps configuration and runtime persistence in separate sqlite files", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-contract-"));
    const env = testEnv(dataDir);
    const config = createConfigPersistence(env);
    const runtime = createRuntimePersistence(env);
    expect(config.env.dbPath).not.toBe(runtime.env.runtimeDbPath);
    expect(config.env.dbPath).toContain("config.sqlite");
    expect(runtime.env.runtimeDbPath).toContain("runtime.sqlite");
    runtime.close();
    config.close();
    removeTempDir(dataDir);
  });

  test("preserves raw OAuth bearer credentials without fabricating refresh configuration", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-raw-oauth-"));
    const env = testEnv(dataDir);
    try {
      const config = createConfigPersistence(env);
      config.accounts.create({ id: "raw-oauth", provider: "kimchi", name: "Raw OAuth", credentialKind: "oauth", credential: "raw-bearer", credentialHint: "…arer" });
      await expect(config.stores.oauthToken.get("raw-oauth")).resolves.toEqual({ accessToken: "raw-bearer", expiresAtMs: null, refreshToken: null, kind: "oauth" });
      config.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("persists routing preset and target concurrency across config reopen", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-routing-"));
    const env = testEnv(dataDir);
    const first = createConfigPersistence(env);
    first.proxies.patchSettings({ routingPreset: "target-concurrent", targetConcurrent: 4 });
    first.close();
    const reopened = createConfigPersistence(env);
    expect(reopened.proxies.getSettings()).toMatchObject({ routingPreset: "target-concurrent", targetConcurrent: 4 });
    reopened.close();
    removeTempDir(dataDir);
  });

  test("migrates renamed provider IDs across routing persistence", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-provider-rename-"));
    const env = testEnv(dataDir);
    const initial = createConfigPersistence(env);
    initial.settings.ensure();
    initial.close();
    const raw = new Database(env.dbPath);
    const timestamp = "2026-08-04T00:00:00.000Z";
    raw.query("INSERT INTO provider_accounts (id, provider, name, credential_kind, credential, credential_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-codex", "openai-codex", "Legacy Codex", "oauth", "secret", "secr", timestamp, timestamp);
    raw.query("INSERT INTO provider_models (provider, model_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("opencode-free", "big-pickle", "manual", timestamp, timestamp);
    raw.query("INSERT INTO model_aliases (alias, model, created_at) VALUES (?, ?, ?)").run("legacy", "claude-code/claude-sonnet-5", timestamp);
    raw.query("INSERT INTO combos (id, name, models_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("combo", "Combo", JSON.stringify(["openai-codex/gpt-5.6-sol"]), timestamp, timestamp);
    raw.close();
    try {
      const migrated = createConfigPersistence(env);
      expect(migrated.accounts.get("legacy-codex")).toMatchObject({ provider: "codex" });
      expect(migrated.providerModels.list("opencodeft")).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: "big-pickle" })]));
      expect(migrated.aliases.get("legacy")).toMatchObject({ model: "claude/claude-sonnet-5" });
      // provider_routing table was removed in dead-code cleanup — verify
      // migrations via the actual repositories instead.
      expect(migrated.combos.get("combo")).toMatchObject({ models: ["codex/gpt-5.6-sol"] });
      migrated.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("persists both last proxy test outcomes across config reopen", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-proxy-tests-"));
    const env = testEnv(dataDir);
    const first = createConfigPersistence(env);
    const proxy = first.proxies.create({ id: "proxy-history", name: "History", protocol: "http", host: "127.0.0.1", port: 8080 });
    first.proxies.recordTest(proxy.id, { testedAt: "2026-08-03T10:00:00.000Z", ok: true, latencyMs: 42, statusCode: 204, error: null });
    first.proxies.recordTest(proxy.id, { testedAt: "2026-08-03T10:01:00.000Z", ok: false, latencyMs: null, statusCode: 502, error: "Canary request returned HTTP 502" });
    first.close();
    const reopened = createConfigPersistence(env);
    const saved = reopened.proxies.get(proxy.id);
    expect(saved).toMatchObject({ lastTestAt: "2026-08-03T10:01:00.000Z", lastTestSuccessAt: "2026-08-03T10:00:00.000Z", lastTestSuccessLatencyMs: 42, lastTestErrorAt: "2026-08-03T10:01:00.000Z", lastTestError: "Canary request returned HTTP 502", lastTestStatusCode: 502 });
    reopened.close();
    removeTempDir(dataDir);
  });

  test("persists all API-key limits and rejects backup table injection", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-backup-contract-"));
    const env = testEnv(dataDir);
    const config = createConfigPersistence(env);
    const key = config.apiKeys.create({ id: "limits-key", name: "Limits", key: "secret-value", keyPrefix: "secret", rateLimitRpm: 12, dailyTokenLimit: 100, monthlyTokenLimit: 500, oneTimeTokenLimit: 50, maxConcurrentRequests: 2 });
    expect(key).toMatchObject({ rateLimitRpm: 12, dailyTokenLimit: 100, monthlyTokenLimit: 500, oneTimeTokenLimit: 50, maxConcurrentRequests: 2 });
    const backup = config.backup();
    expect(validateRestorePayload({ ...backup, tables: { ...backup.tables, injected: [] } })).toMatchObject({ ok: false });
    config.close();
    removeTempDir(dataDir);
  });

  test("opens a legacy config database and preserves rows after schema upgrade", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-legacy-config-"));
    const env = testEnv(dataDir);
    createLegacyConfigDb(env);
    try {
      const first = createConfigPersistence(env);
      // Legacy rows are readable through current repositories.
      expect(first.settings.get()).toMatchObject({ passwordHash: "legacy-hash", passwordVersion: 1, settingsJson: { a: 1 } });
      expect(first.apiKeys.getById("legacy-key")).toMatchObject({ id: "legacy-key", keyPrefix: "sk-legacy", active: true });
      expect(first.accounts.list()).toHaveLength(1);
      expect(first.accounts.get("legacy-account")).toMatchObject({ credentialKind: "api_key", provider: "openai" });
      expect(first.proxies.list()).toHaveLength(1);
      expect(first.proxies.get("legacy-proxy")).toMatchObject({ id: "legacy-proxy", maxConcurrency: 8, weight: 100, lastTestAt: null });
      expect(first.proxies.getSettings()).toMatchObject({ enabled: false, routingPreset: "auto", targetConcurrent: 0 });
      expect(first.aliases.get("legacy-alias")).toMatchObject({ alias: "legacy-alias", model: "openai/o1" });
      expect(first.combos.get("legacy-combo")).toMatchObject({ id: "legacy-combo", models: ["gpt-4o", "gpt-4o-mini"], strategy: "fallback" });
      expect(first.accessRules.get("default")).toMatchObject({ scope: "default", mode: "open" });
      expect(first.customProviders.getBySlug("legacy-custom")).toMatchObject({ id: "legacy-custom", baseUrl: "https://legacy.test/v1" });
      await expect(first.accountHealth.get("legacy-account")).resolves.toMatchObject({ status: "cooling_down", failureKind: "provider_rate_limited", statusCode: 429, sanitizedMessage: "legacy-message" });
      await expect(first.stores.routeHealth.readHealth("account", "legacy-account")).resolves.toMatchObject({ status: "cooling_down" });
      await expect(first.stores.accountHealth.get("legacy-account")).resolves.toMatchObject({ accountId: "legacy-account", failureCount: 0, generation: 0 });
      first.close();

      // Upgrade columns were added exactly once and legacy rows/tables survive.
      const raw = new Database(env.dbPath);
      expect(columnsOf(raw, "proxy_settings")).toEqual(expect.arrayContaining(["routing_preset", "target_concurrent"]));
      expect(columnsOf(raw, "proxies")).toEqual(expect.arrayContaining(["max_concurrency", "weight", "last_test_at", "last_test_success_at", "last_test_success_latency_ms", "last_test_error_at", "last_test_error", "last_test_status_code"]));
      expect(columnsOf(raw, "provider_account_health")).toEqual(expect.arrayContaining(["provider_id", "disabled_until_ms", "failure_count", "generation"]));
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("idx_custom_providers_slug")).toBeFalsy();
      const health = raw.query("SELECT account_id, status FROM provider_account_health WHERE account_id = ?").get("legacy-account") as { account_id: string; status: string };
      expect(health).toMatchObject({ account_id: "legacy-account", status: "cooling_down" });
      // provider_routing table was removed in dead-code cleanup.
      // Legacy filter_rules table is dropped and recreated with new schema.
      expect(columnsOf(raw, "filter_rules")).toEqual(expect.arrayContaining(["rule_id", "pattern", "replacement", "is_active", "is_regex", "sort_order"]));
      const proxySettingsColumns = columnsOf(raw, "proxy_settings");
      raw.close();

      // Reopening applies nothing new — column set is stable.
      const reopened = createConfigPersistence(env);
      expect(reopened.apiKeys.getById("legacy-key")).toMatchObject({ keyPrefix: "sk-legacy" });
      reopened.close();
      const raw2 = new Database(env.dbPath);
      expect(columnsOf(raw2, "proxy_settings")).toEqual(proxySettingsColumns);
      expect(columnsOf(raw2, "proxies")).toEqual(expect.arrayContaining(["max_concurrency", "weight"]));
      raw2.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("writes through upgraded legacy config columns and keeps upgrade idempotent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-legacy-upgrade-"));
    const env = testEnv(dataDir);
    createLegacyConfigDb(env);
    try {
      const first = createConfigPersistence(env);
      first.proxies.patchSettings({ routingPreset: "target-concurrent", targetConcurrent: 4, smartDynamicProxyCount: 3 });
      first.proxies.recordTest("legacy-proxy", { testedAt: "2026-08-03T09:00:00.000Z", ok: true, latencyMs: 12, statusCode: 204, error: null });
      first.close();
      const reopened = createConfigPersistence(env);
      expect(reopened.proxies.getSettings()).toMatchObject({ routingPreset: "target-concurrent", targetConcurrent: 4, smartDynamicProxyCount: 3 });
      expect(reopened.proxies.get("legacy-proxy")).toMatchObject({ lastTestAt: "2026-08-03T09:00:00.000Z", lastTestSuccessAt: "2026-08-03T09:00:00.000Z", lastTestSuccessLatencyMs: 12, lastTestStatusCode: 204 });
      reopened.close();
      const raw = new Database(env.dbPath);
      const proxyColumns = columnsOf(raw, "proxies");
      const proxySettingsColumns = columnsOf(raw, "proxy_settings");
      expect(new Set(proxyColumns).size).toBe(proxyColumns.length);
      expect(new Set(proxySettingsColumns).size).toBe(proxySettingsColumns.length);
      raw.close();
      // A third open still succeeds and the same data is still there.
      const third = createConfigPersistence(env);
      expect(third.proxies.get("legacy-proxy")).toMatchObject({ lastTestAt: "2026-08-03T09:00:00.000Z" });
      third.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("opens a legacy runtime database, upgrades it, and reuses legacy tables", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-legacy-runtime-"));
    const env = testEnv(dataDir);
    createLegacyRuntimeDb(env);
    try {
      const runtime = createRuntimePersistence(env);
      const page = runtime.metadata.queryRequests({ limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ requestId: "legacy-trace-1", endpoint: "/v1/chat/completions", apiKeyPrefix: "sk-legacy", provider: "openai", model: "gpt-4o", status: 200, mode: "non_stream", usageSource: "missing", clientName: "unknown", clientSource: "unknown", messageCount: 0, toolCount: 0, imageCount: 0 });

      // Read-after-write into the upgraded legacy table.
      const handle = runtime.telemetry.start({ requestId: "fresh-trace", endpoint: "/v1/messages", surface: "anthropic", apiKeyId: null, apiKeyPrefix: null, clientName: "claude_code", clientSource: "user_agent", startedAt: new Date().toISOString(), messageCount: 3, toolCount: 1, imageCount: 1 });
      await handle.finish({ statusCode: 200, errorKind: null, providerId: "anthropic", model: "claude-3-5-sonnet", mode: "non_stream", usage: null, messageCount: 3, toolCount: 1, imageCount: 1 });
      expect(runtime.pendingWrites()).toBe(1);
      const after = runtime.metadata.queryRequests({ limit: 10 });
      expect(runtime.pendingWrites()).toBe(0);
      expect(after.items.find((row) => row.requestId === "fresh-trace")).toMatchObject({ provider: "anthropic", model: "claude-3-5-sonnet", status: 200, clientName: "claude_code", clientSource: "user_agent", messageCount: 3, toolCount: 1, imageCount: 1 });
      expect(after.items).toHaveLength(2);

      // Unique legacy trace ids enable upsert semantics: reusing a legacy trace updates in place.
      const reuse = runtime.telemetry.start({ requestId: "legacy-trace-1", endpoint: "/v1/chat/completions", surface: "openai", apiKeyId: null, apiKeyPrefix: null, clientName: "unknown", clientSource: "unknown", startedAt: new Date().toISOString(), messageCount: 0, toolCount: 0, imageCount: 0 });
      await reuse.finish({ statusCode: 502, errorKind: "provider_unavailable", providerId: "openai", model: "gpt-4o", mode: "non_stream", usage: null, messageCount: 0, toolCount: 0, imageCount: 0 });
      const reused = runtime.metadata.queryRequests({ limit: 10 });
      expect(reused.items.filter((row) => row.requestId === "legacy-trace-1")).toHaveLength(1);
      const reusedTrace = reused.items.find((row) => row.requestId === "legacy-trace-1");
      if (reusedTrace?.status !== 502) throw new Error(`expected reused trace status 502, received ${String(reusedTrace?.status)}`);
      expect(reused.items).toHaveLength(2);
      runtime.close();

      const raw = new Database(env.runtimeDbPath);
      expect(columnsOf(raw, "request_history")).toEqual(expect.arrayContaining(["client_name", "client_source", "message_count", "tool_count", "image_count"]));
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("uq_request_history_trace_id")).toBeTruthy();
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("idx_request_history_trace_id")).toBeFalsy();
      // Legacy detail tables are kept but stored payload bodies were stripped.
      expect(raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'request_details'").get()).toBeTruthy();
      const detail = raw.query("SELECT redacted_request, redacted_response, payload_mode, message_count, tool_names, image_count FROM request_details WHERE request_id = 1").get() as { redacted_request: string | null; redacted_response: string | null; payload_mode: string; message_count: number; tool_names: string; image_count: number };
      expect(detail).toMatchObject({ redacted_request: null, redacted_response: null, payload_mode: "meta", message_count: 5, tool_names: "grep", image_count: 1 });
      const log = raw.query("SELECT msg FROM console_logs ORDER BY id DESC LIMIT 1").get() as { msg: string };
      expect(log.msg).toBe("legacy boot log");
      raw.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("legacy runtime databases with duplicate traces stay writable without a unique index", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-legacy-dup-runtime-"));
    const env = testEnv(dataDir);
    createLegacyDuplicateTraceRuntimeDb(env);
    try {
      const runtime = createRuntimePersistence(env);
      expect(runtime.metadata.queryRequests({ limit: 10 }).items).toHaveLength(3);
      const handle = runtime.telemetry.start({ requestId: "after-dup", endpoint: "/v1/messages", surface: "anthropic", apiKeyId: null, apiKeyPrefix: null, clientName: "codex", clientSource: "user_agent", startedAt: new Date().toISOString(), messageCount: 0, toolCount: 0, imageCount: 0 });
      await handle.finish({ statusCode: 200, errorKind: null, providerId: "anthropic", model: "claude-3-5-sonnet", mode: "non_stream", usage: null, messageCount: 0, toolCount: 0, imageCount: 0 });
      expect(runtime.metadata.queryRequests({ limit: 20 }).items).toHaveLength(4);
      runtime.close();
      const raw = new Database(env.runtimeDbPath);
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("uq_request_history_trace_id")).toBeFalsy();
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("idx_request_history_trace_id")).toBeTruthy();
      raw.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("fresh runtime persistence creates the direct-cutover schema and serves writes on the next read", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-fresh-runtime-"));
    const env = testEnv(dataDir);
    try {
      const runtime = createRuntimePersistence(env);
      const handle = runtime.telemetry.start({ requestId: "fresh-1", endpoint: "/v1/messages", surface: "anthropic", apiKeyId: null, apiKeyPrefix: null, clientName: "cursor", clientSource: "explicit_header", startedAt: new Date().toISOString(), messageCount: 2, toolCount: 0, imageCount: 0 });
      await handle.finish({ statusCode: 200, errorKind: null, providerId: "anthropic", model: "claude-3-5-sonnet", mode: "stream", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, source: "provider" }, messageCount: 2, toolCount: 0, imageCount: 0 });
      runtime.consoleLogs.push("info", "test", "fresh log line");
      const rows = runtime.metadata.queryRequests({ limit: 10 });
      expect(rows.items).toHaveLength(1);
      expect(rows.items[0]).toMatchObject({ requestId: "fresh-1", status: 200, mode: "stream", clientName: "cursor", inputTokens: 5, outputTokens: 7, totalTokens: 12 });
      const aborted = runtime.telemetry.start({ requestId: "aborted-1", endpoint: "/v1/messages", surface: "anthropic", apiKeyId: null, apiKeyPrefix: null, clientName: "cursor", clientSource: "explicit_header", startedAt: new Date().toISOString(), messageCount: 1, toolCount: 0, imageCount: 0 });
      await aborted.finish({ statusCode: 0, errorKind: null, providerId: "anthropic", model: "claude-3-5-sonnet", mode: "stream", usage: null, messageCount: 1, toolCount: 0, imageCount: 0 });
      const completedOnly = runtime.metadata.queryRequests({ limit: 10 });
      expect(completedOnly.items.map((row) => row.requestId)).toEqual(["fresh-1"]);
      expect(runtime.pendingWrites()).toBe(0);
      const logs = runtime.consoleLogs.list({ limit: 10 });
      expect(logs.items.some((log) => log.msg === "fresh log line")).toBe(true);
      runtime.close();

      const raw = new Database(env.runtimeDbPath);
      expect(columnsOf(raw, "request_history")).toEqual(expect.arrayContaining(["client_name", "client_source", "message_count", "tool_count", "image_count"]));
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("request_details")).toBeFalsy();
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("uq_request_history_trace_id")).toBeTruthy();
      raw.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("retention removes only rows past the cutoff and is idempotent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-retention-"));
    const env = testEnv(dataDir);
    mkdirSync(env.assetDir, { recursive: true });
    const assetPath = join(env.assetDir, "legacy-asset.bin");
    writeFileSync(assetPath, "legacy asset payload");
    try {
      const db = new Database(env.runtimeDbPath, { create: true });
      db.exec(LEGACY_RUNTIME_SQL);
      const now = utcSlot(Date.now());
      db.query("INSERT INTO request_history (trace_id, endpoint, surface, provider, model, status, stream, started_at, finished_at, duration_ms) VALUES ('old-1', '/v1/chat/completions', 'openai', 'openai', 'gpt-4o', 200, 0, '2020-01-01 00:00:00', '2020-01-01 00:00:00', 10)").run();
      db.query("INSERT INTO request_history (trace_id, endpoint, surface, provider, model, status, stream, started_at, finished_at, duration_ms) VALUES ('new-1', '/v1/chat/completions', 'openai', 'openai', 'gpt-4o', 200, 0, ?, ?, 10)").run(now, now);
      db.query("INSERT INTO console_logs (ts, level, scope, msg) VALUES ('2020-01-01 00:00:00', 'info', 'boot', 'old log')").run();
      db.query("INSERT INTO console_logs (ts, level, scope, msg) VALUES (?, 'info', 'boot', 'new log')").run(now);
      db.query("INSERT INTO request_details (request_id, redacted_request, redacted_response, payload_mode, message_count, created_at) VALUES (1, NULL, NULL, 'meta', 2, '2020-01-01 00:00:00')").run();
      db.query("INSERT INTO request_details (request_id, redacted_request, redacted_response, payload_mode, message_count, created_at) VALUES (2, NULL, NULL, 'meta', 2, ?)").run(now);
      db.query("INSERT INTO request_tool_calls (request_id, name, bytes, status, created_at) VALUES (1, 'legacy_tool', 10, 'ok', '2020-01-01 00:00:00')").run();
      db.query("INSERT INTO request_assets (request_id, kind, storage_path, created_at) VALUES (1, 'file', ?, '2020-01-01 00:00:00')").run(assetPath);
      db.close();

      const runtime = createRuntimePersistence(env);
      const result = runtime.retain({ logRetentionDays: 1, assetRetentionDays: 1 });
      expect(result).toEqual({ historyRemoved: 1, consoleLogsRemoved: 1, detailsRemoved: 1, toolCallsRemoved: 1, assetFilesRemoved: 1 });
      expect(existsSync(assetPath)).toBe(false);
      const rows = runtime.metadata.queryRequests({ limit: 20 });
      expect(rows.items.map((row) => row.requestId)).not.toContain("old-1");
      expect(rows.items.map((row) => row.requestId)).toContain("new-1");
      const logs = runtime.consoleLogs.list({ limit: 20 });
      expect(logs.items.map((log) => log.msg)).not.toContain("old log");
      expect(logs.items.map((log) => log.msg)).toContain("new log");
      const again = runtime.retain({ logRetentionDays: 1, assetRetentionDays: 1 });
      expect(again).toEqual({ historyRemoved: 0, consoleLogsRemoved: 0, detailsRemoved: 0, toolCallsRemoved: 0, assetFilesRemoved: 0 });
      runtime.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

  test("backup export/validate/restore round-trips every supported table", () => {
    const srcDir = mkdtempSync(join(tmpdir(), "cartethyia-backup-src-"));
    const dstDir = mkdtempSync(join(tmpdir(), "cartethyia-backup-dst-"));
    const srcEnv = testEnv(srcDir);
    const dstEnv = testEnv(dstDir);
    try {
      const src = createConfigPersistence(srcEnv);
      src.settings.ensure();
      src.settings.setPasswordHash("roundtrip-hash");
      src.apiKeys.create({ id: "rt-key", name: "RT Key", key: "rt-secret", keyPrefix: "rt-secret", rateLimitRpm: 60, dailyTokenLimit: 250, monthlyTokenLimit: 600, maxConcurrentRequests: 3 });
      src.proxies.create({ id: "rt-proxy", name: "RT Proxy", protocol: "http", host: "127.0.0.1", port: 3128, weight: 500, maxConcurrency: 5 });
      src.proxies.patchSettings({ routingPreset: "target-concurrent", targetConcurrent: 4 });
      src.accounts.create({ id: "rt-account", provider: "openai", name: "RT Account", credentialKind: "api_key", credential: "rt-account-secret", credentialHint: "rt-account-secret" });
      src.aliases.upsert("rt-alias", "openai/o1");
      src.combos.upsert({ id: "rt-combo", name: "RT Combo", models: ["gpt-4o", "gpt-4o-mini"], strategy: "fallback", stickyLimit: 1 });
      src.accessRules.upsert("global", { mode: "open", entries: ["1.2.3.4"] });
      src.customProviders.upsert({ id: "rt-custom", slug: "rt-custom", name: "RT Custom", type: "openai-compatible", baseUrl: "https://rt.test/v1", credential: "rt-cred", timeoutSeconds: 45, models: ["m1"], customHeaders: { "X-Test": "1" } });
      src.shareLinks.create({ id: "rt-share", apiKeyId: "rt-key", tokenHash: "rt-token-hash" });
      const rawSrc = new Database(srcEnv.dbPath);
      rawSrc.close();

      const backup = src.backup();
      expect(backup.app).toBe(BACKUP_APP);
      expect(Object.keys(backup.tables).sort()).toEqual([...BACKUP_TABLES].sort());

      const validation = validateRestorePayload(backup);
      if (!validation.ok) throw new Error(`backup must validate: ${validation.error}`);
      const expectedCounts: Record<string, number> = { settings: 1, api_keys: 1, share_links: 1, model_aliases: 1, combos: 1, access_rules: 1, provider_accounts: 1, custom_providers: 1, proxies: 1, proxy_settings: 1, ip_bans: 0 };

      const dst = createConfigPersistence(dstEnv);
      const result = dst.restoreBackup(validation);
      expect(result.restored).toMatchObject(expectedCounts);
      expect(dst.settings.get()).toMatchObject({ passwordHash: "roundtrip-hash", passwordVersion: 2 });
      expect(dst.apiKeys.getById("rt-key")).toMatchObject({ rateLimitRpm: 60, dailyTokenLimit: 250, monthlyTokenLimit: 600, maxConcurrentRequests: 3 });
      expect(dst.proxies.get("rt-proxy")).toMatchObject({ weight: 500, maxConcurrency: 5 });
      expect(dst.proxies.getSettings()).toMatchObject({ routingPreset: "target-concurrent", targetConcurrent: 4 });
      expect(dst.accounts.get("rt-account")).toMatchObject({ credentialKind: "api_key", credentialHint: "rt-account-secret" });
      expect(dst.aliases.get("rt-alias")).toMatchObject({ model: "openai/o1" });
      expect(dst.combos.get("rt-combo")).toMatchObject({ models: ["gpt-4o", "gpt-4o-mini"], strategy: "fallback", stickyLimit: 1 });
      expect(dst.accessRules.get("global")).toMatchObject({ mode: "open" });
      expect(dst.customProviders.get("rt-custom")).toMatchObject({ baseUrl: "https://rt.test/v1", timeoutSeconds: 45 });
      expect(dst.shareLinks.getByTokenHash("rt-token-hash")).toMatchObject({ apiKeyId: "rt-key", active: true });
      const rawDst = new Database(dstEnv.dbPath);
      for (const table of BACKUP_TABLES) {
        expect((rawDst.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(expectedCounts[table]!);
      }
      rawDst.close();
      // Re-applying the same backup is stable (delete + insert of identical data).
      dst.restoreBackup(validation);
      expect(dst.apiKeys.list()).toHaveLength(1);
      dst.close();
      src.close();
    } finally {
      removeTempDir(srcDir);
      removeTempDir(dstDir);
    }
  });

  test("restore replaces existing configuration instead of merging", () => {
    const srcDir = mkdtempSync(join(tmpdir(), "cartethyia-replace-src-"));
    const dstDir = mkdtempSync(join(tmpdir(), "cartethyia-replace-dst-"));
    const srcEnv = testEnv(srcDir);
    const dstEnv = testEnv(dstDir);
    try {
      const src = createConfigPersistence(srcEnv);
      src.apiKeys.create({ id: "src-key", name: "Source Key", key: "src-secret", keyPrefix: "src-secret" });
      const validation = validateRestorePayload(src.backup());
      if (!validation.ok) throw new Error(`backup must validate: ${validation.error}`);
      src.close();

      const dst = createConfigPersistence(dstEnv);
      dst.apiKeys.create({ id: "old-a", name: "Old A", key: "old-a-secret", keyPrefix: "old-a-secret" });
      dst.apiKeys.create({ id: "old-b", name: "Old B", key: "old-b-secret", keyPrefix: "old-b-secret" });
      dst.restoreBackup(validation);
      expect(dst.apiKeys.list()).toHaveLength(1);
      expect(dst.apiKeys.getById("src-key")).not.toBeNull();
      expect(dst.apiKeys.getById("old-a")).toBeNull();
      expect(dst.apiKeys.getById("old-b")).toBeNull();
      dst.close();
    } finally {
      removeTempDir(srcDir);
      removeTempDir(dstDir);
    }
  });

  test("restore rolls the whole payload back when a table insert fails", () => {
    const dstDir = mkdtempSync(join(tmpdir(), "cartethyia-rollback-"));
    const dstEnv = testEnv(dstDir);
    try {
      const dst = createConfigPersistence(dstEnv);
      dst.settings.ensure();
      const before = dst.settings.get();
      // Passes structural validation (known column, primitives) but violates NOT NULL on insert.
      const validation = validateRestorePayload({ app: BACKUP_APP, version: 1, tables: { settings: [{ id: 1, password_hash: "x" }] } });
      if (!validation.ok) throw new Error(`expected structural validation to pass: ${validation.error}`);
      expect(() => dst.restoreBackup(validation)).toThrow();
      // The failed restore left the existing row untouched.
      expect(dst.settings.get()).toEqual(before);
      dst.close();
    } finally {
      removeTempDir(dstDir);
    }
  });

  test("backup validation rejects malformed payloads", () => {
    const malformed = [
      [null, /backup must be an object/],
      [[], /backup must be an object/],
      ["cartethyia", /backup must be an object/],
      [{ app: "other", version: 1, tables: {} }, /backup.app must be "cartethyia"/],
      [{ app: BACKUP_APP, version: 2, tables: {} }, /unsupported backup version/],
      [{ app: BACKUP_APP, version: 1 }, /backup.tables must be an object/],
      [{ app: BACKUP_APP, version: 1, tables: [] }, /backup.tables must be an object/],
      [{ app: BACKUP_APP, version: 1, tables: { settings: "not-an-object" } }, /table "settings" must be an object or array/],
      [{ app: BACKUP_APP, version: 1, tables: { api_keys: { id: "x" } } }, /table "api_keys" must be an array/],
      [{ app: BACKUP_APP, version: 1, tables: { api_keys: [null] } }, /api_keys\[0\] must be a row object/],
      [{ app: BACKUP_APP, version: 1, tables: { api_keys: [{ id: { nested: true } }] } }, /api_keys\[0\]\.id must be a primitive/],
    ] as const;
    for (const [payload, pattern] of malformed) {
      const verdict = validateRestorePayload(payload);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.error).toMatch(pattern);
    }
  });

  test("backup validation rejects injected tables and columns", () => {
    const base = { app: BACKUP_APP, version: 1, tables: { api_keys: [{ id: "a", name: "A", key: "k", key_prefix: "k", active: 1, created_at: "2026-01-01T00:00:00.000Z" }] } };
    expect(validateRestorePayload(base).ok).toBe(true);
    const injectedTable = validateRestorePayload({ app: BACKUP_APP, version: 1, tables: { ...base.tables, runtime_telemetry: [] } });
    expect(injectedTable.ok).toBe(false);
    if (!injectedTable.ok) expect(injectedTable.error).toMatch(/unknown table "runtime_telemetry"/);
    const injectedColumn = validateRestorePayload({ app: BACKUP_APP, version: 1, tables: { api_keys: [{ id: "a", injected_column: 1 }] } });
    expect(injectedColumn.ok).toBe(false);
    if (!injectedColumn.ok) expect(injectedColumn.error).toMatch(/api_keys\.injected_column is not a known column/);
  });

  test("backup validation rejects oversized payloads", () => {
    const oversized = Array.from({ length: 100_001 }, (_, i) => ({ alias: `a${i}`, model: "m", created_at: "2026-01-01T00:00:00.000Z" }));
    const verdict = validateRestorePayload({ app: BACKUP_APP, version: 1, tables: { model_aliases: oversized } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/exceeds the 100000 row limit/);
  });

  test("resetAll empties every configuration and runtime table", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cartethyia-reset-all-"));
    const env = testEnv(dataDir);
    try {
      const initialConfig = createConfigPersistence(env);
      initialConfig.settings.ensure();
      initialConfig.close();

      const configSeed = new Database(env.dbPath);
      configSeed.exec("CREATE TABLE reset_probe (value TEXT NOT NULL)");
      configSeed.query("INSERT INTO api_keys (id, name, key, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)").run("reset-key", "Reset key", "secret", "sk-reset", "2026-01-01T00:00:00.000Z");
      configSeed.query("INSERT INTO reset_probe (value) VALUES (?)").run("should disappear");
      configSeed.close();

      const config = createConfigPersistence(env);
      config.resetAll();
      config.close();
      const configAfter = new Database(env.dbPath);
      const configTables = (configAfter.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
      for (const table of configTables) expect(countRows(configAfter, table)).toBe(table === "settings" ? 1 : 0);
      configAfter.close();

      const runtime = createRuntimePersistence(env);
      runtime.consoleLogs.push("error", "test", "must be reset");
      const telemetry = runtime.telemetry.start({ requestId: "reset-request", endpoint: "/v1/chat/completions", surface: "openai-chat", apiKeyId: null, apiKeyPrefix: null, clientName: "unknown", clientSource: "unknown", startedAt: new Date().toISOString(), messageCount: 1, toolCount: 0, imageCount: 0 });
      await telemetry.finish({ statusCode: 500, errorKind: "provider_unavailable", providerId: "test", model: "test-model", mode: "non_stream", usage: null, messageCount: 1, toolCount: 0, imageCount: 0 });
      runtime.close();

      const runtimeSeed = new Database(env.runtimeDbPath);
      runtimeSeed.exec("CREATE TABLE reset_probe (value TEXT NOT NULL)");
      runtimeSeed.query("INSERT INTO reset_probe (value) VALUES (?)").run("should disappear");
      runtimeSeed.close();

      const resetRuntime = createRuntimePersistence(env);
      resetRuntime.resetAll();
      resetRuntime.close();
      const runtimeAfter = new Database(env.runtimeDbPath);
      const runtimeTables = (runtimeAfter.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
      for (const table of runtimeTables) expect(countRows(runtimeAfter, table)).toBe(0);
      runtimeAfter.close();
    } finally {
      removeTempDir(dataDir);
    }
  });

});
