import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiKeysPanel } from "./ApiKeysPanel";
import { queryKeys } from "../lib/query-keys";
import type { ApiKeyResponse } from "../lib/contracts";

const ACTIVE_KEY: ApiKeyResponse = {
  id: "key-active-0001",
  label: "ci-key",
  scopes: ["dashboard:read"],
  keyPrefix: "ctk_",
  requestsPerMinute: 120,
  dailyTokenLimit: 1_000_000,
  monthlyTokenLimit: 10_000_000,
  maxConcurrentRequests: 4,
  modelAllowlist: ["openai/gpt-5", "anthropic/claude-x"],
  createdAt: "2026-01-02T00:00:00.000Z",
  tokensConsumed: 2_500_000,
};

const REVOKED_KEY: ApiKeyResponse = {
  id: "key-revoked-0002",
  label: "old-key",
  scopes: ["dashboard:read"],
  keyPrefix: "rk_",
  createdAt: "2025-12-01T00:00:00.000Z",
  revokedAt: "2026-01-05T00:00:00.000Z",
  tokensConsumed: 10,
};

function render(keys: readonly ApiKeyResponse[] | undefined): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (keys) queryClient.setQueryData(queryKeys.apiKeys.all, keys);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(ApiKeysPanel)),
  );
}

describe("API keys panel", () => {
  test("renders key rows with status, prefix and limits", () => {
    const markup = render([ACTIVE_KEY, REVOKED_KEY]);
    expect(markup).toContain("API Credentials");
    expect(markup).toContain("ci-key");
    expect(markup).toContain("old-key");
    expect(markup).toContain(">active<");
    expect(markup).toContain(">revoked<");
    expect(markup).toContain("ctk_…");
    expect(markup).toContain("Edit");
    expect(markup).toContain("Share");
    expect(markup).toContain("Revoke");
  });

  test("never renders a secret or key hash", () => {
    const markup = render([ACTIVE_KEY]);
    expect(markup).not.toContain("keyHash");
    expect(markup).not.toContain("key_hash");
    expect(markup).not.toContain("keyEncrypted");
  });

  test("summarises totals across keys", () => {
    const markup = render([ACTIVE_KEY, REVOKED_KEY]);
    expect(markup).toContain("Active keys");
    expect(markup).toContain("Total usage");
    expect(markup).toContain("1 / 2");
  });

  test("renders the empty state when no keys exist", () => {
    const markup = render([]);
    expect(markup).toContain("No API keys issued");
    expect(markup).toContain("Create Key");
  });

  test("renders a loading state before the key list resolves", () => {
    const markup = render(undefined);
    expect(markup).toContain("Loading API keys");
  });
});
