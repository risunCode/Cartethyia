import { describe, expect, test } from "bun:test";
import { ClineAdapter } from "../../src/providers/cline";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest, StreamEvent } from "../../src/domain/contracts";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "z-ai/glm-5.2",
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
    target: { providerId: "cline", modelId: "z-ai/glm-5.2", upstreamModelId: "z-ai/glm-5.2", surface: "openai-chat" },
    request: request({ model: "z-ai/glm-5.2" }),
    credential: "access-token",
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

function countingStub(respond: (index: number) => Response): { getCalls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
    const current = calls;
    calls += 1;
    return respond(current);
  }) as unknown as typeof fetch;
  return {
    getCalls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonBody(json: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

/** Builds a minimal OpenAI-style SSE stream body with a text delta and stop. */
function sseBody(events: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = events.map((event) => encoder.encode(event));
  return new Blob(parts).stream();
}

function openaiSseStream(): ReadableStream<Uint8Array> {
  return sseBody([
    `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", choices: [{ delta: { content: "Hello" }, index: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", choices: [{ delta: { content: " Cline" }, index: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", choices: [{ delta: {}, index: 0, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

async function collectStream(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Narrows a stream event to its text-delta payload, returning undefined otherwise. */
function textOf(event: StreamEvent): string | undefined {
  return event.type === "text_delta" ? event.text : undefined;
}

describe("ClineAdapter — identity & catalog", () => {
  const adapter = new ClineAdapter();

  test("declares the openai protocol and oauth credential kind", () => {
    expect(adapter.metadata).toMatchObject({
      id: "cline",
      displayName: "Cline",
      protocol: "openai",
      credentialKind: "oauth",
    });
  });

  test("exposes the curated Cline model catalog", () => {
    expect(adapter.models.get("z-ai/glm-5.2")?.displayName).toBe("GLM 5.2");
    expect(adapter.models.get("deepseek/deepseek-v4-flash")?.displayName).toBe("DeepSeek V4 Flash");
    expect(adapter.models.get("openai/gpt-5.6-sol-pro")?.displayName).toBe("GPT 5.6 Sol Pro");
    expect(adapter.models.get("google/gemini-3.1-flash-lite-preview")?.displayName).toBe("Gemini 3.1 Flash Lite");
    expect(adapter.models.get("does-not-exist")).toBeNull();
  });

  test("aggregates capabilities with streaming, reasoning, and image support on the openai-chat surface", () => {
    expect(adapter.capabilities.surfaces).toContain("openai-chat");
    expect(adapter.capabilities.streaming).toBe(true);
    expect(adapter.capabilities.reasoning).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
  });
});

describe("ClineAdapter — resolveTarget", () => {
  const adapter = new ClineAdapter();

  test("resolves a known model on the openai-chat surface", () => {
    expect(adapter.resolveTarget("z-ai/glm-5.2", "openai-chat")).toEqual({ providerId: "cline", modelId: "z-ai/glm-5.2", upstreamModelId: "z-ai/glm-5.2", surface: "openai-chat" });
  });

  test("rejects an unsupported surface with capability_unsupported (400)", () => {
    expect(() => adapter.resolveTarget("z-ai/glm-5.2", "anthropic-messages")).toThrow(ProviderAdapterError);
    try {
      adapter.resolveTarget("z-ai/glm-5.2", "anthropic-messages");
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

describe("ClineAdapter — call credential & header contracts", () => {
  const adapter = new ClineAdapter();

  test("wraps the credential in the workos: prefix and sends Cline identity headers", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, jsonBody({ choices: [{ message: { content: "hi" } }], model: "z-ai/glm-5.2" }));
    try {
      const output = await adapter.call(makeRequest());
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://api.cline.bot/api/v1/chat/completions");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer workos:access-token");
      expect(headers["x-client-type"]).toBe("cline-cli");
      expect(headers["x-client-version"]).toBe("4.0.11");
      expect(headers["x-core-version"]).toBe("4.0.11");
      expect(headers["http-referer"]).toBe("https://cline.bot");
      expect(headers["x-title"]).toBe("Cline");
      expect(headers["user-agent"]).toBe("Cline/4.0.11");
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("z-ai/glm-5.2");
    } finally {
      restore();
    }
  });

  test("does not double-prefix a credential already starting with workos:", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, jsonBody({ choices: [] }));
    try {
      await adapter.call(makeRequest({ credential: "workos:already-prefixed" }));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer workos:already-prefixed");
    } finally {
      restore();
    }
  });

  test("injects a default system message when none is present in the payload", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, jsonBody({ choices: [] }));
    try {
      await adapter.call(makeRequest());
      const raw = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      const messages = Array.isArray(raw.messages) ? raw.messages : [];
      expect(messages.length).toBeGreaterThan(0);
      const first = messages[0];
      expect(typeof first === "object" && first !== null && "role" in first && first.role).toBe("system");
    } finally {
      restore();
    }
  });

  test("does not inject a system message when one is already present", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, jsonBody({ choices: [] }));
    try {
      await adapter.call(
        makeRequest({
          request: request({
            messages: [
              { role: "system", content: [{ type: "text", text: "You are Cline." }] },
              { role: "user", content: [{ type: "text", text: "Hello" }] },
            ],
          }),
        }),
      );
      const raw = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      const messages = Array.isArray(raw.messages) ? raw.messages : [];
      expect(messages.length).toBe(2);
      const first = messages[0];
      expect(typeof first === "object" && first !== null && "role" in first && first.role).toBe("system");
    } finally {
      restore();
    }
  });

  test("preserves a developer-role message without injecting an additional system message", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, jsonBody({ choices: [] }));
    try {
      await adapter.call(
        makeRequest({
          request: request({
            messages: [
              { role: "developer", content: [{ type: "text", text: "dev instructions" }] },
              { role: "user", content: [{ type: "text", text: "Hello" }] },
            ],
          }),
        }),
      );
      const raw = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      const messages = Array.isArray(raw.messages) ? raw.messages : [];
      // ensureSystemMessage skips injection when a system/developer message is
      // already present; the wire payload maps developer→system, so we assert
      // the count stays at 2 (no extra injected message).
      expect(messages.length).toBe(2);
    } finally {
      restore();
    }
  });
});

describe("ClineAdapter — call guards", () => {
  const adapter = new ClineAdapter();

  test("rejects an unsupported surface before touching the network", async () => {
    const input = makeRequest({ target: { providerId: "cline", modelId: "z-ai/glm-5.2", upstreamModelId: "z-ai/glm-5.2", surface: "anthropic-messages" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
    await expect(adapter.call(input)).rejects.toMatchObject({ kind: "capability_unsupported", statusCode: 400 });
  });

  test("rejects an empty credential with authentication_failed (account scope)", async () => {
    const input = makeRequest({ credential: "" });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
    await expect(adapter.call(input)).rejects.toMatchObject({ kind: "authentication_failed", statusCode: 401, routeScope: "account" });
  });

  test("countTokens returns unknown without contacting a tokenizer", async () => {
    await expect(
      adapter.countTokens({ request: request(), signal: new AbortController().signal }),
    ).resolves.toEqual({ tokens: null, source: "unknown" });
  });
});

describe("ClineAdapter — streaming", () => {
  const adapter = new ClineAdapter();

  test("hands off an SSE stream and decodes OpenAI chat-completion chunks", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(
      capture,
      new Response(openaiSseStream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    try {
      const output = await adapter.call(makeRequest({ request: request({ stream: true }) }));
      expect(output.mode).toBe("stream");
      if (output.mode !== "stream") {
        expect.unreachable();
        return;
      }
      const events = await collectStream(output.events);
      const textDeltas = events.map(textOf).filter((text): text is string => text !== undefined);
      expect(textDeltas.length).toBe(2);
      expect(textDeltas[0]).toBe("Hello");
      expect(textDeltas[1]).toBe(" Cline");
      expect(events.some((event) => event.type === "message_stop")).toBe(true);
    } finally {
      restore();
    }
  });

  test("sets the accept header to text/event-stream for stream requests", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(
      capture,
      new Response(openaiSseStream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    try {
      await adapter.call(makeRequest({ request: request({ stream: true }) }));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.accept).toBe("text/event-stream");
    } finally {
      restore();
    }
  });
});

describe("ClineAdapter — retry on empty 500", () => {
  test("retries once when the gateway returns an empty-content 500", async () => {
    const counter = countingStub((index) => {
      if (index === 0) {
        return jsonBody({ error: { message: "empty response content" } }, 500);
      }
      return jsonBody({ choices: [{ message: { content: "recovered" } }], model: "z-ai/glm-5.2" });
    });
    try {
      const adapter = new ClineAdapter();
      const output = await adapter.call(makeRequest());
      expect(output.mode).toBe("non_stream");
      expect(counter.getCalls()).toBe(2);
    } finally {
      counter.restore();
    }
  });

  test("does not retry a non-empty-content 500 error", async () => {
    const counter = countingStub(() => jsonBody({ error: { message: "internal server error" } }, 500));
    try {
      const adapter = new ClineAdapter();
      await expect(adapter.call(makeRequest())).rejects.toBeInstanceOf(ProviderAdapterError);
      expect(counter.getCalls()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  test("does not retry a 4xx error", async () => {
    const counter = countingStub(() => jsonBody({ error: { message: "bad request" } }, 400));
    try {
      const adapter = new ClineAdapter();
      await expect(adapter.call(makeRequest())).rejects.toBeInstanceOf(ProviderAdapterError);
      expect(counter.getCalls()).toBe(1);
    } finally {
      counter.restore();
    }
  });
});

describe("ClineAdapter — mapError", () => {
  const adapter = new ClineAdapter();

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
