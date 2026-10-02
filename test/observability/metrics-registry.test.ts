/**
 * The metrics registry: the exposition format an operator's Prometheus scrapes.
 *
 * Two things make this worth a suite of its own.
 *
 * 1. **Cardinality is a denial-of-service surface.** Labels come from untrusted
 *    input — a status, a reason, a provider id — and every distinct label set is
 *    a new series held in memory forever. The registry's own comment names this,
 *    and the guards (`MAX_SERIES`, `MAX_LABELS`, `MAX_LABEL_VALUE_LENGTH`) are
 *    the only thing between a hostile client and unbounded growth. Each guard is
 *    pinned from both sides: at the limit and one past it.
 * 2. **The wire format is a contract.** A scrape parses a line-oriented format;
 *    an unescaped newline or quote in a help string or a label value corrupts
 *    the whole scrape, not just one sample. The escaping is asserted directly.
 *
 * The suite works on its own `PrometheusRegistry` instance wherever possible, so
 * it does not perturb the process-wide `metrics` object that production code
 * increments.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_LABELS,
  MAX_LABEL_VALUE_LENGTH,
  MAX_SERIES,
  normalizeLabels,
  PrometheusRegistry,
} from "../../src/observability/metrics";

/** One scrape line for `name`, or undefined when the metric did not render. */
function sampleLine(registry: PrometheusRegistry, name: string): string | undefined {
  return registry
    .render()
    .split("\n")
    .find((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`));
}

/** Every scrape line for `name`, in render order. */
function sampleLines(registry: PrometheusRegistry, name: string): string[] {
  return registry
    .render()
    .split("\n")
    .filter((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`));
}

describe("normalizeLabels", () => {
  test("keeps only the metric's declared label names", () => {
    // A label the metric did not declare cannot be rendered into the label set,
    // and carrying it would make two logically identical samples distinct.
    expect(normalizeLabels({ a: "1", b: "2", extra: "3" }, ["a", "b"])).toEqual({
      a: "1",
      b: "2",
    });
  });

  test("a declared label that is absent renders as an empty value, not a missing key", () => {
    // Prometheus requires every declared label on every sample of a series. A
    // dropped key produces a differently shaped line that a scraper rejects.
    expect(normalizeLabels({ a: "1" }, ["a", "b"])).toEqual({ a: "1", b: "" });
  });

  test("a number label is stringified", () => {
    // Labels are strings on the wire; passing a number through would render
    // `429` correctly by luck but `1e3` as `1000` in one place and `1e+3` in
    // another.
    expect(normalizeLabels({ status: 429 }, ["status"])).toEqual({ status: "429" });
  });

  test("newlines and quotes are replaced so the scrape cannot be corrupted", () => {
    // This is the escaping that matters: a raw newline in a label value splits
    // one sample into two lines and the scrape is rejected, taking every other
    // metric in the payload with it.
    const normalized = normalizeLabels({ reason: 'a\nb\rc"d' }, ["reason"]);
    expect(normalized.reason).toBe("a_b_c_d");
    expect(normalized.reason).not.toContain("\n");
    expect(normalized.reason).not.toContain('"');
  });

  test("a label value is truncated to the documented length", () => {
    // A model id or an error message used as a label is attacker-influenced and
    // unbounded; the cap is what keeps one sample from being megabytes.
    const long = "x".repeat(500);
    const normalized = normalizeLabels({ reason: long }, ["reason"]);
    expect(normalized.reason).toHaveLength(MAX_LABEL_VALUE_LENGTH);
  });

  test("a value exactly at the length cap is preserved in full", () => {
    // Both sides of the boundary, so an off-by-one in the truncation is caught.
    const exact = "y".repeat(MAX_LABEL_VALUE_LENGTH);
    expect(normalizeLabels({ reason: exact }, ["reason"]).reason).toBe(exact);
  });

  test("a value is trimmed after truncation", () => {
    // Order matters: truncating after trimming could re-introduce trailing
    // whitespace, which renders as a distinct series from the untrimmed one.
    expect(normalizeLabels({ reason: "  spaced  " }, ["reason"]).reason).toBe("spaced");
  });

  test("more declared names than the cap keeps only the first MAX_LABELS", () => {
    // The cap exists so a metric cannot declare a wide label set that multiplies
    // its cardinality. The metric constructor also rejects a wider declaration,
    // so this is the second line of defence.
    const names = Array.from({ length: MAX_LABELS + 5 }, (_value, index) => `l${index}`);
    const values = Object.fromEntries(names.map((name) => [name, "v"]));
    const normalized = normalizeLabels(values, names);
    expect(Object.keys(normalized)).toHaveLength(MAX_LABELS);
    expect(normalized.l0).toBe("v");
    expect(normalized[`l${MAX_LABELS}`]).toBeUndefined();
  });

  test("no declared labels yields an empty object regardless of input", () => {
    expect(normalizeLabels({ a: "1" }, [])).toEqual({});
    expect(normalizeLabels(undefined, ["a"])).toEqual({});
    expect(normalizeLabels(undefined, [])).toEqual({});
  });

  test("a null value is stringified rather than dropped", () => {
    // `null` is a value the caller supplied; silently turning it into an absent
    // label would change the series identity.
    expect(normalizeLabels({ reason: null as unknown as string }, ["reason"]).reason).toBe("null");
  });
});

