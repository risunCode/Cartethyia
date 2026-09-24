import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RuntimeMetricsSampler, resolveMemoryLimitBytes } from "../../src/observability/runtime-metrics";
import { metrics } from "../../src/observability/metrics";

function metricValue(name: string): number | undefined {
  const match = metrics.render().match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

function sources() {
  return {
    routingRoundRobinEntries: () => ({ combo: 7, provider: 3 }),
    poolAgentEntries: () => 5,
    ipAbuseKeys: () => 13,
    quotaCacheEntries: () => 17,
  };
}

const originalLimit = process.env.CARTETHYIA_MEMORY_LIMIT_BYTES;

afterEach(() => {
  if (originalLimit === undefined) delete process.env.CARTETHYIA_MEMORY_LIMIT_BYTES;
  else process.env.CARTETHYIA_MEMORY_LIMIT_BYTES = originalLimit;
});

describe("resolveMemoryLimitBytes", () => {
  test("prefers an explicit environment override", () => {
    process.env.CARTETHYIA_MEMORY_LIMIT_BYTES = "536870912";
    expect(resolveMemoryLimitBytes()).toBe(536870912);
  });

  test("rejects a malformed override instead of silently ignoring it", () => {
    process.env.CARTETHYIA_MEMORY_LIMIT_BYTES = "not-a-number";
    expect(() => resolveMemoryLimitBytes()).toThrow();
  });
});

describe("RuntimeMetricsSampler", () => {
  test("samples process memory and bounded-collection sizes", () => {
    const sampler = new RuntimeMetricsSampler(sources(), 1024 * 1024, false);
    sampler.sample();

    expect(metricValue("cartethyia_memory_rss_bytes")).toBeGreaterThan(0);
    expect(metricValue("cartethyia_memory_heap_used_bytes")).toBeGreaterThan(0);
    expect(metricValue("cartethyia_memory_limit_bytes")).toBe(1024 * 1024);
    expect(metricValue("cartethyia_routing_roundrobin_entries")).toBeDefined();
    expect(metricValue("cartethyia_ip_abuse_keys")).toBe(13);
    expect(metricValue("cartethyia_quota_cache_entries")).toBe(17);
  });

  test("reports no limit as zero when the environment provides none", () => {
    delete process.env.CARTETHYIA_MEMORY_LIMIT_BYTES;
    const sampler = new RuntimeMetricsSampler(sources(), undefined, false);
    sampler.sample();
    expect(metricValue("cartethyia_memory_limit_bytes")).toBe(0);
  });

  test("triggers a proactive garbage collection above the pressure threshold", () => {
    const gc = spyOn(Bun, "gc").mockImplementation(() => {});
    try {
      // A 1-byte limit guarantees RSS is above 80%.
      const sampler = new RuntimeMetricsSampler(sources(), 1, true);
      sampler.sample();
      expect(gc).toHaveBeenCalledTimes(1);
      expect(gc).toHaveBeenCalledWith(false);
      // The cooldown prevents a second collection within the same window.
      sampler.sample();
      expect(gc).toHaveBeenCalledTimes(1);
    } finally {
      gc.mockRestore();
    }
  });

  test("does not collect when pressure GC is disabled", () => {
    const gc = spyOn(Bun, "gc").mockImplementation(() => {});
    try {
      const sampler = new RuntimeMetricsSampler(sources(), 1, false);
      sampler.sample();
      expect(gc).not.toHaveBeenCalled();
    } finally {
      gc.mockRestore();
    }
  });

  test("does not collect below the pressure threshold", () => {
    const gc = spyOn(Bun, "gc").mockImplementation(() => {});
    try {
      const sampler = new RuntimeMetricsSampler(sources(), Number.MAX_SAFE_INTEGER, true);
      sampler.sample();
      expect(gc).not.toHaveBeenCalled();
    } finally {
      gc.mockRestore();
    }
  });
});
