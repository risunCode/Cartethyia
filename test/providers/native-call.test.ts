import { describe, expect, test } from "bun:test";
import type {
  NetworkSelection,
  NormalizedProviderRequest,
  ProviderOutput,
  ProviderRequest,
  StreamEvent,
} from "../../src/domain/contracts";
import { DEFAULT_NATIVE_PROVIDERS, NativeAdapter, type NativeProviderConfig } from "../../src/providers/native";
import { ProviderAdapterError, isRecord } from "../../src/providers/shared";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "arbitrary-model",
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

function providerRequest(
  adapter: { metadata: { id: string } },
  modelId: string,
  surface: "openai-chat" | "anthropic-messages" = "openai-chat",
  credential = "secret-key",
  requestOverrides: Partial<NormalizedProviderRequest> = {},
): ProviderRequest {
  return {
    target: { providerId: adapter.metadata.id, modelId, surface },
    request: request({ model: modelId, ...requestOverrides }),
    credential,
    network: emptyNetwork,
    signal: new AbortController().signal,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetchFor(capture: CapturedCall, json: Record<string, unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init ?? {};
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Parses the captured request body into a typed record. */
function bodyOf(capture: CapturedCall): Record<string, unknown> {
  return JSON.parse(capture.init.body as string) as Record<string, unknown>;
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function chatSseFrame(json: Record<string, unknown>): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

const DONE = "data: [DONE]\n\n";

async function collectEvents(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** Narrows a ProviderOutput to its stream variant and returns the events. */
function streamEventsOf(output: ProviderOutput): AsyncIterable<StreamEvent> {
  if (output.mode !== "stream") throw new Error("expected stream output");
  return output.events;
}

/** Narrows a StreamEvent to text_delta and returns its text (empty if not a match). */
function textDeltaText(event: StreamEvent): string {
  return event.type === "text_delta" ? event.text : "";
}

const byId = new Map(DEFAULT_NATIVE_PROVIDERS.map((config) => [config.id, config]));

describe("NativeAdapter.call — success path and request shape", () => {
  test("posts the Chat Completions wire shape with model and messages to the base URL", async () => {
    const config = byId.get("openrouter")!;
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c1", object: "chat.completion", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "openai/gpt-5.4"),
        request: request({ model: "openai/gpt-5.4" }),
      });
      expect(output.mode).toBe("non_stream");
      // URL = baseUrl (trailing slashes removed) + /chat/completions
      expect(capture.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = bodyOf(capture);
      expect(body.model).toBe("openai/gpt-5.4");
      expect(body.stream).toBe(false);
      expect(Array.isArray(body.messages)).toBe(true);
      expect(output.usage).toMatchObject({ inputTokens: 1, outputTokens: 2, totalTokens: 3, source: "provider" });
    } finally {
      restore();
    }
  });

  test("strips trailing slashes from the base URL before appending the path", async () => {
    const config: NativeProviderConfig = {
      id: "trailing-slash-test",
      displayName: "Trailing Slash Test",
      baseUrl: "https://api.example.com/v1///",
      credentialKind: "api_key",
    };
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model"));
      expect(capture.url).toBe("https://api.example.com/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("forwards the incoming User-Agent when present", async () => {
    const config = byId.get("deepseek")!;
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call({
        ...providerRequest(adapter, "deepseek-chat"),
        headers: new Headers({ "user-agent": "my-cli/1.0" }),
      });
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["user-agent"]).toBe("my-cli/1.0");
    } finally {
      restore();
    }
  });
});

describe("NativeAdapter.call — bearer auth", () => {
  test("constructs Authorization: Bearer header from the credential", async () => {
    // Default auth is bearer for most configs.
    const config = byId.get("deepseek")!;
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call({
        ...providerRequest(adapter, "deepseek-chat", "openai-chat", "my-bearer-token"),
        request: request({ model: "deepseek-chat" }),
      });
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer my-bearer-token");
      expect(headers["x-api-key"]).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("omits Authorization when the credential is empty (bearer)", async () => {
    const config = byId.get("openrouter")!;
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model", "openai-chat", ""));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("NativeAdapter.call — x-api-key auth", () => {
  test("constructs X-Api-Key header from the credential", async () => {
    const config: NativeProviderConfig = {
      id: "xapi-provider",
      displayName: "XApi Provider",
      baseUrl: "https://api.xapi.example.com/v1",
      credentialKind: "api_key",
      auth: "x-api-key",
    };
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model", "openai-chat", "key-123"));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("key-123");
      expect(headers.authorization).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("omits X-Api-Key when the credential is empty", async () => {
    const config: NativeProviderConfig = {
      id: "xapi-provider-empty",
      displayName: "XApi Empty",
      baseUrl: "https://api.xapi2.example.com/v1",
      credentialKind: "api_key",
      auth: "x-api-key",
    };
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model", "openai-chat", ""));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("NativeAdapter.call — no auth", () => {
  test("sends neither Authorization nor X-Api-Key when auth is none", async () => {
    const config: NativeProviderConfig = {
      id: "noauth-provider",
      displayName: "NoAuth Provider",
      baseUrl: "https://api.noauth.example.com/v1",
      credentialKind: "none",
      auth: "none",
    };
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      // Even with a credential string, auth=none must NOT attach it.
      await adapter.call(providerRequest(adapter, "any-model", "openai-chat", "some-credential"));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("auth defaults to bearer when not specified", async () => {
    const config: NativeProviderConfig = {
      id: "default-auth-provider",
      displayName: "Default Auth",
      baseUrl: "https://api.default.example.com/v1",
      credentialKind: "api_key",
    };
    const adapter = new NativeAdapter(config);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model", "openai-chat", "tok"));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer tok");
    } finally {
      restore();
    }
  });
});

describe("NativeAdapter.resolveTarget — surface rejection", () => {
  const adapter = new NativeAdapter(byId.get("deepseek")!);

  test("resolves a model on the supported openai-chat surface", () => {
    expect(adapter.resolveTarget("deepseek-chat", "openai-chat")).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-chat",
      surface: "openai-chat",
    });
  });

  test("rejects a surface not in the supported list", () => {
    expect(() => adapter.resolveTarget("deepseek-chat", "anthropic-messages")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("deepseek-chat", "anthropic-messages")).toThrow(/does not support surface/);
  });

  test("rejects the images surface", () => {
    expect(() => adapter.resolveTarget("deepseek-chat", "images")).toThrow(ProviderAdapterError);
  });

  test("accepts any model id regardless of catalog (catalog is informational)", () => {
    // Native providers accept arbitrary model ids — the catalog is advisory.
    expect(adapter.resolveTarget("totally-unknown-model-id", "openai-chat").modelId).toBe("totally-unknown-model-id");
  });
});

describe("NativeAdapter.assertSupported — stream-without-streaming rejection", () => {
  test("rejects stream=true when the adapter does not support streaming", async () => {
    // Build a native adapter whose only model has streaming=false.
    const config: NativeProviderConfig = {
      id: "no-stream-provider",
      displayName: "No Stream",
      baseUrl: "https://api.nostream.example.com/v1",
      credentialKind: "api_key",
      models: [
        {
          id: "static-model",
          displayName: "Static Model",
          capabilities: {
            surfaces: ["openai-chat"],
            streaming: false,
            reasoning: false,
            toolCalls: true,
            images: false,
            explicitCache: false,
            promptCacheKey: false,
          },
          context: { inputTokens: null, outputTokens: null },
          categories: ["text"],
          pricing: { inputPerMillion: null, outputPerMillion: null },
        },
      ],
    };
    const adapter = new NativeAdapter(config);
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        adapter.call({
          ...providerRequest(adapter, "static-model"),
          request: request({ model: "static-model", stream: true }),
        }),
      ).rejects.toThrow(ProviderAdapterError);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("NativeAdapter.call — streaming via Chat Completions SSE", () => {
  test("decodes reasoning and text deltas from chat SSE frames", async () => {
    // A native adapter with reasoning enabled on its model.
    const config = byId.get("deepseek")!;
    const adapter = new NativeAdapter(config);
    const frames = [
      chatSseFrame({ id: "chatcmpl-1", choices: [{ delta: { reasoning_content: "thinking hard" } }] }),
      chatSseFrame({ id: "chatcmpl-1", choices: [{ delta: { content: "Hello" } }] }),
      chatSseFrame({ id: "chatcmpl-1", choices: [{ delta: { content: " world" } }] }),
      chatSseFrame({ id: "chatcmpl-1", choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
      DONE,
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => sseResponse(frames)) as typeof fetch;
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "deepseek-reasoner"),
        request: request({ model: "deepseek-reasoner", stream: true }),
      });
      expect(output.mode).toBe("stream");
      const events = await collectEvents(streamEventsOf(output));
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("message_start");
      expect(types).toContain("thinking_delta");
      const text = events.filter((e) => e.type === "text_delta").map(textDeltaText).join("");
      expect(text).toBe("Hello world");
      expect(types).toContain("usage");
      expect(events[events.length - 1]?.type).toBe("message_stop");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("NativeAdapter — per-provider config spot-checks (model-to-URL mapping)", () => {
  test("deepseek maps to the DeepSeek API base URL", async () => {
    const adapter = new NativeAdapter(byId.get("deepseek")!);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "deepseek-chat"));
      expect(capture.url).toBe("https://api.deepseek.com/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("groq maps to the Groq API base URL", async () => {
    const adapter = new NativeAdapter(byId.get("groq")!);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "llama-4-scout-17b-16e-instruct"));
      expect(capture.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("cerebras maps to the Cerebras API base URL", async () => {
    const adapter = new NativeAdapter(byId.get("cerebras")!);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "llama-3.3-70b"));
      expect(capture.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("mistral maps to the Mistral API base URL", async () => {
    const adapter = new NativeAdapter(byId.get("mistral")!);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "mistral-large-latest"));
      expect(capture.url).toBe("https://api.mistral.ai/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("blackboxai maps to the Blackbox AI API base URL", async () => {
    const adapter = new NativeAdapter(byId.get("blackboxai")!);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "blackboxai/z-ai/glm-5.2"));
      expect(capture.url).toBe("https://api.blackbox.ai/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("nvidia maps to the NVIDIA NIM API base URL", async () => {
    const adapter = new NativeAdapter(byId.get("nvidia")!);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "nvidia/llama-3.1-nemotron-ultra-253b-v1"));
      expect(capture.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    } finally {
      restore();
    }
  });
});

describe("NativeAdapter — metadata and catalog identity", () => {
  test("exposes the native protocol and credential kind from config", () => {
    const adapter = new NativeAdapter(byId.get("deepseek")!);
    expect(adapter.metadata).toMatchObject({ id: "deepseek", displayName: "DeepSeek", protocol: "native", credentialKind: "api_key" });
  });

  test("exposes the credentialUrl when configured", () => {
    const adapter = new NativeAdapter(byId.get("groq")!);
    expect(adapter.metadata.credentialUrl).toBe("https://console.groq.com/keys");
  });

  test("aggregates capabilities from the model catalog", () => {
    const adapter = new NativeAdapter(byId.get("deepseek")!);
    // deepseek-reasoner has reasoning=true; aggregation unions to true.
    expect(adapter.capabilities.reasoning).toBe(true);
    expect(adapter.capabilities.surfaces).toContain("openai-chat");
    expect(adapter.capabilities.streaming).toBe(true);
  });

  test("empty-catalog providers remain permissive with fallback capabilities", () => {
    const adapter = new NativeAdapter(byId.get("openrouter")!);
    // OpenRouter has an empty catalog — fallback capabilities apply.
    expect(adapter.capabilities.surfaces).toContain("openai-chat");
    expect(adapter.models.list.length).toBe(0);
    // Still accepts any model id (catalog is informational).
    expect(adapter.resolveTarget("any/model/id", "openai-chat").modelId).toBe("any/model/id");
  });

  test("mapError converts an Error into a ProviderCallError", () => {
    const adapter = new NativeAdapter(byId.get("deepseek")!);
    const error = adapter.mapError(new Error("boom"));
    expect(error.kind).toBe("provider_protocol_error");
    expect(error.source).toBe("upstream");
    expect(error.routeScope).toBe("provider");
  });

  test("countTokens returns unknown stats", async () => {
    const adapter = new NativeAdapter(byId.get("deepseek")!);
    const stats = await adapter.countTokens({ request: request(), signal: new AbortController().signal });
    expect(stats.source).toBe("unknown");
    expect(stats.tokens).toBeNull();
  });
});

// Use isRecord to avoid unused-import in strict environments.
void isRecord;