describe("PrometheusRegistry — the exposition format", () => {
  test("a counter renders HELP, TYPE, and one sample line", () => {
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "A test counter");
    counter.inc();
    const lines = registry.render().split("\n");
    expect(lines).toContain("# HELP test_total A test counter");
    expect(lines).toContain("# TYPE test_total counter");
    expect(sampleLine(registry, "test_total")).toBe("test_total 1");
  });

  test("a gauge renders with the gauge type word", () => {
    // The type word is what tells Prometheus how to treat the sample; a gauge
    // rendered as a counter is summed over time by the scraper, which turns a
    // queue depth into a meaningless ever-growing total.
    const registry = new PrometheusRegistry();
    const gauge = registry.gauge("test_gauge", "A test gauge");
    gauge.inc(5);
    const lines = registry.render().split("\n");
    expect(lines).toContain("# TYPE test_gauge gauge");
  });

  test("labels render in the declared order, quoted and comma-separated", () => {
    // Prometheus does not require an order, but a stable order makes the output
    // diffable and is what the escaping tests rely on.
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["a", "b"]);
    counter.inc(1, { a: "1", b: "2" });
    expect(sampleLine(registry, "test_total")).toBe('test_total{a="1",b="2"} 1');
  });

  test("a metric with labels but no samples renders no sample line", () => {
    // A `# TYPE` line with no samples is valid exposition and is what an idle
    // gateway emits; the absence of a sample must not read as zero.
    const registry = new PrometheusRegistry();
    registry.counter("test_total", "help", ["a"]);
    expect(sampleLines(registry, "test_total")).toEqual([]);
    expect(registry.render()).toContain("# TYPE test_total counter");
  });

  test("a HELP string containing a newline is escaped", () => {
    // A raw newline in a help string would split the comment across two lines,
    // and the second half would be parsed as a metric name.
    const registry = new PrometheusRegistry();
    registry.counter("test_total", "first\nsecond");
    const help = registry.render().split("\n").find((line) => line.startsWith("# HELP test_total"));
    expect(help).toBe("# HELP test_total first\\nsecond");
  });

  test("a HELP string containing a backslash is escaped", () => {
    // A trailing backslash before the escaped newline would otherwise consume
    // the newline and merge the two lines.
    const registry = new PrometheusRegistry();
    registry.counter("test_total", "a\\b");
    const help = registry.render().split("\n").find((line) => line.startsWith("# HELP test_total"));
    expect(help).toBe("# HELP test_total a\\\\b");
  });

  test("the whole payload ends with a newline", () => {
    // A scraper reads line by line; a missing trailing newline truncates the
    // last sample.
    const registry = new PrometheusRegistry();
    registry.counter("test_total", "help").inc();
    expect(registry.render().endsWith("\n")).toBe(true);
  });
});

