# Persistence

`src/persistence/` is the single persistence boundary for Postgres and Redis.
Every table, enum, index, and shared column helper that the code reads or
writes lives in `schema.ts` (canonical Drizzle source);
`postgres.ts` owns the bounded `pg` pool, the
single `drizzle()` instance, and the SQL-only migration ledger; `redis.ts`
owns the shared ioredis client. All other modules are table operations or
tenant-scoping helpers — no second connection path exists.

## Layout

```text
src/persistence/
  PERSISTENCE.md          this file
  schema.ts               canonical Drizzle source: every table, enum, index, shared type
  postgres.ts             bounded pg Pool + drizzle singleton + migration ledger runner
  redis.ts                shared ioredis client + atomic Lua eval guard
  readiness.ts            boot probe (DB + migrations + Redis) with 5s memo
  telemetry-store.ts      event writes, durable usage totals, retention/payload ops
  share-store.ts          hash-only enrollment links + atomic child-key issuance
  tenant-scope.ts         globalOrOwnedBy / ownedByOnly / resolveTenantOverride
  tenant-preferences.ts   console_settings reader + TTL cache + revision counter
  page-cursor.ts          base64url cursor encode/decode with bounded LRU memo
  api-key-store.ts        api_keys CRUD + findActiveByHash (auth source of truth)
```

## Schema groups (`schema.ts`)

- **Identity:** `tenants(id, name, status, created_at)` — root of all FKs.
- **Catalog:** `providers(id, tenant_id NULL=global, capability_profile GIN,
  base_url/compatibility_profile BYOK-only, enabled, requires_account)`;
  `models(provider_id, model_id, endpoint_path, wire_family, limits,
  modalities, reasoning/tool_call/web_search, cost, source, enabled)` with
  `models_provider_model_route_uidx`; `tenant_disabled_models` (tenant
  suppression of global/builtin rows; tenant-owned and BYOK rows are toggled
  directly on `models.enabled` instead).
- **Credentials / health:** `provider_accounts` (ciphertext + health machine:
  `status`, `consecutive_failures`, last success/error/cooldown/recovered,
  `model_cooldowns`, `max_inflight`); `provider_oauth_states` 1:0/1 split
  (`refresh_ciphertext`, `expires_at`, `lease_owner`/`lease_expires_at` fenced
  CAS); `network_pools` (kind, endpoint config, ciphertext, `max_inflight`,
  weight, tenant + health machine + latency/health-check columns);
  `health_events` (entity kind + exactly-one-FK CHECK, from/to status, reason,
  error category).
- **Routing:** `model_aliases(tenant, alias, target_model)`;
  `model_combos(tenant, name, members[], strategy)`;
  `provider_routing_settings(provider_id, tenant_id NULL=global, strategy,
  rotate_count, max_inflight, enabled, bypass_proxy)` with dual
  unique indexes (tenant-scoped + partial global);
  `pool_routing_settings(tenant_id PK, strategy, rotate_count)` — the
  pool-group counterpart (absent row reads as `least_loaded`); `telemetry_events`
  carries `error_origin` (cartethyia/upstream/network) beside `error_category`
  because the category alone cannot separate "our bad request" from "upstream
  rejected the request".
- **Inbound keys / sharing:** `api_keys` (personal authentication hashes or
  hashless share templates, child-parent relationship, canonical issued-IP
  identity, encrypted personal-key material, limits and allow/deny lists);
  `share_links` (SHA-256 `token_hash` only, enroll-only kind, active/expiry/
  last-viewed metadata; legacy `used_at` stays stored but is not exposed);
  `console_lockouts` (IP-keyed, survives restart, shared across instances).
- **Ops:** `admin_audit_log` (actor, tenant SET NULL, action, target, detail);
  `console_settings(tenant_id PK, preferences JSONB, updated_at)`;
  `cli_tool_mappings` + `cli_tool_settings`; `telemetry_events`
  (metadata-only by construction — no prompt/body/key columns; catalog FKs
  deliberately omitted so a telemetry write never depends on a provider row);
  `telemetry_usage_totals` (durable per-tenant/account and per-tenant/API-key
  request, error, and token aggregates that survive event retention);
  `telemetry_payloads` (15-minute rows); `studio_sessions` (opaque JSONB).

Enums: `health_status`, `credential_kind`, `wire_family`,
`network_pool_kind`, `health_entity_kind`, `telemetry_source_surface`,
`telemetry_status`, `model_combo_strategy`, `provider_routing_strategy`,
`pool_routing_strategy`.
Shared helpers: `tenantRefNullable/tenantRefRequired/tenantRefPrimaryKey`,
`tenantCascadeSetNull`, `createdAtColumn`/`updatedAtColumn`/
`timestampColumns`, and the `bytea` custom type for envelope-encrypted
ciphertext.

## Connections and migrations

