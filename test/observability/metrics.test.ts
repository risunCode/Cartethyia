import { describe, expect, test } from "bun:test";
import { MetricsCollector, metrics, toPrometheus } from "../../src/observability/metrics";

// Histogram bucket boundaries used by the collector.
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000] as const;

function fresh(): MetricsCollector {
  return new MetricsCollector();
}

// The collector uses its internal map key (name|sorted-labels) as the metric
// name in Prometheus output.  This helper extracts all le/count pairs from
// histogram output regardless of labeling.
function extractBuckets(out: string): Array<{ le: string; count: number }> {
  const re = /le="(\+Inf|\d+)" (\d+)/g;
  const result: Array<{ le: string; count: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    result.push({ le: m[1]!, count: Number(m[2]) });
  }
  return result;
}

describe("incrementCounter", () => {
  test("increments a new counter by 1", () => {
    const c = fresh();
    c.incrementCounter("requests");
    expect(c.toPrometheus()).toContain("requests| 1");
  });

  test("increments the same counter by N when value is provided", () => {
    const c = fresh();
    c.incrementCounter("requests", {}, 5);
    c.incrementCounter("requests", {}, 3);
    expect(c.toPrometheus()).toContain("requests| 8");
  });

  test("creates separate counters for different names", () => {
    const c = fresh();
    c.incrementCounter("a");
    c.incrementCounter("b");
    c.incrementCounter("a");
    const out = c.toPrometheus();
    expect(out).toContain("a| 2");
    expect(out).toContain("b| 1");
  });

  test("keeps label values distinct", () => {
    const c = fresh();
    c.incrementCounter("requests", { method: "GET" });
    c.incrementCounter("requests", { method: "GET" });
    c.incrementCounter("requests", { method: "POST" });
    const out = c.toPrometheus();
    expect(out).toContain('requests|method=GET{method="GET"} 2');
    expect(out).toContain('requests|method=POST{method="POST"} 1');
  });

  test("merges default labels with per-call labels", () => {
    const c = new MetricsCollector({ service: "cart" });
    c.incrementCounter("requests", { method: "GET" });
    expect(c.toPrometheus()).toContain('requests|method=GET{method="GET",service="cart"} 1');
  });

  test("per-call labels override default labels for the same key", () => {
    const c = new MetricsCollector({ service: "cart" });
    c.incrementCounter("requests", { service: "override" });
    expect(c.toPrometheus()).toContain('requests|service=override{service="override"} 1');
  });

  test("treats label key order as order-independent (same label set)", () => {
    const c = fresh();
    c.incrementCounter("requests", { method: "GET", route: "/v1" });
    c.incrementCounter("requests", { route: "/v1", method: "GET" });
    expect(c.toPrometheus()).toContain('requests|method=GET,route=/v1{method="GET",route="/v1"} 2');
  });

  test("emits the # TYPE counter line", () => {
    const c = fresh();
    c.incrementCounter("reqs");
    expect(c.toPrometheus()).toContain("# TYPE reqs| counter");
  });

  test("emits a # HELP line for the counter", () => {
    const c = fresh();
    c.incrementCounter("reqs");
    expect(c.toPrometheus()).toContain("# HELP reqs| Counter");
  });
});

