import { describe, expect, test } from "bun:test";

import type { CanonicalEvent, CanonicalMessage, CanonicalStopReason, UsageRecord } from "../../../src/transport/canonical-model";
import { MessagesAdapter } from "../../../src/transport/surface/messages/adapter";
import { MessagesStreamEncoder } from "../../../src/transport/surface/messages/stream";
import { MessagesLedgerError } from "../../../src/transport/surface/messages/errors";
import { applyMessagesToolLedger } from "../../../src/transport/surface/messages/parse";
import { canonicalToClaudeMessagesPayload } from "../../../src/protocol/request/messages";

const adapter = new MessagesAdapter();

const usage: UsageRecord = {
  input_tokens: 12,
  cached_input_tokens: 2,
  cache_write_tokens: 0,
  uncached_input_tokens: 10,
  output_tokens: 7,
  reasoning_tokens: 3,
  estimated_cost: 0.01,
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-4-6-sonnet",
    max_tokens: 4096,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("MessagesAdapter.parse", () => {
  test("parses string and block-array system prompts plus text, image, and document blocks", () => {
    const parsed = adapter.parse(
      request({
        system: [
          { type: "text", text: "system" },
          { type: "image", source: { type: "base64", data: "opaque" } },
          { type: "document", source: { data: "opaque" } },
        ],
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ],
      }),
    );
    expect(parsed.system?.[0]).toEqual({ kind: "text", text: "system" });
    expect(parsed.system?.[1]).toMatchObject({ kind: "image" });
    expect(parsed.system?.[2]).toMatchObject({ kind: "document", data: "opaque" });
    expect(parsed.messages[1]?.content).toEqual([{ kind: "text", text: "answer" }]);
  });

  test("hoists a mid-message system turn into the top-level system field", () => {
    // Claude Code v2.1.274 sends its environment/context turn as
    // `role: "system"` inside `messages[]`; providers only accept system
    // content at the top level, so it must be hoisted, not rejected.
    const parsed = adapter.parse(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "system", content: [{ type: "text", text: "# Environment" }] },
        ],
      }),
    );
    expect(parsed.system).toEqual([{ kind: "text", text: "# Environment" }]);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe("user");
  });

  test("appends mid-message system turns after a declared system prompt, in order", () => {
    const parsed = adapter.parse(
      request({
        system: "declared",
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "system", content: "second" },
        ],
      }),
    );
    expect(parsed.system).toEqual([
      { kind: "text", text: "declared" },
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("normalizes Anthropic document, audio, and refusal blocks into typed content", () => {
    const parsed = adapter.parse(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: "pdf" } },
              { type: "audio", source: { type: "base64", media_type: "audio/mpeg", data: "audio" } },
              { type: "refusal", refusal: "blocked" },
            ],
          },
        ],
      }),
    );
    expect(parsed.messages[0]?.content).toEqual([
      // `source_type` is retained so a base64/url/file document survives a
      // cross-wire round trip instead of being flattened into inline bytes.
      { kind: "document", data: "pdf", media_type: "application/pdf", source_type: "base64" },
      { kind: "audio", data: "audio", media_type: "audio/mpeg" },
      { kind: "refusal", text: "blocked" },
    ]);
  });

  test("parses all tool and server block kinds without merging IDs", () => {
    const parsed = adapter.parse(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-a", name: "lookup", input: { key: "a" } },
              { type: "tool_use", id: "tool-b", name: "lookup", input: { key: "b" } },
              {
                type: "server_tool_use",
                id: "server-1",
                name: "web_search",
                input: { query: "x" },
              },
              { type: "search_result", tool_use_id: "server-1", results: [{ title: "result" }] },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-a",
                content: [{ type: "text", text: "a" }],
              },
              { type: "tool_result", tool_use_id: "tool-b", content: "b", is_error: true },
            ],
          },
        ],
      }),
    );
    expect(parsed.messages[0]?.content.slice(0, 2)).toEqual([
      { kind: "toolCall", call_id: "tool-a", name: "lookup", arguments: { key: "a" } },
      { kind: "toolCall", call_id: "tool-b", name: "lookup", arguments: { key: "b" } },
    ]);
    expect(parsed.messages[0]?.content[2]).toMatchObject({
      kind: "extension",
      name: "server_tool_use",
      payload: { id: "server-1" },
    });
    expect(parsed.messages[0]?.content[3]).toMatchObject({
      kind: "extension",
      name: "search_result",
    });
    expect(parsed.messages[1]?.content[0]).toMatchObject({ kind: "toolResult", call_id: "tool-a" });
    expect(parsed.messages[1]?.content[1]).toMatchObject({
      kind: "toolResult",
      call_id: "tool-b",
      is_error: true,
    });
  });

  test("preserves visible thinking summaries, signatures, and redacted opaque payloads", () => {
    const parsed = adapter.parse(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "short summary", signature: "sig-opaque" },
              { type: "redacted_thinking", data: "do-not-inspect" },
            ],
          },
        ],
      }),
    );
    expect(parsed.messages[0]?.content[0]).toEqual({
      kind: "reasoning",
      payload: "short summary",
      summary: "short summary",
      signature: "sig-opaque",
    });
    expect(parsed.messages[0]?.content[1]).toEqual({
      kind: "reasoning",
      payload: { type: "redacted_thinking", data: "do-not-inspect" },
      opaque: true,
    });
  });

  test("normalizes required limits, sampling, stops, tool choice, metadata and AI SDK spellings", () => {
    const body = request({
      temperature: 0.3,
      topP: 0.8,
      topK: 32,
      stopSequences: ["DONE"],
      disableParallelToolUse: true,
      toolChoice: { type: "tool", name: "lookup" },
      metadata: { userId: "user-1" },
      sendReasoning: true,
      toolStreaming: true,
      structuredOutputMode: "json_schema",
      stream: true,
      container: { id: "cont-1" },
      inference_geo: "us",
      service_tier: "standard_only",
      user_profile_id: "up-1",
      workspace_id: "ws-1",
      tools: [{ name: "lookup", description: "desc", inputSchema: { type: "object" } }],
    });
    delete body.max_tokens;
    body.maxTokens = 2048;
    const parsed = adapter.parse(body);
    expect(parsed.generation_controls).toMatchObject({
      temperature: 0.3,
      top_p: 0.8,
      top_k: 32,
      stop: ["DONE"],
      max_tokens: 2048,
      parallel_tool_calls: false,
    });
    expect(parsed.generation_controls["extension:metadata_user_id"]).toBe("user-1");
    expect(parsed.generation_controls["extension:service_tier"]).toBe("standard_only");
    expect(parsed.generation_controls["extension:container"]).toEqual({ id: "cont-1" });
    expect(parsed.generation_controls["extension:inference_geo"]).toBe("us");
    expect(parsed.generation_controls["extension:user_profile_id"]).toBe("up-1");
    expect(parsed.generation_controls["extension:workspace_id"]).toBe("ws-1");
    expect(parsed.tools?.[0]).toMatchObject({ name: "lookup", jsonSchema: { type: "object" } });
    expect(parsed.tool_choice).toEqual({ type: "tool", name: "lookup" });
    expect(parsed.stream).toBe(true);
  });

  test("forwards container, inference geo, service tier, and profile ids on the Messages wire", () => {
    const body = request({
      service_tier: "standard_only",
      container: { id: "cont-1" },
      inference_geo: "us",
      user_profile_id: "up-1",
      workspace_id: "ws-1",
    });
    const payload = canonicalToClaudeMessagesPayload(adapter.parse(body));
    expect(payload.service_tier).toBe("standard_only");
    expect(payload.container).toEqual({ id: "cont-1" });
    expect(payload.inference_geo).toBe("us");
    expect(payload.user_profile_id).toBe("up-1");
    expect(payload.workspace_id).toBe("ws-1");
  });

  test("records top-level automatic and per-block cache intent", () => {
    const automatic = adapter.parse(
      request({ cache_control: { type: "ephemeral" }, system: "stable" }),
    );
    expect(automatic.cache_hint).toBe("stable_prefix");
    const explicit = adapter.parse(
      request({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
          },
        ],
      }),
    );
    expect(explicit.cache_hint).toEqual({ kind: "breakpoint", list: [0] });
  });

  test("validates manual/adaptive/disabled thinking and generation-specific budget rules", () => {
    expect(
      adapter.parse(request({ thinking: { type: "enabled", budget_tokens: 1024 } })).reasoning,
    ).toMatchObject({ thinking_type: "enabled", budget_tokens: 1024 });
    expect(
      adapter.parse(request({ thinking: { type: "enabled", budget_tokens: 4096 } }), {
        headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
      }),
    ).toMatchObject({ reasoning: { budget_tokens: 4096 } });
    expect(
      adapter.parse(request({ thinking: { type: "adaptive" } }), { modelGeneration: "4.7" })
        .reasoning,
    ).toEqual({ thinking_type: "adaptive" });
    expect(adapter.parse(request({ thinking: { type: "disabled" } })).reasoning).toEqual({
      thinking_type: "disabled",
    });
    expect(() =>
      adapter.parse(request({ thinking: { type: "enabled", budget_tokens: 1000 } })),
    ).toThrow();
    expect(() =>
      adapter.parse(request({ thinking: { type: "enabled", budget_tokens: 1024 } }), {
        modelGeneration: "4.7",
      }),
    ).toThrow();
  });

  test("rejects missing required fields and preserves unknown blocks as extensions", () => {
    expect(() => adapter.parse({ model: "m", messages: [] })).toThrow(/max_tokens/);
    const parsed = adapter.parse(
      request({ messages: [{ role: "user", content: [{ type: "future_block", value: 1 }] }] }),
    );
    expect(parsed.messages[0]?.content[0]).toEqual({
      kind: "extension",
      name: "messages:future_block",
      payload: { type: "future_block", value: 1 },
    });
  });
});

