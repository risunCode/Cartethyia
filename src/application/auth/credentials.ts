import { sanitizeMessage, type ApplicationErrorKind, type AccountCandidate, type CredentialKind, type CredentialSelection, type ModelLockRecord, type ProviderCallError, type RouteHealth, type RouteStatus } from "../contracts";
import { createProviderError } from "../../traffic";
import type { TokenRefreshPool } from "./token-refresh";

/**
 * Persistence ports for credential, quota, and account-health state.
 *
 * Wave A ships in-memory implementations; Wave B persistence integration
 * swaps in repository-backed implementations behind these same interfaces.
 * Health payloads never carry secrets: only bounded, sanitized messages.
 */

export interface AccountHealthRecord {
  readonly accountId: string;
  readonly providerId: string;
  readonly status: RouteStatus;
  readonly statusCode: number | null;
  readonly failureKind: ApplicationErrorKind | null;
  readonly sanitizedMessage: string | null;
  readonly occurredAt: string | null;
  readonly retryAt: string | null;
  readonly disabledUntilMs: number | null;
  readonly failureCount: number;
  readonly generation: number;
}

export interface AccountHealthStore {
  get(accountId: string): Promise<AccountHealthRecord | undefined>;
  set(record: AccountHealthRecord): Promise<void>;
  list(): Promise<readonly AccountHealthRecord[]>;
  /** Batch-load health records for multiple accounts (single IN-clause query). */
  listForAccountIds(accountIds: readonly string[]): Promise<readonly AccountHealthRecord[]>;
}

export class MemoryAccountHealthStore implements AccountHealthStore {
  private readonly records = new Map<string, AccountHealthRecord>();

  async get(accountId: string): Promise<AccountHealthRecord | undefined> {
    return this.records.get(accountId);
  }

  async set(record: AccountHealthRecord): Promise<void> {
    this.records.set(record.accountId, record);
  }

  async list(): Promise<readonly AccountHealthRecord[]> {
    return [...this.records.values()];
  }

  async listForAccountIds(accountIds: readonly string[]): Promise<readonly AccountHealthRecord[]> {
    if (accountIds.length === 0) return [];
    const idSet = new Set(accountIds);
    return [...this.records.values()].filter((record) => idSet.has(record.accountId));
  }
}

/**
 * Per-model lock persistence port. Backed by an in-memory Map for tests
 * (keyed by `${accountId}:${modelId}`) and a durable SQLite table in
 * production. The record type itself lives in application/contracts to avoid a
 * circular import (contracts defines AccountCandidate which references it).
 */
export interface ModelLockStore {
  get(accountId: string, modelId: string): Promise<ModelLockRecord | undefined>;
  set(record: ModelLockRecord): Promise<void>;
  delete(accountId: string, modelId: string): Promise<void>;
  listForAccount(accountId: string): Promise<readonly ModelLockRecord[]>;
  listExpired(nowMs: number): Promise<readonly ModelLockRecord[]>;
  /** Batch-load model locks for multiple accounts (single IN-clause query). */
  listForAccountIds(accountIds: readonly string[]): Promise<readonly ModelLockRecord[]>;
}

export class MemoryModelLockStore implements ModelLockStore {
  private readonly records = new Map<string, ModelLockRecord>();

  async get(accountId: string, modelId: string): Promise<ModelLockRecord | undefined> {
    return this.records.get(`${accountId}:${modelId}`);
  }

  async set(record: ModelLockRecord): Promise<void> {
    this.records.set(`${record.accountId}:${record.modelId}`, record);
  }

  async delete(accountId: string, modelId: string): Promise<void> {
    this.records.delete(`${accountId}:${modelId}`);
  }

  async listForAccount(accountId: string): Promise<readonly ModelLockRecord[]> {
    return [...this.records.values()].filter((record) => record.accountId === accountId);
  }

  async listExpired(nowMs: number): Promise<readonly ModelLockRecord[]> {
    return [...this.records.values()].filter((record) => Date.parse(record.retryAt) <= nowMs);
  }

  async listForAccountIds(accountIds: readonly string[]): Promise<readonly ModelLockRecord[]> {
    if (accountIds.length === 0) return [];
    const idSet = new Set(accountIds);
    return [...this.records.values()].filter((record) => idSet.has(record.accountId));
  }
}

export interface QuotaWindowState {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
}

export interface QuotaSnapshotState {
  readonly source: string;
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly plan: string | null;
  readonly windows: readonly QuotaWindowState[];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
}

export interface QuotaStateRecord {
  readonly accountId: string;
  readonly quotaAvailable: boolean;
  readonly lastQuotaRefreshAtMs: number | null;
  readonly lastQuotaAttemptAtMs?: number | null;
  readonly lastQuotaSuccessAtMs?: number | null;
  readonly quota?: QuotaSnapshotState | null;
}
/**
 * Bounded account usage view used only to rank otherwise eligible credentials.
 * A stale snapshot is retained as diagnostic state but never changes ordering.
 */
export interface AccountUsageSnapshot {
  readonly accountId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly remainingFraction: number | null;
  readonly resetAtMs: number | null;
  readonly fetchedAtMs: number;
  readonly stale: boolean;
}

/**
 * Context supplied to an account usage provider. Providers should return only
 * bounded scalar usage metadata and must not include credentials or payloads.
 */
export interface AccountUsageSnapshotContext {
  readonly providerId: string;
  readonly modelId?: string;
  readonly nowMs: number;
}

export type AccountUsageSnapshotInput = AccountUsageSnapshot | QuotaStateRecord | QuotaSnapshotState;
export type AccountUsageSnapshotCollection = readonly AccountUsageSnapshotInput[] | ReadonlyMap<string, AccountUsageSnapshotInput>;
export type AccountUsageSnapshotProviderFunction = (
  accountIds: readonly string[],
  context: AccountUsageSnapshotContext,
) => Promise<AccountUsageSnapshotCollection>;

/**
 * Optional usage source for credential ranking. A provider failure is treated
 * as missing usage data and never makes an eligible pool unavailable.
 */
export interface AccountUsageProvider {
  getSnapshots(accountIds: readonly string[], context: AccountUsageSnapshotContext): Promise<AccountUsageSnapshotCollection>;
}

