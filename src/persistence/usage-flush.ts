import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./db-handle";
import { apiKeys } from "./schema";

/**
 * Coalesces per-request lifetime-usage writes into one UPDATE per key per flush.
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
   * Writes one UPDATE per key for everything accumulated so far. A key whose
   * write fails goes back into the pending map, added to anything enqueued
   * while the flush ran, so a transient failure retries instead of dropping.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    const batch = new Map(this.pending);
    this.pending.clear();
    try {
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
