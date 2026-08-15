import { Database } from "bun:sqlite";
import type { ApplicationErrorKind, ModelLockRecord, RouteHealth, RouteHealthStore, RouteScope } from "../../application/contracts";
import type { AccountConfig, AccountHealthRecord, AccountHealthStore, CredentialConfigStore, ModelLockStore, OAuthTokenRecord, OAuthTokenStore, QuotaStateRecord, QuotaStateStore } from "../../application/auth/credentials";
import { fingerprintOAuthToken } from "../../application/auth/credentials";
import type { ProxyConfig, ProxyPoolConfigStore } from "../../traffic/network";
import { credentialKindOf } from "./mappers";
import { nowIso, orNullString, toErrorKind, toRouteStatus } from "./schema";
import { createConsoleHealthRepository } from "./repositories/health";
import type { ProviderAccountRow, ProxyRow } from "./mappers";

/**
 * Durable RouteHealthStore (routing contract): account scope reads/writes
 * `provider_account_health`, proxy scope `proxy_health`. Both tables store
 * only bounded sanitized scalars.
 */
export function createDurableRouteHealthStore(db: () => Database): RouteHealthStore {
  const account = createConsoleHealthRepository(db, "provider_account_health", "account_id", "account");
  const proxy = createConsoleHealthRepository(db, "proxy_health", "proxy_id", "proxy");
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
  const unsupportedQuotaError = "Quota endpoint is not available for this provider.";
  const availableFromStored = (stored: StoredQuota): boolean => stored.quota?.error === unsupportedQuotaError || stored.available !== false;
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
      return { accountId, quotaAvailable: availableFromStored(stored), lastQuotaRefreshAtMs: row.quota_fetched_at ? Date.parse(row.quota_fetched_at) : null, lastQuotaAttemptAtMs: stored.lastAttemptAtMs ?? null, lastQuotaSuccessAtMs: stored.lastSuccessAtMs ?? null, quota: stored.quota ?? null };
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
        if (stored !== null) out.push({ accountId: row.account_id, quotaAvailable: availableFromStored(stored), lastQuotaRefreshAtMs: row.quota_fetched_at ? Date.parse(row.quota_fetched_at) : null, lastQuotaAttemptAtMs: stored.lastAttemptAtMs ?? null, lastQuotaSuccessAtMs: stored.lastSuccessAtMs ?? null, quota: stored.quota ?? null });
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
        results.push({ accountId: row.account_id, quotaAvailable: availableFromStored(stored), lastQuotaRefreshAtMs: row.quota_fetched_at ? Date.parse(row.quota_fetched_at) : null, lastQuotaAttemptAtMs: stored.lastAttemptAtMs ?? null, lastQuotaSuccessAtMs: stored.lastSuccessAtMs ?? null, quota: stored.quota ?? null });
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
          generation: typeof record.generation === "number" && Number.isSafeInteger(record.generation) && record.generation >= 0 ? record.generation : 0,
          lastRefreshAtMs: typeof record.lastRefreshAtMs === "number" ? record.lastRefreshAtMs : null,
          lastRefreshAttemptAtMs: typeof record.lastRefreshAttemptAtMs === "number" ? record.lastRefreshAttemptAtMs : null,
          lastRefreshErrorKind: typeof record.lastRefreshErrorKind === "string" ? record.lastRefreshErrorKind as ApplicationErrorKind : null,
          lastRefreshStatusCode: typeof record.lastRefreshStatusCode === "number" ? record.lastRefreshStatusCode : null,
          refreshState: record.refreshState === "healthy" || record.refreshState === "retrying" || record.refreshState === "reauth_required" ? record.refreshState : "healthy",
          refreshRetryAtMs: typeof record.refreshRetryAtMs === "number" ? record.refreshRetryAtMs : null,
          refreshFailureCount: typeof record.refreshFailureCount === "number" && Number.isSafeInteger(record.refreshFailureCount) && record.refreshFailureCount >= 0 ? record.refreshFailureCount : 0,
        };
      }
    } catch {
      // A raw bearer token is not JSON; preserve it as a non-refreshable OAuth token.
    }
    return { accessToken: raw, expiresAtMs: null, refreshToken: null, kind: "oauth", generation: 0, refreshState: "healthy", refreshRetryAtMs: null, refreshFailureCount: 0 };
  };

  const readExisting = (accountId: string): { provider: string; credential: string | null; credentialHint: string | null } | null =>
    db().query("SELECT provider, credential, credential_hint AS credentialHint FROM provider_accounts WHERE id = ?").get(accountId) as { provider: string; credential: string | null; credentialHint: string | null } | null;

  const buildBundle = (existing: { provider: string; credential: string | null }, token: OAuthTokenRecord): Record<string, unknown> => {
    let previous: Record<string, unknown> = {};
    if (existing.credential) {
      try {
        const parsed: unknown = JSON.parse(existing.credential);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) previous = parsed as Record<string, unknown>;
      } catch {
        previous = {};
      }
    }
    return {
      ...previous,
      version: 1,
      provider: existing.provider,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      accessExpiresAt: token.expiresAtMs,
      generation: token.generation ?? 0,
      lastRefreshAtMs: token.lastRefreshAtMs ?? null,
      lastRefreshAttemptAtMs: token.lastRefreshAttemptAtMs ?? null,
      lastRefreshErrorKind: token.lastRefreshErrorKind ?? null,
      lastRefreshStatusCode: token.lastRefreshStatusCode ?? null,
      refreshState: token.refreshState ?? "healthy",
      refreshRetryAtMs: token.refreshRetryAtMs ?? null,
      refreshFailureCount: token.refreshFailureCount ?? 0,
      updatedAt: Date.now(),
    };
  };

  const writeToken = (accountId: string, existing: { provider: string; credential: string | null; credentialHint: string | null }, token: OAuthTokenRecord): void => {
    const bundle = buildBundle(existing, token);
    const hint = existing.credentialHint?.trim() || `…${token.accessToken.slice(-4)}`;
    db().query("UPDATE provider_accounts SET credential = ?, credential_hint = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(bundle), hint, nowIso(), accountId);
  };

  return {
    async get(accountId: string): Promise<OAuthTokenRecord | undefined> {
      const row = db().query("SELECT credential FROM provider_accounts WHERE id = ?").get(accountId) as { credential: string } | null;
      return row ? toToken(row.credential) : undefined;
    },
    async set(accountId: string, token: OAuthTokenRecord): Promise<void> {
      const existing = readExisting(accountId);
      if (existing) writeToken(accountId, existing, token);
    },
    async tryAcquireRefreshLease(input): Promise<boolean> {
      const leaseUntilMs = input.nowMs + Math.max(1_000, input.leaseMs);
      const result = db().query(
        `INSERT INTO oauth_refresh_leases (account_id, owner_id, generation, token_fingerprint, lease_until_ms, acquired_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           generation = excluded.generation,
           token_fingerprint = excluded.token_fingerprint,
           lease_until_ms = excluded.lease_until_ms,
           acquired_at_ms = excluded.acquired_at_ms
         WHERE oauth_refresh_leases.lease_until_ms <= ? OR oauth_refresh_leases.owner_id = ?`,
      ).run(input.accountId, input.ownerId, input.generation, input.tokenFingerprint, leaseUntilMs, input.nowMs, input.nowMs, input.ownerId);
      return result.changes > 0;
    },
    async releaseRefreshLease(accountId, ownerId): Promise<void> {
      db().query("DELETE FROM oauth_refresh_leases WHERE account_id = ? AND owner_id = ?").run(accountId, ownerId);
    },
    async compareAndSwap(input): Promise<boolean> {
      const transaction = db().transaction(() => {
        const existing = readExisting(input.accountId);
        if (!existing) return false;
        const current = existing.credential === null ? undefined : toToken(existing.credential);
        if (current === undefined || (current.generation ?? 0) !== input.expectedGeneration || fingerprintOAuthToken(current) !== input.expectedTokenFingerprint) return false;
        writeToken(input.accountId, existing, input.token);
        return true;
      });
      return transaction();
    },
    async delete(accountId: string): Promise<void> {
      db().query("UPDATE provider_accounts SET credential = '', credential_hint = '', updated_at = ? WHERE id = ?").run(nowIso(), accountId);
      db().query("DELETE FROM oauth_refresh_leases WHERE account_id = ?").run(accountId);
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
      const excluded = excludedProviders();
      return (db().query("SELECT * FROM proxies ORDER BY priority ASC, name ASC").all() as ProxyRow[]).map((row) => toConfig(row, excluded));
    },
  };
}
