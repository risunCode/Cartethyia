// Telemetry buffer: coalesces per-request telemetry into batched multi-row inserts.
import { DrizzleTelemetryStore } from "../persistence/telemetry-store";
import type { CartethyiaDatabase } from "../persistence/postgres";
import { metrics } from "./metrics";
import { DEFAULT_BOUNDS } from "../transport/resources";
import { type SourceSurface, type UsageRecord } from "../transport/canonical-model";
import { log } from "./logger";

/**
 * Buffered durable telemetry writer. Coalesces per-request telemetry into
 * multi-row inserts so 1000 concurrent requests do not race the Postgres pool
 * with one `INSERT` each (Requirement: fair-share scale hardening).
 */

/**
 * Durable telemetry writer for the production executor. Inserts one row per
 * completed/failed/cancelled request into `telemetry_events`, which
 * `DrizzleObservabilityStore` (console Usage/ConsoleLog/health) already
 * reads. Metadata-only by default — no prompt/response body is ever
 * persisted here (the schema structurally excludes it).
 */
export interface TelemetryEventInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly sourceSurface: SourceSurface;
  readonly requestedModel: string;
  readonly endpoint?: string;
  readonly apiKeyId?: string;
  readonly userAgent?: string;
  readonly clientIp?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly networkPoolId?: string;
  readonly latencyMs?: number;
  readonly ttfbMs?: number;
  readonly stream: boolean;
  /** HTTP status returned to the client; absent on pre-migration rows. */
  readonly httpStatus?: number | undefined;
  readonly status: "completed" | "failed" | "cancelled" | "truncated";
  readonly errorCategory?: string;
  /** Layer that produced the failure; see the schema column's doc comment. */
  readonly errorOrigin?: string;
  readonly usage?: UsageRecord;
  readonly tokensPerSec?: number;
  readonly firstContentDeltaAtMs?: number;
  readonly lastEventAtMs?: number;
}

function tokenCountToInt(value: number | "unavailable" | undefined): number | undefined {
  return typeof value === "number" ? Math.round(value) : undefined;
}

/** Conservative byte estimate for queue accounting.
 *  Telemetry events contain only bounded scalar metadata; serializing every
 *  event just to measure queue size added a JSON allocation on every request.
 *  The fixed envelope deliberately overestimates structural JSON overhead. */
function estimateTelemetryEventBytes(event: TelemetryEventInput): number {
  const strings = [
    event.tenantId,
    event.requestId,
    event.sourceSurface,
    event.userAgent,
    event.clientIp,
    event.endpoint,
    event.apiKeyId,
    event.providerId,
    event.accountId,
    event.networkPoolId,
    event.errorCategory,
  ];
  let bytes = 512;
  for (const value of strings) {
    if (value !== undefined) bytes += Buffer.byteLength(value);
  }
  if (event.usage !== undefined) bytes += 128;
  return bytes;
}

/** Maps a durable event to its `telemetry_events` insert row for the
 * batched multi-row writer (`TelemetryBatchBuffer.drain`). */
function telemetryEventRow(event: TelemetryEventInput) {
  // Every column below has a live producer: `accountId`/`networkPoolId` flow
  // `ttfbMs` is measured by the model-probe path, and `usage` (including
  // `cachedInputTokens` stays — `health` aggregates it into the Overview
  // cache-hit rate.
  return {
    tenantId: event.tenantId,
    requestId: event.requestId,
    sourceSurface: event.sourceSurface,
    requestedModel: event.requestedModel,
    endpoint: event.endpoint ?? null,
    apiKeyId: event.apiKeyId ?? null,
    userAgent: event.userAgent ?? null,
    clientIp: event.clientIp ?? null,
    providerId: event.providerId ?? null,
    accountId: event.accountId ?? null,
    networkPoolId: event.networkPoolId ?? null,
    latencyMs: event.latencyMs ?? null,
    ttfbMs: event.ttfbMs ?? null,
    stream: event.stream,
    httpStatus: event.httpStatus ?? null,
    status: event.status,
    errorCategory: event.errorCategory ?? null,
    errorOrigin: event.errorOrigin ?? null,
    inputTokens: event.usage?.input_tokens ?? null,
    cachedInputTokens: tokenCountToInt(event.usage?.cached_input_tokens) ?? null,
    outputTokens: event.usage?.output_tokens ?? null,
    reasoningTokens: tokenCountToInt(event.usage?.reasoning_tokens) ?? null,
    estimatedCostUsd: event.usage ? String(event.usage.estimated_cost) : null,
    tokensPerSec: event.tokensPerSec != null ? String(event.tokensPerSec) : null,
    firstContentDeltaAtMs: event.firstContentDeltaAtMs ?? null,
    lastEventAtMs: event.lastEventAtMs ?? null,
  };
}

