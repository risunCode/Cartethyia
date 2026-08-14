import { describe, expect, test } from "vitest";
import { parseOverviewData } from "../../../src/features/overview/page";

describe("parseOverviewData — current console response contract", () => {
  test("normalizes the registered provider and usage summary fields", () => {
    expect(parseOverviewData({ totals: { requests: 2, inputTokens: 10, outputTokens: 4, cachedTokens: 1, errors: 0 }, inFlight: 1, providers: [{ providerId: "openai", requests: 2, inputTokens: 10, cachedTokens: 1, outputTokens: 4, errors: 0 }], proxyAuthMode: "api_key", registered: ["openai"] })).toMatchObject({ registered: ["openai"], totals: { requests: 2, avgDurationMs: 0, estimatedCostUsd: 0 }, providers: [{ id: "openai", requestsToday: 2, status: "ok" }] });
  });

  test("rejects missing required collections instead of rendering a false success", () => {
    expect(parseOverviewData({ totals: { requests: 0 }, registered: [] })).toBeNull();
  });
});

