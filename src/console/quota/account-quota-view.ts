import { providerAccounts } from "../../persistence/schema";
import type { ProviderQuotaResult } from "../../providers/quota/quota-contracts";
import { GLOBAL_QUOTA_LENS } from "./quota-cache";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  refreshAccountQuota,
  signalFetch,
  type QuotaRefreshDeps,
  type QuotaRefreshTarget,
} from "./quota-refresh";

/** Shape returned for quota data on dashboard account responses. */
export interface QuotaRefreshView {
  readonly source: string;
  readonly status: "ready" | "error" | "refreshing";
  readonly plan: string | null;
  readonly windows: ProviderQuotaResult["windows"];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
}

interface BackgroundQuotaRefreshJob {
  readonly key: string;
  readonly deps: QuotaRefreshDeps;
  readonly target: QuotaRefreshTarget;
}

const backgroundQuotaRefreshQueue: BackgroundQuotaRefreshJob[] = [];
const queuedBackgroundQuotaRefreshes = new Set<string>();
const activeBackgroundQuotaRefreshes = new Set<string>();
const MAX_BACKGROUND_QUOTA_REFRESHES = 4;

/** Accounts currently queued or in flight, for the overview's `pending` flag. */
export function pendingQuotaRefreshes(): ReadonlySet<string> {
  return activeBackgroundQuotaRefreshes;
}

function drainBackgroundQuotaRefreshes(): void {
  while (
    activeBackgroundQuotaRefreshes.size < MAX_BACKGROUND_QUOTA_REFRESHES &&
    backgroundQuotaRefreshQueue.length > 0
  ) {
    const job = backgroundQuotaRefreshQueue.shift();
    if (!job) return;
    queuedBackgroundQuotaRefreshes.delete(job.key);
    activeBackgroundQuotaRefreshes.add(job.target.accountId);
    void refreshAccountQuota(
      job.deps,
      job.target,
      signalFetch(AbortSignal.timeout(QUOTA_REFRESH_TIMEOUT_MS)),
    )
      .catch(() => undefined)
      .finally(() => {
        activeBackgroundQuotaRefreshes.delete(job.target.accountId);
        drainBackgroundQuotaRefreshes();
      });
  }
}

/**
 * Queues a background fill for one account. `targetLens` is part of the dedupe
 * key because a global account is refreshed once for every tenant that can see
 * it; the refresh itself is per-account and the cache write is shared.
 */
export function enqueueBackgroundQuotaRefresh(
  deps: QuotaRefreshDeps,
  target: QuotaRefreshTarget,
): void {
  const key = `${target.tenantId ?? GLOBAL_QUOTA_LENS}:${target.accountId}`;
  if (queuedBackgroundQuotaRefreshes.has(key)) return;
  if (activeBackgroundQuotaRefreshes.has(target.accountId)) return;
  queuedBackgroundQuotaRefreshes.add(key);
  backgroundQuotaRefreshQueue.push({ key, deps, target });
  drainBackgroundQuotaRefreshes();
}

/** Test seam: the queue is process-wide state. */
export function resetBackgroundQuotaRefreshesForTests(): void {
  backgroundQuotaRefreshQueue.length = 0;
  queuedBackgroundQuotaRefreshes.clear();
  activeBackgroundQuotaRefreshes.clear();
}

/** Shared quota-view projection used by the dashboard account endpoints. */
export function toQuotaView(
  quota: ProviderQuotaResult,
  account: { lastSuccessAt?: Date | null },
  timestamps: {
    fetchedAt?: string | null;
    lastAttemptAt?: string | null;
    lastSuccessAt?: string | null;
    status?: "ready" | "error" | "refreshing";
  } = {},
): QuotaRefreshView {
  const fetchedAt = timestamps.fetchedAt ?? account.lastSuccessAt?.toISOString() ?? null;
  return {
    source: quota.source,
    status: timestamps.status ?? (quota.error ? "error" : "ready"),
    plan: quota.plan ?? null,
    windows: quota.windows,
    fetchedAt,
    lastAttemptAt: timestamps.lastAttemptAt ?? null,
    lastSuccessAt: timestamps.lastSuccessAt ?? account.lastSuccessAt?.toISOString() ?? null,
    error: quota.error ?? null,
  };
}

/** Removes credential material from global-account responses. */
export function sanitizeGlobalAccount(
  row: typeof providerAccounts.$inferSelect,
): Record<string, unknown> {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    credentialKind: row.credentialKind,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt.toISOString() } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.cooldownUntil ? { cooldownUntil: row.cooldownUntil.toISOString() } : {}),
  };
}
