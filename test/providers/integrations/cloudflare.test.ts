import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../src/providers/provider-registry";
import { createCloudflareAdapter } from "../../../src/providers/integrations/cloudflare";

const ACCOUNT_ID = "a".repeat(32);

function request(stream: boolean): CanonicalRequest {
  return {
    model: "cf-model",
    system: [{ kind: "text", text: "sys" }],
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    tools: [{ name: "t", description: "d", jsonSchema: { type: "object" } }],
    generation_controls: {},
    stream,
    source_surface: "chat",
  };
}

function candidate(): ProviderDispatchTarget {
  return {
    provider_id: "cloudflare",
    model_id: "cf-model",
    wire_family: "chat",
    endpoint_path: "",
    capabilities: {},
  };
}

function context(fetcher: typeof fetch): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "cloudflare",
      credential_kind: "api_key",
      secret: new TextEncoder().encode(JSON.stringify({ apiKey: "k", accountId: ACCOUNT_ID })),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  };
}

describe("Cloudflare request bytes", () => {
  test("JSON dispatch pins URL, headers, and body", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: { ...(init?.headers as Record<string, string>) },
        body: String(init?.body),
      });
      return new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const events: string[] = [];
    const adapter = createCloudflareAdapter({ fetch: fetcher });
    for await (const event of adapter.dispatch(request(false), candidate(), context(fetcher))) {
      events.push(event.type);
    }
    expect(events).toEqual(["response_start", "content_delta", "terminal"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/v1/chat/completions`,
    );
    expect(seen[0]!.headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer k",
    });
    expect(seen[0]!.body).toBe(
      JSON.stringify({
        model: "cf-model",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
        stream: false,
        tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }],
      }),
    );
  });

  test("SSE dispatch pins URL and streams deltas", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      seen.push(String(input));
      const body =
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const events: string[] = [];
    const adapter = createCloudflareAdapter({ fetch: fetcher });
    for await (const event of adapter.dispatch(request(true), candidate(), context(fetcher))) {
      events.push(event.type);
    }
    expect(events).toEqual(["response_start", "content_delta", "terminal"]);
    expect(seen).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/v1/chat/completions`,
    ]);
  });
});
