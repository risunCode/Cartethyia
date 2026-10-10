import { describe, expect, test } from "bun:test";
import { parseClaudeWebCredential } from "../../src/providers/integrations/claude-web/claude-web-auth";
import { ClaudeWebOAuthClient } from "../../src/providers/integrations/claude-web/claude-web-oauth";
import { CLAUDE_WEB_MODELS, createClaudeWebAdapter } from "../../src/providers/integrations/claude-web/claude-web";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { providerServiceKinds } from "../../src/providers/metadata";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/contracts";

describe("Claude Web", () => {
  test("parses session key forms and rejects a cookie without sessionKey", () => {
    expect(parseClaudeWebCredential("sk-ant-abc").cookie).toBe("sessionKey=sk-ant-abc");
    expect(parseClaudeWebCredential('{"sessionKey":"sk-ant-abc"}').sessionKey).toBe("sk-ant-abc");
    expect(parseClaudeWebCredential("foo=1; sessionKey=sk-ant-abc").sessionKey).toBe("sk-ant-abc");
    expect(() => parseClaudeWebCredential("foo=1")).toThrow("Claude Web credential must contain sessionKey");
  });

  test("sends the exact completion body and emits one tool call", async () => {
    const sse = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"call-1","name":"lookup"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}\n\ndata: {"type":"content_block_stop"}\n\n';
    const calls: Array<{ url: string; init?: RequestInit | undefined; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/organizations")) return Response.json([{ uuid: "org-1" }]);
      if (url.endsWith("/chat_conversations")) return Response.json({ uuid: "conv-1" });
      if (url.endsWith("/completion")) return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const adapter = createClaudeWebAdapter(fetchImpl);
    const request = { model: "", messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }], tools: [{ name: "lookup", jsonSchema: { type: "object" } }], generation_controls: {} } as unknown as CanonicalRequest;
    const events = [];
    for await (const event of adapter.dispatch(request, { provider_id: "claude-web", model_id: "claude-sonnet-4-5", wire_family: "chat", endpoint_path: "", capabilities: {} } as unknown as ProviderDispatchTarget, { credential: { provider_id: "claude-web", credential_kind: "oauth", secret: new TextEncoder().encode("sk-ant-abc") }, abort_signal: new AbortController().signal } as unknown as ProviderDispatchContext)) events.push(event);
    const completion = calls.find((call) => call.url.endsWith("/completion"));
    expect(completion?.body).toEqual({
      prompt: "user: hi",
      parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      timezone: "UTC",
      locale: "en-US",
      model: "claude-sonnet-4-5",
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      turn_message_uuids: expect.objectContaining({ human_message_uuid: expect.any(String), assistant_message_uuid: expect.any(String) }),
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: "messages",
    });
    expect(completion?.init?.headers).toMatchObject({ Referer: "https://claude.ai/new", "User-Agent": expect.stringContaining("Chrome/136") });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_delta", call_id: "call-1", name: "lookup", arguments_delta: '{"q":"x"}' }));
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete", stop_reason: "stop" });
  });

  test("reports an unsigned session during paste exchange", async () => {
    const client = new ClaudeWebOAuthClient((async () => new Response(null, { status: 401 })) as unknown as typeof fetch);
    await expect(client.exchangeCode("sk-ant-abc")).rejects.toThrow("Claude Web session is not signed in");
  });

  test("registers the static subscription catalog", async () => {
    expect(CLAUDE_WEB_MODELS.map((model) => [model.modelId, model.contextLimit, model.outputLimit, model.cost])).toEqual([
      ["claude-sonnet-4-5", 200000, 64000, expect.objectContaining({ input: null, output: null, pricing_model: "subscription" })],
      ["claude-opus-4-1", 200000, 32000, expect.objectContaining({ input: null, output: null, pricing_model: "subscription" })],
      ["claude-haiku-4-5", 200000, 64000, expect.objectContaining({ input: null, output: null, pricing_model: "subscription" })],
      ["claude-3-7-sonnet", 200000, 64000, expect.objectContaining({ input: null, output: null, pricing_model: "subscription" })],
    ]);
    const registry = createDefaultProviderRegistry();
    expect(providerServiceKinds("claude-web")).toContain("llm");
    expect((await registry.registrations().find((row) => row.provider_id === "claude-web")?.loadModels?.())?.length).toBe(4);
  });
});