describe("MessagesAdapter.encode", () => {
  const events: CanonicalEvent[] = [
    { type: "message_start", sequence_number: 1, event_id: "msg-1", model: "claude" },
    { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "hello" } },
    {
      type: "content_delta",
      sequence_number: 3,
      content: { kind: "reasoning", payload: "summary", summary: "summary", signature: "sig" },
    },
    {
      type: "content_delta",
      sequence_number: 4,
      content: {
        kind: "reasoning",
        payload: { type: "redacted_thinking", data: "opaque" },
        opaque: true,
      },
    },
    {
      type: "tool_call_delta",
      sequence_number: 5,
      call_id: "call-1",
      name: "lookup",
      arguments_delta: '{"x":1}',
    },
    { type: "terminal", sequence_number: 6, state: "complete", stop_reason: "tool_use", usage },
  ];

  test("encodes non-streaming content, tool use, thinking signatures and usage", () => {
    const response = adapter.encode(events, {
      response_id: "msg-1",
      model: "claude",
    });
    if (response.type !== "message") throw new Error("expected a Messages response");
    expect(response).toMatchObject({
      id: "msg-1",
      type: "message",
      model: "claude",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
        output_tokens: 7,
        output_tokens_details: { thinking_tokens: 3 },
      },
    });
    expect(response.content.map((part) => part.type)).toEqual([
      "text",
      "thinking",
      "redacted_thinking",
      "tool_use",
    ]);
    expect(response.content[1]).toMatchObject({ thinking: "summary", signature: "sig" });
    expect(response.content[2]).toEqual({ type: "redacted_thinking", data: "opaque" });
    expect(response.content[3]).toMatchObject({ id: "call-1", name: "lookup", input: { x: 1 } });
  });

  test("drops foreign extensions instead of emitting rejectable block types", () => {
    const withExtensions: CanonicalEvent[] = [
      { type: "message_start", sequence_number: 1, event_id: "msg-1", model: "claude" },
      { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "hi" } },
      {
        type: "content_delta",
        sequence_number: 3,
        content: {
          kind: "extension",
          name: "responses:response.output_text.annotation.added",
          payload: { type: "response.output_text.annotation.added" },
        },
      },
      {
        type: "content_delta",
        sequence_number: 4,
        content: { kind: "extension", name: "audio", payload: { data: "x" } },
      },
      {
        type: "content_delta",
        sequence_number: 5,
        content: {
          kind: "extension",
          name: "messages:container",
          payload: { type: "container", id: "ctr-1" },
        },
      },
      { type: "terminal", sequence_number: 6, state: "complete", stop_reason: "stop", usage },
    ];
    const response = adapter.encode(withExtensions, {
      response_id: "msg-1",
      model: "claude",
    });
    if (response.type !== "message") throw new Error("expected a Messages response");
    expect(response.content.map((part) => part.type)).toEqual(["text", "container"]);
  });

  test("emits complete ordered lifecycle and puts thinking usage on final message_delta only", () => {
    const encoder = new MessagesStreamEncoder({ response_id: "msg-1", model: "claude" });
    const response = events.flatMap((event) => encoder.push(event));
    expect(response.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // `message_start` opens before the encoder has seen any usage: the
    // canonical decoder folds upstream usage into the terminal event
    // (`protocol/response/messages.ts`), so an incremental encoder has nothing
    // to report yet and opens with the zeroed shape.
    expect(response[0]).toMatchObject({
      type: "message_start",
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    });
    // The complete accounting — input side included — lands on the final
    // `message_delta`, the only event that can carry it.
    expect(response.at(-2)).toMatchObject({
      type: "message_delta",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2,
        output_tokens: 7,
        output_tokens_details: { thinking_tokens: 3 },
      },
    });
  });

  test("maps canonical stop reasons to Anthropic stop reasons", () => {
    const expected: Record<CanonicalStopReason, string> = {
      stop: "end_turn",
      length: "max_tokens",
      tool_use: "tool_use",
      content_filter: "refusal",
      refusal: "refusal",
      error: "end_turn",
      cancelled: "end_turn",
      pause_turn: "pause_turn",
    };
    for (const stop_reason of Object.keys(expected) as CanonicalStopReason[]) {
      const expectedReason = expected[stop_reason];
      const encoded = adapter.encode([
        { type: "terminal", sequence_number: 1, state: "complete", stop_reason },
      ]);
      expect(encoded.stop_reason).toBe(expectedReason);
    }
  });

  test("defaults a complete terminal without a stop reason to end_turn", () => {
    const encoded = adapter.encode([{ type: "terminal", sequence_number: 1, state: "complete" }]);
    expect(encoded.stop_reason).toBe("end_turn");
  });

  test("a tool call whose name arrives late keeps its arguments and real name", () => {
    // Anthropic streams `input_json_delta` fragments that can precede the
    // name. The call must reach the wire under its real name with its
    // arguments intact — never under a fabricated placeholder.
    const encoded = adapter.encode([
      {
        type: "tool_call_delta",
        sequence_number: 1,
        call_id: "call-1",
        arguments_delta: '{"city":',
      },
      { type: "tool_call_delta", sequence_number: 2, call_id: "call-1", name: "lookup" },
      { type: "tool_call_delta", sequence_number: 3, call_id: "call-1", arguments_delta: '"Jakarta"}' },
      { type: "terminal", sequence_number: 4, state: "complete", stop_reason: "tool_use" },
    ]);
    const content = encoded.content as ReadonlyArray<Record<string, unknown>>;
    const toolUse = content.find((part) => part["type"] === "tool_use");
    expect(toolUse).toMatchObject({
      type: "tool_use",
      id: "call-1",
      name: "lookup",
      input: { city: "Jakarta" },
    });
  });

  test("drops a call the upstream never named instead of failing the response", () => {
    // `tool_use.name` is mandatory and the client resolves it against the
    // tools it has, so a placeholder name would surface as a confusing
    // "unknown tool" rejection. The call is therefore dropped — but the
    // response itself survives, with the stop reason downgraded so the client
    // never sees a `tool_use` stop it cannot act on.
    const encoded = adapter.encode([
      {
        type: "tool_call_delta",
        sequence_number: 1,
        call_id: "call-1",
        arguments_delta: "{}",
      },
      { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "tool_use" },
    ]);
    expect(encoded.content).toEqual([]);
    expect(encoded.stop_reason).toBe("end_turn");
  });

  test("keeps a named call while dropping only the unnamed sibling", () => {
    const encoded = adapter.encode([
      { type: "tool_call_delta", sequence_number: 1, call_id: "named", name: "lookup", arguments_delta: '{"x":1}' },
      { type: "tool_call_delta", sequence_number: 2, call_id: "nameless", arguments_delta: "{}" },
      { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "tool_use" },
    ]);
    const content = encoded.content as ReadonlyArray<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "tool_use", id: "named", name: "lookup" });
    // A real call survives, so the tool_use stop reason stays accurate.
    expect(encoded.stop_reason).toBe("tool_use");
  });

  test("streaming withholds fragments until the name arrives, then sends them intact", () => {
    // Production streaming goes through `MessagesStreamEncoder` (see
    // `dispatch/stream-bridge.ts`), not `groupedBlocks`. It must not open the
    // `tool_use` block early under a placeholder: fragments are parked and
    // emitted once named, so the client sees one call with its real name and
    // complete arguments.
    const encoder = new MessagesStreamEncoder({ response_id: "msg-1", model: "claude" });
    const events = [
      { type: "tool_call_delta", sequence_number: 1, call_id: "call-1", arguments_delta: '{"city":' },
      { type: "tool_call_delta", sequence_number: 2, call_id: "call-1", name: "lookup" },
      { type: "tool_call_delta", sequence_number: 3, call_id: "call-1", arguments_delta: '"Jakarta"}' },
      { type: "terminal", sequence_number: 4, state: "complete", stop_reason: "tool_use" },
    ] as const;
    const out = events.flatMap((event) => encoder.push(event as CanonicalEvent));

    // The block must not exist before the name does: the first delta is parked.
    const starts = out.filter((event) => event.type === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      content_block: { type: "tool_use", id: "call-1", name: "lookup" },
    });

    // And the arguments arrive whole, in one delta.
    const partials = out
      .filter((event) => event.type === "content_block_delta")
      .map((event) => (event.delta as { partial_json?: string }).partial_json ?? "");
    expect(partials.join("")).toBe('{"city":"Jakarta"}');
  });

  test("streaming collapses two spellings of one call id into a single block", () => {
    // Some backends deliver one call under `fc_<suffix>` and then continue it
    // under `call_<suffix>`. `toolIdentityKey` is the one place that prefix is
    // interpreted, so both spellings must reach the client as one `tool_use`
    // block — otherwise an agent performs the same action twice.
    const encoder = new MessagesStreamEncoder({ response_id: "msg-1", model: "claude" });
    const events = [
      { type: "tool_call_delta", sequence_number: 1, call_id: "fc_abc", name: "lookup", arguments_delta: '{"city":' },
      { type: "tool_call_delta", sequence_number: 2, call_id: "call_abc", arguments_delta: '"Jakarta"}' },
      { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "tool_use" },
    ] as const;
    const out = events.flatMap((event) => encoder.push(event as CanonicalEvent));

    const starts = out.filter((event) => event.type === "content_block_start");
    expect(starts).toHaveLength(1);
    // The id the client is handed is the first spelling, which the backend
    // really sent, so replaying it upstream addresses the same call.
    expect(starts[0]).toMatchObject({
      content_block: { type: "tool_use", id: "fc_abc", name: "lookup" },
    });

    // Both fragments land in that one block, in order.
    const partials = out
      .filter((event) => event.type === "content_block_delta")
      .map((event) => (event.delta as { partial_json?: string }).partial_json ?? "");
    expect(partials.join("")).toBe('{"city":"Jakarta"}');
    expect(out.filter((event) => event.type === "content_block_stop")).toHaveLength(1);
  });

  test("streaming keeps genuinely distinct call ids in separate blocks", () => {
    // The collapse above must not over-merge: two calls whose suffixes differ
    // are two calls, and each keeps its own block and its own arguments.
    const encoder = new MessagesStreamEncoder({ response_id: "msg-1", model: "claude" });
    const events = [
      { type: "tool_call_delta", sequence_number: 1, call_id: "call_a", name: "one", arguments_delta: '{"n":1}' },
      { type: "tool_call_delta", sequence_number: 2, call_id: "call_b", name: "two", arguments_delta: '{"n":2}' },
      { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "tool_use" },
    ] as const;
    const out = events.flatMap((event) => encoder.push(event as CanonicalEvent));

    const starts = out.filter((event) => event.type === "content_block_start");
    expect(starts.map((event) => (event.content_block as { id?: string }).id)).toEqual([
      "call_a",
      "call_b",
    ]);
    const partials = out
      .filter((event) => event.type === "content_block_delta")
      .map((event) => (event.delta as { partial_json?: string }).partial_json ?? "");
    expect(partials).toEqual(['{"n":1}', '{"n":2}']);
  });

  test("streaming drops a call the upstream never named without killing the stream", () => {
    const encoder = new MessagesStreamEncoder({ response_id: "msg-1", model: "claude" });
    // Fragments alone are parked, not emitted under a placeholder.
    const parked = encoder.push({
      type: "tool_call_delta",
      sequence_number: 1,
      call_id: "call-1",
      arguments_delta: "{}",
    });
    expect(parked.some((event) => event.type === "content_block_start")).toBe(false);

    // The terminal flush drops the inexpressible call; the stream still ends
    // cleanly with a coherent `end_turn` rather than throwing mid-response
    // (which turned a 57-second stream into a bare 500).
    const terminal = encoder.push({
      type: "terminal",
      sequence_number: 2,
      state: "complete",
      stop_reason: "tool_use",
    });
    expect(terminal.some((event) => event.type === "content_block_start")).toBe(false);
    expect(terminal.at(-1)).toMatchObject({ type: "message_stop" });
    expect(terminal.at(-2)).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
  });
});

