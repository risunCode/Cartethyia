import { eq } from "drizzle-orm";

import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { apiKeys } from "../../persistence/schema";
import { queryTelemetryEvents } from "../../observability/event-log";
import { utcDayStart, utcMonthStart } from "../shared/day";

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
  const spentSince = async (start: Date): Promise<number> => {
    const events = await queryTelemetryEvents({ apiKeyIds: keyIds, since: start });
    return events
      .reduce((sum, event) => sum + (event.inputTokens ?? 0) + (event.outputTokens ?? 0), 0);
  };
  const [daily, monthly] = await Promise.all([
    spentSince(utcDayStart(now)),
    spentSince(utcMonthStart(now)),
  ]);
  return { daily, monthly };
}
