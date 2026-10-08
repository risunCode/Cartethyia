import { describe, expect, test } from "bun:test";
import { createGeminiAdapter } from "../../src/providers/integrations/gemini";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ResolvedCredential,
  ValidatedOutboundFetch,
} from "../../src/providers/provider-registry";

function context(fetcher: ValidatedOutboundFetch): ProviderDispatchContext {
  const credential: ResolvedCredential = {
    provider_id: "gemini",
    credential_kind: "api_key",
    secret: new TextEncoder().encode("gemini-test-key"),
  };
  return {
    credential,
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  };
}

const target: ProviderDispatchTarget = {
  provider_id: "gemini",
  model_id: "gemini-search",
  wire_family: "chat",
  endpoint_path: "/v1beta/models/gemini-2.5-flash:generateContent",
  capabilities: {},
};

describe("Gemini grounded web search", () => {
  test("sends the grounding tool and normalizes deduplicated sources", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const fetcher: ValidatedOutboundFetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: "https://example.com/one", title: "One" } },
                  { web: { uri: "https://example.com/one", title: "One duplicate" } },
                  { web: { uri: "https://example.com/two", title: "Two" } },
                ],
                groundingSupports: [
                  {
                    segment: { text: "One source context" },
                    groundingChunkIndices: [0, 1],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const adapter = createGeminiAdapter();
    if (adapter.websearch === undefined) throw new Error("Gemini search adapter is missing");
    const outcome = await adapter.websearch(
      { model: "gemini-search", query: "latest AI news", max_results: 2 },
      target,
      context(fetcher),
    );

    expect(requestUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(requestBody?.contents).toEqual([{ role: "user", parts: [{ text: "latest AI news" }] }]);
    expect(requestBody?.tools).toEqual([{ google_search: {} }]);
    expect(outcome.results).toEqual([
      {
        title: "One",
        url: "https://example.com/one",
        snippet: "One source context",
        published_at: null,
        score: null,
      },
      {
        title: "Two",
        url: "https://example.com/two",
        snippet: "Two",
        published_at: null,
        score: null,
      },
    ]);
    expect(outcome.total_results).toBe(2);
  });

  test("fails closed when Gemini returns no grounded sources", async () => {
    const fetcher: ValidatedOutboundFetch = async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "answer" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const adapter = createGeminiAdapter();
    if (adapter.websearch === undefined) throw new Error("Gemini search adapter is missing");

    await expect(
      adapter.websearch({ query: "ungrounded" }, target, context(fetcher)),
    ).rejects.toMatchObject({ code: "platform_unavailable", status: 502 });
  });
});
