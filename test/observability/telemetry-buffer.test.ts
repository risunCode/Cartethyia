/**
 * The telemetry buffer: the only writer of the `telemetry_events` rows the
 * Usage page reads.
 *
 * A buffered writer hides its mistakes until a query returns nothing, so every
 * claim here is checked against the real table through the real
 * `DrizzleTelemetryStore`. Nothing about the persistence path is stubbed, and
 * no private field is reached into: if the mapping is wrong, the row that
 * Postgres hands back is wrong.
 *
 * The three properties that matter, each a way an operator loses data:
 *
 * 1. **What reaches Postgres.** A dropped field or a mistyped column empties a
 *    dashboard panel without failing anything else, so every column with a
 *    live producer is asserted end to end.
 * 2. **Loss is counted, never silent.** A dropped event is indistinguishable
 *    from a request that never happened, so both drop paths must increment
 *    `cartethyia_telemetry_dropped_total`.
 * 3. **A failed drain must not take the queue with it.** The retry loop and the
 *    outage gate are what keep a database blip from becoming a retry storm or
 *    an unbounded queue.
 *
 * Rows are scoped by a `runId` tenant and removed by the `on delete cascade`
 * on `telemetry_events.tenant_id`, so the suite leaves the database as it found
 * it without a manual teardown of the rows it wrote.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  adaptiveFlushIntervalMs,
  TelemetryBatchBuffer,
  type TelemetryEventInput,
} from "../../src/observability/telemetry-buffer";
import { metrics } from "../../src/observability/metrics";
import { getDb, type CartethyiaDatabase } from "../../src/persistence/postgres";
import { telemetryEvents } from "../../src/persistence/schema";
import { createRunId, getTestPool, requireDatabase } from "../helpers/database";
import { createTenant } from "../helpers/fixtures";

requireDatabase();

/** Every buffer this file started, so no timer outlives the test that made it. */
const buffers: TelemetryBatchBuffer[] = [];

/**
 * The real Drizzle handle over the test pool.
 *
 * `postgres.ts` routes `DATABASE_URL` to the test database at import time
 * (see `test/helpers/database.ts`), so this is the same connection the
 * fixtures use and the same one production code would get.
 */
function db(): CartethyiaDatabase {
  return getDb();
}

/**
 * A buffer whose periodic timer cannot fire during a test.
 *
 * Every drain in this file is an explicit `flush()`, so the interval is pushed
 * an hour out: a test asserting "these events were dropped" must not race a
 * timer that drains them first. The adaptive-interval policy is covered
 * separately, as a pure function.
 */
function startBuffer(options: { maxBatch?: number; maxItems?: number; maxBytes?: number } = {}): TelemetryBatchBuffer {
  const buffer = new TelemetryBatchBuffer(db(), { flushIntervalMs: 3_600_000, ...options });
  buffers.push(buffer);
  return buffer;
}

afterEach(async () => {
  for (const buffer of buffers.splice(0)) await buffer.stop();
});

/** A tenant for one test, plus the cleanup that removes everything under it. */
async function tenantScope(
  label: string,
): Promise<{ tenantId: string; cleanup: () => Promise<void> }> {
  const pool = await getTestPool();
  const runId = createRunId(label);
  const client = await pool.connect();
  try {
    const tenant = await createTenant(client, runId);
    return {
      tenantId: tenant.tenantId,
      cleanup: async () => {
        // One statement: `telemetry_events.tenant_id` cascades from `tenants`.
        await client.query("delete from tenants where id = $1", [tenant.tenantId]);
      },
    };
  } finally {
    client.release();
  }
}

/** The rows the buffer wrote for one tenant, read back through Drizzle. */
async function rowsFor(tenantId: string): Promise<readonly (typeof telemetryEvents.$inferSelect)[]> {
  return db().select().from(telemetryEvents).where(eq(telemetryEvents.tenantId, tenantId));
}

function makeEvent(
  tenantId: string,
  overrides: Partial<TelemetryEventInput> = {},
): TelemetryEventInput {
  return {
    tenantId,
    requestId: crypto.randomUUID(),
    sourceSurface: "chat",
    requestedModel: "claude-sonnet-4-6",
    stream: false,
    status: "completed",
    ...overrides,
  };
}

