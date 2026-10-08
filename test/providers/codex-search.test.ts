import { describe, expect, test } from "bun:test";
import { createCodexAdapter } from "../../src/providers/integrations/codex/codex";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ResolvedCredential,
  ValidatedOutboundFetch,
} from "../../src/providers/provider-registry";

const target: ProviderDispatchTarget = {
  provider_id: "codex",
  model_id: "codex-search",
  wire_family: "responses",
  endpoint_path: "/backend-api/codex/responses",
  capabilities: {},
};

function responseContext(fetcher: ValidatedOutboundFetch): ProviderDispatchContext {
  const credential: ResolvedCredential = {
    provider_id: "codex",
    credential_kind: "oauth",
    secret: new TextEncoder().encode("codex-test-token"),
  };
  return {
    credential,
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  };
}

describe("Codex hosted web search", () => {
  test("normalizes Responses URL citations from the hosted search tool", async () => {
    const fetcher: ValidatedOutboundFetch = async () =>
      new Response(
        [
          'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Search answer","annotations":[{"type":"url_citation","url":"https://example.com/codex","title":"Codex source"}]}]}}',
          'data: {"type":"response.completed","response":{"status":"completed"}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const adapter = createCodexAdapter({ provider_id: "codex", installation_id_override: "test-install" });
    if (adapter.websearch === undefined) throw new Error("Codex search adapter is missing");

    const outcome = await adapter.websearch(
      { model: "codex-search", query: "latest AI news", max_results: 5 },
      target,
      responseContext(fetcher),
    );

    expect(outcome.results).toEqual([
      {
        title: "Codex source",
        url: "https://example.com/codex",
        snippet: "Search answer",
        published_at: null,
        score: null,
      },
    ]);
    expect(outcome.total_results).toBe(1);
  });
});
