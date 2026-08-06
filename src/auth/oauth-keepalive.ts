/**
 * OAuth keepalive — proactive token pre-refresh service.
 *
 * Sweeps all OAuth accounts on a bounded interval and pre-refreshes tokens
 * that are within the refresh lead window of expiry. This prevents
 * request-time 401s from expired tokens: by the time a request arrives,
 * the token is already fresh.
 *
 * Memory safety:
 * - The interval timer is `unref()`ed so it never keeps the process alive.
 * - Concurrent sweeps for the same account coalesce via OAuthCoordinator's
 *   single-flight per account (inflight map).
 * - Failures are logged but never stop the sweep — the next interval retries.
 * - No token material leaves the coordinator; only account ids are enumerated.
 *
 * Inspired by 9router's `checkAndRefreshToken` but server-side, periodic, and
 * not in the request hot path — zero overhead per request.
 */

import type { CredentialConfigStore } from "./credentials";
import type { OAuthCoordinator } from "./credentials";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_LEAD_MS = 5 * 60 * 1000; // pre-refresh 5 min before expiry

export interface OAuthKeepaliveOptions {
  readonly intervalMs?: number;
  readonly refreshLeadMs?: number;
  readonly nowMs?: () => number;
  readonly onRefreshed?: (accountId: string) => void;
  readonly onFailed?: (accountId: string, message: string) => void;
}

export class OAuthKeepalive {
  private readonly intervalMs: number;
  private readonly refreshLeadMs: number;
  private readonly nowMs: () => number;
  private readonly onRefreshed?: (accountId: string) => void;
  private readonly onFailed?: (accountId: string, message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly accounts: CredentialConfigStore,
    private readonly oauth: OAuthCoordinator,
    options: OAuthKeepaliveOptions = {},
  ) {
    this.intervalMs = Math.max(30_000, options.intervalMs ?? SWEEP_INTERVAL_MS);
    this.refreshLeadMs = Math.max(30_000, options.refreshLeadMs ?? REFRESH_LEAD_MS);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.onRefreshed = options.onRefreshed;
    this.onFailed = options.onFailed;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    // Fire one immediately so tokens are fresh on startup.
    void this.sweep();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    let accountList: readonly { readonly id: string; readonly kind: string }[];
    try {
      accountList = await this.accounts.listAccounts();
    } catch {
      return;
    }
    const oauthAccounts = accountList.filter((a) => a.kind === "oauth");
    await Promise.allSettled(oauthAccounts.map((account) => this.refreshIfNearExpiry(account.id)));
  }

  private async refreshIfNearExpiry(accountId: string): Promise<void> {
    const token = await this.oauth.getToken(accountId);
    if (token === undefined) return;

    // No expiry → can't pre-refresh (some providers issue non-expiring tokens).
    if (token.expiresAtMs === null) return;

    const remaining = token.expiresAtMs - this.nowMs();
    if (remaining > this.refreshLeadMs) return; // still fresh

    // Has a refresh token → proactive refresh.
    if (token.refreshToken === null) return;

    try {
      await this.oauth.ensureFresh(accountId);
      this.onRefreshed?.(accountId);
    } catch (error) {
      this.onFailed?.(accountId, error instanceof Error ? error.message : "refresh failed");
    }
  }
}