export type AccountUsageSnapshotProvider = AccountUsageProvider | AccountUsageSnapshotProviderFunction;


export interface QuotaStateStore {
  get(accountId: string): Promise<QuotaStateRecord | undefined>;
  set(record: QuotaStateRecord): Promise<void>;
  list(): Promise<readonly QuotaStateRecord[]>;
  /** Batch-load quota state for multiple accounts (single IN-clause query). */
  listForAccountIds(accountIds: readonly string[]): Promise<readonly QuotaStateRecord[]>;
}

export class MemoryQuotaStateStore implements QuotaStateStore {
  private readonly records = new Map<string, QuotaStateRecord>();

  async get(accountId: string): Promise<QuotaStateRecord | undefined> {
    return this.records.get(accountId);
  }

  async set(record: QuotaStateRecord): Promise<void> {
    this.records.set(record.accountId, record);
  }

  async list(): Promise<readonly QuotaStateRecord[]> {
    return [...this.records.values()];
  }

  async listForAccountIds(accountIds: readonly string[]): Promise<readonly QuotaStateRecord[]> {
    if (accountIds.length === 0) return [];
    const idSet = new Set(accountIds);
    return [...this.records.values()].filter((record) => idSet.has(record.accountId));
  }
}

/** Cached OAuth token view; token fields are secrets and must never be logged or exposed. */
export interface OAuthTokenRecord {
  readonly accessToken: string;
  readonly expiresAtMs: number | null;
  readonly refreshToken: string | null;
  readonly kind: "oauth";
  /** Monotonic generation used to reject stale cross-instance writes. */
  readonly generation?: number;
  /** Timestamp of the last successful refresh, used by provider stale-token policies. */
  readonly lastRefreshAtMs?: number | null;
  /** Timestamp of the last refresh attempt, including failures. */
  readonly lastRefreshAttemptAtMs?: number | null;
  /** Sanitized application error kind from the last refresh failure. */
  readonly lastRefreshErrorKind?: ApplicationErrorKind | null;
  /** HTTP status from the last refresh failure, when available. */
  readonly lastRefreshStatusCode?: number | null;
  /** Persistent state used to stop retrying revoked grants. */
  readonly refreshState?: "healthy" | "retrying" | "reauth_required";
  /** Earliest time a retrying refresh may call the provider again. */
  readonly refreshRetryAtMs?: number | null;
  /** Consecutive refresh failures since the last successful refresh. */
  readonly refreshFailureCount?: number;
}

/** Stable non-secret identity used for refresh-token compare-and-swap. */
export function fingerprintOAuthToken(token: OAuthTokenRecord | null): string {
  const value = token?.refreshToken ?? token?.accessToken ?? "";
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash.toString(16).padStart(8, "0");
}

/** Optional durable coordination hooks implemented by the SQLite token store. */
export interface OAuthTokenStore {
  get(accountId: string): Promise<OAuthTokenRecord | undefined>;
  set(accountId: string, token: OAuthTokenRecord): Promise<void>;
  delete(accountId: string): Promise<void>;
  tryAcquireRefreshLease?(input: {
    readonly accountId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly tokenFingerprint: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): Promise<boolean>;
  releaseRefreshLease?(accountId: string, ownerId: string): Promise<void>;
  compareAndSwap?(input: {
    readonly accountId: string;
    readonly expectedGeneration: number;
    readonly expectedTokenFingerprint: string;
    readonly token: OAuthTokenRecord;
  }): Promise<boolean>;
}

export class MemoryOAuthTokenStore implements OAuthTokenStore {
  private readonly tokens = new Map<string, OAuthTokenRecord>();
  private readonly leases = new Map<string, { readonly ownerId: string; readonly generation: number; readonly tokenFingerprint: string; readonly leaseUntilMs: number }>();

  async get(accountId: string): Promise<OAuthTokenRecord | undefined> {
    return this.tokens.get(accountId);
  }

  async set(accountId: string, token: OAuthTokenRecord): Promise<void> {
    this.tokens.set(accountId, token);
  }

  async delete(accountId: string): Promise<void> {
    this.tokens.delete(accountId);
    this.leases.delete(accountId);
  }

  async tryAcquireRefreshLease(input: { readonly accountId: string; readonly ownerId: string; readonly generation: number; readonly tokenFingerprint: string; readonly nowMs: number; readonly leaseMs: number }): Promise<boolean> {
    const existing = this.leases.get(input.accountId);
    if (existing !== undefined && existing.leaseUntilMs > input.nowMs && existing.ownerId !== input.ownerId) return false;
    this.leases.set(input.accountId, { ownerId: input.ownerId, generation: input.generation, tokenFingerprint: input.tokenFingerprint, leaseUntilMs: input.nowMs + input.leaseMs });
    return true;
  }

  async releaseRefreshLease(accountId: string, ownerId: string): Promise<void> {
    if (this.leases.get(accountId)?.ownerId === ownerId) this.leases.delete(accountId);
  }

