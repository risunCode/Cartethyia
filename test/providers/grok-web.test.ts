import { describe, expect, test } from "bun:test";
import { parseGrokWebCredential } from "../../src/providers/integrations/grok-web/grok-web-auth";
import { GrokWebOAuthClient } from "../../src/providers/integrations/grok-web/grok-web-oauth";
import { GROK_WEB_MODELS, createGrokWebAdapter } from "../../src/providers/integrations/grok-web/grok-web";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { providerServiceKinds } from "../../src/providers/metadata";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/contracts";

const COOKIE = "sso=one; sso-rw=two";

describe("Grok Web", () => {
  test("parses both cookie forms and rejects a partial cookie", () => {
    expect(parseGrokWebCredential(COOKIE)).toMatchObject({ sso: "one", ssoRw: "two" });
    expect(parseGrokWebCredential('{"sso":"one","sso-rw":"two"}').cookie).toBe(COOKIE);
    expect(() => parseGrokWebCredential("sso=one")).toThrow("Grok Web credential must contain sso and sso-rw");
  });

  test("maps supported tools and emits the caller tool name", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const sse = 'data: {"text":"ok"}\n\ndata: {"tool_call":{"id":"call-1","intent":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}\n\n';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/conversations/new")) return Response.json({ conversationId: "conv-1" });
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const adapter = createGrokWebAdapter(fetchImpl);
    const request = { model: "", messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }], tools: [{ name: "shell" }], generation_controls: {} } as unknown as CanonicalRequest;
    const events = [];
    for await (const event of adapter.dispatch(request, { provider_id: "grok-web", model_id: "grok-4", wire_family: "chat", endpoint_path: "", capabilities: {} } as unknown as ProviderDispatchTarget, { credential: { provider_id: "grok-web", credential_kind: "oauth", secret: new TextEncoder().encode(COOKIE) }, abort_signal: new AbortController().signal } as unknown as ProviderDispatchContext)) events.push(event);
    expect(calls[0]?.body).toEqual({ modelName: "grok-4", temporary: true });
    expect(calls[1]?.body).toMatchObject({ message: "user: hi", modelName: "grok-4", toolOverrides: [{ intent: "bash", name: "shell" }] });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_delta", name: "shell", arguments_delta: '{"cmd":"ls"}' }));
  });

  test("rejects an unsupported tool before fetching", async () => {
    let called = false;
    const adapter = createGrokWebAdapter((async () => { called = true; return new Response(null, { status: 500 }); }) as unknown as typeof fetch);
    const request = { model: "", messages: [], tools: [{ name: "lookup" }], generation_controls: {} } as unknown as CanonicalRequest;
    await expect((async () => {
      for await (const _event of adapter.dispatch(request, { provider_id: "grok-web", model_id: "grok-3", wire_family: "chat", endpoint_path: "", capabilities: {} } as unknown as ProviderDispatchTarget, { credential: { provider_id: "grok-web", credential_kind: "oauth", secret: new TextEncoder().encode(COOKIE) }, abort_signal: new AbortController().signal } as unknown as ProviderDispatchContext)) { /* drain */ }
    })()).rejects.toThrow("Grok Web only supports bash, readFile, webSearch, and browsePage tools");
    expect(called).toBe(false);
  });

  test("reports an unsigned session during paste exchange", async () => {
    const client = new GrokWebOAuthClient((async () => new Response(null, { status: 403 })) as unknown as typeof fetch);
    await expect(client.exchangeCode(COOKIE)).rejects.toThrow("Grok Web session is not signed in");
  });
  test("registers the static subscription catalog", async () => {
    expect(GROK_WEB_MODELS.map((model) => [model.modelId, model.contextLimit, model.outputLimit, model.cost.pricing_model])).toEqual([
      ["grok-3", 131072, 32768, "subscription"],
      ["grok-4", 256000, 32768, "subscription"],
    ]);
    const registry = createDefaultProviderRegistry();
    expect(providerServiceKinds("grok-web")).toContain("llm");
    expect((await registry.registrations().find((row) => row.provider_id === "grok-web")?.loadModels?.())?.length).toBe(2);
  });
});