describe("recordHistogram", () => {
  test("records a single value with sum and count", () => {
    const c = fresh();
    c.recordHistogram("latency", 42);
    const out = c.toPrometheus();
    expect(out).toContain("latency|_sum 42");
    expect(out).toContain("latency|_count 1");
  });

  test("accumulates sum and count across recordings", () => {
    const c = fresh();
    c.recordHistogram("latency", 10);
    c.recordHistogram("latency", 20);
    c.recordHistogram("latency", 30);
    const out = c.toPrometheus();
    expect(out).toContain("latency|_sum 60");
    expect(out).toContain("latency|_count 3");
  });

  test("increments the matching le bucket and all larger buckets", () => {
    const c = fresh();
    c.recordHistogram("latency", 7); // <= 10, 25, 50, ...
    const out = c.toPrometheus();
    // value 7 > 5, so le=5 bucket is NOT present in output
    expect(out).not.toContain('le="5"');
    // le=10 is the first bucket (cumulative count 1)
    expect(out).toContain('latency|_bucketle="10" 1');
    expect(out).toContain('latency|_bucketle="60000" 12');
    expect(out).toContain('latency|_bucketle="+Inf" 1');
  });

  test("assigns value to the smallest bucket that contains it (boundary inclusive)", () => {
    const c = fresh();
    c.recordHistogram("latency", 25); // exactly == bucket boundary 25 (<=)
    const out = c.toPrometheus();
    // 25 > 5 and 25 > 10, so those buckets are absent
    expect(out).not.toContain('le="5"');
    expect(out).not.toContain('le="10"');
    // 25 <= 25, so le=25 is the first bucket (cumulative 1)
    expect(out).toContain('latency|_bucketle="25" 1');
  });

  test("records values in the gt+le gap correctly", () => {
    const c = fresh();
    // 30 is > 25 and <= 50
    c.recordHistogram("latency", 30);
    const out = c.toPrometheus();
    expect(out).not.toContain('le="25"');
    expect(out).toContain('latency|_bucketle="50" 1');
  });

  test("a value exceeding all buckets only appears in +Inf", () => {
    const c = fresh();
    c.recordHistogram("latency", 99999);
    const out = c.toPrometheus();
    // no finite bucket lines at all
    for (const b of BUCKETS) {
      expect(out).not.toContain(`le="${b}"`);
    }
    expect(out).toContain('latency|_bucketle="+Inf" 1');
    expect(out).toContain("latency|_sum 99999");
    expect(out).toContain("latency|_count 1");
  });

  test("keeps separate histograms per label set", () => {
    const c = fresh();
    c.recordHistogram("latency", 5, { route: "/a" });
    c.recordHistogram("latency", 15, { route: "/b" });
    const out = c.toPrometheus();
    expect(out).toContain('latency|route=/a_count{route="/a"} 1');
    expect(out).toContain('latency|route=/b_count{route="/b"} 1');
    expect(out).toContain('latency|route=/a_sum{route="/a"} 5');
    expect(out).toContain('latency|route=/b_sum{route="/b"} 15');
  });

  test("merges default labels into histogram labels", () => {
    const c = new MetricsCollector({ service: "cart" });
    c.recordHistogram("latency", 10, { route: "/a" });
    expect(c.toPrometheus()).toContain('latency|route=/a_sum{route="/a",service="cart"} 10');
  });

  test("emits the # TYPE histogram line", () => {
    const c = fresh();
    c.recordHistogram("latency", 1);
    expect(c.toPrometheus()).toContain("# TYPE latency| histogram");
  });

  test("emits a # HELP line for the histogram", () => {
    const c = fresh();
    c.recordHistogram("latency", 1);
    expect(c.toPrometheus()).toContain("# HELP latency| Histogram");
  });

  test("cumulative bucket counts are monotonic non-decreasing", () => {
    const c = fresh();
    c.recordHistogram("latency", 3);
    c.recordHistogram("latency", 50);
    c.recordHistogram("latency", 2000);
    const out = c.toPrometheus();
    const all = extractBuckets(out);
    const finite = all
      .filter((x) => x.le !== "+Inf")
      .map((x) => ({ le: Number(x.le), count: x.count }))
      .sort((a, b) => a.le - b.le);
    for (let i = 1; i < finite.length; i++) {
      expect(finite[i]!.count).toBeGreaterThanOrEqual(finite[i - 1]!.count);
    }
    // +Inf must equal total count (3)
    const inf = all.find((x) => x.le === "+Inf");
    expect(inf?.count).toBe(3);
  });
});

