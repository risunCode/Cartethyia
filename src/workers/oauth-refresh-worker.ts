// OAuth refresh sweep: one bounded pass that proactively refreshes due
// OAuth accounts. Registered as a ScheduledTaskRegistry task so the registry
// owns interval + re-entrancy; this function owns only the domain work.
import type { OAuthRefreshService, OAuthTokenRefresher } from "../providers/authentication/oauth-refresh-service";
import { runSweep } from "./sweep";

export interface DueOAuthAccount {
  readonly id: string;
  readonly providerId: string;
}

export interface OAuthRefreshSweepDeps {
  readonly loadDueAccounts: () => Promise<readonly DueOAuthAccount[]>;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
  /** Resolves a provider's token-endpoint client; accounts with no registered refresher are skipped. */
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly skewMs?: number;
  /** Maximum accounts in one completed wave. Defaults to 5. */
  readonly maxConcurrency?: number;
  /**
   * Milliseconds to pause between accounts when running sequentially. Absent
   * keeps the default wave behavior. Providers whose token endpoint rate-limits
   * bursts (Google-backed) are the reason this exists.
   */
  readonly interItemDelayMs?: number;
  readonly onAccountError?: (accountId: string, providerId: string, error: unknown) => void;
  readonly onTick?: (result: { readonly due: number; readonly attempted: number }) => void;
}

/**
 * One non-overlapping OAuth refresh sweep. Never rejects: the timer path has
 * no rejection channel, so every per-account failure is isolated here.
 *
 * Accounts with no provider refresher are skipped. Eligible accounts run in
 * completed waves of 2, then 3, then 4, then 5 (or the configured maximum).
 */
export async function oauthRefreshSweep(deps: OAuthRefreshSweepDeps): Promise<void> {
  const refreshers = new Map<string, OAuthTokenRefresher>();

  const result = await runSweep<DueOAuthAccount>({
    name: "oauth-refresh",
    list: deps.loadDueAccounts,
    // A provider with no registered refresher cannot be refreshed at all; it
    // is dropped before the waves rather than failing inside one.
    eligible: async (account) => {
      const cached = refreshers.get(account.providerId);
      if (cached !== undefined) return true;
      try {
        const refresher = await deps.resolveRefresher(account.providerId);
        if (refresher === undefined) return false;
        refreshers.set(account.providerId, refresher);
        return true;
      } catch {
        return false;
      }
    },
    run: async (account) => {
      const refresher = refreshers.get(account.providerId);
      if (refresher === undefined) return;
      await deps.refreshService.ensureFreshAccessToken(
        account.id,
        refresher,
        deps.skewMs === undefined ? {} : { skewMs: deps.skewMs },
      );
    },
    onItemError: (account, error) => {
      deps.onAccountError?.(account.id, account.providerId, error);
    },
    maxConcurrency: deps.maxConcurrency,
    ...(deps.interItemDelayMs === undefined
      ? {}
      : { pace: { interItemDelayMs: deps.interItemDelayMs } }),
  });

  // A pass that could not even list its accounts reports no tick: an all-zero
  // tick would read as "nothing due" rather than "nothing reachable".
  if (result.aborted) return;
  deps.onTick?.({ due: result.listed, attempted: result.attempted });
}
