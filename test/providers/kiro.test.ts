import { describe, expect, test } from "bun:test";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest, StreamEvent } from "../../src/domain/contracts";
import { KiroAdapter, buildKiroPayload, decodeKiroStream, materializeKiroEvents } from "../../src/providers/kiro";
import { kiroModelCatalog } from "../../src/providers/kiro-models";
import { ProviderAdapterError } from "../../src/providers/shared";
import { AbortCoordinator } from "../../src/providers/shared";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 2_000,
} as const;

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "claude-opus-4.8",
    messages: [
      { role: "system", content: [{ type: "text", text: "You are a helpful assistant" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
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

function providerRequest(modelId = "claude-opus-4.8", credential = "secret", stream = false): ProviderRequest {
  return {
    target: { providerId: "kiro", modelId, surface: "openai-chat" },
    request: request({ model: modelId, stream }),
    credential,
    network: emptyNetwork,
    signal: new AbortController().signal,
  };
}

/** Encodes an AWS event-stream frame with an empty header block and a JSON payload. */
function frame(payload: Record<string, unknown>): Uint8Array {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const total = 12 + payloadBytes.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, 0); // zero-length headers block
  out.set(payloadBytes, 12);
  return out;
}

function streamBody(frames: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  const parts = frames.map((item) => item.buffer.slice(item.byteOffset, item.byteOffset + item.byteLength) as ArrayBuffer);
  return new Blob(parts).stream();
}

function kiroEventStream(): ReadableStream<Uint8Array> {
  return streamBody([
    frame({ assistantResponseEvent: { content: "Hello from " } }),
    frame({ reasoningContentEvent: { reasoningContent: "thinking hard" } }),
    frame({ assistantResponseEvent: { content: "Kiro" } }),
    frame({ meteringEvent: { inputTokens: 12, outputTokens: 4, cacheReadInputTokens: 3 } }),
    frame({ messageStopEvent: { requestId: "req-1" } }),
  ]);
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(capture: CapturedCall, respond: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init ?? {};
    return respond(String(url));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("KiroAdapter model catalog", () => {
  test("catalog exposes the legacy 39-model Kiro set", () => {
    expect(kiroModelCatalog.length).toBe(42);
    expect(kiroModelCatalog.map((model) => model.id)).toContain("auto");
    expect(kiroModelCatalog.map((model) => model.id)).toContain("auto-thinking");
    expect(kiroModelCatalog.map((model) => model.id)).toContain("auto-thinking-agentic");
    expect(kiroModelCatalog.map((model) => model.id)).toContain("claude-opus-4.8");
    expect(kiroModelCatalog.map((model) => model.id)).toContain("gpt-5.6-luna-thinking-agentic");
    expect(kiroModelCatalog.find((model) => model.id === "auto")?.capabilities.reasoning).toBe(false);
    expect(kiroModelCatalog.find((model) => model.id === "auto-thinking")?.capabilities.reasoning).toBe(true);
    expect(kiroModelCatalog.filter((model) => model.id !== "auto").every((model) => model.capabilities.reasoning)).toBe(true);
    const gpt = kiroModelCatalog.find((model) => model.id === "gpt-5.6-sol");
    expect(gpt?.capabilities.images).toBe(true);
    const claude = kiroModelCatalog.find((model) => model.id === "claude-haiku-4.5");
    expect(claude?.capabilities.images).toBe(false);
  });
});

describe("KiroAdapter routing", () => {
  const adapter = new KiroAdapter();

  test("resolves the openai-chat surface with the requested model", () => {
    expect(adapter.resolveTarget("claude-sonnet-5", "openai-chat")).toEqual({ providerId: "kiro", modelId: "claude-sonnet-5", surface: "openai-chat" });
  });

  test("rejects unsupported surfaces with a typed capability error", () => {
    try {
      adapter.resolveTarget("claude-sonnet-5", "native" as never);
      expect.unreachable();
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProviderAdapterError);
      const mapped = (caught as ProviderAdapterError).toProviderCallError();
      expect(mapped.kind).toBe("capability_unsupported");
      expect(mapped.statusCode).toBe(400);
    }
  });
});

describe("Kiro thinking payload", () => {
  test("translates thinking aliases to the base model and enables Kiro reasoning", () => {
    const payload = buildKiroPayload(request({ model: "claude-haiku-4.5-thinking" }), "claude-haiku-4.5-thinking");
    expect(payload.systemPrompt).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(payload.systemPrompt).toContain("<max_thinking_length>16000</max_thinking_length>");
    expect(payload.systemPrompt).toContain("You are a helpful assistant");
    const state = payload.conversationState as { currentMessage: { userInputMessage: { modelId: string } } };
    expect(state.currentMessage.userInputMessage.modelId).toBe("claude-haiku-4.5");

    const autoPayload = buildKiroPayload(request({ model: "auto-thinking-agentic" }), "auto-thinking-agentic");
    expect(autoPayload.systemPrompt).toContain("<thinking_mode>enabled</thinking_mode>");
    const autoState = autoPayload.conversationState as { currentMessage: { userInputMessage: { modelId: string } } };
    expect(autoState.currentMessage.userInputMessage.modelId).toBe("auto");
  });

  test("honors explicit reasoning enablement for a base model", () => {
    const payload = buildKiroPayload(request({ reasoning: "enabled" }), "claude-haiku-4.5");
    expect(payload.systemPrompt).toContain("<thinking_mode>enabled</thinking_mode>");
  });

  test("honors explicit reasoning disablement over a thinking alias", () => {
    const payload = buildKiroPayload(request({ reasoning: "disabled" }), "claude-haiku-4.5-thinking");
    expect(payload.systemPrompt).toBe("You are a helpful assistant");
  });
});

describe("KiroAdapter call (non-stream)", () => {
  test("requires a credential", async () => {
    const adapter = new KiroAdapter();
    await expect(adapter.call(providerRequest("claude-opus-4.8", ""))).rejects.toMatchObject({ kind: "authentication_failed", statusCode: 401 });
  });

  test("decodes a non-stream response into a chat completion body with usage", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, () => new Response(kiroEventStream(), { status: 200 }));
    try {
      const adapter = new KiroAdapter();
      const output = await adapter.call(providerRequest("claude-opus-4.8"));
      expect(output.mode).toBe("non_stream");
      if (output.mode !== "non_stream") return;
      expect(capture.url).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer secret");
      expect(headers["x-amz-target"]).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
      expect(headers.tokentype).toBeUndefined();
      const body = output.body;
      const choices = body.choices as unknown as Array<{ message: { content: string; reasoning_content?: string } }>;
      const choice = choices[0];
      expect(choice).toBeDefined();
      if (choice === undefined) throw new Error("Kiro response did not contain a choice");
      expect(choice.message.content).toBe("Hello from Kiro");
      expect(choice.message.reasoning_content).toBe("thinking hard");
      expect(body.model).toBe("claude-opus-4.8");
      expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
      // conversationState payload carries the system prompt and history.
      const sent = JSON.parse(String(capture.init.body)) as Record<string, unknown>;
      const state = sent.conversationState as Record<string, unknown>;
      expect(sent.systemPrompt).toBe("You are a helpful assistant");
      expect((state.currentMessage as Record<string, unknown>).userInputMessage).toMatchObject({ content: "Hello", modelId: "claude-opus-4.8", origin: "AI_EDITOR" });
      expect(sent.profileArn).toContain("profile/AAAACCCCXXXX");
      expect((sent.inferenceConfig as Record<string, unknown>).maxTokens).toBe(128000);
    } finally {
      restore();
    }
  });

  test("accepts a raw access token as the credential", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, () => new Response(kiroEventStream(), { status: 200 }));
    try {
      const adapter = new KiroAdapter();
      const output = await adapter.call(providerRequest("claude-opus-4.8", "raw-token"));
      expect(output.mode).toBe("non_stream");
      expect((capture.init.headers as Record<string, string>).authorization).toBe("Bearer raw-token");
    } finally {
      restore();
    }
  });

  test("attaches the API_KEY token-type header, omits the profile ARN, and prefers regionalized Amazon endpoints", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const bundle = JSON.stringify({ accessToken: "kiro-token", authMethod: "api_key", region: "eu-west-1" });
    const restore = stubFetch(capture, () => new Response(kiroEventStream(), { status: 200 }));
    try {
      const adapter = new KiroAdapter();
      await adapter.call(providerRequest("claude-opus-4.8", bundle));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.tokentype).toBe("API_KEY");
      const sent = JSON.parse(String(capture.init.body)) as Record<string, unknown>;
      expect(sent.profileArn).toBeUndefined();
      // API-key auth tries the Amazon-hosted endpoints first, regionalized.
      expect(capture.url).toBe("https://codewhisperer.eu-west-1.amazonaws.com/generateAssistantResponse");
    } finally {
      restore();
    }
  });

  test("does not retry non-retryable 4xx responses on the next endpoint", async () => {
    let calls = 0;
    const restore = stubFetch({ url: "", init: {} }, () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    try {
      const adapter = new KiroAdapter();
      const error = await adapter.call(providerRequest("claude-opus-4.8")).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect((error as ProviderAdapterError).toProviderCallError().kind).toBe("model_not_found");
      expect(calls).toBe(1);
    } finally {
      restore();
    }
  });

  test("retries 5xx responses across the ordered endpoints", async () => {
    let calls = 0;
    const restore = stubFetch({ url: "", init: {} }, () => {
      calls += 1;
      return new Response("boom", { status: 503 });
    });
    try {
      const adapter = new KiroAdapter();
      const error = await adapter.call(providerRequest("claude-opus-4.8")).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect((error as ProviderAdapterError).toProviderCallError().kind).toBe("provider_unavailable");
      expect(calls).toBe(3);
    } finally {
      restore();
    }
  });
});

