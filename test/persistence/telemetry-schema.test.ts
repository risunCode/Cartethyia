import { describe, expect, test } from "bun:test";
import { telemetryEvents } from "../../src/persistence/schema";

/**
 * Stream event timestamps are absolute epoch milliseconds (~1.8e12), which
 * overflow integer (int4, max ~2.1e9). When these columns were int4, every
 * completed request carrying observed stream timings failed its
 * telemetry_events insert ("value is out of range for type integer") and
 * silently vanished from the console usage table. Pin the bigint width so
 * a narrowing never ships again.
 */
describe("telemetry_events timestamp columns", () => {
  test("event timestamp columns are bigint", () => {
    expect(telemetryEvents.firstContentDeltaAtMs.getSQLType()).toBe("bigint");
    expect(telemetryEvents.lastEventAtMs.getSQLType()).toBe("bigint");
  });
});
