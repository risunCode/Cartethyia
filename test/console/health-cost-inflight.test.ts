/**
 * Health metrics/GC (memory+CPU+"Clear RAM usage"), estimated cost, and
 * in-flight request count (REQ-9 follow-up).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";
import { insertUsageHistory, utcNow } from "../../src/console/db/repos/usage";
import { getInFlightCount, resetInFlightForTests, subscribeInFlight } from "../../src/console/tracking/in-flight";
import { estimateCostUsd } from "../../src/console/tracking/cost";
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
  test("runs cross-platform GC (Bun.gc, not a shelled-out OS command) and reports a before/after snapshot", async () => {
    const res = await app.handle(new Request("http://localhost/console/api/health/gc", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { before: { memoryUsedMb: number }; after: { memoryUsedMb: number } };
    expect(body.before.memoryUsedMb).toBeGreaterThan(0);
    expect(body.after.memoryUsedMb).toBeGreaterThan(0);
  });
});

describe("estimated cost", () => {
  test("estimateCostUsd blends input/output rates over the given token counts", () => {
    expect(estimateCostUsd(1_000_000, 500_000, 1, 2)).toBe(2); // 1*1 + 0.5*2
    expect(estimateCostUsd(100, 100, 0, 0)).toBe(0);
  });

  test("/overview and /usage/summary report $0 estimatedCostUsd while cost rates are unconfigured", async () => {
    insertUsageHistory({
      traceId: "cost-trace-1", endpoint: "/v1/chat/completions", surface: "chat", apiKeyId: null, apiKeyPrefix: null,
      provider: "kimchi", model: "kimchi/kimi-k2.7", status: 200, errorKind: null, stream: false,
      startedAt: utcNow(), finishedAt: utcNow(), durationMs: 500,
      inputTokens: 1000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1500,
      usageSource: "provider", meta: {},
    });

    const overviewRes = await app.handle(new Request("http://localhost/console/api/overview", { headers: { cookie } }));
    const overview = (await overviewRes.json()) as { totals: { estimatedCostUsd: number } };
    expect(overview.totals.estimatedCostUsd).toBe(0);

    const summaryRes = await app.handle(new Request("http://localhost/console/api/usage/summary?period=24h", { headers: { cookie } }));
    const summary = (await summaryRes.json()) as { estimatedCostUsd: number };
    expect(summary.estimatedCostUsd).toBe(0);
  });

  test("configuring cost rates makes /overview and /usage/summary report a non-zero estimate", async () => {
    insertUsageHistory({
      traceId: "cost-trace-2", endpoint: "/v1/chat/completions", surface: "chat", apiKeyId: null, apiKeyPrefix: null,
      provider: "kimchi", model: "kimchi/kimi-k2.7", status: 200, errorKind: null, stream: false,
      startedAt: utcNow(), finishedAt: utcNow(), durationMs: 500,
      inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2_000_000,
      usageSource: "provider", meta: {},
    });

    const patchRes = await app.handle(postJson("/console/api/settings", { costPerMillionInputTokens: 1, costPerMillionOutputTokens: 3 }, { cookie }));
    expect(patchRes.status).toBe(200);

    const summaryRes = await app.handle(new Request("http://localhost/console/api/usage/summary?period=24h", { headers: { cookie } }));
    const summary = (await summaryRes.json()) as { estimatedCostUsd: number };
    // 1M input @ $1/M + 1M output @ $3/M = $4
    expect(summary.estimatedCostUsd).toBe(4);
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
