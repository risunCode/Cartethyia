import type { ProviderCallError } from "../contracts";
import { createProviderError } from "../../traffic";
import { fingerprintOAuthToken, type AccountConfig, type CredentialConfigStore, type OAuthRefresher, type OAuthRefreshResult, type OAuthTokenRecord, type OAuthTokenStore } from "./credentials";

const DEFAULT_REFRESH_LEAD_MS = 5 * 60_000;
const DEFAULT_WORKER_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_CONCURRENCY = 4;
const DEFAULT_REFRESH_LEASE_MS = 15_000;
const REFRESH_LEASE_WAIT_MS = 50;
const MAX_REFRESH_LEASE_WAIT_MS = 3_000;

export interface TokenRefreshPolicy {
  readonly refreshLeadMs?: number;
  readonly maxRefreshAgeMs?: number;
  readonly minRefreshIntervalMs?: number;
  readonly jitterMs?: number;
}

export interface TokenRefreshPoolOptions {
  readonly safetySkewMs?: number;
  readonly nowMs?: () => number;
  readonly intervalMs?: number;
  readonly concurrency?: number;
  readonly ownerId?: string;
  readonly leaseMs?: number;
  readonly defaultPolicy?: TokenRefreshPolicy;
  readonly resolvePolicy?: (account: AccountConfig) => TokenRefreshPolicy | undefined;
  readonly onRefreshed?: (accountId: string) => void;
  readonly onFailed?: (accountId: string, error: ProviderCallError) => void;
}

export interface TokenLease {
  readonly leaseId: string;
  readonly token: OAuthTokenRecord;
  release(): boolean;
}

/**
 * Central OAuth token coordinator and proactive refresh scheduler.
 *
 * All request-time, quota-time, manual, and scheduled refreshes share the
 * same account-level single-flight map. This prevents refresh-token rotation
 * races across otherwise independent callers.
 */
