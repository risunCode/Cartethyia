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
import { openAIFinishToAnthropicStop, isOpenAIFinishReason, anthropicStopToOpenAIFinishWithTools } from "../translate/concerns/finishReasons";
import type { AnthropicStopReason } from "../translate/concerns/finishReasons";

/**
 * Runtime-checked field readers for untyped JSON parsed off the wire (SSE
 * frames, upstream responses). Every reader does a real `typeof`/shape
 * check and returns `undefined` on mismatch instead of trusting an inline
 * `as` cast, a malformed or version-drifted upstream event degrades to
 * "field missing" instead of a silently wrong value.
 */

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function field(obj: Record<string, unknown> | undefined, key: string): unknown {
  return obj?.[key];
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "finish"; stopReason: AnthropicStopReason }
  | { type: "usage"; inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

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
  const outputDetails = asObject(field(usage, "completion_tokens_details")) ?? asObject(field(usage, "output_tokens_details"));
  return {
    type: "usage",
    inputTokens: asNumber(field(usage, "input_tokens")) ?? asNumber(field(usage, "prompt_tokens")) ?? 0,
    outputTokens: asNumber(field(usage, "output_tokens")) ?? asNumber(field(usage, "completion_tokens")) ?? 0,
    reasoningTokens: asNumber(field(outputDetails, "reasoning_tokens")) ?? 0,
    cacheReadTokens: (details ? asNumber(field(details, "cached_tokens")) : asNumber(field(usage, readKey))) ?? 0,
    cacheWriteTokens: asNumber(field(usage, writeKey)) ?? 0,
  };
}

// ── Decode: Anthropic SSE → StreamEvent ──────────────────────────────────

interface AnthropicBlockState {
  type: "text" | "tool_use" | "thinking";
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
      } else if (blockType === "thinking") {
        blocks.set(index, { type: "thinking" } as AnthropicBlockState);
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
      } else if (deltaType === "thinking_delta") {
        // Anthropic's real wire format never reuses text_delta for thinking
        // content - it has its own delta type with a `thinking` field, not
        // `text`. Checking `deltaType === "text_delta"` plus a state lookup
        // here (the prior shape of this branch) never matches a real
        // streaming response, so thinking content was silently dropped
        // outright before this fix - not just its trailing signature.
        yield { type: "thinking_delta", text: asString(field(delta, "thinking")) ?? "" };
      } else if (deltaType === "input_json_delta" && state?.toolId) {
        yield { type: "tool_call_args_delta", id: state.toolId, argumentsDelta: asString(field(delta, "partial_json")) ?? "" };
      } else if (deltaType === "signature_delta" && state?.type === "thinking") {
        // Terminal delta on an extended-thinking block, carrying the
        // cryptographic signature Anthropic requires unmodified on replay
        // (extended thinking + tool use rejects an unsigned/altered thinking
        // block on the next turn). Dropping this silently used to strand
        // every multi-turn thinking+tool-use conversation proxied through
        // Cartethyia, including Anthropic-native clients (Claude Code) whose
        // requests still funnel through this same StreamEvent bridge.
        yield { type: "thinking_signature", signature: asString(field(delta, "signature")) ?? "" };
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
  // Chat Completions correlates streamed tool-call fragments by wire `index`,
  // not `id` - continuation chunks omit `id`/`name` and carry only `index` +
  // an `arguments` fragment. Keying off "the last id we saw" breaks the
  // instant two tool calls are open at once (parallel_tool_calls), which
  // agentic clients (Claude Code, GitHub Copilot, OpenCode) trigger routinely
  // but a single-tool curl smoke test never does.
  const toolIdByIndex = new Map<number, string>();
  // Most recently opened tool call's id - used only for the malformed-index
  // recovery below, never to override a well-formed id/name pair.
  let lastToolId: string | undefined;

  for await (const frame of parseSSEStream(body)) {
    if (frame.data === "[DONE]") continue;
    const chunk = parseJSON(frame.data);
    if (!chunk) continue;

    const choices = asArray(field(chunk, "choices"));
    const choice = choices ? asObject(choices[0]) : undefined;
    const delta = choice ? asObject(field(choice, "delta")) : undefined;

    const content = delta ? asString(field(delta, "content")) : undefined;
    if (content) yield { type: "text_delta", text: content };
    const reasoningContent = delta ? asString(field(delta, "reasoning_content")) : undefined;
    if (reasoningContent) yield { type: "thinking_delta", text: reasoningContent };

    const toolCalls = delta ? asArray(field(delta, "tool_calls")) : undefined;
    for (const raw of toolCalls ?? []) {
      const tc = asObject(raw);
      const fn = tc ? asObject(field(tc, "function")) : undefined;
      const id = tc ? asString(field(tc, "id")) : undefined;
      const name = fn ? asString(field(fn, "name")) : undefined;
      const index = asNumber(field(tc, "index")) ?? 0;
      if (id && name && !toolIdByIndex.has(index)) {
        toolIdByIndex.set(index, id);
        lastToolId = id;
        yield { type: "tool_call_start", id, name };
      } else if (!toolIdByIndex.has(index) && lastToolId) {
        // Malformed upstream: a "new" index opened with id/name both blank
        // (empty string, not absent - so the `id && name` check above never
        // registers it) while a tool call is already in flight. Confirmed
        // via a production trace: Devin SWE-1.6 split a single create_file
        // call's own arguments across two tool_calls indices mid-stream,
        // the second with `"id":"","function":{"name":""}}` - every
        // argument fragment routed to that index silently vanished (dropped
        // by the `if (targetId)` guard below, since the index was never in
        // the map) instead of reaching the real tool call. Route it to
        // whichever call most recently started instead of dropping it.
        toolIdByIndex.set(index, lastToolId);
      }
      const args = fn ? asString(field(fn, "arguments")) : undefined;
      if (args) {
        const targetId = toolIdByIndex.get(index);
        if (targetId) yield { type: "tool_call_args_delta", id: targetId, argumentsDelta: args };
      }
    }

    const finishReason = choice ? asString(field(choice, "finish_reason")) : undefined;
    if (finishReason) {
      // A malformed index recovered above maps to the SAME id as another
      // index (see above) - dedupe so that id's tool_call_end fires once.
      for (const id of new Set(toolIdByIndex.values())) yield { type: "tool_call_end", id };
      toolIdByIndex.clear();
      lastToolId = undefined;
      yield { type: "finish", stopReason: chatFinishToAnthropicStop(finishReason) };
    }

    const usage = asObject(field(chunk, "usage"));
    if (usage) yield usageEventFrom(usage, "", "cache_write_tokens", "prompt_tokens_details");
  }
}

