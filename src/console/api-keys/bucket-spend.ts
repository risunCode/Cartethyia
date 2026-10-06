import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { apiKeys, telemetryEvents } from "../../persistence/schema";

/**
 * Tokens already recorded for the current daily and monthly admission buckets.
 *
 * The admission counters themselves are transient (Redis keys with a bucket
 * TTL), so when an operator adds a limit to a key that has already spent in the
 * current bucket, there is no counter to read. This reads the durable record —
 * telemetry — instead, which is what the bucket would have contained had the
 * limit existed all along.
 *
 * Buckets are UTC, matching `admission.ts` (`toISOString().slice(0, 10)` /
 * `slice(0, 7)`), so a seeded counter lines up with the one the reserve script
 * would have written.
 *
 * A share template's recipients admit under the parent id, and their spend is
 * attributed to their own child row, so the family is summed — otherwise
 * seeding a template would miss everything its recipients already used.
 */
export function utcDayStart(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

export function utcMonthStart(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`);
}

export async function familyBucketSpend(
  db: CartethyiaDatabase,
  keyId: string,
  now: Date,
): Promise<{ daily: number; monthly: number }> {
  const children = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.parentKeyId, keyId));
  const keyIds = [keyId, ...children.map((child) => child.id)];
  const tokens = sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`;
  const since = (start: Date) =>
    and(inArray(telemetryEvents.apiKeyId, keyIds), gte(telemetryEvents.createdAt, start));

  const [dailyRows, monthlyRows] = await Promise.all([
    db.select({ total: tokens }).from(telemetryEvents).where(since(utcDayStart(now))),
    db.select({ total: tokens }).from(telemetryEvents).where(since(utcMonthStart(now))),
  ]);
  return {
    daily: Number(dailyRows[0]?.total ?? 0),
    monthly: Number(monthlyRows[0]?.total ?? 0),
  };
}
