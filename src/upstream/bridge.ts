/**
 * Streaming event bridge — decodes each provider's SSE event vocabulary into
 * one canonical `StreamEvent` sequence, and encodes that sequence back into
 * any of the three target vocabularies.
 *
 * Canonical events carry INCREMENTAL data only (text deltas, raw JSON
 * argument fragments) — never a running snapshot — because that's the
 * lowest common denominator all three wire formats can encode without
 * resending already-sent bytes. Tool call `argumentsDelta` is passed through
 * as a raw JSON string fragment (not re-parsed) since Anthropic's
 * `input_json_delta` and OpenAI's `tool_calls[].function.arguments` are both
 * partial-JSON-string streams already — reparsing mid-stream would just
 * throw on every incomplete chunk.
 */

import { parseSSEStream, formatSSEFrame, SSE_DONE } from "./sse";
import { asArray, asNumber, asObject, asString, field } from "./jsonGuards";
import type { AnthropicStopReason } from "../translate/concerns/finishReasons";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "finish"; stopReason: AnthropicStopReason }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export interface StreamMeta {
  id: string;
  model: string;
  createdAt: number;
}

function parseJSON(data: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(data));
  } catch {
    return undefined;
  }
}

function usageEventFrom(usage: Record<string, unknown>, readKey: string, writeKey: string, detailsKey?: string): StreamEvent {
  const details = detailsKey ? asObject(field(usage, detailsKey)) : undefined;
  return {
    type: "usage",
    inputTokens: asNumber(field(usage, "input_tokens")) ?? asNumber(field(usage, "prompt_tokens")) ?? 0,
    outputTokens: asNumber(field(usage, "output_tokens")) ?? asNumber(field(usage, "completion_tokens")) ?? 0,
    cacheReadTokens: (details ? asNumber(field(details, "cached_tokens")) : asNumber(field(usage, readKey))) ?? 0,
    cacheWriteTokens: asNumber(field(usage, writeKey)) ?? 0,
  };
}

// ── Decode: Anthropic SSE → StreamEvent ──────────────────────────────────

interface AnthropicBlockState {
  type: "text" | "tool_use";
  toolId?: string;
}

export async function* decodeAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, AnthropicBlockState>();

  for await (const frame of parseSSEStream(body)) {
    if (frame.data === "[DONE]") continue;
    const payload = parseJSON(frame.data);
    if (!payload) continue;
    const type = asString(field(payload, "type"));

    if (type === "content_block_start") {
      const index = asNumber(field(payload, "index")) ?? -1;
      const block = asObject(field(payload, "content_block"));
      const blockType = asString(field(block, "type"));
      if (blockType === "tool_use") {
        const toolId = asString(field(block, "id")) ?? "";
        const toolName = asString(field(block, "name")) ?? "";
        blocks.set(index, { type: "tool_use", toolId });
        yield { type: "tool_call_start", id: toolId, name: toolName };
      } else {
        blocks.set(index, { type: "text" });
      }
    } else if (type === "content_block_delta") {
      const index = asNumber(field(payload, "index")) ?? -1;
      const delta = asObject(field(payload, "delta"));
      const deltaType = asString(field(delta, "type"));
      const state = blocks.get(index);
      if (deltaType === "text_delta") {
        yield { type: "text_delta", text: asString(field(delta, "text")) ?? "" };
      } else if (deltaType === "input_json_delta" && state?.toolId) {
        yield { type: "tool_call_args_delta", id: state.toolId, argumentsDelta: asString(field(delta, "partial_json")) ?? "" };
      }
    } else if (type === "content_block_stop") {
      const index = asNumber(field(payload, "index")) ?? -1;
      const state = blocks.get(index);
      if (state?.type === "tool_use" && state.toolId) yield { type: "tool_call_end", id: state.toolId };
      blocks.delete(index);
    } else if (type === "message_delta") {
      const delta = asObject(field(payload, "delta"));
      const stopReason = delta ? field(delta, "stop_reason") : undefined;
      if (stopReason !== undefined) yield { type: "finish", stopReason: stopReason as AnthropicStopReason };
      const usage = asObject(field(payload, "usage"));
      if (usage) yield usageEventFrom(usage, "cache_read_input_tokens", "cache_creation_input_tokens");
    } else if (type === "message_start") {
      const message = asObject(field(payload, "message"));
      const usage = message ? asObject(field(message, "usage")) : undefined;
      if (usage) yield usageEventFrom(usage, "cache_read_input_tokens", "cache_creation_input_tokens");
    }
    // message_stop, ping: no-op
  }
}

