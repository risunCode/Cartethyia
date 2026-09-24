// OAuth refresh sweep: one bounded pass that proactively refreshes due
// OAuth accounts. Registered as a ScheduledTaskRegistry task so the registry
// owns interval + re-entrancy; this function owns only the domain work.
import type { OAuthRefreshService, OAuthTokenRefresher } from "../providers/authentication/oauth-refresh-service";
import { log } from "../observability/logger";
import { runGrowingWaves } from "./tasks";

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
  readonly onAccountError?: (accountId: string, providerId: string, error: unknown) => void;
  readonly onTick?: (result: { readonly due: number; readonly attempted: number }) => void;
}

const DEFAULT_MAX_CONCURRENCY = 5;
/**
 * One non-overlapping OAuth refresh sweep. The timer path intentionally never
 * rejects: an unhandled rejection would be observed by the task registry and
 * logged there, while this function isolates per-account errors.
 *
 * Accounts with no provider refresher are skipped. Eligible accounts run in
 * completed waves of 2, then 3, then 4, then 5 (or the configured maximum).
 */
export async function oauthRefreshSweep(deps: OAuthRefreshSweepDeps): Promise<void> {
  let due: readonly DueOAuthAccount[];
  try {
    due = await deps.loadDueAccounts();
  } catch (error) {
    log.error("[oauth-refresh] sweep failed to load due accounts", error as Error);
    return;
  }
  let attempted = 0;
  await runGrowingWaves(due, {
    maxConcurrency: deps.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    onItem: async (account) => {
      const refresher = await deps.resolveRefresher(account.providerId);
      if (!refresher) return;
      attempted += 1;
      try {
        await deps.refreshService.ensureFreshAccessToken(
          account.id,
          refresher,
          deps.skewMs === undefined ? {} : { skewMs: deps.skewMs },
        );
      } catch (error) {
        deps.onAccountError?.(account.id, account.providerId, error);
      }
    },
  });
  deps.onTick?.({ due: due.length, attempted });
}