describe("KiroAdapter call (stream)", () => {
  test("exposes decoded StreamEvents with a terminal message_stop", async () => {
    const restore = stubFetch({ url: "", init: {} }, () => new Response(kiroEventStream(), { status: 200 }));
    try {
      const adapter = new KiroAdapter();
      const output = await adapter.call(providerRequest("claude-opus-4.8", "secret", true));
      expect(output.mode).toBe("stream");
      if (output.mode !== "stream") return;
      const events: StreamEvent[] = [];
      for await (const event of output.events) events.push(event);
      const texts = events.filter((event) => event.type === "text_delta").map((event) => event.text);
      expect(texts).toEqual(["Hello from ", "Kiro"]);
      const usage = events.find((event) => event.type === "usage");
      expect(usage).toEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 3, cacheWriteTokens: null, source: "provider" } });
      expect(events.at(-1)).toEqual({ type: "message_stop", reason: "completed" });
    } finally {
      restore();
    }
  });

  test("synthesizes a terminal message_stop when the upstream stream ends without one", async () => {
    const restore = stubFetch({ url: "", init: {} }, () => new Response(streamBody([frame({ assistantResponseEvent: { content: "only this" } })]), { status: 200 }));
    try {
      const adapter = new KiroAdapter();
      const output = await adapter.call(providerRequest("claude-opus-4.8", "secret", true));
      if (output.mode !== "stream") return;
      const events: StreamEvent[] = [];
      for await (const event of output.events) events.push(event);
      expect(events.at(-1)).toEqual({ type: "message_stop", reason: "completed" });
    } finally {
      restore();
    }
  });
});