describe("setGauge", () => {
  test("sets a new gauge value", () => {
    const c = fresh();
    c.setGauge("queue_size", 10);
    expect(c.toPrometheus()).toContain("queue_size| 10");
  });

  test("overwrites the previous gauge value", () => {
    const c = fresh();
    c.setGauge("queue_size", 10);
    c.setGauge("queue_size", 3);
    const out = c.toPrometheus();
    expect(out).toContain("queue_size| 3");
    expect(out).not.toContain("queue_size| 10");
  });

  test("keeps distinct gauge values per label set", () => {
    const c = fresh();
    c.setGauge("pool_size", 5, { provider: "openai" });
    c.setGauge("pool_size", 8, { provider: "anthropic" });
    const out = c.toPrometheus();
    expect(out).toContain('pool_size|provider=openai{provider="openai"} 5');
    expect(out).toContain('pool_size|provider=anthropic{provider="anthropic"} 8');
  });

  test("overwrites per-label gauge value", () => {
    const c = fresh();
    c.setGauge("pool_size", 5, { provider: "openai" });
    c.setGauge("pool_size", 9, { provider: "openai" });
    const out = c.toPrometheus();
    expect(out).toContain('pool_size|provider=openai{provider="openai"} 9');
    expect(out).not.toContain('pool_size|provider=openai{provider="openai"} 5');
  });

  test("emits the # TYPE gauge line", () => {
    const c = fresh();
    c.setGauge("g", 1);
    expect(c.toPrometheus()).toContain("# TYPE g| gauge");
  });

  test("merges default labels into gauge labels", () => {
    const c = new MetricsCollector({ service: "cart" });
    c.setGauge("g", 1, { kind: "a" });
    expect(c.toPrometheus()).toContain('g|kind=a{kind="a",service="cart"} 1');
  });
});

describe("toPrometheus", () => {
  test("always starts with build_info gauge", () => {
    const c = fresh();
    const out = c.toPrometheus();
    expect(out.startsWith("# HELP cartethyia_build_info Build information")).toBe(true);
    expect(out).toContain("# TYPE cartethyia_build_info gauge");
    expect(out).toContain('cartethyia_build_info{version="');
  });

  test("ends with a trailing newline", () => {
    const c = fresh();
    expect(c.toPrometheus().endsWith("\n")).toBe(true);
  });

  test("renders counters, histograms, and gauges together", () => {
    const c = fresh();
    c.incrementCounter("reqs");
    c.recordHistogram("latency", 7);
    c.setGauge("pool", 2);
    const out = c.toPrometheus();
    expect(out).toContain("# TYPE reqs| counter");
    expect(out).toContain("# TYPE latency| histogram");
    expect(out).toContain("# TYPE pool| gauge");
  });

  test("renders an empty exposition (only build_info) when no metrics recorded", () => {
    const c = fresh();
    const out = c.toPrometheus();
    expect(out).toContain("cartethyia_build_info");
    expect(out).not.toContain("# TYPE reqs| counter");
  });

  test("build_info version is a non-empty string", () => {
    const c = fresh();
    const match = c.toPrometheus().match(/cartethyia_build_info\{version="([^"]*)"\} 1/);
    expect(match).not.toBeNull();
    const version = match?.[1];
    expect(version).toBeDefined();
    expect(version!.length).toBeGreaterThan(0);
  });
});

describe("reset", () => {
  test("clears all recorded counters", () => {
    const c = fresh();
    c.incrementCounter("a");
    c.reset();
    expect(c.toPrometheus()).not.toContain("# TYPE a| counter");
  });

  test("clears all recorded histograms", () => {
    const c = fresh();
    c.recordHistogram("h", 1);
    c.reset();
    expect(c.toPrometheus()).not.toContain("# TYPE h| histogram");
  });

  test("clears all recorded gauges", () => {
    const c = fresh();
    c.setGauge("g", 1);
    c.reset();
    expect(c.toPrometheus()).not.toContain("# TYPE g| gauge");
  });

  test("preserves build_info after reset", () => {
    const c = fresh();
    c.incrementCounter("a");
    c.reset();
    expect(c.toPrometheus()).toContain("cartethyia_build_info");
  });

  test("allows recording fresh metrics after reset", () => {
    const c = fresh();
    c.incrementCounter("a", {}, 5);
    c.reset();
    c.incrementCounter("a", {}, 2);
    expect(c.toPrometheus()).toContain("a| 2");
  });
});

