import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "../../src/observability/metrics";

describe("Prometheus histogram exposition", () => {
  test("initializes every bucket and exports cumulative counts", () => {
    const metrics = new MetricsCollector();
    metrics.recordHistogram("request_latency_ms", 20);
    metrics.recordHistogram("request_latency_ms", 7);

    const lines = metrics.toPrometheus().split("\n");
    const bucketLines = new Map(lines.filter((line) => line.startsWith("request_latency_ms_bucket")).map((line) => [line.match(/le="([^"]+)"/)?.[1] ?? "", line] as const));
    expect(bucketLines.get("5")).toMatch(/ 0$/);
    expect(bucketLines.get("10")).toMatch(/ 1$/);
    expect(bucketLines.get("25")).toMatch(/ 2$/);
    expect(bucketLines.get("50")).toMatch(/ 2$/);
    expect(bucketLines.get("60000")).toMatch(/ 2$/);
    expect(lines).toContain('request_latency_ms_bucket{le="+Inf"} 2');
    expect(lines).toContain("request_latency_ms_count 2");
    expect(lines).toContain("request_latency_ms_sum 27");
  });
});
