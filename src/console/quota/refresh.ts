// Shared account-quota refresh: one home for "resolve credential → fetch quota →
// cache under the right lens → stamp the account row".
//
// Four callers need exactly this sequence — the console's single/bulk refresh
// routes, the overview's background fill, the periodic sweep worker, and the
// global-admin refresh — so it lives here rather than inside the route module.
// A drift between them would mean the page and the worker disagree about what
// "refreshed" means.
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { providerAccounts } from "../../persistence/schema";
import type { RedisClient } from "../../persistence/redis";
import { log } from "../../observability/logger";
import { fetchProviderQuota } from "../../providers/quota/quota-support";
import { totalRemainingCredit, type FetchLike, type ProviderQuotaResult } from "../../providers/quota/quota-contracts";
import type { ProviderId, ProviderRegistry } from "../../providers/provider-registry";
import { GLOBAL_QUOTA_LENS, setCachedQuota } from "./cache";
import { record } from "../../providers/authentication/oauth-flow-store";

/** Why an account quota refresh failed; `null` means the fetch succeeded. */
export type QuotaRefreshFailureCode = "missing_credential" | "quota_fetch_failed";

export interface QuotaRefreshOutcome {
  readonly quota: ProviderQuotaResult;
  readonly failure: QuotaRefreshFailureCode | null;
  /** Display identity the quota surface reported, when it reported one. */
  readonly accountLabel?: string;
}

/** Abort budget for one upstream quota fetch. */
export const QUOTA_REFRESH_TIMEOUT_MS = 15_000;

export interface QuotaRefreshDeps {
  readonly db: CartethyiaDatabase;
  readonly redis: RedisClient;
  readonly providerRegistry: ProviderRegistry;
  /**
   * Resolves a stored credential through the refresh-aware path (OAuth tokens
   * are refreshed before use), returning `""` when the account has none.
   * API-key accounts are wrapped in the provider's key envelope when one
   * exists, so a key-only credential never reaches an OAuth-only surface.
   */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  /** Marks a stored api_key credential with the upstream-distinguishable envelope. */
  readonly markApiKeyCredential?: (providerId: string, credential: string) => string;
  /** Invalidates the route snapshot when a stamped figure may exclude an account. */
  readonly snapshotInvalidator?: { invalidate(): unknown } | undefined;
}

/**
 * In-flight promise deduplication map for account quota refreshes. Keyed by
 * accountId so concurrent callers (a manual refresh plus the sweep, or two
 * rapid clicks) share one upstream fetch instead of hammering the provider.
 */
export const inFlightAccountQuotaRefreshes = new Map<string, Promise<QuotaRefreshOutcome>>();

/**
 * Binds an abort signal to outbound quota fetches while preserving Bun's
 * `fetch.preconnect` static, so the wrapper satisfies `FetchLike`.
 */
