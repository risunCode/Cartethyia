// Daily check-in ride-along.
//
// WorkBuddy/CodeBuddy grant a free credit package once per calendar day. This
// claims it for every stored account and logs one line per account, so an
// operator can confirm each account got its daily login credit.
//
// It deliberately has no timer of its own: it rides along with the quota
// refresh sweep (`quota-refresh-worker.ts`), which already resolves a fresh
// credential for each account every few minutes. Adding a second scheduled
// task would just duplicate that credential work for a once-a-day action.
//
// Budget is one attempt per account per day. A Redis day marker reserves the
// right to attempt, so a restart cannot double-post; the marker is released
// again when the attempt errors, so a transient failure retries on a later
// pass instead of forfeiting that day's grant.
//

import { and, eq } from "drizzle-orm";
import type { RedisClient } from "../persistence/redis";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { dailyCheckinLedger } from "../persistence/schema";
import type { ProviderId } from "../providers/contracts";
import { log } from "../observability/logger";
import { buddyAccountUid } from "../providers/integrations/buddy/buddy-oauth-shared";
import {
  DAILY_CHECKIN_PROVIDER_IDS,
  checkinDayKey,
  fetchBuddyActivityReport,
  fetchDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "../providers/integrations/buddy/buddy-checkin";

export { DAILY_CHECKIN_PROVIDER_IDS, checkinDayKey };
export type { BuddyActivityReportResult, DailyCheckinResult };

const LEDGER_KEY_PREFIX = "cartethyia:daily-checkin";
/**
 * Ledger TTL. The key is already scoped to one calendar day, so the TTL only
 * needs to outlive that day; three days covers any timezone/clock skew without
 * relying on the key expiring for correctness.
 */
const LEDGER_TTL_SECONDS = 3 * 24 * 60 * 60;

/** The day-marker key for one account. Exported so the console reads the same key the sweep writes. */
export function ledgerKey(dayKey: string, accountId: string): string {
  return `${LEDGER_KEY_PREFIX}:${dayKey}:${accountId}`;
}

/**
 * True when this pass won the account's day slot and must do the work.
 *
 * Two guards, because the deployment shape decides which one is authoritative.
 * With Redis the `SET NX EX` is the cross-process guard (two gateway instances
 * cannot both attempt the same account). Without it the ledger *table* is the
 * guard, and its composite PK makes the insert atomic — so Lite records the
 * attempt it just made instead of silently returning `true`, which is what left
 * the console unable to answer "attempted today" and showing "Check-in due"
 * forever.
 */
async function reserveDaySlot(
  db: CartethyiaDatabase | undefined,
  redis: RedisClient | undefined,
  dayKey: string,
  accountId: string,
): Promise<boolean> {
  if (redis === undefined) {
    if (db === undefined) {
      // No ledger at all: one process needs no distributed guard, so the slot is
      // always won and the sweep's once-a-day cadence is the only throttle.
      return true;
    }
    try {
      await db
        .insert(dailyCheckinLedger)
        .values({ dayKey, accountId })
        .onConflictDoNothing();
      return true;
    } catch (error) {
      // A failed ledger write must not stop the claim: the day marker is only
      // bookkeeping, and losing it costs a possible duplicate claim tomorrow
      // rather than forfeiting today's grant.
      log.warn(`[daily-checkin] ledger reserve failed for account=${accountId}`, error as Error);
      return true;
    }
  }
  const set = await redis.set(ledgerKey(dayKey, accountId), "1", "EX", LEDGER_TTL_SECONDS, "NX");
  return set !== null;
}

/**
 * Releases today's slot so a later pass can retry.
 *
 * Only transient outcomes release: `error` is a network/5xx failure and
 * `unavailable` means the probe could not be read — both are worth another
 * attempt, and holding the slot until tomorrow is what made an account look
 * "done" when nothing had been claimed. Terminal states keep the slot.
 */
async function releaseDaySlot(
  db: CartethyiaDatabase | undefined,
  redis: RedisClient | undefined,
  dayKey: string,
  accountId: string,
): Promise<void> {
  if (redis !== undefined) {
    await redis.del(ledgerKey(dayKey, accountId)).catch(() => undefined);
    return;
  }
  if (db === undefined) return;
  try {
    await db
      .delete(dailyCheckinLedger)
      .where(
        and(
          eq(dailyCheckinLedger.dayKey, dayKey),
          eq(dailyCheckinLedger.accountId, accountId),
        ),
      );
  } catch (error) {
    log.warn(`[daily-checkin] ledger release failed for account=${accountId}`, error as Error);
  }
}

/** Providers whose billing facade exposes the daily check-in routes. */
export function supportsDailyCheckin(providerId: string): boolean {
  return (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export type DailyGrowthPassResult = {
  readonly checkin: DailyCheckinResult;
  readonly report: BuddyActivityReportResult;
};

/**
 * Runs the full daily growth pass for one account: check-in claim first, then
 * (buddy only) the growth-activity report — same order as the dashboard's
 * growth button.
 *
 * The day slot is reserved here, so a caller cannot double-claim. The report
 * leg exists only for the buddy family, so any other provider's pass is the
 * check-in alone and the report field carries a "not supported" marker rather
 * than a fabricated success. The report fires only when the check-in step does
 * not hard-fail — reporting activity for an account whose credential just died
 * is noise at best. A report-side failure never releases the day slot: the
 * credit grant is the valuable half, and a failed report retries tomorrow
 * rather than spinning every sweep pass today.
 *
 * Returns `null` when no slot could be reserved (already settled today).
 */
export async function attemptDailyGrowthPass(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly providerId: ProviderId;
  readonly accountId: string;
  /** Refresh-aware credential resolution (the quota sweep's own resolver). */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}): Promise<DailyGrowthPassResult | null> {
  const { db, redis, providerId, accountId, resolveCredential } = args;
  const dayKey = checkinDayKey(args.now?.() ?? new Date());

  let reserved = false;
  try {
    reserved = await reserveDaySlot(db, redis, dayKey, accountId);
  } catch (error) {
    log.warn(`[daily-checkin] ledger unavailable for account=${accountId}`, error as Error);
    reserved = true;
  }
  if (!reserved) return null;

  let credential = "";
  try {
    credential = await resolveCredential(providerId, accountId);
  } catch (error) {
    await releaseDaySlot(db, redis, dayKey, accountId);
    return {
      checkin: {
        providerId,
        accountId,
        state: "error",
        credit: null,
        streakDays: null,
        error: error instanceof Error ? error.message : "Daily check-in failed.",
      },
      report: {
        providerId,
        accountId,
        state: "error",
        error: "Skipped (check-in failed).",
      },
    };
  }

  let checkin: DailyCheckinResult;
  try {
    checkin = await fetchDailyCheckin({
      providerId,
      accountId,
      credential,
      fetcher: args.fetcher ?? globalThis.fetch,
    });
  } catch (error) {
    checkin = {
      providerId,
      accountId,
      state: "error",
      credit: null,
      streakDays: null,
      error: error instanceof Error ? error.message : "Daily check-in failed.",
    };
  }

  if (checkin.state === "error" || checkin.state === "unavailable") {
    // Release the slot so a later pass today can retry. `error` is a transient
    // failure (network, 5xx); `unavailable` is the status probe answering that
    // no activity is running or the envelope could not be read — both are
    // worth another attempt, and holding the slot until tomorrow is what made
    // an account look "done" when nothing had been claimed. `already_claimed`,
    // `not_eligible`, and `event_ended` are terminal for the day and keep it.
    await releaseDaySlot(db, redis, dayKey, accountId);
    return {
      checkin,
      report: { providerId, accountId, state: "error", error: "Skipped (check-in failed)." },
    };
  }

  // The growth event scores by uid, and only a JWT carries one. An opaque API
  // key fails closed here — the sweep must never report one account's activity
  // under another account's uid.
  const userId = buddyAccountUid(credential);
  if (!userId) {
    return {
      checkin,
      report: {
        providerId,
        accountId,
        state: "error",
        error: "Skipped (no uid in this credential).",
      },
    };
  }

  let report: BuddyActivityReportResult;
  try {
    report = await fetchBuddyActivityReport({
      providerId,
      accountId,
      credential,
      userId,
      fetcher: args.fetcher ?? globalThis.fetch,
    });
  } catch (error) {
    report = {
      providerId,
      accountId,
      state: "error",
      error: error instanceof Error ? error.message : "Activity report failed.",
    };
  }
  return { checkin, report };
}