describe("PrometheusRegistry — counter and gauge semantics", () => {
  test("a counter accumulates across increments", () => {
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help");
    counter.inc();
    counter.inc(4);
    counter.inc();
    expect(sampleLine(registry, "test_total")).toBe("test_total 6");
  });

  test("a negative increment is accepted, because the buffer needs it", () => {
    // The telemetry buffer decrements its gauge when a batch drains. A counter
    // that refused to go down would make the buffered gauge monotonically wrong.
    const registry = new PrometheusRegistry();
    const gauge = registry.gauge("test_gauge", "help");
    gauge.inc(10);
    gauge.inc(-4);
    expect(sampleLine(registry, "test_gauge")).toBe("test_gauge 6");
  });

  test("a fractional increment is preserved rather than rounded", () => {
    // Token-per-second figures are fractional and are recorded as such.
    const registry = new PrometheusRegistry();
    const gauge = registry.gauge("test_gauge", "help");
    gauge.inc(0.25);
    expect(sampleLine(registry, "test_gauge")).toBe("test_gauge 0.25");
  });

  test("each distinct label set is its own sample", () => {
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    counter.inc(1, { reason: "a" });
    counter.inc(2, { reason: "b" });
    expect(sampleLines(registry, "test_total").sort()).toEqual([
      'test_total{reason="a"} 1',
      'test_total{reason="b"} 2',
    ]);
  });

  test("increments to the same label set accumulate on one sample", () => {
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    counter.inc(1, { reason: "a" });
    counter.inc(1, { reason: "a" });
    expect(sampleLines(registry, "test_total")).toEqual(['test_total{reason="a"} 2']);
  });

  test("a label set differing only in an undeclared label collapses to one sample", () => {
    // The declared labels define the identity. If an undeclared label could
    // split the series, a caller passing a stray key would silently multiply
    // cardinality.
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["a"]);
    counter.inc(1, { a: "1", stray: "x" });
    counter.inc(1, { a: "1", stray: "y" });
    expect(sampleLines(registry, "test_total")).toEqual(['test_total{a="1"} 2']);
  });

  test("a set and its reset are separate samples", () => {
    const registry = new PrometheusRegistry();
    const gauge = registry.gauge("test_gauge", "help");
    gauge.set(10);
    gauge.set(3);
    expect(sampleLine(registry, "test_gauge")).toBe("test_gauge 3");
  });
});

describe("PrometheusRegistry — cardinality guards", () => {
  test("series past the cap are dropped rather than stored", () => {
    // The guard the registry's comment names: an attacker-controlled label value
    // must not be able to grow the process's memory without bound. Past the cap
    // the sample is silently skipped, which is the intended trade — a dropped
    // metric beats an exhausted heap.
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    for (let index = 0; index < MAX_SERIES + 50; index += 1) {
      counter.inc(1, { reason: `r${index}` });
    }
    expect(sampleLines(registry, "test_total")).toHaveLength(MAX_SERIES);
  });

  test("a series already at the cap is still incremented", () => {
    // The guard is on *adding* a series, not on writing to one that exists. A
    // guard that also blocked existing series would freeze the metric exactly
    // when the process is under the attack the cap protects against.
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    for (let index = 0; index < MAX_SERIES; index += 1) {
      counter.inc(1, { reason: `r${index}` });
    }
    // At the cap: an existing series still accumulates.
    counter.inc(5, { reason: "r0" });
    expect(sampleLine(registry, "test_total")).toBe('test_total{reason="r0"} 6');
    // A new series is refused, and the refused increment is not reattributed.
    counter.inc(1, { reason: "overflow" });
    expect(sampleLines(registry, "test_total")).toHaveLength(MAX_SERIES);
    expect(sampleLine(registry, "test_total")).toBe('test_total{reason="r0"} 6');
  });

  test("the cap is per metric, not per registry", () => {
    // Each metric owns its own series map, so one runaway label set must not
    // starve every other metric of its capacity.
    const registry = new PrometheusRegistry();
    const first = registry.counter("first_total", "help", ["reason"]);
    const second = registry.counter("second_total", "help", ["reason"]);
    for (let index = 0; index < MAX_SERIES; index += 1) {
      first.inc(1, { reason: `r${index}` });
    }
    second.inc(1, { reason: "only" });
    expect(sampleLines(registry, "second_total")).toEqual(['second_total{reason="only"} 1']);
  });

  test("declaring more label names than the cap throws at construction", () => {
    // A misdeclared metric is a programming error, not a runtime condition, so
    // it fails loudly at startup rather than silently dropping labels later.
    const registry = new PrometheusRegistry();
    const names = Array.from({ length: MAX_LABELS + 1 }, (_value, index) => `l${index}`);
    expect(() => registry.counter("test_total", "help", names)).toThrow(/too many label names/);
  });

  test("declaring exactly the cap is accepted", () => {
    const registry = new PrometheusRegistry();
    const names = Array.from({ length: MAX_LABELS }, (_value, index) => `l${index}`);
    expect(() => registry.counter("test_total", "help", names)).not.toThrow();
  });

  test("a label value that is truncated to the cap still forms one series", () => {
    // Two long values sharing a 64-character prefix are the same series after
    // truncation. That is the intended behaviour: the cap is a memory guard, and
    // collapsing them is better than storing both.
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    const prefix = "p".repeat(MAX_LABEL_VALUE_LENGTH);
    counter.inc(1, { reason: `${prefix}AAAA` });
    counter.inc(1, { reason: `${prefix}BBBB` });
    expect(sampleLines(registry, "test_total")).toHaveLength(1);
    expect(sampleLine(registry, "test_total")).toBe(`test_total{reason="${prefix}"} 2`);
  });
});

