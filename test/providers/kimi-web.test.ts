import { describe, expect, test } from "bun:test";
import { parseKimiWebCredential } from "../../src/providers/integrations/kimi-web/kimi-web-auth";
import { createKimiWebAdapter } from "../../src/providers/integrations/kimi-web/kimi-web";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { providerServiceKinds } from "../../src/providers/metadata";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/contracts";

function frame(json: string): ArrayBuffer {
  const payload = new TextEncoder().encode(json);
  const out = new ArrayBuffer(5 + payload.length);
  new DataView(out).setUint32(1, payload.length);
  new Uint8Array(out).set(payload, 5);
  return out;
}

describe("Kimi Web", () => {
  test("parses token forms and rejects a cookie without a token", () => {
    expect(parseKimiWebCredential("token-1").accessToken).toBe("token-1");
    expect(parseKimiWebCredential('{"access_token":"token-2"}').accessToken).toBe("token-2");
    expect(parseKimiWebCredential("kimi-auth=%7B%22access_token%22%3A%22token-3%22%7D").accessToken).toBe("token-3");
    expect(() => parseKimiWebCredential("foo=1")).toThrow("Kimi Web credential must contain access_token");
  });

  test("sends a Connect chat frame and emits reasoning", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const payload = JSON.stringify({ op: "append", mask: "block.think.content", block: { think: { content: "thinking" } } });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      calls.push({ url, body: JSON.parse(new TextDecoder().decode(bytes.subarray(5))) as Record<string, unknown> });
      return new Response(new Blob([frame(payload)]));
    }) as unknown as typeof fetch;
    const adapter = createKimiWebAdapter({ fetch: fetchImpl });
    const request = { model: "k3", messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }], generation_controls: {}, reasoning: { effort: "low" } } as unknown as CanonicalRequest;
    const events = [];
    for await (const event of adapter.dispatch(request, { provider_id: "kimi-web", model_id: "k3", wire_family: "chat", endpoint_path: "", capabilities: {} } as unknown as ProviderDispatchTarget, { credential: { provider_id: "kimi-web", credential_kind: "oauth", secret: new TextEncoder().encode("token-1") }, abort_signal: new AbortController().signal } as unknown as ProviderDispatchContext)) events.push(event);
    expect(calls[0]?.url).toContain("/apiv2/kimi.gateway.chat.v1.ChatService/Chat");
    expect(calls[0]?.body).toMatchObject({ scenario: "SCENARIO_K2D5", options: { reasoning_effort: "REASONING_EFFORT_LOW" } });
    expect(events).toContainEqual(expect.objectContaining({ type: "content_delta", content: { kind: "reasoning", payload: null, summary: "thinking" } }));
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });

  test("registers Kimi Web as an LLM catalog", async () => {
    const registry = createDefaultProviderRegistry();
    expect(providerServiceKinds("kimi-web")).toContain("llm");
    expect((await registry.registrations().find((row) => row.provider_id === "kimi-web")?.loadModels?.())?.map((model) => model.modelId)).toEqual(["k3", "k2d6"]);
  });
});