/** One usage record with every field present, so a dropped field is visible. */
function fullUsage(): NonNullable<TelemetryEventInput["usage"]> {
  return {
    input_tokens: 900,
    cached_input_tokens: 800,
    cache_write_tokens: 0,
    uncached_input_tokens: 100,
    output_tokens: 120,
    reasoning_tokens: 40,
    estimated_cost: 0.012345,
    total_tokens: 1020,
    credit_used: 1.01,
  };
}

/** Reads one metric's current value out of the real Prometheus registry. */
function metricValue(name: string): number {
  const lines = metrics.render().split("\n");
  let total = 0;
  let found = false;
  for (const line of lines) {
    if (!line.startsWith(name)) continue;
    // Only an exact name or a name immediately followed by a label set, so
    // `foo_total` cannot be matched by a scrape line for `foo_total_other`.
    const rest = line.slice(name.length);
    if (rest !== "" && !rest.startsWith("{") && !rest.startsWith(" ")) continue;
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (Number.isFinite(value)) {
      total += value;
      found = true;
    }
  }
  return found ? total : 0;
}

describe("adaptiveFlushIntervalMs", () => {
  test("an empty queue waits out the idle multiplier", () => {
    // Fewer wakeups under low load: this timer is the only reason an idle
    // gateway touches the database at all.
    expect(adaptiveFlushIntervalMs(500, 0, 500)).toBe(2_000);
  });

  test("a filling queue drains faster, down to the floor", () => {
    // Batching must never become a latency source: as the queue approaches
    // `maxBatch` the interval collapses from the base cadence to the floor.
    // MEASURED: the curve is `max(50, round(base * (1 - fill)))`, so at a
    // 500 base the interval reaches the 50ms floor at a fill of 0.9 — a queue
    // of 450 events drains every 50ms, not every 250ms.
    expect(adaptiveFlushIntervalMs(500, 125, 500)).toBe(375);
    expect(adaptiveFlushIntervalMs(500, 250, 500)).toBe(250);
    expect(adaptiveFlushIntervalMs(500, 450, 500)).toBe(50);
    // Past `maxBatch` the fill ratio is clamped, so the interval stops falling.
    expect(adaptiveFlushIntervalMs(500, 500, 500)).toBe(50);
    expect(adaptiveFlushIntervalMs(500, 10_000, 500)).toBe(50);
  });

  test("always returns an integer at or above the floor", () => {
    for (const length of [0, 1, 7, 123, 499, 500, 10_000]) {
      const value = adaptiveFlushIntervalMs(500, length, 500);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(50);
    }
  });

  test("a zero maxBatch does not divide by zero", () => {
    // `Math.max(1, maxBatch)` guards the divisor. Without it the fill ratio is
    // Infinity, the interval becomes NaN, and `setTimeout(NaN)` fires
    // immediately — a hot loop against the database.
    const value = adaptiveFlushIntervalMs(500, 1, 0);
    expect(Number.isNaN(value)).toBe(false);
    expect(value).toBeGreaterThanOrEqual(50);
  });
});