describe("decodeKiroStream framing", () => {
  test("reassembles frames split across chunks", async () => {
    const bytes = new Blob([
      frame({ assistantResponseEvent: { content: "frag" } }),
      frame({ messageStopEvent: { requestId: "req-2" } }),
    ]).arrayBuffer().then((buffer) => new Uint8Array(buffer));
    const all = await bytes;
    const split = all.subarray(0, 9);
    const rest = all.subarray(9);
    const body = streamBody([split, rest]);
    const coordinator = new AbortCoordinator(new AbortController().signal);
    const events: StreamEvent[] = [];
    for await (const event of decodeKiroStream(body, coordinator)) events.push(event);
    expect(events[0]).toEqual({ type: "text_delta", text: "frag" });
    expect(events.at(-1)).toEqual({ type: "message_stop", reason: "completed" });
  });

  test("maps alternate visible text fields from model-specific Kiro events", async () => {
    const body = streamBody([
      frame({ assistantResponseEvent: { response: { content: [{ text: "Haiku response" }] } } }),
      frame({ codeEvent: { outputText: " with a code block" } }),
      frame({ messageStopEvent: { requestId: "req-3" } }),
    ]);
    const coordinator = new AbortCoordinator(new AbortController().signal);
    const events: StreamEvent[] = [];
    for await (const event of decodeKiroStream(body, coordinator)) events.push(event);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Haiku response" },
      { type: "text_delta", text: " with a code block" },
    ]);
  });

  test("maps the current gateway content and stopReason events", async () => {
    const body = streamBody([
      frame({ content: "Hey" }),
      frame({ content: " there." }),
      frame({ stopReason: "END_TURN" }),
    ]);
    const coordinator = new AbortCoordinator(new AbortController().signal);
    const events: StreamEvent[] = [];
    for await (const event of decodeKiroStream(body, coordinator)) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "Hey" },
      { type: "text_delta", text: " there." },
      { type: "message_stop", reason: "completed" },
    ]);
  });
});

describe("materializeKiroEvents", () => {
  test("aggregates deltas and usage into a chat completion body", async () => {
    const coordinator = new AbortCoordinator(new AbortController().signal);
    const events = decodeKiroStream(kiroEventStream(), coordinator);
    const body = await materializeKiroEvents(events, "claude-opus-4.8");
    const choices = body.choices as unknown as Array<{ message: { content: string } }>;
    const choice = choices[0];
    expect(choice).toBeDefined();
    if (choice === undefined) throw new Error("Kiro materialization did not contain a choice");
    expect(choice.message.content).toBe("Hello from Kiro");
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  });
});