export interface TelemetryBatchBufferOptions {
  readonly flushIntervalMs?: number;
  readonly maxBatch?: number;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

/** Cooldown between `[telemetry] failed to record` log lines during a sustained drain outage. */
const DRAIN_OUTAGE_LOG_WINDOW_MS = 60_000;
/** Retry attempts per drain before the batch is dropped and the outage backoff grows. */
const DRAIN_MAX_ATTEMPTS = 5;
/** First retry delay; doubles per attempt up to {@link DRAIN_RETRY_MAX_MS}. */
const DRAIN_RETRY_BASE_MS = 25;
const DRAIN_RETRY_MAX_MS = 1_000;

import { exponentialBackoff, type BackoffOptions } from "../runtime/backoff";

/** Exponential retry delay for the `attempt`-th retry, clamped to the ceiling. */
function drainRetryDelayMs(attempt: number): number {
  const options: BackoffOptions = { baseDelayMs: DRAIN_RETRY_BASE_MS, maxDelayMs: DRAIN_RETRY_MAX_MS };
  return exponentialBackoff(attempt, options);
}

/** Floor for the adaptive active interval so a full queue still drains promptly. */
const ADAPTIVE_FLUSH_MIN_MS = 50;
/** Multiplier applied to the base interval while the queue is empty. */
const ADAPTIVE_IDLE_MULTIPLIER = 4;

/**
 * Adaptive scheduled-flush interval: an empty queue is polled rarely (fewer
 * wakeups under low load), while a queue filling toward `maxBatch` is drained
 * faster so batching never becomes a latency source under load. Pure so the
 * scheduling policy is unit-testable without timers.
 */
export function adaptiveFlushIntervalMs(
  baseMs: number,
  queueLength: number,
  maxBatch: number,
): number {
  if (queueLength <= 0) return baseMs * ADAPTIVE_IDLE_MULTIPLIER;
  const fill = Math.min(1, queueLength / Math.max(1, maxBatch));
  return Math.max(ADAPTIVE_FLUSH_MIN_MS, Math.round(baseMs * (1 - fill)));
}

export class TelemetryBatchBuffer {
  /**
   * One entry per queued event. `bytes` is a conservative enqueue-time
   * estimate reused for quota accounting and drain accounting. It avoids a
   * JSON serialization allocation on every request.
   */
  private readonly queue: Array<{ event: TelemetryEventInput; bytes: number }> = [];
  private readonly store: DrizzleTelemetryStore;
  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private flushing = false;
  private flushWait: Promise<void> = Promise.resolve();
  private lastDrainOutageAt = 0;
  private suppressedDrainOutages = 0;
  /** Consecutive fully-failed drains; drives the cross-drain outage backoff. */
  private drainFailureStreak = 0;
  /** Wall-clock gate that suppresses scheduled flush attempts while an outage backs off. */
  private drainBlockedUntil = 0;

  constructor(
    db: CartethyiaDatabase,
    opts: TelemetryBatchBufferOptions = {},
  ) {
    this.store = new DrizzleTelemetryStore(db);
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
    this.maxBatch = opts.maxBatch ?? 500;
    this.maxItems = opts.maxItems ?? 10000;
    this.maxBytes = opts.maxBytes ?? DEFAULT_BOUNDS.maxTelemetryQueueBytes;
    this.scheduleNextFlush(this.flushIntervalMs);
  }

  /**
   * Self-rescheduling flush timer. `setInterval` cannot adapt to load; this
   * picks the next delay from the current queue depth after every tick (see
   * {@link adaptiveFlushIntervalMs}). `unref` keeps a pending tick from
   * holding the event loop open past shutdown.
   */
  private scheduleNextFlush(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushScheduled().finally(() => {
        this.scheduleNextFlush(adaptiveFlushIntervalMs(this.flushIntervalMs, this.queue.length, this.maxBatch));
      });
    }, delayMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Non-blocking; drops the event (and counts it) when the buffer is full by count or bytes. */
  enqueue(event: TelemetryEventInput): void {
    const bytes = estimateTelemetryEventBytes(event);
    if (this.queue.length >= this.maxItems || this.queuedBytes + bytes > this.maxBytes) {
      metrics.cartethyia_telemetry_dropped_total.inc();
      return;
    }
    const wasEmpty = this.queue.length === 0;
    this.queue.push({ event, bytes });
    this.queuedBytes += bytes;
    metrics.cartethyia_telemetry_buffered.inc();
    if (this.queue.length >= this.maxBatch) {
      void this.flushScheduled();
    } else if (wasEmpty && this.timer !== undefined) {
      // A first event after an idle tick must not wait out the long idle
      // interval; re-arm at the base cadence.
      this.scheduleNextFlush(this.flushIntervalMs);
    }
  }