describe("TelemetryBatchBuffer — drop accounting", () => {
  test("a queue past maxItems drops the overflow and counts it", async () => {
    // A silent drop is the worst outcome: the request appears in the gateway
    // log, no row appears in Usage, and nothing explains the gap.
    const scope = await tenantScope("telemetry-items");
    try {
      const before = metricValue("cartethyia_telemetry_dropped_total");
      const buffer = startBuffer({ maxItems: 2 });
      buffer.enqueue(makeEvent(scope.tenantId));
      buffer.enqueue(makeEvent(scope.tenantId));
      buffer.enqueue(makeEvent(scope.tenantId));
      expect(metricValue("cartethyia_telemetry_dropped_total") - before).toBe(1);
      await buffer.flush();
      // The two admitted events still land; the drop is the third alone.
      expect(await rowsFor(scope.tenantId)).toHaveLength(2);
    } finally {
      await scope.cleanup();
    }
  });

  test("a byte budget drops the event that would exceed it and counts it", async () => {
    // The byte bound is the one that actually protects memory: a queue of 10k
    // events carrying long user agents defeats the item cap's intent.
    const scope = await tenantScope("telemetry-bytes");
    try {
      const before = metricValue("cartethyia_telemetry_dropped_total");
      const buffer = startBuffer({ maxBytes: 700 });
      buffer.enqueue(makeEvent(scope.tenantId));
      buffer.enqueue(makeEvent(scope.tenantId));
      expect(metricValue("cartethyia_telemetry_dropped_total") - before).toBeGreaterThanOrEqual(1);
      await buffer.flush();
      expect((await rowsFor(scope.tenantId)).length).toBeLessThan(2);
    } finally {
      await scope.cleanup();
    }
  });

  test("the buffered gauge tracks the queue through enqueue and drain", async () => {
    const scope = await tenantScope("telemetry-gauge");
    try {
      const before = metricValue("cartethyia_telemetry_buffered");
      const buffer = startBuffer();
      buffer.enqueue(makeEvent(scope.tenantId));
      buffer.enqueue(makeEvent(scope.tenantId));
      expect(metricValue("cartethyia_telemetry_buffered") - before).toBe(2);
      await buffer.flush();
      // Drained: the gauge returns to where it started.
      expect(metricValue("cartethyia_telemetry_buffered") - before).toBe(0);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("TelemetryBatchBuffer — flush lifecycle", () => {
  test("flushing an empty buffer resolves without touching the database", async () => {
    const buffer = startBuffer();
    await expect(buffer.flush()).resolves.toBeUndefined();
  });

  test("concurrent flushes serialise and all resolve", async () => {
    // Shutdown races the periodic timer. The documented contract is that
    // overlapping callers await the in-flight drain and re-enter until the
    // queue is empty, so a shutdown caller can observe a true postcondition
    // before the pool closes instead of returning mid-drain.
    const scope = await tenantScope("telemetry-concurrent");
    try {
      const buffer = startBuffer();
      for (let index = 0; index < 5; index += 1) buffer.enqueue(makeEvent(scope.tenantId));
      await Promise.all([buffer.flush(), buffer.flush(), buffer.flush()]);
      expect(await rowsFor(scope.tenantId)).toHaveLength(5);
    } finally {
      await scope.cleanup();
    }
  });

  test("stop() is idempotent and stop({ flush }) drains what is queued", async () => {
    const scope = await tenantScope("telemetry-stop");
    try {
      const buffer = startBuffer();
      buffer.enqueue(makeEvent(scope.tenantId));
      await buffer.stop({ flush: true });
      await expect(buffer.stop()).resolves.toBeUndefined();
      expect(await rowsFor(scope.tenantId)).toHaveLength(1);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("telemetry row mapping, read back from Postgres", () => {
  test("every column with a live producer is persisted", async () => {
    // The end-to-end claim: what the buffer enqueues is what Postgres holds.
    // A column rename or a broken insert fails here rather than emptying the
    // Usage panel that reads it.
    const scope = await tenantScope("telemetry-full");
    try {
      const requestId = crypto.randomUUID();
      const buffer = startBuffer();
      buffer.enqueue({
        tenantId: scope.tenantId,
        requestId,
        sourceSurface: "chat",
        requestedModel: "claude-sonnet-4-6",
        requestedEffort: "high",
        endpoint: "/v1/chat/completions",
        providerId: "anthropic",
        latencyMs: 1234,
        ttfbMs: 400,
        stream: true,
        httpStatus: 200,
        status: "completed",
        resolveMs: 55,
        firstContentDeltaAtMs: 1_800_000_000_000,
        lastEventAtMs: 1_800_000_004_000,
        tokensPerSec: 42.5,
        usage: fullUsage(),
      });
      await buffer.flush();
      const rows = await rowsFor(scope.tenantId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.requestId).toBe(requestId);
      expect(row?.sourceSurface).toBe("chat");
      expect(row?.requestedModel).toBe("claude-sonnet-4-6");
      expect(row?.requestedEffort).toBe("high");
      expect(row?.endpoint).toBe("/v1/chat/completions");
      expect(row?.providerId).toBe("anthropic");
      expect(row?.latencyMs).toBe(1234);
      expect(row?.ttfbMs).toBe(400);
      expect(row?.stream).toBe(true);
      expect(row?.httpStatus).toBe(200);
      expect(row?.status).toBe("completed");
      expect(row?.resolveMs).toBe(55);
      expect(row?.inputTokens).toBe(900);
      expect(row?.cachedInputTokens).toBe(800);
      expect(row?.outputTokens).toBe(120);
      expect(row?.reasoningTokens).toBe(40);
      expect(row?.estimatedCostUsd).toBe("0.012345");
      expect(row?.creditUsed).toBe("1.0100");
      expect(row?.tokensPerSec).toBe("42.50");
      // Epoch millis exceed int4, which is why these columns are bigint: a
      // completed request carrying stream timings used to fail its insert and
      // vanish from the console.
      expect(row?.firstContentDeltaAtMs).toBe(1_800_000_000_000);
      expect(row?.lastEventAtMs).toBe(1_800_000_004_000);
    } finally {
      await scope.cleanup();
    }
  });

  test("absent optional fields persist as NULL, never as an empty string", async () => {
    // An empty string renders as a blank cell that looks like real data; NULL
    // renders as absent. `providerId` is the field an operator filters on, so
    // a fabricated "" would create a provider that does not exist.
    const scope = await tenantScope("telemetry-nulls");
    try {
      const buffer = startBuffer();
      buffer.enqueue(makeEvent(scope.tenantId));
      await buffer.flush();
      const row = (await rowsFor(scope.tenantId))[0];
      expect(row?.requestedEffort).toBeNull();
      expect(row?.endpoint).toBeNull();
      expect(row?.apiKeyId).toBeNull();
      expect(row?.userAgent).toBeNull();
      expect(row?.clientIp).toBeNull();
      expect(row?.providerId).toBeNull();
      expect(row?.accountId).toBeNull();
      expect(row?.networkPoolId).toBeNull();
      expect(row?.latencyMs).toBeNull();
      expect(row?.ttfbMs).toBeNull();
      expect(row?.httpStatus).toBeNull();
      expect(row?.errorCategory).toBeNull();
      expect(row?.errorOrigin).toBeNull();
      expect(row?.inputTokens).toBeNull();
      expect(row?.cachedInputTokens).toBeNull();
      expect(row?.outputTokens).toBeNull();
      expect(row?.reasoningTokens).toBeNull();
      expect(row?.estimatedCostUsd).toBeNull();
      expect(row?.creditUsed).toBeNull();
      expect(row?.resolveMs).toBeNull();
      expect(row?.tokensPerSec).toBeNull();
      expect(row?.firstContentDeltaAtMs).toBeNull();
      expect(row?.lastEventAtMs).toBeNull();
    } finally {
      await scope.cleanup();
    }
  });

  test("a measured zero is preserved rather than treated as absent", async () => {
    // `??` and `!= null` are load-bearing: a `latencyMs` of 0 (a cached
    // answer) and a `tokensPerSec` of 0 are measurements, not omissions. A
    // truthiness check would blank them and make a fast answer look unmeasured.
    const scope = await tenantScope("telemetry-zeros");
    try {
      const buffer = startBuffer();
      buffer.enqueue(
        makeEvent(scope.tenantId, {
          latencyMs: 0,
          ttfbMs: 0,
          httpStatus: 200,
          resolveMs: 0,
          tokensPerSec: 0,
          firstContentDeltaAtMs: 0,
          lastEventAtMs: 0,
          usage: { ...fullUsage(), credit_used: 0, estimated_cost: 0 },
        }),
      );
      await buffer.flush();
      const row = (await rowsFor(scope.tenantId))[0];
      expect(row?.latencyMs).toBe(0);
      expect(row?.ttfbMs).toBe(0);
      expect(row?.httpStatus).toBe(200);
      expect(row?.resolveMs).toBe(0);
      expect(row?.tokensPerSec).toBe("0.00");
      expect(row?.firstContentDeltaAtMs).toBe(0);
      expect(row?.lastEventAtMs).toBe(0);
      // Zero credit is a reported measurement, not a missing field.
      expect(row?.creditUsed).toBe("0.0000");
      // Zero cost is a real answer (a free tier); it must not become NULL,
      // which is reserved for "the catalog had no rate to apply".
      expect(row?.estimatedCostUsd).toBe("0.000000");
    } finally {
      await scope.cleanup();
    }
  });

  test("an unpriced route persists NULL cost so the analytics partial flag can fire", async () => {
    // The schema comment is explicit: null is not 0. An unpriced route that
    // reported $0.00 would read as measured-free, and the `partial` flag that
    // counts completed rows with no persisted cost could never fire.
    const scope = await tenantScope("telemetry-unpriced");
    try {
      const buffer = startBuffer();
      buffer.enqueue(
        makeEvent(scope.tenantId, { usage: { ...fullUsage(), estimated_cost: null } }),
      );
      await buffer.flush();
      const row = (await rowsFor(scope.tenantId))[0];
      expect(row?.estimatedCostUsd).toBeNull();
      // The token counts beside it are unaffected.
      expect(row?.inputTokens).toBe(900);
    } finally {
      await scope.cleanup();
    }
  });

  test("an unavailable token count persists as NULL, not as zero", async () => {
    // `"unavailable"` means the provider did not report the field. Persisting
    // 0 would report a cache miss of zero tokens, which the Overview cache-hit
    // rate then divides by.
    const scope = await tenantScope("telemetry-unavailable");
    try {
      const buffer = startBuffer();
      buffer.enqueue(
        makeEvent(scope.tenantId, {
          usage: {
            ...fullUsage(),
            cached_input_tokens: "unavailable",
            reasoning_tokens: "unavailable",
          },
        }),
      );
      await buffer.flush();
      const row = (await rowsFor(scope.tenantId))[0];
      expect(row?.cachedInputTokens).toBeNull();
      expect(row?.reasoningTokens).toBeNull();
      // The fields that were reported are unaffected.
      expect(row?.inputTokens).toBe(900);
      expect(row?.outputTokens).toBe(120);
    } finally {
      await scope.cleanup();
    }
  });

  test("fractional token counts are rounded to the integer columns", async () => {
    // The columns are `integer`; Postgres rejects a fractional value, which
    // would drop the whole batch. Rounding is what keeps the row insertable.
    const scope = await tenantScope("telemetry-rounding");
    try {
      const buffer = startBuffer();
      buffer.enqueue(
        makeEvent(scope.tenantId, {
          usage: {
            ...fullUsage(),
            cached_input_tokens: 10.6,
            reasoning_tokens: 9.5,
            input_tokens: 100,
            output_tokens: 50,
          },
        }),
      );
      await buffer.flush();
      const row = (await rowsFor(scope.tenantId))[0];
      expect(row?.cachedInputTokens).toBe(11);
      expect(row?.reasoningTokens).toBe(10);
    } finally {
      await scope.cleanup();
    }
  });

  test("a streamed flag of false is recorded as false, not NULL", async () => {
    // A truthiness check would write NULL for a non-streamed request, which the
    // Usage page then reports as "unknown" rather than "not streamed".
    const scope = await tenantScope("telemetry-stream-flag");
    try {
      const buffer = startBuffer();
      buffer.enqueue(makeEvent(scope.tenantId, { stream: false }));
      buffer.enqueue(makeEvent(scope.tenantId, { stream: true }));
      await buffer.flush();
      const rows = await rowsFor(scope.tenantId);
      const flags = rows.map((row) => row.stream).sort();
      expect(flags).toEqual([false, true]);
    } finally {
      await scope.cleanup();
    }
  });

  test("every terminal status the gateway can emit is accepted by the enum column", async () => {
    // `status` is an enum column: a value the enum does not carry makes the
    // insert throw and drops the whole batch with it.
    const statuses: readonly TelemetryEventInput["status"][] = [
      "completed",
      "failed",
      "cancelled",
      "truncated",
    ];
    const scope = await tenantScope("telemetry-statuses");
    try {
      const buffer = startBuffer();
      for (const status of statuses) buffer.enqueue(makeEvent(scope.tenantId, { status }));
      await buffer.flush();
      const rows = await rowsFor(scope.tenantId);
      expect(rows).toHaveLength(statuses.length);
      expect(rows.map((row) => row.status).sort()).toEqual([...statuses].sort());
    } finally {
      await scope.cleanup();
    }
  });
});

describe("TelemetryBatchBuffer — batching", () => {
  test("a batch of many events lands in one flush, all of them", async () => {
    // Batching is the entire reason this class exists: 1000 concurrent
    // requests must not race the pool with one INSERT each.
    const scope = await tenantScope("telemetry-batch");
    try {
      const buffer = startBuffer();
      const requestIds = Array.from({ length: 50 }, () => crypto.randomUUID());
      for (const requestId of requestIds) {
        buffer.enqueue(makeEvent(scope.tenantId, { requestId }));
      }
      await buffer.flush();
      const rows = await rowsFor(scope.tenantId);
      expect(rows).toHaveLength(50);
      const stored = new Set(rows.map((row) => row.requestId));
      for (const requestId of requestIds) expect(stored.has(requestId)).toBe(true);
    } finally {
      await scope.cleanup();
    }
  });

  test("maxBatch bounds one drain without losing the remainder", async () => {
    // The bound keeps one drain from building an unbounded statement. The
    // events past it must stay queued for the next drain, not be dropped:
    // `flush()` loops until the queue is empty, which is what a shutdown
    // caller depends on.
    const scope = await tenantScope("telemetry-maxbatch");
    try {
      const buffer = startBuffer({ maxBatch: 3 });
      for (let index = 0; index < 7; index += 1) buffer.enqueue(makeEvent(scope.tenantId));
      await buffer.flush();
      expect(await rowsFor(scope.tenantId)).toHaveLength(7);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("TelemetryBatchBuffer — failed drain", () => {
  /**
   * A drain that the database rejects is retried `DRAIN_MAX_ATTEMPTS` (5) times
   * with exponential backoff before the batch is dropped, so one failing drain
   * costs roughly 25+50+100+200ms of real wall clock. The two failure tests
   * below therefore share a single buffer and a single flush: they assert three
   * distinct properties of that one drain, which is also the honest shape —
   * a batch is one statement, so its failure is one event.
   *
   * A tenant id that is not a UUID fails the insert at the database, which is
   * the real failure shape (a constraint violation), not a thrown stub.
   */
  test("a batch the database rejects is dropped, counted, and does not wedge the buffer", async () => {
    const scope = await tenantScope("telemetry-failed-drain");
    try {
      const buffer = startBuffer();
      // A good row and an uninsertable one in the same drain. One statement
      // means the whole batch fails together, so both are counted as dropped:
      // the drop counter counts rows, not causes. Pinned because it is the
      // honest cost of batching, and an operator reading the counter needs to
      // know that a single bad row can take a good one with it.
      buffer.enqueue(makeEvent(scope.tenantId));
      buffer.enqueue(makeEvent("not-a-uuid"));
      const before = metricValue("cartethyia_telemetry_dropped_total");
      await buffer.flush();
      expect(metricValue("cartethyia_telemetry_dropped_total") - before).toBe(2);
      expect(await rowsFor(scope.tenantId)).toHaveLength(0);
      // Still usable: one bad batch must not wedge telemetry for every later
      // request, and the queue must be empty so nothing is retried forever.
      buffer.enqueue(makeEvent(scope.tenantId));
      await buffer.flush();
      expect(await rowsFor(scope.tenantId)).toHaveLength(1);
    } finally {
      await scope.cleanup();
    }
  });

  test("a drain that fails entirely leaves no queue behind", async () => {
    // The five attempts are the documented ceiling. Past it the batch is
    // dropped and the outage gate takes over, so a sustained database outage
    // costs one counted loss per batch instead of an unbounded retry loop that
    // grows the queue while it fails.
    const buffer = startBuffer();
    for (let index = 0; index < 3; index += 1) buffer.enqueue(makeEvent("not-a-uuid"));
    const before = metricValue("cartethyia_telemetry_dropped_total");
    await buffer.flush();
    expect(metricValue("cartethyia_telemetry_dropped_total") - before).toBe(3);
    // Empty queue, so a second flush has nothing to retry and must not
    // re-count the same loss.
    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(metricValue("cartethyia_telemetry_dropped_total") - before).toBe(3);
  });
});
