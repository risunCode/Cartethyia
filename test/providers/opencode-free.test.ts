import { describe, expect, test } from "bun:test";
import { OpenCodeFreeAdapter, openCodeFreeModelCatalog } from "../../src/providers/opencode";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest } from "../../src/domain/contracts";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "big-pickle",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

const emptyNetwork: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "opencodeft", modelId: "big-pickle", upstreamModelId: "big-pickle", surface: "openai-chat" },
    request: request({ model: "big-pickle" }),
    credential: "",
    network: emptyNetwork,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(capture: CapturedCall, json: Record<string, unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init ?? {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("OpenCodeFreeAdapter — identity & catalog", () => {
  const adapter = new OpenCodeFreeAdapter();

  test("declares the openai protocol and none credential kind (unauthenticated public route)", () => {
    expect(adapter.metadata).toMatchObject({
      id: "opencodeft",
      displayName: "OpenCode Free",
      protocol: "openai",
      credentialKind: "none",
    });
  });

  test("exposes the free model catalog with the expected models", () => {
    const ids = openCodeFreeModelCatalog.map((model) => model.id);
    expect(ids).toContain("big-pickle");
    expect(ids).toContain("deepseek-v4-flash-free");
    expect(ids).toContain("mimo-v2.5-free");
    expect(ids).toContain("nemotron-3-ultra-free");
    expect(ids).toContain("north-mini-code-free");
    expect(ids).toContain("laguna-s-2.1-free");
    expect(openCodeFreeModelCatalog.length).toBe(6);
  });

  test("catalog get returns the model and null for unknown ids", () => {
    expect(adapter.models.get("big-pickle")?.displayName).toBe("Big Pickle");
    expect(adapter.models.get("deepseek-v4-flash-free")?.displayName).toBe("DeepSeek V4 Flash Free");
    expect(adapter.models.get("does-not-exist")).toBeNull();
  });

  test("aggregates capabilities with streaming and tool-call support on the openai-chat surface", () => {
    expect(adapter.capabilities.surfaces).toContain("openai-chat");
    expect(adapter.capabilities.streaming).toBe(true);
    expect(adapter.capabilities.toolCalls).toBe(true);
    expect(adapter.capabilities.reasoning).toBe(true);
  });
});

describe("OpenCodeFreeAdapter — resolveTarget", () => {
  const adapter = new OpenCodeFreeAdapter();

  test("resolves a known model on the openai-chat surface", () => {
    expect(adapter.resolveTarget("big-pickle", "openai-chat")).toEqual({ providerId: "opencodeft", modelId: "big-pickle", upstreamModelId: "big-pickle", surface: "openai-chat" });
  });

  test("rejects an unsupported surface with capability_unsupported (400)", () => {
    expect(() => adapter.resolveTarget("big-pickle", "anthropic-messages")).toThrow(ProviderAdapterError);
    try {
      adapter.resolveTarget("big-pickle", "anthropic-messages");
      expect.unreachable();
    } catch (error) {
      const typed = error as ProviderAdapterError;
      expect(typed.kind).toBe("capability_unsupported");
      expect(typed.statusCode).toBe(400);
    }
  });

  test("rejects an unknown model with model_not_found (404)", () => {
    expect(() => adapter.resolveTarget("no-such-model", "openai-chat")).toThrow(ProviderAdapterError);
    try {
      adapter.resolveTarget("no-such-model", "openai-chat");
      expect.unreachable();
    } catch (error) {
      const typed = error as ProviderAdapterError;
      expect(typed.kind).toBe("model_not_found");
      expect(typed.statusCode).toBe(404);
    }
  });
});

describe("OpenCodeFreeAdapter — call (non-stream)", () => {
  const adapter = new OpenCodeFreeAdapter();

  test("sends a Bearer public credential to the zen/v1 chat completions endpoint", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, { choices: [{ message: { content: "hi" } }], model: "big-pickle" });
    try {
      const output = await adapter.call(makeRequest());
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://opencode.ai/zen/v1/chat/completions");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer public");
      expect(headers["content-type"]).toBe("application/json");
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("big-pickle");
    } finally {
      restore();
    }
  });

  test("sets the accept header to application/json for non-stream requests", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, { choices: [] });
    try {
      await adapter.call(makeRequest());
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.accept).toBe("application/json");
    } finally {
      restore();
    }
  });

  test("passes through the user-agent header when present on the request", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, { choices: [] });
    try {
      const headers = new Headers();
      headers.set("user-agent", "test-client/1.0");
      await adapter.call(makeRequest({ headers }));
      const sentHeaders = capture.init.headers as Record<string, string>;
      expect(sentHeaders["user-agent"]).toBe("test-client/1.0");
    } finally {
      restore();
    }
  });

  test("omits the user-agent header when not present on the request", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, { choices: [] });
    try {
      await adapter.call(makeRequest());
      const sentHeaders = capture.init.headers as Record<string, string>;
      expect(sentHeaders["user-agent"]).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("OpenCodeFreeAdapter — call guards", () => {
  const adapter = new OpenCodeFreeAdapter();

  test("rejects a request whose providerId does not match the adapter id", async () => {
    const input = makeRequest({ target: { providerId: "other", modelId: "big-pickle", upstreamModelId: "big-pickle", surface: "openai-chat" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
    await expect(adapter.call(input)).rejects.toMatchObject({ kind: "capability_unsupported", statusCode: 400 });
  });

  test("rejects an unsupported surface before touching the network", async () => {
    const input = makeRequest({ target: { providerId: "opencodeft", modelId: "big-pickle", upstreamModelId: "big-pickle", surface: "anthropic-messages" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
    await expect(adapter.call(input)).rejects.toMatchObject({ kind: "capability_unsupported", statusCode: 400 });
  });

  test("countTokens returns unknown without contacting a tokenizer", async () => {
    await expect(
      adapter.countTokens({ request: request(), signal: new AbortController().signal }),
    ).resolves.toEqual({ tokens: null, source: "unknown" });
  });
});

describe("OpenCodeFreeAdapter — mapError", () => {
  const adapter = new OpenCodeFreeAdapter();

  test("maps a ProviderAdapterError faithfully to a typed ProviderCallError", () => {
    const mapped = adapter.mapError(
      new ProviderAdapterError({ kind: "provider_rate_limited", message: "slow down", statusCode: 429, retryable: true, routeScope: "provider" }),
    );
    expect(mapped.kind).toBe("provider_rate_limited");
    expect(mapped.retryable).toBe(true);
    expect(mapped.statusCode).toBe(429);
  });

  test("maps a plain Error to a provider_protocol_error", () => {
    const mapped = adapter.mapError(new Error("boom"));
    expect(mapped.kind).toBe("provider_protocol_error");
    expect(mapped.retryable).toBe(false);
    expect(mapped.sanitizedMessage).toContain("boom");
  });
});
