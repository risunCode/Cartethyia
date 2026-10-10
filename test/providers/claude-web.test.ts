import { describe, expect, test } from "bun:test";
import { parseClaudeWebCredential } from "../../src/providers/integrations/claude-web/claude-web-auth";
import { createClaudeWebAdapter } from "../../src/providers/integrations/claude-web/claude-web";
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
    const exported = JSON.stringify([{ name: "sessionKey", value: "sk-ant-sid" }, { name: "lastActiveOrg", value: "org-1" }]);
    expect(parseClaudeWebCredential(exported)).toMatchObject({ sessionKey: "sk-ant-sid", cookie: "sessionKey=sk-ant-sid; lastActiveOrg=org-1" });
  });

  test("sends caller tool schema and emits one tool call", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const sse = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"call-1","name":"lookup"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}\n\ndata: {"type":"content_block_stop"}\n\n';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/organizations")) return Response.json([{ uuid: "org-1" }]);
      if (url.endsWith("/chat_conversations")) return Response.json({ uuid: "conv-1" });
      if (url.endsWith("/completion")) return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const adapter = createClaudeWebAdapter({ fetch: fetchImpl });
    const request = { model: "", messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }], tools: [{ name: "lookup", jsonSchema: { type: "object" } }], generation_controls: {}, reasoning: { effort: "high" } } as unknown as CanonicalRequest;
    const events = [];
    for await (const event of adapter.dispatch(request, { provider_id: "claude-web", model_id: "model-1", wire_family: "chat", endpoint_path: "", capabilities: {} } as unknown as ProviderDispatchTarget, { credential: { provider_id: "claude-web", credential_kind: "oauth", secret: new TextEncoder().encode("sk-ant-abc") }, abort_signal: new AbortController().signal } as unknown as ProviderDispatchContext)) events.push(event);
    const completion = calls.find((call) => call.url.endsWith("/completion"));
    expect(completion?.body).toMatchObject({ model: "model-1", effort: "high", thinking_mode: "extended", tools: [{ name: "lookup", input_schema: { type: "object" } }] });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_delta", call_id: "call-1", name: "lookup", arguments_delta: '{"q":"x"}' }));
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete", stop_reason: "stop" });
  });

  test("registers both web providers as LLM catalogs", async () => {
    const registry = createDefaultProviderRegistry();
    for (const id of ["claude-web"] as const) {
      expect(providerServiceKinds(id)).toContain("llm");
      expect((await registry.registrations().find((row) => row.provider_id === id)?.loadModels?.())?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
