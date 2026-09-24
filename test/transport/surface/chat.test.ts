import { describe, expect, test } from "bun:test";

import type { CanonicalEvent, UsageRecord } from "../../../src/transport/canonical-model";
import { ChatAdapter } from "../../../src/transport/surface/chat/adapter";
import { ChatStreamEncoder } from "../../../src/transport/surface/chat/encode";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { parseChatResponseToEvents } from "../../../src/protocol/response/chat";

const usage: UsageRecord = {
  input_tokens: 10,
  cached_input_tokens: 2,
  cache_write_tokens: "unavailable",
  uncached_input_tokens: 8,
  output_tokens: 4,
  reasoning_tokens: 1,
  estimated_cost: 0.01,
};

function decodeJson(output: { bytes: Uint8Array }): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(output.bytes)) as Record<string, unknown>;
}

/** Drive the production chat stream encoder and collect every wire chunk. */
function streamChunks(
  encoder: ChatStreamEncoder,
  source: readonly CanonicalEvent[],
): Record<string, unknown>[] {
  return [...source.flatMap((event) => encoder.push(event)), ...encoder.finish()];
}

describe("ChatAdapter.parse", () => {
  test("keeps history tool calls with missing arguments as zero-arg calls", () => {
    const adapter = new ChatAdapter();
    const request = adapter.parse({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "get_time" } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "noon" },
      ],
      stream: false,
    });
    const assistant = request.messages.find((m) => m.role === "assistant");
    const call = assistant?.content.find((p) => p.kind === "toolCall");
    // "{}" (not "") so the Anthropic Messages wire gets an object `input`
    // instead of a bare string it would 400 on.
    expect(call).toMatchObject({ kind: "toolCall", call_id: "call-1", name: "get_time", arguments: "{}" });
    // The paired result survives alongside it instead of orphaning.
    expect(
      request.messages.some(
        (m) =>
          m.role === "tool" &&
          m.content.some((p) => p.kind === "toolResult" && p.call_id === "call-1"),
      ),
    ).toBe(true);
  });

  test("keeps reasoning replayed from the messages and responses wires", () => {
    const adapter = new ChatAdapter();
    const request = adapter.parse({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "worked it out" },
            { type: "text", text: "42" },
          ],
          reasoning_content: "also reasoned",
        },
      ],
      stream: false,
    });
    const assistant = request.messages.find((m) => m.role === "assistant");
    const reasoning = assistant?.content.filter((p) => p.kind === "reasoning") ?? [];
    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((p) => (p.kind === "reasoning" ? p.summary : ""))).toEqual([
      "also reasoned",
      "worked it out",
    ]);
  });

  test("normalizes an explicitly empty tool-call argument string to {}", () => {
    const adapter = new ChatAdapter();
    const request = adapter.parse({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "get_time", arguments: "" } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "noon" },
      ],
      stream: false,
    });
    const assistant = request.messages.find((m) => m.role === "assistant");
    const call = assistant?.content.find((p) => p.kind === "toolCall");
    expect(call).toMatchObject({ arguments: "{}" });
  });

  test("parses sampling, stream, limits, stop, logging, service tier, user, metadata, and seed", () => {
    const adapter = new ChatAdapter();
    const request = adapter.parse({
      model: "gpt-chat",
      stream: true,
      messages: [
        { role: "system", content: "system instruction" },
        { role: "developer", content: [{ type: "text", text: "developer instruction" }] },
        { role: "user", content: "hello" },
      ],
      stream_options: { include_usage: true, include_obfuscation: true },
      temperature: 0.2,
      top_p: 0.8,
      n: 2,
      stop: ["END", "DONE"],
      max_tokens: 32,
      max_completion_tokens: 24,
      parallel_tool_calls: false,
      service_tier: "priority",
      user: "user-1",
      metadata: { trace: "trace-1" },
      logprobs: true,
      top_logprobs: 4,
      seed: 7,
      frequency_penalty: 0.5,
      presence_penalty: -0.2,
      logit_bias: { "123": 1 },
      prompt_cache_options: { mode: "explicit" },
      prompt_cache_retention: "24h",
      unknown_field: "must not be copied",
    });

    expect(request).toMatchObject({
      model: "gpt-chat",
      stream: true,
      source_surface: "chat",
      system: [{ kind: "text", text: "system instruction" }],
      instructions: [{ kind: "text", text: "developer instruction" }],
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {
        temperature: 0.2,
        top_p: 0.8,
        n: 2,
        stop: ["END", "DONE"],
        max_tokens: 32,
        max_completion_tokens: 24,
        parallel_tool_calls: false,
        service_tier: "priority",
        logprobs: true,
        top_logprobs: 4,
        seed: 7,
        "extension:include_usage": true,
        "extension:include_obfuscation": true,
        "extension:user": "user-1",
        "extension:metadata": { trace: "trace-1" },
        "extension:frequency_penalty": 0.5,
        "extension:presence_penalty": -0.2,
        "extension:logit_bias": { "123": 1 },
        "extension:prompt_cache_options": { mode: "explicit" },
        "extension:prompt_cache_retention": "24h",
      },
    });
    expect(request.generation_controls).not.toHaveProperty("unknown_field");
  });

  test("forwards penalty, token-bias, and cache-retention knobs on the chat wire", () => {
    const adapter = new ChatAdapter();
    const request = adapter.parse({
      model: "gpt-chat",
      messages: [{ role: "user", content: "hi" }],
      frequency_penalty: 0.5,
      presence_penalty: -0.2,
      logit_bias: { "123": 1 },
      prompt_cache_options: { mode: "explicit" },
      prompt_cache_retention: "24h",
    });
    const payload = canonicalToChatPayload(request);
    expect(payload["frequency_penalty"]).toBe(0.5);
    expect(payload["presence_penalty"]).toBe(-0.2);
    expect(payload["logit_bias"]).toEqual({ "123": 1 });
    expect(payload["prompt_cache_options"]).toEqual({ mode: "explicit" });
    expect(payload["prompt_cache_retention"]).toBe("24h");
  });

  test("parses the caller omit flag and top_p/logprobs sampling knobs", () => {
    const adapter = new ChatAdapter();
    const request = adapter.parse({
      model: "gpt-chat",
      messages: [{ role: "user", content: "hi" }],
      top_p: 0.9,
      logprobs: true,
      top_logprobs: 5,
      omit_encrypted_reasoning: true,
    });
    expect(request.generation_controls["top_p"]).toBe(0.9);
    expect(request.generation_controls["logprobs"]).toBe(true);
    expect(request.generation_controls["top_logprobs"]).toBe(5);
    expect(request.generation_controls["extension:omit_encrypted_reasoning"]).toBe(true);
    const payload = canonicalToChatPayload(request);
    expect(payload["top_p"]).toBe(0.9);
    expect(payload["logprobs"]).toBe(true);
    expect(payload["top_logprobs"]).toBe(5);
  });

  test("carries upstream system_fingerprint through to the public response", () => {
    const events = parseChatResponseToEvents(
      {
        id: "chatcmpl-1",
        model: "gpt-chat",
        system_fingerprint: "fp_abc123",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        model: "gpt-chat",
        messages: [],
        generation_controls: {},
        stream: false,
        source_surface: "chat",
      },
    );
    const json = decodeJson(new ChatAdapter().encode(events)) as Record<string, unknown>;
    expect(json["system_fingerprint"]).toBe("fp_abc123");
  });
  test("normalizes supported token limits without inventing invalid values", () => {
    const adapter = new ChatAdapter();
    expect(
      adapter.parse({ model: "m", messages: [], max_tokens: 12 }).generation_controls,
    ).toMatchObject({ max_tokens: 12 });
    expect(
      adapter.parse({ model: "m", messages: [], max_completion_tokens: 18 }).generation_controls,
    ).toMatchObject({
      max_completion_tokens: 18,
    });
    expect(
      adapter.parse({ model: "m", messages: [], max_tokens: -1, max_completion_tokens: Number.NaN })
        .generation_controls,
    ).toEqual({});
  });

  test("accepts structured outputs and reasoning aliases", () => {
    const adapter = new ChatAdapter();
    expect(
      adapter.parse({ model: "m", messages: [], response_format: { type: "json_object" } })
        .response_format,
    ).toEqual({
      type: "json_object",
    });
    expect(
      adapter.parse({
        model: "m",
        messages: [],
        response_format: {
          type: "json_schema",
          json_schema: { schema: { type: "object" }, strict: true },
        },
        reasoning_effort: "high",
      }),
    ).toMatchObject({
      response_format: { type: "json_schema", schema: { type: "object" }, strict: true },
      reasoning: { effort: "high" },
    });
    expect(adapter.parse({ model: "m", messages: [], reasoning_level: "low" }).reasoning).toEqual({
      effort: "low",
    });
  });

  test("preserves assistant tool calls and independently correlates parallel tool results", () => {
    const adapter = new ChatAdapter();
    const request = adapter.parse({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-a",
              type: "function",
              function: { name: "lookup", arguments: '{"key":"a"}' },
            },
            {
              id: "call-b",
              type: "function",
              function: { name: "lookup", arguments: '{"key":"b"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-b", content: "b-result" },
        { role: "tool", tool_call_id: "call-a", content: [{ type: "text", text: "a-result" }] },
      ],
    });

    expect(request.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: "call-a",
            name: "lookup",
            arguments: '{"key":"a"}',
            index: 0,
          },
          {
            kind: "toolCall",
            call_id: "call-b",
            name: "lookup",
            arguments: '{"key":"b"}',
            index: 1,
          },
        ],
      },
      { role: "tool", content: [{ kind: "toolResult", call_id: "call-b", content: "b-result" }] },
      {
        role: "tool",
        content: [
          { kind: "toolResult", call_id: "call-a", content: [{ kind: "text", text: "a-result" }] },
        ],
      },
    ]);
  });

  test("parses SurfaceInput JSON bytes and rejects malformed content parts", () => {
    const adapter = new ChatAdapter();
    const body = new TextEncoder().encode(
      JSON.stringify({ model: "m", messages: [{ role: "user", content: "ok" }], future: true }),
    );
    const request = adapter.parse({ headers: {}, path: "/v1/chat/completions", body });
    expect(request.model).toBe("m");
    expect(request.messages[0]?.content).toEqual([{ kind: "text", text: "ok" }]);
    expect(adapter.parse(null)).toMatchObject({ model: "", messages: [], source_surface: "chat" });
    expect(adapter.matchesBodyShape({ messages: [{ role: "user", content: "ok" }] })).toBe(true);
    expect(adapter.matchesBodyShape({ input: [], messages: [{ role: "user" }] })).toBe(false);
  });
});

