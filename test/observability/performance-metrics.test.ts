import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_PERFORMANCE_ENTRIES,
  performanceMetricsSnapshot,
  resetPerformanceMetricsForTesting,
  trackAdapterLoad,
  trackMemoryUsage,
  trackModelCatalogLoad,
  trackNetworkCall,
} from "../../src/observability/performance-metrics";

// The metrics registry is process-global and shared with other test files that
// exercise the registry/console, so these tests use keys unique to this file
// and assert per-key values rather than whole-map equality.
const K = {
  adapter: "metrics-test-adapter",
  catalog: "metrics-test-catalog",
  host: "metrics-test-host.example",
  memory: "metrics-test-memory",
} as const;

afterEach(() => {
  resetPerformanceMetricsForTesting();
});

describe("performance metrics", () => {
  test("records each series under its own key", () => {
    trackAdapterLoad(K.adapter, 12.5);
    trackModelCatalogLoad(K.catalog, 3.5);
    trackNetworkCall(K.host, 88);
    trackMemoryUsage(K.memory, 1024);

    const snapshot = performanceMetricsSnapshot();
    expect(snapshot.adapter_load_ms[K.adapter]).toBe(12.5);
    expect(snapshot.model_catalog_load_ms[K.catalog]).toBe(3.5);
    expect(snapshot.network_call_latency_ms[K.host]).toBe(88);
    expect(snapshot.memory_bytes[K.memory]).toBe(1024);
  });

  test("ignores non-finite values", () => {
    trackAdapterLoad(K.adapter, Number.NaN);
    trackAdapterLoad(K.adapter, Number.POSITIVE_INFINITY);
    expect(performanceMetricsSnapshot().adapter_load_ms[K.adapter]).toBeUndefined();
  });

  test("overwrites an existing key with the latest sample", () => {
    trackAdapterLoad(K.adapter, 1);
    trackAdapterLoad(K.adapter, 2);
    expect(performanceMetricsSnapshot().adapter_load_ms[K.adapter]).toBe(2);
  });

  test("bounds each series at the cardinality cap", () => {
    // Start from an empty series so the cap boundary is deterministic.
    resetPerformanceMetricsForTesting();
    const prefix = "metrics-test-host-";
    for (let i = 0; i < MAX_PERFORMANCE_ENTRIES + 50; i += 1) {
      trackNetworkCall(`${prefix}${i}`, i);
    }
    const series = performanceMetricsSnapshot().network_call_latency_ms;
    expect(Object.keys(series)).toHaveLength(MAX_PERFORMANCE_ENTRIES);
    // The first keys are retained; later keys are dropped rather than evicting.
    expect(series[`${prefix}0`]).toBe(0);
    expect(series[`${prefix}${MAX_PERFORMANCE_ENTRIES + 49}`]).toBeUndefined();
  });

  test("reset clears the series", () => {
    trackAdapterLoad(K.adapter, 1);
    trackMemoryUsage(K.memory, 1);
    resetPerformanceMetricsForTesting();
    const snapshot = performanceMetricsSnapshot();
    expect(snapshot.adapter_load_ms[K.adapter]).toBeUndefined();
    expect(snapshot.memory_bytes[K.memory]).toBeUndefined();
  });
});
