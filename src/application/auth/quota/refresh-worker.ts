import { mapWithConcurrency } from "../../concurrency";
import type { AccountConfig, CredentialConfigStore, QuotaStateStore } from "../credentials";

const DEFAULT_QUOTA_INTERVAL_MS = 5 * 60_000;
const DEFAULT_QUOTA_CONCURRENCY = 3;
const DEFAULT_FAILURE_COOLDOWN_MS = 15 * 60_000;

export interface QuotaRefreshWorkerOptions {
  readonly intervalMs?: number;
  readonly concurrency?: number;
  readonly failureCooldownMs?: number;
  readonly nowMs?: () => number;
  readonly supportsProvider?: (providerId: string) => boolean;
  readonly onRefreshed?: (accountId: string, quotaAvailable: boolean) => void;
  readonly onFailed?: (accountId: string, error: unknown) => void;
}

/** Periodic quota worker; quota refresh is coalesced per account and never overlaps a sweep. */
export class QuotaRefreshWorker {
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly failureCooldownMs: number;
  private readonly nowMs: () => number;
  private readonly supportsProvider: (providerId: string) => boolean;
  private readonly onRefreshed?: (accountId: string, quotaAvailable: boolean) => void;
  private readonly onFailed?: (accountId: string, error: unknown) => void;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly failedUntil = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly accounts: CredentialConfigStore,
    private readonly state: QuotaStateStore,
    private readonly refreshQuota: (accountId: string) => Promise<boolean>,
    options: QuotaRefreshWorkerOptions = {},
  ) {
    this.intervalMs = Math.max(60_000, options.intervalMs ?? DEFAULT_QUOTA_INTERVAL_MS);
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_QUOTA_CONCURRENCY));
    this.failureCooldownMs = Math.max(60_000, options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.supportsProvider = options.supportsProvider ?? (() => true);
    this.onRefreshed = options.onRefreshed;
    this.onFailed = options.onFailed;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => console.warn("[QuotaRefresh] sweep failed", error instanceof Error ? error.message : "unknown error"));
    }, this.intervalMs);
    this.timer.unref?.();
    this.sweep().catch((error) => console.warn("[QuotaRefresh] initial sweep failed", error instanceof Error ? error.message : "unknown error"));
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
      const accounts = (await this.accounts.listAccounts()).filter((account) => account.enabled && this.supportsProvider(account.providerId));
      await mapWithConcurrency(accounts, this.concurrency, async (account) => {
        if (!(await this.isDue(account))) return;
        try {
          const quotaAvailable = await this.refreshSingleFlight(account.id);
          this.failedUntil.delete(account.id);
          this.onRefreshed?.(account.id, quotaAvailable);
        } catch (error) {
          this.failedUntil.set(account.id, this.nowMs() + this.failureCooldownMs);
          this.onFailed?.(account.id, error);
        }
      });
    } finally {
      this.sweeping = false;
    }
  }

  private async isDue(account: AccountConfig): Promise<boolean> {
    const failedUntil = this.failedUntil.get(account.id) ?? 0;
    if (failedUntil > this.nowMs()) return false;
    const record = await this.state.get(account.id);
    const lastRefreshAtMs = record?.lastQuotaRefreshAtMs ?? null;
    return lastRefreshAtMs === null || this.nowMs() - lastRefreshAtMs >= this.intervalMs;
  }

  private async refreshSingleFlight(accountId: string): Promise<boolean> {
    const existing = this.inflight.get(accountId);
    if (existing !== undefined) return existing;
    const pending = this.refreshQuota(accountId);
    this.inflight.set(accountId, pending);
    pending.finally(() => this.inflight.delete(accountId)).catch(() => {});
    return pending;
  }

}