describe("ChatAdapter.encode", () => {
  const events: CanonicalEvent[] = [
    { type: "response_start", sequence_number: 1, model: "gpt-chat", event_id: "response-event" },
    { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "Hello" } },
    { type: "content_delta", sequence_number: 3, content: { kind: "text", text: " world" } },
    { type: "terminal", sequence_number: 4, state: "complete", stop_reason: "stop", usage },
  ];

  test("emits stable identity and non-streaming completion JSON", () => {
    const adapter = new ChatAdapter();
    const output = decodeJson(adapter.encode(events, { response_id: "resp-1", created: 123 }));
    expect(output).toMatchObject({
      id: "resp-1",
      object: "chat.completion",
      created: 123,
      model: "gpt-chat",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
  });

  test("backfills zero-argument tool calls with valid empty JSON", () => {
    const adapter = new ChatAdapter();
    const toolEvents: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 1, model: "m" },
      {
        type: "tool_call_delta",
        sequence_number: 2,
        call_id: "call-0",
        name: "ping",
        arguments_delta: "",
      },
      { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "tool_use" },
    ];
    const output = decodeJson(adapter.encode(toolEvents));
    const toolCalls = (
      output.choices as Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>
    )[0]?.message.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0]?.function.arguments).toBe("{}");
  });

  test("emits nullable usage for non-final chunks and final usage plus optional usage-only chunk", () => {
    const encoder = new ChatStreamEncoder({ response_id: "resp-1", created: 123, include_usage: true });
    const chunks = streamChunks(encoder, events);
    expect(chunks.length).toBe(5);
    expect(new Set(chunks.map((chunk) => chunk.id))).toEqual(new Set(["resp-1"]));
    expect(chunks.slice(0, 2).every((chunk) => chunk.usage === null)).toBe(true);
    expect(chunks[3]).toMatchObject({
      usage: { prompt_tokens: 10, completion_tokens: 4 },
      choices: [{ finish_reason: "stop" }],
    });
    expect(chunks[4]).toMatchObject({ choices: [], usage: { total_tokens: 14 } });
  });

  test("does not synthesize final usage after cancellation", () => {
    const encoder = new ChatStreamEncoder({ include_usage: true, cancelled: true });
    const chunks = streamChunks(encoder, events);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }], usage: null });
    expect(
      chunks.some(
        (chunk) =>
          Array.isArray(chunk.choices) && chunk.choices.length === 0 && chunk.usage !== null,
      ),
    ).toBe(false);
  });

  test("preserves obfuscation bytes and finish reasons", () => {
    const obfuscated: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 1, model: "m" },
      {
        type: "content_delta",
        sequence_number: 2,
        content: { kind: "extension", name: "chat.obfuscation", payload: "opaque-padding" },
      },
      { type: "terminal", sequence_number: 3, state: "failed", stop_reason: "content_filter" },
    ];
    const chunks = streamChunks(new ChatStreamEncoder({ include_obfuscation: true }), obfuscated);
    // The field is present from the first chunk because the caller asked for
    // it, but a streaming encoder cannot know the upstream padding before the
    // extension event carrying it arrives — the first chunk still carries the
    // synthesized placeholder.
    expect(chunks[0]).toHaveProperty("obfuscation");
    expect(chunks[0]?.obfuscation).toBe("0000000000000000");
    // Once the extension arrives the provider's own bytes pass through, and
    // the padding is adopted for every chunk after it.
    expect(chunks.at(-1)).toMatchObject({
      obfuscation: "opaque-padding",
      choices: [{ finish_reason: "content_filter" }],
    });
  });

  test("lets an explicitly configured obfuscation outrank upstream padding", () => {
    const chunks = streamChunks(new ChatStreamEncoder({ obfuscation: "pinned" }), [
      { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "hi" } },
      {
        type: "content_delta",
        sequence_number: 2,
        content: { kind: "extension", name: "chat.obfuscation", payload: "opaque-padding" },
      },
      { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "stop" },
    ]);
    expect(chunks.map((chunk) => chunk.obfuscation)).toEqual(["pinned", "pinned"]);
  });

  test("keeps streamed tool arguments incremental and keyed by call index", () => {
    const toolEvents: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 1, model: "m" },
      {
        type: "tool_call_delta",
        sequence_number: 2,
        call_id: "call-a",
        index: 0,
        name: "lookup",
        arguments_delta: '{"a":',
      },
      {
        type: "tool_call_delta",
        sequence_number: 3,
        call_id: "call-b",
        index: 1,
        name: "lookup",
        arguments_delta: '{"b":',
      },
      {
        type: "tool_call_delta",
        sequence_number: 4,
        call_id: "call-a",
        index: 0,
        arguments_delta: "1}",
      },
      {
        type: "tool_call_delta",
        sequence_number: 5,
        call_id: "call-b",
        index: 1,
        arguments_delta: "2}",
      },
      { type: "terminal", sequence_number: 6, state: "complete", stop_reason: "tool_use" },
    ];
    const chunks = streamChunks(new ChatStreamEncoder({}), toolEvents);
    const toolDeltas = chunks.flatMap((chunk) => {
      const choices = chunk.choices as Array<{ delta?: { tool_calls?: unknown[] } }>;
      return choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
    }) as Array<{ index: number; id?: string; function: { arguments: string } }>;
    expect(toolDeltas.map((delta) => [delta.index, delta.id, delta.function.arguments])).toEqual([
      [0, "call-a", '{"a":'],
      [1, "call-b", '{"b":'],
      [0, undefined, "1}"],
      [1, undefined, "2}"],
    ]);
  });

  test("maps canonical stop reasons and emits non-opaque reasoning on JSON and SSE", () => {
    const adapter = new ChatAdapter();
    const reasoningEvents: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 1, model: "reasoning-model" },
      {
        type: "content_delta",
        sequence_number: 2,
        content: { kind: "reasoning", payload: "Think ", summary: "ignored" },
      },
      {
        type: "content_delta",
        sequence_number: 3,
        content: { kind: "reasoning", payload: "carefully" },
      },
      {
        type: "content_delta",
        sequence_number: 4,
        content: { kind: "reasoning", payload: "secret", opaque: true },
      },
      { type: "content_delta", sequence_number: 5, content: { kind: "text", text: "Answer" } },
      { type: "terminal", sequence_number: 6, state: "complete", stop_reason: "tool_use" },
    ];
    const json = decodeJson(adapter.encode(reasoningEvents));
    expect(json.choices).toMatchObject([
      {
        message: {
          content: "Answer",
          reasoning_content: "Think \n\ncarefully",
        },
        finish_reason: "tool_calls",
      },
    ]);
    const chunks = streamChunks(new ChatStreamEncoder({}), reasoningEvents);
    const reasoningDeltas = chunks.flatMap((chunk) =>
      (chunk.choices as Array<{ delta?: { reasoning_content?: string } }>).flatMap((choice) =>
        choice.delta?.reasoning_content === undefined ? [] : [choice.delta.reasoning_content],
      ),
    );
    expect(reasoningDeltas).toEqual(["Think ", "carefully"]);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] });
  });
});