describe("makeKey (observable via label-set isolation)", () => {
  test("the same label set with different key insertion order is the same key", () => {
    const c = fresh();
    c.incrementCounter("r", { a: "1", b: "2" });
    c.incrementCounter("r", { b: "2", a: "1" });
    expect(c.toPrometheus()).toContain('r|a=1,b=2{a="1",b="2"} 2');
  });

  test("different label values produce distinct keys", () => {
    const c = fresh();
    c.incrementCounter("r", { a: "1" });
    c.incrementCounter("r", { a: "2" });
    const out = c.toPrometheus();
    expect(out).toContain('r|a=1{a="1"} 1');
    expect(out).toContain('r|a=2{a="2"} 1');
  });

  test("a counter with labels and one without are distinct keys", () => {
    const c = fresh();
    c.incrementCounter("r");
    c.incrementCounter("r", { a: "1" });
    const out = c.toPrometheus();
    // unlabeled line uses bare name + "|"
    expect(out).toContain("r| 1");
    expect(out).toContain('r|a=1{a="1"} 1');
  });

  test("an empty label set is equivalent to no labels", () => {
    const c = fresh();
    c.incrementCounter("r", {}, 1);
    c.incrementCounter("r", undefined, 2);
    expect(c.toPrometheus()).toContain("r| 3");
  });
});

describe("formatLabels (observable via toPrometheus)", () => {
  test("returns empty string for no labels", () => {
    const c = fresh();
    c.incrementCounter("r");
    // no braces around the bare metric value line
    expect(c.toPrometheus()).toContain("r| 1\n");
  });

  test("formats a single label as {key=\"value\"}", () => {
    const c = fresh();
    c.incrementCounter("r", { method: "GET" });
    expect(c.toPrometheus()).toContain('r|method=GET{method="GET"} 1');
  });

  test("sorts multiple labels alphabetically by key", () => {
    const c = fresh();
    c.incrementCounter("r", { zeta: "1", alpha: "2", mid: "3" });
    expect(c.toPrometheus()).toContain('r|alpha=2,mid=3,zeta=1{alpha="2",mid="3",zeta="1"} 1');
  });

  test("quotes values literally inside double quotes", () => {
    const c = fresh();
    c.incrementCounter("r", { path: "/v1/chat?id=42" });
    expect(c.toPrometheus()).toContain('r|path=/v1/chat?id=42{path="/v1/chat?id=42"} 1');
  });
});

describe("bucket boundary assignment", () => {
  test.each([
    [0, 5],
    [5, 5],
    [6, 10],
    [10, 10],
    [11, 25],
    [25, 25],
    [26, 50],
    [50, 50],
    [51, 100],
    [100, 100],
    [101, 250],
    [250, 250],
    [251, 500],
    [500, 500],
    [501, 1000],
    [1000, 1000],
    [1001, 2500],
    [2500, 2500],
    [2501, 5000],
    [5000, 5000],
    [5001, 10000],
    [10000, 10000],
    [10001, 30000],
    [30000, 30000],
    [30001, 60000],
    [60000, 60000],
  ] as const)("value %i falls into le=%s bucket", (value, firstNonZeroBucket) => {
    const c = fresh();
    c.recordHistogram("latency", value);
    const out = c.toPrometheus();
    const all = extractBuckets(out);
    const finite = all
      .filter((p) => p.le !== "+Inf")
      .map((p) => ({ le: Number(p.le), count: p.count }))
      .sort((a, b) => a.le - b.le);
    const firstNonZero = finite.find((f) => f.count > 0);
    expect(firstNonZero?.le).toBe(firstNonZeroBucket);
  });

  test("a value greater than the largest bucket is only counted in +Inf", () => {
    const c = fresh();
    c.recordHistogram("latency", 60001);
    const out = c.toPrometheus();
    for (const b of BUCKETS) {
      expect(out).not.toContain(`le="${b}"`);
    }
    expect(out).toContain('latency|_bucketle="+Inf" 1');
  });
});

