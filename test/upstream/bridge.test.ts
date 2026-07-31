/**
 * Tests for the streaming event bridge — the highest-risk part of the
 * proxy's hot path (tool_call id continuity across chunk boundaries, usage
 * accounting, stop-reason mapping). Each decoder is fed a realistic raw SSE
 * transcript (per the vendor's documented event shapes) and asserted against
 * the canonical `StreamEvent` sequence; each encoder is fed a canonical
 * sequence and asserted against the resulting wire frames.
 */

import { describe, expect, test } from "bun:test";
import {
  decodeAnthropicStream,
  decodeOpenAIChatStream,
  decodeResponsesStream,
  encodeAnthropicStream,
  encodeOpenAIChatStream,
  encodeResponsesStream,
  withStreamErrorHandling,
} from "../../src/upstream/bridge";
import type { StreamEvent, StreamMeta } from "../../src/upstream/bridge";
import { formatSSEFrame } from "../../src/upstream/sse";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const META: StreamMeta = { id: "id-1", model: "test-model", createdAt: 1000 };

function frame(data: Record<string, unknown>, event?: string): string {
  return formatSSEFrame({ event, data: JSON.stringify(data) });
}

describe("bridge — decodeAnthropicStream", () => {
  test("decodes a full text turn: content_block_start/delta/stop, message_delta with stop_reason+usage", async () => {
    const raw =
      frame({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 2 } } }) +
      frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } }) +
      frame({ type: "content_block_stop", index: 0 }) +
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
      frame({ type: "message_stop" });

    const events = await collect(decodeAnthropicStream(streamOf(raw)));
    expect(events).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0 },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", world" },
      { type: "finish", stopReason: "end_turn" },
      { type: "usage", inputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  test("decodes a tool_use turn: tool_call_start on content_block_start, args via input_json_delta, tool_call_end on stop", async () => {
    const raw =
      frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Jakarta"}' } }) +
      frame({ type: "content_block_stop", index: 0 }) +
      frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} });

    const events = await collect(decodeAnthropicStream(streamOf(raw)));
    expect(events).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "get_weather" },
      { type: "tool_call_args_delta", id: "toolu_1", argumentsDelta: '{"city":' },
      { type: "tool_call_args_delta", id: "toolu_1", argumentsDelta: '"Jakarta"}' },
      { type: "tool_call_end", id: "toolu_1" },
      { type: "finish", stopReason: "tool_use" },
      { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  test("ignores [DONE] sentinel and unparseable frames without throwing", async () => {
    const raw = frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) + "data: [DONE]\n\n" + "data: not json\n\n";
    const events = await collect(decodeAnthropicStream(streamOf(raw)));
    expect(events).toEqual([{ type: "text_delta", text: "ok" }]);
  });

  test("extended-thinking turn: signature_delta terminates the thinking block as a thinking_signature event, not silently dropped", async () => {
    const raw =
      frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me work through this." } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_abc123" } }) +
      frame({ type: "content_block_stop", index: 0 }) +
      frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } }) +
      frame({ type: "content_block_stop", index: 1 }) +
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });

    const events = await collect(decodeAnthropicStream(streamOf(raw)));
    expect(events).toEqual([
      { type: "thinking_delta", text: "Let me work through this." },
      { type: "thinking_signature", signature: "sig_abc123" },
      { type: "text_delta", text: "Answer." },
      { type: "finish", stopReason: "end_turn" },
      { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });
});

