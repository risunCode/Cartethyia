import type { ProviderCallError } from "../application/contracts";
import { makeProviderError } from "../traffic";
import type {
  AccountConfig,
  CredentialConfigStore,
  OAuthRefresher,
  OAuthRefreshResult,
  OAuthTokenRecord,
  OAuthTokenStore,
} from "./credentials";

const DEFAULT_REFRESH_LEAD_MS = 5 * 60_000;
const DEFAULT_WORKER_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_CONCURRENCY = 4;

export interface TokenRefreshPolicy {
  readonly refreshLeadMs?: number;
  readonly maxRefreshAgeMs?: number;
}

export interface TokenRefreshPoolOptions {
  readonly safetySkewMs?: number;
  readonly nowMs?: () => number;
  readonly intervalMs?: number;
  readonly concurrency?: number;
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
  private readonly defaultPolicy: TokenRefreshPolicy;
  private readonly resolvePolicy?: (account: AccountConfig) => TokenRefreshPolicy | undefined;
  private readonly onRefreshed?: (accountId: string) => void;
  private readonly onFailed?: (accountId: string, error: ProviderCallError) => void;
  private readonly inflight = new Map<string, Promise<OAuthTokenRecord>>();
  private readonly leases = new Map<string, string>();
  private readonly refcounts = new Map<string, number>();
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
    return this.refreshSingleFlight(accountId, cached ?? null);
  }

  /** Forces one refresh while still sharing the same account-level flight. */
  async forceRefresh(accountId: string): Promise<OAuthTokenRecord> {
    const cached = await this.store.get(accountId);
    this.throwIfReauthenticationRequired(cached);
    if (cached?.refreshToken === null && cached.accessToken.length > 0) return cached;
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
          await this.ensureFresh(account.id);
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
    if (policy.maxRefreshAgeMs === undefined) return false;
    const lastRefreshAtMs = token.lastRefreshAtMs ?? null;
    return lastRefreshAtMs === null || now - lastRefreshAtMs >= Math.max(0, policy.maxRefreshAgeMs);
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
    const attemptAtMs = this.nowMs();
    if (cached !== null) {
      await this.store.set(accountId, {
        ...cached,
        lastRefreshAttemptAtMs: attemptAtMs,
        refreshState: "retrying",
      });
    }
    let result: OAuthRefreshResult;
    try {
      result = await this.refresher.refresh({ accountId, token: cached });
    } catch {
      result = {
        ok: false,
        error: makeProviderError("provider_unavailable", "OAuth token refresh failed", { retryable: true, routeScope: "account" }),
      };
    }
    if (!result.ok) {
      await this.recordFailure(accountId, cached, result.error, attemptAtMs);
      this.reportFailure(accountId, result.error);
      throw result.error;
    }
    const refreshed: OAuthTokenRecord = {
      ...result.token,
      lastRefreshAtMs: attemptAtMs,
      lastRefreshAttemptAtMs: attemptAtMs,
      lastRefreshErrorKind: null,
      lastRefreshStatusCode: null,
      refreshState: "healthy",
    };
    await this.store.set(accountId, refreshed);
    this.onRefreshed?.(accountId);
    return refreshed;
  }

  private async recordFailure(accountId: string, cached: OAuthTokenRecord | null, error: ProviderCallError, atMs: number): Promise<void> {
    const current = cached ?? await this.store.get(accountId);
    if (current === undefined) return;
    await this.store.set(accountId, {
      ...current,
      lastRefreshAttemptAtMs: atMs,
      lastRefreshErrorKind: error.kind,
      lastRefreshStatusCode: error.statusCode,
      refreshState: this.requiresReauthentication(error) ? "reauth_required" : "retrying",
    });
  }

  private requiresReauthentication(error: ProviderCallError): boolean {
    return (error.kind === "authentication_failed" || error.kind === "authorization_denied") && !error.retryable;
  }

  private throwIfReauthenticationRequired(token: OAuthTokenRecord | undefined): void {
    if (token?.refreshState !== "reauth_required") return;
    throw makeProviderError("authentication_failed", "OAuth reauthorization is required", {
      retryable: false,
      routeScope: "account",
      statusCode: token.lastRefreshStatusCode ?? 401,
    });
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
    this.onFailed?.(accountId, makeProviderError("provider_unavailable", "OAuth token refresh failed", { retryable: true, routeScope: "account" }));
  }
}
