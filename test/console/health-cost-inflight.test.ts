/**
 * Health metrics/GC (memory+CPU+"Clear RAM usage"), estimated cost, and
 * in-flight request count (REQ-9 follow-up).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";
import { insertUsageHistory, queryUsageCost, utcNow } from "../../src/console/db/repos/usage";
import { getInFlightCount, resetInFlightForTests, subscribeInFlight } from "../../src/console/tracking/in-flight";
import { cancelScheduledGc } from "../../src/console/memory";
import { createRequestTracker } from "../../src/console/tracking/tracker";
import { activeFlights } from "../../src/http/traffic";

let cookie: string;

beforeEach(async () => {
  useIsolatedDataDir();
  resetInFlightForTests();
  cookie = await loginAndGetCookie();
});

describe("GET /console/api/health/metrics", () => {
  test("reports process memory, system-wide used memory, system total, and a CPU percent in [0,100]", async () => {
    const res = await app.handle(new Request("http://localhost/console/api/health/metrics", { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memoryUsedMb: number; memorySystemUsedMb: number; memoryTotalMb: number; cpuPercent: number };
    expect(body.memoryUsedMb).toBeGreaterThan(0);
    expect(body.memorySystemUsedMb).toBeGreaterThan(0);
    expect(body.memoryTotalMb).toBeGreaterThan(0);
    // "This program" usage must be a subset of the whole machine's usage.
    expect(body.memoryUsedMb).toBeLessThanOrEqual(body.memoryTotalMb);
    expect(body.memorySystemUsedMb).toBeLessThanOrEqual(body.memoryTotalMb);
    expect(body.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(body.cpuPercent).toBeLessThanOrEqual(100);
  });
});

describe("POST /console/api/health/gc", () => {
  test("schedules process-wide asynchronous GC and reports a before/after snapshot", async () => {
    const res = await app.handle(new Request("http://localhost/console/api/health/gc", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { before: { memoryUsedMb: number }; after: { memoryUsedMb: number }; gc: { status: string; inFlight: number } };
    expect(body.before.memoryUsedMb).toBeGreaterThan(0);
    expect(body.after.memoryUsedMb).toBeGreaterThan(0);
    expect(["scheduled", "already_pending"]).toContain(body.gc.status);
    expect(body.gc.inFlight).toBe(0);
  });

  test("defers GC while a proxy request is in flight", async () => {
    const tracker = createRequestTracker({
      endpoint: "/v1/chat/completions",
      surface: "chat",
      model: "kimchi/kimi-k2.7",
      stream: false,
      request: new Request("http://localhost/v1/chat/completions"),
      apiKey: null,
    });

    const res = await app.handle(new Request("http://localhost/console/api/health/gc", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }));
    const body = (await res.json()) as { gc: { status: string; inFlight: number } };
    expect(body.gc.status).toBe("deferred");
    expect(body.gc.inFlight).toBe(1);

    tracker.finishJson(200, { ok: true }, "kimchi", {});
    cancelScheduledGc();
  });
});

describe("estimated cost", () => {
  test("a request against an unpriced provider (aggregator/subscription, no per-token rate card) contributes $0 and marks the total partial", async () => {
    insertUsageHistory({
      traceId: "cost-trace-1", endpoint: "/v1/chat/completions", surface: "chat", apiKeyId: null, apiKeyPrefix: null,
      // Kimchi's own catalog now carries an explicit $0 rate card (a priced
      // model that just happens to bill nothing), which no longer represents
      // "no rate card at all" — cursor's "default" has no pricing field.
      provider: "cursor", model: "default", status: 200, errorKind: null, stream: false,
      startedAt: utcNow(), finishedAt: utcNow(), durationMs: 500,
      inputTokens: 1000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1500,
      usageSource: "provider", meta: {},
    });

    const overviewRes = await app.handle(new Request("http://localhost/console/api/overview", { headers: { cookie } }));
    const overview = (await overviewRes.json()) as { totals: { estimatedCostUsd: number; partial: boolean } };
    expect(overview.totals.estimatedCostUsd).toBe(0);
    expect(overview.totals.partial).toBe(true);

    const summaryRes = await app.handle(new Request("http://localhost/console/api/usage/summary?period=24h", { headers: { cookie } }));
    const summary = (await summaryRes.json()) as { estimatedCostUsd: number; partial: boolean };
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.partial).toBe(true);
  });

  test("a request against a priced provider is costed from that model's own real rate, no settings involved", async () => {
    insertUsageHistory({
      traceId: "cost-trace-2", endpoint: "/v1/chat/completions", surface: "chat", apiKeyId: null, apiKeyPrefix: null,
      provider: "openai", model: "gpt-5.6-sol", status: 200, errorKind: null, stream: false,
      startedAt: utcNow(), finishedAt: utcNow(), durationMs: 500,
      inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2_000_000,
      usageSource: "provider", meta: {},
    });

    const summaryRes = await app.handle(new Request("http://localhost/console/api/usage/summary?period=24h", { headers: { cookie } }));
    const summary = (await summaryRes.json()) as { estimatedCostUsd: number; partial: boolean };
    // gpt-5.6-sol: $5/M input + $30/M output → 1M input + 1M output = $35
    expect(summary.estimatedCostUsd).toBe(35);
    expect(summary.partial).toBe(false);
  });

  test("queryUsageCost mixes priced and unpriced requests correctly, only the priced one contributes", () => {
    insertUsageHistory({
      traceId: "cost-trace-3", endpoint: "/v1/chat/completions", surface: "chat", apiKeyId: null, apiKeyPrefix: null,
      provider: "openai", model: "gpt-5.4-mini", status: 200, errorKind: null, stream: false,
      startedAt: utcNow(), finishedAt: utcNow(), durationMs: 500,
      inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1_000_000,
      usageSource: "provider", meta: {},
    });
    insertUsageHistory({
      traceId: "cost-trace-4", endpoint: "/v1/chat/completions", surface: "chat", apiKeyId: null, apiKeyPrefix: null,
      // Cursor's "default" (server auto-picks the model) genuinely has no
      // rate card — unlike ollama's models, which now carry real pricing.
      provider: "cursor", model: "default", status: 200, errorKind: null, stream: false,
      startedAt: utcNow(), finishedAt: utcNow(), durationMs: 500,
      inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1_000_000,
      usageSource: "provider", meta: {},
    });

    const cost = queryUsageCost("24h");
    // gpt-5.4-mini: $0.75/M input → $0.75; cursor's "default" has no rate card, contributes $0 and flips partial.
    expect(cost.estimatedCostUsd).toBe(0.75);
    expect(cost.partial).toBe(true);
  });
});

describe("in-flight request count", () => {
  test("increments and decrements exactly once per request lifecycle", () => {
    expect(getInFlightCount()).toBe(0);
    const seen: number[] = [];
    const unsubscribe = subscribeInFlight((count) => seen.push(count));

    const tracker = createRequestTracker({
      endpoint: "/v1/chat/completions",
      surface: "chat",
      model: "kimchi/kimi-k2.7",
      stream: false,
      request: new Request("http://localhost/v1/chat/completions"),
      apiKey: null,
    });
    expect(getInFlightCount()).toBe(1);

    tracker.finishJson(200, { ok: true }, "kimchi", {});
    expect(getInFlightCount()).toBe(0);
    expect(seen).toEqual([1, 0]);
    unsubscribe();
  });

  test("GET /console/api/live/in-flight reflects the live counter", async () => {
    const before = await app.handle(new Request("http://localhost/console/api/live/in-flight", { headers: { cookie } }));
    expect((await before.json() as { inFlight: number }).inFlight).toBe(0);
  });
});

describe("per-IP active flight visibility (maxFlightsPerIp enforcement)", () => {
  test("GET /console/api/live/in-flight exposes activeFlights' per-IP snapshot and the configured limit", async () => {
    activeFlights.clear();
    activeFlights.acquire("203.0.113.5", 20);
    activeFlights.acquire("203.0.113.5", 20);
    activeFlights.acquire("198.51.100.9", 20);

    const res = await app.handle(new Request("http://localhost/console/api/live/in-flight", { headers: { cookie } }));
    const body = (await res.json()) as { byIp: Array<{ ip: string; active: number }>; maxFlightsPerIp: number };
    expect(body.byIp).toEqual([
      { ip: "203.0.113.5", active: 2 },
      { ip: "198.51.100.9", active: 1 },
    ]);
    expect(body.maxFlightsPerIp).toBeGreaterThan(0);

    activeFlights.clear();
  });
});
