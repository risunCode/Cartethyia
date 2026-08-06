/**
 * Test preload — runs before all test files.
 *
 * Bun auto-loads `.env` from the repo root for `bun test`, same as `bun run` -
 * a developer's local dev overrides (TRACK_PAYLOADS, retention days, rate
 * limits, a bootstrap key, ...) silently leak into every test run and make
 * results depend on whichever machine ran them. Delete every optional env
 * var the config layers (`src/console/env.ts`, `src/config.ts`) read so
 * tests always exercise the documented defaults; per-test overrides still
 * work by setting `Bun.env.X` explicitly inside that test.
 */
for (const key of [
  "CONSOLE_ENABLED", "CONSOLE_PATH", "CONSOLE_PASSWORD", "CONSOLE_JWT_SECRET", "CONSOLE_SESSION_TTL_HOURS",
  "DATA_DIR", "DB_PATH", "RUNTIME_DB_PATH", "ASSET_DIR", "BOOTSTRAP_PROXY_API_KEY", "BOOTSTRAP_PROXY_API_KEY_NAME",
  "TRACK_PAYLOADS", "TRACK_ASSETS", "LOG_RETENTION_DAYS", "ASSET_RETENTION_DAYS",
  "MAX_FLIGHTS_PER_IP", "TRUST_PROXY", "CACHE_MARKERS_ENABLED", "PORT",
]) {
  delete Bun.env[key];
}

Bun.env.PROXY_AUTH_MODE = "open";