export class TokenRefreshPool {
  private readonly safetySkewMs: number;
  private readonly nowMs: () => number;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly defaultPolicy: TokenRefreshPolicy;
  private readonly resolvePolicy?: (account: AccountConfig) => TokenRefreshPolicy | undefined;
  private readonly onRefreshed?: (accountId: string) => void;
  private readonly onFailed?: (accountId: string, error: ProviderCallError) => void;
  private readonly inflight = new Map<string, Promise<OAuthTokenRecord>>();
  private readonly leases = new Map<string, string>();
  private readonly refcounts = new Map<string, number>();
  private readonly refreshWaiters: Array<() => void> = [];
  private activeRefreshes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly accounts: CredentialConfigStore,
    private readonly store: OAuthTokenStore,
    private readonly refresher: OAuthRefresher,
    options: TokenRefreshPoolOptions = {},
  ) {
    this.safetySkewMs = Math.max(0, options.safetySkewMs ?? 30_000);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.intervalMs = Math.max(30_000, options.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS);
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_REFRESH_CONCURRENCY));
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_REFRESH_LEASE_MS);
    this.defaultPolicy = options.defaultPolicy ?? { refreshLeadMs: DEFAULT_REFRESH_LEAD_MS };
    this.resolvePolicy = options.resolvePolicy;
    this.onRefreshed = options.onRefreshed;
    this.onFailed = options.onFailed;
  }

  async getToken(accountId: string): Promise<OAuthTokenRecord | undefined> {
    return this.store.get(accountId);
  }

  async ensureFresh(accountId: string): Promise<OAuthTokenRecord> {
    const cached = await this.store.get(accountId);
    this.throwIfReauthenticationRequired(cached);
    if (cached !== undefined && (this.isFresh(cached) || cached.refreshToken === null)) return cached;
    this.throwIfRefreshDeferred(cached);
    return this.refreshSingleFlight(accountId, cached ?? null);
  }

  /** Forces one refresh while still sharing the same account-level flight. */
  async forceRefresh(accountId: string): Promise<OAuthTokenRecord> {
    const cached = await this.store.get(accountId);
    this.throwIfReauthenticationRequired(cached);
    if (cached?.refreshToken === null && cached.accessToken.length > 0) return cached;
    this.throwIfRefreshDeferred(cached);
    return this.refreshSingleFlight(accountId, cached ?? null);
  }

  async lease(accountId: string): Promise<TokenLease> {
    const token = await this.ensureFresh(accountId);
    const leaseId = crypto.randomUUID();
    this.leases.set(leaseId, accountId);
    this.refcounts.set(accountId, (this.refcounts.get(accountId) ?? 0) + 1);
    return { leaseId, token, release: () => this.releaseLease(leaseId) };
  }

  releaseLease(leaseId: string): boolean {
    const accountId = this.leases.get(leaseId);
    if (accountId === undefined) return false;
    this.leases.delete(leaseId);
    const current = this.refcounts.get(accountId) ?? 1;
    if (current <= 1) this.refcounts.delete(accountId);
    else this.refcounts.set(accountId, current - 1);
    return true;
  }

  activeLeaseCount(accountId: string): number {
    return this.refcounts.get(accountId) ?? 0;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => {
        console.warn("[TokenRefresh] sweep failed", error instanceof Error ? error.message : "unknown error");
      });
    }, this.intervalMs);
    this.timer.unref?.();
    this.sweep().catch((error) => {
      console.warn("[TokenRefresh] initial sweep failed", error instanceof Error ? error.message : "unknown error");
    });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const accountList = await this.accounts.listAccounts();
      const candidates = accountList.filter((account) => account.enabled && account.kind === "oauth");
      const due: AccountConfig[] = [];
      for (const account of candidates) {
        if (await this.isDue(account)) due.push(account);
      }
      await this.mapWithConcurrency(due, async (account) => {
        try {
          await this.forceRefresh(account.id);
        } catch (error) {
          this.reportFailure(account.id, error);
        }
      });
    } finally {
      this.sweeping = false;
    }
  }

  private async isDue(account: AccountConfig): Promise<boolean> {
    const token = await this.store.get(account.id);
    if (token === undefined || token.refreshToken === null || token.refreshState === "reauth_required") return false;
    const policy = { ...this.defaultPolicy, ...this.resolvePolicy?.(account) };
    const now = this.nowMs();
    const refreshLeadMs = Math.max(0, policy.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS);
    if (token.expiresAtMs !== null && token.expiresAtMs - now <= refreshLeadMs) return true;
    const lastRefreshAtMs = token.lastRefreshAtMs ?? null;
    const minRefreshIntervalMs = Math.max(0, policy.minRefreshIntervalMs ?? 0);
    if (lastRefreshAtMs !== null && now - lastRefreshAtMs < minRefreshIntervalMs) return false;
    if (policy.maxRefreshAgeMs === undefined) return false;
    const jitterMs = this.calculateJitterMs(account.id, Math.max(0, policy.jitterMs ?? 0));
    return lastRefreshAtMs === null || now - lastRefreshAtMs >= Math.max(0, policy.maxRefreshAgeMs) + jitterMs;
  }

  private calculateJitterMs(accountId: string, maximumMs: number): number {
    if (maximumMs <= 0) return 0;
    let hash = 2166136261;
    for (let index = 0; index < accountId.length; index += 1) {
      hash ^= accountId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % (Math.floor(maximumMs) + 1);
  }

  private async refreshSingleFlight(accountId: string, cached: OAuthTokenRecord | null): Promise<OAuthTokenRecord> {
    const inflight = this.inflight.get(accountId);
    if (inflight !== undefined) return inflight;
    const pending = this.refreshAndStore(accountId, cached);
    this.inflight.set(accountId, pending);
    pending.finally(() => this.inflight.delete(accountId)).catch(() => {});
    return pending;
  }

  private async refreshAndStore(accountId: string, cached: OAuthTokenRecord | null): Promise<OAuthTokenRecord> {
    const releaseRefreshSlot = await this.acquireRefreshSlot();
    try {
    const acquired = await this.acquireRefreshLease(accountId, cached);
    const expected = acquired.token;
    if (!acquired.owned) {
      if (expected !== null) return expected;
      throw createProviderError("provider_unavailable", "OAuth refresh is already in progress", { retryable: true, routeScope: "account" });
    }

      try {
      const current = await this.store.get(accountId);
      if (expected !== null && current !== undefined && this.isDifferentToken(current, expected)) return current;
      const base = current ?? expected;
      const attemptAtMs = this.nowMs();
      if (base !== null) {
        await this.store.set(accountId, {
          ...base,
          lastRefreshAttemptAtMs: attemptAtMs,
          refreshState: "retrying",
        });
      }

      let result: OAuthRefreshResult;
      try {
        result = await this.refresher.refresh({ accountId, token: base });
      } catch {
        result = {
          ok: false,
          error: createProviderError("provider_unavailable", "OAuth token refresh failed", { retryable: true, routeScope: "account" }),
        };
      }
      if (!result.ok) {
        await this.recordFailure(accountId, base, result.error, attemptAtMs);
        this.reportFailure(accountId, result.error);
        throw result.error;
      }

      const refreshed: OAuthTokenRecord = {
        ...result.token,
        refreshToken: result.token.refreshToken ?? base?.refreshToken ?? null,
        generation: (base?.generation ?? 0) + 1,
        lastRefreshAtMs: attemptAtMs,
        lastRefreshAttemptAtMs: attemptAtMs,
        lastRefreshErrorKind: null,
        lastRefreshStatusCode: null,
        refreshState: "healthy",
        refreshRetryAtMs: null,
        refreshFailureCount: 0,
      };
      const committed = base !== null && this.store.compareAndSwap !== undefined
        ? await this.store.compareAndSwap({
          accountId,
          expectedGeneration: base.generation ?? 0,
          expectedTokenFingerprint: fingerprintOAuthToken(base),
          token: refreshed,
        })
        : false;
      if (this.store.compareAndSwap !== undefined && base !== null && !committed) {
        const latest = await this.store.get(accountId);
        if (latest !== undefined) return latest;
        throw createProviderError("provider_unavailable", "OAuth token update lost its generation race", { retryable: true, routeScope: "account" });
      }
      if (!committed) await this.store.set(accountId, refreshed);
      this.onRefreshed?.(accountId);
      return refreshed;
    } finally {
      await this.store.releaseRefreshLease?.(accountId, this.ownerId);
    }
    } finally {
      releaseRefreshSlot();
  }

  }
  private async acquireRefreshSlot(): Promise<() => void> {
    if (this.activeRefreshes >= this.concurrency) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.refreshWaiters.push(resolve);
      await promise;
    }
    this.activeRefreshes += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRefreshes = Math.max(0, this.activeRefreshes - 1);
      this.refreshWaiters.shift()?.();
    };
  }

  private async acquireRefreshLease(accountId: string, cached: OAuthTokenRecord | null): Promise<{ readonly token: OAuthTokenRecord | null; readonly owned: boolean }> {
    let expected: OAuthTokenRecord | null = cached ?? await this.store.get(accountId) ?? null;
    const acquire = this.store.tryAcquireRefreshLease?.bind(this.store);
    if (acquire === undefined || expected === null || expected.refreshToken === null) return { token: expected, owned: true };
    for (let waitedMs = 0; waitedMs <= MAX_REFRESH_LEASE_WAIT_MS; waitedMs += REFRESH_LEASE_WAIT_MS) {
      const owned = await acquire({
        accountId,
        ownerId: this.ownerId,
        generation: expected.generation ?? 0,
        tokenFingerprint: fingerprintOAuthToken(expected),
        nowMs: this.nowMs(),
        leaseMs: this.leaseMs,
      });
      if (owned) return { token: await this.store.get(accountId) ?? expected, owned: true };
      const latest = await this.store.get(accountId);
      if (latest !== undefined && this.isDifferentToken(latest, expected)) return { token: latest, owned: false };
      if (waitedMs < MAX_REFRESH_LEASE_WAIT_MS) await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_LEASE_WAIT_MS));
    }
    throw createProviderError("provider_unavailable", "OAuth refresh lease is busy", {
      retryable: true,
      routeScope: "account",
      retryAt: new Date(this.nowMs() + REFRESH_LEASE_WAIT_MS).toISOString(),
    });
  }

  private async recordFailure(accountId: string, cached: OAuthTokenRecord | null, error: ProviderCallError, atMs: number): Promise<void> {
    const current = cached ?? await this.store.get(accountId);
    if (current === undefined) return;
    const failureCount = (current.refreshFailureCount ?? 0) + 1;
    const requiresReauthentication = this.requiresReauthentication(error);
    const retryAtMs = requiresReauthentication ? null : this.calculateRetryAtMs(error, atMs, failureCount);
    const next: OAuthTokenRecord = {
      ...current,
      lastRefreshAttemptAtMs: atMs,
      lastRefreshErrorKind: error.kind,
      lastRefreshStatusCode: error.statusCode,
      refreshState: requiresReauthentication ? "reauth_required" : "retrying",
      refreshRetryAtMs: retryAtMs,
      refreshFailureCount: failureCount,
    };
    if (this.store.compareAndSwap !== undefined) {
      await this.store.compareAndSwap({
        accountId,
        expectedGeneration: current.generation ?? 0,
        expectedTokenFingerprint: fingerprintOAuthToken(current),
        token: next,
      });
      return;
    }
    await this.store.set(accountId, next);
  }

  private calculateRetryAtMs(error: ProviderCallError, atMs: number, failureCount: number): number | null {
    const retryAtMs = error.retryAt === null ? Number.NaN : Date.parse(error.retryAt);
    if (Number.isFinite(retryAtMs)) return retryAtMs;
    if (!error.retryable && error.kind !== "provider_protocol_error") return null;
    return atMs + Math.min(60_000, 1_000 * 2 ** Math.min(failureCount - 1, 6));
  }

  private requiresReauthentication(error: ProviderCallError): boolean {
    const message = error.sanitizedMessage.toLowerCase();
    const permanentMarker = ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "revoked"].some((marker) => message.includes(marker));
    return permanentMarker || ((error.kind === "authentication_failed" || error.kind === "authorization_denied") && !error.retryable);
  }

  private throwIfReauthenticationRequired(token: OAuthTokenRecord | undefined): void {
    if (token?.refreshState !== "reauth_required") return;
    throw createProviderError("authentication_failed", "OAuth reauthorization is required", {
      retryable: false,
      routeScope: "account",
      statusCode: token.lastRefreshStatusCode ?? 401,
    });
  }

  private throwIfRefreshDeferred(token: OAuthTokenRecord | undefined): void {
    if (token?.refreshState !== "retrying" || token.refreshRetryAtMs === null || token.refreshRetryAtMs === undefined || token.refreshRetryAtMs <= this.nowMs()) return;
    throw createProviderError(token.lastRefreshStatusCode === 429 ? "provider_rate_limited" : "provider_unavailable", "OAuth refresh is waiting for provider retry backoff", {
      retryable: true,
      routeScope: "account",
      statusCode: token.lastRefreshStatusCode ?? 503,
      retryAt: new Date(token.refreshRetryAtMs).toISOString(),
    });
  }

  private isDifferentToken(left: OAuthTokenRecord, right: OAuthTokenRecord): boolean {
    return (left.generation ?? 0) !== (right.generation ?? 0) || fingerprintOAuthToken(left) !== fingerprintOAuthToken(right);
  }

  private isFresh(token: OAuthTokenRecord): boolean {
    return token.expiresAtMs === null || token.expiresAtMs - this.nowMs() > this.safetySkewMs;
  }

  private async mapWithConcurrency<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        await task(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, () => worker()));
  }

  private reportFailure(accountId: string, error: unknown): void {
    if (error !== null && typeof error === "object" && "kind" in error) {
      this.onFailed?.(accountId, error as ProviderCallError);
      return;
    }
    this.onFailed?.(accountId, createProviderError("provider_unavailable", "OAuth token refresh failed", { retryable: true, routeScope: "account" }));
  }
}
