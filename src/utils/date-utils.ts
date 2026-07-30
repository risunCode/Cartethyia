/**
 * Date utils — shared UTC timestamp/period helpers.
 *
 * Consolidates the timestamp formatting and period-offset math that used to
 * live inline in usage.ts and tracking/rotate.ts. All timestamps use the
 * "YYYY-MM-DD HH:MM:SS" space-separated shape the usage store relies on.
 */

/** Millisecond spans for the console usage periods — single source of truth. */
export const PERIOD_OFFSETS = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
} as const;

export type UsagePeriod = keyof typeof PERIOD_OFFSETS;

/** Format an epoch millisecond value as "YYYY-MM-DD HH:MM:SS" (UTC). */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** Current time as "YYYY-MM-DD HH:MM:SS" (UTC). */
export function utcNow(): string {
  return formatUtc(Date.now());
}

/** Date portion ("YYYY-MM-DD") of an ISO/space timestamp. */
export function utcDateOf(ts: string): string {
  return ts.slice(0, 10);
}

/** Start of a usage period as a "YYYY-MM-DD HH:MM:SS" (UTC) timestamp. */
export function periodStartUtc(period: UsagePeriod): string {
  return formatUtc(Date.now() - PERIOD_OFFSETS[period]);
}

/** "YYYY-MM-DD" date `days` in the past (UTC) — retention cutoff boundary. */
export function cutoffDate(days: number): string {
  return new Date(Date.now() - days * PERIOD_OFFSETS["24h"]).toISOString().slice(0, 10);
}