const call = (call_id: string, name = "lookup") => ({
  kind: "toolCall" as const,
  call_id,
  name,
  arguments: {},
});
const result = (call_id: string, text: string, is_error = false) => ({
  kind: "toolResult" as const,
  call_id,
  content: [{ kind: "text" as const, text }],
  ...(is_error ? { is_error: true as const } : {}),
});

function kinds(messages: readonly CanonicalMessage[]): string[][] {
  return messages.map((message) => message.content.map((part) => part.kind));
}

describe("MessagesToolLedger", () => {
  test("places interleaved results directly after the matching assistant tool use", () => {
    const input: CanonicalMessage[] = [
      { role: "user", content: [{ kind: "text", text: "start" }] },
      { role: "assistant", content: [call("a"), call("b")] },
      {
        role: "user",
        content: [{ kind: "text", text: "free" }, result("b", "b-result"), result("a", "a-result")],
      },
    ];
    const output = applyMessagesToolLedger(input);
    expect(kinds(output)).toEqual([
      ["text"],
      ["toolCall", "toolCall"],
      ["toolResult", "toolResult"],
      ["text"],
    ]);
    expect(
      output[2]?.content.map((part) => (part.kind === "toolResult" ? part.call_id : part.kind)),
    ).toEqual(["a", "b"]);
  });

  test("keeps multiple parallel calls separate and preserves every ID", () => {
    const output = applyMessagesToolLedger([
      { role: "assistant", content: [call("a"), call("b"), call("c")] },
      { role: "user", content: [result("c", "c"), result("a", "a"), result("b", "b")] },
    ]);
    const results = output
      .flatMap((message) => message.content)
      .filter((part) => part.kind === "toolResult");
    expect(results.map((part) => part.call_id)).toEqual(["a", "b", "c"]);
  });

  test("puts all tool results before free text and preserves text in a separate trailing message", () => {
    const output = applyMessagesToolLedger([
      { role: "user", content: [result("a", "result"), { kind: "text", text: "after" }] },
      { role: "assistant", content: [call("a")] },
    ]);
    expect(output[0]?.content[0]?.kind).toBe("toolResult");
    expect(output[1]?.content).toEqual([{ kind: "text", text: "after" }]);
  });

  test("omits unresolved server-tool results and suppresses directly-invoked trailing text", () => {
    const output = applyMessagesToolLedger([
      {
        role: "assistant",
        content: [
          call("client"),
          { kind: "extension", name: "server_tool_use", payload: { id: "server" } },
        ],
      },
      {
        role: "user",
        content: [
          result("client", "ok"),
          result("server", "server output"),
          { kind: "text", text: "must not trail" },
        ],
      },
    ]);
    const parts = output.flatMap((message) => message.content);
    expect(parts.some((part) => part.kind === "toolResult" && part.call_id === "server")).toBe(
      false,
    );
    expect(parts.some((part) => part.kind === "text" && part.text === "must not trail")).toBe(
      false,
    );
    expect(parts.some((part) => part.kind === "toolResult" && part.call_id === "client")).toBe(
      true,
    );
  });

  test("passes error results through verbatim without changing IDs", () => {
    const output = applyMessagesToolLedger([
      { role: "assistant", content: [call("a")] },
      { role: "user", content: [result("a", "permission denied", true)] },
    ]);
    const part = output
      .flatMap((message) => message.content)
      .find((entry) => entry.kind === "toolResult");
    expect(part).toMatchObject({ kind: "toolResult", call_id: "a", is_error: true });
    // The original payload survives untouched: it is the diagnostic detail
    // a retry depends on, never rewritten into instructive prose.
    if (part?.kind === "toolResult") {
      expect(part.content).toEqual([{ kind: "text", text: "permission denied" }]);
    }
  });

  test("rejects missing and duplicate matches rather than repairing in another layer", () => {
    expect(() =>
      applyMessagesToolLedger([{ role: "user", content: [result("missing", "x")] }]),
    ).toThrow(MessagesLedgerError);
    expect(() =>
      applyMessagesToolLedger([
        { role: "assistant", content: [call("a")] },
        { role: "user", content: [result("a", "x"), result("a", "y")] },
      ]),
    ).toThrow(MessagesLedgerError);
  });
});
