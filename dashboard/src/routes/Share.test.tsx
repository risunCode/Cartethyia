import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SharedKeyActivityDetail, SharedKeySummary } from "../lib/contracts";

const summary: SharedKeySummary = {
  id: "child-secret-id-not-displayed", label: "Recipient", keyPrefix: "rk_child", issuedClientIp: "203.0.113.*",
  createdAt: "2026-09-24T12:00:00.000Z", revokedAt: null, allTime: { requests: 9, errors: 1, inputTokens: 100, outputTokens: 200, totalTokens: 300 },
  today: { requests: 4, errors: 0, inputTokens: 45, outputTokens: 80, totalTokens: 125 }, lastUsedAt: "2026-09-25T12:30:00.000Z",
};
const activity: SharedKeyActivityDetail = {
  models: [{ providerId: "openai", modelId: "gpt-5", retainedRequests: 8, retainedErrors: 1, retainedTokens: 270, todayRequests: 4, todayErrors: 0, todayTokens: 125 }],
  requests: [{ requestId: "event-1", startedAt: "2026-09-25T12:30:00.000Z", providerId: "openai", modelId: "gpt-5", status: "success", httpStatus: 200, clientIp: "203.0.113.*", inputTokens: 10, outputTokens: 15, totalTokens: 25 }],
};
mock.module("../lib/hooks/api-keys", () => ({
  useApiKeys: () => ({ data: [{ id: "parent-id", label: "Team", keyMode: "share", createdAt: "2026-09-01", revokedAt: undefined }], isPending: false, isError: false, refetch: () => Promise.resolve() }),
  useShareApiKey: () => ({ isPending: false, mutate: () => undefined }),
  useRevokeSharedKey: () => ({ isPending: false, mutate: () => undefined }),
  useSharedKeys: () => ({ data: [summary], isPending: false, isError: false, refetch: () => Promise.resolve() }),
  useSharedKeyActivity: () => ({ data: activity, isPending: false, isError: false, refetch: () => Promise.resolve() }),
}));
const { default: ShareRoute, ChildDetail } = await import("./Share");

describe("owner share dashboard", () => {
  test("lists masked recipient IP, prefix, and today/all-time usage without a raw child id", () => {
    const markup = renderToStaticMarkup(createElement(ShareRoute));
    expect(markup).toContain("203.0.113.*");
    expect(markup).toContain("rk_child…");
    expect(markup).toContain("Today requests");
    expect(markup).toContain("Today errors");
    expect(markup).toContain("Today tokens");
    expect(markup).toContain("Lifetime requests");
    expect(markup).toContain("Lifetime errors");
    expect(markup).toContain("Lifetime tokens");
    expect(markup).toContain('class="share-recipient-metrics"');
    expect(markup).not.toContain("child-secret-id-not-displayed");
  });

  test("expanded activity contains top model totals and only bare request metadata", () => {
    const markup = renderToStaticMarkup(createElement(ChildDetail, { parentId: "parent-id", childId: summary.id }));
    expect(markup).toContain("Top models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Today");
    expect(markup).toContain("Retained telemetry");
    expect(markup).toContain("Hits");
    expect(markup).toContain("Recent requests");
    expect(markup).toContain("HTTP 200");
    expect(markup).toContain("Client IP");
    expect(markup).toContain("Input tokens");
    expect(markup).toContain("Output tokens");
    expect(markup).toContain("203.0.113.*");
  });
});
