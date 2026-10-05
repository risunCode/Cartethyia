// Periodic quota sweep: keeps every account's cached quota warm so opening the
// Quota page is a cache read instead of a cold upstream fan-out.
//
// This is the piece that makes the page feel instant. Without it the only
// refreshes are the ones a user triggers, which means the first open after a
// cache expiry always blocks on the provider.
//
// It also carries the daily check-in ride-along: each account this sweep
// refreshes gets its once-per-day credit grant claimed in the same pass
// (`attemptDailyGrowthPass`), because both need the same freshly resolved
// credential and a second timer would duplicate that work.
import { log } from "../observability/logger";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  listQuotaRefreshTargets,
  refreshAccountQuota,
  signalFetch,
  targetLens,
  type QuotaRefreshDeps,
  type QuotaRefreshOutcome,
  type QuotaRefreshTarget,
} from "../console/quota/refresh";
import { getCachedQuotaEntries, type CachedQuotaEntry } from "../console/quota/cache";
import { runSweep } from "./sweep";
import type { ValidatedFetch } from "../network/outbound-fetch";
import type { ProviderId } from "../providers/provider-registry";
import {
  attemptDailyGrowthPass,
  supportsDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "./daily-checkin";

export interface QuotaRefreshSweepDeps extends QuotaRefreshDeps {
  /** Lists credential-bearing accounts; the default excludes credential-less rows. */
  readonly listTargets?: () => Promise<readonly QuotaRefreshTarget[]>;
  /** Maximum accounts in one completed wave. Defaults to 5. */
  readonly maxConcurrency?: number;
  /** Per-account credential cache, keyed by account id. Defaults to a shared module cache (W3). */
  readonly credentialCache?: Map<string, string>;
  /** Skip accounts whose cached value is younger than this. Defaults to 4 min. */
  readonly minAgeMs?: number;
  /** Cap on accounts attempted per pass, so one pass cannot run unbounded. Defaults to 40. */
  readonly maxPerPass?: number;
  /** Cap on the whole pass; remaining accounts are picked up next tick. Defaults to 90s. */
  readonly passBudgetMs?: number;
  /** Bounded per-pass cap on daily check-ins; `0` disables the ride-along. */
  readonly maxCheckinsPerPass?: number;
  /** Injectable fetch for the check-in ride-along (tests). */
  readonly checkinFetcher?: typeof fetch;
  /**
   * Builds the fetch the check-in ride-along uses for one account.
   *
   * The sweep passes this down so the check-in can rotate egress per account
   * (a different proxy per account when pools are available) instead of
   * sharing one direct `globalThis.fetch` for every account. Absent means
   * direct egress, which is what `attemptDailyGrowthPass` already does.
   */
  readonly checkinFetcherFor?: (
    accountId: string,
    tenantId?: string | null,
  ) => ValidatedFetch | Promise<ValidatedFetch>;
  readonly now?: () => number;
  readonly onTick?: (result: {
    readonly targets: number;
    readonly attempted: number;
    readonly skipped: number;
    readonly failed: number;
    /** Daily check-ins attempted in this pass. */
    readonly checkins: number;
  }) => void;
}
const DEFAULT_MAX_CHECKINS_PER_PASS = 10;

/**
 * Last line emitted per account. The sweep runs every minute over dozens of
 * accounts, and most outcomes ("quota ok, daily already claimed") repeat
 * verbatim every pass — printing them all buries the one line that matters.
 * An account is re-announced only when its outcome actually changes.
 *
 * Module scope, not per-call: suppression must survive across passes, and one
 * `quotaRefreshSweep` call is one pass. Tests reset it via
 * `resetSweepLogMemory`.
 */
const lastSweepLine = new Map<string, string>();

/**
 * Shared per-account credential cache, keyed by account id (W3).
 *
 * Module scope, like `lastSweepLine` above: the point is reuse *across*
 * passes. The sweep resolves the same accounts every 60s and credentials
 * rotate rarely, so without this the quota leg re-decrypts every credential
 * once per pass while the check-in leg inside the same pass resolves it
 * again for the same account. A pass that touched a credential change still
 * sees it, because the credential resolver carries its own freshness
 * (OAuth refresh is proactive through `OAuthRefreshService`) and a process
 * restart starts from an empty cache anyway.
 */
const sharedCredentialCache = new Map<string, string>();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Test-only: forget suppression state between tests. */
export function resetSweepLogMemory(): void {
  lastSweepLine.clear();
}

/** `provider/identity` — the account's own label, else its id. */
function accountName(target: QuotaRefreshTarget): string {
  const label = (target.label ?? "").trim();
  return `${target.providerId}/${label.length > 0 ? label : target.accountId}`;
}

/** Human-readable quota result. */
function quotaPhrase(outcome: QuotaRefreshOutcome): string {
  const error = outcome.quota.error;
  if (error === null) {
    const window = outcome.quota.windows.find((w) => w.usedPercent !== null);
    return window === undefined
      ? "quota ok"
      : `quota ok (${window.label} ${Math.round(window.usedPercent as number)}% used)`;
  }
  return `quota failed: ${error}`;
}

/**
 * Daily check-in outcome for the log line, or `null` when this account has
 * nothing to report.
 *
 * Only providers that expose the check-in route appear here at all: the sweep
 * skips the rest, and `daily unsupported` on every non-WorkBuddy account was
 * pure noise. The routine "nothing to claim today" states collapse to one
 * short phrase so the line stays scannable; only a real grant or a failure
 * carries detail. The report half appends only when it says something the
 * check-in half did not already say.
 */
function checkinPhrase(
  result: DailyCheckinResult | undefined,
  report: BuddyActivityReportResult | undefined,
): string | null {
  if (result === undefined) return null;
  let phrase: string;
  switch (result.state) {
    case "claimed": {
      const credit = result.credit !== null ? ` +${result.credit}` : "";
      const streak = result.streakDays !== null ? ` (streak ${result.streakDays})` : "";
      phrase = `daily claimed${credit}${streak}`;
      break;
    }
    case "already_claimed":
      phrase = "daily ok";
      break;
    case "not_eligible":
      phrase = "daily not eligible";
      break;
    case "event_ended":
      phrase = "daily ended";
      break;
    case "unavailable":
      phrase = "daily unavailable";
      break;
    case "error":
      phrase = `daily failed: ${result.error ?? "unknown error"}`;
      break;
  }
  if (report !== undefined) {
    if (report.state === "reported") phrase += ", activity reported";
    else if (report.state === "error" && report.error !== "Skipped (check-in failed).") {
      phrase += `, activity failed: ${report.error ?? "unknown error"}`;
    }
  }
  return phrase;
}

/**
 * Emits one line per attempted account, then a single pass summary when
 * anything needs attention. Level is `info` so the line survives the
 * production `LOG_LEVEL` (a `debug` sweep line is invisible in the console).
 */
function logSweepAccounts(
  attempted: readonly QuotaRefreshTarget[],
  quotaOutcomes: ReadonlyMap<string, QuotaRefreshOutcome>,
  checkinOutcomes: ReadonlyMap<string, DailyCheckinResult>,
  reportOutcomes: ReadonlyMap<string, BuddyActivityReportResult>,
  failed: number,
  claimed: number,
): void {
  for (const target of attempted) {
    const outcome = quotaOutcomes.get(target.accountId);
    if (outcome === undefined) continue;
    const result = checkinOutcomes.get(target.accountId);
    const parts = [quotaPhrase(outcome)];
    const checkin = checkinPhrase(result, reportOutcomes.get(target.accountId));
    if (checkin !== null) parts.push(checkin);
    const line = `${accountName(target)} ${parts.join(", ")}`;

    if (lastSweepLine.get(target.accountId) === line) continue;
    lastSweepLine.set(target.accountId, line);

    // A failed quota fetch or a failed check-in is operator-actionable.
    if (outcome.failure !== null || result?.state === "error") {
      log.warn(`[Quota-refresh] ${line}`);
    } else {
      log.info(`[Quota-refresh] ${line}`);
    }
  }

  // Only the interesting passes get a summary: an all-green pass that changed
  // nothing is already fully described by the lines above.
  if (failed > 0 || claimed > 0) {
    log.info(
      `[Quota-refresh] pass done: ${attempted.length} attempted, ${failed} quota failed, ${claimed} daily claimed`,
    );
  }
}

const DEFAULT_MIN_AGE_MS = 4 * 60_000;
const DEFAULT_MAX_PER_PASS = 40;
const DEFAULT_PASS_BUDGET_MS = 90_000;

/**
 * One non-overlapping quota sweep. Never rejects out of the timer path: the
 * task registry treats a rejection as a backstop, not a channel, so every
 * failure here is isolated and counted.
 *
 * Ordering is by cache age (oldest first). Eligible accounts run in completed
 * waves of 2, then 3, then 4, then 5 (or the configured maximum); the next
 * wave does not start until the previous wave has fully settled.
 */
export async function quotaRefreshSweep(deps: QuotaRefreshSweepDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const minAgeMs = deps.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const maxPerPass = Math.max(1, deps.maxPerPass ?? DEFAULT_MAX_PER_PASS);
  // One cache for the whole pass: the quota leg resolves the credential and
  // the check-in ride-along reuses it for the same account instead of
  // fetching it twice (W3).
  const credentialCache = deps.credentialCache ?? sharedCredentialCache;
  const resolveCredentialCached = async (
    providerId: ProviderId,
    accountId: string,
  ): Promise<string> => {
    const cached = credentialCache.get(accountId);
    if (cached !== undefined) return cached;
    const secret = await deps.resolveCredential(providerId, accountId);
    credentialCache.set(accountId, secret);
    return secret;
  };

  let failed = 0;
  let claimed = 0;
  let checkins = 0;
  const maxCheckins = deps.maxCheckinsPerPass ?? DEFAULT_MAX_CHECKINS_PER_PASS;

  /**
   * One log line per account, emitted after the wave completes so the quota
   * result and the check-in ride-along land together instead of as two
   */
  const quotaOutcomes = new Map<string, QuotaRefreshOutcome>();
  const checkinOutcomes = new Map<string, DailyCheckinResult>();
  const reportOutcomes = new Map<string, BuddyActivityReportResult>();
  const attemptedTargets: QuotaRefreshTarget[] = [];

  const result = await runSweep<{ target: QuotaRefreshTarget; ageMs: number }>({
    name: "quota-refresh",
    list: async () => {
      const targets = deps.listTargets
        ? await deps.listTargets()
        : await listQuotaRefreshTargets(deps.db);
      // Read cache ages in one batched pass per lens: the sweep runs over
      // dozens of accounts each minute, so a `get` per account made the age
      // scan's latency scale with the account count. `getCachedQuotaEntries`
      // is the cache's own batched reader, so the key format stays owned by
      // the cache module.
      const byLens = new Map<string, QuotaRefreshTarget[]>();
      for (const target of targets) {
        const lens = targetLens(target);
        const group = byLens.get(lens);
        if (group) group.push(target);
        else byLens.set(lens, [target]);
      }
      const cachedByAccount = new Map<string, CachedQuotaEntry | null>();
      for (const [lens, group] of byLens) {
        try {
          const entries = await getCachedQuotaEntries(
            lens,
            group.map((target) => target.accountId),
            deps.redis,
          );
          for (const target of group) {
            cachedByAccount.set(target.accountId, entries.get(target.accountId) ?? null);
          }
        } catch {
          // An unreadable cache reads as "due" for every account in the lens,
          // which is the safe direction.
          for (const target of group) cachedByAccount.set(target.accountId, null);
        }
      }
      const nowMs = now();
      return targets.map((target) => {
        const cached = cachedByAccount.get(target.accountId) ?? null;
        const fetchedAt = cached?.fetchedAt;
        return {
          target,
          ageMs:
            typeof fetchedAt === "string"
              ? nowMs - new Date(fetchedAt).getTime()
              : Number.POSITIVE_INFINITY,
        };
      });
    },
    eligible: async (entry) => {
      // Collectorless providers intentionally have no quota surface; do not
      // turn their key-only accounts into recurring quota failures.
      try {
        const collector = await deps.providerRegistry.resolveQuotaCollector(entry.target.providerId);
        if (collector === undefined) return false;
      } catch {
        return false;
      }
      // API-key/JWT accounts use the stored credential directly; OAuth
      // accounts need a provider refresher before their quota can be read.
      if (entry.target.credentialKind === "api_key") return true;
      try {
        return (await deps.providerRegistry.resolveRefresher(entry.target.providerId)) !== undefined;
      } catch {
        return false;
      }
    },
    // Oldest first, capped so one pass cannot run unbounded. Fresh accounts
    // are dropped as skips rather than carried into the wave.
    select: (entries) => {
      const due = entries.filter((entry) => entry.ageMs >= minAgeMs);
      due.sort((left, right) => right.ageMs - left.ageMs);
      const batch = due.slice(0, maxPerPass);
      return { batch, skipped: entries.length - due.length + (due.length - batch.length) };
    },
    run: async (entry) => {
      attemptedTargets.push(entry.target);
      const outcome = await refreshAccountQuota(
        // The sweep already resolved this account's credential for the
        // check-in leg; hand the quota leg the same cached resolver so one
        // account costs one resolution per pass, not two (W3).
        { ...deps, resolveCredential: resolveCredentialCached },
        entry.target,
        signalFetch(AbortSignal.timeout(QUOTA_REFRESH_TIMEOUT_MS)),
      );
      quotaOutcomes.set(entry.target.accountId, outcome);
      // A fetch that threw is still a failure the operator must see, so it is
      // recorded as one rather than silently counted.
      if (outcome.failure !== null) {
        failed += 1;
        return;
      }
      // Daily growth ride-along: the same item's freshly resolved credential,
      // check-in claim first and then the growth-activity report. Bounded per
      // pass, and skipped for providers without the billing route — a day
      // marker makes this a no-op on every pass after the first of the day.
      if (maxCheckins <= 0 || checkins >= maxCheckins) return;
      if (!supportsDailyCheckin(entry.target.providerId)) return;
      try {
        // `ValidatedFetch` is call-compatible with `typeof fetch`; the cast
        // is only for the `preconnect` static Bun adds to its own fetch (the
        // same cast the adapters use for `outbound_fetch`).
        const pooled = deps.checkinFetcherFor
          ? ((await deps.checkinFetcherFor(
              entry.target.accountId,
              entry.target.tenantId,
            )) as unknown as typeof fetch)
          : undefined;
        const fetcher = pooled ?? deps.checkinFetcher;
        const pass = await attemptDailyGrowthPass({
          redis: deps.redis,
          providerId: entry.target.providerId as ProviderId,
          accountId: entry.target.accountId,
          resolveCredential: resolveCredentialCached,
          ...(fetcher ? { fetcher } : {}),
        });
        if (pass !== null) {
          checkins += 1;
          if (pass.checkin.state === "claimed") claimed += 1;
          checkinOutcomes.set(entry.target.accountId, pass.checkin);
          reportOutcomes.set(entry.target.accountId, pass.report);
        }
      } catch (error) {
        checkinOutcomes.set(entry.target.accountId, {
          providerId: entry.target.providerId,
          accountId: entry.target.accountId,
          state: "error",
          credit: null,
          streakDays: null,
          error: getErrorMessage(error),
        });
      }
    },
    onItemError: (entry, error) => {
      failed += 1;
      quotaOutcomes.set(entry.target.accountId, {
        quota: {
          source: entry.target.providerId,
          plan: null,
          windows: [],
          error: getErrorMessage(error),
        },
        failure: "quota_fetch_failed",
      });
    },
    maxConcurrency: deps.maxConcurrency,
    budgetMs: deps.passBudgetMs ?? DEFAULT_PASS_BUDGET_MS,
    now,
  });

  logSweepAccounts(attemptedTargets, quotaOutcomes, checkinOutcomes, reportOutcomes, failed, claimed);
  // A pass that could not even list its targets reports no tick: an all-zero
  // tick would read as "nothing was due" rather than "nothing was reachable".
  if (result.aborted) return;
  deps.onTick?.({
    targets: result.listed,
    attempted: result.attempted,
    skipped: result.skipped,
    failed,
    checkins,
  });
}
