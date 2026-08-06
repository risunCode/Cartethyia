import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { ApplicationErrorKind, CredentialKind, RouteHealth, RouteScope, RouteStatus, RoutingPreset } from "../../domain/contracts";
import { sanitizeMessage } from "../../domain/contracts";
import type { RouteHealthStore } from "../../domain/contracts";
import type { ModelLockRecord } from "../../domain/contracts";
import type { AccountConfig, AccountHealthRecord, AccountHealthStore, CredentialConfigStore, ModelLockStore, OAuthTokenRecord, OAuthTokenStore, QuotaStateRecord, QuotaStateStore } from "../../auth/credentials";
import type { ProxyConfig, ProxyPoolConfigStore } from "../../traffic/network";
import type { FilterRuleRepository, IpBanRepository, IpBanView } from "../../console/views";
import type { WarpAccount, WarpAccountCreateData, WarpAccountRepository, WarpAccountUpdateData } from "../../console/warp/types";
import { getPersistenceEnv, type PersistenceEnv } from "./env";
import { applyConfigRestore, exportConfigBackup, type BackupPayload, type RestoreResult, type RestoreValidation } from "./backup";

// Re-export schema + records so existing consumers importing from "./config"
// continue to work unchanged.
export {
  CONFIG_SCHEMA_SQL,
  clearAllDatabaseTables,
  ensureColumn,
  ensureConfigSchema,
  migrateProviderIds,
  nowIso,
  configError,
  toRouteStatus,
  toErrorKind,
  orNullString,
} from "./schema";
export type {
  SettingsRecord,
  RuntimeSettings,
  ApiKeyPublic,
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  ProviderAccountRecord,
  AccountCreateInput,
  AccountPatchInput,
  AccountListPagination,
  AccountListPage,
  ProxyRecord,
  ProxyCreateInput,
  ProxyTestRecordInput,
  ProxyPatchInput,
  ProxySettingsRecord,
  ProviderModelRecord,
  AliasRecord,
  ComboRecord,
  CustomProviderRecord,
  AccessRuleRecord,
  SettingsRepository,
  ApiKeyRepository,
  AccountRepository,
  HealthRepository,
  ProxyRepository,
  ProviderModelRepository,
  AliasRepository,
  ComboRepository,
  CustomProviderRepository,
  AccessRuleRepository,
  ShareLinkRecord,
  ShareLinkRepository,
} from "./records";

// Imports for the implementation below.
import {
  CONFIG_SCHEMA_SQL,
  clearAllDatabaseTables,
  ensureColumn,
  ensureConfigSchema,
  migrateProviderIds,
  nowIso,
  configError,
  toRouteStatus,
  toErrorKind,
  orNullString,
} from "./schema";
import type {
  SettingsRecord,
  RuntimeSettings,
  ApiKeyPublic,
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  ProviderAccountRecord,
  AccountCreateInput,
  AccountPatchInput,
  AccountListPagination,
  AccountListPage,
  ProxyRecord,
  ProxyCreateInput,
  ProxyTestRecordInput,
  ProxyPatchInput,
  ProxySettingsRecord,
  ProviderModelRecord,
  AliasRecord,
  ComboRecord,
  CustomProviderRecord,
  AccessRuleRecord,
  SettingsRepository,
  ApiKeyRepository,
  AccountRepository,
  HealthRepository,
  ProxyRepository,
  ProviderModelRepository,
  AliasRepository,
  ComboRepository,
  CustomProviderRepository,
  AccessRuleRepository,
  ShareLinkRecord,
  ShareLinkRepository,
} from "./records";

// ───────────────────────── SQL row shapes (legacy) ──────────────────────────

