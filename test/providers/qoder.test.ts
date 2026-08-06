import { describe, expect, test } from "bun:test";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest, StreamEvent } from "../../src/domain/contracts";
import { ProviderAdapterError } from "../../src/providers/shared";
import { QODER_CHAT_URL, QODER_MODEL_CONFIGS, QoderAdapter, encodeQoderBody, qoderModelCatalog } from "../../src/providers/qoder";

const QODER_JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "qmodel_latest",
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

const emptyNetwork: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function providerRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "qoder", modelId: "qmodel_latest", upstreamModelId: "qmodel_latest", surface: "openai-chat" },
    request: request(),
    credential: "pat-secret",
    network: emptyNetwork,
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------- fetch stubbing

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

function exchangeOkResponse(): Response {
  return new Response(JSON.stringify({ id: "u1", name: "tester", securityOauthToken: "sot-1", refreshToken: "rt-1", userType: "personal_standard" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
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

/** Builds a Qoder envelope SSE frame. `bodyJson` may contain literal newlines (pretty-printed chunks). */
function qoderFrame(bodyJson: string, statusCodeValue: number | undefined = 200): string {
  const envelope = statusCodeValue === undefined ? { body: bodyJson } : { statusCodeValue, body: bodyJson };
  return `data: ${JSON.stringify(envelope)}\n\n`;
}

function chunk(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 123,
    model: "qmodel_latest",
    choices: [{ index: 0, delta: { content: "" }, finish_reason: null }],
    ...overrides,
  });
}

function contentChunk(content: string): string {
  return chunk({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
}

function finishChunk(finishReason: string): string {
  return chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
}

function usageChunk(): string {
  return chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
}

const STREAM_FRAMES: string[] = [
  qoderFrame(contentChunk("Hel")),
  qoderFrame(contentChunk("lo")),
  qoderFrame(usageChunk()),
  qoderFrame(finishChunk("stop")),
  qoderFrame("[DONE]"),
];

// ---------------------------------------------------------------- body decoding

const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const REVERSE_ALPHABET = new Map<string, string>();
for (let i = 0; i < STANDARD_ALPHABET.length; i++) REVERSE_ALPHABET.set(QODER_ALPHABET[i]!, STANDARD_ALPHABET[i]!);

/** Inverse of encodeQoderBody — reorders and maps the custom alphabet back to base64. */
function decodeQoderBody(bytes: Uint8Array): string {
  const mapped = Buffer.from(bytes).toString("latin1");
  let reordered = "";
  for (const char of mapped) reordered += char === "$" ? "=" : (REVERSE_ALPHABET.get(char) ?? char);
  const third = Math.floor(reordered.length / 3);
  const base64 = reordered.slice(reordered.length - third) + reordered.slice(third, reordered.length - third) + reordered.slice(0, third);
  return Buffer.from(base64, "base64").toString("utf8");
}

function chatBodyFrom(captures: CapturedCall[]): Record<string, unknown> {
  return JSON.parse(decodeQoderBody(captures[1]!.init.body as Uint8Array)) as Record<string, unknown>;
}

async function collectEvents(output: Awaited<ReturnType<QoderAdapter["call"]>>): Promise<StreamEvent[]> {
  expect(output.mode).toBe("stream");
  if (output.mode !== "stream") return [];
  const events: StreamEvent[] = [];
  for await (const event of output.events) events.push(event);
  return events;
}

// ---------------------------------------------------------------- tests

describe("QoderAdapter", () => {
  const adapter = new QoderAdapter();

  test("metadata, catalog, and static configs match the legacy identity", () => {
    expect(adapter.metadata).toMatchObject({ id: "qoder", displayName: "Qoder", protocol: "openai", credentialKind: "api_key" });
    const ids = adapter.models.list.map((m) => m.id);
    expect(ids).toEqual(["auto", "ultimate", "performance", "efficient", "lite", "qmodel", "qmodel_latest", "qmodel_preview", "dmodel", "dfmodel", "gm51model", "kmodel", "mmodel", "kmodel_latest"]);
    expect(qoderModelCatalog).toHaveLength(14);
    expect(Object.keys(QODER_MODEL_CONFIGS)).toHaveLength(14);
    expect(QODER_MODEL_CONFIGS["qmodel_latest"]?.max_input_tokens).toBe(1000000);
    expect(QODER_MODEL_CONFIGS["kmodel_latest"]?.is_reasoning).toBe(false);
    expect(adapter.capabilities.surfaces).toEqual(["openai-chat"]);
    expect(adapter.capabilities.streaming).toBe(true);
  });

  test("resolves catalog models and rejects unknown models and surfaces", () => {
    expect(adapter.resolveTarget("kmodel_latest", "openai-chat")).toEqual({ providerId: "qoder", modelId: "kmodel_latest", upstreamModelId: "kmodel_latest", surface: "openai-chat" });
    expect(adapter.resolveTarget("qmodel", "openai-chat")).toEqual({ providerId: "qoder", modelId: "qmodel", upstreamModelId: "qmodel", surface: "openai-chat" });
    expect(() => adapter.resolveTarget("not-a-qoder-model", "openai-chat")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("auto", "images")).toThrow(ProviderAdapterError);
  });

  test("guards empty credential and wrong surface before any fetch", async () => {
    const captures = stubFetchQueue(exchangeOkResponse());
    try {
      await expect(adapter.call(providerRequest({ credential: "" }))).rejects.toThrow(/personal access token/i);
      await expect(
        adapter.call(providerRequest({ target: { providerId: "qoder", modelId: "auto", upstreamModelId: "auto", surface: "images" as const } })),
      ).rejects.toThrow(ProviderAdapterError);
      expect(captures).toHaveLength(0);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("maps PAT exchange auth failure to a typed account error", async () => {
    const captures = stubFetchQueue(new Response("denied", { status: 401 }));
    try {
      const error = await adapter.call(providerRequest()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect((error as ProviderAdapterError).kind).toBe("authentication_failed");
      expect((error as ProviderAdapterError).statusCode).toBe(401);
      expect((error as ProviderAdapterError).routeScope).toBe("account");
      expect(captures).toHaveLength(1);
      expect(captures[0]!.url).toBe(QODER_JOB_TOKEN_URL);
      const mapped = adapter.mapError(error);
      expect(mapped).toMatchObject({ kind: "authentication_failed", routeScope: "account", statusCode: 401 });
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("rejects malformed PAT exchange responses with provider_protocol_error", async () => {
    for (const body of ["<html>not json</html>", "[]", JSON.stringify({ id: "u1" })]) {
      const captures = stubFetchQueue(new Response(body, { status: 200 }));
      try {
        const error = await adapter.call(providerRequest()).catch((e: unknown) => e);
        expect((error as ProviderAdapterError).kind).toBe("provider_protocol_error");
        expect(captures).toHaveLength(1);
      } finally {
        (globalThis.fetch as unknown as { __restore: () => void }).__restore();
      }
    }
  });

  test("performs the PAT exchange then posts the encoded COSY-signed chat request", async () => {
    const captures = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      const output = await adapter.call(providerRequest());
      const events = await collectEvents(output);
      expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "text_delta", "usage", "message_stop"]);
      expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["Hel", "lo"]);
      expect(events.at(-1)).toMatchObject({ type: "message_stop", reason: "completed" });

      // Exchange call: job-token URL, static COSY headers, encoded body carrying the PAT.
      expect(captures).toHaveLength(2);
      const exchange = captures[0]!;
      expect(exchange.url).toBe(QODER_JOB_TOKEN_URL);
      const exchangeHeaders = exchange.init.headers as Record<string, string>;
      expect(exchangeHeaders.appcode).toBe("cosy");
      expect(exchangeHeaders["login-version"]).toBe("v2");
      expect(exchangeHeaders.signature).toMatch(/^[0-9a-f]{32}$/);
      expect(exchangeHeaders["cosy-machinetoken"]).toBe(exchangeHeaders["cosy-machineid"]);
      const exchangeBody = JSON.parse(decodeQoderBody(exchange.init.body as Uint8Array)) as Record<string, unknown>;
      expect(JSON.parse(exchangeBody.payload as string)).toMatchObject({ personalToken: "pat-secret" });

      // Chat call: COSY bearer, body hash/length, identity, and model headers.
      const chat = captures[1]!;
      expect(chat.url).toBe(QODER_CHAT_URL);
      const chatHeaders = chat.init.headers as Record<string, string>;
      expect(chatHeaders.authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/);
      expect(chatHeaders["cosy-user"]).toBe("u1");
      expect(chatHeaders["cosy-bodyhash"]).toMatch(/^[0-9a-f]{32}$/);
      expect(chatHeaders["cosy-sigpath"]).toBe("/api/v2/service/pro/sse/agent_chat_generation");
      expect(chatHeaders["x-model-key"]).toBe("qmodel_latest");
      expect(chatHeaders["x-model-source"]).toBe("system");
      expect(chatHeaders.accept).toBe("text/event-stream");
      expect(chatHeaders["cosy-machineid"]).toBe(exchangeHeaders["cosy-machinetoken"]);
      expect(chatHeaders["cosy-bodylength"]).toBe(String((chat.init.body as Uint8Array).byteLength));

      // Request shaping: OpenAI-shaped envelope with flattened messages and stable ids.
      const body = chatBodyFrom(captures);
      expect(body.stream).toBe(true);
      expect((body.model_config as Record<string, unknown>).key).toBe("qmodel_latest");
      expect((body.model_config as Record<string, unknown>).source).toBe("system");
      expect((body.parameters as Record<string, unknown>).max_tokens).toBe(32768);
      expect(body.messages).toEqual([{ role: "user", content: "Hello", contents: [{ type: "text", text: "Hello" }] }]);
      expect((body.chat_context as Record<string, unknown>).text).toBe("Hello");
      expect((body.business as Record<string, unknown>).product).toBe("cli");
      expect(typeof body.session_id).toBe("string");
      expect(typeof body.chat_record_id).toBe("string");
      expect(body.session_id).toHaveLength(16);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("shapes system, developer, tool, and max-token inputs onto the wire", async () => {
    const captures = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(
        providerRequest({
          request: request({
            stream: false,
            maxOutputTokens: 100,
            messages: [
              { role: "system", content: [{ type: "text", text: "You are helpful." }] },
              { role: "developer", content: [{ type: "text", text: "Follow the plan." }] },
              { role: "user", content: [{ type: "text", text: "Hi" }] },
              { role: "assistant", content: [{ type: "text", text: "Howdy" }] },
              { role: "tool", content: [{ type: "tool_result", text: "42", toolCallId: "call_1" }] },
            ],
            tools: [{ name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
          }),
        }),
      );
      const body = chatBodyFrom(captures);
      expect(body.system).toBe("You are helpful.\n\nFollow the plan.");
      expect(body.messages).toEqual([
        { role: "user", content: "Hi", contents: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: "Howdy", contents: [{ type: "text", text: "Howdy" }] },
        { role: "tool", content: "42", contents: [{ type: "text", text: "42" }], tool_call_id: "call_1" },
      ]);
      expect(body.tools).toEqual([
        { type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
      ]);
      expect((body.parameters as Record<string, unknown>).max_tokens).toBe(100);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("keeps session and record ids stable for identical user+model+conversation", async () => {
    const first = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(providerRequest());
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
    const second = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(providerRequest());
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
    const third = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(providerRequest({ request: request({ messages: [{ role: "user", content: [{ type: "text", text: "Different" }] }] }) }));
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
    const firstBody = chatBodyFrom(first);
    const secondBody = chatBodyFrom(second);
    const thirdBody = chatBodyFrom(third);
    expect(secondBody.session_id).toBe(firstBody.session_id);
    expect(secondBody.chat_record_id).toBe(firstBody.chat_record_id);
    // Changed conversation changes the record id but not the user+model session id.
    expect(thirdBody.session_id).toBe(firstBody.session_id);
    expect(thirdBody.chat_record_id).not.toBe(firstBody.chat_record_id);
  });

  test("uses a stable per-PAT machine id across calls and different ids for different PATs", async () => {
    const first = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(providerRequest());
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
    const second = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(providerRequest());
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
    const other = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      await adapter.call(providerRequest({ credential: "another-pat" }));
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
    const headers = (captures: CapturedCall[]) => captures[0]!.init.headers as Record<string, string>;
    expect(headers(second)["cosy-machinetoken"]).toBe(headers(first)["cosy-machinetoken"]);
    expect(headers(other)["cosy-machinetoken"]).not.toBe(headers(first)["cosy-machinetoken"]);
  });

  test("materializes the stream into a chat.completion body for non-stream clients", async () => {
    const captures = stubFetchQueue(exchangeOkResponse(), sseResponse(STREAM_FRAMES));
    try {
      const output = await adapter.call(providerRequest({ request: request({ stream: false }) }));
      expect(output.mode).toBe("non_stream");
      if (output.mode !== "non_stream") return;
      expect(output.body.object).toBe("chat.completion");
      expect(output.body.model).toBe("qmodel_latest");
      expect((output.body.choices as Record<string, unknown>[])[0]).toMatchObject({
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "Hello" },
      });
      expect(output.body.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      expect(output.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      // The exchange is followed by exactly one chat call.
      expect(captures).toHaveLength(2);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("materializes tool calls into the non-stream body with a tool_calls finish reason", async () => {
    const frames = [
      qoderFrame(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] })),
      qoderFrame(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] })),
      qoderFrame(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }] })),
      qoderFrame(finishChunk("tool_calls")),
      qoderFrame("[DONE]"),
    ];
    const captures = stubFetchQueue(exchangeOkResponse(), sseResponse(frames));
    try {
      const output = await adapter.call(providerRequest({ request: request({ stream: false }) }));
      expect(output.mode).toBe("non_stream");
      if (output.mode !== "non_stream") return;
      const choice = (output.body.choices as Record<string, unknown>[])[0]!;
      expect(choice).toMatchObject({ finish_reason: "tool_calls" });
      expect((choice.message as Record<string, unknown>).tool_calls).toEqual([
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
      ]);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("maps upstream chat HTTP errors through the shared error mapper", async () => {
    const captures = stubFetchQueue(exchangeOkResponse(), new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }), { status: 429 }));
    try {
      const error = await adapter.call(providerRequest()).catch((e: unknown) => e);
      expect((error as ProviderAdapterError).kind).toBe("provider_rate_limited");
      expect((error as ProviderAdapterError).statusCode).toBe(429);
      expect((error as ProviderAdapterError).retryable).toBe(true);
      expect(captures).toHaveLength(2);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("throws a typed error when an envelope carries a non-200 status code", async () => {
    const frames = [qoderFrame(contentChunk("partial")), qoderFrame(contentChunk(""), 401), qoderFrame("[DONE]")];
    const captures = stubFetchQueue(exchangeOkResponse(), sseResponse(frames));
    try {
      const output = await adapter.call(providerRequest());
      const error = await collectEvents(output).catch((e: unknown) => e);
      expect((error as ProviderAdapterError).kind).toBe("authentication_failed");
      expect((error as ProviderAdapterError).statusCode).toBe(401);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("skips malformed and telemetry envelopes while preserving valid chunks", async () => {
    const frames = [
      "data: this is not json\n\n",
      qoderFrame(contentChunk("A")),
      "data: {\"totalDuration\":1234}\n\n",
      qoderFrame(contentChunk("B")),
      qoderFrame("[DONE]"),
    ];
    const captures = stubFetchQueue(exchangeOkResponse(), sseResponse(frames));
    try {
      const events = await collectEvents(await adapter.call(providerRequest()));
      expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["A", "B"]);
      expect(events.at(-1)).toMatchObject({ type: "message_stop" });
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("sanitizes pretty-printed chunk JSON inside envelopes without losing content", async () => {
    // The envelope embeds the chunk JSON with real newlines (single-escaped),
    // which must be collapsed before re-emitting the SSE frame.
    const prettyChunk = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 123,
      model: "qmodel_latest",
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
    }, null, 2);
    const frames = [qoderFrame(prettyChunk), qoderFrame("[DONE]")];
    const captures = stubFetchQueue(exchangeOkResponse(), sseResponse(frames));
    try {
      const events = await collectEvents(await adapter.call(providerRequest()));
      expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["Hi"]);
    } finally {
      (globalThis.fetch as unknown as { __restore: () => void }).__restore();
    }
  });

  test("encodes and decodes the request body with Qoder's reordered alphabet", () => {
    for (const plaintext of ["", "abc", "hello world", '{"a":1,"b":"x"}', "ünïcode ✓ emoji 🎉", "a".repeat(300)]) {
      const encoded = encodeQoderBody(plaintext);
      expect(Buffer.from(encoded).toString("latin1")).not.toContain("=");
      expect(decodeQoderBody(encoded)).toBe(plaintext);
    }
  });
});
