import { lt, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./postgres";
import { telemetryEvents, telemetryPayloads } from "./schema";

/**
 * Database boundary for durable telemetry writes and bounded retention cleanup.
 * The observability buffer owns queueing and retry policy; this store owns only
 * table operations and retention.
 */
export class DrizzleTelemetryStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  /** Inserts one bounded batch of metadata events. */
  async insertEvents(rows: Array<typeof telemetryEvents.$inferInsert>): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(telemetryEvents).values(rows);
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
   * Deletes telemetry older than the supplied cutoff. Payloads follow their
   * `expires_at` contract (15 minutes per row) rather than capture time.
   */
  async pruneTelemetry(before: Date): Promise<void> {
    await this.db.delete(telemetryEvents).where(lt(telemetryEvents.createdAt, before));
    await this.db.delete(telemetryPayloads).where(lt(telemetryPayloads.expiresAt, before));
  }
}