export function signalFetch(signal: AbortSignal): typeof fetch {
  const wrapped = (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => fetch(url, { ...init, signal });
  return Object.assign(wrapped, {
    preconnect: (...args: Parameters<typeof fetch.preconnect>): void =>
      fetch.preconnect(...args),
  });
}

/** Combines the caller's abort signal with the fetch budget. */
export function timeoutSignal(requestSignal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([requestSignal, AbortSignal.timeout(ms)]);
}

/**
 * Records a manual account-test outcome on the account row so the dashboard's
 * "Last check" reflects what the test actually found. Success stamps
 * `lastSuccessAt` and clears the error fields; failure stamps the error
 * fields and keeps the last success. Never touches `status` or
 * `consecutiveFailures` — the dispatch health state machine owns those, a
 * manual check only reports.
 *
 * The error fields are written only while the account is `active`, because for
 * a parked account (cooldown/disabled) those fields carry the reason
 * the health machine parked it. A periodic quota sweep runs against every OAuth
 * account, and a failing quota endpoint reported "Invalid or expired
 * credentials" for an entire provider — overwriting the `auth_invalidated`
 * reason a dispatch 401 had just recorded with `quota_fetch_failed`, so the
 * dashboard blamed the wrong thing. A check cannot reclassify a parked account;
 * its own failure is still visible through the quota cache the page renders.
 */
export async function recordAccountCheck(
  db: CartethyiaDatabase,
  accountId: string,
  outcome: { ok: boolean; error?: string | null; category?: string | null },
): Promise<void> {
  const activeOnly = and(
    eq(providerAccounts.id, accountId),
    eq(providerAccounts.status, "active"),
  );
  if (outcome.ok) {
    await db
      .update(providerAccounts)
      .set({ lastSuccessAt: new Date(), lastError: null, lastErrorCategory: null, lastErrorAt: null })
      .where(activeOnly);
    return;
  }
  await db
    .update(providerAccounts)
    .set({
      lastError: (outcome.error ?? "Account check failed").slice(0, 500),
      lastErrorCategory: outcome.category ?? "check_failed",
      lastErrorAt: new Date(),
    })
    .where(activeOnly);
}

/** One account that a quota refresh can be attempted for. */
export interface QuotaRefreshTarget {
  readonly accountId: string;
  readonly providerId: string;
  /** Owning tenant, or `null` for a global/shared account. */
  readonly tenantId: string | null;
  /**
   * Stored credential kind. Key-only credentials never reach an OAuth-only
   * quota surface: the collector routes `api_key` to the `/models`
   * connectivity probe instead, while OAuth keeps `users/me`.
   */
  readonly credentialKind?: "api_key" | "oauth" | "none" | null;
  /**
   * Human identity for logs. OAuth rows carry `Name <email@host>` because the
   * account label is seeded from the token's own identity claims, so sweep
   * lines can name the account instead of dumping a uuid.
   */
  readonly label?: string | null;
  /**
   * Non-secret per-account auth configuration. A collector whose billing
   * surface is region- or profile-scoped needs it; most ignore it.
   */
  readonly authState?: unknown;
}

/** Cache lens an account's quota belongs under. */
export function targetLens(target: QuotaRefreshTarget): string {
  return target.tenantId ?? GLOBAL_QUOTA_LENS;
}

/**
 * Stamps the fresh remaining credit onto the account row so the request path
 * can enforce the per-account floor from the last cached read — no live
 * provider round trip per request. Writes only when the fetch reported a
 * figure; a credit-less read leaves the previous stamp untouched. Returns
 * `true` when the row changed so the caller can invalidate the route snapshot.
 */
export async function stampRemainingCredit(
  db: CartethyiaDatabase,
  accountId: string,
  remaining: number | null,
): Promise<boolean> {
  if (remaining === null || !Number.isFinite(remaining)) return false;
  try {
    const updated = await db
      .update(providerAccounts)
      .set({ lastRemainingCredit: String(Math.max(0, remaining)) })
      .where(
        and(
          eq(providerAccounts.id, accountId),
          or(
            isNull(providerAccounts.lastRemainingCredit),
            ne(providerAccounts.lastRemainingCredit, String(Math.max(0, remaining))),
          ),
        ),
      )
      .returning({ id: providerAccounts.id });
    return updated.length > 0;
  } catch {
    return false;
  }
}

const TARGET_COLUMNS = {
  accountId: providerAccounts.id,
  providerId: providerAccounts.providerId,
  tenantId: providerAccounts.tenantId,
  credentialKind: providerAccounts.credentialKind,
  label: providerAccounts.label,
  authState: providerAccounts.authState,
};

/**
 * Credential-bearing accounts eligible for the periodic quota sweep.
 *
 * OAuth accounts use the refresh-aware resolver; api_key accounts (including
 * pasted JWTs) use the stored bearer exactly as issued. Both need quota refresh
 * and Buddy daily check-in, while `none` has no credential to probe.
 *
 * An account already marked `auth_invalidated` is excluded: its credential was
 * rejected outright and does not repair itself, so every sweep is a guaranteed
 * 401 that only re-confirms the row and floods the log — the operator needs a
 * re-login, not another probe. It returns to the sweep once it is re-authed or
 * recovered, which is when its credential is expected to work again.
 *
 * Every other credential-bearing account is swept, `disabled` included. A
 * disabled account is not necessarily revoked — it may have been parked for a
 * reason unrelated to its credential — and skipping it would let a credential
 * die silently while the row still reads healthy.
 */
export async function listQuotaRefreshTargets(
  db: CartethyiaDatabase,
): Promise<readonly QuotaRefreshTarget[]> {
  return db
    .select(TARGET_COLUMNS)
    .from(providerAccounts)
    .where(
      and(
        inArray(providerAccounts.credentialKind, ["oauth", "api_key"]),
        or(
          isNull(providerAccounts.lastErrorCategory),
          ne(providerAccounts.lastErrorCategory, "auth_invalidated"),
        ),
      ),
    );
}

/**
 * Loads one account scoped to its owner.
 *
 * `tenantId` undefined means "any owner"; `null` means a shared/global row,
 * and a supplied tenant id matches only that tenant's own rows. Explicitly
 * selecting `null` keeps global-admin refreshes from addressing tenant-owned
 * accounts by id.
 */
export async function loadQuotaTarget(
  db: CartethyiaDatabase,
  accountId: string,
  tenantId?: string | null,
): Promise<QuotaRefreshTarget | undefined> {
  const ownerPredicate =
    tenantId === undefined
      ? undefined
      : tenantId === null
        ? isNull(providerAccounts.tenantId)
        : eq(providerAccounts.tenantId, tenantId);
  const where = ownerPredicate
    ? and(eq(providerAccounts.id, accountId), ownerPredicate)
    : eq(providerAccounts.id, accountId);
  const rows = await db.select(TARGET_COLUMNS).from(providerAccounts).where(where).limit(1);
  return rows[0];
}

/**
 * Fetches one account's quota through the refresh-aware credential path, then
 * persists the outcome: the result is cached under the account's lens and the
 * account row is stamped with the check result. Concurrent callers for the same
 * account share one upstream fetch via `inFlightAccountQuotaRefreshes`.
 */
export async function refreshAccountQuota(
  deps: QuotaRefreshDeps,
  target: QuotaRefreshTarget,
  fetcher: FetchLike,
): Promise<QuotaRefreshOutcome> {
  const existing = inFlightAccountQuotaRefreshes.get(target.accountId);
  if (existing) return existing;
  const task = runQuotaRefresh(deps, target, fetcher).finally(() => {
    inFlightAccountQuotaRefreshes.delete(target.accountId);
  });
  inFlightAccountQuotaRefreshes.set(target.accountId, task);
  return task;
}

async function runQuotaRefresh(
  deps: QuotaRefreshDeps,
  target: QuotaRefreshTarget,
  fetcher: FetchLike,
): Promise<QuotaRefreshOutcome> {
  let credential: string | undefined;
  let resolveError: string | undefined;
  try {
    credential = await deps.resolveCredential(target.providerId as ProviderId, target.accountId);
  } catch (error) {
    resolveError = error instanceof Error ? error.message : "Failed to resolve credential";
  }

  let quota: ProviderQuotaResult;
  let failure: QuotaRefreshFailureCode | null = null;
  if (resolveError !== undefined) {
    quota = { source: target.providerId, plan: null, windows: [], error: resolveError };
    failure = "quota_fetch_failed";
  } else if (!credential) {
    quota = {
      source: target.providerId,
      plan: null,
      windows: [],
      error: "Account has no stored credential",
    };
    failure = "missing_credential";
  } else {
    // OAuth accounts must never see the api-key mark: the marker routes the
    // collector to the key-only probe, and OAuth credentials carry no key.
    const marked =
      target.credentialKind === "api_key"
        ? (deps.markApiKeyCredential?.(target.providerId, credential) ?? credential)
        : credential;
    try {
      const authState = record(target.authState);
      quota = await fetchProviderQuota(deps.providerRegistry, target.providerId, marked, fetcher, {
        ...(authState === undefined ? {} : { auth_state: authState }),
        ...(target.credentialKind === null || target.credentialKind === undefined
          ? {}
          : { credential_kind: target.credentialKind }),
      });
    } catch (error) {
      quota = {
        source: target.providerId,
        plan: null,
        windows: [],
        error: error instanceof Error ? error.message : "Failed to refresh quota",
      };
    }
    failure = quota.error === null ? null : "quota_fetch_failed";
  }

  // Cache even a failed fetch: the error view ("credential expired", "quota
  // unsupported") is itself the answer the page must render, and caching it
  // stops every page open from re-hitting a provider that just refused us.
  await setCachedQuota(targetLens(target), target.accountId, quota, deps.redis);
  // A quota surface that names the account adopts the identity — but only over
  // a default label. An operator's custom rename is never overwritten, and the
  // CASE keeps the read and the write in one statement so a concurrent rename
  // cannot lose to the background sweep.
  if (quota.accountLabel !== undefined && quota.accountLabel.trim().length > 0) {
    try {
      await deps.db
        .update(providerAccounts)
        .set({
          label: sql`CASE WHEN lower(trim(${providerAccounts.label})) = lower(trim(${providerAccounts.providerId})) THEN ${quota.accountLabel} ELSE ${providerAccounts.label} END`,
        })
        .where(eq(providerAccounts.id, target.accountId));
    } catch (error) {
      log.warn(`[quota] failed to adopt account label for account=${target.accountId}`, error as Error);
    }
  }
  try {
    await recordAccountCheck(deps.db, target.accountId, {
      ok: quota.error === null,
      ...(quota.error === null ? {} : { error: quota.error, category: failure ?? "quota_fetch_failed" }),
    });
  } catch (error) {
    // A stamp failure must not lose the freshly fetched quota.
    log.warn(`[quota] failed to stamp check outcome for account=${target.accountId}`, error as Error);
  }
  // Stamp the last fetched remaining credit: only a *successful* fetch that
  // actually reports credit carries a figure — a failed or credit-less read
  // must never overwrite a real stamp. The request path enforces the
  // per-account floor from this stamp, and the route snapshot is invalidated
  // when it changes so the next plan sees the fresh figure.
  if (quota.error === null) {
    try {
      const remaining = totalRemainingCredit(quota.windows);
      if (await stampRemainingCredit(deps.db, target.accountId, remaining)) {
        await deps.snapshotInvalidator?.invalidate();
        log.info(
          `[quota] remaining credit stamped account=${target.accountId} provider=${target.providerId} remaining=${remaining}`,
        );
      }
    } catch (error) {
      // The stamp is advisory: a failure here must not lose the fetched quota.
      log.warn(`[quota] remaining credit stamp failed for account=${target.accountId}`, error as Error);
    }
  }
  return {
    quota,
    failure: quota.error === null ? null : (failure ?? "quota_fetch_failed"),
    ...(quota.accountLabel === undefined ? {} : { accountLabel: quota.accountLabel }),
  };
}