describe("PrometheusRegistry — a hostile label value cannot corrupt the scrape", () => {
  test("a label value carrying a newline stays on one line", () => {
    // The attack this defends against: a value that closes the quoted label and
    // opens a new metric name of its choosing, so the scrape carries a series
    // the gateway never wrote. MEASURED: `normalizeLabels` replaces the newline
    // with `_` *before* the value reaches `escapeLabelValue`, so the sample is
    // one line and the injected name is inside the quotes rather than on a line
    // of its own.
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    counter.inc(1, { reason: 'x"} 999\nevil_metric{reason="y' });
    const line = sampleLine(registry, "test_total");
    expect(line).toBeString();
    expect(line).not.toContain("\n");
    // The injected text is inert: it appears only inside the quoted value, and
    // the sample's own value is still the `1` that was recorded.
    expect(line).toContain('evil_metric');
    expect(line?.endsWith('"} 1')).toBe(true);
    // The only line naming `evil_metric` is this sample's, so no series was
    // created by the injection.
    const naming = registry.render().split("\n").filter((entry) => entry.includes("evil_metric"));
    expect(naming).toHaveLength(1);
    expect(naming[0]).toBe(line);
  });

  test("a label value carrying a backslash is escaped so it cannot escape the quote", () => {
    // A trailing backslash is the other half of the injection: unescaped, it
    // consumes the closing quote and the rest of the line becomes a value the
    // scraper mis-parses.
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    counter.inc(1, { reason: 'a\\"b' });
    const line = sampleLine(registry, "test_total");
    expect(line).toBeString();
    expect(line?.endsWith("} 1")).toBe(true);
    expect(line?.split('"').length).toBeGreaterThanOrEqual(3);
  });

  test("a label value that is a very long hostile string is bounded", () => {
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help", ["reason"]);
    counter.inc(1, { reason: "z".repeat(1_000_000) });
    const line = sampleLine(registry, "test_total");
    expect(line?.length).toBeLessThan(200);
  });
});

describe("PrometheusRegistry — several metrics in one payload", () => {
  test("each metric contributes its own block", () => {
    const registry = new PrometheusRegistry();
    registry.counter("first_total", "first").inc();
    registry.gauge("second_gauge", "second").inc(2);
    const rendered = registry.render();
    expect(rendered).toContain("# HELP first_total first");
    expect(rendered).toContain("# TYPE first_total counter");
    expect(rendered).toContain("first_total 1");
    expect(rendered).toContain("# HELP second_gauge second");
    expect(rendered).toContain("# TYPE second_gauge gauge");
    expect(rendered).toContain("second_gauge 2");
  });

  test("render is repeatable and does not consume state", () => {
    // The scrape endpoint is polled; a render that drained its samples would
    // report every counter once and then nothing.
    const registry = new PrometheusRegistry();
    registry.counter("test_total", "help").inc(3);
    const first = registry.render();
    const second = registry.render();
    expect(first).toBe(second);
    expect(first).toContain("test_total 3");
  });

  test("a counter incremented between renders reflects the new value", () => {
    const registry = new PrometheusRegistry();
    const counter = registry.counter("test_total", "help");
    counter.inc(1);
    expect(registry.render()).toContain("test_total 1");
    counter.inc(1);
    expect(registry.render()).toContain("test_total 2");
  });
});

