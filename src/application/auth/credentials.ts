import { sanitizeMessage, type ApplicationErrorKind, type AccountCandidate, type CredentialKind, type CredentialSelection, type ModelLockRecord, type ProviderCallError, type RouteHealth, type RouteStatus } from "../contracts";
import { makeProviderError } from "../../traffic";
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

/** Cached OAuth token view; the access token is a secret and must never be logged or exposed. */
export interface OAuthTokenRecord {
  readonly accessToken: string;
  readonly expiresAtMs: number | null;
  readonly refreshToken: string | null;
  readonly kind: "oauth";
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
}

export interface OAuthTokenStore {
  get(accountId: string): Promise<OAuthTokenRecord | undefined>;
  set(accountId: string, token: OAuthTokenRecord): Promise<void>;
  delete(accountId: string): Promise<void>;
}

export class MemoryOAuthTokenStore implements OAuthTokenStore {
  private readonly tokens = new Map<string, OAuthTokenRecord>();

  async get(accountId: string): Promise<OAuthTokenRecord | undefined> {
    return this.tokens.get(accountId);
  }

  async set(accountId: string, token: OAuthTokenRecord): Promise<void> {
    this.tokens.set(accountId, token);
  }

  async delete(accountId: string): Promise<void> {
    this.tokens.delete(accountId);
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

import { accountCooldownPolicyFor, cooldownDelayMs, deriveRouteHealth, isRecordUsable } from "../../traffic";

export interface AccountHealthOptions {
  readonly nowMs?: () => number;
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

  constructor(
    private readonly store: AccountHealthStore,
    options: AccountHealthOptions = {},
    private readonly modelLockStore: ModelLockStore | null = null,
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async recordFailure(accountId: string, providerId: string, error: ProviderCallError): Promise<AccountHealthRecord | null> {
    if (!error.retryable) return null;
    const now = this.nowMs();
    const previous = await this.store.get(accountId);
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
    return record;
  }

  async recordSuccess(accountId: string, providerId: string): Promise<AccountHealthRecord> {
    const previous = await this.store.get(accountId);
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
    return record;
  }

  async getHealth(accountId: string): Promise<RouteHealth | null> {
    const record = await this.store.get(accountId);
    return record === undefined ? null : deriveRouteHealth(record, "account", this.nowMs());
  }

  async isUsable(accountId: string, nowMs: number = this.nowMs()): Promise<boolean> {
    const record = await this.store.get(accountId);
    return record === undefined || isRecordUsable(record, nowMs);
  }

  async list(): Promise<readonly AccountHealthRecord[]> {
    return this.store.list();
  }

  /**
   * Records a per-model lock so an error on model A (e.g. claude/sonnet-4)
   * does NOT block model B (e.g. claude/haiku-4) on the same account. Uses
   * the same cooldown logic as recordFailure (cooldownDelayMs), but stores
   * in the ModelLockStore instead of AccountHealthStore.
   *
   * - If `error.retryable === false`, skip (non-retryable = no model lock).
   * - If delayMs === 0 (T2 transient error → no cooldown), skip.
   * - Returns the stored record, or null when skipped.
   */
  async recordModelLock(accountId: string, modelId: string, error: ProviderCallError): Promise<ModelLockRecord | null> {
    if (this.modelLockStore === null) return null;
    if (!error.retryable) return null;
    const now = this.nowMs();
    const previous = await this.modelLockStore.get(accountId, modelId);
    const failureCount = Math.min(255, (previous?.failureCount ?? 0) + 1);
    const delayMs = cooldownDelayMs(error, accountCooldownPolicyFor(error.kind), failureCount, now);
    // T2 transient errors (5xx, network, stream, protocol) → no cooldown.
    // The model is likely still working; the recovery loop retries.
    if (delayMs === 0) return null;
    const retryAtMs = now + delayMs;
    const record: ModelLockRecord = {
      accountId,
      modelId,
      retryAt: new Date(retryAtMs).toISOString(),
      errorKind: error.kind,
      statusCode: error.statusCode,
      sanitizedMessage: sanitizeMessage(error.sanitizedMessage),
      failureCount,
    };
    await this.modelLockStore.set(record);
    return record;
  }

  /** Clears a per-model lock on success — the model is working again. */
  async clearModelLock(accountId: string, modelId: string): Promise<void> {
    if (this.modelLockStore === null) return;
    await this.modelLockStore.delete(accountId, modelId);
  }

  /**
   * Checks whether a model is available (no active model lock) for the
   * given account at the specified time. Returns true when no lock store
   * is configured, when no lock exists, or when the lock's retry_at has
   * already passed.
   */
  async isModelAvailable(accountId: string, modelId: string, nowMs: number = this.nowMs()): Promise<boolean> {
    if (this.modelLockStore === null) return true;
    const lock = await this.modelLockStore.get(accountId, modelId);
    if (lock === undefined) return true;
    return Date.parse(lock.retryAt) <= nowMs;
  }

  /** Lists all per-model locks for the given account (for candidate construction). */
  async listModelLocksForAccount(accountId: string): Promise<readonly ModelLockRecord[]> {
    if (this.modelLockStore === null) return [];
    return this.modelLockStore.listForAccount(accountId);
  }

  /** Batch-load health for multiple accounts — eliminates N+1 in accountCandidates. */
  async getHealthBatch(accountIds: readonly string[]): Promise<Map<string, RouteHealth>> {
    if (accountIds.length === 0) return new Map();
    const records = await this.store.listForAccountIds(accountIds);
    const now = this.nowMs();
    const map = new Map<string, RouteHealth>();
    for (const record of records) map.set(record.accountId, deriveRouteHealth(record, "account", now));
    return map;
  }

  /** Batch-load model locks for multiple accounts, grouped by accountId — eliminates N+1. */
  async listModelLocksForAccounts(accountIds: readonly string[]): Promise<Map<string, readonly ModelLockRecord[]>> {
    if (this.modelLockStore === null || accountIds.length === 0) return new Map();
    const allLocks = await this.modelLockStore.listForAccountIds(accountIds);
    const map = new Map<string, ModelLockRecord[]>();
    for (const lock of allLocks) {
      const list = map.get(lock.accountId);
      if (list === undefined) map.set(lock.accountId, [lock]);
      else list.push(lock);
    }
    return map as Map<string, readonly ModelLockRecord[]>;
  }
}

export const OAUTH_SAFETY_SKEW_MS = 30_000;

export interface OAuthRefresher {
  refresh(input: { readonly accountId: string; readonly token: OAuthTokenRecord | null }): Promise<OAuthRefreshResult>;
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
}

/**
 * Cooldown-protected quota state and account-level request coalescing.
 * OAuth refresh is coordinated by TokenRefreshPool before quota fetches.
 */
export class QuotaCoordinator {
  private readonly sweepCooldownMs: number;
  private readonly nowMs: () => number;
  private readonly inflight = new Map<string, Promise<QuotaSweepResult>>();

  constructor(
    private readonly store: QuotaStateStore,
    options: QuotaCoordinatorOptions = {},
  ) {
    this.sweepCooldownMs = options.sweepCooldownMs ?? QUOTA_SWEEP_COOLDOWN_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async getQuotaAvailable(accountId: string): Promise<boolean> {
    const record = await this.store.get(accountId);
    return record?.quotaAvailable ?? true;
  }

  /** Batch-load quota availability for multiple accounts — eliminates N+1 in accountCandidates. */
  async getQuotaAvailableBatch(accountIds: readonly string[]): Promise<Map<string, boolean>> {
    if (accountIds.length === 0) return new Map();
    const records = await this.store.listForAccountIds(accountIds);
    const map = new Map<string, boolean>();
    for (const record of records) map.set(record.accountId, record.quotaAvailable);
    return map;
  }

  /** Refreshes quota only when the per-account cooldown has elapsed; concurrent sweeps coalesce. */
  async refreshQuotaIfDue(accountId: string, refresh: QuotaRefresher["refreshQuota"]): Promise<QuotaSweepResult> {
    const now = this.nowMs();
    const record = await this.store.get(accountId);
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
      () => {
        this.inflight.delete(accountId);
      },
      () => {
        this.inflight.delete(accountId);
      },
    );
    return pending;
  }

  async setQuotaAvailable(accountId: string, quotaAvailable: boolean): Promise<void> {
    const previous = await this.store.get(accountId);
    const record: QuotaStateRecord = {
      accountId,
      quotaAvailable,
      lastQuotaRefreshAtMs: previous?.lastQuotaRefreshAtMs ?? null,
    };
    await this.store.set(record);
  }

  private async performRefresh(accountId: string, refresh: QuotaRefresher["refreshQuota"]): Promise<QuotaSweepResult> {
    const quotaAvailable = await refresh(accountId);
    const now = this.nowMs();
    const record: QuotaStateRecord = { accountId, quotaAvailable, lastQuotaRefreshAtMs: now };
    await this.store.set(record);
    return { refreshed: true, quotaAvailable, nextRefreshAtMs: now + this.sweepCooldownMs };
  }
}

export type CredentialSelectionReason = "preferred" | "healthy" | "sole" | "fallback";

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

export class CredentialSelector {
  private readonly leases = new Map<string, { readonly accountId: string; readonly release: () => boolean }>();
  private readonly roundRobinCursor = new Map<string, number>();
  private readonly inFlightByAccount = new Map<string, number>();

  constructor(
    private readonly config: CredentialConfigStore,
    private readonly oauth: TokenRefreshPool,
  ) {}

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
    // Fix: use >= not > so sticky activates when pool size equals stickyLimit.
    // The old `>` meant a pool of 3 accounts with stickyLimit=3 never entered
    // the sticky path — it fell through to plain round-robin (no affinity).
    const stickyPool = stickyLimit > 0 && input.affinityKey && eligible.length >= stickyLimit
      ? Array.from({ length: stickyLimit }, (_, offset) => eligible[(stableCredentialHash(`${input.affinityKey}:${input.providerId}`) + offset) % eligible.length]).filter((candidate): candidate is AccountCandidate => candidate !== undefined)
      : eligible;

    let chosen: AccountCandidate | undefined;
    if (input.strategy === "round-robin" && stickyPool.length > 1) {
      // In-flight aware round-robin (etteum-pool pattern): prefer idle
      // accounts (in-flight == 0). If all are busy, fall back to the
      // least-loaded account, breaking ties by the round-robin cursor.
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
      const idle = eligible.filter((c) => this.getInFlight(c.id) === 0);
      chosen = idle.length > 0 ? idle[0] : eligible[0];
    }
    if (chosen === undefined) return null;

    const accountConfig = await this.config.getAccount(chosen.id);
    if (accountConfig === undefined) {
      throw makeProviderError("credential_unavailable", `Account ${chosen.id} has no credential configuration`, { retryable: false, routeScope: "account" });
    }
    if (!accountConfig.enabled) {
      throw makeProviderError("credential_unavailable", `Account ${chosen.id} is disabled`, { retryable: false, routeScope: "account" });
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
        throw makeProviderError("credential_unavailable", `Account ${chosen.id} has no secret configured`, { retryable: false, routeScope: "account" });
      }
      secret = configuredSecret;
    }

    const leaseId = crypto.randomUUID();
    if (releaseLease !== null) {
      this.leases.set(leaseId, { accountId: chosen.id, release: releaseLease });
    }
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
            : "healthy";

    return {
      selection: { accountId: chosen.id, kind: accountConfig.kind, leaseId, secret },
      account: chosen,
      reason,
    };
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
  return makeProviderError("credential_unavailable", `No eligible account available for provider ${providerId}`, {
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
