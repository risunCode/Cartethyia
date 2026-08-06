import { describe, expect, test } from "bun:test";
import { GoogleAntigravityAdapter, antigravityThinkingBudget, antigravityWireModelId, buildAntigravityRequest, parseAntigravityCredential } from "../../src/providers/google-antigravity";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest } from "../../src/domain/contracts";

const limits = { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 2_000, totalTimeoutMs: 10_000 };
const emptyNetwork: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "gemini-3.1-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
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

function providerRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "antigravity", modelId: "gemini-3.1-pro", surface: "openai-chat" },
    request: request(),
    credential: JSON.stringify({ accessToken: "at-1", projectId: "proj-123" }),
    network: emptyNetwork,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** Replaces global fetch with a queue of canned responses; records every call. */
function stubFetchQueue(...responses: Response[]): CapturedCall[] {
  const captures: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    captures.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch call: ${call.url}`);
    return next;
  }) as typeof fetch;
  (globalThis.fetch as unknown as { __restore?: () => void }).__restore = () => {
    globalThis.fetch = original;
  };
  return captures;
}

function captureAt(captures: readonly CapturedCall[], index: number): CapturedCall {
  const capture = captures[index];
  if (capture === undefined) throw new Error(`missing captured call ${index}`);
  return capture;
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

function antigravityFrame(json: Record<string, unknown>): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

function textFrame(text: string, usage?: Record<string, unknown>): string {
  const usageMetadata = usage ?? { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
  return antigravityFrame({ response: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata } });
}

const STREAM_FRAMES = [textFrame("Hello")];

function errorBody(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "internal" } }), { status, headers: { "content-type": "application/json" } });
}

function restoreFetch(): void {
  (globalThis.fetch as unknown as { __restore: () => void }).__restore();
}

describe("parseAntigravityCredential", () => {
  test("accepts the composite JSON form", () => {
    const parsed = parseAntigravityCredential(JSON.stringify({ accessToken: "at-1", projectId: "proj-123" }));
    expect(parsed).toEqual({ accessToken: "at-1", projectId: "proj-123" });
  });

  test("rejects bare tokens, empty strings, and partial JSON", () => {
    expect(parseAntigravityCredential("")).toBeNull();
    expect(parseAntigravityCredential("eyJhbGciOiJIUzI1NiJ9.sig")).toBeNull();
    expect(parseAntigravityCredential(JSON.stringify({ accessToken: "at-1" }))).toBeNull();
    expect(parseAntigravityCredential(JSON.stringify({ projectId: "proj-1" }))).toBeNull();
  });
});

describe("antigravityWireModelId / thinking budget", () => {
  test("collapses logical ids to the upstream wire ids", () => {
    expect(antigravityWireModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-low");
    expect(antigravityWireModelId("gemini-3.1-pro-high")).toBe("gemini-pro-agent");
    expect(antigravityWireModelId("gemini-3.5-flash")).toBe("gemini-3.5-flash-extra-low");
    expect(antigravityWireModelId("gemini-3.5-flash-medium")).toBe("gemini-3.5-flash-low");
    expect(antigravityWireModelId("gemini-3.5-flash-high")).toBe("gemini-3-flash-agent");
    expect(antigravityWireModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  test("maps effort tiers to thinking budgets", () => {
    expect(antigravityThinkingBudget("gemini-3.1-pro-low")).toBe(1_000);
    expect(antigravityThinkingBudget("gemini-3.1-pro-low-medium")).toBe(4_000);
    expect(antigravityThinkingBudget("gemini-3.1-pro-low-high")).toBe(10_000);
    expect(antigravityThinkingBudget("claude-opus-4-6")).toBe(10_000);
    expect(antigravityThinkingBudget("gpt-oss-120b")).toBeUndefined();
  });
});

describe("buildAntigravityRequest", () => {
  const credential = { accessToken: "at-1", projectId: "proj-123" };

  test("builds the agent envelope with project, labels, and wire model", () => {
    const envelope = buildAntigravityRequest(request(), credential, "gemini-3.1-pro");
    expect(envelope.project).toBe("proj-123");
    expect(envelope.userAgent).toBe("antigravity");
    expect(envelope.requestType).toBe("agent");
    expect(envelope.model).toBe("gemini-3.1-pro-low");
    expect(String(envelope.requestId)).toMatch(/^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/2$/);

    const inner = envelope.request as Record<string, unknown>;
    expect(String(inner.sessionId)).toMatch(/^\d+$/);
    const labels = inner.labels as Record<string, string>;
    expect(labels.trajectory_id).toBeTruthy();
    expect(labels.last_step_index).toBe("1");
    expect(labels.used_claude).toBe("false");
    expect(labels.model_enum).toBe("MODEL_PLACEHOLDER_M36");
    expect((inner.contents as unknown[]).length).toBe(2);
    expect(((inner.contents as Array<{ parts?: Array<{ text?: string }> }>)[0]?.parts?.[0]?.text)).toContain("You are Antigravity");

    const generationConfig = inner.generationConfig as Record<string, unknown>;
    expect(generationConfig.maxOutputTokens).toBe(65_535);
    // The wire id is gemini-3.1-pro-low, so the "low" effort tier wins.
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1_000 });
  });

  test("caps Claude wire models at 64000 output tokens with the VALIDATED tool config", () => {
    const envelope = buildAntigravityRequest(request({ model: "claude-sonnet-4-6" }), credential, "claude-sonnet-4-6");
    const inner = envelope.request as Record<string, unknown>;
    const generationConfig = inner.generationConfig as Record<string, unknown>;
    expect(generationConfig.maxOutputTokens).toBe(64_000);
    expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 10_000 });
    expect(inner.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect((inner.labels as Record<string, string>).used_claude).toBe("true");
  });

  test("keeps the client max output cap for wire ids without a fixed profile", () => {
    const envelope = buildAntigravityRequest(request({ model: "claude-opus-4-6", maxOutputTokens: 4096 }), credential, "claude-opus-4-6");
    const inner = envelope.request as Record<string, unknown>;
    const generationConfig = inner.generationConfig as Record<string, unknown>;
    expect(generationConfig.maxOutputTokens).toBe(4096);
  });

  test("appends the googleSearch tool when the request asks for web search", () => {
    const envelope = buildAntigravityRequest(request({ tools: [{ name: "web_search", description: "search", inputSchema: {} }] }), credential, "gemini-3.5-flash");
    const inner = envelope.request as Record<string, unknown>;
    const tools = inner.tools as Array<Record<string, unknown>>;
    expect(tools.some((tool) => tool.googleSearch !== undefined)).toBe(true);
  });

  test("keeps declared function tools alongside the search tool", () => {
    const envelope = buildAntigravityRequest(
      request({
        model: "gemini-3-flash",
        tools: [
          { name: "get_weather", description: "weather", inputSchema: { type: "object" } },
          { name: "web_search_preview", description: "search", inputSchema: {} },
        ],
      }),
      credential,
      "gemini-3-flash",
    );
    const inner = envelope.request as Record<string, unknown>;
    const tools = inner.tools as Array<Record<string, unknown>>;
    const firstTool = tools[0];
    expect(firstTool).toBeDefined();
    if (firstTool === undefined) throw new Error("Antigravity request did not contain tools");
    const declarations = (firstTool.functionDeclarations as Array<{ name: string }>).map((tool) => tool.name);
    expect(declarations).toContain("get_weather");
    expect(tools.some((tool) => tool.googleSearch !== undefined)).toBe(true);
  });
});

describe("GoogleAntigravityAdapter.call", () => {
  test("streams Gemini-style SSE frames with the Antigravity wire headers", async () => {
    const captures = stubFetchQueue(sseResponse(STREAM_FRAMES));
    const adapter = new GoogleAntigravityAdapter();
    const output = await adapter.call(providerRequest());

    expect(captures.length).toBe(1);
    expect(captureAt(captures, 0).url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    const headers = captureAt(captures, 0).init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer at-1");
    expect(headers["user-agent"]).toBe(`antigravity/hub/2.1.4 ${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch}`);
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["content-type"]).toBe("application/json");

    expect(output.mode).toBe("stream");
    const events: Array<{ type: string }> = [];
    if (output.mode === "stream") {
      for await (const event of output.events) events.push(event);
    }
    const text = events.filter((event) => event.type === "text_delta").map((event) => (event as unknown as { text: string }).text).join("");
    expect(text).toBe("Hello");
    const usage = events.find((event) => event.type === "usage") as { usage: { inputTokens: number } } | undefined;
    expect(usage?.usage.inputTokens).toBe(10);
    expect(events.some((event) => event.type === "message_stop")).toBe(true);
    restoreFetch();
  });

  test("folds the stream into a non-stream chat completion when the client does not stream", async () => {
    const captures = stubFetchQueue(sseResponse(STREAM_FRAMES));
    const adapter = new GoogleAntigravityAdapter();
    const output = await adapter.call(providerRequest({ request: request({ stream: false }) }));

    expect(output.mode).toBe("non_stream");
    if (output.mode === "non_stream") {
      const choices = output.body.choices as Array<{ message: { content: string }; finish_reason: string }>;
      const choice = choices[0];
      expect(choice).toBeDefined();
      if (choice === undefined) throw new Error("Antigravity response did not contain a choice");
      expect(choice.message.content).toBe("Hello");
      expect(choice.finish_reason).toBe("stop");
      const usage = output.body.usage as { prompt_tokens: number; completion_tokens: number };
      expect(usage.prompt_tokens).toBe(10);
      expect(usage.completion_tokens).toBe(5);
    }
    expect(captures.length).toBe(1);
    restoreFetch();
  });

  test("retries once against the sandbox endpoint on a 5xx from the daily endpoint", async () => {
    const captures = stubFetchQueue(errorBody(500, "boom"), sseResponse(STREAM_FRAMES));
    const adapter = new GoogleAntigravityAdapter();
    const output = await adapter.call(providerRequest());

    expect(captures.length).toBe(2);
    expect(captureAt(captures, 0).url).toContain("daily-cloudcode-pa.googleapis.com");
    expect(captureAt(captures, 1).url).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(output.mode).toBe("stream");
    restoreFetch();
  });

  test("retries once against the sandbox endpoint on 429 rate limiting", async () => {
    const captures = stubFetchQueue(errorBody(429, "rate limited"), sseResponse(STREAM_FRAMES));
    const adapter = new GoogleAntigravityAdapter();
    const output = await adapter.call(providerRequest());
    expect(captures.length).toBe(2);
    expect(captureAt(captures, 1).url).toContain("sandbox.googleapis.com");
    expect(output.mode).toBe("stream");
    restoreFetch();
  });

  test("maps upstream errors to typed provider errors and does not fall back on 400", async () => {
    const captures = stubFetchQueue(errorBody(400, "Request contains an invalid argument"));
    const adapter = new GoogleAntigravityAdapter();
    const failure = await adapter.call(providerRequest()).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ProviderAdapterError);
    const mapped = adapter.mapError(failure);
    expect(mapped.kind).toBe("invalid_request");
    expect(mapped.statusCode).toBe(400);
    expect(captures.length).toBe(1);
    restoreFetch();
  });

  test("rejects credentials without the project id before any request is made", async () => {
    const adapter = new GoogleAntigravityAdapter();
    const failure = await adapter.call(providerRequest({ credential: "bare-access-token" })).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ProviderAdapterError);
    const mapped = adapter.mapError(failure);
    expect(mapped.kind).toBe("authentication_failed");
    expect(mapped.statusCode).toBe(401);
    expect(mapped.routeScope).toBe("account");
  });

  test("resolveTarget rejects unknown models and unsupported surfaces", () => {
    const adapter = new GoogleAntigravityAdapter();
    expect(adapter.resolveTarget("gemini-3.1-pro", "openai-chat")).toEqual({ providerId: "antigravity", modelId: "gemini-3.1-pro", surface: "openai-chat" });
    expect(() => adapter.resolveTarget("not-a-model", "openai-chat")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("gemini-3.1-pro", "anthropic-messages")).toThrow(ProviderAdapterError);
  });
});