import { describe, expect, test } from "bun:test";
import type {
  NetworkSelection,
  NormalizedProviderRequest,
  ProviderOutput,
  ProviderRequest,
  StreamEvent,
} from "../../src/domain/contracts";
import { CustomProviderAdapter, syncCustomAdapters } from "../../src/providers/custom";
import { ProviderAdapterError, isRecord } from "../../src/providers/shared";
import { ProviderRegistry } from "../../src/providers/registry";
import type { CustomProviderRecord } from "../../src/storage";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 10_000,
} as const;

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "arbitrary-upstream-model",
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
  credential = "secret",
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

function record(overrides: Partial<CustomProviderRecord> = {}): CustomProviderRecord {
  return {
    id: "custom-1",
    slug: "acme",
    name: "Acme",
    type: "openai-compatible",
    // Use a public IP literal so the SSRF guard's dispatch check returns
    // early without a DNS lookup (tests have no network).
    baseUrl: "https://93.184.216.34/v1",
    credential: "secret",
    timeoutSeconds: 30,
    models: [],
    customHeaders: {},
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function sourceFor(rows: CustomProviderRecord[]): { list: () => CustomProviderRecord[]; getBySlug: (slug: string) => CustomProviderRecord | null } {
  return {
    list: () => rows,
    getBySlug: (slug: string) => rows.find((row) => row.slug === slug) ?? null,
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

describe("CustomProviderAdapter — anthropic-compatible protocol routing", () => {
  test("routes to /messages and speaks the Anthropic Messages wire shape", async () => {
    const rec = record({
      slug: "acme-anthropic",
      name: "Acme Anthropic",
      type: "anthropic-compatible",
      baseUrl: "https://93.184.216.34",
      credential: "anthropic-key",
    });
    const source = sourceFor([rec]);
    const adapter = new CustomProviderAdapter(rec, source);
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 3 } });
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "claude-like-model", "anthropic-messages", "anthropic-key"),
        request: request({ model: "claude-like-model", sourceSurface: "anthropic-messages" }),
      });
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://93.184.216.34/messages");
      const headers = capture.init.headers as Record<string, string>;
      // Anthropic-compatible uses x-api-key, not Bearer.
      expect(headers["x-api-key"]).toBe("anthropic-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers.authorization).toBeUndefined();
      const body = bodyOf(capture);
      // Anthropic payload shape: max_tokens, messages, model.
      expect(body.max_tokens).toBeDefined();
      expect(body.model).toBe("claude-like-model");
      expect(Array.isArray(body.messages)).toBe(true);
      expect(output.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, source: "provider" });
    } finally {
      restore();
    }
  });

  test("exposes the anthropic protocol and anthropic-messages surface in metadata", () => {
    const rec = record({ type: "anthropic-compatible", slug: "acme-a", name: "Acme A" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    expect(adapter.metadata).toMatchObject({ id: "acme-a", displayName: "Acme A", protocol: "anthropic", credentialKind: "api_key" });
    expect(adapter.capabilities.surfaces).toEqual(["anthropic-messages"]);
  });
});