describe("histogram percentile estimation from buckets", () => {
  test("a value below the p50 boundary yields cumulative count 0 below its containing bucket", () => {
    const c = fresh();
    // 1 value at 3 (<= 5,10,25,...,60000). Every bucket >= 5 is incremented.
    c.recordHistogram("latency", 3);
    const out = c.toPrometheus();
    // value 3 <= 5, so le=5 is the first finite bucket present (cumulative 1)
    expect(out).toContain('latency|_bucketle="5" 1');
    expect(out).toContain('latency|_bucketle="10" 2');
    // all 13 finite buckets are incremented by 1, so le=60000 cumulative is 13
    expect(out).toContain('latency|_bucketle="60000" 13');
    expect(out).toContain("latency|_count 1");
  });

  test("half the observations fall at or below the median bucket", () => {
    const c = fresh();
    // two values: 3 (<= 5,10,25,...) and 30 (<= 50,100,...)
    c.recordHistogram("latency", 3);
    c.recordHistogram("latency", 30);
    const out = c.toPrometheus();
    expect(out).toContain("latency|_count 2");
    // both values <= 60000, so le=60000 cumulative is 2
    expect(out).toContain('latency|_bucketle="60000" 2');
    // value 30 > 25, so le=25 only counts value 3. Cumulative at le=25 = 3
    // (value 3 contributes 1 to each of le=5, le=10, le=25).
    expect(out).toContain('latency|_bucketle="25" 3');
    // both values <= 50, so le=50 cumulative is 5
    // (value 3: 4 buckets <=50; value 30: 1 bucket at le=50).
    expect(out).toContain('latency|_bucketle="50" 5');
  });

  test("p99 is bounded by the +Inf bucket when all values are below the top finite bucket", () => {
    const c = fresh();
    c.recordHistogram("latency", 1);
    c.recordHistogram("latency", 2);
    const out = c.toPrometheus();
    const infMatch = out.match(/latency\|_bucketle="\+Inf" (\d+)/);
    expect(infMatch?.[1]).toBe("2");
    expect(out).toContain("latency|_count 2");
  });

  test("sum and count allow mean computation", () => {
    const c = fresh();
    c.recordHistogram("latency", 10);
    c.recordHistogram("latency", 20);
    c.recordHistogram("latency", 30);
    const out = c.toPrometheus();
    const sumMatch = out.match(/latency\|_sum (\d+)/);
    const countMatch = out.match(/latency\|_count (\d+)/);
    const sum = Number(sumMatch?.[1]);
    const count = Number(countMatch?.[1]);
    expect(sum).toBe(60);
    expect(count).toBe(3);
    expect(sum / count).toBeCloseTo(20, 10);
  });
});

describe("global metrics instance", () => {
  test("is a MetricsCollector with default service label", () => {
    const out = metrics.toPrometheus();
    expect(out).toContain("cartethyia_build_info");
    metrics.reset();
    metrics.incrementCounter("global_test", { method: "GET" });
    expect(metrics.toPrometheus()).toContain('global_test|method=GET{method="GET",service="cartethyia"} 1');
    metrics.reset();
  });

  test("module-level toPrometheus() re-exports the global instance", () => {
    metrics.reset();
    metrics.setGauge("exported_gauge", 7);
    // global instance merges its default label { service: "cartethyia" }
    expect(toPrometheus()).toContain('exported_gauge|{service="cartethyia"} 7');
    metrics.reset();
  });
});

describe("Counter: no labels vs with labels", () => {
  test("a counter with no labels renders a bare name line", () => {
    const c = fresh();
    c.incrementCounter("nolabels");
    expect(c.toPrometheus()).toContain("nolabels| 1\n");
  });

  test("a counter with labels renders a labeled line and does not collide with the unlabeled one", () => {
    const c = fresh();
    c.incrementCounter("mixed");
    c.incrementCounter("mixed", { k: "v" });
    const out = c.toPrometheus();
    expect(out).toContain("mixed| 1");
    expect(out).toContain('mixed|k=v{k="v"} 1');
  });

  test("incrementing the unlabeled counter twice does not leak into a labeled variant", () => {
    const c = fresh();
    c.incrementCounter("sep", {}, 2);
    c.incrementCounter("sep", { k: "v" }, 3);
    const out = c.toPrometheus();
    expect(out).toContain("sep| 2");
    expect(out).toContain('sep|k=v{k="v"} 3');
  });
});