describe("bridge — decodeOpenAIChatStream", () => {
  test("decodes a text turn ending in finish_reason: stop", async () => {
    const raw =
      frame({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
      frame({ choices: [{ index: 0, delta: { content: "Hi" } }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";

    const events = await collect(decodeOpenAIChatStream(streamOf(raw)));
    expect(events).toEqual([{ type: "text_delta", text: "Hi" }, { type: "finish", stopReason: "end_turn" }]);
  });

  test("tool_calls: id present only on the first chunk, continuation chunks key off the last opened id", async () => {
    const raw =
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Jakarta"}' } }] } }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });

    const events = await collect(decodeOpenAIChatStream(streamOf(raw)));
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "get_weather" },
      { type: "tool_call_args_delta", id: "call_1", argumentsDelta: '{"city":' },
      { type: "tool_call_args_delta", id: "call_1", argumentsDelta: '"Jakarta"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "finish", stopReason: "tool_use" },
    ]);
  });

  test("usage chunk (final, empty choices) maps prompt_tokens_details.cached_tokens to cacheReadTokens", async () => {
    const raw = frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
    const events = await collect(decodeOpenAIChatStream(streamOf(raw)));
    expect(events).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 }]);
  });

  test("two parallel tool calls: interleaved continuation chunks (no id/name) route by wire index, not by the last-opened id", async () => {
    // Mirrors real agentic-client traffic (Claude Code, GitHub Copilot, OpenCode):
    // both tool calls open before either finishes, and continuation chunks carry
    // only `index` - never `id`/`name`. A "last opened id" heuristic would
    // misroute every arg fragment to call_B once both are open.
    const raw =
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "read_file", arguments: "" } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_B", type: "function", function: { name: "read_file", arguments: "" } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":' } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"b.txt"}' } }] } }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });

    const events = await collect(decodeOpenAIChatStream(streamOf(raw)));
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_A", name: "read_file" },
      { type: "tool_call_start", id: "call_B", name: "read_file" },
      { type: "tool_call_args_delta", id: "call_A", argumentsDelta: '{"path":' },
      { type: "tool_call_args_delta", id: "call_B", argumentsDelta: '{"path":' },
      { type: "tool_call_args_delta", id: "call_A", argumentsDelta: '"a.txt"}' },
      { type: "tool_call_args_delta", id: "call_B", argumentsDelta: '"b.txt"}' },
      { type: "tool_call_end", id: "call_A" },
      { type: "tool_call_end", id: "call_B" },
      { type: "finish", stopReason: "tool_use" },
    ]);
  });
});

describe("bridge — decodeResponsesStream", () => {
  test("decodes a text turn to response.completed with usage", async () => {
    const raw =
      frame({ type: "response.output_text.delta", delta: "Hi" }) +
      frame({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 3 } } });

    const events = await collect(decodeResponsesStream(streamOf(raw)));
    expect(events).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "finish", stopReason: "end_turn" },
      { type: "usage", inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  test("decodes a function_call turn via output_item.added / arguments.delta / arguments.done", async () => {
    const raw =
      frame({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "get_weather" } }) +
      frame({ type: "response.function_call_arguments.delta", item_id: "call_1", delta: '{"city":"Jakarta"}' }) +
      frame({ type: "response.function_call_arguments.done", item_id: "call_1" }) +
      frame({ type: "response.completed", response: { status: "completed" } });

    const events = await collect(decodeResponsesStream(streamOf(raw)));
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "get_weather" },
      { type: "tool_call_args_delta", id: "call_1", argumentsDelta: '{"city":"Jakarta"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "finish", stopReason: "end_turn" },
    ]);
  });

  test("response.incomplete with max_output_tokens maps to max_tokens stop reason", async () => {
    const raw = frame({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
    const events = await collect(decodeResponsesStream(streamOf(raw)));
    expect(events).toEqual([{ type: "finish", stopReason: "max_tokens" }]);
  });
});

describe("bridge — encodeAnthropicStream", () => {
  test("wraps text deltas in a single content_block, closes it before message_delta/message_stop", async () => {
    const out = (await collect(encodeAnthropicStream(fromArray<StreamEvent>([{ type: "text_delta", text: "Hi" }, { type: "finish", stopReason: "end_turn" }]), META))).join("");
    expect(out).toContain('"type":"message_start"');
    expect(out).toContain('"type":"content_block_start"');
    expect(out).toContain('"text_delta","text":"Hi"');
    expect(out).toContain('"type":"content_block_stop"');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('"type":"message_stop"');
  });

  test("tool_call events open a tool_use content block at a distinct index from text", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", text: "thinking..." },
      { type: "tool_call_start", id: "t1", name: "get_weather" },
      { type: "tool_call_args_delta", id: "t1", argumentsDelta: "{}" },
      { type: "tool_call_end", id: "t1" },
      { type: "finish", stopReason: "tool_use" },
    ];
    const frames = await collect(encodeAnthropicStream(fromArray(events), META));
    const starts = frames.filter((f) => f.includes('"content_block_start"'));
    expect(starts).toHaveLength(2);
    expect(starts[0]).toContain('"index":0');
    expect(starts[1]).toContain('"index":1');
    expect(starts[1]).toContain('"tool_use"');
  });
});

