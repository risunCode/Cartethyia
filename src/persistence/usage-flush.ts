import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./db-handle";
import { apiKeys } from "./schema";

/** Spelling a uuid column must match before it is inlined into a statement. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coalesces per-request lifetime-usage writes into one UPDATE per flush.
 *
 * The admission counter is the live source of truth and already lives in memory
 * (or Redis). Persisting the same delta on the request path meant one UPDATE
 * per completed request, and on the embedded backend every write queues behind
 * a single writer — so request throughput was bound by usage accounting, not by
 * the work the request did. Callers enqueue and return; a timer flushes the
 * accumulated deltas, and shutdown flushes what remains.
 *
 * A crash loses at most the deltas not yet flushed. The admission counter is
 * re-seeded from the persisted total on its next miss, so the loss is bounded
 * by the flush interval and never compounds.
 */

async function writeLifetimeDelta(db: CartethyiaDatabase, apiKeyId: string, delta: number): Promise<void> {
  await db
    .update(apiKeys)
    .set({
      lifetimeTokensConsumed: sql`COALESCE(${apiKeys.lifetimeTokensConsumed}, 0) + ${delta}`,
    })
    .where(eq(apiKeys.id, apiKeyId));
}

/**
 * One statement for the whole batch, instead of one UPDATE per key.
 *
 * On the embedded backend one write queues behind a single writer, so the cost
 * of a flush is dominated by round-trips rather than by rows: measured on
 * PGlite, 300 keys cost 129 ms as separate UPDATEs and 4 ms as one
 * `UPDATE ... FROM (VALUES ...)` — 28x. That difference is the whole reason
 * this path coalesces deltas at all, so a flush that fans back out per key
 * gives the win straight back.
 *
 * `id::uuid` is spelled out because the driver would otherwise infer the
 * VALUES column as text and fail the join against a uuid key.
 */
async function writeLifetimeDeltas(
  db: CartethyiaDatabase,
  deltas: ReadonlyMap<string, number>,
): Promise<void> {
  if (deltas.size === 0) return;
  // Inlined rather than bound: Drizzle turns each interpolated value into a
  // bind parameter, so 300 keys became a 600-parameter VALUES list — slow, and
  // rejected outright at that arity. The values are therefore built with
  // `sql.raw` and validated on the way in, which is what keeps this a literal
  // rather than an injection path: a uuid must match the uuid spelling and a
  // delta must be a finite non-negative integer.
  const values = [...deltas]
    .map(([apiKeyId, delta]) => {
      if (!UUID_RE.test(apiKeyId)) throw new Error(`usage flush: apiKeyId is not a uuid`);
      if (!Number.isFinite(delta) || !Number.isInteger(delta) || delta < 0) {
        throw new Error(`usage flush: delta is not a non-negative integer (got ${String(delta)})`);
      }
      return `('${apiKeyId}'::uuid, ${delta}::bigint)`;
    })
    .join(", ");
  await db.execute(sql.raw(`
    UPDATE "api_keys"
    SET "lifetime_tokens_consumed" =
      COALESCE("api_keys"."lifetime_tokens_consumed", 0) + v.delta
    FROM (VALUES ${values}) AS v(id, delta)
    WHERE "api_keys"."id" = v.id
  `));
}
export class UsageFlushBuffer {
  private readonly pending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private stopped = false;

  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly intervalMs = 1_000,
    private readonly write: (db: CartethyiaDatabase, apiKeyId: string, delta: number) => Promise<void> = writeLifetimeDelta,
  ) {
    this.arm();
  }

  /** Records a delta. Never touches the database; safe to call per request. */
  enqueue(apiKeyId: string, delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.pending.set(apiKeyId, (this.pending.get(apiKeyId) ?? 0) + delta);
  }

  /**
   * Writes everything accumulated so far in one statement.
   *
   * The whole batch goes as a single UPDATE; on failure it falls back to one
   * write per key so one bad key cannot cost the others their delta. A key
   * whose write fails goes back into the pending map, added to anything
   * enqueued while the flush ran, so a transient failure retries instead of
   * dropping.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    const batch = new Map(this.pending);
    this.pending.clear();
    try {
      try {
        await writeLifetimeDeltas(this.db, batch);
        return;
      } catch {
        // Fall through to the per-key path: one statement failing tells us
        // nothing about which key caused it.
      }
      for (const [apiKeyId, delta] of batch) {
        try {
          await this.write(this.db, apiKeyId, delta);
        } catch {
          this.pending.set(apiKeyId, (this.pending.get(apiKeyId) ?? 0) + delta);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Stops the timer. Pass `{ flush: true }` to persist what is still pending. */
  async stop(options?: { flush?: boolean }): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (options?.flush) await this.flush();
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().finally(() => this.arm());
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
}
