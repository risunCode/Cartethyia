import { describe, expect, test } from "bun:test";
import { adaptiveFlushIntervalMs, TelemetryBatchBuffer, type TelemetryEventInput } from "../../src/observability/telemetry-buffer";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";

function event(): TelemetryEventInput {
  return {
    tenantId: "tenant-1",
    requestId: `req-${Math.random().toString(16).slice(2)}`,
    sourceSurface: "chat",
    requestedModel: "gpt-test",
    stream: false,
    status: "completed",
  };
}

/** Minimal transactional insert stub; these events have no aggregate identity. */
function dbWithInsert(
  impl: (batch: Array<Record<string, unknown>>) => Promise<void>,
): CartethyiaDatabase {
  const transaction = { insert: () => ({ values: impl }) };
  return {
    transaction: (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
  } as unknown as CartethyiaDatabase;
}

describe("adaptiveFlushIntervalMs", () => {
  test("polls rarely while idle and faster as the queue fills", () => {
    // Idle: base × idle multiplier.
    expect(adaptiveFlushIntervalMs(500, 0, 500)).toBe(2_000);
    // Half full: roughly half the base cadence.
    expect(adaptiveFlushIntervalMs(500, 250, 500)).toBe(250);
    // Full: clamped to the floor, never zero/negative.
    expect(adaptiveFlushIntervalMs(500, 500, 500)).toBe(50);
    expect(adaptiveFlushIntervalMs(500, 10_000, 500)).toBe(50);
  });

  test("is monotonic non-increasing as the queue grows", () => {
    const samples = [0, 1, 50, 200, 400, 500].map((n) => adaptiveFlushIntervalMs(500, n, 500));
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
    }
  });
});

describe("TelemetryBatchBuffer", () => {
  test("drains a batch in one insert and empties the queue", async () => {
    let calls = 0;
    const buffer = new TelemetryBatchBuffer(
      dbWithInsert(async () => {
        calls += 1;
      }),
      { flushIntervalMs: 60_000 },
    );
    buffer.enqueue(event());
    buffer.enqueue(event());
    await buffer.flush();
    expect(calls).toBe(1);
    await buffer.stop();
  });

  test("retries a transient failure and succeeds without dropping", async () => {
    let calls = 0;
    const buffer = new TelemetryBatchBuffer(
      dbWithInsert(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
      }),
      { flushIntervalMs: 60_000 },
    );
    buffer.enqueue(event());
    await buffer.flush();
    expect(calls).toBe(2);
    await buffer.stop();
  });

  test("bounds retries and terminates during a sustained outage", async () => {
    let calls = 0;
    const buffer = new TelemetryBatchBuffer(
      dbWithInsert(async () => {
        calls += 1;
        throw new Error("database down");
      }),
      { flushIntervalMs: 60_000 },
    );
    buffer.enqueue(event());
    // Must terminate rather than retry forever; the batch is dropped after the
    // bounded attempt count.
    await buffer.flush();
    expect(calls).toBe(5);
    await buffer.stop();
  });
});

describe("telemetry error origin", () => {
  /**
   * `errorCategory` alone cannot separate the gateway's own failures from an
   * upstream's: `invalid_request` is recorded both when the caller's body is
   * malformed (our rejection) and when the provider rejects a well-formed body
   * (theirs). `errorOrigin` is what lets an operator triage a spike, so it must
   * survive the queue → row mapping.
   */
  test("carries errorOrigin through to the inserted row", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const buffer = new TelemetryBatchBuffer(
      dbWithInsert(async (batch) => {
        for (const row of batch) rows.push(row);
      }),
      { flushIntervalMs: 60_000 },
    );
    buffer.enqueue({ ...event(), status: "failed", errorCategory: "invalid_request", errorOrigin: "upstream" });
    await buffer.flush();
    await buffer.stop();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.errorCategory).toBe("invalid_request");
    expect(rows[0]!.errorOrigin).toBe("upstream");
  });

  test("writes null rather than dropping the column when no origin is set", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const buffer = new TelemetryBatchBuffer(
      dbWithInsert(async (batch) => {
        for (const row of batch) rows.push(row);
      }),
      { flushIntervalMs: 60_000 },
    );
    buffer.enqueue(event());
    await buffer.flush();
    await buffer.stop();

    expect(rows).toHaveLength(1);
    // `null`, not omitted: the column exists and the row must state that the
    // origin is unknown rather than leaving the key absent.
    expect(rows[0]!.errorOrigin).toBeNull();
  });
});