describe("bridge — encodeOpenAIChatStream", () => {
  test("opens with an assistant role chunk, streams content, and sets finish_reason: stop on finish", async () => {
    const frames = await collect(encodeOpenAIChatStream(fromArray<StreamEvent>([{ type: "text_delta", text: "Hi" }, { type: "finish", stopReason: "end_turn" }]), META));
    expect(frames[0]).toContain('"role":"assistant"');
    expect(frames[1]).toContain('"content":"Hi"');
    const finishFrame = frames.find((f) => f.includes('"finish_reason":"stop"'));
    expect(finishFrame).toBeDefined();
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  test("tool_calls force finish_reason: tool_calls even if the last StreamEvent.finish carried a different Anthropic reason", async () => {
    const events: StreamEvent[] = [
      { type: "tool_call_start", id: "t1", name: "get_weather" },
      { type: "tool_call_args_delta", id: "t1", argumentsDelta: "{}" },
      { type: "tool_call_end", id: "t1" },
      { type: "finish", stopReason: "end_turn" },
    ];
    const frames = await collect(encodeOpenAIChatStream(fromArray(events), META));
    expect(frames.some((f) => f.includes('"finish_reason":"tool_calls"'))).toBe(true);
  });

  test("usage event maps cacheReadTokens into prompt_tokens_details.cached_tokens", async () => {
    const events: StreamEvent[] = [{ type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 }];
    const frames = await collect(encodeOpenAIChatStream(fromArray(events), META));
    const usageFrame = frames.find((f) => f.includes('"prompt_tokens"'));
    expect(usageFrame).toContain('"prompt_tokens":140'); // inputTokens + cacheReadTokens, per normalizeOpenAIUsage's inverse
    expect(usageFrame).toContain('"cached_tokens":40');
    expect(usageFrame).toContain('"choices":[{"index":0,"delta":{},"finish_reason":null}]');
  });
});

describe("bridge — encodeResponsesStream", () => {
  test("accumulates text deltas and emits a single response.completed with output_text", async () => {
    const events: StreamEvent[] = [{ type: "text_delta", text: "Hi " }, { type: "text_delta", text: "there" }, { type: "finish", stopReason: "end_turn" }];
    const frames = await collect(encodeResponsesStream(fromArray(events), META));
    expect(frames[0]).toContain('"response.created"');
    expect(frames.some((f) => f.includes('"response.output_text.delta"'))).toBe(true);
    const completed = frames.at(-2)!;
    expect(completed).toContain('"response.completed"');
    expect(completed).toContain('"output_text":"Hi there"');
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  test("max_tokens finish reason maps to status: incomplete with incomplete_details.reason", async () => {
    const events: StreamEvent[] = [{ type: "text_delta", text: "cut off" }, { type: "finish", stopReason: "max_tokens" }];
    const frames = await collect(encodeResponsesStream(fromArray(events), META));
    const final = frames.at(-2)!;
    expect(final).toContain('"response.incomplete"');
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
    expect(final).toContain('"status":"incomplete"');
    expect(final).toContain('"max_output_tokens"');
  });
});

  test("thinking_delta events produce a thinking content block that closes before any text block", async () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "I need to think about this..." },
      { type: "thinking_delta", text: " OK, done thinking." },
      { type: "text_delta", text: "Here is the answer." },
      { type: "finish", stopReason: "end_turn" },
    ];
    const frames = await collect(encodeAnthropicStream(fromArray(events), META));
    const all = frames.join("");
    expect(all).toContain('"type":"thinking","thinking":""');
    expect(all).toContain('"thinking_delta","thinking":"I need to think about this..."');
    expect(all).toContain('"type":"text","text":""');
    expect(all).toContain('"text_delta","text":"Here is the answer."');
    // Thinking block (index 0) must close before text block (index 1) starts.
    const thinkingClose = frames.findIndex((f) => f.includes('"content_block_stop"') && f.includes('"index":0'));
    const textStart = frames.findIndex((f) => f.includes('"content_block_start"') && f.includes('"type":"text"'));
    expect(thinkingClose).toBeLessThan(textStart);
  });

  test("fallback text block fires only when the stream produced zero blocks (no thinking, text, or tool_use)", async () => {
    const events: StreamEvent[] = [{ type: "finish", stopReason: "end_turn" }];
    const frames = await collect(encodeAnthropicStream(fromArray(events), META));
    const starts = frames.filter((f) => f.includes('"content_block_start"'));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain('"type":"text","text":""');
    const deltas = frames.filter((f) => f.includes('"content_block_delta"'));
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toContain('(model produced no visible output)');
  });

  test("thinking_signature emits a signature_delta on the still-open thinking block before it closes", async () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "Reasoning..." },
      { type: "thinking_signature", signature: "sig_xyz" },
      { type: "text_delta", text: "Answer." },
      { type: "finish", stopReason: "end_turn" },
    ];
    const frames = await collect(encodeAnthropicStream(fromArray(events), META));
    const sigFrameIndex = frames.findIndex((f) => f.includes('"signature_delta"'));
    const thinkingCloseIndex = frames.findIndex((f) => f.includes('"content_block_stop"') && f.includes('"index":0'));
    expect(sigFrameIndex).toBeGreaterThan(-1);
    expect(frames[sigFrameIndex]).toContain('"index":0');
    expect(frames[sigFrameIndex]).toContain('"signature":"sig_xyz"');
    // Signature delta must land on the thinking block (index 0) before it closes.
    expect(sigFrameIndex).toBeLessThan(thinkingCloseIndex);
  });

  test("a stray thinking_signature with no open thinking block is a no-op (no synthesized block)", async () => {
    const events: StreamEvent[] = [{ type: "thinking_signature", signature: "orphan" }, { type: "finish", stopReason: "end_turn" }];
    const frames = await collect(encodeAnthropicStream(fromArray(events), META));
    expect(frames.some((f) => f.includes('"signature_delta"'))).toBe(false);
  });