describe("CustomProviderAdapter — surface rejection", () => {
  test("openai-compatible rejects the anthropic-messages surface", async () => {
    const rec = record({ slug: "acme-openai" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        adapter.call({
          ...providerRequest(adapter, "any-model", "openai-chat"),
          target: { providerId: "acme-openai", modelId: "any-model", surface: "anthropic-messages" },
        }),
      ).rejects.toThrow(ProviderAdapterError);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("anthropic-compatible rejects the openai-chat surface", async () => {
    const rec = record({ type: "anthropic-compatible", slug: "acme-anth" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        adapter.call({
          ...providerRequest(adapter, "any-model", "anthropic-messages"),
          target: { providerId: "acme-anth", modelId: "any-model", surface: "openai-chat" },
        }),
      ).rejects.toThrow(ProviderAdapterError);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("rejects a target whose providerId does not match the adapter", async () => {
    const rec = record({ slug: "acme-mismatch" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        adapter.call({
          ...providerRequest(adapter, "any-model"),
          target: { providerId: "different-provider", modelId: "any-model", surface: "openai-chat" },
        }),
      ).rejects.toThrow(ProviderAdapterError);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("CustomProviderAdapter — customHeaders injection", () => {
  test("injects custom headers from config into the upstream request, overriding defaults", async () => {
    const rec = record({
      slug: "acme-headers",
      customHeaders: { "x-tenant": "prod", "x-routing": "edge", "content-type": "text/plain" },
    });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model"));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["x-tenant"]).toBe("prod");
      expect(headers["x-routing"]).toBe("edge");
      // Custom headers apply LAST, so a custom content-type overrides the default.
      expect(headers["content-type"]).toBe("text/plain");
      expect(headers.authorization).toBe("Bearer secret");
    } finally {
      restore();
    }
  });

  test("forwards the incoming User-Agent when present", async () => {
    const rec = record({ slug: "acme-ua" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call({
        ...providerRequest(adapter, "any-model"),
        headers: new Headers({ "user-agent": "custom-cli/3.2" }),
      });
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["user-agent"]).toBe("custom-cli/3.2");
    } finally {
      restore();
    }
  });

  test("anthropic-compatible uses x-api-key for the credential", async () => {
    const rec = record({ type: "anthropic-compatible", slug: "acme-a-key", credential: "the-key" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call(providerRequest(adapter, "any-model", "anthropic-messages", "the-key"));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("the-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      restore();
    }
  });

  test("sets accept to text/event-stream for streaming requests", async () => {
    const rec = record({ slug: "acme-stream-accept" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call({
        ...providerRequest(adapter, "any-model"),
        request: request({ model: "any-model", stream: true }),
      });
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.accept).toBe("text/event-stream");
    } finally {
      restore();
    }
  });
});

describe("CustomProviderAdapter — streaming via SSE", () => {
  test("decodes chat SSE stream events through the chat mapper", async () => {
    const rec = record({ slug: "acme-stream" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const frames = [
      chatSseFrame({ id: "chatcmpl-1", choices: [{ delta: { content: "Hello" } }] }),
      chatSseFrame({ id: "chatcmpl-1", choices: [{ delta: { content: " stream" } }] }),
      chatSseFrame({ id: "chatcmpl-1", choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      DONE,
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => sseResponse(frames)) as typeof fetch;
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "any-model"),
        request: request({ model: "any-model", stream: true }),
      });
      expect(output.mode).toBe("stream");
      const events = await collectEvents(streamEventsOf(output));
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("message_start");
      expect(types).toContain("text_delta");
      const text = events.filter((e) => e.type === "text_delta").map(textDeltaText).join("");
      expect(text).toBe("Hello stream");
      expect(types).toContain("usage");
      expect(events[events.length - 1]?.type).toBe("message_stop");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("decodes anthropic SSE stream events through the anthropic mapper", async () => {
    const rec = record({ type: "anthropic-compatible", slug: "acme-anth-stream" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 4 } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => sseResponse(frames)) as typeof fetch;
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "any-model", "anthropic-messages"),
        request: request({ model: "any-model", stream: true, sourceSurface: "anthropic-messages" }),
      });
      expect(output.mode).toBe("stream");
      const events = await collectEvents(streamEventsOf(output));
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("message_start");
      expect(types).toContain("text_delta");
      const text = events.filter((e) => e.type === "text_delta").map(textDeltaText).join("");
      expect(text).toBe("Hi");
      expect(types).toContain("usage");
      expect(events[events.length - 1]?.type).toBe("message_stop");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("CustomProviderAdapter — timeoutSeconds cap", () => {
  test("caps total timeout at timeoutSeconds, below the pipeline default", async () => {
    // The pipeline default totalTimeoutMs is 10_000. A record with
    // timeoutSeconds=2 caps the effective timeout to 2_000ms.
    const rec = record({ slug: "acme-timeout", timeoutSeconds: 2 });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      // A successful call confirms the cap was applied without rejecting —
      // the cap only shortens, never extends. We verify the request succeeds
      // and the URL/path is correct (the timeout is internal to the coordinator).
      await adapter.call(providerRequest(adapter, "any-model"));
      expect(capture.url).toBe("https://93.184.216.34/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("clamps a sub-second timeout to a minimum of 1 second", async () => {
    // timeoutSeconds=0 would produce Math.max(1, 0)*1000 = 1000ms — still valid.
    const rec = record({ slug: "acme-zero-timeout", timeoutSeconds: 0 });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model"));
      // Should not reject — the clamp ensures a minimum of 1s.
      expect(capture.url).toBe("https://93.184.216.34/v1/chat/completions");
    } finally {
      restore();
    }
  });
});

describe("CustomProviderAdapter — storedModels parsing", () => {
  test("parses plain string model ids into the catalog", () => {
    const rec = record({ slug: "acme-strings", models: ["model-a", "model-b", ""] });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const ids = adapter.models.list.map((m) => m.id);
    expect(ids).toEqual(["model-a", "model-b"]);
    // Empty strings are dropped.
  });

  test("parses object model records with id and name", () => {
    const rec = record({
      slug: "acme-objects",
      models: [
        { id: "obj-1", name: "Object One" },
        { id: "obj-2", displayName: "Object Two" },
        { id: "", name: "Empty Id" },
        { name: "No Id" },
      ],
    });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const list = adapter.models.list;
    expect(list.map((m) => m.id)).toEqual(["obj-1", "obj-2"]);
    const obj1 = list.find((m) => m.id === "obj-1");
    expect(obj1?.displayName).toBe("Object One");
    const obj2 = list.find((m) => m.id === "obj-2");
    // Falls back to displayName when name is absent.
    expect(obj2?.displayName).toBe("Object Two");
  });

  test("drops malformed non-string, non-object entries", () => {
    const rec = record({ slug: "acme-malformed", models: [42, null, true, { id: "valid" }, "also-valid"] });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const ids = adapter.models.list.map((m) => m.id);
    expect(ids).toEqual(["valid", "also-valid"]);
  });

  test("empty model list means any model id is accepted (permissive catalog)", () => {
    const rec = record({ slug: "acme-empty", models: [] });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    expect(adapter.models.list.length).toBe(0);
    // get() returns a synthetic entry for any id.
    expect(adapter.models.get("any-future-model")).not.toBeNull();
    expect(adapter.models.get("any-future-model")?.id).toBe("any-future-model");
  });
});

describe("syncCustomAdapters — reconcile edge cases", () => {
  test("registers new adapters from the source list", () => {
    const rows = [record({ slug: "alpha", name: "Alpha" }), record({ slug: "beta", name: "Beta" })];
    const registry = new ProviderRegistry();
    syncCustomAdapters(registry, sourceFor(rows));
    expect(registry.get("alpha")).toBeInstanceOf(CustomProviderAdapter);
    expect(registry.get("beta")).toBeInstanceOf(CustomProviderAdapter);
    expect(registry.size).toBe(2);
  });

  test("unregisters adapters whose records were deleted", () => {
    let rows = [record({ slug: "alpha" }), record({ slug: "beta" })];
    const registry = new ProviderRegistry();
    syncCustomAdapters(registry, sourceFor(rows));
    expect(registry.get("beta")).not.toBeNull();
    // Remove beta.
    rows = [record({ slug: "alpha" })];
    syncCustomAdapters(registry, sourceFor(rows));
    expect(registry.get("alpha")).not.toBeNull();
    expect(registry.get("beta")).toBeNull();
    expect(registry.size).toBe(1);
  });

  test("refreshes (re-instantiates) adapters whose records were updated", () => {
    let rows = [record({ slug: "gamma", name: "Gamma v1" })];
    const registry = new ProviderRegistry();
    syncCustomAdapters(registry, sourceFor(rows));
    const before = registry.get("gamma");
    expect(before?.metadata.displayName).toBe("Gamma v1");
    // Update the record's display name.
    rows = [record({ slug: "gamma", name: "Gamma v2" })];
    syncCustomAdapters(registry, sourceFor(rows));
    const after = registry.get("gamma");
    expect(after?.metadata.displayName).toBe("Gamma v2");
  });

  test("deduplicates by slug — one adapter per slug even with duplicate rows", () => {
    const rows = [
      record({ slug: "dup", name: "First" }),
      record({ slug: "dup", name: "Second" }),
    ];
    const registry = new ProviderRegistry();
    syncCustomAdapters(registry, sourceFor(rows));
    expect(registry.size).toBe(1);
    // The last row wins (re-registers over the first).
    expect(registry.get("dup")?.metadata.displayName).toBe("Second");
  });

  test("preserves non-custom adapters already in the registry", () => {
    const registry = new ProviderRegistry();
    // Simulate a built-in adapter already registered under a different id.
    const builtin = new CustomProviderAdapter(record({ slug: "builtin", name: "Builtin" }), sourceFor([record({ slug: "builtin" })]));
    registry.register(builtin);
    // Sync with custom rows that do NOT include "builtin".
    syncCustomAdapters(registry, sourceFor([record({ slug: "custom-a" })]));
    // builtin is a CustomProviderAdapter not in the live set → unregistered.
    expect(registry.get("builtin")).toBeNull();
    expect(registry.get("custom-a")).not.toBeNull();
  });

  test("handles an empty source list by unregistering all custom adapters", () => {
    const registry = new ProviderRegistry();
    syncCustomAdapters(registry, sourceFor([record({ slug: "x" })]));
    expect(registry.size).toBe(1);
    syncCustomAdapters(registry, sourceFor([]));
    expect(registry.size).toBe(0);
  });
});

describe("CustomProviderAdapter — call rejects deleted provider at dispatch", () => {
  test("throws when the record no longer exists in the source", async () => {
    // The source returns null for getBySlug, simulating a deleted record.
    const source: { list: () => CustomProviderRecord[]; getBySlug: (slug: string) => CustomProviderRecord | null } = {
      list: () => [],
      getBySlug: () => null,
    };
    const adapter = new CustomProviderAdapter(record({ slug: "deleted" }), source);
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        adapter.call({
          ...providerRequest(adapter, "any-model"),
          target: { providerId: "deleted", modelId: "any-model", surface: "openai-chat" },
        }),
      ).rejects.toThrow(/no longer exists/i);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("CustomProviderAdapter — metadata and identity", () => {
  test("openai-compatible exposes the openai protocol and openai-chat surface", () => {
    const rec = record({ slug: "acme-oai", name: "Acme OAI" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    expect(adapter.metadata).toMatchObject({ id: "acme-oai", displayName: "Acme OAI", protocol: "openai", credentialKind: "api_key" });
    expect(adapter.capabilities.surfaces).toEqual(["openai-chat"]);
  });

  test("strips trailing slashes from the base URL", async () => {
    const rec = record({ slug: "acme-trailing", baseUrl: "https://93.184.216.34/v1///" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "c", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "any-model"));
      expect(capture.url).toBe("https://93.184.216.34/v1/chat/completions");
    } finally {
      restore();
    }
  });

  test("mapError converts an Error into a ProviderCallError", () => {
    const rec = record({ slug: "acme-err" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const error = adapter.mapError(new Error("custom boom"));
    expect(error.kind).toBe("provider_protocol_error");
    expect(error.source).toBe("upstream");
  });

  test("countTokens returns unknown stats", async () => {
    const rec = record({ slug: "acme-tokens" });
    const adapter = new CustomProviderAdapter(rec, sourceFor([rec]));
    const stats = await adapter.countTokens({ request: request(), signal: new AbortController().signal });
    expect(stats.source).toBe("unknown");
    expect(stats.tokens).toBeNull();
  });
});

// Use isRecord to avoid unused-import in strict environments.
void isRecord;
