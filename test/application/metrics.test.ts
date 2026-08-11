import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "../../src/observability/metrics";

describe("Prometheus histogram exposition", () => {
  test("exports every configured bucket as cumulative counts", () => {
    const metrics = new MetricsCollector();
    metrics.recordHistogram("request_duration_ms", 10);

    const text = metrics.toPrometheus();
    expect(text).toContain('request_duration_ms_bucket{le="5"} 0');
    expect(text).toContain('request_duration_ms_bucket{le="10"} 1');
    expect(text).toContain('request_duration_ms_bucket{le="25"} 1');
    expect(text).toContain('request_duration_ms_bucket{le="+Inf"} 1');
    expect(text).toContain("request_duration_ms_count 1");
  });
});