interface SettingsRow {
  password_hash: string | null;
  password_version: number;
  jwt_secret: string | null;
  settings_json: string;
  initialized_at: string;
  updated_at: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key: string;
  key_prefix: string;
  active: number;
  rate_limit_rpm: number | null;
  daily_token_limit: number | null;
  monthly_token_limit: number | null;
  one_time_token_limit: number | null;
  one_time_tokens_used: number;
  quote_big_text: string | null;
  quote_sub_text: string | null;
  quote_body: string | null;
  max_concurrent_requests: number | null;
  provider_allowlist: string | null;
  model_allowlist: string | null;
  model_denylist: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface ProviderAccountRow {
  id: string;
  provider: string;
  name: string;
  credential_kind: string;
  credential: string;
  credential_hint: string;
  priority: number;
  active: number;
  cooldown_until: string | null;
  cooldown_level: number;
  consecutive_use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProxyRow {
  id: string;
  name: string;
  protocol: string;
  is_relay: number;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  max_concurrency: number;
  priority: number;
  weight: number;
  active: number;
  cooldown_until: string | null;
  cooldown_level: number;
  consecutive_use_count: number;
  last_used_at: string | null;
  last_test_at: string | null;
  last_test_success_at: string | null;
  last_test_success_latency_ms: number | null;
  last_test_error_at: string | null;
  last_test_error: string | null;
  last_test_status_code: number | null;
  created_at: string;
  updated_at: string;
}

interface ProxySettingsRow {
  enabled: number;
  excluded_providers_json: string;
  smart_dynamic_routing: number;
  smart_dynamic_proxy_count: number;
  routing_preset: string;
  target_concurrent: number;
  updated_at: string;
}

interface ProviderModelRow {
  provider: string;
  model_id: string;
  enabled: number;
  source: string;
  created_at: string;
  updated_at: string;
}

interface AliasRow {
  alias: string;
  model: string;
  created_at: string;
}

interface ComboRow {
  id: string;
  name: string;
  models_json: string;
  strategy: string;
  sticky_limit: number;
  created_at: string;
  updated_at: string;
}

interface CustomProviderRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  base_url: string;
  credential: string;
  timeout_seconds: number;
  models_json: string;
  headers_json: string;
  created_at: string;
  updated_at: string;
}

interface AccessRuleRow {
  scope: string;
  mode: string;
  entries_json: string;
  updated_at: string;
}

interface ShareLinkRow {
  id: string;
  api_key_id: string;
  token_hash: string;
  active: number;
  created_at: string;
  last_viewed_at: string | null;
}

interface AccountHealthRow {
  status: string | null;
  error_kind: string | null;
  status_code: number | null;
  sanitized_message: string | null;
  occurred_at: string | null;
  retry_at: string | null;
  updated_at: string | null;
}

// ────────────────────────────── Mappers ─────────────────────────────────────

const LEGACY_CREDENTIAL_KINDS: Readonly<Record<string, CredentialKind>> = {
  bearer: "api_key",
  pat: "api_key",
  "session-token": "api_key",
  oauth: "oauth",
  api_key: "api_key",
  manual: "manual",
};

export function credentialKindOf(value: string | null | undefined): CredentialKind {
  const mapped = value === null || value === undefined ? undefined : LEGACY_CREDENTIAL_KINDS[value];
  return mapped ?? "manual";
}

function toApiKeyPublic(row: ApiKeyRow): ApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    active: row.active === 1,
    rateLimitRpm: row.rate_limit_rpm,
    dailyTokenLimit: row.daily_token_limit,
    monthlyTokenLimit: row.monthly_token_limit,
    oneTimeTokenLimit: row.one_time_token_limit,
    oneTimeTokensUsed: row.one_time_tokens_used,
    maxConcurrentRequests: row.max_concurrent_requests,
    providerAllowlist: row.provider_allowlist,
    modelAllowlist: row.model_allowlist,
    modelDenylist: row.model_denylist,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function toProviderAccount(row: ProviderAccountRow): ProviderAccountRecord {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    credentialKind: credentialKindOf(row.credential_kind),
    credentialHint: row.credential_hint,
    priority: row.priority,
    active: row.active === 1,
    cooldownUntil: row.cooldown_until,
    cooldownLevel: row.cooldown_level,
    consecutiveUseCount: row.consecutive_use_count ?? 0,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProxy(row: ProxyRow): ProxyRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol === "https" || row.protocol === "socks5" ? row.protocol : "http",
    isRelay: row.is_relay === 1,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password,
    maxConcurrency: Math.max(1, Math.min(10_000, Math.round(row.max_concurrency || 8))),
    priority: row.priority,
    weight: Math.max(1, Math.min(1_000, Math.round(row.weight || 100))),
    active: row.active === 1,
    cooldownUntil: row.cooldown_until,
    cooldownLevel: row.cooldown_level,
    consecutiveUseCount: row.consecutive_use_count ?? 0,
    lastUsedAt: row.last_used_at,
    lastTestAt: row.last_test_at,
    lastTestSuccessAt: row.last_test_success_at,
    lastTestSuccessLatencyMs: row.last_test_success_latency_ms,
    lastTestErrorAt: row.last_test_error_at,
    lastTestError: row.last_test_error,
    lastTestStatusCode: row.last_test_status_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSettings(row: SettingsRow): SettingsRecord {
  let settingsJson: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.settings_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settingsJson = parsed as Record<string, unknown>;
  } catch {
    // malformed legacy JSON — treat as empty, never crash
  }
  return {
    passwordHash: row.password_hash,
    passwordVersion: row.password_version,
    jwtSecret: row.jwt_secret,
    settingsJson,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────── Repository builders ────────────────────────────

function createSettingsRepository(db: () => Database, env: PersistenceEnv): SettingsRepository {
  const getRow = (): SettingsRow | null => db().query("SELECT * FROM settings WHERE id = 1").get() as SettingsRow | null;
  // Cache the parsed settings JSON — invalidated on any mutation. This avoids
  // a SQLite read + JSON.parse on every hot-path call (tokenSaver, provider
  // routing, privacy mode) when settings haven't changed.
  let cachedJson: Record<string, unknown> | null = null;

  return {
    ensure(): SettingsRecord {
      const existing = getRow();
      if (existing) { cachedJson = null; return toSettings(existing); }
      const now = nowIso();
      db().query("INSERT INTO settings (id, password_hash, password_version, jwt_secret, settings_json, initialized_at, updated_at) VALUES (1, NULL, 1, NULL, '{}', ?, ?)").run(now, now);
      cachedJson = null;
      return toSettings(db().query("SELECT * FROM settings WHERE id = 1").get() as SettingsRow);
    },
    get(): SettingsRecord | null {
      const row = getRow();
      return row ? toSettings(row) : null;
    },
    getSettingsJson(): Record<string, unknown> {
      if (cachedJson !== null) return cachedJson;
      const json = this.get()?.settingsJson ?? {};
      cachedJson = json;
      return json;
    },
    patchSettingsJson(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
      const row = getRow();
      if (!row) throw configError("settings not initialized");
      // Use the cached parsed JSON (getSettingsJson) instead of re-parsing
      // the row via toSettings(row) — the cache is invalidated on every
      // mutation, so it's always current at this point.
      const current = this.getSettingsJson();
      const next: Record<string, unknown> = { ...current, ...patch };
      db().query("UPDATE settings SET settings_json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(next), nowIso());
      cachedJson = next;
      return next;
    },
    getRuntimeSettings(): RuntimeSettings {
      const json = this.getSettingsJson();
      const runtime = json.runtime;
      const patch = typeof runtime === "object" && runtime !== null && !Array.isArray(runtime) ? (runtime as Record<string, unknown>) : {};
      const logRetentionDays = typeof patch.logRetentionDays === "number" && Number.isFinite(patch.logRetentionDays) ? Math.min(Math.max(Math.floor(patch.logRetentionDays), 1), 365) : env.logRetentionDays;
      const assetRetentionDays = typeof patch.assetRetentionDays === "number" && Number.isFinite(patch.assetRetentionDays) ? Math.min(Math.max(Math.floor(patch.assetRetentionDays), 1), 365) : env.assetRetentionDays;
      return { logRetentionDays, assetRetentionDays };
    },
    patchRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
      const json = this.getSettingsJson();
      const runtime = json.runtime;
      const current = typeof runtime === "object" && runtime !== null && !Array.isArray(runtime) ? (runtime as Record<string, unknown>) : {};
      const next: Record<string, unknown> = { ...current };
      if (patch.logRetentionDays !== undefined) next.logRetentionDays = Math.min(Math.max(Math.floor(patch.logRetentionDays), 1), 365);
      if (patch.assetRetentionDays !== undefined) next.assetRetentionDays = Math.min(Math.max(Math.floor(patch.assetRetentionDays), 1), 365);
      this.patchSettingsJson({ runtime: next });
      return { logRetentionDays: Number(next.logRetentionDays) || env.logRetentionDays, assetRetentionDays: Number(next.assetRetentionDays) || env.assetRetentionDays };
    },
    setPasswordHash(hash: string): void {
      db().query("UPDATE settings SET password_hash = ?, password_version = password_version + 1, updated_at = ? WHERE id = 1").run(hash, nowIso());
    },
    bumpPasswordVersion(): void {
      db().query("UPDATE settings SET password_version = password_version + 1, updated_at = ? WHERE id = 1").run(nowIso());
    },
    rotateJwtSecret(secret: string): void {
      db().query("UPDATE settings SET jwt_secret = ?, password_version = password_version + 1, updated_at = ? WHERE id = 1").run(secret, nowIso());
    },
  };
}

const SECRET_CACHE_TTL_MS = 5_000;
const SECRET_CACHE_MAX = 512;

function createApiKeyRepository(db: () => Database): ApiKeyRepository {
  const secretCache = new Map<string, { at: number; value: ApiKeyPublic }>();
  const pendingTouches = new Set<string>();
  let touchTimer: Timer | null = null;

  const getSecretCached = (key: string): ApiKeyPublic | null => {
    const hit = secretCache.get(key);
    if (hit && Date.now() - hit.at < SECRET_CACHE_TTL_MS) return hit.value;
    secretCache.delete(key);
    // Fetch candidates by prefix wildcard to narrow the candidate set, then
    // verify the full secret with a timing-safe comparison so SQLite's
    // index lookup cannot leak prefix validity through response timing.
    const prefix = key.slice(0, Math.min(8, key.length));
    const candidates = db().query("SELECT * FROM api_keys WHERE key LIKE ?").all(`${prefix}%`) as ApiKeyRow[];
    let match: ApiKeyRow | null = null;
    for (const candidate of candidates) {
      if (candidate.key.length === key.length) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(candidate.key), Buffer.from(key))) {
            match = candidate;
            break;
          }
        } catch { /* length mismatch — skip */ }
      }
    }
    if (!match) return null;
    const value = toApiKeyPublic(match);
    if (secretCache.size >= SECRET_CACHE_MAX) secretCache.clear();
    secretCache.set(key, { at: Date.now(), value });
    return value;
  };

  const flushTouches = (): void => {
    if (touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
    if (pendingTouches.size === 0) return;
    const ids = [...pendingTouches];
    pendingTouches.clear();
    const now = nowIso();
    const apply = db().transaction((rows: string[]) => {
      for (const id of rows) db().query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, id);
    });
    apply(ids);
  };

  return {
    list(): ApiKeyPublic[] {
      return (db().query("SELECT * FROM api_keys ORDER BY created_at DESC").all() as ApiKeyRow[]).map(toApiKeyPublic);
    },
    getById(id: string): ApiKeyPublic | null {
      const row = db().query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
      return row ? toApiKeyPublic(row) : null;
    },
    getBySecret(key: string): ApiKeyPublic | null {
      return getSecretCached(key);
    },
    credential(id: string): string | null {
      const row = db().query("SELECT key FROM api_keys WHERE id = ?").get(id) as { key: string } | null;
      return row?.key ?? null;
    },
    create(input: ApiKeyCreateInput): ApiKeyPublic {
      const now = nowIso();
      db().query(
        "INSERT INTO api_keys (id, name, key, key_prefix, active, rate_limit_rpm, daily_token_limit, monthly_token_limit, one_time_token_limit, max_concurrent_requests, provider_allowlist, model_allowlist, model_denylist, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.name, input.key, input.keyPrefix, input.rateLimitRpm ?? null, input.dailyTokenLimit ?? null, input.monthlyTokenLimit ?? null, input.oneTimeTokenLimit ?? null, input.maxConcurrentRequests ?? null, input.providerAllowlist ?? null, input.modelAllowlist ?? null, input.modelDenylist ?? null, now);
      const row = db().query("SELECT * FROM api_keys WHERE id = ?").get(input.id) as ApiKeyRow;
      return toApiKeyPublic(row);
    },
    update(id: string, patch: ApiKeyUpdateInput): ApiKeyPublic | null {
      const existing = db().query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
      if (!existing) return null;
      const fields: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.key !== undefined) {
        fields.push("key = ?", "key_prefix = ?", "active = ?", "revoked_at = ?");
        values.push(patch.key, patch.key.slice(0, Math.min(12, patch.key.length)), 1, null);
      }
      if (patch.rateLimitRpm !== undefined) {
        fields.push("rate_limit_rpm = ?");
        values.push(patch.rateLimitRpm);
      }
      if (patch.dailyTokenLimit !== undefined) {
        fields.push("daily_token_limit = ?");
        values.push(patch.dailyTokenLimit);
      }
      if (patch.monthlyTokenLimit !== undefined) {
        fields.push("monthly_token_limit = ?");
        values.push(patch.monthlyTokenLimit);
      }
      if (patch.oneTimeTokenLimit !== undefined) {
        fields.push("one_time_token_limit = ?");
        values.push(patch.oneTimeTokenLimit);
      }
      if (patch.maxConcurrentRequests !== undefined) {
        fields.push("max_concurrent_requests = ?");
        values.push(patch.maxConcurrentRequests);
      }
      if (patch.providerAllowlist !== undefined) {
        fields.push("provider_allowlist = ?");
        values.push(patch.providerAllowlist);
      }
      if (patch.modelAllowlist !== undefined) {
        fields.push("model_allowlist = ?");
        values.push(patch.modelAllowlist);
      }
      if (patch.modelDenylist !== undefined) {
        fields.push("model_denylist = ?");
        values.push(patch.modelDenylist);
      }
      if (patch.active !== undefined) {
        fields.push("active = ?");
        values.push(patch.active ? 1 : 0);
      }
      if (fields.length === 0) return toApiKeyPublic(existing);
      db().query(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
      const row = db().query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
      return row ? toApiKeyPublic(row) : null;
    },
    revoke(id: string): boolean {
      const result = db().query("UPDATE api_keys SET active = 0, revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
      return result.changes > 0;
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM api_keys WHERE id = ?").run(id);
      return result.changes > 0;
    },
    touch(id: string): void {
      pendingTouches.add(id);
      if (pendingTouches.size >= 200) {
        flushTouches();
        return;
      }
      if (!touchTimer) {
        touchTimer = setTimeout(flushTouches, 30_000);
        touchTimer.unref?.();
      }
    },
    flushTouches,
    sumOneTimeTokensUsed(id: string): number {
      const row = db().query("SELECT one_time_tokens_used FROM api_keys WHERE id = ?").get(id) as { one_time_tokens_used: number } | null;
      return row?.one_time_tokens_used ?? 0;
    },
    consumeOneTimeTokens(id: string, tokens: number): void {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      db().query("UPDATE api_keys SET one_time_tokens_used = MIN(one_time_token_limit, one_time_tokens_used + ?) WHERE id = ? AND one_time_token_limit IS NOT NULL").run(Math.floor(tokens), id);
    },
  };
}

function createAccountRepository(db: () => Database): AccountRepository {
  return {
    list(provider?: string): ProviderAccountRecord[] {
      const rows = provider
        ? (db().query("SELECT * FROM provider_accounts WHERE provider = ? ORDER BY priority ASC, name ASC").all(provider) as ProviderAccountRow[])
        : (db().query("SELECT * FROM provider_accounts ORDER BY provider ASC, priority ASC, name ASC").all() as ProviderAccountRow[]);
      return rows.map(toProviderAccount);
    },
    listPaged(provider: string, pagination: AccountListPagination): AccountListPage {
      const limit = Math.max(1, Math.min(500, Math.floor(pagination.limit ?? 50)));
      const cursor = pagination.cursor;
      // Keyset pagination on the primary key id — backed by
      // idx_provider_accounts_provider_id(provider, id). The first page
      // skips the id predicate; subsequent pages resume after the cursor.
      const rows = cursor
        ? (db().query("SELECT * FROM provider_accounts WHERE provider = ? AND id > ? ORDER BY id ASC LIMIT ?").all(provider, cursor, limit) as ProviderAccountRow[])
        : (db().query("SELECT * FROM provider_accounts WHERE provider = ? ORDER BY id ASC LIMIT ?").all(provider, limit) as ProviderAccountRow[]);
      const items = rows.map(toProviderAccount);
      const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
      return { items, nextCursor };
    },
    get(id: string): ProviderAccountRecord | null {
      const row = db().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
      return row ? toProviderAccount(row) : null;
    },
    create(input: AccountCreateInput): ProviderAccountRecord {
      const now = nowIso();
      const priority = input.priority === undefined ? 100 : input.priority;
      const active = input.active === undefined ? true : input.active;
      db().query(
        "INSERT INTO provider_accounts (id, provider, name, credential_kind, credential, credential_hint, priority, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.provider, input.name, input.credentialKind, input.credential, input.credentialHint, priority, active ? 1 : 0, now, now);
      return toProviderAccount(db().query("SELECT * FROM provider_accounts WHERE id = ?").get(input.id) as ProviderAccountRow);
    },
    patch(id: string, patch: AccountPatchInput): ProviderAccountRecord | null {
      const existing = db().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
      if (!existing) return null;
      const fields: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.credentialKind !== undefined) {
        fields.push("credential_kind = ?");
        values.push(patch.credentialKind);
      }
      if (patch.credential !== undefined) {
        fields.push("credential = ?");
        values.push(patch.credential);
      }
      if (patch.credentialHint !== undefined) {
        fields.push("credential_hint = ?");
        values.push(patch.credentialHint);
      }
      if (patch.priority !== undefined) {
        fields.push("priority = ?");
        values.push(patch.priority);
      }
      if (patch.active !== undefined) {
        fields.push("active = ?");
        values.push(patch.active ? 1 : 0);
      }
      if (patch.cooldownUntil !== undefined) {
        fields.push("cooldown_until = ?");
        values.push(patch.cooldownUntil);
      }
      if (patch.cooldownLevel !== undefined) {
        fields.push("cooldown_level = ?");
        values.push(patch.cooldownLevel);
      }
      if (patch.consecutiveUseCount !== undefined) {
        fields.push("consecutive_use_count = ?");
        values.push(patch.consecutiveUseCount);
      }
      if (patch.lastUsedAt !== undefined) {
        fields.push("last_used_at = ?");
        values.push(patch.lastUsedAt);
      }
      if (fields.length === 0) return toProviderAccount(existing);
      db().query(`UPDATE provider_accounts SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
      const row = db().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
      return row ? toProviderAccount(row) : null;
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM provider_accounts WHERE id = ?").run(id);
      return result.changes > 0;
    },
    deleteBatch(ids: readonly string[]): number {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      const result = db().query(`DELETE FROM provider_accounts WHERE id IN (${placeholders})`).run(...ids);
      return result.changes;
    },
    setActiveBatch(ids: readonly string[], active: boolean): number {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      const result = db().query(`UPDATE provider_accounts SET active = ?, updated_at = ? WHERE id IN (${placeholders})`).run(active ? 1 : 0, nowIso(), ...ids);
      return result.changes;
    },
    listActiveCredentials(provider: string): string[] {
      const rows = db().query("SELECT credential FROM provider_accounts WHERE provider = ? AND active = 1 ORDER BY priority ASC, name ASC").all(provider) as Array<{ credential: string }>;
      return rows.map((row) => row.credential).filter((value) => value.length > 0);
    },
  };
}

/** Hardcoded allowlist of health tables and key columns — defense against interpolation. */
const HEALTH_TABLES = new Set(["provider_account_health", "proxy_health"]);
const HEALTH_KEY_COLUMNS = new Set(["account_id", "proxy_id"]);

function createHealthRepository(db: () => Database, table: string, keyColumn: string, scope: RouteScope): HealthRepository {
  if (!HEALTH_TABLES.has(table) || !HEALTH_KEY_COLUMNS.has(keyColumn)) {
    throw new Error(`Refusing to query unknown health table: ${table}`);
  }
  const toHealth = (row: AccountHealthRow): RouteHealth => ({
    scope,
    status: toRouteStatus(row.status),
    statusCode: row.status_code,
    failureKind: toErrorKind(row.error_kind),
    sanitizedMessage: orNullString(row.sanitized_message),
    occurredAt: row.occurred_at,
    retryAt: row.retry_at,
  });
  return {
    async get(routeId: string): Promise<RouteHealth | null> {
      const row = db().query(`SELECT status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at FROM ${table} WHERE ${keyColumn} = ?`).get(routeId) as AccountHealthRow | null;
      return row ? toHealth(row) : null;
    },
    async list(): Promise<RouteHealth[]> {
      const rows = db().query(`SELECT status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at FROM ${table}`).all() as AccountHealthRow[];
      return rows.map(toHealth);
    },
    async upsert(routeId: string, health: RouteHealth): Promise<void> {
      // Route health is observability: never fail the caller when the
      // configured account/proxy row is absent (legacy behavior guard).
      const parentTable = scope === "proxy" ? "proxies" : "provider_accounts";
      const parentKey = scope === "proxy" ? "id" : "id";
      if (db().query(`SELECT 1 FROM ${parentTable} WHERE ${parentKey} = ?`).get(routeId) === null) return;
      db().query(
        `INSERT INTO ${table} (${keyColumn}, status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(${keyColumn}) DO UPDATE SET status = excluded.status, error_kind = excluded.error_kind, status_code = excluded.status_code, sanitized_message = excluded.sanitized_message, occurred_at = excluded.occurred_at, retry_at = excluded.retry_at, updated_at = excluded.updated_at`,
      ).run(routeId, health.status, health.failureKind, health.statusCode, health.sanitizedMessage, health.occurredAt, health.retryAt, nowIso());
    },
    async clear(routeId: string): Promise<void> {
      db().query(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(routeId);
    },
  };
}

function createProxyRepository(db: () => Database): ProxyRepository {
  const getSettingsRow = (): ProxySettingsRow | null => db().query("SELECT * FROM proxy_settings WHERE id = 1").get() as ProxySettingsRow | null;

  const toSettings = (row: ProxySettingsRow): ProxySettingsRecord => {
    let excludedProviders: readonly string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.excluded_providers_json);
      if (Array.isArray(parsed)) excludedProviders = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      // malformed legacy JSON — empty list
    }
    return {
      enabled: row.enabled === 1,
      excludedProviders,
      smartDynamicRouting: row.smart_dynamic_routing === 1,
      smartDynamicProxyCount: Math.max(1, Math.min(32, Math.round(row.smart_dynamic_proxy_count || 2))),
      routingPreset: row.routing_preset === "target-user" || row.routing_preset === "target-concurrent" ? row.routing_preset : "auto",
      targetConcurrent: Math.max(0, Math.min(10_000, Math.round(row.target_concurrent || 0))),
      updatedAt: row.updated_at,
    };
  };

  return {
    list(): ProxyRecord[] {
      return (db().query("SELECT * FROM proxies ORDER BY priority ASC, name ASC").all() as ProxyRow[]).map(toProxy);
    },
    get(id: string): ProxyRecord | null {
      const row = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      return row ? toProxy(row) : null;
    },
    create(input: ProxyCreateInput): ProxyRecord {
      const now = nowIso();
      db().query(
        "INSERT INTO proxies (id, name, protocol, is_relay, host, port, username, password, max_concurrency, priority, weight, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.name, input.protocol, input.isRelay ? 1 : 0, input.host, input.port, input.username ?? null, input.password ?? null, input.maxConcurrency ?? 8, input.priority ?? 100, Math.max(1, Math.min(1_000, Math.round(input.weight ?? 100))), input.active === false ? 0 : 1, now, now);
      return toProxy(db().query("SELECT * FROM proxies WHERE id = ?").get(input.id) as ProxyRow);
    },
    patch(id: string, patch: ProxyPatchInput): ProxyRecord | null {
      const existing = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      if (!existing) return null;
      const fields: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.protocol !== undefined) {
        fields.push("protocol = ?");
        values.push(patch.protocol);
      }
      if (patch.host !== undefined) {
        fields.push("host = ?");
        values.push(patch.host);
      }
      if (patch.port !== undefined) {
        fields.push("port = ?");
        values.push(patch.port);
      }
      if (patch.username !== undefined) {
        fields.push("username = ?");
        values.push(patch.username);
      }
      if (patch.password !== undefined) {
        fields.push("password = ?");
        values.push(patch.password);
      }
      if (patch.isRelay !== undefined) {
        fields.push("is_relay = ?");
        values.push(patch.isRelay ? 1 : 0);
      }
      if (patch.maxConcurrency !== undefined) {
        fields.push("max_concurrency = ?");
        values.push(Math.max(1, Math.min(10_000, Math.round(patch.maxConcurrency))));
      }
      if (patch.priority !== undefined) {
        fields.push("priority = ?");
        values.push(patch.priority);
      }
      if (patch.weight !== undefined) {
        fields.push("weight = ?");
        values.push(Math.max(1, Math.min(1_000, Math.round(patch.weight))));
      }
      if (patch.active !== undefined) {
        fields.push("active = ?");
        values.push(patch.active ? 1 : 0);
      }
      if (patch.cooldownUntil !== undefined) {
        fields.push("cooldown_until = ?");
        values.push(patch.cooldownUntil);
      }
      if (patch.cooldownLevel !== undefined) {
        fields.push("cooldown_level = ?");
        values.push(patch.cooldownLevel);
      }
      if (patch.consecutiveUseCount !== undefined) {
        fields.push("consecutive_use_count = ?");
        values.push(patch.consecutiveUseCount);
      }
      if (patch.lastUsedAt !== undefined) {
        fields.push("last_used_at = ?");
        values.push(patch.lastUsedAt);
      }
      if (fields.length === 0) return toProxy(existing);
      db().query(`UPDATE proxies SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
      const row = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      return row ? toProxy(row) : null;
    },
    recordTest(id: string, result: ProxyTestRecordInput): ProxyRecord | null {
      const existing = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      if (!existing) return null;
      if (result.ok) {
        db().query("UPDATE proxies SET last_test_at = ?, last_test_success_at = ?, last_test_success_latency_ms = ?, last_test_status_code = ?, updated_at = ? WHERE id = ?").run(result.testedAt, result.testedAt, result.latencyMs, result.statusCode, nowIso(), id);
      } else {
        db().query("UPDATE proxies SET last_test_at = ?, last_test_error_at = ?, last_test_error = ?, last_test_status_code = ?, updated_at = ? WHERE id = ?").run(result.testedAt, result.testedAt, result.error?.slice(0, 500) ?? "Connection failed", result.statusCode, nowIso(), id);
      }
      return toProxy(db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow);
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM proxies WHERE id = ?").run(id);
      return result.changes > 0;
    },
    getSettings(): ProxySettingsRecord | null {
      const row = getSettingsRow();
      return row ? toSettings(row) : null;
    },
    patchSettings(patch: Partial<Omit<ProxySettingsRecord, "updatedAt">>): ProxySettingsRecord {
      const existing = getSettingsRow();
      const now = nowIso();
      if (!existing) {
        db().query("INSERT INTO proxy_settings (id, enabled, excluded_providers_json, smart_dynamic_routing, smart_dynamic_proxy_count, routing_preset, target_concurrent, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)").run(
          patch.enabled === undefined ? 0 : patch.enabled ? 1 : 0,
          JSON.stringify(patch.excludedProviders ?? []),
          patch.smartDynamicRouting === undefined ? 0 : patch.smartDynamicRouting ? 1 : 0,
          Math.max(1, Math.min(32, Math.round(patch.smartDynamicProxyCount ?? 2))),
          patch.routingPreset === "target-user" || patch.routingPreset === "target-concurrent" ? patch.routingPreset : "auto",
          Math.max(0, Math.min(10_000, Math.round(patch.targetConcurrent ?? 0))),
          now,
        );
      } else {
        const fields: string[] = [];
        const values: Array<string | number> = [];
        if (patch.enabled !== undefined) {
          fields.push("enabled = ?");
          values.push(patch.enabled ? 1 : 0);
        }
        if (patch.excludedProviders !== undefined) {
          fields.push("excluded_providers_json = ?");
          values.push(JSON.stringify(patch.excludedProviders));
        }
        if (patch.smartDynamicRouting !== undefined) {
          fields.push("smart_dynamic_routing = ?");
          values.push(patch.smartDynamicRouting ? 1 : 0);
        }
        if (patch.smartDynamicProxyCount !== undefined) {
          fields.push("smart_dynamic_proxy_count = ?");
          values.push(Math.max(1, Math.min(32, Math.round(patch.smartDynamicProxyCount))));
        }
        if (patch.routingPreset !== undefined) {
          fields.push("routing_preset = ?");
          values.push(patch.routingPreset === "target-user" || patch.routingPreset === "target-concurrent" ? patch.routingPreset : "auto");
        }
        if (patch.targetConcurrent !== undefined) {
          fields.push("target_concurrent = ?");
          values.push(Math.max(0, Math.min(10_000, Math.round(patch.targetConcurrent))));
        }
        fields.push("updated_at = ?");
        values.push(now);
        db().query(`UPDATE proxy_settings SET ${fields.join(", ")} WHERE id = 1`).run(...values);
      }
      return toSettings(getSettingsRow() as ProxySettingsRow);
    },
  };
}

function createProviderModelRepository(db: () => Database): ProviderModelRepository {
  const toRecord = (row: ProviderModelRow): ProviderModelRecord => ({
    provider: row.provider,
    modelId: row.model_id,
    enabled: row.enabled === 1,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return {
    list(provider: string): ProviderModelRecord[] {
      return (db().query("SELECT * FROM provider_models WHERE provider = ? ORDER BY model_id ASC").all(provider) as ProviderModelRow[]).map(toRecord);
    },
    get(provider: string, modelId: string): ProviderModelRecord | null {
      // Try exact match first, then a prefix-qualified match so lookups work
      // whether the caller passes the bare ID or the legacy qualified ID.
      const direct = db().query("SELECT * FROM provider_models WHERE provider = ? AND model_id = ?").get(provider, modelId) as ProviderModelRow | null;
      if (direct) return toRecord(direct);
      const qualified = db().query("SELECT * FROM provider_models WHERE provider = ? AND model_id = ?").get(provider, `${provider}/${modelId}`) as ProviderModelRow | null;
      return qualified ? toRecord(qualified) : null;
    },
    upsert(provider: string, modelId: string, input: { enabled?: boolean; source?: string }): ProviderModelRecord {
      const now = nowIso();
      db().query(
        "INSERT INTO provider_models (provider, model_id, enabled, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model_id) DO UPDATE SET enabled = excluded.enabled, source = excluded.source, updated_at = excluded.updated_at",
      ).run(provider, modelId, input.enabled === false ? 0 : 1, input.source ?? "manual", now, now);
      return toRecord(db().query("SELECT * FROM provider_models WHERE provider = ? AND model_id = ?").get(provider, modelId) as ProviderModelRow);
    },
    delete(provider: string, modelId: string): boolean {
      // Also handle legacy qualified IDs on delete.
      const result = db().query("DELETE FROM provider_models WHERE provider = ? AND model_id = ?").run(provider, modelId);
      if (result.changes > 0) return true;
      const qualified = db().query("DELETE FROM provider_models WHERE provider = ? AND model_id = ?").run(provider, `${provider}/${modelId}`);
      return qualified.changes > 0;
    },
  };
}

function createAliasRepository(db: () => Database): AliasRepository {
  const toRecord = (row: AliasRow): AliasRecord => ({ alias: row.alias, model: row.model, createdAt: row.created_at });
  return {
    list(): AliasRecord[] {
      return (db().query("SELECT * FROM model_aliases ORDER BY alias ASC").all() as AliasRow[]).map(toRecord);
    },
    get(alias: string): AliasRecord | null {
      const row = db().query("SELECT * FROM model_aliases WHERE alias = ?").get(alias) as AliasRow | null;
      return row ? toRecord(row) : null;
    },
    upsert(alias: string, model: string): AliasRecord {
      const now = nowIso();
      db().query("INSERT INTO model_aliases (alias, model, created_at) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET model = excluded.model").run(alias, model, now);
      return toRecord(db().query("SELECT * FROM model_aliases WHERE alias = ?").get(alias) as AliasRow);
    },
    delete(alias: string): boolean {
      const result = db().query("DELETE FROM model_aliases WHERE alias = ?").run(alias);
      return result.changes > 0;
    },
  };
}

function createComboRepository(db: () => Database): ComboRepository {
  const toRecord = (row: ComboRow): ComboRecord => {
    let models: readonly string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.models_json);
      if (Array.isArray(parsed)) models = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      // malformed legacy JSON — empty list
    }
    return { id: row.id, name: row.name, models, strategy: row.strategy, stickyLimit: row.sticky_limit, createdAt: row.created_at, updatedAt: row.updated_at };
  };
  return {
    list(): ComboRecord[] {
      return (db().query("SELECT * FROM combos ORDER BY name ASC").all() as ComboRow[]).map(toRecord);
    },
    get(id: string): ComboRecord | null {
      const row = db().query("SELECT * FROM combos WHERE id = ?").get(id) as ComboRow | null;
      return row ? toRecord(row) : null;
    },
    upsert(input: { id: string; name: string; models: readonly string[]; strategy?: string; stickyLimit?: number }): ComboRecord {
      const now = nowIso();
      db().query(
        "INSERT INTO combos (id, name, models_json, strategy, sticky_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, models_json = excluded.models_json, strategy = excluded.strategy, sticky_limit = excluded.sticky_limit, updated_at = excluded.updated_at",
      ).run(input.id, input.name, JSON.stringify(input.models), input.strategy ?? "fallback", input.stickyLimit ?? 0, now, now);
      return toRecord(db().query("SELECT * FROM combos WHERE id = ?").get(input.id) as ComboRow);
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM combos WHERE id = ?").run(id);
      return result.changes > 0;
    },
  };
}

function createCustomProviderRepository(db: () => Database): CustomProviderRepository {
  const toRecord = (row: CustomProviderRow): CustomProviderRecord => {
    let models: readonly unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(row.models_json);
      if (Array.isArray(parsed)) models = parsed;
    } catch {
      // malformed legacy JSON — empty list
    }
    let customHeaders: Readonly<Record<string, string>> = {};
    try {
      const parsed: unknown = JSON.parse(row.headers_json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        customHeaders = parsed as Record<string, string>;
      }
    } catch {
      // malformed legacy JSON — empty object
    }
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type === "anthropic-compatible" ? "anthropic-compatible" : "openai-compatible",
      baseUrl: row.base_url,
      credential: row.credential,
      timeoutSeconds: row.timeout_seconds,
      models,
      customHeaders,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  return {
    list(): CustomProviderRecord[] {
      return (db().query("SELECT * FROM custom_providers ORDER BY name ASC").all() as CustomProviderRow[]).map(toRecord);
    },
    get(id: string): CustomProviderRecord | null {
      const row = db().query("SELECT * FROM custom_providers WHERE id = ?").get(id) as CustomProviderRow | null;
      return row ? toRecord(row) : null;
    },
    getBySlug(slug: string): CustomProviderRecord | null {
      const row = db().query("SELECT * FROM custom_providers WHERE slug = ?").get(slug) as CustomProviderRow | null;
      return row ? toRecord(row) : null;
    },
    upsert(input: {
      id: string;
      slug: string;
      name: string;
      type: "openai-compatible" | "anthropic-compatible";
      baseUrl: string;
      credential: string;
      timeoutSeconds?: number;
      models?: readonly unknown[];
      customHeaders?: Readonly<Record<string, string>>;
    }): CustomProviderRecord {
      const now = nowIso();
      db().query(
        "INSERT INTO custom_providers (id, slug, name, type, base_url, credential, timeout_seconds, models_json, headers_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, type = excluded.type, base_url = excluded.base_url, credential = excluded.credential, timeout_seconds = excluded.timeout_seconds, models_json = excluded.models_json, headers_json = excluded.headers_json, updated_at = excluded.updated_at",
      ).run(input.id, input.slug, input.name, input.type, input.baseUrl, input.credential, input.timeoutSeconds ?? 30, JSON.stringify(input.models ?? []), JSON.stringify(input.customHeaders ?? {}), now, now);
      return toRecord(db().query("SELECT * FROM custom_providers WHERE id = ?").get(input.id) as CustomProviderRow);
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM custom_providers WHERE id = ?").run(id);
      return result.changes > 0;
    },
    updateModels(id: string, models: readonly unknown[]): CustomProviderRecord | null {
      const now = nowIso();
      const result = db().query("UPDATE custom_providers SET models_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(models), now, id);
      if (result.changes === 0) return null;
      return toRecord(db().query("SELECT * FROM custom_providers WHERE id = ?").get(id) as CustomProviderRow);
    },
  };
}

function createAccessRuleRepository(db: () => Database): AccessRuleRepository {
  const toRecord = (row: AccessRuleRow): AccessRuleRecord => {
    let entries: readonly unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(row.entries_json);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // malformed legacy JSON — empty list
    }
    return { scope: row.scope, mode: row.mode, entries, updatedAt: row.updated_at };
  };
  return {
    get(scope: string): AccessRuleRecord | null {
      const row = db().query("SELECT * FROM access_rules WHERE scope = ?").get(scope) as AccessRuleRow | null;
      return row ? toRecord(row) : null;
    },
    upsert(scope: string, input: { mode: string; entries: readonly unknown[] }): AccessRuleRecord {
      const now = nowIso();
      db().query("INSERT INTO access_rules (scope, mode, entries_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET mode = excluded.mode, entries_json = excluded.entries_json, updated_at = excluded.updated_at").run(scope, input.mode, JSON.stringify(input.entries), now);
      return toRecord(db().query("SELECT * FROM access_rules WHERE scope = ?").get(scope) as AccessRuleRow);
    },
  };
}

function createShareLinkRepository(db: () => Database): ShareLinkRepository {
  const toRecord = (row: ShareLinkRow): ShareLinkRecord => ({
    id: row.id,
    apiKeyId: row.api_key_id,
    tokenHash: row.token_hash,
    active: row.active === 1,
    createdAt: row.created_at,
    lastViewedAt: row.last_viewed_at,
  });
  return {
    getByTokenHash(tokenHash: string): ShareLinkRecord | null {
      const row = db().query("SELECT * FROM share_links WHERE token_hash = ?").get(tokenHash) as ShareLinkRow | null;
      return row ? toRecord(row) : null;
    },
    listByApiKey(apiKeyId: string): ShareLinkRecord[] {
      return (db().query("SELECT * FROM share_links WHERE api_key_id = ? ORDER BY created_at DESC").all(apiKeyId) as ShareLinkRow[]).map(toRecord);
    },
    create(input: { id: string; apiKeyId: string; tokenHash: string; active?: boolean }): ShareLinkRecord {
      const now = nowIso();
      db().query("INSERT INTO share_links (id, api_key_id, token_hash, active, created_at) VALUES (?, ?, ?, ?, ?)").run(input.id, input.apiKeyId, input.tokenHash, input.active === false ? 0 : 1, now);
      return toRecord(db().query("SELECT * FROM share_links WHERE id = ?").get(input.id) as ShareLinkRow);
    },
    patchActive(id: string, active: boolean): ShareLinkRecord | null {
      const result = db().query("UPDATE share_links SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
      if (result.changes === 0) return null;
      return toRecord(db().query("SELECT * FROM share_links WHERE id = ?").get(id) as ShareLinkRow);
    },
    touch(id: string): void {
      db().query("UPDATE share_links SET last_viewed_at = ? WHERE id = ?").run(nowIso(), id);
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM share_links WHERE id = ?").run(id);
      return result.changes > 0;
    },
  };
}

// ───────────────────── Durable port implementations ─────────────────────────

/**
 * Durable RouteHealthStore (routing contract): account scope reads/writes
 * `provider_account_health`, proxy scope `proxy_health`. Both tables store
 * only bounded sanitized scalars.
 */
export function createDurableRouteHealthStore(db: () => Database): RouteHealthStore {
  const account = createHealthRepository(db, "provider_account_health", "account_id", "account");
  const proxy = createHealthRepository(db, "proxy_health", "proxy_id", "proxy");
  return {
    async readHealth(scope: RouteScope, routeId: string): Promise<RouteHealth | null> {
      return scope === "proxy" ? proxy.get(routeId) : account.get(routeId);
    },
    async writeHealth(scope: RouteScope, routeId: string, health: RouteHealth): Promise<void> {
      if (scope === "proxy") await proxy.upsert(routeId, health);
      else await account.upsert(routeId, health);
    },
    async clearHealth(scope: RouteScope, routeId: string): Promise<void> {
      if (scope === "proxy") await proxy.clear(routeId);
      else await account.clear(routeId);
    },
  };
}

/** Durable AccountHealthStore (credentials contract) over provider_account_health. */
export function createDurableAccountHealthStore(db: () => Database): AccountHealthStore {
  interface AccountHealthRow {
    account_id: string;
    provider_id: string | null;
    status: string | null;
    status_code: number | null;
    error_kind: string | null;
    sanitized_message: string | null;
    occurred_at: string | null;
    retry_at: string | null;
    disabled_until_ms: number | null;
    failure_count: number;
    generation: number;
  }

  const toRecord = (row: AccountHealthRow): AccountHealthRecord => ({
    accountId: row.account_id,
    providerId: row.provider_id ?? "",
    status: toRouteStatus(row.status),
    statusCode: row.status_code,
    failureKind: toErrorKind(row.error_kind),
    sanitizedMessage: orNullString(row.sanitized_message),
    occurredAt: row.occurred_at,
    retryAt: row.retry_at,
    disabledUntilMs: row.disabled_until_ms,
    failureCount: row.failure_count,
    generation: row.generation,
  });

  return {
    async get(accountId: string): Promise<AccountHealthRecord | undefined> {
      const row = db()
        .query(
          "SELECT h.account_id, h.provider_id, h.status, h.status_code, h.error_kind, h.sanitized_message, h.occurred_at, h.retry_at, h.disabled_until_ms, h.failure_count, h.generation FROM provider_account_health h WHERE h.account_id = ?",
        )
        .get(accountId) as AccountHealthRow | null;
      return row ? toRecord(row) : undefined;
    },
    async set(record: AccountHealthRecord): Promise<void> {
      db().query(
        "INSERT INTO provider_account_health (account_id, provider_id, status, status_code, error_kind, sanitized_message, occurred_at, retry_at, disabled_until_ms, failure_count, generation, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET provider_id = excluded.provider_id, status = excluded.status, status_code = excluded.status_code, error_kind = excluded.error_kind, sanitized_message = excluded.sanitized_message, occurred_at = excluded.occurred_at, retry_at = excluded.retry_at, disabled_until_ms = excluded.disabled_until_ms, failure_count = excluded.failure_count, generation = excluded.generation, updated_at = excluded.updated_at",
      ).run(record.accountId, record.providerId, record.status, record.statusCode, record.failureKind, record.sanitizedMessage, record.occurredAt, record.retryAt, record.disabledUntilMs, record.failureCount, record.generation, nowIso());
    },
    async list(): Promise<readonly AccountHealthRecord[]> {
      const rows = db().query("SELECT h.account_id, h.provider_id, h.status, h.status_code, h.error_kind, h.sanitized_message, h.occurred_at, h.retry_at, h.disabled_until_ms, h.failure_count, h.generation FROM provider_account_health h").all() as AccountHealthRow[];
      return rows.map(toRecord);
    },
    async listForAccountIds(accountIds: readonly string[]): Promise<readonly AccountHealthRecord[]> {
      if (accountIds.length === 0) return [];
      const placeholders = accountIds.map(() => "?").join(",");
      const rows = db().query(
        `SELECT h.account_id, h.provider_id, h.status, h.status_code, h.error_kind, h.sanitized_message, h.occurred_at, h.retry_at, h.disabled_until_ms, h.failure_count, h.generation FROM provider_account_health h WHERE h.account_id IN (${placeholders})`,
      ).all(...accountIds) as AccountHealthRow[];
      return rows.map(toRecord);
    },
  };
}

/** Durable ModelLockStore (credentials contract) over account_model_locks. */
export function createDurableModelLockStore(db: () => Database): ModelLockStore {
  interface ModelLockRow {
    account_id: string;
    model_id: string;
    retry_at: string;
    error_kind: string | null;
    status_code: number | null;
    sanitized_message: string | null;
    failure_count: number;
  }

  const toRecord = (row: ModelLockRow): ModelLockRecord => ({
    accountId: row.account_id,
    modelId: row.model_id,
    retryAt: row.retry_at,
    errorKind: orNullString(row.error_kind),
    statusCode: row.status_code,
    sanitizedMessage: orNullString(row.sanitized_message),
    failureCount: row.failure_count,
  });

  return {
    async get(accountId: string, modelId: string): Promise<ModelLockRecord | undefined> {
      const row = db().query("SELECT account_id, model_id, retry_at, error_kind, status_code, sanitized_message, failure_count FROM account_model_locks WHERE account_id = ? AND model_id = ?").get(accountId, modelId) as ModelLockRow | null;
      return row ? toRecord(row) : undefined;
    },
    async set(record: ModelLockRecord): Promise<void> {
      db().query(
        "INSERT INTO account_model_locks (account_id, model_id, retry_at, error_kind, status_code, sanitized_message, failure_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, model_id) DO UPDATE SET retry_at = excluded.retry_at, error_kind = excluded.error_kind, status_code = excluded.status_code, sanitized_message = excluded.sanitized_message, failure_count = excluded.failure_count, updated_at = excluded.updated_at",
      ).run(record.accountId, record.modelId, record.retryAt, record.errorKind, record.statusCode, record.sanitizedMessage, record.failureCount, nowIso(), nowIso());
    },
    async delete(accountId: string, modelId: string): Promise<void> {
      db().query("DELETE FROM account_model_locks WHERE account_id = ? AND model_id = ?").run(accountId, modelId);
    },
    async listForAccount(accountId: string): Promise<readonly ModelLockRecord[]> {
      const rows = db().query("SELECT account_id, model_id, retry_at, error_kind, status_code, sanitized_message, failure_count FROM account_model_locks WHERE account_id = ?").all(accountId) as ModelLockRow[];
      return rows.map(toRecord);
    },
    async listExpired(nowMs: number): Promise<readonly ModelLockRecord[]> {
      // Push the cutoff into SQL so the partial index
      // idx_account_model_locks_retry ON account_model_locks(retry_at)
      // WHERE retry_at IS NOT NULL is used as a range scan instead of pulling
      // the whole table into JS. retry_at is stored as an ISO-8601 string,
      // which sorts lexicographically identical to chronological order.
      const cutoffIso = new Date(nowMs).toISOString();
      const rows = db().query("SELECT account_id, model_id, retry_at, error_kind, status_code, sanitized_message, failure_count FROM account_model_locks WHERE retry_at IS NOT NULL AND retry_at <= ?").all(cutoffIso) as ModelLockRow[];
      return rows.map(toRecord);
    },
    async listForAccountIds(accountIds: readonly string[]): Promise<readonly ModelLockRecord[]> {
      if (accountIds.length === 0) return [];
      const placeholders = accountIds.map(() => "?").join(",");
      const rows = db().query(
        `SELECT account_id, model_id, retry_at, error_kind, status_code, sanitized_message, failure_count FROM account_model_locks WHERE account_id IN (${placeholders})`,
      ).all(...accountIds) as ModelLockRow[];
      return rows.map(toRecord);
    },
  };
}

/** Durable QuotaStateStore (credentials contract) over quota_json/quota_fetched_at. */
export function createDurableQuotaStateStore(db: () => Database): QuotaStateStore {
  const exists = (accountId: string): boolean => db().query("SELECT 1 FROM provider_accounts WHERE id = ?").get(accountId) !== null;
  type StoredQuota = { available?: boolean; quota?: QuotaStateRecord["quota"]; lastAttemptAtMs?: number | null; lastSuccessAtMs?: number | null };
  const parse = (value: string): StoredQuota | null => {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as StoredQuota : null;
    } catch {
      return null;
    }
  };

  return {
    async get(accountId: string): Promise<QuotaStateRecord | undefined> {
      const row = db().query("SELECT quota_json, quota_fetched_at FROM provider_account_health WHERE account_id = ?").get(accountId) as { quota_json: string | null; quota_fetched_at: string | null } | null;
      if (!row || row.quota_json === null) return undefined;
      const stored = parse(row.quota_json);
      if (stored === null) return undefined;
      return { accountId, quotaAvailable: stored.available !== false, lastQuotaRefreshAtMs: row.quota_fetched_at ? Date.parse(row.quota_fetched_at) : null, lastQuotaAttemptAtMs: stored.lastAttemptAtMs ?? null, lastQuotaSuccessAtMs: stored.lastSuccessAtMs ?? null, quota: stored.quota ?? null };
    },
    async set(record: QuotaStateRecord): Promise<void> {
      if (!exists(record.accountId)) return;
      db().query("UPDATE provider_account_health SET quota_json = ?, quota_error = ?, quota_fetched_at = ?, last_refresh_at = ?, updated_at = ? WHERE account_id = ?").run(
        JSON.stringify({ available: record.quotaAvailable, quota: record.quota ?? null, lastAttemptAtMs: record.lastQuotaAttemptAtMs ?? null, lastSuccessAtMs: record.lastQuotaSuccessAtMs ?? null }),
        record.quota?.error ?? null,
        record.lastQuotaSuccessAtMs === null || record.lastQuotaSuccessAtMs === undefined ? null : new Date(record.lastQuotaSuccessAtMs).toISOString(),
        record.lastQuotaAttemptAtMs === null || record.lastQuotaAttemptAtMs === undefined ? null : new Date(record.lastQuotaAttemptAtMs).toISOString(),
        nowIso(), record.accountId,
      );
    },
    async list(): Promise<readonly QuotaStateRecord[]> {
      const rows = db().query("SELECT account_id, quota_json, quota_fetched_at FROM provider_account_health WHERE quota_json IS NOT NULL").all() as Array<{ account_id: string; quota_json: string; quota_fetched_at: string | null }>;
      const out: QuotaStateRecord[] = [];
      for (const row of rows) {
        const stored = parse(row.quota_json);
        if (stored !== null) out.push({ accountId: row.account_id, quotaAvailable: stored.available !== false, lastQuotaRefreshAtMs: row.quota_fetched_at ? Date.parse(row.quota_fetched_at) : null, lastQuotaAttemptAtMs: stored.lastAttemptAtMs ?? null, lastQuotaSuccessAtMs: stored.lastSuccessAtMs ?? null, quota: stored.quota ?? null });
      }
      return out;
    },
    async listForAccountIds(accountIds: readonly string[]): Promise<readonly QuotaStateRecord[]> {
      if (accountIds.length === 0) return [];
      const placeholders = accountIds.map(() => "?").join(",");
      const rows = db().query(
        `SELECT account_id, quota_json, quota_fetched_at FROM provider_account_health WHERE account_id IN (${placeholders})`,
      ).all(...accountIds) as Array<{ account_id: string; quota_json: string | null; quota_fetched_at: string | null }>;
      const results: QuotaStateRecord[] = [];
      for (const row of rows) {
        if (row.quota_json === null) continue;
        const stored = parse(row.quota_json);
        if (stored === null) continue;
        results.push({ accountId: row.account_id, quotaAvailable: stored.available !== false, lastQuotaRefreshAtMs: row.quota_fetched_at ? Date.parse(row.quota_fetched_at) : null, lastQuotaAttemptAtMs: stored.lastAttemptAtMs ?? null, lastQuotaSuccessAtMs: stored.lastSuccessAtMs ?? null, quota: stored.quota ?? null });
      }
      return results;
    },
  };
}

/**
 * Durable OAuthTokenStore (credentials contract). The access/refresh token
 * bundle is a JSON v1 payload in `provider_accounts.credential`, matching the
 * legacy bundle layout; the hint column keeps the masked tail for display.
 */
export function createDurableOAuthTokenStore(db: () => Database): OAuthTokenStore {
  const toToken = (value: string): OAuthTokenRecord | undefined => {
    const raw = value.trim();
    if (raw.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.accessToken !== "string" || record.accessToken.length === 0) return undefined;
        return {
          accessToken: record.accessToken,
          expiresAtMs: typeof record.accessExpiresAt === "number" ? record.accessExpiresAt : null,
          refreshToken: typeof record.refreshToken === "string" && record.refreshToken.length > 0 ? record.refreshToken : null,
          kind: "oauth",
        };
      }
    } catch {
      // A raw bearer token is not JSON; preserve it as a non-refreshable OAuth token.
    }
    // Some OAuth-style providers accept a pasted bearer token without a
    // refresh token. Treat it as a durable access token instead of making the
    // coordinator report a misleading local refresh configuration failure.
    return { accessToken: raw, expiresAtMs: null, refreshToken: null, kind: "oauth" };
  };

  return {
    async get(accountId: string): Promise<OAuthTokenRecord | undefined> {
      const row = db().query("SELECT credential FROM provider_accounts WHERE id = ?").get(accountId) as { credential: string } | null;
      return row ? toToken(row.credential) : undefined;
    },
    async set(accountId: string, token: OAuthTokenRecord): Promise<void> {
      // Single SELECT: fetch provider, credential kind, and the existing
      // credential bundle in one query (was two separate SELECTs — one for
      // existence + provider, one for the previous credential to merge).
      const existing = db().query("SELECT provider, credential_kind, credential FROM provider_accounts WHERE id = ?").get(accountId) as { provider: string; credential_kind: string; credential: string | null } | null;
      if (!existing) return;
      let previous: Record<string, unknown> = {};
      if (existing.credential) {
        try {
          const parsed: unknown = JSON.parse(existing.credential);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) previous = parsed as Record<string, unknown>;
        } catch {
          previous = {};
        }
      }
      const bundle: Record<string, unknown> = {
        ...previous,
        version: 1,
        provider: existing.provider,
        refreshToken: token.refreshToken,
        accessToken: token.accessToken,
        accessExpiresAt: token.expiresAtMs,
        updatedAt: Date.now(),
      };
      const hint = `…${token.accessToken.slice(-4)}`;
      db().query("UPDATE provider_accounts SET credential = ?, credential_hint = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(bundle), hint, nowIso(), accountId);
    },
    async delete(accountId: string): Promise<void> {
      db().query("UPDATE provider_accounts SET credential = '', credential_hint = '', updated_at = ? WHERE id = ?").run(nowIso(), accountId);
    },
  };
}

/** Durable CredentialConfigStore (credentials contract) over provider_accounts. */
export function createDurableCredentialConfigStore(db: () => Database): CredentialConfigStore {
  const toConfig = (row: ProviderAccountRow): AccountConfig => ({
    id: row.id,
    providerId: row.provider,
    kind: credentialKindOf(row.credential_kind),
    secret: row.credential.length > 0 ? row.credential : null,
    enabled: row.active === 1,
    priority: row.priority,
  });
  return {
    async getAccount(id: string): Promise<AccountConfig | undefined> {
      const row = db().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
      return row ? toConfig(row) : undefined;
    },
    async listAccounts(): Promise<readonly AccountConfig[]> {
      return (db().query("SELECT * FROM provider_accounts ORDER BY provider ASC, priority ASC, name ASC").all() as ProviderAccountRow[]).map(toConfig);
    },
  };
}

/** Durable ProxyPoolConfigStore (transport contract) over proxies + proxy_settings. */
export function createDurableProxyPoolConfigStore(db: () => Database): ProxyPoolConfigStore {
  const excludedProviders = (): readonly string[] => {
    const row = db().query("SELECT excluded_providers_json FROM proxy_settings WHERE id = 1").get() as { excluded_providers_json: string } | null;
    if (!row) return [];
    try {
      const parsed: unknown = JSON.parse(row.excluded_providers_json);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  };
  const toConfig = (row: ProxyRow, excludedProviderIds: readonly string[]): ProxyConfig => {
    const auth = row.username !== null && row.username.length > 0 ? `${encodeURIComponent(row.username)}${row.password !== null && row.password.length > 0 ? `:${encodeURIComponent(row.password)}` : ""}@` : "";
    return {
      id: row.id,
      url: `${row.protocol}://${auth}${row.host}:${row.port}`,
      isRelay: row.is_relay === 1,
      enabled: row.active === 1,
      maxConcurrency: row.max_concurrency > 0 ? row.max_concurrency : 8,
      priority: row.priority,
      weight: Math.max(1, Math.min(1_000, Math.round(row.weight || 100))),
      excludedProviderIds,
    };
  };
  return {
    async getProxy(id: string): Promise<ProxyConfig | undefined> {
      const row = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      return row ? toConfig(row, excludedProviders()) : undefined;
    },
    async listProxies(): Promise<readonly ProxyConfig[]> {
      // Single SELECT for the shared excluded-providers list instead of one
      // per proxy row (the original toConfig() called excludedProviders() on
      // every .map iteration — an N+1 on the transport hot path).
      const excludedProviderIds = excludedProviders();
      return (db().query("SELECT * FROM proxies ORDER BY priority ASC, name ASC").all() as ProxyRow[]).map((row) => toConfig(row, excludedProviderIds));
    },
  };
}

// ─────────────────────────────── Lifecycle ──────────────────────────────────

export interface ConfigPersistence {
  readonly env: PersistenceEnv;
  readonly settings: SettingsRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly accounts: AccountRepository;
  readonly accountHealth: HealthRepository;
  readonly proxyHealth: HealthRepository;
  readonly proxies: ProxyRepository;
  readonly providerModels: ProviderModelRepository;
  readonly aliases: AliasRepository;
  readonly combos: ComboRepository;
  readonly customProviders: CustomProviderRepository;
  readonly accessRules: AccessRuleRepository;
  readonly shareLinks: ShareLinkRepository;
  readonly filterRules: FilterRuleRepository;
  readonly warpAccounts: WarpAccountRepository;
  readonly ipBans: IpBanRepository;
  /** Repository-backed implementations of the routing/credentials/transport ports. */
  readonly stores: {
    readonly routeHealth: RouteHealthStore;
    readonly accountHealth: AccountHealthStore;
    readonly quotaState: QuotaStateStore;
    readonly oauthToken: OAuthTokenStore;
    readonly credentialConfig: CredentialConfigStore;
    readonly proxyPool: ProxyPoolConfigStore;
    readonly modelLocks: ModelLockStore;
  };
  /** WAL checkpoint without blocking readers. */
  readonly checkpoint: () => void;
  /** Configuration snapshot export (secrets included — this is the backup file). */
  readonly backup: () => BackupPayload;
  /** Applies a pre-validated backup inside one transaction; rolls back on any error. */
  readonly restoreBackup: (validation: Extract<RestoreValidation, { ok: true }>) => RestoreResult;
  /** Destructive reset used only after console password confirmation. */
  readonly resetAll: () => void;
  /** Flushes coalesced writes and closes the connection. */
  readonly close: () => void;
  /**
   * Live `Database` handle for coordinated admin writes (db-map SQL console).
   * Exposed only because the database browser needs raw SQL access that the
   * repository boundary cannot express; never use this from request hot paths.
   */
  readonly db: () => Database;
  /**
   * Checkpoint and close the current connection so the live file can be
   * renamed/overwritten (db-map import). Unlike the terminal shutdown
   * `close()`, the singleton can be brought back with `reopen()`.
   */
  readonly closeForSwap: () => void;
  /**
   * Reopen a fresh connection at the same path so a swapped database file
   * (db-map import) is picked up by all repositories.
   */
  readonly reopen: () => void;
}

// ───────────────────── Filter rules ──────────────────────────────────────────

interface FilterRuleRow {
  id: number;
  rule_id: string;
  pattern: string;
  replacement: string;
  is_active: number;
  is_regex: number;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
}

function createFilterRuleRepository(db: () => Database): FilterRuleRepository {
  const toView = (row: FilterRuleRow) => ({
    id: row.id,
    ruleId: row.rule_id,
    pattern: row.pattern,
    replacement: row.replacement,
    isActive: row.is_active === 1,
    isRegex: row.is_regex === 1,
    sortOrder: row.sort_order,
  });

  return {
    async list() {
      const rows = db().query("SELECT * FROM filter_rules ORDER BY sort_order ASC, id ASC").all() as FilterRuleRow[];
      return rows.map(toView);
    },
    listSync() {
      const rows = db().query("SELECT * FROM filter_rules ORDER BY sort_order ASC, id ASC").all() as FilterRuleRow[];
      return rows.map(toView);
    },

    async create(input) {
      const pattern = input.pattern.trim();
      if (!pattern) throw new Error("pattern is required");
      // Validate regex if applicable
      if (input.isRegex !== false) {
        try { new RegExp(pattern, "gi"); } catch { throw new Error("invalid regex pattern"); }
      }
      const maxRow = db().query("SELECT COALESCE(MAX(sort_order), 0) as max_order FROM filter_rules").get() as { max_order: number };
      const sortOrder = maxRow.max_order + 1;
      const ruleId = typeof input.ruleId === "string" && input.ruleId.trim().length > 0 ? input.ruleId.trim() : `rule_${crypto.randomUUID().slice(0, 8)}`;
      const now = nowIso();
      db().query(
        "INSERT INTO filter_rules (rule_id, pattern, replacement, is_active, is_regex, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        ruleId,
        pattern,
        input.replacement ?? "",
        input.isActive === false ? 0 : 1,
        input.isRegex === false ? 0 : 1,
        sortOrder,
        now,
      );
      const row = db().query("SELECT * FROM filter_rules WHERE rule_id = ?").get(ruleId) as FilterRuleRow;
      return toView(row);
    },

    async update(id, patch) {
      const sets: string[] = [];
      const params: (string | number)[] = [];
      if (patch.pattern !== undefined) {
        const trimmed = patch.pattern.trim();
        if (!trimmed) throw new Error("pattern cannot be empty");
        sets.push("pattern = ?"); params.push(trimmed);
      }
      if (patch.replacement !== undefined) { sets.push("replacement = ?"); params.push(patch.replacement); }
      if (patch.isRegex !== undefined) {
        if (patch.isRegex) { try { new RegExp(patch.pattern ?? "", "gi"); } catch { throw new Error("invalid regex pattern"); } }
        sets.push("is_regex = ?"); params.push(patch.isRegex ? 1 : 0);
      }
      if (patch.isActive !== undefined) { sets.push("is_active = ?"); params.push(patch.isActive ? 1 : 0); }
      if (patch.sortOrder !== undefined) { sets.push("sort_order = ?"); params.push(patch.sortOrder); }
      if (sets.length === 0) {
        const row = db().query("SELECT * FROM filter_rules WHERE id = ?").get(id) as FilterRuleRow | null;
        return row ? toView(row) : null;
      }
      sets.push("updated_at = ?"); params.push(nowIso());
      params.push(id);
      const result = db().query(`UPDATE filter_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      if (result.changes === 0) return null;
      const row = db().query("SELECT * FROM filter_rules WHERE id = ?").get(id) as FilterRuleRow;
      return toView(row);
    },

    async remove(id) {
      const result = db().query("DELETE FROM filter_rules WHERE id = ?").run(id);
      return result.changes > 0;
    },
  };
}

// ───────────────────── IP bans ──────────────────────────────────────────────

function createIpBanRepository(db: () => Database): IpBanRepository {
  const toView = (row: { ip: string; reason: string; created_at: string }): IpBanView => ({
    ip: row.ip,
    reason: row.reason,
    createdAt: row.created_at,
  });

  return {
    async list(): Promise<readonly IpBanView[]> {
      const rows = db().query("SELECT ip, reason, created_at FROM ip_bans ORDER BY created_at DESC").all() as { ip: string; reason: string; created_at: string }[];
      return rows.map(toView);
    },

    async add(ip: string, reason = ""): Promise<IpBanView> {
      const now = nowIso();
      db().query("INSERT INTO ip_bans (ip, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at").run(ip, reason, now);
      return { ip, reason, createdAt: now };
    },

    async remove(ip: string): Promise<boolean> {
      const result = db().query("DELETE FROM ip_bans WHERE ip = ?").run(ip);
      return result.changes > 0;
    },

    async isBanned(ip: string): Promise<boolean> {
      return db().query("SELECT 1 FROM ip_bans WHERE ip = ?").get(ip) !== null;
    },

    async bannedSet(): Promise<ReadonlySet<string>> {
      const rows = db().query("SELECT ip FROM ip_bans").all() as { ip: string }[];
      return new Set(rows.map((row) => row.ip));
    },
  };
}

/** Warp account row shape (matches warp_accounts table columns). */
interface WarpAccountRow {
  id: string;
  label: string;
  device_id: string;
  access_token: string;
  license_key: string;
  private_key: string;
  address_v4: string;
  address_v6: string;
  public_key: string;
  endpoint: string;
  endpoint_port: number;
  dns: string;
  mtu: number;
  socks_port: number;
  enabled: number;
  running: number;
  pid: number | null;
  prefer_ipv6: number;
  custom_endpoint: string | null;
  persistent_keepalive: number;
  created_at: string;
  updated_at: string | null;
}

function toWarpAccount(row: WarpAccountRow): WarpAccount {
  return {
    id: row.id,
    label: row.label,
    deviceId: row.device_id,
    accessToken: row.access_token,
    licenseKey: row.license_key,
    privateKey: row.private_key,
    addressV4: row.address_v4,
    addressV6: row.address_v6,
    publicKey: row.public_key,
    endpoint: row.endpoint,
    endpointPort: row.endpoint_port,
    dns: row.dns,
    mtu: row.mtu,
    socksPort: row.socks_port,
    enabled: row.enabled === 1,
    running: row.running === 1,
    pid: row.pid,
    preferIpv6: row.prefer_ipv6 === 1,
    customEndpoint: row.custom_endpoint,
    persistentKeepalive: row.persistent_keepalive,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createWarpAccountRepository(db: () => Database): WarpAccountRepository {
  return {
    async list() {
      return (db().query("SELECT * FROM warp_accounts ORDER BY created_at ASC").all() as WarpAccountRow[]).map(toWarpAccount);
    },
    async get(id) {
      const row = db().query("SELECT * FROM warp_accounts WHERE id = ?").get(id) as WarpAccountRow | null;
      return row ? toWarpAccount(row) : null;
    },
    async create(data: WarpAccountCreateData) {
      const now = new Date().toISOString();
      db().query(`INSERT INTO warp_accounts (id, label, device_id, access_token, license_key, private_key, address_v4, address_v6, public_key, endpoint, endpoint_port, dns, mtu, socks_port, enabled, running, pid, prefer_ipv6, custom_endpoint, persistent_keepalive, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?, NULL)`).run(
        data.id, data.label, data.deviceId, data.accessToken, data.licenseKey, data.privateKey, data.addressV4, data.addressV6, data.publicKey, data.endpoint, data.endpointPort, data.dns, data.mtu, data.socksPort,
        data.preferIpv6 ? 1 : 0,
        data.customEndpoint ?? null,
        data.persistentKeepalive ?? 15,
        now,
      );
      const row = db().query("SELECT * FROM warp_accounts WHERE id = ?").get(data.id) as WarpAccountRow;
      return toWarpAccount(row);
    },
    async update(id, patch: Partial<WarpAccountUpdateData>) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.label !== undefined) { sets.push("label = ?"); params.push(patch.label); }
      if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
      if (patch.socksPort !== undefined) { sets.push("socks_port = ?"); params.push(patch.socksPort); }
      if (patch.preferIpv6 !== undefined) { sets.push("prefer_ipv6 = ?"); params.push(patch.preferIpv6 ? 1 : 0); }
      if (patch.customEndpoint !== undefined) { sets.push("custom_endpoint = ?"); params.push(patch.customEndpoint); }
      if (patch.persistentKeepalive !== undefined) { sets.push("persistent_keepalive = ?"); params.push(patch.persistentKeepalive); }
      if (sets.length === 0) return db().query("SELECT * FROM warp_accounts WHERE id = ?").get(id) as WarpAccountRow ? toWarpAccount(db().query("SELECT * FROM warp_accounts WHERE id = ?").get(id) as WarpAccountRow) : null;
      sets.push("updated_at = ?"); params.push(new Date().toISOString());
      params.push(id);
      const result = db().query(`UPDATE warp_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      if (result.changes === 0) return null;
      const row = db().query("SELECT * FROM warp_accounts WHERE id = ?").get(id) as WarpAccountRow;
      return toWarpAccount(row);
    },
    async remove(id) {
      const result = db().query("DELETE FROM warp_accounts WHERE id = ?").run(id);
      return result.changes > 0;
    },
    async setRunning(id, running, pid) {
      db().query("UPDATE warp_accounts SET running = ?, pid = ?, updated_at = ? WHERE id = ?").run(running ? 1 : 0, pid, new Date().toISOString(), id);
    },
  };
}

export function createConfigPersistence(env: PersistenceEnv = getPersistenceEnv()): ConfigPersistence {
  let db: Database | null = null;
  let closed = false;

  const getDb = (): Database => {
    if (closed) throw new Error("configuration database is closed");
    if (db === null) {
      try {
        mkdirSync(dirname(env.dbPath), { recursive: true });
        const opened = new Database(env.dbPath, { create: true });
        opened.exec("PRAGMA journal_mode=WAL");
        // Config state is durable-by-default: FULL synchronous (unlike the
        // runtime telemetry database, which trades a narrow crash window for
        // write throughput).
        opened.exec("PRAGMA synchronous=FULL");
        opened.exec("PRAGMA foreign_keys=ON");
        opened.exec("PRAGMA busy_timeout=5000");
        // Pre-migration: drop account_model_locks if it has the old schema
        // (locked_until instead of retry_at). The CREATE INDEX in
        // CONFIG_SCHEMA_SQL references retry_at, which would fail on old tables.
        try {
          const lockCols = opened.prepare("PRAGMA table_info(account_model_locks)").all() as { name: string }[];
          const lockColNames = new Set(lockCols.map((c) => c.name));
          if (lockColNames.has("locked_until") && !lockColNames.has("retry_at")) {
            opened.exec("DROP TABLE IF EXISTS account_model_locks");
          }
        } catch {
          // Table doesn't exist yet — safe to ignore.
        }
        opened.exec(CONFIG_SCHEMA_SQL);
        ensureConfigSchema(opened);
        migrateProviderIds(opened);
        db = opened;
      } catch (error) {
        throw new Error(`configuration database unavailable: ${sanitizeMessage(error instanceof Error ? error.message : "open failed")}`);
      }
    }
    return db;
  };

  const settingsRepo = createSettingsRepository(getDb, env);
  const apiKeysRepo = createApiKeyRepository(getDb);
  const accountsRepo = createAccountRepository(getDb);
  const accountHealthRepo = createHealthRepository(getDb, "provider_account_health", "account_id", "account");
  const proxyHealthRepo = createHealthRepository(getDb, "proxy_health", "proxy_id", "proxy");
  const proxiesRepo = createProxyRepository(getDb);
  const providerModelsRepo = createProviderModelRepository(getDb);
  const aliasesRepo = createAliasRepository(getDb);
  const combosRepo = createComboRepository(getDb);
  const customProvidersRepo = createCustomProviderRepository(getDb);
  const accessRulesRepo = createAccessRuleRepository(getDb);
  const shareLinksRepo = createShareLinkRepository(getDb);
  const filterRulesRepo = createFilterRuleRepository(getDb);
  const warpAccountsRepo = createWarpAccountRepository(getDb);
  const ipBansRepo = createIpBanRepository(getDb);

  return {
    env,
    settings: settingsRepo,
    apiKeys: apiKeysRepo,
    accounts: accountsRepo,
    accountHealth: accountHealthRepo,
    proxyHealth: proxyHealthRepo,
    proxies: proxiesRepo,
    providerModels: providerModelsRepo,
    aliases: aliasesRepo,
    combos: combosRepo,
    customProviders: customProvidersRepo,
    accessRules: accessRulesRepo,
    shareLinks: shareLinksRepo,
    filterRules: filterRulesRepo,
    warpAccounts: warpAccountsRepo,
    ipBans: ipBansRepo,
    stores: {
      routeHealth: createDurableRouteHealthStore(getDb),
      accountHealth: createDurableAccountHealthStore(getDb),
      quotaState: createDurableQuotaStateStore(getDb),
      oauthToken: createDurableOAuthTokenStore(getDb),
      credentialConfig: createDurableCredentialConfigStore(getDb),
      proxyPool: createDurableProxyPoolConfigStore(getDb),
      modelLocks: createDurableModelLockStore(getDb),
    },
    checkpoint(): void {
      db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
    },
    db(): Database {
      return getDb();
    },
    closeForSwap(): void {
      // Flush any pending api-key touch coalescing before tearing down.
      apiKeysRepo.flushTouches();
      if (db) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // no active transaction — best effort
        }
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // mid-close — best effort
        }
        try {
          db.close();
        } catch {
          // already closed — best effort
        }
        db = null;
      }
      // Mark reopenable: a subsequent reopen() (or lazy getDb()) re-opens
      // against whatever file is now at env.dbPath.
      closed = false;
    },
    reopen(): void {
      // Force a fresh open against the (possibly swapped) file, re-running
      // schema setup + migrations so an imported DB missing our tables is
      // brought up to date.
      closed = false;
      getDb();
    },
    backup(): BackupPayload {
      return exportConfigBackup(getDb());
    },
    restoreBackup(validation: Extract<RestoreValidation, { ok: true }>): RestoreResult {
      return applyConfigRestore(getDb(), validation);
    },
    resetAll(): void {
      const database = getDb();
      clearAllDatabaseTables(database);
      settingsRepo.ensure();
    },
    close(): void {
      if (closed) return;
      apiKeysRepo.flushTouches();
      closed = true;
      if (db) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // no active transaction or already closed — best effort
        }
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // already closed or mid-shutdown — best effort
        }
        db.close();
        db = null;
      }
    },
  };
}

let singleton: ConfigPersistence | null = null;

/** Test-only: close the singleton so the next access re-opens (possibly at a re-pointed env). */
export function resetConfigPersistenceForTests(): void {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // already closed — fine
    }
    singleton = null;
  }
}