describe("bridge — decode → encode round trip", () => {
  test("an Anthropic extended-thinking SSE transcript preserves the signature end-to-end through the StreamEvent bridge", async () => {
    // Same-surface case that mattered most in practice: an Anthropic-native
    // client (Claude Code) dispatched to an Anthropic-family provider still
    // funnels through this decode\u2192encode bridge (there is no raw passthrough
    // fast path), so the signature must survive it or extended-thinking +
    // tool-use replay breaks on the client's next turn.
    const raw =
      frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thinking..." } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_roundtrip" } }) +
      frame({ type: "content_block_stop", index: 0 }) +
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });

    const events = decodeAnthropicStream(streamOf(raw));
    const anthropicFrames = (await collect(encodeAnthropicStream(events, META))).join("");
    expect(anthropicFrames).toContain('"signature_delta"');
    expect(anthropicFrames).toContain('"signature":"sig_roundtrip"');
  });

  test("a full Anthropic tool-call SSE transcript decodes and re-encodes to an equivalent OpenAI Chat stream", async () => {
    const raw =
      frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" } }) +
      frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Jakarta"}' } }) +
      frame({ type: "content_block_stop", index: 0 }) +
      frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} });

    const events = decodeAnthropicStream(streamOf(raw));
    const chatFrames = (await collect(encodeOpenAIChatStream(events, META))).join("");
    expect(chatFrames).toContain('"name":"get_weather"');
    expect(chatFrames).toContain('"arguments":"{\\"city\\":\\"Jakarta\\"}"');
    expect(chatFrames).toContain('"finish_reason":"tool_calls"');
  });
});

describe("bridge — withStreamErrorHandling / synthesizeFailureEvent", () => {
  async function* throwing(): AsyncGenerator<string> {
    yield formatSSEFrame({ data: "partial" });
    throw new Error("upstream disconnected");
  }

  test("Chat: abnormal termination emits a finish_reason: error chunk followed by [DONE]", async () => {
    const frames = await collect(withStreamErrorHandling(throwing(), "openai-chat"));
    expect(frames[0]).toBe(formatSSEFrame({ data: "partial" }));
    expect(frames[1]).toContain('"finish_reason":"error"');
    expect(frames[1]).toContain("upstream disconnected");
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  test("Anthropic: abnormal termination emits an event: error block", async () => {
    const frames = await collect(withStreamErrorHandling(throwing(), "anthropic"));
    expect(frames.at(-1)).toBe(formatSSEFrame({ event: "error", data: JSON.stringify({ type: "error", error: { type: "stream_error", message: "upstream disconnected" } }) }));
  });

  test("Responses: abnormal termination emits response.failed followed by [DONE]", async () => {
    const frames = await collect(withStreamErrorHandling(throwing(), "openai-responses"));
    expect(frames.at(-2)).toContain('"response.failed"');
    expect(frames.at(-2)).toContain("upstream disconnected");
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });
});
