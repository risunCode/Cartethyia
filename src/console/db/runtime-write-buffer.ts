/**
 * Write-behind buffer for `runtime.sqlite` inserts. Every proxied request
 * used to commit up to 4 separate single-row writes there (request history +
 * detail + tool calls + a console log line) as 4 independent transactions -
 * each commit does a `synchronous=NORMAL` WAL flush. Benchmarked on a
 * typical dev disk: unbatched, that caps out around 1,700-3,800 req/sec;
 * queueing writes and committing them together in one transaction reaches
 * 10,000+ req/sec in the same benchmark - the headroom a 5k req/sec target
 * needs.
 *
 * Reads must go through `readRuntimeDb()` (or call `flushRuntimeWriteBuffer()`
 * directly first) so a request most just tracked is visible to
 * `/console/api/usage/*`/console-log hydration immediately, not only after
 * the next timed flush.
 */

import { getRuntimeDb } from "./runtime-client";

interface QueuedWrite {
  sql: string;
  params: (string | number | null)[];
}

const queue: QueuedWrite[] = [];
let flushTimer: Timer | null = null;

const FLUSH_INTERVAL_MS = 20;
const FLUSH_THRESHOLD = 200;

/** Queues an INSERT (or any statement without a caller-visible result) for the next batched commit. */
export function enqueueRuntimeWrite(sql: string, params: (string | number | null)[]): void {
  queue.push({ sql, params });
  if (queue.length >= FLUSH_THRESHOLD) {
    flushRuntimeWriteBuffer();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flushRuntimeWriteBuffer, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

/** Drains and commits every buffered write in one transaction. Safe to call when the queue is empty (no-op). Called periodically, before every read, and on graceful shutdown. */
export function flushRuntimeWriteBuffer(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  const db = getRuntimeDb();
  const applyBatch = db.transaction((rows: QueuedWrite[]) => {
    for (const row of rows) db.query(row.sql).run(...row.params);
  });
  applyBatch(batch);
}

/** Flushes pending writes, then returns the runtime db handle - use for every read so it observes writes queued moments earlier (read-your-writes). */
export function readRuntimeDb() {
  flushRuntimeWriteBuffer();
  return getRuntimeDb();
}

/** Test-only: drop anything queued without committing it (paired with closeRuntimeDbForTests, which points at a fresh isolated db). */
export function resetRuntimeWriteBufferForTests(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  queue.length = 0;
}
