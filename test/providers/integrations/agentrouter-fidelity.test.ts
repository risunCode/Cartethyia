/**
 * AgentRouter fidelity baseline.
 *
 * Pins the provider's observable behaviour — request wire bytes (the
 * canonical Claude Messages body field order plus the CLI-fingerprint header
 * contract), stop-reason mapping, and both response decode paths — through the
 * real `dispatch` boundary. The assertions were first recorded against the
 * bespoke implementation and then reconciled with the canonical Claude
 * Messages pieces (`buildClaudeMessagesRequest` + `sendClaudeMessagesRequest`);
 * every value that moved is justified in the accompanying change report.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENTROUTER_BASE_URL,
  createAgentRouterAdapter,
} from "../../../src/providers/integrations/agentrouter";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../../src/providers/provider-registry";

const encoder = new TextEncoder();

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** Stub upstream that records every request and answers from `build`. */
function captureFetch(build: () => Response): {
  readonly fetchFn: typeof fetch;
  readonly calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return build();
  }) as typeof fetch;
  return { fetchFn, calls };
}

function sseResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** One SSE body from raw `data:` payloads. */
function sseBody(frames: readonly string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join("");
}

function messagesRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "messages",
    ...overrides,
  } as CanonicalRequest;
}

function candidate(endpointPath = "/v1/messages?beta=true"): ProviderDispatchTarget {
  return {
    provider_id: "agentrouter",
    model_id: "claude-sonnet-4-5",
    wire_family: "messages",
    endpoint_path: endpointPath,
    capabilities: {},
  } as ProviderDispatchTarget;
}

function context(deadlineInMs = 5_000): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "agentrouter",
      credential_kind: "api_key",
      secret: encoder.encode("test-key"),
    },
    deadline: Date.now() + deadlineInMs,
    abort_signal: new AbortController().signal,
  } as ProviderDispatchContext;
}

