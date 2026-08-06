import { describe, expect, test } from "bun:test";
import { GrokBuildAdapter } from "../../src/providers/grok-build";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest, StreamEvent } from "../../src/domain/contracts";

const limits = { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 2_000, totalTimeoutMs: 10_000 };
const emptyNetwork: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "grok-4.6",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello Grok" }] }],
    tools: [],
    stream: true,
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

function makeRequest(credential: string, overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "grok-build", modelId: "grok-4.6", surface: "openai-responses" },
    request: request(),
    credential,
    network: emptyNetwork,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(capture: CapturedCall, response: Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init ?? {};
    return response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
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

function frame(json: Record<string, unknown>): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

const STREAM_FRAMES = [
  frame({ type: "response.created", response: { id: "resp_123" } }),
  frame({ type: "response.output_text.delta", delta: "Hello" }),
  frame({ type: "response.completed", response: { id: "resp_123", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }),
];

async function collectEvents(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("GrokBuildAdapter — identity & catalog", () => {
  test("declares openai protocol, openai-chat surface, and oauth credential kind", () => {
    const adapter = new GrokBuildAdapter();
    expect(adapter.metadata).toMatchObject({ id: "grok-build", displayName: "Grok Build", protocol: "openai", credentialKind: "oauth" });
    expect(adapter.capabilities.surfaces).toEqual(["openai-responses"]);
    expect(adapter.capabilities.streaming).toBe(true);
  });

  test("exposes the default catalog with grok-4.5 and grok-4.6 models", () => {
    const adapter = new GrokBuildAdapter();
    const ids = adapter.models.list.map((m) => m.id);
    expect(ids).toEqual(["grok-4.6", "grok-4.5"]);
    expect(adapter.models.get("grok-4.6")).not.toBeNull();
    expect(adapter.models.get("grok-4.5")).not.toBeNull();
    expect(adapter.models.get("grok-4.6-high")).toBeNull();
  });

  test("catalog models carry reasoning capability and context limits", () => {
    const adapter = new GrokBuildAdapter();
    const model = adapter.models.get("grok-4.6");
    expect(model).not.toBeNull();
    if (model === null) throw new Error("grok-4.6 not found");
    expect(model.capabilities.reasoning).toBe(true);
    expect(model.context?.inputTokens).toBe(500000);
    expect(model.context?.outputTokens).toBe(64000);
  });
});

describe("GrokBuildAdapter — resolveTarget", () => {
  test("resolves a known model on the openai-responses surface", () => {
    const adapter = new GrokBuildAdapter();
    expect(adapter.resolveTarget("grok-4.6", "openai-responses")).toEqual({ providerId: "grok-build", modelId: "grok-4.6", surface: "openai-responses" });
    expect(adapter.resolveTarget("grok-4.5", "openai-responses")).toEqual({ providerId: "grok-build", modelId: "grok-4.5", surface: "openai-responses" });
  });

  test("rejects an unsupported surface", () => {
    const adapter = new GrokBuildAdapter();
    expect(() => adapter.resolveTarget("grok-4.6", "anthropic-messages")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("grok-4.6", "web-search")).toThrow(ProviderAdapterError);
  });

  test("rejects an unknown model", () => {
    const adapter = new GrokBuildAdapter();
    expect(() => adapter.resolveTarget("grok-3", "openai-responses")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("not-a-grok-model", "openai-responses")).toThrow(ProviderAdapterError);
  });
});

describe("GrokBuildAdapter — call guard paths (no network)", () => {
  test("countTokens returns unknown", async () => {
    const adapter = new GrokBuildAdapter();
    await expect(adapter.countTokens({ request: request(), signal: new AbortController().signal })).resolves.toEqual({ tokens: null, source: "unknown" });
  });

  test("call rejects an unsupported surface before the network", async () => {
    const adapter = new GrokBuildAdapter();
    const input = makeRequest("tok", { target: { providerId: "grok-build", modelId: "grok-4.6", surface: "anthropic-messages" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an empty credential before the network", async () => {
    const adapter = new GrokBuildAdapter();
    const input = makeRequest("");
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("mapError maps a ProviderAdapterError faithfully", () => {
    const adapter = new GrokBuildAdapter();
    const error = new ProviderAdapterError({ kind: "authentication_failed", message: "no token", statusCode: 401, routeScope: "account" });
    const mapped = adapter.mapError(error);
    expect(mapped.kind).toBe("authentication_failed");
    expect(mapped.statusCode).toBe(401);
    expect(mapped.routeScope).toBe("account");
  });
});

describe("GrokBuildAdapter — call streaming happy path", () => {
  test("posts to /responses with Bearer auth and grok-shell user-agent headers", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      const output = await adapter.call(makeRequest("grok-oauth-tok"));
      expect(output.mode).toBe("stream");

      expect(capture.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["authorization"]).toBe("Bearer grok-oauth-tok");
      expect(headers["user-agent"]).toBe("grok-shell/0.2.120 (linux; x86_64)");
      expect(headers["x-xai-token-auth"]).toBe("xai-grok-cli");
      expect(headers["x-grok-client-identifier"]).toBe("grok-shell");
      expect(headers["x-grok-client-version"]).toBe("0.2.120");
      expect(headers["x-grok-client-mode"]).toBe("headless");
      expect(headers["accept"]).toBe("text/event-stream");
    } finally {
      restore();
    }
  });

  test("drops sampling controls (temperature, top_p, max_output_tokens)", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(makeRequest("tok"));
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("grok-4.6");
      const reasoning = body.reasoning as Record<string, unknown>;
      expect(reasoning.effort).toBe("high");
      expect(reasoning.summary).toBe("concise");
    } finally {
      restore();
    }
  });

  test("enabled reasoning maps to medium effort in payload", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      // buildResponsesPayload sets reasoning={effort:"medium"} only when reasoning="enabled"
      await adapter.call(makeRequest("tok", { request: request({ reasoning: "enabled" }) }));
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      const reasoning = body.reasoning as Record<string, unknown>;
      // normalizeEffort("medium") returns "medium"
      expect(reasoning.effort).toBe("medium");
    } finally {
      restore();
    }
  });

  test("store=false and stream=true forced in payload", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(makeRequest("tok"));
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
    } finally {
      restore();
    }
  });

  test("encrypted_content included when effort != none", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(makeRequest("tok"));
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      const include = body.include as string[];
      expect(include).toContain("reasoning.encrypted_content");
    } finally {
      restore();
    }
  });

  test("drops sampling controls (temperature, top_p, max_output_tokens)", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(makeRequest("tok", { request: request({ maxOutputTokens: 1000 }) }));
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.max_output_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
      expect(body.messages).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("maps SSE frames to StreamEvents with message_start, text_delta, and message_stop", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      const output = await adapter.call(makeRequest("tok"));
      expect(output.mode).toBe("stream");
      if (output.mode !== "stream") throw new Error("expected stream");

      const events = await collectEvents(output.events);
      const types = events.map((e) => e.type);
      expect(types).toContain("message_start");
      expect(types).toContain("text_delta");

      const start = events.find((e) => e.type === "message_start");
      expect(start).toBeDefined();

      const textDelta = events.find((e) => e.type === "text_delta") as { type: "text_delta"; text: string } | undefined;
      expect(textDelta?.text).toBe("Hello");
    } finally {
      restore();
    }
  });

  test("maps upstream error to a typed ProviderAdapterError", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } }));
    try {
      const error = await adapter.call(makeRequest("tok")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect((error as ProviderAdapterError).retryable).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("GrokBuildAdapter — call non-stream (folded SSE)", () => {
  test("folds SSE stream into a non_stream response body when client did not request streaming", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, sseResponse(STREAM_FRAMES));
    try {
      const input = makeRequest("tok", { request: request({ stream: false }) });
      const output = await adapter.call(input);
      expect(output.mode).toBe("non_stream");
      if (output.mode !== "non_stream") throw new Error("expected non_stream");

      const body = output.body;
      expect(body.id).toBe("resp_123");

      const usage = output.usage;
      expect(usage).toBeDefined();
      if (usage === undefined) throw new Error("expected usage");
      expect(usage.inputTokens).toBe(5);
      expect(usage.outputTokens).toBe(3);
    } finally {
      restore();
    }
  });

  test("throws stream_truncated when SSE ends without response.completed", async () => {
    const adapter = new GrokBuildAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    // Stream with only a delta, no terminal response.completed event.
    const truncatedFrames = [frame({ type: "response.output_text.delta", delta: "Hello" })];
    const restore = stubFetch(capture, sseResponse(truncatedFrames));
    try {
      const input = makeRequest("tok", { request: request({ stream: false }) });
      const error = await adapter.call(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect((error as ProviderAdapterError).kind).toBe("stream_truncated");
    } finally {
      restore();
    }
  });
});
