import { describe, expect, test } from "bun:test";
import { createSearchAdapter } from "../../src/providers/search/search-provider";
import { SEARCH_PROVIDER_SPECS } from "../../src/providers/search/search-providers";
import type { ProviderDispatchContext, ProviderDispatchTarget, ResolvedCredential, ValidatedOutboundFetch } from "../../src/providers/contracts";

const target: ProviderDispatchTarget = {
  provider_id: "exa",
  model_id: "exa",
  wire_family: "chat",
  endpoint_path: "/search",
  capabilities: {},
};

function context(providerId: "exa" | "parallel", secret: string | undefined, fetcher: ValidatedOutboundFetch): ProviderDispatchContext {
  const credential: ResolvedCredential = {
    provider_id: providerId,
    credential_kind: secret === undefined ? "none" : "api_key",
    ...(secret === undefined ? {} : { secret: new TextEncoder().encode(secret) }),
  };
  return {
    credential,
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  };
}

describe("authless MCP search providers", () => {
  test("Exa uses the public MCP without a key and the search API with one", async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    const fetcher: ValidatedOutboundFetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return Response.json({
        result: { structuredContent: { results: [{ title: "Exa", url: "https://example.com", text: "snippet" }] } },
      });
    };
    const adapter = createSearchAdapter(SEARCH_PROVIDER_SPECS.exa);

    await adapter.websearch!({ query: "cartethyia", max_results: 3 }, target, context("exa", undefined, fetcher));
    expect(requests[0]?.url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");
    expect(requests[0]?.headers.has("x-api-key")).toBe(false);
    expect(requests[0]?.body).toMatchObject({ method: "tools/call", params: { name: "web_search_exa" } });

    await adapter.websearch!({ query: "cartethyia", max_results: 3 }, target, context("exa", "exa-key", fetcher));
    expect(requests[1]?.url).toBe("https://api.exa.ai/search");
    expect(requests[1]?.headers.get("x-api-key")).toBe("exa-key");
  });

  test("Parallel uses the public MCP without a key and the beta API with one", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetcher: ValidatedOutboundFetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      return Response.json({ results: [{ title: "Parallel", url: "https://example.com", excerpts: ["snippet"] }] });
    };
    const adapter = createSearchAdapter(SEARCH_PROVIDER_SPECS.parallel);
    const parallelTarget = { ...target, provider_id: "parallel" as const, model_id: "parallel" };

    const outcome = await adapter.websearch!({ query: "cartethyia" }, parallelTarget, context("parallel", undefined, fetcher));
    expect(requests[0]?.url).toBe("https://search.parallel.ai/mcp");
    expect(outcome.results[0]).toMatchObject({ title: "Parallel", url: "https://example.com", snippet: "snippet" });

    await adapter.websearch!({ query: "cartethyia" }, parallelTarget, context("parallel", "parallel-key", fetcher));
    expect(requests[1]?.url).toBe("https://api.parallel.ai/v1beta/search");
    expect(requests[1]?.headers.get("x-api-key")).toBe("parallel-key");
  });
});
