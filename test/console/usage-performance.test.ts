import { expect, test } from "bun:test";
import { summarizeUsagePerformance } from "../../src/console/observability/store";

test("usage performance reports routing average and P50/P95/P99 latency", () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    latencyMs: index + 1,
    resolveMs: index === 1 ? 100 : index === 2 ? 300 : null,
  }));

  expect(summarizeUsagePerformance(events)).toEqual({
    avgResolveMs: 200,
    avgDurationMs: 50.5,
    latencyP50Ms: 50,
    latencyP95Ms: 95,
    latencyP99Ms: 99,
  });
});

test("usage performance returns zero metrics when the period has no events", () => {
  expect(summarizeUsagePerformance([])).toEqual({
    avgResolveMs: 0,
    avgDurationMs: 0,
    latencyP50Ms: 0,
    latencyP95Ms: 0,
    latencyP99Ms: 0,
  });
});