// ── Decode: OpenAI Chat Completions SSE → StreamEvent ────────────────────

export async function* decodeOpenAIChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const openToolIds = new Set<string>();

  for await (const frame of parseSSEStream(body)) {
    if (frame.data === "[DONE]") continue;
    const chunk = parseJSON(frame.data);
    if (!chunk) continue;

    const choices = asArray(field(chunk, "choices"));
    const choice = choices ? asObject(choices[0]) : undefined;
    const delta = choice ? asObject(field(choice, "delta")) : undefined;

    const content = delta ? asString(field(delta, "content")) : undefined;
    if (content) yield { type: "text_delta", text: content };

    const toolCalls = delta ? asArray(field(delta, "tool_calls")) : undefined;
    for (const raw of toolCalls ?? []) {
      const tc = asObject(raw);
      const fn = tc ? asObject(field(tc, "function")) : undefined;
      const id = tc ? asString(field(tc, "id")) : undefined;
      const name = fn ? asString(field(fn, "name")) : undefined;
      if (id && name && !openToolIds.has(id)) {
        openToolIds.add(id);
        yield { type: "tool_call_start", id, name };
      }
      const args = fn ? asString(field(fn, "arguments")) : undefined;
      if (args) {
        // Chat Completions omits `id` on continuation chunks — key off the last opened id.
        const targetId = id ?? [...openToolIds].at(-1);
        if (targetId) yield { type: "tool_call_args_delta", id: targetId, argumentsDelta: args };
      }
    }

    const finishReason = choice ? asString(field(choice, "finish_reason")) : undefined;
    if (finishReason) {
      for (const id of openToolIds) yield { type: "tool_call_end", id };
      openToolIds.clear();
      yield { type: "finish", stopReason: chatFinishToAnthropicStop(finishReason) };
    }

    const usage = asObject(field(chunk, "usage"));
    if (usage) yield usageEventFrom(usage, "", "cache_write_tokens", "prompt_tokens_details");
  }
}

function chatFinishToAnthropicStop(reason: string): AnthropicStopReason {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}

// ── Decode: OpenAI Responses SSE → StreamEvent ───────────────────────────

export async function* decodeResponsesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  for await (const frame of parseSSEStream(body)) {
    const payload = parseJSON(frame.data);
    if (!payload) continue;
    const type = asString(field(payload, "type"));

    if (type === "response.output_text.delta") {
      yield { type: "text_delta", text: asString(field(payload, "delta")) ?? "" };
    } else if (type === "response.output_item.added") {
      const item = asObject(field(payload, "item"));
      if (item && asString(field(item, "type")) === "function_call") {
        const id = asString(field(item, "call_id")) ?? "";
        const name = asString(field(item, "name")) ?? "";
        yield { type: "tool_call_start", id, name };
      }
    } else if (type === "response.function_call_arguments.delta") {
      yield { type: "tool_call_args_delta", id: asString(field(payload, "item_id")) ?? "", argumentsDelta: asString(field(payload, "delta")) ?? "" };
    } else if (type === "response.function_call_arguments.done") {
      yield { type: "tool_call_end", id: asString(field(payload, "item_id")) ?? "" };
    } else if (type === "response.completed" || type === "response.incomplete") {
      const resp = asObject(field(payload, "response"));
      const status = asString(field(resp, "status")) ?? "completed";
      const incompleteDetails = asObject(field(resp, "incomplete_details"));
      const incompleteReason = asString(field(incompleteDetails, "reason"));
      yield { type: "finish", stopReason: responsesStatusToAnthropicStop(status, incompleteReason) };
      const usage = asObject(field(resp, "usage"));
      if (usage) yield usageEventFrom(usage, "", "cache_write_tokens", "input_tokens_details");
    }
    // response.created, response.output_item.done, response.content_part.*: no-op (redundant with above)
  }
}