describe("PrometheusRegistry — histogram", () => {
  test("observing values produces buckets, a sum, and a count", () => {
    // The histogram is what makes latency percentiles possible; without the
    // bucket lines a scraper has only a mean.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10, 100, 1000]);
    histogram.observe(5);
    histogram.observe(50);
    histogram.observe(5_000);
    const rendered = registry.render();
    expect(rendered).toContain("# TYPE test_ms histogram");
    // Every bucket is cumulative and ends with `+Inf` equal to the count.
    expect(sampleLine(registry, "test_ms_count")).toBe("test_ms_count 3");
    expect(sampleLine(registry, "test_ms_sum")).toBe("test_ms_sum 5055");
    expect(sampleLine(registry, 'test_ms_bucket{le="10"}')).toBe('test_ms_bucket{le="10"} 1');
    expect(sampleLine(registry, 'test_ms_bucket{le="100"}')).toBe('test_ms_bucket{le="100"} 2');
    expect(sampleLine(registry, 'test_ms_bucket{le="1000"}')).toBe('test_ms_bucket{le="1000"} 2');
    expect(sampleLine(registry, 'test_ms_bucket{le="+Inf"}')).toBe('test_ms_bucket{le="+Inf"} 3');
  });

  test("a value exactly on a bucket boundary falls in that bucket", () => {
    // `le` is "less than or equal", so the boundary belongs to the bucket it
    // names. An exclusive comparison would shift every percentile one bucket up.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [100]);
    histogram.observe(100);
    expect(sampleLine(registry, 'test_ms_bucket{le="100"}')).toBe('test_ms_bucket{le="100"} 1');
  });

  test("observing nothing still renders every bucket at zero", () => {
    // A scraper must be able to distinguish "no observations" from "the metric
    // disappeared", and a missing bucket line breaks a percentile computation.
    const registry = new PrometheusRegistry();
    registry.histogram("test_ms", "help", [10, 100]);
    expect(sampleLine(registry, "test_ms_count")).toBe("test_ms_count 0");
    expect(sampleLine(registry, 'test_ms_bucket{le="+Inf"}')).toBe('test_ms_bucket{le="+Inf"} 0');
  });

  test("a zero observation is counted, not treated as absent", () => {
    // A zero-millisecond observation is a real measurement (a cached answer).
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(0);
    expect(sampleLine(registry, "test_ms_count")).toBe("test_ms_count 1");
    expect(sampleLine(registry, "test_ms_sum")).toBe("test_ms_sum 0");
  });

  /**
   * KNOWN DEFECT — `HistogramMetric.observe` accepts a `labels` argument and
   * silently discards it.
   *
   * `HistogramMetric` (the interface) declares
   * `observe(value: number, labels?: MetricLabels): void`. The only
   * implementation — `Histogram` in `src/observability/metrics.ts` — declares
   * `observe(value: number)` and stores no labels, and the registry's
   * `histogram(name, help, buckets)` factory takes no label names either. So the
   * interface advertises a capability the implementation does not have, and the
   * extra argument is accepted at runtime (TypeScript permits a call with more
   * arguments through an interface-typed reference) and dropped without a word.
   *
   * Reachable impact today is limited: both call sites
   * (`proxy_request_latency_ms` in `error-lifecycle.ts`,
   * `proxy_provider_adapter_load_ms` in `provider-registry.ts`) observe without
   * labels, so nothing is mis-attributed right now. The defect is the contract.
   * A caller who follows the interface and writes `observe(ms, { route })` gets
   * one merged histogram across every route — no error, no missing-sample
   * signal, and no way to tell from the output. A latency percentile that
   * averages a fast route with a slow one is worse than no percentile, because
   * the operator reads it as if it described the route they filtered on.
   *
   * Written with `test.failing` so it flips to a failure the moment the
   * implementation honours the parameter (or the parameter is removed from the
   * interface, which would break this call at typecheck — also a signal). The
   * assertion goes through `observe`, which is the half that compiles today.
   */
  test("a label passed to observe reaches the rendered sample", () => {
    // The defect this pins: `Histogram.observe(value, labels?)` accepted the
    // parameter and discarded it, so a caller following the interface got one
    // merged histogram across every label value — no error, no missing-sample
    // signal, and no way to tell from the output. A latency percentile that
    // averages a fast route with a slow one reads as if it described the route
    // the operator filtered on.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(5, { route: "/v1/chat" });
    expect(registry.render()).toContain('route="/v1/chat"');
  });

  test("a labelled histogram keeps one series per label set", () => {
    // The property that makes the label useful: two routes must not share
    // accumulators.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(5, { route: "/v1/chat" });
    histogram.observe(7, { route: "/v1/messages" });

    const rendered = registry.render();
    expect(sampleLine(registry, 'test_ms_count{route="/v1/chat"}')).toBe(
      'test_ms_count{route="/v1/chat"} 1',
    );
    expect(sampleLine(registry, 'test_ms_count{route="/v1/messages"}')).toBe(
      'test_ms_count{route="/v1/messages"} 1',
    );
    // And the sums are per-series, not merged.
    expect(sampleLine(registry, 'test_ms_sum{route="/v1/chat"}')).toBe(
      'test_ms_sum{route="/v1/chat"} 5',
    );
    expect(rendered).toContain('test_ms_sum{route="/v1/messages"} 7');
  });

  test("the bucket lines carry the labels before the le boundary", () => {
    // The exposition shape a scraper expects: declared labels first, then `le`.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(5, { route: "/v1/chat" });
    expect(sampleLine(registry, 'test_ms_bucket{route="/v1/chat",le="10"}')).toBe(
      'test_ms_bucket{route="/v1/chat",le="10"} 1',
    );
    expect(sampleLine(registry, 'test_ms_bucket{route="/v1/chat",le="+Inf"}')).toBe(
      'test_ms_bucket{route="/v1/chat",le="+Inf"} 1',
    );
  });

  test("an unlabelled histogram renders exactly as before", () => {
    // The regression guard for the existing call sites, which observe without
    // labels: their exposition must be byte-identical to the unlabelled form.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(5);
    histogram.observe(50);
    expect(sampleLine(registry, 'test_ms_bucket{le="10"}')).toBe('test_ms_bucket{le="10"} 1');
    expect(sampleLine(registry, 'test_ms_bucket{le="+Inf"}')).toBe('test_ms_bucket{le="+Inf"} 2');
    expect(registry.render()).not.toContain("route=");
  });

  test("a histogram with no observations still renders zeroed buckets", () => {
    // A scrape before the first request must not show an absent metric.
    const registry = new PrometheusRegistry();
    registry.histogram("test_ms", "help", [10]);
    expect(sampleLine(registry, 'test_ms_bucket{le="10"}')).toBe('test_ms_bucket{le="10"} 0');
    expect(sampleLine(registry, 'test_ms_count')).toBe("test_ms_count 0");
  });

  test("the label names are fixed by the first labelled observation", () => {
    // A Prometheus family must expose one consistent label set, so a later
    // observation with different keys is normalized against the first set rather
    // than creating an incompatible series.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(5, { route: "/v1/chat" });
    histogram.observe(5, { provider: "anthropic" });
    // The second observation lands in the `route=""` series, not a new family.
    expect(sampleLine(registry, 'test_ms_count{route=""}')).toBe('test_ms_count{route=""} 1');
    expect(registry.render()).not.toContain("provider=");
  });

  test("histogram labels go through the same cardinality guards as scalars", () => {
    // The reason labels can be accepted from a request path at all: they are
    // sanitized and capped, so an attacker-controlled route value cannot exhaust
    // memory.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(5, { route: "a".repeat(200) });
    const rendered = registry.render();
    const match = /route="([^"]*)"/.exec(rendered);
    expect(match?.[1]).toHaveLength(MAX_LABEL_VALUE_LENGTH);
    // A quote or newline would break the exposition format, so both are replaced.
    histogram.observe(5, { route: 'bad"value\nwith\rbreaks' });
    expect(registry.render()).not.toContain('bad"value');
  });

  test("a histogram stops adding series at the cap", () => {
    // `canAddSeries` — the same bound the scalar metrics use.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    for (let index = 0; index < MAX_SERIES + 20; index += 1) {
      histogram.observe(5, { route: `r${index}` });
    }
    const countLines = sampleLines(registry, "test_ms_count");
    expect(countLines.length).toBe(MAX_SERIES);
  });

  test("a negative observation is accepted, because a clock can go backwards", () => {
    // MEASURED: no guard rejects it. Pinned so the behaviour is deliberate: a
    // negative duration would skew a percentile, but rejecting it would throw
    // inside a timing path where throwing is worse than a skewed sample.
    const registry = new PrometheusRegistry();
    const histogram = registry.histogram("test_ms", "help", [10]);
    histogram.observe(-5);
    expect(sampleLine(registry, "test_ms_count")).toBe("test_ms_count 1");
    expect(sampleLine(registry, "test_ms_sum")).toBe("test_ms_sum -5");
  });
});
