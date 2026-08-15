import { Database } from "bun:sqlite";

export type SqlValue = string | number | null

interface QueuedWrite {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

const FLUSH_THRESHOLD = 64;
const FLUSH_INTERVAL_MS = 20;
const FLUSH_RETRY_MS = 1_000;
const MAX_BUFFERED_WRITES = 256;
const FLUSH_BATCH_SIZE = 64;

export interface RuntimeTelemetryStats {
  readonly pendingWrites: number;
  readonly flushCount: number;
  readonly flushDurationMs: number;
  readonly flushBatchSize: number;
  readonly maxPendingWrites: number;
  readonly droppedWrites: number;
  readonly flushFailures: number;
}

export interface WriteBuffer { enqueue(sql: string, params: readonly SqlValue[]): void;
flush(): void;
pending(): number;
stats(): RuntimeTelemetryStats;
close(): void; }

export function createWriteBuffer(getDb: () => Database): WriteBuffer { let queue: QueuedWrite[] = [];
let flushTimer: Timer | null = null;
let retryTimer: Timer | null = null;
let closed = false;
let flushCount = 0;
let flushDurationMs = 0;
let flushBatchSize = 0;
let maxPendingWrites = 0;
let droppedWrites = 0;
let flushFailures = 0;

let preparedDb: Database | null = null;
const preparedStatements = new Map<string, { run(...params: SqlValue[]): unknown }>();

const statementFor = (db: Database, sql: string): { run(...params: SqlValue[]): unknown } => {
  if (preparedDb !== db) {
    preparedDb = db;
    preparedStatements.clear();
  }
  let statement = preparedStatements.get(sql);
  if (statement === undefined) {
    statement = db.query(sql);
    preparedStatements.set(sql, statement);
  }
  return statement;
};

const scheduleFlush = (delayMs = FLUSH_INTERVAL_MS): void => {
  if (flushTimer !== null) {
    if (delayMs !== 0) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, delayMs);
  flushTimer.unref?.();
};

const trimQueue = (): void => {
  if (queue.length <= MAX_BUFFERED_WRITES) return;
  const removed = queue.length - MAX_BUFFERED_WRITES;
  queue.splice(0, removed);
  droppedWrites += removed;
};

const flush = (): void => {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const batch = queue.splice(0, FLUSH_BATCH_SIZE);
  const startedAt = performance.now();
  try {
    const db = getDb();
    const applyBatch = db.transaction((rows: QueuedWrite[]) => {
      for (const row of rows) statementFor(db, row.sql).run(...row.params);
    });
    applyBatch(batch);
    flushCount += 1;
    flushDurationMs = Math.max(0, performance.now() - startedAt);
    flushBatchSize = batch.length;
    if (queue.length > 0) scheduleFlush(0);
  } catch {
    flushFailures += 1;
    queue = [...batch, ...queue];
    trimQueue();
    if (!closed && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flush();
      }, FLUSH_RETRY_MS);
      retryTimer.unref?.();
  }
  }
};

return {
  enqueue(sql: string, params: readonly SqlValue[]): void {
    if (closed) return;
    queue.push({ sql, params });
    maxPendingWrites = Math.max(maxPendingWrites, queue.length);
    trimQueue();
    scheduleFlush(queue.length >= FLUSH_THRESHOLD ? 0 : FLUSH_INTERVAL_MS);
  },
  flush,
  pending(): number {
    return queue.length;
  },
  stats(): RuntimeTelemetryStats {
    return { pendingWrites: queue.length, flushCount, flushDurationMs, flushBatchSize, maxPendingWrites, droppedWrites, flushFailures };
  },
  close(): void {
    closed = true;
    flush();
    queue = [];
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  },
}; }
