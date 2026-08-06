import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../../src/domain/contracts";
import { AbortCoordinator, ProviderAdapterError, mapSseStream, type SseDecodeConfig } from "../../src/providers/shared";
import { createChatMapper, ChatCompletionsStreamDecoder, ResponsesStreamDecoder, createResponsesMapper } from "../../src/transport/protocols/openai";
import { createAnthropicMapper, AnthropicMessagesStreamDecoder } from "../../src/transport/protocols/anthropic";

function sseBody(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function streamConfig(body: ReadableStream<Uint8Array>): SseDecodeConfig {
  return { body, coordinator: new AbortCoordinator(new AbortController().signal), maxLineBytes: 4_096 };
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<readonly StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("chat stream terminal and error behavior", () => {
  test("maps deltas, tool calls, usage, and the [DONE] terminal", async () => {
    const events = await collect(mapSseStream(
      streamConfig(sseBody(
        'data: {"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
        "data: [DONE]\n\n",
      )),
      createChatMapper(),
    ));

    expect(events[0]).toEqual({ type: "message_start", id: "chat-1" });
    expect(events).toContainEqual({ type: "thinking_delta", text: "think" });
    expect(events).toContainEqual({ type: "text_delta", text: "hel" });
    expect(events).toContainEqual({ type: "tool_call_start", callId: "call_1", name: "lookup" });
    const deltas = events.filter((event) => event.type === "tool_call_delta" && event.callId === "call_1").map((event) => (event.type === "tool_call_delta" ? event.delta : ""));
    expect(deltas.join("")).toBe('{"q":1}');
    expect(events).toContainEqual({ type: "tool_call_end", callId: "call_1" });
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" ? usage.usage : null).toMatchObject({ inputTokens: 4, outputTokens: 3, totalTokens: 7, cacheReadTokens: 2 });
    expect(events.at(-1)).toEqual({ type: "message_stop", reason: "tool_call" });
  });

  test("maps finish reasons to stop reasons", async () => {
    const cases: ReadonlyArray<[string | null, StreamEvent["type"] extends never ? never : "completed" | "length" | "tool_call" | "content_filter"]> = [
      [null, "completed"],
      ["length", "length"],
      ["content_filter", "content_filter"],
      ["tool_calls", "tool_call"],
    ];
    for (const [finishReason, expected] of cases) {
      const frame = finishReason === null
        ? `{"choices":[{"index":0,"delta":{"content":"x"}}]}`
        : `{"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"${finishReason}"}]}`;
      const events = await collect(mapSseStream(
        streamConfig(sseBody(`data: ${frame}\n\n`, "data: [DONE]\n\n")),
        createChatMapper(),
      ));
      expect(events.at(-1)).toEqual({ type: "message_stop", reason: expected });
    }
  });

  test("fails typed on invalid JSON in a stream event", async () => {
    const stream = mapSseStream(streamConfig(sseBody("data: not-json\n\n")), createChatMapper());
    const caught = await collect(stream).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderAdapterError);
    expect(caught).toMatchObject({ kind: "provider_protocol_error", retryable: false });
  });

  test("surfaces usage cache reads only when explicit cache is declared", async () => {
    const frame = 'data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":4}}}\n\n';
    const explicit = await collect(mapSseStream(streamConfig(sseBody(frame, "data: [DONE]\n\n")), createChatMapper()));
    const usageEvent = explicit.find((event) => event.type === "usage");
    expect(usageEvent?.type === "usage" ? usageEvent.usage.cacheReadTokens : null).toBe(4);
  });
});

describe("responses stream terminal and error behavior", () => {
  test("maps created, deltas, tool lifecycle, usage, and completed", async () => {
    const events = await collect(mapSseStream(
      streamConfig(sseBody(
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"q\\":"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"1}"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","arguments":"{\\"q\\":1}"}}\n\n',
        'data: {"type":"response.reasoning_text.delta","delta":"plan"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"done"}\n\n',
        'data: {"type":"response.usage","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}\n\n',
      )),
      createResponsesMapper(),
    ));

    expect(events[0]).toEqual({ type: "message_start", id: "resp_1" });
    expect(events).toContainEqual({ type: "tool_call_start", callId: "call_1", name: "lookup" });
    expect(events).toContainEqual({ type: "tool_call_end", callId: "call_1" });
    expect(events).toContainEqual({ type: "thinking_delta", text: "plan" });
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
    expect(events.at(-1)).toEqual({ type: "message_stop", reason: "completed" });
    const usageEvents = events.filter((event) => event.type === "usage");
    expect(usageEvents).toHaveLength(2);
  });

  test("terminates with error on response.failed and length on incomplete", async () => {
    const failed = await collect(mapSseStream(
      streamConfig(sseBody('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n', 'data: {"type":"response.failed"}\n\n')),
      createResponsesMapper(),
    ));
    expect(failed.at(-1)).toEqual({ type: "message_stop", reason: "error" });

    const incomplete = await collect(mapSseStream(
      streamConfig(sseBody('data: {"type":"response.incomplete"}\n\n', 'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n')),
      createResponsesMapper(),
    ));
    expect(incomplete.at(-1)).toEqual({ type: "message_stop", reason: "length" });
  });

  test("throws typed on response.error events", async () => {
    const truncated = mapSseStream(streamConfig(sseBody('data: {"type":"response.error","code":"max_output_tokens","message":"budget exceeded"}\n\n')), createResponsesMapper());
    await expect(collect(truncated)).rejects.toMatchObject({ kind: "stream_truncated" });

    const protocol = mapSseStream(streamConfig(sseBody('data: {"type":"response.error","message":"boom"}\n\n')), createResponsesMapper());
    await expect(collect(protocol)).rejects.toMatchObject({ kind: "provider_protocol_error", retryable: false });
  });
});