async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** The final event of a drained dispatch. */
async function terminalOf(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent> {
  const collected = await collect(events);
  const terminal = collected.at(-1);
  if (terminal === undefined) throw new Error("dispatch yielded no events");
  return terminal;
}

/** Drives one stream whose only interesting frame is the stop reason. */
async function stopReasonTerminal(raw: string | undefined): Promise<CanonicalEvent> {
  const frames: string[] = [];
  if (raw !== undefined) {
    frames.push(JSON.stringify({ type: "message_delta", delta: { stop_reason: raw } }));
  }
  frames.push(JSON.stringify({ type: "message_stop" }));
  const { fetchFn } = captureFetch(() => sseResponse(sseBody(frames)));
  const adapter = createAgentRouterAdapter({ fetch: fetchFn });
  return terminalOf(adapter.dispatch(messagesRequest(), candidate(), context()));
}

// ---------------------------------------------------------------------------
// Request wire bytes
// ---------------------------------------------------------------------------

describe("agentrouter request wire bytes", () => {
  test("streaming body uses the canonical Claude Messages field order", async () => {
    const { fetchFn, calls } = captureFetch(() =>
      sseResponse(sseBody([JSON.stringify({ type: "message_stop" })])),
    );
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    await collect(adapter.dispatch(messagesRequest(), candidate(), context()));

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    // Canonical Claude Messages key order (`canonicalToClaudeMessagesPayload`),
    // shared with anthropic/kimi/claude-code. JSON objects are unordered per
    // RFC 8259, so the previous bespoke `reorderBody` ordering was not a wire
    // guarantee AgentRouter depended on; see the change report.
    expect(Object.keys(body)).toEqual([
      "model",
      "max_tokens",
      "messages",
      "stream",
      "stream_options",
    ]);
    expect(body["model"]).toBe("claude-sonnet-4-5");
    expect(body["stream"]).toBe(true);
  });

  test("non-streaming body uses the canonical Claude Messages field order", async () => {
    const { fetchFn, calls } = captureFetch(() =>
      jsonResponse({ content: [], stop_reason: "end_turn" }),
    );
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    await collect(adapter.dispatch(messagesRequest({ stream: false }), candidate(), context()));
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    // Canonical Claude Messages key order, as above.
    expect(Object.keys(body)).toEqual(["model", "max_tokens", "messages", "stream"]);
    expect(body["stream"]).toBe(false);
  });

  test("the model id comes from the dispatch candidate", async () => {
    const { fetchFn, calls } = captureFetch(() =>
      sseResponse(sseBody([JSON.stringify({ type: "message_stop" })])),
    );
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    await collect(
      adapter.dispatch(
        messagesRequest(),
        { ...candidate(), model_id: "override-model" } as ProviderDispatchTarget,
        context(),
      ),
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("override-model");
  });

  test("carries the AgentRouter CLI-fingerprint header contract", async () => {
    const { fetchFn, calls } = captureFetch(() =>
      sseResponse(sseBody([JSON.stringify({ type: "message_stop" })])),
    );
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    await collect(adapter.dispatch(messagesRequest(), candidate(), context()));

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe(
      "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24",
    );
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["x-app"]).toBe("cli");
    expect(headers["user-agent"]).toBe("claude-cli/2.1.195 (external, sdk-cli)");
    expect(headers["x-stainless-retry-count"]).toBe("0");
    expect(headers["x-stainless-timeout"]).toBe("600");
    expect(headers["x-stainless-lang"]).toBe("js");
    expect(headers["x-stainless-package-version"]).toBe("0.94.0");
    expect(headers["x-stainless-os"]).toBe("MacOS");
    expect(headers["x-stainless-arch"]).toBe("arm64");
    expect(headers["x-stainless-runtime"]).toBe("node");
    expect(headers["x-stainless-runtime-version"]).toBe("v24.3.0");
    expect(headers["accept"]).toBe("text/event-stream");
    expect(headers["accept-encoding"]).toBe("gzip, deflate, br, zstd");
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["x-claude-code-session-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("accept header reflects the non-streaming request", async () => {
    const { fetchFn, calls } = captureFetch(() =>
      jsonResponse({ content: [], stop_reason: "end_turn" }),
    );
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    await collect(adapter.dispatch(messagesRequest({ stream: false }), candidate(), context()));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/json");
  });

  test("URL resolution keeps the ?beta=true wire bytes", async () => {
    const defaultPath = captureFetch(() =>
      sseResponse(sseBody([JSON.stringify({ type: "message_stop" })])),
    );
    await collect(
      createAgentRouterAdapter({ fetch: defaultPath.fetchFn }).dispatch(
        messagesRequest(),
        candidate(),
        context(),
      ),
    );
    expect(defaultPath.calls[0]!.url).toBe(AGENTROUTER_BASE_URL);
    expect(defaultPath.calls[0]!.url.endsWith("/v1/messages?beta=true")).toBe(true);

    const canonicalPath = captureFetch(() =>
      sseResponse(sseBody([JSON.stringify({ type: "message_stop" })])),
    );
    await collect(
      createAgentRouterAdapter({ fetch: canonicalPath.fetchFn }).dispatch(
        messagesRequest(),
        candidate("/v1/messages"),
        context(),
      ),
    );
    expect(canonicalPath.calls[0]!.url).toBe(AGENTROUTER_BASE_URL);

    const overridePath = captureFetch(() =>
      sseResponse(sseBody([JSON.stringify({ type: "message_stop" })])),
    );
    await collect(
      createAgentRouterAdapter({ fetch: overridePath.fetchFn }).dispatch(
        messagesRequest(),
        candidate("/v1/other"),
        context(),
      ),
    );
    // Recorded verbatim: the override branch strips `?beta=true` off a base
    // URL that already carries the Messages path, so the path doubles up.
    // Pinned as-is so the refactor cannot silently change these wire bytes.
    expect(overridePath.calls[0]!.url).toBe(
      "https://agentrouter.org/v1/messages/v1/other?beta=true",
    );

    const absolutePath = captureFetch(() =>
      sseResponse(sseBody([JSON.stringify({ type: "message_stop" })])),
    );
    await collect(
      createAgentRouterAdapter({ fetch: absolutePath.fetchFn }).dispatch(
        messagesRequest(),
        candidate("https://mirror.example/v1/messages"),
        context(),
      ),
    );
    expect(absolutePath.calls[0]!.url).toBe("https://mirror.example/v1/messages");
  });
});

// ---------------------------------------------------------------------------
// Stop-reason mapping
// ---------------------------------------------------------------------------

describe("agentrouter stop-reason mapping", () => {
  // Canonical `mapClaudeStopReason`. `refusal`/`sensitive` now classify as
  // `error` and `model_context_window_exceeded` as `length`; both are strictly
  // more accurate than the old local mapper, which collapsed them to `stop`.
  const cases: readonly [string, string, string][] = [
    ["end_turn", "stop", "end_turn"],
    ["stop_sequence", "stop", "stop_sequence"],
    ["max_tokens", "length", "max_tokens"],
    ["tool_use", "tool_use", "tool_use"],
    ["refusal", "error", "refusal"],
    ["sensitive", "error", "sensitive"],
    ["pause_turn", "stop", "pause_turn"],
    ["model_context_window_exceeded", "length", "model_context_window_exceeded"],
    ["something_unknown", "stop", "something_unknown"],
  ];

  for (const [raw, expected, providerRaw] of cases) {
    test(`maps ${raw} -> ${expected}`, async () => {
      const terminal = await stopReasonTerminal(raw);
      expect(terminal).toMatchObject({
        type: "terminal",
        state: "complete",
        stop_reason: expected,
        provider_stop_reason: providerRaw,
      });
    });
  }

  test("omits the stop reason when the stream never reported one", async () => {
    const terminal = await stopReasonTerminal(undefined);
    // `canonicalTerminal` omits absent optionals rather than writing explicit
    // `undefined`, so the keys are absent from the envelope entirely.
    expect(Object.hasOwn(terminal, "stop_reason")).toBe(false);
    expect(Object.hasOwn(terminal, "provider_stop_reason")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stream decoding
// ---------------------------------------------------------------------------

describe("agentrouter stream decoding", () => {
  test("decodes a recorded Anthropic Messages SSE body", async () => {
    const body = sseBody([
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_01",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 7, output_tokens: 1 },
        },
      }),
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      }),
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      }),
      JSON.stringify({ type: "ping" }),
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      }),
      JSON.stringify({ type: "message_stop" }),
    ]);
    const { fetchFn } = captureFetch(() => sseResponse(body));
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    const events = await collect(adapter.dispatch(messagesRequest(), candidate(), context()));

    // The canonical stream decoder emits no start event: surface encoders
    // synthesize `message_start`/`response_start` from the request model (the
    // same contract anthropic, kimi, and claude-code rely on). The first event
    // is therefore the first content delta.
    expect(events[0]).toMatchObject({ type: "content_delta", sequence_number: 1 });
    expect(events.some((event) => event.type === "message_start" || event.type === "response_start")).toBe(false);
    const text = events
      .filter((event) => event.type === "content_delta")
      .map((event) => (event as { content: { kind: string; text?: string } }).content)
      .filter((content) => content.kind === "text")
      .map((content) => content.text)
      .join("");
    expect(text).toBe("Hello");
    expect(events.some((event) => event.type === "keepalive")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "terminal",
      state: "complete",
      stop_reason: "stop",
      provider_stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 2 },
    });
  });

  test("decodes tool_use blocks and input_json_delta fragments", async () => {
    const body = sseBody([
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      }),
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      }),
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"x"}' },
      }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      JSON.stringify({ type: "message_stop" }),
    ]);
    const { fetchFn } = captureFetch(() => sseResponse(body));
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    const events = await collect(adapter.dispatch(messagesRequest(), candidate(), context()));

    const toolEvents = events.filter((event) => event.type === "tool_call_delta") as Array<{
      call_id: string;
      name?: string;
      arguments_delta: string;
    }>;
    // The canonical decoder skips the empty `input: {}` placeholder (its own
    // comment: forwarding it "corrupts the concatenation"), so the fragments
    // concatenate to valid JSON rather than `{}{"q":"x"}`. This is the
    // corruption the shared decoder fixes; the repo pins the same contract in
    // `test/protocol/response/stream-truncation.test.ts`.
    expect(toolEvents[0]).toMatchObject({
      call_id: "toolu_1",
      name: "lookup",
      arguments_delta: '{"q":',
    });
    expect(toolEvents.map((event) => event.arguments_delta).join("")).toBe('{"q":"x"}');
    expect(toolEvents).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "terminal", stop_reason: "tool_use" });
  });

  test("decodes thinking deltas as reasoning content", async () => {
    const body = sseBody([
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "why" },
      }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      JSON.stringify({ type: "message_stop" }),
    ]);
    const { fetchFn } = captureFetch(() => sseResponse(body));
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    const events = await collect(adapter.dispatch(messagesRequest(), candidate(), context()));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "content_delta",
        content: { kind: "reasoning", payload: "why", summary: "why" },
      }),
    );
  });

  test("rejects a stream that ends before message_stop", async () => {
    const body = sseBody([
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      }),
    ]);
    const { fetchFn } = captureFetch(() => sseResponse(body));
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    // The canonical decoder treats a missing `message_stop` as a protocol
    // violation and rejects, rather than synthesizing a `state: "failed"`
    // terminal. Same contract as anthropic/kimi/claude-code.
    await expect(
      collect(adapter.dispatch(messagesRequest(), candidate(), context())),
    ).rejects.toMatchObject({ code: "platform_unavailable", status: 502, origin: "upstream" });
  });

  test("skips the [DONE] sentinel", async () => {
    const body = sseBody([
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      JSON.stringify({ type: "message_stop" }),
      "[DONE]",
    ]);
    const { fetchFn } = captureFetch(() => sseResponse(body));
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    const terminal = await terminalOf(adapter.dispatch(messagesRequest(), candidate(), context()));
    expect(terminal).toMatchObject({ type: "terminal", state: "complete", stop_reason: "stop" });
  });

  test("maps an upstream error frame through the shared stream-error mapper", async () => {
    const body = sseBody([
      JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
    ]);
    const { fetchFn } = captureFetch(() => sseResponse(body));
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    // The shared mapper defaults the status to 502 and classifies 5xx as
    // `platform_unavailable` (an upstream fault, not a client error).
    await expect(
      collect(adapter.dispatch(messagesRequest(), candidate(), context())),
    ).rejects.toMatchObject({ code: "platform_unavailable", status: 502 });
  });

  test("maps a non-2xx response through the upstream HTTP mapper", async () => {
    const { fetchFn } = captureFetch(
      () =>
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    await expect(
      collect(adapter.dispatch(messagesRequest(), candidate(), context())),
    ).rejects.toMatchObject({ status: 429 });
  });
});

// ---------------------------------------------------------------------------
// Non-stream decoding
// ---------------------------------------------------------------------------

describe("agentrouter non-stream decoding", () => {
  test("decodes a Messages JSON body", async () => {
    const { fetchFn } = captureFetch(() =>
      jsonResponse({
        id: "msg_02",
        type: "message",
        model: "claude-sonnet-4-5",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "toolu_2", name: "lookup", input: { q: "x" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    const adapter = createAgentRouterAdapter({ fetch: fetchFn });
    const events = await collect(
      adapter.dispatch(messagesRequest({ stream: false }), candidate(), context()),
    );

    // The canonical non-stream decoder opens with a `message_start` carrying
    // the upstream message id and model, which the surface encoders adopt as
    // the response id/model.
    expect(events[0]).toMatchObject({
      type: "message_start",
      event_id: "msg_02",
      model: "claude-sonnet-4-5",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "content_delta",
        content: { kind: "text", text: "Hello" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_call_delta",
        call_id: "toolu_2",
        name: "lookup",
        arguments_delta: '{"q":"x"}',
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "terminal",
      state: "complete",
      stop_reason: "tool_use",
      provider_stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  });
});
