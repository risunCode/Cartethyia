import { fetchProviderQuota } from "../../providers/quota/fetcher";
import type { OAuthTokenRecord, OAuthTokenStore, QuotaSnapshotState, QuotaStateStore } from "../../application/auth";
import type { AccountRepository, AccountQuotaView } from "../views";


export interface QuotaRefreshQueueStatus {
  readonly queued: number;
  readonly active: number;
  readonly concurrency: number;
}

export class QuotaService {
  private readonly inflight = new Map<string, Promise<AccountQuotaView | null>>();
  private readonly queued = new Set<string>();
  private active = 0;
  private readonly concurrency = 3;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly states: QuotaStateStore,
    private readonly tokens: OAuthTokenStore,
    private readonly oauth?: { ensureFresh(accountId: string): Promise<OAuthTokenRecord> } | null,
  ) {}

  async get(accountId: string): Promise<AccountQuotaView | null> {
    return this.accounts.quota(accountId);
  }

  /**
   * Enqueues quota refreshes without making the HTTP caller wait for
   * provider calls. Duplicate account IDs are coalesced while queued or active.
   */
  enqueueRefresh(accountIds: readonly string[]): QuotaRefreshQueueStatus {
    for (const accountId of accountIds) {
      if (accountId.length > 0 && !this.queued.has(accountId) && !this.inflight.has(accountId)) this.queued.add(accountId);
    }
    this.drainQueue();
    return this.queueStatus();
  }

  queueStatus(): QuotaRefreshQueueStatus {
    return { queued: this.queued.size, active: this.active, concurrency: this.concurrency };
  }

  async refresh(accountId: string): Promise<AccountQuotaView | null> {
    const existing = this.inflight.get(accountId);
    if (existing !== undefined) return existing;
    const pending = this.performRefresh(accountId);
    this.inflight.set(accountId, pending);
    void pending.then(
      () => this.inflight.delete(accountId),
      () => this.inflight.delete(accountId),
    );
    return pending;
  }

  private drainQueue(): void {
    while (this.active < this.concurrency) {
      const accountId = this.queued.values().next().value as string | undefined;
      if (accountId === undefined) return;
      this.queued.delete(accountId);
      this.active += 1;
      void this.refresh(accountId).finally(() => {
        this.active -= 1;
        this.drainQueue();
      });
    }
  }

  private async performRefresh(accountId: string): Promise<AccountQuotaView | null> {
    const account = await this.accounts.get(accountId);
    if (account === null) return null;
    const credential = await this.accounts.credential(accountId);
    const previous = await this.states.get(accountId);
    const attemptAtMs = Date.now();
    // For OAuth accounts, ensureFresh the token before fetching quota —
    // an expired access token makes the quota API return 401 silently.
    let token = account.credentialKind === "oauth" ? await this.tokens.get(accountId) : undefined;
    let oauthFailure: string | null = null;
    if (account.credentialKind === "oauth" && this.oauth !== undefined && this.oauth !== null) {
      try {
        token = await this.oauth.ensureFresh(accountId);
      } catch (error) {
        token = undefined;
        if (typeof error === "object" && error !== null && "sanitizedMessage" in error && typeof error.sanitizedMessage === "string") oauthFailure = error.sanitizedMessage;
        else oauthFailure = "OAuth refresh failed; reauthorization may be required";
      }
    }
    const result = oauthFailure === null
      ? await fetchProviderQuota(account.providerId, credential?.credential ?? "", token)
      : { source: account.providerId, plan: null, windows: [], error: oauthFailure };
    const successful = result.error === null;
    const previousQuota = previous?.quota ?? null;
    const snapshot: QuotaSnapshotState = {
      source: result.source,
      status: successful ? "ready" : "error",
      plan: successful ? result.plan : previousQuota?.plan ?? null,
      windows: successful ? result.windows : previousQuota?.windows ?? [],
      fetchedAt: successful ? new Date(attemptAtMs).toISOString() : previousQuota?.fetchedAt ?? null,
      lastAttemptAt: new Date(attemptAtMs).toISOString(),
      lastSuccessAt: successful ? new Date(attemptAtMs).toISOString() : previousQuota?.lastSuccessAt ?? null,
      error: successful ? null : result.error,
    };
    const quotaAvailable = successful && (snapshot.windows.length === 0 || snapshot.windows.some((window) => window.remainingPercent === null || window.remainingPercent > 0));
    await this.states.set({ accountId, quotaAvailable, lastQuotaRefreshAtMs: successful ? attemptAtMs : previous?.lastQuotaRefreshAtMs ?? null, lastQuotaAttemptAtMs: attemptAtMs, lastQuotaSuccessAtMs: successful ? attemptAtMs : previous?.lastQuotaSuccessAtMs ?? null, quota: snapshot });
    return snapshot;
  }
}