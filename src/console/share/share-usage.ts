// Aggregate usage for one API key, read by the public share page.
//
// The gateway's `api_keys` row stores only a lifetime token counter, so the
// daily/monthly windows are derived from telemetry as rolling 24h/30d sums
// rather than calendar-boundary resets. The share page compares them against
// the key's configured limits; the rolling window is an approximation of the
// quota period, not a claim of exact reset semantics.

import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { telemetryEvents } from "../../persistence/schema";

export interface ApiKeyUsage {
  readonly totalTokens: number;
  readonly totalRequests: number;
  readonly dailyTokens: number;
  readonly monthlyTokens: number;
  readonly successCount: number;
  readonly errorCount: number;
  /** ISO timestamp of the most recent telemetry row for this key, or null. */
  readonly lastUsedAt: string | null;
}

/** Telemetry reader needed by the public share page. */
export interface ShareUsagePort {
  /** Returns aggregate usage for one API key. */
  getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsage>;
}

const DAY_MS = 24 * 3_600_000;
const MONTH_MS = 30 * DAY_MS;

const EMPTY_USAGE: ApiKeyUsage = {
  totalTokens: 0,
  totalRequests: 0,
  dailyTokens: 0,
  monthlyTokens: 0,
  successCount: 0,
  errorCount: 0,
  lastUsedAt: null,
};

export function createShareUsagePort(db: CartethyiaDatabase): ShareUsagePort {
  return {
    async getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsage> {
      const now = Date.now();
      const dayStart = new Date(now - DAY_MS);
      const monthStart = new Date(now - MONTH_MS);
      const tokenSum = sql<number>`coalesce(sum(${telemetryEvents.inputTokens} + ${telemetryEvents.outputTokens}), 0)`;
      try {
        const [row] = await db
          .select({
            totalTokens: tokenSum,
            totalRequests: sql<number>`count(*)`,
            successCount: sql<number>`count(*) filter (where ${telemetryEvents.status} = 'completed')`,
            errorCount: sql<number>`count(*) filter (where ${telemetryEvents.status} = 'failed')`,
            dailyTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens} + ${telemetryEvents.outputTokens}) filter (where ${telemetryEvents.createdAt} >= ${dayStart}), 0)`,
            monthlyTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens} + ${telemetryEvents.outputTokens}) filter (where ${telemetryEvents.createdAt} >= ${monthStart}), 0)`,
            lastUsedAt: sql<Date | null>`max(${telemetryEvents.createdAt})`,
          })
          .from(telemetryEvents)
          .where(eq(telemetryEvents.apiKeyId, apiKeyId));
        return {
          totalTokens: Number(row?.totalTokens ?? 0),
          totalRequests: Number(row?.totalRequests ?? 0),
          successCount: Number(row?.successCount ?? 0),
          errorCount: Number(row?.errorCount ?? 0),
          dailyTokens: Number(row?.dailyTokens ?? 0),
          monthlyTokens: Number(row?.monthlyTokens ?? 0),
          lastUsedAt: row?.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
        };
      } catch {
        // A telemetry read failure must not take down the public share page;
        // the key metadata is still useful without usage numbers.
        return EMPTY_USAGE;
      }
    },
  };
}