function chatFinishToAnthropicStop(reason: string): AnthropicStopReason {
  return isOpenAIFinishReason(reason) ? openAIFinishToAnthropicStop(reason) : "end_turn";
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
  yield formatSSEFrame({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: { id: meta.id, type: "message", role: "assistant", model: meta.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
  });

  let blockIndex = -1;
  let thinkingOpen = false;
  let textOpen = false;
  const toolBlockIndexById = new Map<string, number>();
  // Sticky across the whole stream (unlike thinking/textOpen and the tool
  // map, which reflect only currently-open blocks) - the `finish` handler
  // needs to know whether ANY content block ever ran, not whether one
  // happens to still be open, since a tool_call_end can close and remove its
  // block from the map well before `finish` arrives.
  let anyBlockOpened = false;

  // Closes an open thinking/text block. Tool blocks are closed individually
  // by their own `tool_call_end` (see below) - unlike thinking/text, more
  // than one tool_use block can be genuinely open at once (parallel tool
  // calls on an OpenAI-shaped upstream interleave argument deltas by id
  // before any of them finish), so a text/thinking transition must not
  // touch tool blocks that are still streaming.
  function* closeTextLikeBlocks(): Generator<string> {
    if (thinkingOpen) { yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) }); thinkingOpen = false; }
    if (textOpen) { yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) }); textOpen = false; }
  }

  // Full close, used only at stream end: closes thinking/text plus any tool
  // blocks still open (a safety net for a stream that ends before every
  // tool_call_end arrives - normal completion already closes each tool via
  // its own end event, per-id, so this is a no-op in the common case).
  function* closeAllOpenBlocks(): Generator<string> {
    yield* closeTextLikeBlocks();
    for (const idx of toolBlockIndexById.values()) { yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: idx }) }); }
    toolBlockIndexById.clear();
  }

  for await (const ev of events) {
    if (ev.type === "thinking_delta") {
      if (!thinkingOpen) {
        yield* closeAllOpenBlocks();
        blockIndex++;
        thinkingOpen = true;
        anyBlockOpened = true;
        yield formatSSEFrame({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "" } }) });
      }
      yield formatSSEFrame({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: ev.text } }) });
    } else if (ev.type === "thinking_signature") {
      // Only meaningful while the thinking block it terminates is still
      // open; a stray signature event with nothing open is a decode-side
      // ordering violation, not something to synthesize a block for.
      if (thinkingOpen) {
        yield formatSSEFrame({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "signature_delta", signature: ev.signature } }) });
      }
    } else if (ev.type === "text_delta") {
      if (!textOpen) {
        yield* closeAllOpenBlocks();
        blockIndex++;
        textOpen = true;
        anyBlockOpened = true;
        yield formatSSEFrame({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }) });
      }
      yield formatSSEFrame({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: ev.text } }) });
    } else if (ev.type === "tool_call_start") {
      // Only thinking/text must yield before a tool block opens - other
      // still-open tool blocks (parallel tool calls) are left alone so
      // their argument deltas keep resolving by id instead of vanishing.
      yield* closeTextLikeBlocks();
      blockIndex++;
      anyBlockOpened = true;
      toolBlockIndexById.set(ev.id, blockIndex);
      yield formatSSEFrame({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} } }) });
    } else if (ev.type === "tool_call_args_delta") {
      const index = toolBlockIndexById.get(ev.id);
      if (index !== undefined) {
        yield formatSSEFrame({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: ev.argumentsDelta } }) });
      }
    } else if (ev.type === "tool_call_end") {
      const index = toolBlockIndexById.get(ev.id);
      if (index !== undefined) {
        yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) });
        // Removed once closed - otherwise the next closeAllOpenBlocks() call
        // (next tool-less transition, or stream finish) re-closes an index
        // the client already considers stopped, corrupting the SSE stream
        // with a stray content_block_stop for every tool call, parallel or not.
        toolBlockIndexById.delete(ev.id);
      }
    } else if (ev.type === "finish") {
      yield* closeAllOpenBlocks();
      if (!anyBlockOpened) {
        blockIndex++;
        yield formatSSEFrame({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }) });
        yield formatSSEFrame({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: "(model produced no visible output)" } }) });
        yield formatSSEFrame({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) });
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
  const toolIdsWithArgs = new Set<string>();
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
    if (ev.type === "thinking_delta") {
      yield chunk({ reasoning_content: ev.text });
    } else if (ev.type === "text_delta") {
      yield chunk({ content: ev.text });
    } else if (ev.type === "tool_call_start") {
      const index = nextToolIndex++;
      toolIndexById.set(ev.id, index);
      yield chunk({ tool_calls: [{ index, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] });
    } else if (ev.type === "tool_call_args_delta") {
      const index = toolIndexById.get(ev.id);
      if (index !== undefined) {
        toolIdsWithArgs.add(ev.id);
        yield chunk({ tool_calls: [{ index, function: { arguments: ev.argumentsDelta } }] });
      }
    } else if (ev.type === "tool_call_end") {
      // Chat Completions has no per-tool-call end marker — folded into
      // finish_reason. A tool call whose upstream never streamed any argument
      // fragment (a genuinely zero-argument function) would otherwise leave
      // the client-assembled `arguments` as "" - not valid JSON - since the
      // opening chunk only ever sends "". Backfill "{}" once, here.
      const index = toolIndexById.get(ev.id);
      if (index !== undefined && !toolIdsWithArgs.has(ev.id)) yield chunk({ tool_calls: [{ index, function: { arguments: "{}" } }] });
    } else if (ev.type === "finish") {
      yield chunk({}, anthropicStopToOpenAIFinishWithTools(ev.stopReason, toolIndexById.size > 0));
    } else if (ev.type === "usage") {
      yield formatSSEFrame({
        data: JSON.stringify({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.createdAt,
          model: meta.model,
          // Some coding clients (including Copilot's strict stream parser)
          // reject OpenAI's optional empty-choices usage chunk.
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          usage: {
            prompt_tokens: ev.inputTokens + ev.cacheReadTokens,
            completion_tokens: ev.outputTokens,
            total_tokens: ev.inputTokens + ev.cacheReadTokens + ev.outputTokens,
            prompt_tokens_details: { cached_tokens: ev.cacheReadTokens },
            completion_tokens_details: { reasoning_tokens: ev.reasoningTokens },
          },
        }),
      });
    }
  }

  yield SSE_DONE;
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
  yield formatSSEFrame({ data: "[DONE]" });
}

