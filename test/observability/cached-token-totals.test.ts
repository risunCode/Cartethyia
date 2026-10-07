/**
 * Cached-token aggregation must sum the cached count, not the whole input.
 *
 * A request that hits the cache at all still carries fresh tokens, and the
 * Usage page prices nothing itself — it only displays what these folds report.
 * Counting every input token of a cache-touching request as cached made a
 * 99.6% hit rate out of traffic that was not, and made the estimated cost look
 * like it ignored the cache. The cost is computed per request from the real
 * split; only the displayed cached total was wrong.
 */
import { describe, expect, test } from "bun:test";
import { accumulate, emptyTotals, type TelemetryEventRecord } from "../../src/observability/event-log";

function event(inputTokens: number, cachedInputTokens: number | null): TelemetryEventRecord {
  return {
    id: "e",
    createdAt: "2026-01-01T00:00:00.000Z",
    requestId: "r",
    sourceSurface: null,
    requestedModel: null,
    requestedEffort: null,
    providerId: null,
    accountId: null,
    networkPoolId: null,
    endpoint: null,
    apiKeyId: null,
    userAgent: null,
    clientIp: null,
    latencyMs: null,
    ttfbMs: null,
    stream: null,
    status: "completed",
    httpStatus: 200,
    errorOrigin: null,
    errorCategory: null,
    inputTokens,
    cachedInputTokens,
    outputTokens: 0,
    reasoningTokens: null,
    estimatedCostUsd: null,
    creditUsed: null,
    resolveMs: null,
    tokensPerSec: null,
    firstContentDeltaAtMs: null,
    lastEventAtMs: null,
  };
}

describe("cached token totals", () => {
  test("a partial cache hit counts only the cached tokens, not the whole input", () => {
    const totals = emptyTotals();
    accumulate(totals, event(1_000, 900));
    accumulate(totals, event(500, null));
    expect(totals.inputTokens).toBe(1_500);
    expect(totals.cachedTokens).toBe(900);
  });
});