function responsesStatusToAnthropicStop(status: string, incompleteReason: string | undefined): AnthropicStopReason {
  if (status === "incomplete" && incompleteReason === "max_output_tokens") return "max_tokens";
  if (status === "incomplete" && incompleteReason === "content_filter") return "refusal";
  return "end_turn";
}

// ── Encode: StreamEvent → Anthropic SSE ──────────────────────────────────

export async function* encodeAnthropicStream(events: AsyncGenerator<StreamEvent>, meta: StreamMeta): AsyncGenerator<string> {
  let blockIndex = -1;
  let textOpen = false;
  const toolBlockIndexById = new Map<string, number>();

  yield formatSSEFrame({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: { id: meta.id, type: "message", role: "assistant", model: meta.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
  });

  for await (const ev of events) {
    if (ev.type === "text_delta") {
      if (!textOpen) {
        blockIndex++;
        textOpen = true;
        yield formatSSEFrame({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }) });
      }
      yield formatSSEFrame({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: ev.text } }) });
    } else if (ev.type === "tool_call_start") {
      if (textOpen) {
        yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) });
        textOpen = false;
      }
      blockIndex++;
      toolBlockIndexById.set(ev.id, blockIndex);
      yield formatSSEFrame({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} } }) });
    } else if (ev.type === "tool_call_args_delta") {
      const index = toolBlockIndexById.get(ev.id);
      if (index !== undefined) {
        yield formatSSEFrame({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: ev.argumentsDelta } }) });
      }
    } else if (ev.type === "tool_call_end") {
      const index = toolBlockIndexById.get(ev.id);
      if (index !== undefined) yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) });
    } else if (ev.type === "finish") {
      if (textOpen) {
        yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) });
        textOpen = false;
      }
      yield formatSSEFrame({ event: "message_delta", data: JSON.stringify({ type: "message_delta", delta: { stop_reason: ev.stopReason, stop_sequence: null }, usage: {} }) });
    } else if (ev.type === "usage") {
      yield formatSSEFrame({
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: {},
          usage: { input_tokens: ev.inputTokens, output_tokens: ev.outputTokens, cache_read_input_tokens: ev.cacheReadTokens, cache_creation_input_tokens: ev.cacheWriteTokens },
        }),
      });
    }
  }

  yield formatSSEFrame({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
}

// ── Encode: StreamEvent → OpenAI Chat Completions SSE ────────────────────

export async function* encodeOpenAIChatStream(events: AsyncGenerator<StreamEvent>, meta: StreamMeta): AsyncGenerator<string> {
  const toolIndexById = new Map<string, number>();
  let nextToolIndex = 0;

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    formatSSEFrame({
      data: JSON.stringify({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.createdAt,
        model: meta.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }),
    });

  yield chunk({ role: "assistant", content: "" });

  for await (const ev of events) {
    if (ev.type === "text_delta") {
      yield chunk({ content: ev.text });
    } else if (ev.type === "tool_call_start") {
      const index = nextToolIndex++;
      toolIndexById.set(ev.id, index);
      yield chunk({ tool_calls: [{ index, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] });
    } else if (ev.type === "tool_call_args_delta") {
      const index = toolIndexById.get(ev.id);
      if (index !== undefined) yield chunk({ tool_calls: [{ index, function: { arguments: ev.argumentsDelta } }] });
    } else if (ev.type === "tool_call_end") {
      // Chat Completions has no per-tool-call end marker — folded into finish_reason.
    } else if (ev.type === "finish") {
      yield chunk({}, anthropicStopToChatFinish(ev.stopReason, toolIndexById.size > 0));
    } else if (ev.type === "usage") {
      yield formatSSEFrame({
        data: JSON.stringify({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.createdAt,
          model: meta.model,
          choices: [],
          usage: {
            prompt_tokens: ev.inputTokens + ev.cacheReadTokens,
            completion_tokens: ev.outputTokens,
            total_tokens: ev.inputTokens + ev.cacheReadTokens + ev.outputTokens,
            prompt_tokens_details: { cached_tokens: ev.cacheReadTokens },
          },
        }),
      });
    }
  }

  yield SSE_DONE;
}

function anthropicStopToChatFinish(reason: AnthropicStopReason, hadToolCalls: boolean): string {
  if (hadToolCalls) return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

// ── Encode: StreamEvent → OpenAI Responses SSE ───────────────────────────

export async function* encodeResponsesStream(events: AsyncGenerator<StreamEvent>, meta: StreamMeta): AsyncGenerator<string> {
  let sequence = 0;
  const seq = () => sequence++;
  let textAccum = "";
  let finishStop: AnthropicStopReason = "end_turn";
  let usageEvent: Extract<StreamEvent, { type: "usage" }> | undefined;

  yield formatSSEFrame({ data: JSON.stringify({ type: "response.created", sequence_number: seq(), response: { id: meta.id, object: "response", created_at: meta.createdAt, model: meta.model, status: "in_progress" } }) });

  for await (const ev of events) {
    if (ev.type === "text_delta") {
      textAccum += ev.text;
      yield formatSSEFrame({ data: JSON.stringify({ type: "response.output_text.delta", sequence_number: seq(), item_id: meta.id, delta: ev.text }) });
    } else if (ev.type === "tool_call_start") {
      yield formatSSEFrame({ data: JSON.stringify({ type: "response.output_item.added", sequence_number: seq(), item: { type: "function_call", call_id: ev.id, name: ev.name, arguments: "" } }) });
    } else if (ev.type === "tool_call_args_delta") {
      yield formatSSEFrame({ data: JSON.stringify({ type: "response.function_call_arguments.delta", sequence_number: seq(), item_id: ev.id, delta: ev.argumentsDelta }) });
    } else if (ev.type === "tool_call_end") {
      yield formatSSEFrame({ data: JSON.stringify({ type: "response.function_call_arguments.done", sequence_number: seq(), item_id: ev.id }) });
    } else if (ev.type === "finish") {
      finishStop = ev.stopReason;
    } else if (ev.type === "usage") {
      usageEvent = ev;
    }
  }

  const status = finishStop === "max_tokens" || finishStop === "refusal" ? "incomplete" : "completed";
  const responseBody: Record<string, unknown> = {
    id: meta.id,
    object: "response",
    created_at: meta.createdAt,
    model: meta.model,
    status,
    output_text: textAccum,
    usage: usageEvent
      ? {
          input_tokens: usageEvent.inputTokens,
          output_tokens: usageEvent.outputTokens,
          total_tokens: usageEvent.inputTokens + usageEvent.outputTokens,
          input_tokens_details: { cached_tokens: usageEvent.cacheReadTokens },
          cache_write_tokens: usageEvent.cacheWriteTokens,
        }
      : undefined,
  };
  if (status === "incomplete") {
    responseBody.incomplete_details = { reason: finishStop === "max_tokens" ? "max_output_tokens" : "content_filter" };
  }

  yield formatSSEFrame({ data: JSON.stringify({ type: status === "completed" ? "response.completed" : "response.incomplete", sequence_number: seq(), response: responseBody }) });
}