- `postgres.ts`: `requireDatabaseUrl()` (`DATABASE_URL` only, explicit host +
  port, never inferred from Docker/Laragon); `poolMaxFromEnv()`; `getPool()`
  and `getDb()` singletons cached on `globalThis` (idle 60s, connect 5s,
  statement 30s, idle-in-transaction 60s, lock 5s, keepAlive; PgBouncer-safe:
  no session state, no LISTEN/NOTIFY). `DATABASE_POOL_MAX` is a per-process
  *ceiling*, not a reservation — connections open on demand, and the proxy path
  issues few (routing comes from the in-process snapshot, admission counters
  live in Redis; a dispatch attempt still does its own credential read and
  health write, and reads tenant preferences behind a short cache), so the
  pool's largest consumers are the console API, one
  telemetry flush, the worker sweeps, auth, and readiness.
  `assertPoolFitsServerCapacity()` runs at boot: it reads the server's
  `max_connections` and refuses a pool that alone meets it, because the gateway
  is designed to run several processes behind `reusePort` and each opens its own
  pool — nothing in one process can see its siblings. Otherwise it logs how many
  processes fit, which is the arithmetic the operator cannot read off the config
  file. Migration ledger:
  `resolveMigrationsFolder()`, per-file `BEGIN` / SQL / ledger insert /
  `COMMIT` under `pg_advisory_lock`, `readMigrationLedgerStatus()` comparing
  discovered files against ledger rows, `ensureMigrated()` once-flag,
  `closeDb()`; `setPoolForTesting()` mirrors `setRedisForTesting()` for the
  capacity check.
- `redis.ts`: `requireRedisUrl()` (explicit host + port); `getRedis()`
  singleton (`maxRetriesPerRequest: 2`, error logged without crashing);
  `getRedisOrUndefined()` for metrics/readiness paths that must not throw;
  `closeRedis()` (QUIT raced with a bounded timeout, `disconnect()` fallback);
  `redisEvalNumber()` — static-script atomic eval with a finite-number guard
  so a garbled result throws instead of reading as a bogus counter.
- `readiness.ts`: `checkReadiness(db, redis, redisMode, timeoutMs = 5000)`
  memoized for 5s keyed on the full probe identity (db instance, redis
  client, mode, timeout). Order: `SELECT 1` → migration ledger `applied` →
  `redis.ping() === "PONG"` (skipped in `single_instance_local`). Exports
  `RedisMode` + `resolveRedisMode()` which validates `REDIS_MODE`.

## Table stores and helpers

- `telemetry-store.ts`: `DrizzleTelemetryStore(db)` — `insertEvents(rows)`
  writes event batches and upserts account/API-key lifetime totals in one
  transaction; those totals remain after metadata events expire.
  `insertPayload(row)`, `deleteExpiredPayloads()`, and `pruneTelemetry(before)`
  retain the existing payload policy. Metadata retention is configured by
  `CARTETHYIA_TELEMETRY_RETENTION_DAYS` (default 30 days); payload retention is
  15 minutes. `telemetryPayloads` is tenant-gated and off by default
  (`bounded` is an explicit debugging opt-in); rows hold checksummed frame
  references, not bodies (see `observability/OBSERVABILITY.md`).
- `share-store.ts`: `hashShareToken()` (SHA-256); `DrizzleShareLinkStore` —
  creates enroll-only links and resolves only active, unexpired links whose
  parent is an active hashless share template. `issueSharedApiKey()` locks
  parent and link before inserting the policy-inheriting child; the database
  unique-IP violation maps to the one-active-child-per-IP conflict.
- `api-key-store.ts`: list/get/create/update/revoke plus `listChildren()` and
  `findActiveByHash()`. Parent revoke or conversion to personal mode revokes
  children and deactivates links transactionally; hashless templates cannot
  authenticate.
- `tenant-scope.ts`: `globalOrOwnedBy(column, tenantId)` (NULL rows are
  global; a null requester is a platform identity and matches globals only),
  `ownedByOnly()`, and `resolveTenantOverride(tenantRow, globalRow, default)`
  — whole-row tenant-wins precedence, never a per-field merge. Both
  `transport/routing/route-catalog.ts` and the console provider-detail store
  read through it so dispatch and dashboard never disagree.
- `tenant-preferences.ts`: single-row `console_settings` read plus
  `CachedPreferencesReader` over `TtlCache(5s, 128)` keyed
  `tenantId:revision`, with a process revision counter — the hot dispatch
  path reads preferences without importing dashboard code.
- `page-cursor.ts`: `encodeCursor()` base64url JSON; `decodeCursor()` returns
  `undefined` for missing/malformed input, with a bounded 256-entry LRU memo.

## Rules

- `DATABASE_URL` and `REDIS_URL` are the only connection sources; never infer
  a host.
- Schema changes go through `schema.ts` plus the single
  `drizzle/migrations/0000_baseline.sql` consumed by the ledger runner;
  historical baseline entries stay historical. Live databases need the
  hand-run idempotent DDL because the baseline ledger row is
  already applied. Those hand-run statements are kept in
  `drizzle/migrations/manual/` (including `0011_`): `migrationFiles()` only
  matches numbered `NNNN_*.sql` entries at the top level of the migrations
  folder, so the ledger runner never sees that subfolder and each file must be
  applied by hand (its own header says so).
- Manual migration `0011` backfills lifetime usage totals from telemetry rows
  still retained at rollout. Older events already pruned cannot be reconstructed.
- It disables legacy share links and normalizes their kind to `enroll`; the
  old bearer values remain in the database but can no longer be used.
- **The baseline must be self-contained.** It is the entire schema for a
  database created today, so a column that exists only in a `manual/` file
  reaches an already-migrated database and no fresh one — a new deployment then
  starts missing it while every developer machine looks fine. `network_pools.kind`
  and `telemetry_events.error_origin` were absent from a fresh install exactly
  this way. When a manual statement adds a column, the same column belongs in the
  baseline; `test/contracts/migration-integrity.contract.test.ts` asserts the
  baseline carries both, and `test/integration/isolated-db.test.ts` compares a
  freshly migrated database against `schema.ts` column by column.
- Telemetry tables stay metadata-only; bodies are written to the append-only
  `.jsonb` frame files and the `telemetry_payloads` row keeps only a
  checksummed file reference — opt-in, redacted, and TTL-expired.
