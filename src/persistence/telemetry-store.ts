import { sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./postgres";
import {
  telemetryEvents,
  telemetryPayloads,
  telemetryUsageTotals,
  type TelemetryUsageIdentityType,
} from "./schema";
import { isGatewayError } from "../observability/telemetry-status";

interface UsageTotalDelta {
  readonly tenantId: string;
  readonly identityType: TelemetryUsageIdentityType;
  readonly entityId: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

function addUsageDelta(
  deltas: Map<string, UsageTotalDelta>,
  row: typeof telemetryEvents.$inferInsert,
  identityType: TelemetryUsageIdentityType,
  entityId: string | null | undefined,
): void {
  if (entityId == null) return;
  const key = `${row.tenantId}\0${identityType}\0${entityId}`;
  let delta = deltas.get(key);
  if (!delta) {
    delta = {
      tenantId: row.tenantId,
      identityType,
      entityId,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    deltas.set(key, delta);
  }
  delta.requests += 1;
  // Same definition as every read-side error count, including the HTTP-status
  // exclusions (404/499/503): this rollup is durable, so a request counted here
  // stays counted after its raw row is pruned and cannot be corrected later.
  if (isGatewayError(row.status, row.httpStatus)) delta.errors += 1;
  delta.inputTokens += row.inputTokens ?? 0;
  delta.outputTokens += row.outputTokens ?? 0;
}

function aggregateUsage(rows: readonly (typeof telemetryEvents.$inferInsert)[]) {
  const deltas = new Map<string, UsageTotalDelta>();
  for (const row of rows) {
    addUsageDelta(deltas, row, "account", row.accountId);
    addUsageDelta(deltas, row, "api_key", row.apiKeyId);
  }
  return [...deltas.values()];
}

/**
 * Database boundary for durable telemetry writes and bounded retention cleanup.
 * The observability buffer owns queueing and retry policy; this store owns table
 * operations, lifetime aggregates, and retention.
 */
export class DrizzleTelemetryStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  /** Inserts events and their durable identity aggregates atomically. */
  async insertEvents(rows: Array<typeof telemetryEvents.$inferInsert>): Promise<void> {
    if (rows.length === 0) return;
    const deltas = aggregateUsage(rows);
    await this.db.transaction(async (tx) => {
      await tx.insert(telemetryEvents).values(rows);
      if (deltas.length === 0) return;
      const now = new Date();
      await tx
        .insert(telemetryUsageTotals)
        .values(deltas.map((delta) => ({ ...delta, lastUsedAt: now })))
        .onConflictDoUpdate({
          target: [
            telemetryUsageTotals.tenantId,
            telemetryUsageTotals.identityType,
            telemetryUsageTotals.entityId,
          ],
          set: {
            requests: sql`${telemetryUsageTotals.requests} + excluded.requests`,
            errors: sql`${telemetryUsageTotals.errors} + excluded.errors`,
            inputTokens: sql`${telemetryUsageTotals.inputTokens} + excluded.input_tokens`,
            outputTokens: sql`${telemetryUsageTotals.outputTokens} + excluded.output_tokens`,
            lastUsedAt: sql`greatest(${telemetryUsageTotals.lastUsedAt}, excluded.last_used_at)`,
            updatedAt: sql`now()`,
          },
        });
    });
  }

  /** Inserts one redacted payload and returns its generated identity. */
  async insertPayload(
    row: typeof telemetryPayloads.$inferInsert,
  ): Promise<{ id: string; expiresAt: Date }> {
    const [inserted] = await this.db
      .insert(telemetryPayloads)
      .values(row)
      .returning({ id: telemetryPayloads.id, expiresAt: telemetryPayloads.expiresAt });
    if (!inserted) throw new Error("payload capture insert returned no row");
    return inserted;
  }

  /**
   * Deletes at most one bounded batch of expired payloads in a single
   * statement, so concurrent sweeps atomically claim disjoint rows and the
   * returned count matches the rows actually deleted.
   */
  async deleteExpiredPayloads(batchSize = 5000, before = new Date()): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${telemetryPayloads}
      WHERE ${telemetryPayloads.id} IN (
        SELECT ${telemetryPayloads.id} FROM ${telemetryPayloads}
        WHERE ${telemetryPayloads.expiresAt} < ${before}
        ORDER BY ${telemetryPayloads.expiresAt}
        LIMIT ${batchSize}
      )
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Deletes at most one bounded batch of aged events in a single statement, so
   * concurrent sweeps atomically claim disjoint rows and the returned count
   * matches the rows actually deleted. Ordered by `created_at`, which
   * `idx_telemetry_created_at` backs.
   */
  async deleteExpiredEvents(batchSize = 5000, before: Date): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${telemetryEvents}
      WHERE ${telemetryEvents.id} IN (
        SELECT ${telemetryEvents.id} FROM ${telemetryEvents}
        WHERE ${telemetryEvents.createdAt} < ${before}
        ORDER BY ${telemetryEvents.createdAt}
        LIMIT ${batchSize}
      )
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Deletes telemetry older than the supplied cutoff. Payloads follow their
   * `expires_at` contract (15 minutes per row) rather than capture time.
   *
   * Events are pruned in bounded batches rather than one `DELETE`, because
   * `telemetry_events` is the highest-volume table and a single statement
   * covering every aged row grows without limit: it holds locks and WAL for the
   * whole sweep, and on a deployment that has run for months it can exceed the
   * pool's `statement_timeout` and be cancelled, so the sweep never converges
   * and retention silently stops working. Each batch commits independently, so
   * progress survives a cancel or a restart. The loop is bounded so one pass
   * cannot run unbounded — a backlog drains over successive sweeps — mirroring
   * the payload sweeper's `cleanupExpired`.
   */
  async pruneTelemetry(before: Date): Promise<void> {
    const MAX_BATCHES_PER_SWEEP = 40;
    for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
      const deleted = await this.deleteExpiredEvents(5000, before);
      if (deleted < 5000) break;
    }
    await this.deleteExpiredPayloads(5000, before);
  }
}