describe("anthropic stream terminal and error behavior", () => {
  test("maps message lifecycle, tool input JSON, usage, and stop reason", async () => {
    const events = await collect(mapSseStream(
      streamConfig(sseBody(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"1}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      )),
      createAnthropicMapper(),
    ));

    expect(events[0]).toEqual({ type: "message_start", id: "msg_1" });
    expect(events).toContainEqual({ type: "tool_call_start", callId: "toolu_1", name: "lookup" });
    const deltas = events.filter((event) => event.type === "tool_call_delta" && event.callId === "toolu_1").map((event) => (event.type === "tool_call_delta" ? event.delta : ""));
    expect(deltas.join("")).toBe('{"q":1}');
    expect(events).toContainEqual({ type: "tool_call_end", callId: "toolu_1" });
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" ? usage.usage : null).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1 });
    expect(events.at(-1)).toEqual({ type: "message_stop", reason: "tool_call" });
  });

  test("maps max_tokens and refusal stop reasons", async () => {
    const length = await collect(mapSseStream(
      streamConfig(sseBody(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      )),
      createAnthropicMapper(),
    ));
    expect(length.at(-1)).toEqual({ type: "message_stop", reason: "length" });

    const refusal = await collect(mapSseStream(
      streamConfig(sseBody(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      )),
      createAnthropicMapper(),
    ));
    expect(refusal.at(-1)).toEqual({ type: "message_stop", reason: "content_filter" });
  });

  test("throws typed, retryable errors on upstream rate-limit events", async () => {
    const stream = mapSseStream(
      streamConfig(sseBody('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n')),
      createAnthropicMapper(),
    );
    await expect(collect(stream)).rejects.toMatchObject({ kind: "provider_rate_limited", retryable: true, routeScope: "account" });
  });
});

describe("stream decoders reject missing terminal events", () => {
  test("chat decoder fails typed when the stream ends without a terminal event", async () => {
    const decoder = new ChatCompletionsStreamDecoder();
    const events = decoder.decode({ body: sseBody('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'), signal: new AbortController().signal, maxLineBytes: 4_096 });
    await expect(collect(events)).rejects.toMatchObject({ kind: "stream_truncated", retryable: false });
  });

  test("responses decoder fails typed on a truncated stream", async () => {
    const decoder = new ResponsesStreamDecoder();
    const events = decoder.decode({ body: sseBody('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), signal: new AbortController().signal, maxLineBytes: 4_096 });
    await expect(collect(events)).rejects.toMatchObject({ kind: "stream_truncated" });
  });

  test("anthropic decoder fails typed on a truncated stream", async () => {
    const decoder = new AnthropicMessagesStreamDecoder();
    const events = decoder.decode({ body: sseBody('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n'), signal: new AbortController().signal, maxLineBytes: 4_096 });
    await expect(collect(events)).rejects.toMatchObject({ kind: "stream_truncated" });
  });

  test("decoders accept streams that do terminate", async () => {
    const decoder = new ChatCompletionsStreamDecoder();
    const events = await collect(decoder.decode({ body: sseBody('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"), signal: new AbortController().signal, maxLineBytes: 4_096 }));
    expect(events.at(-1)).toEqual({ type: "message_stop", reason: "completed" });
  });
});