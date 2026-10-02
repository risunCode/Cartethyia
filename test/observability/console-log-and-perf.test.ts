/**
 * The console log ring and the performance counters.
 *
 * Both are bounded in-memory stores that exist to be *read* by an operator, and
 * both take untrusted keys — a provider id, an upstream hostname, a request id.
 * So the properties worth pinning are the bounds and the truncation, not the
 * happy path:
 *
 * - **The ring is a ring.** `log-ring.ts` caps at 500 lines and drops the OLDEST,
 *   which is the right direction for a live tail: the newest lines are the ones an
 *   operator is watching for. A cap that dropped the newest would make the page
 *   useless exactly when something is going wrong.
 * - **A subscriber must not be able to break logging.** A throwing listener is
 *   caught per-listener, and a listener that throws on `init` must not stop the
 *   others from being registered.
 * - **`performance-metrics.ts` drops rather than evicts once full.** The comment
 *   says so, and the direction matters: evicting would mean a hostile upstream
 *   hostname could push out a legitimate series.
 *
 * Both modules keep module-level state, so every test resets it through the
 * exported test hooks. That is not incidental — a suite that did not would be
 * order-dependent, and the ring's 500-line cap makes cross-test bleed very
 * visible.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearConsoleLogs,
  CONSOLE_LOG_LEVELS,
  type ConsoleLogEvent,
  type ConsoleLogLine,
  getConsoleLogSnapshot,
  pushConsoleLog,
  pushStructuredConsoleLog,
  resetConsoleLogsForTests,
  subscribeConsoleLogs,
} from "../../src/observability/log-ring";
import {
  MAX_PERFORMANCE_ENTRIES,
  performanceMetricsSnapshot,
  resetPerformanceMetricsForTesting,
  trackAdapterLoad,
  trackMemoryUsage,
  trackModelCatalogLoad,
  trackNetworkCall,
} from "../../src/observability/performance-metrics";

beforeEach(() => {
  resetConsoleLogsForTests();
  resetPerformanceMetricsForTesting();
});

describe("log-ring — the documented constants", () => {
  test("the four levels are the documented set", () => {
    // The level is what colours the row and what the filter keys on.
    expect([...CONSOLE_LOG_LEVELS]).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("log-ring — appending and reading", () => {
  test("a pushed line is readable in the snapshot", () => {
    pushConsoleLog("info", "hello");
    const snapshot = getConsoleLogSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.msg).toBe("hello");
    expect(snapshot[0]?.level).toBe("info");
  });

  test("every line carries an ISO timestamp", () => {
    // The page renders it and sorts on it; a non-parseable stamp would sort wrong.
    pushConsoleLog("warn", "stamped");
    const ts = getConsoleLogSnapshot()[0]?.ts;
    expect(typeof ts).toBe("string");
    expect(Number.isNaN(new Date(ts ?? "").getTime())).toBe(false);
  });

  test("lines keep their arrival order", () => {
    pushConsoleLog("info", "first");
    pushConsoleLog("info", "second");
    pushConsoleLog("info", "third");
    expect(getConsoleLogSnapshot().map((line) => line.msg)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("the snapshot is a copy, so a caller cannot mutate the ring", () => {
    // The page holds the snapshot across renders; a shared array would let it
    // corrupt the ring.
    pushConsoleLog("info", "one");
    const snapshot = getConsoleLogSnapshot();
    snapshot.push({ ts: "x", level: "info", msg: "injected" });
    snapshot.length = 0;
    expect(getConsoleLogSnapshot()).toHaveLength(1);
  });

  test("structured metadata is carried through", () => {
    pushStructuredConsoleLog("error", "failed", {
      event: "request_error",
      requestId: "req_1",
      endpoint: "/v1/chat",
      method: "POST",
      model: "claude-sonnet-4",
      routedModel: "anthropic/claude-sonnet-4",
      providerId: "anthropic",
      accountId: "acct_1",
      accountLabel: "Work",
      networkPoolId: "pool_1",
      clientIp: "203.0.113.7",
      userAgent: "test-agent/1.0",
      status: 502,
      durationMs: 1234,
      errorCode: "platform_unavailable",
      details: { retryAfterMs: 1000 },
    });
    const line = getConsoleLogSnapshot()[0];
    expect(line?.event).toBe("request_error");
    expect(line?.requestId).toBe("req_1");
    expect(line?.routedModel).toBe("anthropic/claude-sonnet-4");
    expect(line?.status).toBe(502);
    expect(line?.durationMs).toBe(1234);
    expect(line?.details).toEqual({ retryAfterMs: 1000 });
  });

  test("the event key is not duplicated into the line", () => {
    // `pushStructuredConsoleLog` destructures `event` out of the metadata, so it
    // must not also survive as an unrelated field.
    pushStructuredConsoleLog("info", "m", { event: "request_start" });
    expect(getConsoleLogSnapshot()[0]?.event).toBe("request_start");
  });

  test("an absent optional metadata field is omitted, not undefined", () => {
    pushStructuredConsoleLog("info", "m", { event: "request_start" });
    const line = getConsoleLogSnapshot()[0];
    expect(line).not.toHaveProperty("requestId");
    expect(line).not.toHaveProperty("status");
  });
});

describe("log-ring — the message cap", () => {
  test("a long message is truncated with an ellipsis", () => {
    // The cap keeps a provider's HTML error page or a huge echo out of memory and
    // out of the SSE frame. The ellipsis is what tells the operator the text was
    // cut rather than the provider having ended mid-sentence.
    const long = "x".repeat(5_000);
    pushConsoleLog("info", long);
    const msg = getConsoleLogSnapshot()[0]?.msg ?? "";
    expect(msg).toHaveLength(2_001);
    expect(msg.endsWith("…")).toBe(true);
  });

  test("a message at the cap is not truncated", () => {
    // The boundary from the accepted side.
    const exact = "y".repeat(2_000);
    pushConsoleLog("info", exact);
    expect(getConsoleLogSnapshot()[0]?.msg).toBe(exact);
    expect(getConsoleLogSnapshot()[0]?.msg).not.toContain("…");
  });

  test("a message one over the cap is truncated", () => {
    pushConsoleLog("info", "z".repeat(2_001));
    const msg = getConsoleLogSnapshot()[0]?.msg ?? "";
    expect(msg).toHaveLength(2_001);
    expect(msg.endsWith("…")).toBe(true);
  });

  test("an empty message is stored as-is", () => {
    pushConsoleLog("info", "");
    expect(getConsoleLogSnapshot()[0]?.msg).toBe("");
  });
});

describe("log-ring — the ring bound", () => {
  test("the ring holds at most 500 lines", () => {
    for (let index = 0; index < 600; index += 1) pushConsoleLog("info", `line-${index}`);
    expect(getConsoleLogSnapshot()).toHaveLength(500);
  });

  test("overflow drops the OLDEST lines", () => {
    // The direction that matters: a live tail must keep the newest lines, because
    // those are the ones an operator is watching for.
    for (let index = 0; index < 600; index += 1) pushConsoleLog("info", `line-${index}`);
    const messages = getConsoleLogSnapshot().map((line) => line.msg);
    expect(messages[0]).toBe("line-100");
    expect(messages[messages.length - 1]).toBe("line-599");
    expect(messages).not.toContain("line-99");
  });

  test("exactly at the cap nothing is dropped", () => {
    for (let index = 0; index < 500; index += 1) pushConsoleLog("info", `line-${index}`);
    const messages = getConsoleLogSnapshot().map((line) => line.msg);
    expect(messages).toHaveLength(500);
    expect(messages[0]).toBe("line-0");
    expect(messages[499]).toBe("line-499");
  });
});

describe("log-ring — clearing", () => {
  test("clearing empties the ring", () => {
    pushConsoleLog("info", "a");
    pushConsoleLog("info", "b");
    clearConsoleLogs();
    expect(getConsoleLogSnapshot()).toEqual([]);
  });

  test("clearing notifies subscribers with a clear event", () => {
    // The page uses this to blank the list without refetching.
    const events: ConsoleLogEvent[] = [];
    subscribeConsoleLogs((event) => events.push(event));
    clearConsoleLogs();
    expect(events.at(-1)).toEqual({ type: "clear" });
  });

  test("the ring is usable after a clear", () => {
    pushConsoleLog("info", "a");
    clearConsoleLogs();
    pushConsoleLog("info", "b");
    expect(getConsoleLogSnapshot().map((line) => line.msg)).toEqual(["b"]);
  });
});

describe("log-ring — subscriptions", () => {
  test("a new subscriber immediately receives the current tail", () => {
    // The documented contract: the page reads a snapshot then subscribes, and the
    // `init` frame is what makes the two not race.
    pushConsoleLog("info", "existing");
    const events: ConsoleLogEvent[] = [];
    subscribeConsoleLogs((event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("init");
    const init = events[0];
    if (init?.type !== "init") throw new Error("expected init");
    expect(init.lines.map((line) => line.msg)).toEqual(["existing"]);
  });

  test("a later line is pushed to the subscriber", () => {
    const received: ConsoleLogLine[] = [];
    subscribeConsoleLogs((event) => {
      if (event.type === "line") received.push(event.line);
    });
    pushConsoleLog("warn", "live");
    expect(received.map((line) => line.msg)).toEqual(["live"]);
  });

  test("every subscriber receives every line", () => {
    const first: string[] = [];
    const second: string[] = [];
    subscribeConsoleLogs((event) => {
      if (event.type === "line") first.push(event.line.msg);
    });
    subscribeConsoleLogs((event) => {
      if (event.type === "line") second.push(event.line.msg);
    });
    pushConsoleLog("info", "both");
    expect(first).toEqual(["both"]);
    expect(second).toEqual(["both"]);
  });

  test("unsubscribing stops delivery", () => {
    // A closed SSE stream must stop accumulating lines in memory.
    const received: string[] = [];
    const unsubscribe = subscribeConsoleLogs((event) => {
      if (event.type === "line") received.push(event.line.msg);
    });
    pushConsoleLog("info", "before");
    unsubscribe();
    pushConsoleLog("info", "after");
    expect(received).toEqual(["before"]);
  });

  test("unsubscribing twice is safe", () => {
    const unsubscribe = subscribeConsoleLogs(() => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  test("a listener that throws on a LINE does not break logging", () => {
    // Documented: "Listener failures must not break logging." The `line` fan-out is
    // wrapped per listener, so one broken SSE consumer must not take the log path
    // down with it.
    //
    // MEASURED: the listener must not throw on `init`, because that call is NOT
    // guarded (see the asymmetry test below). This one tolerates `init` and throws
    // only on a line, which is the shape a real broken consumer has.
    subscribeConsoleLogs((event) => {
      if (event.type === "line") throw new Error("listener exploded");
    });
    expect(() => pushConsoleLog("info", "still logged")).not.toThrow();
    expect(getConsoleLogSnapshot().map((line) => line.msg)).toEqual(["still logged"]);
  });

  test("a listener that throws on a line does not stop the other subscribers", () => {
    // The per-listener try/catch, tested from the side that matters: a healthy
    // subscriber must still receive the line.
    const received: string[] = [];
    subscribeConsoleLogs((event) => {
      if (event.type === "line") throw new Error("first listener explodes");
    });
    subscribeConsoleLogs((event) => {
      if (event.type === "line") received.push(event.line.msg);
    });
    pushConsoleLog("info", "delivered");
    expect(received).toEqual(["delivered"]);
  });

  test("a listener that throws on `clear` does not stop the others", () => {
    // `clearConsoleLogs` has its own per-listener guard; the two fan-out sites are
    // separate code, so both need pinning.
    const sawClear: string[] = [];
    subscribeConsoleLogs((event) => {
      if (event.type === "clear") throw new Error("clear exploded");
    });
    subscribeConsoleLogs((event) => {
      if (event.type === "clear") sawClear.push("clear");
    });
    expect(() => clearConsoleLogs()).not.toThrow();
    expect(sawClear).toEqual(["clear"]);
  });

  test("a listener that throws on init is still registered", () => {
    // MEASURED: `subscribeConsoleLogs` calls the listener with `init` AFTER
    // adding it to the set, and the `init` call is NOT wrapped in a try/catch. So a
    // listener that throws on `init` propagates out of `subscribeConsoleLogs`
    // while remaining subscribed — the caller gets an exception and no
    // unsubscribe function, and the listener keeps receiving lines it cannot
    // handle. Pinned because it is an asymmetry with the `line` path, which IS
    // guarded.
    const received: string[] = [];
    let threw = false;
    try {
      subscribeConsoleLogs((event) => {
        if (event.type === "init") throw new Error("init exploded");
        if (event.type === "line") received.push(event.line.msg);
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // And it is still subscribed, because the throw happened after `add`.
    pushConsoleLog("info", "still delivered");
    expect(received).toEqual(["still delivered"]);
  });

  test("clearing does not remove subscribers", () => {
    const received: string[] = [];
    subscribeConsoleLogs((event) => {
      if (event.type === "line") received.push(event.line.msg);
    });
    clearConsoleLogs();
    pushConsoleLog("info", "after clear");
    expect(received).toEqual(["after clear"]);
  });
});

describe("performance-metrics — recording and snapshot", () => {
  test("a fresh snapshot has four empty series", () => {
    expect(performanceMetricsSnapshot()).toEqual({
      adapter_load_ms: {},
      model_catalog_load_ms: {},
      network_call_latency_ms: {},
      memory_bytes: {},
    });
  });

  test("each tracker writes to its own series", () => {
    // The four series are separate maps; a mis-wired tracker would cross-contaminate
    // two panels of the console.
    trackAdapterLoad("anthropic", 10);
    trackModelCatalogLoad("openai", 20);
    trackNetworkCall("api.example.com", 30);
    trackMemoryUsage("heap", 40);
    expect(performanceMetricsSnapshot()).toEqual({
      adapter_load_ms: { anthropic: 10 },
      model_catalog_load_ms: { openai: 20 },
      network_call_latency_ms: { "api.example.com": 30 },
      memory_bytes: { heap: 40 },
    });
  });

  test("a repeated key is overwritten with the latest value", () => {
    // These are last-known figures, not accumulators.
    trackAdapterLoad("anthropic", 10);
    trackAdapterLoad("anthropic", 99);
    expect(performanceMetricsSnapshot().adapter_load_ms).toEqual({ anthropic: 99 });
  });

  test("a non-finite value is dropped", () => {
    // A NaN latency would render as "NaN ms" and poison any average the console
    // computes.
    trackAdapterLoad("nan", Number.NaN);
    trackAdapterLoad("inf", Number.POSITIVE_INFINITY);
    trackNetworkCall("neg-inf", Number.NEGATIVE_INFINITY);
    expect(performanceMetricsSnapshot().adapter_load_ms).toEqual({});
    expect(performanceMetricsSnapshot().network_call_latency_ms).toEqual({});
  });

  test("zero is a real measurement, not dropped as falsy", () => {
    trackAdapterLoad("instant", 0);
    trackMemoryUsage("empty", 0);
    expect(performanceMetricsSnapshot().adapter_load_ms).toEqual({ instant: 0 });
    expect(performanceMetricsSnapshot().memory_bytes).toEqual({ empty: 0 });
  });

  test("a negative value is stored as-is", () => {
    // No clamp: a negative latency is nonsense but it is the caller's nonsense, and
    // hiding it would make a broken clock harder to diagnose.
    trackAdapterLoad("clock-skew", -5);
    expect(performanceMetricsSnapshot().adapter_load_ms).toEqual({ "clock-skew": -5 });
  });

  test("the snapshot is a plain JSON-serializable object", () => {
    // The console endpoint returns it directly.
    trackAdapterLoad("a", 1);
    const snapshot = performanceMetricsSnapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  test("the snapshot is a copy, so mutating it does not touch the store", () => {
    trackAdapterLoad("a", 1);
    const snapshot = performanceMetricsSnapshot();
    // Each series is rebuilt with `Object.fromEntries` on every call, so the
    // returned object is detached: overwriting a key and emptying a field
    // cannot reach the store. Asserted by assignment rather than `delete`
    // because the snapshot's fields are required in the interface.
    snapshot.adapter_load_ms.a = 999;
    snapshot.model_catalog_load_ms = {};
    expect(performanceMetricsSnapshot().adapter_load_ms).toEqual({ a: 1 });
    expect(performanceMetricsSnapshot()).toHaveProperty("model_catalog_load_ms");
  });
});

describe("performance-metrics — the cardinality cap", () => {
  test("the cap is the documented value", () => {
    expect(MAX_PERFORMANCE_ENTRIES).toBe(256);
  });

  test("a series accepts exactly the cap and then drops new keys", () => {
    // Documented: "once full, new keys are dropped rather than evicting". The
    // direction matters — evicting would let a hostile upstream hostname push out a
    // legitimate series.
    for (let index = 0; index < MAX_PERFORMANCE_ENTRIES; index += 1) {
      trackNetworkCall(`host-${index}`, index);
    }
    expect(Object.keys(performanceMetricsSnapshot().network_call_latency_ms)).toHaveLength(
      MAX_PERFORMANCE_ENTRIES,
    );

    trackNetworkCall("one-too-many", 1);
    const series = performanceMetricsSnapshot().network_call_latency_ms;
    expect(Object.keys(series)).toHaveLength(MAX_PERFORMANCE_ENTRIES);
    expect(series["one-too-many"]).toBeUndefined();
  });

  test("an existing key is still updatable once the series is full", () => {
    // The `!has(key)` guard: the cap blocks NEW keys, not writes. Without this a
    // full series would freeze every value it holds.
    for (let index = 0; index < MAX_PERFORMANCE_ENTRIES; index += 1) {
      trackNetworkCall(`host-${index}`, index);
    }
    trackNetworkCall("host-0", 12_345);
    expect(performanceMetricsSnapshot().network_call_latency_ms["host-0"]).toBe(12_345);
  });

  test("the cap is per series, not shared", () => {
    // Four independent maps, so filling one must not block another.
    for (let index = 0; index < MAX_PERFORMANCE_ENTRIES + 10; index += 1) {
      trackNetworkCall(`host-${index}`, index);
    }
    trackAdapterLoad("still-works", 1);
    expect(performanceMetricsSnapshot().adapter_load_ms).toEqual({ "still-works": 1 });
  });

  test("a dropped key is dropped silently, not stored as undefined", () => {
    for (let index = 0; index < MAX_PERFORMANCE_ENTRIES; index += 1) {
      trackAdapterLoad(`p-${index}`, index);
    }
    trackAdapterLoad("overflow", 1);
    expect("overflow" in performanceMetricsSnapshot().adapter_load_ms).toBe(false);
  });
});

describe("performance-metrics — reset", () => {
  test("the test reset empties every series", () => {
    trackAdapterLoad("a", 1);
    trackModelCatalogLoad("b", 2);
    trackNetworkCall("c", 3);
    trackMemoryUsage("d", 4);
    resetPerformanceMetricsForTesting();
    expect(performanceMetricsSnapshot()).toEqual({
      adapter_load_ms: {},
      model_catalog_load_ms: {},
      network_call_latency_ms: {},
      memory_bytes: {},
    });
  });

  test("a reset series accepts keys again", () => {
    // The reset must clear the map, not just its contents in a way that leaves the
    // cap tripped.
    for (let index = 0; index < MAX_PERFORMANCE_ENTRIES; index += 1) {
      trackAdapterLoad(`p-${index}`, index);
    }
    resetPerformanceMetricsForTesting();
    trackAdapterLoad("fresh", 1);
    expect(performanceMetricsSnapshot().adapter_load_ms).toEqual({ fresh: 1 });
  });
});