/**
 * Synthesizes the format-specific terminal frame(s) for an upstream stream
 * that ended abnormally, so a client parsing that vocabulary sees a
 * recognized failure event instead of a silently truncated stream. Each
 * surface's normal terminal frame is mirrored here (finish_reason for Chat,
 * message_stop-equivalent event for Anthropic, response.failed for
 * Responses), followed by that surface's own terminal sentinel.
 */
export function synthesizeFailureEvent(
  format: "openai-chat" | "anthropic" | "openai-responses",
  error: unknown,
): string[] {
  const message = error instanceof Error ? error.message : "Stream interrupted";

  if (format === "openai-chat") {
    return [
      formatSSEFrame({ data: JSON.stringify({ error: { message, type: "stream_error" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] }) }),
      SSE_DONE,
    ];
  }

  if (format === "openai-responses") {
    return [
      formatSSEFrame({ data: JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message } } }) }),
      formatSSEFrame({ data: "[DONE]" }),
    ];
  }

  return [formatSSEFrame({ event: "error", data: JSON.stringify({ type: "error", error: { type: "stream_error", message } }) })];
}

/**
 * Wraps an SSE stream generator with error handling (M2).
 * If the source generator throws, yields the format-specific synthesized
 * failure frame(s) before the stream ends, so the client knows why it
 * disconnected instead of seeing a silently truncated stream.
 */
export function withStreamErrorHandling(
  source: AsyncGenerator<string>,
  format: "openai-chat" | "anthropic" | "openai-responses",
): AsyncGenerator<string> {
  return (async function* () {
    try {
      yield* source;
    } catch (err) {
      yield* synthesizeFailureEvent(format, err);
    }
  })();
}