  async compareAndSwap(input: { readonly accountId: string; readonly expectedGeneration: number; readonly expectedTokenFingerprint: string; readonly token: OAuthTokenRecord }): Promise<boolean> {
    const current = this.tokens.get(input.accountId);
    if (current === undefined || (current.generation ?? 0) !== input.expectedGeneration || fingerprintOAuthToken(current) !== input.expectedTokenFingerprint) return false;
    this.tokens.set(input.accountId, input.token);
    return true;
  }
}


/** Static account configuration: identity, credential kind, and secret (never logged). */
export interface AccountConfig {
  readonly id: string;
  readonly providerId: string;
  readonly kind: CredentialKind;
  readonly secret: string | null;
  readonly enabled: boolean;
  readonly priority: number;
}

export interface CredentialConfigStore {
  getAccount(id: string): Promise<AccountConfig | undefined>;
  listAccounts(): Promise<readonly AccountConfig[]>;
}

export interface CredentialConfigCacheOptions {
  readonly nowMs?: () => number;
  readonly ttlMs?: number;
  /** Optional mutation revision; a change clears all cached account views immediately. */
  readonly readRevision?: () => number;
}

/**
 * Adds a short-lived read cache for request-time account selection without
 * changing the durable store used by OAuth refresh and console mutations.
 */
export function createCachedCredentialConfigStore(
  store: CredentialConfigStore,
  options: CredentialConfigCacheOptions = {},
): CredentialConfigStore {
  const nowMs = options.nowMs ?? (() => Date.now());
  const ttlMs = Math.max(0, options.ttlMs ?? 250);
  const readRevision = options.readRevision ?? (() => 0);
  let cacheRevision = readRevision();
  const accounts = new Map<string, { readonly value: AccountConfig | undefined; readonly expiresAtMs: number }>();
  let listCache: { readonly value: readonly AccountConfig[]; readonly expiresAtMs: number } | undefined;
  const invalidateIfRevisionChanged = (): void => {
    const revision = readRevision();
    if (revision === cacheRevision) return;
    cacheRevision = revision;
    accounts.clear();
    listCache = undefined;
  };

  return {
    async getAccount(id) {
      invalidateIfRevisionChanged();
      const now = nowMs();
      const cached = accounts.get(id);
      if (cached !== undefined && cached.expiresAtMs > now) return cached.value;
      const value = await store.getAccount(id);
      accounts.set(id, { value, expiresAtMs: now + ttlMs });
      return value;
    },
    async listAccounts() {
      invalidateIfRevisionChanged();
      const now = nowMs();
      if (listCache !== undefined && listCache.expiresAtMs > now) return listCache.value;
      const value = await store.listAccounts();
      listCache = { value, expiresAtMs: now + ttlMs };
      for (const account of value) accounts.set(account.id, { value: account, expiresAtMs: now + ttlMs });
      return value;
    },
  };
}

import { accountCooldownPolicyFor, cooldownDelayMs, deriveRouteHealth, isRecordUsable } from "../../traffic";

export interface AccountHealthOptions {
  readonly nowMs?: () => number;
  readonly cacheTtlMs?: number;
}

/**
 * Bounded, per-account health state, independent from proxy health.
 *
 * Only retryable failures are recorded (non-retryable semantic errors do not
 * rotate the account). Cooldown follows the shared policy:
 *
 *   - T1 known rate-limit  → 5 min cap, 30s for per-minute "too many requests"
 *   - T1 known quota       → 5 min cap (was 24h)
 *   - T1 model capacity    → 45-75s w/ jitter
 *   - T2 transient (5xx,   → NO cooldown — status = "error" (still eligible)
 *     network, stream,       The recovery loop retries; we don't poison the
 *     protocol, unknown)     account for a blip that's likely still working.
 *   - Auth failure         → 2s exponential backoff, 5 min cap
 *
 * Records carry only bounded, sanitized messages — never secrets.
 */
export class AccountHealthManager {
  private readonly nowMs: () => number;
  private readonly cacheTtlMs: number;
  private readonly healthCache = new Map<string, { readonly record: AccountHealthRecord | undefined; readonly expiresAtMs: number }>();
  private readonly modelLocksCache = new Map<string, { readonly records: readonly ModelLockRecord[]; readonly expiresAtMs: number }>();

  constructor(
    private readonly store: AccountHealthStore,
    options: AccountHealthOptions = {},
    private readonly modelLockStore: ModelLockStore | null = null,
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 250);
  }

  private async readHealthRecord(accountId: string, nowMs: number): Promise<AccountHealthRecord | undefined> {
    const cached = this.healthCache.get(accountId);
    if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.record;
    const record = await this.store.get(accountId);
    this.healthCache.set(accountId, { record, expiresAtMs: nowMs + this.cacheTtlMs });
    return record;
  }

  private async readHealthRecords(accountIds: readonly string[], nowMs: number): Promise<Map<string, AccountHealthRecord>> {
    const missingIds = accountIds.filter((accountId) => {
      const cached = this.healthCache.get(accountId);
      return cached === undefined || cached.expiresAtMs <= nowMs;
    });
    if (missingIds.length > 0) {
      const records = await this.store.listForAccountIds(missingIds);
      const byId = new Map(records.map((record) => [record.accountId, record]));
      for (const accountId of missingIds) {
        this.healthCache.set(accountId, { record: byId.get(accountId), expiresAtMs: nowMs + this.cacheTtlMs });
      }
    }
    const result = new Map<string, AccountHealthRecord>();
    for (const accountId of accountIds) {
      const record = this.healthCache.get(accountId)?.record;
      if (record !== undefined) result.set(accountId, record);
    }
    return result;
  }

  private async readModelLocks(accountId: string, nowMs: number): Promise<readonly ModelLockRecord[]> {
    if (this.modelLockStore === null) return [];
    const cached = this.modelLocksCache.get(accountId);
    if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.records;
    const records = await this.modelLockStore.listForAccount(accountId);
    this.modelLocksCache.set(accountId, { records, expiresAtMs: nowMs + this.cacheTtlMs });
    return records;
  }