describe("canonicalToChatPayload ledger-folded results", () => {
  const base = {
    model: "m",
    stream: true,
    source_surface: "messages",
    generation_controls: {},
  } as const;

  test("skips a user turn emptied by toolResult fold-out (11148)", () => {
    // Every claude-cli tool flow: the Messages ledger re-homes results into
    // `role: "user"`; the fold-out emits them as `role: "tool"`, leaving a
    // bare `user` turn that strict upstreams read as a broken sequence.
    const payload = canonicalToChatPayload({
      ...base,
      messages: [
        { role: "user", content: [{ kind: "text", text: "fix" }] },
        {
          role: "assistant",
          content: [{ kind: "toolCall", call_id: "t9", name: "E", arguments: "{}", index: 0 }],
        },
        { role: "user", content: [{ kind: "toolResult", call_id: "t9", content: "done" }] },
      ],
      tools: [{ name: "E", description: "e", jsonSchema: { type: "object" } }],
    });
    const roles = (payload.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
  });

  test("keeps a user turn that still carries text after fold-out", () => {
    const payload = canonicalToChatPayload({
      ...base,
      messages: [
        { role: "user", content: [{ kind: "text", text: "fix" }] },
        {
          role: "assistant",
          content: [{ kind: "toolCall", call_id: "t9", name: "E", arguments: "{}", index: 0 }],
        },
        {
          role: "user",
          content: [
            { kind: "toolResult", call_id: "t9", content: "done" },
            { kind: "text", text: "thanks" },
          ],
        },
      ],
      tools: [{ name: "E", description: "e", jsonSchema: { type: "object" } }],
    });
    const roles = (payload.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
  });

  test("folds leftover reasoning into the tool side channel instead of a bare turn", () => {
    const payload = canonicalToChatPayload({
      ...base,
      messages: [
        { role: "user", content: [{ kind: "text", text: "fix" }] },
        {
          role: "assistant",
          content: [{ kind: "toolCall", call_id: "t9", name: "E", arguments: "{}", index: 0 }],
        },
        {
          role: "user",
          content: [
            { kind: "toolResult", call_id: "t9", content: "done" },
            { kind: "reasoning", payload: "x", summary: "thought" },
          ],
        },
      ],
      tools: [{ name: "E", description: "e", jsonSchema: { type: "object" } }],
    });
    const wire = payload.messages as Array<Record<string, unknown>>;
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(wire[2]?.reasoning_content).toBe("thought");
  });

  test("keeps reasoning on an assistant turn that carries tool_calls", () => {
    // Thinking-mode providers require the previous turn's reasoning to be
    // replayed, and a thinking model emits it on the very turn that calls a
    // tool. Dropping it there made the next request fail with "the reasoning
    // content from the previous turn must be passed back in thinking mode".
    const payload = canonicalToChatPayload({
      ...base,
      messages: [
        { role: "user", content: [{ kind: "text", text: "check the weather" }] },
        {
          role: "assistant",
          content: [
            { kind: "reasoning", payload: "I need the weather tool", summary: "I need the weather tool" },
            { kind: "text", text: "checking" },
            { kind: "toolCall", call_id: "t9", name: "E", arguments: "{}", index: 0 },
          ],
        },
        { role: "tool", content: [{ kind: "toolResult", call_id: "t9", content: "sunny" }] },
      ],
      tools: [{ name: "E", description: "e", jsonSchema: { type: "object" } }],
    });
    const wire = payload.messages as Array<Record<string, unknown>>;
    const toolTurn = wire.find((m) => m["tool_calls"] !== undefined);
    expect(toolTurn?.reasoning_content).toBe("I need the weather tool");
    expect(toolTurn?.content).toBe("checking");
  });

  test("emits reasoning_content for an omitted-display thinking block with empty text", () => {
    // `display: "omitted"` returns a thinking block whose text is empty but
    // which carries a signature. The turn is still a thinking turn, so the
    // upstream demands the field back; gating on non-empty text dropped it and
    // reproduced "the reasoning content from the previous turn must be passed
    // back in thinking mode".
    const payload = canonicalToChatPayload({
      ...base,
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { kind: "reasoning", payload: "", summary: "", signature: "sig-1" },
            { kind: "toolCall", call_id: "t9", name: "E", arguments: "{}", index: 0 },
          ],
        },
        { role: "tool", content: [{ kind: "toolResult", call_id: "t9", content: "ok" }] },
      ],
      tools: [{ name: "E", description: "e", jsonSchema: { type: "object" } }],
    });
    const toolTurn = (payload.messages as Array<Record<string, unknown>>).find(
      (m) => m["tool_calls"] !== undefined,
    );
    expect(toolTurn).toHaveProperty("reasoning_content");
    expect(toolTurn?.reasoning_content).toBe("");
  });

  test("keeps a reasoning-only assistant turn instead of dropping it", () => {
    const payload = canonicalToChatPayload({
      ...base,
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        { role: "assistant", content: [{ kind: "reasoning", payload: "", summary: "", signature: "s" }] },
        { role: "user", content: [{ kind: "text", text: "continue" }] },
      ],
    });
    const roles = (payload.messages as Array<Record<string, unknown>>).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    const assistant = (payload.messages as Array<Record<string, unknown>>)[1];
    expect(assistant).toHaveProperty("reasoning_content");
  });

  test("does not put reasoning_content on a non-assistant turn", () => {
    const payload = canonicalToChatPayload({
      ...base,
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        { role: "assistant", content: [{ kind: "toolCall", call_id: "t9", name: "E", arguments: "{}", index: 0 }] },
        {
          role: "user",
          content: [
            { kind: "toolResult", call_id: "t9", content: "ok" },
            { kind: "reasoning", payload: "trace", summary: "trace" },
            { kind: "text", text: "and more" },
          ],
        },
      ],
      tools: [{ name: "E", description: "e", jsonSchema: { type: "object" } }],
    });
    const userTurn = (payload.messages as Array<Record<string, unknown>>).filter(
      (m) => m["role"] === "user",
    ).pop();
    expect(userTurn).not.toHaveProperty("reasoning_content");
  });
});