  /** Drains the buffer with a single multi-row insert. Idempotent, and safe
   *  against concurrent invocation: overlapping callers await the in-flight
   *  drain and then re-enter until the queue is fully empty. Shutdown callers
   *  rely on this loop so they can observe an "empty queue" postcondition
   *  before closing the database pool, instead of returning immediately when
   *  a periodic timer flush happened to be running. */
  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.flushing) {
      if (this.flushing) {
        // A concurrent flush is running (typically the periodic timer). Wait
        // it out via a short microtask spin so we do not busy-loop, then
        // re-check the queue — new events may have been enqueued during
        // that flush and must also be persisted before we return.
        await this.flushWait;
        continue;
      }
      this.flushing = true;
      this.flushWait = (async () => {
        try {
          await this.drain();
        } finally {
          this.flushing = false;
        }
      })();
      await this.flushWait;
    }
  }

  /**
   * Stops the periodic flush timer. The coordinated shutdown path
   * (`ShutdownCoordinator.flushTelemetry` before `closePools`) already
   * flushes before calling this; `{ flush: true }` is a safety net for any
   * caller that stops the buffer without going through that sequence.
   */
  async stop(options?: { flush?: boolean }): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (options?.flush) await this.flush();
  }

  /**
   * Scheduled entry point (periodic timer and batch-full trigger). Unlike the
   * public {@link flush}, it honors the outage backoff gate so a sustained
   * database failure cannot turn every interval tick into a fresh burst of
   * retries. Explicit shutdown flushes bypass the gate and always attempt.
   */
  private flushScheduled(): Promise<void> {
    if (Date.now() < this.drainBlockedUntil) return Promise.resolve();
    return this.flush();
  }

  private async drain(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, Math.min(this.queue.length, this.maxBatch));
    // Reuse the enqueue-time serialized sizes — no second JSON pass.
    const batchBytes = batch.reduce((sum, item) => sum + item.bytes, 0);
    this.queuedBytes = Math.max(0, this.queuedBytes - batchBytes);
    const rows = batch.map((item) => telemetryEventRow(item.event));
    let firstError: unknown;
    let lastError: unknown;
    for (let attempt = 0; attempt < DRAIN_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        // Backoff compounds with the outage streak so consecutive failed
        // drains probe the database less and less often.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, drainRetryDelayMs(this.drainFailureStreak + attempt - 1));
        await promise;
      }
      try {
        await this.store.insertEvents(rows);
        // Success: clear the streak and lift the outage gate immediately.
        this.drainFailureStreak = 0;
        this.drainBlockedUntil = 0;
        metrics.cartethyia_telemetry_buffered.inc(-batch.length);
        return;
      } catch (error) {
        if (attempt === 0) firstError = error;
        lastError = error;
      }
    }
    this.drainFailureStreak += 1;
    this.drainBlockedUntil =
      Date.now() + drainRetryDelayMs(Math.min(this.drainFailureStreak - 1, 6));
    this.logDrainOutage(lastError, firstError);
    metrics.cartethyia_telemetry_dropped_total.inc(batch.length);
    metrics.cartethyia_telemetry_buffered.inc(-batch.length);
  }

  /**
   * Rate-limits drain-outage log lines to one per window during a sustained
   * outage instead of one per failed flush; suppressed lines are counted
   * into the next emitted line so volume stays visible.
   */
  private logDrainOutage(retryError: unknown, firstError: unknown): void {
    const now = Date.now();
    if (now - this.lastDrainOutageAt < DRAIN_OUTAGE_LOG_WINDOW_MS) {
      this.suppressedDrainOutages += 1;
      return;
    }
    const suppressed = this.suppressedDrainOutages;
    this.lastDrainOutageAt = now;
    this.suppressedDrainOutages = 0;
    log.error(
      `[telemetry] failed to record batched events${suppressed > 0 ? ` (${suppressed} similar suppressed)` : ""}`,
      retryError as Error,
      firstError,
    );
  }
}
