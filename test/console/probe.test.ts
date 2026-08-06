import { describe, expect, test } from "bun:test";
import { probeProviderModel } from "../../src/console/probe";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "../../src/domain/contracts";

function makeAdapter(calls: ProviderRequest[]): ProviderAdapter {
  const capabilities = { surfaces: ["openai-chat"] as const, streaming: true, reasoning: true, toolCalls: false, images: false, explicitCache: false, promptCacheKey: false };
  return {
    metadata: { id: "minimax", displayName: "MiniMax", protocol: "openai", credentialKind: "none" },
    capabilities,
    models: { list: [{ id: "minimax-m3", displayName: "MiniMax M3", capabilities }], get: (id) => id === "minimax-m3" ? { id, displayName: "MiniMax M3", capabilities } : null },
    resolveTarget: (modelId, surface) => ({ providerId: "minimax", modelId, upstreamModelId: modelId, surface }),
    call: async (input) => {
      calls.push(input);
      return { mode: "stream", events: (async function* (): AsyncIterable<StreamEvent> {
        yield { type: "message_start", id: "probe" };
        yield { type: "thinking_delta", text: "long hidden reasoning" };
        yield { type: "text_delta", text: "Model: MiniMax M3; " };
        yield { type: "text_delta", text: "Knowledge cutoff: unknown." };
        yield { type: "message_stop", reason: "completed" };
      })() };
    },
    countTokens: async () => ({ tokens: null, source: "unknown" }),
    mapError: (error) => ({ statusCode: 502, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: error instanceof Error ? error.message : "probe error", retryAt: null }),
  };
}

function ports(adapter: ProviderAdapter, calls: ProviderRequest[]) {
  const registry = new ProviderRegistry();
  registry.register(adapter);
  return {
    registry,
    accounts: {} as never,
    credentials: { release: async () => {} } as never,
    accountHealth: { getHealth: async () => null, recordSuccess: async () => {}, recordFailure: async () => {} } as never,
    network: { select: async () => ({ proxyId: null, selection: { proxyId: null, url: null, release: async () => {} } }) } as never,
  };
}

describe("unified compatible model probe", () => {
  test("returns end-turn visible text and excludes thinking", async () => {
    const calls: ProviderRequest[] = [];
    const adapter = makeAdapter(calls);
    const result = await probeProviderModel({ provider: "minimax", model: "minimax-m3", credentialMode: "auto", signal: new AbortController().signal }, ports(adapter, calls));
    expect(result).toMatchObject({ ok: true, mode: "non_stream", sample: "Model: MiniMax M3; Knowledge cutoff: unknown." });
    if (result.ok) expect(result.sample).not.toContain("reasoning");
    expect(calls[0]?.request.maxOutputTokens).toBe(256);
    expect(calls[0]?.request.stream).toBe(false);
    expect(calls[0]?.request.messages[0]?.content[0]).toMatchObject({ type: "text" });
    expect((calls[0]?.request.messages[0]?.content[0] as { text?: string }).text).toContain("knowledge cutoff");
  });
});

function nonStreamAdapter(id: string, surface: "openai-chat" | "openai-responses" | "anthropic-messages", body: Record<string, unknown>): ProviderAdapter {
  const capabilities = { surfaces: [surface] as const, streaming: true, reasoning: true, toolCalls: false, images: false, explicitCache: false, promptCacheKey: false };
  return {
    metadata: { id, displayName: id, protocol: surface === "openai-responses" ? "openai" : surface === "anthropic-messages" ? "anthropic" : "openai", credentialKind: "none" },
    capabilities,
    models: { list: [{ id: "m", displayName: "M", capabilities }], get: (modelId) => modelId === "m" ? { id: "m", displayName: "M", capabilities } : null },
    resolveTarget: (modelId, s) => ({ providerId: id, modelId, upstreamModelId: modelId, surface: s }),
    call: async () => ({ mode: "non_stream", body }),
    countTokens: async () => ({ tokens: null, source: "unknown" }),
    mapError: (error) => ({ statusCode: 502, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: error instanceof Error ? error.message : "probe error", retryAt: null }),
  };
}

function failingAdapter(calls: ProviderRequest[]): { adapter: ProviderAdapter; fail: () => void } {
  const capabilities = { surfaces: ["openai-chat"] as const, streaming: true, reasoning: true, toolCalls: false, images: false, explicitCache: false, promptCacheKey: false };
  let shouldFail = false;
  const adapter: ProviderAdapter = {
    metadata: { id: "boom", displayName: "Boom", protocol: "openai", credentialKind: "none" },
    capabilities,
    models: { list: [{ id: "m", displayName: "M", capabilities }], get: (modelId) => modelId === "m" ? { id: "m", displayName: "M", capabilities } : null },
    resolveTarget: (modelId, s) => ({ providerId: "boom", modelId, upstreamModelId: modelId, surface: s }),
    call: async (input) => {
      calls.push(input);
      if (shouldFail) throw new Error("upstream exploded");
      return { mode: "non_stream", body: { choices: [{ message: { content: "probe ok" } }], model: "m" } };
    },
    countTokens: async () => ({ tokens: null, source: "unknown" }),
    mapError: (error) => ({ statusCode: 502, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: error instanceof Error ? error.message : "probe error", retryAt: null }),
  };
  return { adapter, fail: () => { shouldFail = true; } };
}

describe("probe non-stream sample extraction per surface", () => {
  test("openai-chat non-stream extracts message content and returned model", async () => {
    const adapter = nonStreamAdapter("p", "openai-chat", { model: "gpt-5", choices: [{ message: { content: "hello world" } }] });
    const calls: ProviderRequest[] = [];
    const result = await probeProviderModel({ provider: "p", model: "m", credentialMode: "auto", signal: new AbortController().signal }, ports(adapter, calls));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sample).toBe("hello world");
      expect(result.returnedModel).toBe("gpt-5");
      expect(result.mode).toBe("non_stream");
    }
  });

  test("openai-responses non-stream extracts output_text", async () => {
    const adapter = nonStreamAdapter("r", "openai-responses", { model: "r1", output_text: "from responses" });
    const result = await probeProviderModel({ provider: "r", model: "m", credentialMode: "auto", signal: new AbortController().signal }, ports(adapter, []));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sample).toContain("from responses");
  });

  test("anthropic-messages non-stream extracts text blocks and excludes thinking", async () => {
    const adapter = nonStreamAdapter("c", "anthropic-messages", { model: "claude", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible reply" }] });
    const result = await probeProviderModel({ provider: "c", model: "m", credentialMode: "auto", signal: new AbortController().signal }, ports(adapter, []));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sample).toContain("visible reply");
      expect(result.sample).not.toContain("hidden");
    }
  });
});

describe("probe failure recording", () => {
  test("returns ok:false with a mapped error when the adapter throws", async () => {
    const calls: ProviderRequest[] = [];
    const { adapter, fail } = failingAdapter(calls);
    fail();
    const result = await probeProviderModel({ provider: "boom", model: "m", credentialMode: "auto", signal: new AbortController().signal }, ports(adapter, calls));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("provider_protocol_error");
  });
});