  async recordFailure(accountId: string, providerId: string, error: ProviderCallError): Promise<AccountHealthRecord | null> {
    if (!error.retryable) return null;
    const now = this.nowMs();
    const previous = await this.readHealthRecord(accountId, now);
    const failureCount = Math.min(255, (previous?.failureCount ?? 0) + 1);
    const delayMs = cooldownDelayMs(error, accountCooldownPolicyFor(error.kind), failureCount, now);
    const disabledUntilMs = delayMs > 0 ? now + delayMs : null;
    const record: AccountHealthRecord = {
      accountId,
      providerId,
      status: disabledUntilMs !== null ? "cooling_down" : "error",
      statusCode: error.statusCode,
      failureKind: error.kind,
      sanitizedMessage: sanitizeMessage(error.sanitizedMessage),
      occurredAt: new Date(now).toISOString(),
      retryAt: disabledUntilMs !== null ? new Date(disabledUntilMs).toISOString() : null,
      disabledUntilMs,
      failureCount,
      generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    this.healthCache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
    return record;
  }
  /** Marks a credential permanently unusable until an explicit OAuth reauthentication succeeds. */
  async recordPermanentFailure(accountId: string, providerId: string, error: ProviderCallError): Promise<AccountHealthRecord | null> {
    const now = this.nowMs();
    const previous = await this.readHealthRecord(accountId, now);
    const record: AccountHealthRecord = {
      accountId,
      providerId,
      status: "disabled",
      statusCode: error.statusCode,
      failureKind: error.kind,
      sanitizedMessage: sanitizeMessage(error.sanitizedMessage),
      occurredAt: new Date(now).toISOString(),
      retryAt: null,
      disabledUntilMs: null,
      failureCount: Math.min(255, (previous?.failureCount ?? 0) + 1),
      generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    this.healthCache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
    return record;
  }

  async recordSuccess(accountId: string, providerId: string): Promise<AccountHealthRecord> {
    const now = this.nowMs();
    const previous = await this.readHealthRecord(accountId, now);
    const record: AccountHealthRecord = {
      accountId,
      providerId,
      status: "healthy",
      statusCode: null,
      failureKind: null,
      sanitizedMessage: null,
      occurredAt: null,
      retryAt: null,
      disabledUntilMs: null,
      failureCount: 0,
      generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    this.healthCache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
    return record;
  }

  async getHealth(accountId: string): Promise<RouteHealth | null> {
    const record = await this.readHealthRecord(accountId, this.nowMs());
    return record === undefined ? null : deriveRouteHealth(record, "account", this.nowMs());
  }

  async isUsable(accountId: string, nowMs: number = this.nowMs()): Promise<boolean> {
    const record = await this.readHealthRecord(accountId, nowMs);
    return record === undefined || isRecordUsable(record, nowMs);
  }

  async list(): Promise<readonly AccountHealthRecord[]> {
    return this.store.list();
  }

  async recordModelLock(accountId: string, modelId: string, error: ProviderCallError): Promise<ModelLockRecord | null> {
    if (this.modelLockStore === null || !error.retryable) return null;
    const now = this.nowMs();
    const previous = (await this.readModelLocks(accountId, now)).find((record) => record.modelId === modelId);
    const failureCount = Math.min(255, (previous?.failureCount ?? 0) + 1);
    const delayMs = cooldownDelayMs(error, accountCooldownPolicyFor(error.kind), failureCount, now);
    if (delayMs === 0) return null;
    const record: ModelLockRecord = {
      accountId,
      modelId,
      retryAt: new Date(now + delayMs).toISOString(),
      errorKind: error.kind,
      statusCode: error.statusCode,
      sanitizedMessage: sanitizeMessage(error.sanitizedMessage),
      failureCount,
    };
    await this.modelLockStore.set(record);
    const current = (await this.readModelLocks(accountId, now)).filter((item) => item.modelId !== modelId);
    this.modelLocksCache.set(accountId, { records: [...current, record], expiresAtMs: now + this.cacheTtlMs });
    return record;
  }

  /** Clears a per-model lock on success — the model is working again. */
  async clearModelLock(accountId: string, modelId: string): Promise<void> {
    if (this.modelLockStore === null) return;
    await this.modelLockStore.delete(accountId, modelId);
    const now = this.nowMs();
    const cached = this.modelLocksCache.get(accountId);
    if (cached !== undefined && cached.expiresAtMs > now) {
      this.modelLocksCache.set(accountId, { records: cached.records.filter((record) => record.modelId !== modelId), expiresAtMs: cached.expiresAtMs });
    }
  }

  async isModelAvailable(accountId: string, modelId: string, nowMs: number = this.nowMs()): Promise<boolean> {
    const lock = (await this.readModelLocks(accountId, nowMs)).find((record) => record.modelId === modelId);
    return lock === undefined || Date.parse(lock.retryAt) <= nowMs;
  }

  async listModelLocksForAccount(accountId: string): Promise<readonly ModelLockRecord[]> {
    return this.readModelLocks(accountId, this.nowMs());
  }

  async getHealthBatch(accountIds: readonly string[]): Promise<Map<string, RouteHealth>> {
    if (accountIds.length === 0) return new Map();
    const records = await this.readHealthRecords(accountIds, this.nowMs());
    const now = this.nowMs();
    const map = new Map<string, RouteHealth>();
    for (const record of records.values()) map.set(record.accountId, deriveRouteHealth(record, "account", now));
    return map;
  }

  async listModelLocksForAccounts(accountIds: readonly string[]): Promise<Map<string, readonly ModelLockRecord[]>> {
    if (this.modelLockStore === null || accountIds.length === 0) return new Map();
    const now = this.nowMs();
    const missingIds = accountIds.filter((accountId) => {
      const cached = this.modelLocksCache.get(accountId);
      return cached === undefined || cached.expiresAtMs <= now;
    });
    if (missingIds.length > 0) {
      const allLocks = await this.modelLockStore.listForAccountIds(missingIds);
      const grouped = new Map<string, ModelLockRecord[]>();
      for (const lock of allLocks) {
        const list = grouped.get(lock.accountId);
        if (list === undefined) grouped.set(lock.accountId, [lock]);
        else list.push(lock);
      }
      for (const accountId of missingIds) this.modelLocksCache.set(accountId, { records: grouped.get(accountId) ?? [], expiresAtMs: now + this.cacheTtlMs });
    }
    const result = new Map<string, readonly ModelLockRecord[]>();
    for (const accountId of accountIds) {
      const records = this.modelLocksCache.get(accountId)?.records;
      if (records !== undefined && records.length > 0) result.set(accountId, records);
    }
    return result;
  }
}


export const OAUTH_SAFETY_SKEW_MS = 30_000;

export interface OAuthRefresher {
  refresh(input: { readonly accountId: string; readonly token: OAuthTokenRecord | null; readonly account?: AccountConfig }): Promise<OAuthRefreshResult>;
}

/** Result-typed refresh surface so failures always map to application errors. */
export type OAuthRefreshResult =
  | { readonly ok: true; readonly token: OAuthTokenRecord }
  | { readonly ok: false; readonly error: ProviderCallError };

export const QUOTA_SWEEP_COOLDOWN_MS = 15 * 60_000;

export interface QuotaRefresher {
  refreshQuota(accountId: string): Promise<boolean>;
}

export interface QuotaSweepResult {
  readonly refreshed: boolean;
  readonly quotaAvailable: boolean;
  readonly nextRefreshAtMs: number | null;
}

export interface QuotaCoordinatorOptions {
  readonly sweepCooldownMs?: number;
  readonly nowMs?: () => number;
  readonly cacheTtlMs?: number;
}

/**
 * Cooldown-protected quota state and account-level request coalescing.
 * OAuth refresh is coordinated by TokenRefreshPool before quota fetches.
 */
export class QuotaCoordinator {
  private readonly sweepCooldownMs: number;
  private readonly nowMs: () => number;
  private readonly cacheTtlMs: number;
  private readonly inflight = new Map<string, Promise<QuotaSweepResult>>();
  private readonly cache = new Map<string, { readonly record: QuotaStateRecord | undefined; readonly expiresAtMs: number }>();

  constructor(
    private readonly store: QuotaStateStore,
    options: QuotaCoordinatorOptions = {},
  ) {
    this.sweepCooldownMs = options.sweepCooldownMs ?? QUOTA_SWEEP_COOLDOWN_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 1_000);
  }

  private async readRecord(accountId: string, nowMs: number): Promise<QuotaStateRecord | undefined> {
    const cached = this.cache.get(accountId);
    if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.record;
    const record = await this.store.get(accountId);
    this.cache.set(accountId, { record, expiresAtMs: nowMs + this.cacheTtlMs });
    return record;
  }

  private async readRecords(accountIds: readonly string[], nowMs: number): Promise<Map<string, QuotaStateRecord>> {
    const missingIds = accountIds.filter((accountId) => {
      const cached = this.cache.get(accountId);
      return cached === undefined || cached.expiresAtMs <= nowMs;
    });
    if (missingIds.length > 0) {
      const records = await this.store.listForAccountIds(missingIds);
      const byId = new Map(records.map((record) => [record.accountId, record]));
      for (const accountId of missingIds) {
        this.cache.set(accountId, { record: byId.get(accountId), expiresAtMs: nowMs + this.cacheTtlMs });
      }
    }
    const result = new Map<string, QuotaStateRecord>();
    for (const accountId of accountIds) {
      const record = this.cache.get(accountId)?.record;
      if (record !== undefined) result.set(accountId, record);
    }
    return result;
  }

  async getQuotaAvailable(accountId: string): Promise<boolean> {
    return (await this.readRecord(accountId, this.nowMs()))?.quotaAvailable ?? true;
  }

  async getQuotaAvailableBatch(accountIds: readonly string[]): Promise<Map<string, boolean>> {
    if (accountIds.length === 0) return new Map();
    const records = await this.readRecords(accountIds, this.nowMs());
    const map = new Map<string, boolean>();
    for (const record of records.values()) map.set(record.accountId, record.quotaAvailable);
    return map;
  }

  async refreshQuotaIfDue(accountId: string, refresh: QuotaRefresher["refreshQuota"]): Promise<QuotaSweepResult> {
    const now = this.nowMs();
    const record = await this.readRecord(accountId, now);
    const lastRefreshAtMs = record?.lastQuotaRefreshAtMs ?? null;
    if (lastRefreshAtMs !== null && now - lastRefreshAtMs < this.sweepCooldownMs) {
      return {
        refreshed: false,
        quotaAvailable: record?.quotaAvailable ?? true,
        nextRefreshAtMs: lastRefreshAtMs + this.sweepCooldownMs,
      };
    }
    const inflight = this.inflight.get(accountId);
    if (inflight !== undefined) return inflight;
    const pending = this.performRefresh(accountId, refresh);
    this.inflight.set(accountId, pending);
    pending.then(
      () => this.inflight.delete(accountId),
      () => this.inflight.delete(accountId),
    );
    return pending;
  }

  async setQuotaAvailable(accountId: string, quotaAvailable: boolean): Promise<void> {
    const now = this.nowMs();
    const previous = await this.readRecord(accountId, now);
    const record: QuotaStateRecord = {
      accountId,
      quotaAvailable,
      lastQuotaRefreshAtMs: previous?.lastQuotaRefreshAtMs ?? null,
    };
    await this.store.set(record);
    this.cache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
  }

  private async performRefresh(accountId: string, refresh: QuotaRefresher["refreshQuota"]): Promise<QuotaSweepResult> {
    const quotaAvailable = await refresh(accountId);
    const now = this.nowMs();
    const record: QuotaStateRecord = { accountId, quotaAvailable, lastQuotaRefreshAtMs: now };
    await this.store.set(record);
    this.cache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
    return { refreshed: true, quotaAvailable, nextRefreshAtMs: now + this.sweepCooldownMs };
  }
}

export type CredentialSelectionReason = "preferred" | "healthy" | "sole" | "fallback" | "usage_headroom";

export interface CredentialSelectionResult {
  readonly selection: CredentialSelection;
  readonly account: AccountCandidate;
  readonly reason: CredentialSelectionReason;
}

export type CredentialSelectionStrategy = "priority" | "round-robin";

export interface SelectCredentialInput {
  readonly providerId: string;
  readonly candidates: readonly AccountCandidate[];
  readonly preferredAccountId?: string | null;
  readonly strategy?: CredentialSelectionStrategy;
  readonly affinityKey?: string | null;
  readonly stickyLimit?: number;
  readonly nowMs?: number;
  /** When provided, candidates with an active per-model lock for this model are excluded. */
  readonly modelId?: string;
  /** Optional usage snapshots keyed by account id; quota records are accepted directly. */
  readonly usageSnapshots?: AccountUsageSnapshotCollection;
  /** Optional bounded usage source. Provider errors fall back to deterministic ranking. */
  readonly usageSnapshotProvider?: AccountUsageSnapshotProvider;
  /** Maximum age for a snapshot to participate in ranking. */
  readonly usageSnapshotTtlMs?: number;
  /** Provider deadline, bounded to a small in-process timeout. */
  readonly usageSnapshotTimeoutMs?: number;
}

/**
 * A candidate is eligible when it is enabled, has quota, and is not currently
 * cooling down (auto-restored once its bounded retry time has passed). When a
 * `modelId` is provided, also checks that no per-model lock is active — an
 * error on model A does NOT block model B on the same account.
 */
export function isAccountEligible(candidate: AccountCandidate, nowMs: number, modelId?: string): boolean {
  if (!candidate.enabled || !candidate.quotaAvailable) return false;
  const health = candidate.health;
  if (health === null) {
    // Still must check per-model lock even when account health is null/healthy.
    if (modelId !== undefined && candidate.modelLocks !== null) {
      const lock = candidate.modelLocks.get(modelId);
      if (lock !== undefined && Date.parse(lock.retryAt) > nowMs) return false;
    }
    return true;
  }
  if (health.status === "disabled") return false;
  // "error" and "cooling_down" accounts are still eligible — the routing
  // layer will try them as a last resort and the cooldown system handles
  // backoff. Only "disabled" (explicit user action) truly blocks routing.
  if (health.status === "cooling_down") {
    if (health.retryAt === null) return false;
    const retryAt = Date.parse(health.retryAt);
    if (!(Number.isFinite(retryAt) && nowMs >= retryAt)) return false;
  }
  // Per-model lock: when a modelId is provided, a lock whose retry_at has
  // not yet passed makes this candidate ineligible for that specific model.
  if (modelId !== undefined && candidate.modelLocks !== null) {
    const lock = candidate.modelLocks.get(modelId);
    if (lock !== undefined && Date.parse(lock.retryAt) > nowMs) return false;
  }
  return true;
}

/** Deterministic credential-pool ordering: eligible first, preferred first within eligible, then id. */
export function rankAccountCandidates(
  candidates: readonly AccountCandidate[],
  preferredAccountId: string | null = null,
  nowMs: number = Date.now(),
  modelId?: string,
): readonly AccountCandidate[] {
  return [...candidates].sort((a, b) => {
    const eligibleDiff = Number(isAccountEligible(b, nowMs, modelId)) - Number(isAccountEligible(a, nowMs, modelId));
    if (eligibleDiff !== 0) return eligibleDiff;
    // Preferred account sorts first among eligible records (docstring contract).
    const preferredDiff = Number(b.id === preferredAccountId) - Number(a.id === preferredAccountId);
    if (preferredDiff !== 0) return preferredDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Credential selection and leasing.
 *
 * Picks the first eligible candidate, then acquires the credential: static
 * secrets come from the injected CredentialConfigStore (env-backed for Wave
 * A), OAuth tokens come from the central TokenRefreshPool as a refcounted lease.
 * Returns the application-typed CredentialSelection; every selection carries a
 * leaseId released exactly once via `release()`.
 *
 * Returns null when no candidate is eligible (the caller maps that to
 * credentialUnavailableError under its own retry policy). Missing/disabled
 * config and refresh failures surface as application ProviderCallError values.
 */
function stableCredentialHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const DEFAULT_USAGE_SNAPSHOT_TTL_MS = 5 * 60_000;
const DEFAULT_USAGE_SNAPSHOT_TIMEOUT_MS = 250;
const MAX_USAGE_SNAPSHOT_ACCOUNTS = 100;

interface UsageProviderCacheState {
  readonly snapshots: Map<string, AccountUsageSnapshot>;
  readonly inflight: Map<string, Promise<readonly AccountUsageSnapshot[]>>;
}

function parseFiniteDate(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedFraction(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value));
}

function normalizeQuotaSnapshot(
  accountId: string,
  providerId: string,
  modelId: string | undefined,
  quota: QuotaSnapshotState,
  fallbackFetchedAtMs: number | null = null,
): AccountUsageSnapshot {
  const remaining = quota.windows
    .map((window) => window.remainingPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .map((value) => boundedFraction(value / 100))
    .filter((value): value is number => value !== null);
  const resets = quota.windows
    .map((window) => parseFiniteDate(window.resetsAt))
    .filter((value): value is number => value !== null);
  const fetchedAtMs = parseFiniteDate(quota.fetchedAt) ?? parseFiniteDate(quota.lastSuccessAt) ?? fallbackFetchedAtMs ?? Number.NaN;
  return {
    accountId,
    providerId,
    ...(modelId === undefined ? {} : { modelId }),
    remainingFraction: remaining.length === 0 ? null : Math.min(...remaining),
    resetAtMs: resets.length === 0 ? null : Math.min(...resets),
    fetchedAtMs,
    stale: quota.status !== "ready" || quota.error !== null,
  };
}

function normalizeUsageValue(
  accountId: string,
  providerId: string,
  modelId: string | undefined,
  value: AccountUsageSnapshotInput,
): AccountUsageSnapshot | undefined {
  if ("remainingFraction" in value && "fetchedAtMs" in value) {
    if (value.accountId !== accountId || value.providerId !== providerId) return undefined;
    if (value.modelId !== undefined && value.modelId !== modelId) return undefined;
    return { ...value, remainingFraction: boundedFraction(value.remainingFraction) };
  }
  if ("quotaAvailable" in value) {
    if (value.quota === null || value.quota === undefined) return undefined;
    return normalizeQuotaSnapshot(accountId, providerId, modelId, value.quota, value.lastQuotaSuccessAtMs ?? null);
  }
  return normalizeQuotaSnapshot(accountId, providerId, modelId, value);
}

function normalizeUsageCollection(
  collection: AccountUsageSnapshotCollection,
  providerId: string,
  modelId: string | undefined,
): Map<string, AccountUsageSnapshot> {
  const snapshots = new Map<string, AccountUsageSnapshot>();
  if (!("get" in collection)) {
    for (const value of collection) {
      if (!("accountId" in value)) continue;
      const normalized = normalizeUsageValue(value.accountId, providerId, modelId, value);
      if (normalized !== undefined) snapshots.set(normalized.accountId, normalized);
    }
    return snapshots;
  }
  for (const [accountId, value] of collection) {
    const normalized = normalizeUsageValue(accountId, providerId, modelId, value);
    if (normalized !== undefined) snapshots.set(accountId, normalized);
  }
  return snapshots;
}

function isFreshUsageSnapshot(snapshot: AccountUsageSnapshot, nowMs: number, ttlMs: number): boolean {
  if (snapshot.stale || !Number.isFinite(snapshot.fetchedAtMs)) return false;
  const ageMs = nowMs - snapshot.fetchedAtMs;
  return ageMs >= 0 && ageMs <= ttlMs && (snapshot.remainingFraction !== null || snapshot.resetAtMs !== null);
}

function compareUsageSnapshots(left: AccountUsageSnapshot, right: AccountUsageSnapshot): number {
  if (left.remainingFraction !== null || right.remainingFraction !== null) {
    if (left.remainingFraction === null) return 1;
    if (right.remainingFraction === null) return -1;
    if (left.remainingFraction !== right.remainingFraction) return right.remainingFraction - left.remainingFraction;
  }
  if (left.resetAtMs !== null || right.resetAtMs !== null) {
    if (left.resetAtMs === null) return 1;
    if (right.resetAtMs === null) return -1;
    if (left.resetAtMs !== right.resetAtMs) return left.resetAtMs - right.resetAtMs;
  }
  return 0;
}

function rankWithUsage(
  candidates: readonly AccountCandidate[],
  preferredAccountId: string | null,
  snapshots: ReadonlyMap<string, AccountUsageSnapshot>,
  nowMs: number,
  ttlMs: number,
): { readonly candidates: readonly AccountCandidate[]; readonly applied: boolean } {
  const fresh = new Map<string, AccountUsageSnapshot>();
  for (const candidate of candidates) {
    const snapshot = snapshots.get(candidate.id);
    if (snapshot !== undefined && isFreshUsageSnapshot(snapshot, nowMs, ttlMs)) fresh.set(candidate.id, snapshot);
  }
  if (fresh.size === 0) return { candidates, applied: false };
  const preferred = candidates.find((candidate) => candidate.id === preferredAccountId);
  const usageCandidates = preferred === undefined ? candidates : candidates.filter((candidate) => candidate.id !== preferred.id);
  const ranked = [...usageCandidates].sort((left, right) => {
    const leftSnapshot = fresh.get(left.id);
    const rightSnapshot = fresh.get(right.id);
    if (leftSnapshot === undefined || rightSnapshot === undefined) return leftSnapshot === rightSnapshot ? 0 : leftSnapshot === undefined ? 1 : -1;
    return compareUsageSnapshots(leftSnapshot, rightSnapshot);
  });
  return { candidates: preferred === undefined ? ranked : [preferred, ...ranked], applied: true };
}


async function callUsageProvider(
  provider: AccountUsageSnapshotProvider,
  accountIds: readonly string[],
  context: AccountUsageSnapshotContext,
): Promise<AccountUsageSnapshotCollection> {
  return typeof provider === "function"
    ? provider(accountIds, context)
    : provider.getSnapshots(accountIds, context);
}

async function withUsageTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let rejectTimeout: (reason: Error) => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => rejectTimeout(new Error("usage snapshot timeout")), timeoutMs);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class CredentialSelector {
  private readonly leases = new Map<string, { readonly accountId: string; readonly release: () => boolean }>();
  private readonly roundRobinCursor = new Map<string, number>();
  private readonly inFlightByAccount = new Map<string, number>();

  private readonly usageProviderStates = new WeakMap<object, UsageProviderCacheState>();
  constructor(
    private readonly config: CredentialConfigStore,
    private readonly oauth: TokenRefreshPool,
  ) {}
  private getUsageProviderState(provider: AccountUsageSnapshotProvider): UsageProviderCacheState {
    let state = this.usageProviderStates.get(provider);
    if (state === undefined) {
      state = { snapshots: new Map(), inflight: new Map() };
      this.usageProviderStates.set(provider, state);
    }
    return state;
  }

  private async resolveUsageSnapshots(
    input: SelectCredentialInput,
    accountIds: readonly string[],
    nowMs: number,
  ): Promise<Map<string, AccountUsageSnapshot>> {
    if (input.usageSnapshots !== undefined) {
      return normalizeUsageCollection(input.usageSnapshots, input.providerId, input.modelId);
    }
    const provider = input.usageSnapshotProvider;
    if (provider === undefined || accountIds.length === 0) return new Map();
    const boundedIds = [...new Set(accountIds)].slice(0, MAX_USAGE_SNAPSHOT_ACCOUNTS);
    const context: AccountUsageSnapshotContext = { providerId: input.providerId, ...(input.modelId === undefined ? {} : { modelId: input.modelId }), nowMs };
    const state = this.getUsageProviderState(provider);
    const providerKey = `${input.providerId}:${input.modelId ?? ""}`;
    let pending = state.inflight.get(providerKey);
    if (pending === undefined) {
      const timeoutMs = Math.max(1, Math.min(5_000, Math.round(input.usageSnapshotTimeoutMs ?? DEFAULT_USAGE_SNAPSHOT_TIMEOUT_MS)));
      pending = withUsageTimeout(callUsageProvider(provider, boundedIds, context), timeoutMs)
        .then((collection) => [...normalizeUsageCollection(collection, input.providerId, input.modelId).values()])
        .catch(() => [])
        .then((snapshots) => {
          for (const snapshot of snapshots) state.snapshots.set(`${providerKey}:${snapshot.accountId}`, snapshot);
          return snapshots;
        })
        .finally(() => state.inflight.delete(providerKey));
      state.inflight.set(providerKey, pending);
    }
    const fetched = await pending;
    const result = new Map(fetched.map((snapshot) => [snapshot.accountId, snapshot]));
    for (const accountId of boundedIds) {
      if (result.has(accountId)) continue;
      const cached = state.snapshots.get(`${providerKey}:${accountId}`);
      if (cached !== undefined) result.set(accountId, cached);
    }
    return result;
  }


  private getInFlight(accountId: string): number {
    return this.inFlightByAccount.get(accountId) ?? 0;
  }

  trackSelection(accountId: string): void {
    this.inFlightByAccount.set(accountId, this.getInFlight(accountId) + 1);
  }

  trackRelease(accountId: string): void {
    const next = this.getInFlight(accountId) - 1;
    if (next > 0) this.inFlightByAccount.set(accountId, next);
    else this.inFlightByAccount.delete(accountId);
  }

  async select(input: SelectCredentialInput): Promise<CredentialSelectionResult | null> {
    const now = input.nowMs ?? Date.now();
    const ranked = rankAccountCandidates(input.candidates, input.preferredAccountId ?? null, now, input.modelId);
    const eligible = ranked.filter((candidate) => isAccountEligible(candidate, now, input.modelId));
    const stickyLimit = input.stickyLimit === undefined ? 0 : Math.max(1, Math.min(100, Math.round(input.stickyLimit)));
    const hasStickyAffinity = stickyLimit > 0 && input.affinityKey !== undefined && input.affinityKey !== null && eligible.length >= stickyLimit;
    const usageRanking = hasStickyAffinity
      ? { candidates: eligible, applied: false }
      : rankWithUsage(
        eligible,
        input.preferredAccountId ?? null,
        await this.resolveUsageSnapshots(input, eligible.map((candidate) => candidate.id), now),
        now,
        Math.max(0, Math.min(24 * 60 * 60_000, Math.round(input.usageSnapshotTtlMs ?? DEFAULT_USAGE_SNAPSHOT_TTL_MS))),
      );
    const selectionCandidates = usageRanking.candidates;
    // A cache-affine request must stay on one deterministic credential. Round-robin
    // still balances different affinity keys, but rotating one key per request
    // destroys the provider-side prompt cache it is trying to reuse.
    const stickyPool = hasStickyAffinity
      ? Array.from({ length: stickyLimit }, (_, offset) => eligible[(stableCredentialHash(`${input.affinityKey}:${input.providerId}`) + offset) % eligible.length]).filter((candidate): candidate is AccountCandidate => candidate !== undefined)
      : selectionCandidates;

    let chosen: AccountCandidate | undefined;
    if (hasStickyAffinity) {
      chosen = stickyPool[0];
    } else if (input.strategy === "round-robin" && stickyPool.length > 1) {
      // In-flight aware round-robin for non-affine traffic.
      const cursor = this.roundRobinCursor.get(input.providerId) ?? 0;
      const idle = stickyPool.filter((c) => this.getInFlight(c.id) === 0);
      const pool = idle.length > 0 ? idle : stickyPool;
      chosen = pool[cursor % pool.length];
      if (chosen !== undefined) {
        this.roundRobinCursor.set(input.providerId, (cursor + 1) % pool.length);
      }
    } else {
      // Priority strategy: pick the first eligible (lowest priority number).
      // Still prefer idle accounts among the eligible set.
      const idle = selectionCandidates.filter((c) => this.getInFlight(c.id) === 0);
      chosen = idle.length > 0 ? idle[0] : selectionCandidates[0];
    }
    if (chosen === undefined) return null;

    const accountConfig = await this.config.getAccount(chosen.id);
    if (accountConfig === undefined) {
      throw createProviderError("credential_unavailable", `Account ${chosen.id} has no credential configuration`, { retryable: false, routeScope: "account" });
    }
    if (!accountConfig.enabled) {
      throw createProviderError("credential_unavailable", `Account ${chosen.id} is disabled`, { retryable: false, routeScope: "account" });
    }

    let secret: string;
    let releaseLease: (() => boolean) | null = null;
    if (accountConfig.kind === "oauth") {
      const lease = await this.oauth.lease(chosen.id);
      // The stored credential bundle carries provider metadata (projectId,
      // region, orgId, etc.) that adapters need at dispatch time — e.g.
      // Antigravity's parseAntigravityCredential expects {"accessToken",
      // "projectId"}. Swapping the stale access token for the fresh lease
      // token preserves that metadata without provider-specific logic here.
      secret = withFreshAccessToken(accountConfig.secret, lease.token.accessToken);
      releaseLease = () => this.oauth.releaseLease(lease.leaseId);
    } else {
      const configuredSecret = accountConfig.secret;
      if (configuredSecret === null || configuredSecret.length === 0) {
        throw createProviderError("credential_unavailable", `Account ${chosen.id} has no secret configured`, { retryable: false, routeScope: "account" });
      }
      secret = configuredSecret;
    }

    const leaseId = crypto.randomUUID();
    this.leases.set(leaseId, { accountId: chosen.id, release: releaseLease ?? (() => true) });
    // Track in-flight for load-aware round-robin (etteum-pool pattern).
    // Incremented on select, decremented on release.
    this.trackSelection(chosen.id);

    const reason: CredentialSelectionReason =
      chosen.id === input.preferredAccountId
        ? "preferred"
        : ranked.length === 1
          ? "sole"
          : input.preferredAccountId !== undefined && input.preferredAccountId !== null
            ? "fallback"
            : usageRanking.applied
              ? "usage_headroom"
              : "healthy";

    return {
      selection: { accountId: chosen.id, kind: accountConfig.kind, leaseId, secret },
      account: chosen,
      reason,
    };
  }

  /** Forces the shared OAuth coordinator to refresh one account. */
  async forceRefresh(accountId: string): Promise<OAuthTokenRecord> {
    return this.oauth.forceRefresh(accountId);
  }

  /** Releases the credential lease exactly once; safe for unknown or already-released ids. */
  async release(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return;
    this.leases.delete(leaseId);
    lease.release();
    this.trackRelease(lease.accountId);
  }
}

export function credentialUnavailableError(providerId: string, retryAt: string | null = null): ProviderCallError {
  return createProviderError("credential_unavailable", `No eligible account available for provider ${providerId}`, {
    retryable: true,
    routeScope: "account",
    retryAt,
  });
}

/**
 * Swaps the `accessToken` inside a stored OAuth credential bundle JSON for
 * a freshly leased token, preserving all other provider metadata (projectId,
 * region, orgId, etc.). Falls back to the bare fresh token when the stored
 * secret is not a JSON bundle or does not contain an `accessToken` field.
 */
function withFreshAccessToken(storedSecret: string | null, freshAccessToken: string): string {
  if (storedSecret === null || storedSecret.length === 0 || !storedSecret.startsWith("{")) {
    return freshAccessToken;
  }
  try {
    const parsed = JSON.parse(storedSecret) as Record<string, unknown>;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
      return freshAccessToken;
    }
    parsed.accessToken = freshAccessToken;
    return JSON.stringify(parsed);
  } catch {
    return freshAccessToken;
  }
}
