import { describe, expect, test } from "bun:test";
import { ExaAdapter, exaModelCatalog } from "../../src/providers/exa";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest, StreamEvent } from "../../src/domain/contracts";

const limits = { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 2_000, totalTimeoutMs: 10_000 };
const emptyNetwork: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "exa-search",
    messages: [{ role: "user", content: [{ type: "text", text: "what is bun runtime" }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "web-search",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "exa", modelId: "exa-search", surface: "web-search" },
    request: request(),
    credential: "exa-key-test",
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

function stubFetchQueue(capture: CapturedCall, ...responses: Response[]): () => void {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init ?? {};
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error(`unexpected fetch call ${index}`);
    return next;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function collectEvents(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("ExaAdapter — identity & catalog", () => {
  test("declares exa protocol, web-search surface, and api_key credential kind", () => {
    const adapter = new ExaAdapter();
    expect(adapter.metadata).toMatchObject({ id: "exa", displayName: "Exa AI", protocol: "exa", credentialKind: "api_key" });
    expect(adapter.capabilities.surfaces).toEqual(["web-search"]);
  });

  test("honors config overrides for id, displayName, baseUrl, and credentialKind", () => {
    const adapter = new ExaAdapter({ id: "custom-exa", displayName: "Custom Exa", baseUrl: "https://custom.exa.ai/", credentialKind: "api_key" });
    expect(adapter.metadata.id).toBe("custom-exa");
    expect(adapter.metadata.displayName).toBe("Custom Exa");
  });

  test("exposes the default catalog with exa-search and exa-deep-research", () => {
    const adapter = new ExaAdapter();
    const ids = adapter.models.list.map((m) => m.id);
    expect(ids).toEqual(["exa-search", "exa-deep-research"]);
    expect(adapter.models.get("exa-search")).not.toBeNull();
    expect(adapter.models.get("exa-deep-research")).not.toBeNull();
  });

  test("exaModelCatalog export matches the adapter default models", () => {
    const adapter = new ExaAdapter();
    expect(exaModelCatalog).toHaveLength(2);
    expect(exaModelCatalog.map((m) => m.id)).toEqual(adapter.models.list.map((m) => m.id));
  });
});

describe("ExaAdapter — resolveTarget", () => {
  test("resolves a known model on the web-search surface", () => {
    const adapter = new ExaAdapter();
    expect(adapter.resolveTarget("exa-search", "web-search")).toEqual({ providerId: "exa", modelId: "exa-search", surface: "web-search" });
    expect(adapter.resolveTarget("exa-deep-research", "web-search")).toEqual({ providerId: "exa", modelId: "exa-deep-research", surface: "web-search" });
  });

  test("rejects an unsupported surface", () => {
    const adapter = new ExaAdapter();
    expect(() => adapter.resolveTarget("exa-search", "openai-chat")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("exa-search", "anthropic-messages")).toThrow(ProviderAdapterError);
  });

  test("rejects an unknown model", () => {
    const adapter = new ExaAdapter();
    expect(() => adapter.resolveTarget("not-a-model", "web-search")).toThrow(ProviderAdapterError);
  });
});

describe("ExaAdapter — call guard paths (no network)", () => {
  test("countTokens returns unknown", async () => {
    const adapter = new ExaAdapter();
    await expect(adapter.countTokens({ request: request(), signal: new AbortController().signal })).resolves.toEqual({ tokens: null, source: "unknown" });
  });

  test("call rejects a mismatched providerId", async () => {
    const adapter = new ExaAdapter();
    const input = makeRequest({ target: { providerId: "other", modelId: "exa-search", surface: "web-search" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an unsupported surface before the network", async () => {
    const adapter = new ExaAdapter();
    const input = makeRequest({ target: { providerId: "exa", modelId: "exa-search", surface: "openai-chat" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an empty credential before the network", async () => {
    const adapter = new ExaAdapter();
    const input = makeRequest({ credential: "" });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects a request with no user text in messages", async () => {
    const adapter = new ExaAdapter();
    const input = makeRequest({
      request: request({ messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] }),
    });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("mapError maps a ProviderAdapterError faithfully", () => {
    const adapter = new ExaAdapter();
    const error = new ProviderAdapterError({ kind: "model_not_found", message: "boom", statusCode: 404, routeScope: "provider" });
    const mapped = adapter.mapError(error);
    expect(mapped.kind).toBe("model_not_found");
    expect(mapped.statusCode).toBe(404);
  });
});

describe("ExaAdapter — call non-stream happy path", () => {
  test("posts to /search with x-api-key header and query in body", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const body = JSON.stringify({
      requestId: "req-1",
      results: [
        { title: "Bun Runtime", url: "https://bun.sh", id: "a1", summary: "Fast JS runtime", highlights: ["fast", "native"] },
      ],
      resolvedSearchType: "neural",
      costDollars: { total: 0.01, search: {} },
    });
    const restore = stubFetch(capture, new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const output = await adapter.call(makeRequest());
      expect(output.mode).toBe("non_stream");
      if (output.mode !== "non_stream") throw new Error("expected non_stream");

      expect(capture.url).toBe("https://api.exa.ai/search");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("exa-key-test");
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["accept"]).toBe("application/json");

      const sentBody = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(sentBody.query).toBe("what is bun runtime");
      expect(sentBody.numResults).toBe(10);
      expect(sentBody.stream).toBe(false);
    } finally {
      restore();
    }
  });

  test("formatSearchResponse maps results into chat completion choices", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const body = JSON.stringify({
      requestId: "req-1",
      results: [{ title: "Bun", url: "https://bun.sh", id: "a1", summary: "JS runtime", highlights: ["fast"], text: "detailed content" }],
      resolvedSearchType: "neural",
      costDollars: { total: 0.01, search: {} },
    });
    const restore = stubFetch(capture, new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const output = await adapter.call(makeRequest());
      expect(output.mode).toBe("non_stream");
      if (output.mode !== "non_stream") throw new Error("expected non_stream");

      const responseBody = output.body;
      expect(responseBody.object).toBe("chat.completion");
      expect(responseBody.model).toBe("exa-search");
      const choices = responseBody.choices as Array<Record<string, unknown>>;
      expect(choices).toHaveLength(1);
      const message = choices[0]?.message as Record<string, unknown>;
      expect(typeof message.content).toBe("string");
      const content = message.content as string;
      expect(content).toContain("[Bun](https://bun.sh)");
      expect(content).toContain("Summary: JS runtime");
      expect(content).toContain("Highlights: fast");
    } finally {
      restore();
    }
  });

  test("returns no-results-found when upstream returns empty results", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const body = JSON.stringify({ requestId: "r2", results: [], resolvedSearchType: "neural", costDollars: { total: 0, search: {} } });
    const restore = stubFetch(capture, new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const output = await adapter.call(makeRequest());
      expect(output.mode).toBe("non_stream");
      if (output.mode !== "non_stream") throw new Error("expected non_stream");
      const message = (output.body.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown>;
      expect(message.content).toBe("No results found.");
    } finally {
      restore();
    }
  });

  test("maps upstream error status to a typed ProviderAdapterError", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, new Response(JSON.stringify({ error: "bad request" }), { status: 400, headers: { "content-type": "application/json" } }));
    try {
      const error = await adapter.call(makeRequest()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect((error as ProviderAdapterError).kind).toBe("invalid_request");
    } finally {
      restore();
    }
  });
});

describe("ExaAdapter — call streaming happy path", () => {
  test("emits message_start, text_delta, and message_stop from SSE result chunks", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const chunk1 = `data: ${JSON.stringify({ type: "result", result: { title: "Result One", url: "https://one.example", id: "r1", summary: "First result" } })}\n\n`;
    const chunk2 = `data: ${JSON.stringify({ type: "result", result: { title: "Result Two", url: "https://two.example", id: "r2", highlights: ["second"] } })}\n\n`;
    const chunk3 = `data: ${JSON.stringify({ type: "done" })}\n\n`;
    const restore = stubFetchQueue(capture, sseResponse([chunk1, chunk2, chunk3]));
    try {
      const input = makeRequest({ request: request({ stream: true }) });
      const output = await adapter.call(input);
      expect(output.mode).toBe("stream");
      if (output.mode !== "stream") throw new Error("expected stream");

      const headers = capture.init.headers as Record<string, string>;
      expect(headers["accept"]).toBe("text/event-stream");

      const events = await collectEvents(output.events);
      const types = events.map((e) => e.type);
      expect(types).toContain("message_start");
      expect(types.filter((t) => t === "text_delta").length).toBeGreaterThanOrEqual(1);
      expect(types[types.length - 1]).toBe("message_stop");

      const startEvent = events.find((e) => e.type === "message_start");
      expect(startEvent).toBeDefined();
      if (startEvent?.type === "message_start") {
        expect(startEvent.id).toContain("exa-");
      }

      const textDeltas = events.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
      expect(textDeltas[0]?.text).toContain("[Result One](https://one.example)");
      expect(textDeltas[0]?.text).toContain("First result");
      expect(textDeltas[1]?.text).toContain("[Result Two](https://two.example)");
    } finally {
      restore();
    }
  });

  test("emits message_stop on [DONE] sentinel", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchQueue(capture, sseResponse(["data: [DONE]\n\n"]));
    try {
      const input = makeRequest({ request: request({ stream: true }) });
      const output = await adapter.call(input);
      expect(output.mode).toBe("stream");
      if (output.mode !== "stream") throw new Error("expected stream");
      const events = await collectEvents(output.events);
      const last = events[events.length - 1];
      expect(last?.type).toBe("message_stop");
    } finally {
      restore();
    }
  });
});

describe("ExaAdapter — numResults from tool schema", () => {
  test("extracts numResults default from exa_search tool schema", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, new Response(JSON.stringify({ requestId: "r", results: [], resolvedSearchType: "neural", costDollars: { total: 0, search: {} } }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const input = makeRequest({
        request: request({
          tools: [{
            name: "exa_search",
            description: "Exa web search",
            inputSchema: {
              type: "object",
              properties: {
                numResults: { type: "number", default: 5 },
              },
            },
          }],
        }),
      });
      await adapter.call(input);
      const sentBody = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(sentBody.numResults).toBe(5);
    } finally {
      restore();
    }
  });

  test("defaults to 10 when numResults is absent from schema", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetch(capture, new Response(JSON.stringify({ requestId: "r", results: [], resolvedSearchType: "neural", costDollars: { total: 0, search: {} } }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const input = makeRequest({
        request: request({
          tools: [{
            name: "exa_search",
            description: "Exa web search",
            inputSchema: { type: "object", properties: {} },
          }],
        }),
      });
      await adapter.call(input);
      const sentBody = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(sentBody.numResults).toBe(10);
    } finally {
      restore();
    }
  });
});

describe("ExaAdapter — cost chunk usage emission", () => {
  test("emits a usage event when a cost chunk arrives in the stream", async () => {
    const adapter = new ExaAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const costChunk = `data: ${JSON.stringify({ type: "cost", costDollars: { total: 0.01 } })}\n\n`;
    const doneChunk = `data: ${JSON.stringify({ type: "done" })}\n\n`;
    const restore = stubFetchQueue(capture, sseResponse([costChunk, doneChunk]));
    try {
      const input = makeRequest({ request: request({ stream: true }) });
      const output = await adapter.call(input);
      expect(output.mode).toBe("stream");
      if (output.mode !== "stream") throw new Error("expected stream");
      const events = await collectEvents(output.events);
      const usageEvent = events.find((e) => e.type === "usage");
      expect(usageEvent).toBeDefined();
    } finally {
      restore();
    }
  });
});
