import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useExportProviderAccounts } from "../../../src/lib/hooks/providers";
import { jsonResponse } from "../../helpers/test-helpers";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Renders a probe component that calls the hook's `mutateAsync` once on render
 * is impossible in static markup, so this exercises the hook through a thin
 * harness that exposes the mutation fn directly.
 */
function captureMutation<T>(
  useHook: () => { mutateAsync: (variables: never) => Promise<T> },
): { run: (variables: unknown) => Promise<T> } {
  let captured: ((variables: never) => Promise<T>) | undefined;
  function Probe(): null {
    const mutation = useHook();
    captured = mutation.mutateAsync as (variables: never) => Promise<T>;
    return null;
  }
  const client = new QueryClient();
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Probe),
    ),
  );
  if (!captured) throw new Error("mutation was not captured");
  const run = captured as unknown as (variables: unknown) => Promise<T>;
  return { run };
}

describe("useExportProviderAccounts", () => {
  test("POSTs the selected account ids to the export endpoint", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({
        exportedAt: "2026-01-01T00:00:00.000Z",
        accounts: [
          {
            id: "acct-1",
            providerId: "openai",
            label: "primary",
            credentialKind: "api_key",
            status: "active",
            secret: "sk-secret",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }) as typeof fetch;

    const { run } = captureMutation(useExportProviderAccounts);
    const body = await run({ providerId: "openai", accountIds: ["acct-1"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/providers/openai/accounts/export");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ accountIds: ["acct-1"] });
    expect((body as { accounts: Array<{ secret: string }> }).accounts[0]?.secret).toBe("sk-secret");
  });
});
