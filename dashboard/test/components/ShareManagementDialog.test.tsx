import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SharedKeyActivityDetail } from "../../src/lib/contracts";

const activity: SharedKeyActivityDetail = {
  models: [
    {
      providerId: "openai",
      modelId: "gpt-5",
      retainedRequests: 8,
      retainedErrors: 1,
      retainedTokens: 270,
      todayRequests: 4,
      todayErrors: 0,
      todayTokens: 125,
    },
  ],
  requests: [
    {
      requestId: "event-1",
      startedAt: "2026-09-25T12:30:00.000Z",
      providerId: "openai",
      modelId: "gpt-5",
      status: "success",
      httpStatus: 200,
      clientIp: "203.0.113.*",
      inputTokens: 10,
      outputTokens: 15,
      totalTokens: 25,
    },
  ],
};

mock.module("../../src/lib/hooks/api-keys", () => ({
  useShareApiKey: () => ({ isPending: false, mutate: () => undefined }),
  useRegenerateApiKey: () => ({ isPending: false, mutate: () => undefined }),
  useShareLink: () => ({ data: null, isPending: false, isError: false }),
  useRevokeSharedKey: () => ({ isPending: false, mutate: () => undefined }),
  useSharedKeys: () => ({ data: [], isPending: true, isError: false }),
  useSharedKeyActivity: () => ({ data: activity, isPending: false, isError: false }),
}));

const { ChildDetail } = await import("../../src/components/ShareManagementDialog");

function render(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ChildDetail, { parentId: "parent-id", childId: "child-id" }),
    ),
  );
}

describe("share management dialog", () => {
  test("expanded recipient exposes token usage without credential material", () => {
    const markup = render();
    expect(markup).toContain("Top models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Recent requests");
    // Token totals only: the detail deliberately drops the per-event client IP
    // and error fields the owner does not act on.
    expect(markup).toContain("25");
    expect(markup).not.toContain("203.0.113.*");
    expect(markup).not.toContain("child-id");
  });
});
