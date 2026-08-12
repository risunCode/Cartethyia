import { isRecord } from "../../application/protocols";
import type { Surface, ProviderUsage, StopReason, StreamEvent } from "../../application/contracts";
import { fullPromptTokens } from "../translate/response/usage";

const encoder = new TextEncoder();

type WireFrame = { readonly event?: string; readonly data: unknown };

function frame(input: WireFrame): Uint8Array {
  const event = input.event === undefined ? "" : `event: ${input.event}\n`;
  return encoder.encode(`${event}data: ${typeof input.data === "string" ? input.data : JSON.stringify(input.data)}\n\n`);
}

function usageNumber(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function openAIStop(reason: StopReason, hasToolCall: boolean): string {
  if (reason === "error") return "error";
  if (reason === "length") return "length";
  if (reason === "tool_call" || hasToolCall) return "tool_calls";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

function anthropicStop(reason: StopReason): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_call") return "tool_use";
  if (reason === "content_filter") return "refusal";
  if (reason === "compaction") return "compaction";
  if (reason === "pause_turn") return "pause_turn";
  return "end_turn";
}

function responseStatus(reason: StopReason): "completed" | "incomplete" | "failed" {
  if (reason === "error") return "failed";
  return reason === "length" || reason === "content_filter" ? "incomplete" : "completed";
}

function responseIncompleteReason(reason: StopReason): string | undefined {
  if (reason === "length") return "max_output_tokens";
  if (reason === "content_filter") return "content_filter";
  return undefined;
}

function responseUsage(usage: ProviderUsage): Record<string, unknown> {
  const output = usageNumber(usage.outputTokens);
  const cached = usageNumber(usage.cacheReadTokens);
  const written = usageNumber(usage.cacheWriteTokens);
  const prompt = fullPromptTokens(usage);
  return {
    input_tokens: prompt,
    output_tokens: output,
    total_tokens: usageNumber(usage.totalTokens) || prompt + output,
    input_tokens_details: {
      cached_tokens: cached,
      ...(written > 0 ? { cache_write_tokens: written } : {}),
    },
    output_tokens_details: { reasoning_tokens: usageNumber(usage.reasoningTokens ?? null) },
  };
}

async function* encodeOpenAIChat(events: AsyncIterable<StreamEvent>, model: string): AsyncGenerator<Uint8Array> {
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let started = false;
  let finished = false;
  let sawTool = false;
  let nextToolIndex = 0;
  const toolIndexById = new Map<string, number>();
  const toolArgsById = new Set<string>();

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, unknown>): Uint8Array =>
    frame({ data: {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage === undefined ? {} : { usage }),
    } });

  for await (const event of events) {
    if (event.type === "message_start") {
      id = event.id || id;
      if (!started) {
        started = true;
        yield chunk({ role: "assistant", content: "" });
      }
      continue;
    }
    if (!started) {
      started = true;
      yield chunk({ role: "assistant", content: "" });
    }
    if (event.type === "thinking_delta") {
      yield chunk({ reasoning_content: event.text });
    } else if (event.type === "text_delta") {
      yield chunk({ content: event.text });
    } else if (event.type === "tool_call_start") {
      sawTool = true;
      const index = nextToolIndex++;
      toolIndexById.set(event.callId, index);
      yield chunk({ tool_calls: [{ index, id: event.callId, type: "function", function: { name: event.name, arguments: "" } }] });
    } else if (event.type === "tool_call_delta") {
      sawTool = true;
      const index = toolIndexById.get(event.callId) ?? nextToolIndex++;
      toolIndexById.set(event.callId, index);
      toolArgsById.add(event.callId);
      yield chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] });
    } else if (event.type === "tool_call_end") {
      const index = toolIndexById.get(event.callId);
      if (index !== undefined && !toolArgsById.has(event.callId)) yield chunk({ tool_calls: [{ index, function: { arguments: "{}" } }] });
    } else if (event.type === "usage") {
      const cached = usageNumber(event.usage.cacheReadTokens);
      const written = usageNumber(event.usage.cacheWriteTokens);
      yield chunk({}, null, {
        prompt_tokens: fullPromptTokens(event.usage),
        completion_tokens: usageNumber(event.usage.outputTokens),
        total_tokens: usageNumber(event.usage.totalTokens) || fullPromptTokens(event.usage) + usageNumber(event.usage.outputTokens),
        prompt_tokens_details: {
          cached_tokens: cached,
          ...(written > 0 ? { cache_write_tokens: written } : {}),
        },
      });
    } else if (event.type === "message_stop" && !finished) {
      finished = true;
      if (event.reason === "error") {
        yield frame({ data: { error: { message: event.error?.message ?? "Stream interrupted", type: "stream_error", code: event.error?.kind }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] } });
      } else {
        yield chunk({}, openAIStop(event.reason, sawTool));
      }
      yield encoder.encode("data: [DONE]\n\n");
    }
  }
  if (!finished) {
    yield chunk({}, "error");
    yield encoder.encode("data: [DONE]\n\n");
  }
}

async function* encodeAnthropic(events: AsyncIterable<StreamEvent>, model: string): AsyncGenerator<Uint8Array> {
  let id = `msg_${crypto.randomUUID()}`;
  let started = false;
  let finished = false;
  let blockIndex = -1;
  let textBlock: number | null = null;
  let compactionBlock: number | null = null;
  let thinkingBlock: number | null = null;
  const toolBlockById = new Map<string, number>();
  const nativeBlockByIndex = new Map<number, number>();
  const startMessage = (): Uint8Array => frame({ event: "message_start", data: { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
  const stopBlock = (index: number): Uint8Array => frame({ event: "content_block_stop", data: { type: "content_block_stop", index } });

  const closeTextBlocks = function* (): Generator<Uint8Array> {
    if (thinkingBlock !== null) { yield stopBlock(thinkingBlock); thinkingBlock = null; }
    if (textBlock !== null) { yield stopBlock(textBlock); textBlock = null; }
    if (compactionBlock !== null) { yield stopBlock(compactionBlock); compactionBlock = null; }
  };

  for await (const event of events) {
    if (event.type === "message_start") {
      id = event.id || id;
      if (!started) { started = true; yield startMessage(); }
      continue;
    }
    if (event.type === "server_tool_result") {
      yield* closeTextBlocks();
      const index = ++blockIndex;
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index, content_block: event.block } });
      yield stopBlock(index);
    } else if (event.type === "native_block_start") {
      yield* closeTextBlocks();
      const index = ++blockIndex;
      nativeBlockByIndex.set(event.index, index);
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index, content_block: event.block } });
    } else if (event.type === "native_block_delta") {
      const index = nativeBlockByIndex.get(event.index);
      if (index !== undefined) yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: event.delta } });
    } else if (event.type === "native_block_stop") {
      const index = nativeBlockByIndex.get(event.index);
      if (index !== undefined) {
        yield stopBlock(index);
        nativeBlockByIndex.delete(event.index);
      }
    } else if (event.type === "compaction_start") {
      yield* closeTextBlocks();
      compactionBlock = ++blockIndex;
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index: compactionBlock, content_block: { type: "compaction", content: "" } } });
    } else if (event.type === "compaction_delta") {
      if (compactionBlock !== null) yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index: compactionBlock, delta: { type: "compaction_delta", content: event.text } } });
    } else if (event.type === "compaction_stop") {
      if (compactionBlock !== null) { yield stopBlock(compactionBlock); compactionBlock = null; }
    } else if (event.type === "thinking_delta") {
      if (thinkingBlock === null) {
        yield* closeTextBlocks();
        thinkingBlock = ++blockIndex;
        yield frame({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: thinkingBlock,
            content_block: { type: "thinking", thinking: "", ...(event.reasoningSignature === undefined ? {} : { signature: event.reasoningSignature }) },
          },
        });
      }
      yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index: thinkingBlock, delta: { type: "thinking_delta", thinking: event.text } } });
    } else if (event.type === "text_delta") {
      if (textBlock === null) {
        yield* closeTextBlocks();
        textBlock = ++blockIndex;
        yield frame({ event: "content_block_start", data: { type: "content_block_start", index: textBlock, content_block: { type: "text", text: "" } } });
      }
      yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index: textBlock, delta: { type: "text_delta", text: event.text } } });
    } else if (event.type === "tool_call_start") {
      yield* closeTextBlocks();
      const index = ++blockIndex;
      toolBlockById.set(event.callId, index);
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: event.callId, name: event.name, input: {}, ...(event.reasoningSignature === undefined ? {} : { signature: event.reasoningSignature }) } } });
    } else if (event.type === "tool_call_delta") {
      const index = toolBlockById.get(event.callId);
      if (index !== undefined) yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: event.delta } } });
    } else if (event.type === "tool_call_end") {
      const index = toolBlockById.get(event.callId);
      if (index !== undefined) { yield stopBlock(index); toolBlockById.delete(event.callId); }
    } else if (event.type === "usage") {
      yield frame({ event: "message_delta", data: { type: "message_delta", delta: {}, usage: { input_tokens: usageNumber(event.usage.inputTokens), output_tokens: usageNumber(event.usage.outputTokens), cache_read_input_tokens: usageNumber(event.usage.cacheReadTokens), cache_creation_input_tokens: usageNumber(event.usage.cacheWriteTokens) } } });
    } else if (event.type === "message_stop" && !finished) {
      finished = true;
      yield* closeTextBlocks();
      for (const index of toolBlockById.values()) yield stopBlock(index);
      toolBlockById.clear();
      for (const index of nativeBlockByIndex.values()) yield stopBlock(index);
      nativeBlockByIndex.clear();
      if (event.reason === "error") {
        yield frame({ event: "error", data: { type: "error", error: { type: event.error?.kind ?? "stream_error", message: event.error?.message ?? "Stream interrupted" } } });
      } else {
        yield frame({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: anthropicStop(event.reason), stop_sequence: null }, usage: {} } });
        yield frame({ event: "message_stop", data: { type: "message_stop" } });
      }
    }
  }
  if (!finished) yield frame({ event: "error", data: { type: "error", error: { type: "stream_error", message: "Stream interrupted" } } });
}

async function* encodeResponses(events: AsyncIterable<StreamEvent>, model: string): AsyncGenerator<Uint8Array> {
  let id = `resp_${crypto.randomUUID()}`;
  let started = false;
  let finished = false;
  let sequence = 0;
  let textItemId: string | null = null;
  let textIndex: number | null = null;
  let textValue = "";
  let reasoningItemId: string | null = null;
  let reasoningIndex: number | null = null;
  let reasoningValue = "";
  let finalReason: StopReason = "completed";
  let usage: ProviderUsage | null = null;
  const outputItems: Array<Record<string, unknown>> = [];
  const activeCalls = new Map<string, { readonly index: number; readonly item: Record<string, unknown> }>();

  const next = (): number => sequence++;
  const eventFrame = (data: Record<string, unknown>): Uint8Array => frame({ data: { sequence_number: next(), ...data } });
  const setOutputItem = (index: number, item: Record<string, unknown>): void => {
    outputItems[index] = item;
  };
  const responseCreated = (): Uint8Array => eventFrame({
    type: "response.created",
    response: { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] },
  });
  const outputItemAdded = (index: number, item: Record<string, unknown>): Uint8Array => eventFrame({ type: "response.output_item.added", output_index: index, item });
  const contentPartAdded = (index: number, itemId: string, content: Record<string, unknown>): Uint8Array => eventFrame({ type: "response.content_part.added", item_id: itemId, output_index: index, content_index: 0, part: content });

  function* closeText(): Generator<Uint8Array> {
    if (textItemId === null || textIndex === null) return;
    const item = outputItems[textIndex] ?? { type: "message", id: textItemId, role: "assistant", content: [] };
    const content = { type: "output_text", text: textValue, annotations: [] };
    item.content = [content];
    setOutputItem(textIndex, item);
    yield eventFrame({ type: "response.output_text.done", item_id: textItemId, output_index: textIndex, content_index: 0, text: textValue });
    yield eventFrame({ type: "response.content_part.done", item_id: textItemId, output_index: textIndex, content_index: 0, part: content });
    yield eventFrame({ type: "response.output_item.done", output_index: textIndex, item });
    textItemId = null;
    textIndex = null;
    textValue = "";
  }

  function* closeReasoning(): Generator<Uint8Array> {
    if (reasoningItemId === null || reasoningIndex === null) return;
    const item = outputItems[reasoningIndex] ?? { type: "reasoning", id: reasoningItemId, summary: [] };
    const summary = { type: "summary_text", text: reasoningValue };
    item.summary = [summary];
    setOutputItem(reasoningIndex, item);
    yield eventFrame({ type: "response.reasoning_summary_text.done", item_id: reasoningItemId, output_index: reasoningIndex, summary_index: 0, text: reasoningValue });
    yield eventFrame({ type: "response.content_part.done", item_id: reasoningItemId, output_index: reasoningIndex, content_index: 0, part: summary });
    yield eventFrame({ type: "response.output_item.done", output_index: reasoningIndex, item });
    reasoningItemId = null;
    reasoningIndex = null;
    reasoningValue = "";
  }

  function* closeActive(): Generator<Uint8Array> {
    yield* closeReasoning();
    yield* closeText();
  }

  for await (const event of events) {
    if (event.type === "message_start") {
      id = event.id || id;
      if (!started) {
        started = true;
        yield responseCreated();
      }
      continue;
    }
    if (!started) {
      started = true;
      yield responseCreated();
    }
    if (event.type === "context_item") {
      const item = { ...event.item };
      setOutputItem(event.outputIndex, item);
      yield event.phase === "added" ? outputItemAdded(event.outputIndex, item) : eventFrame({ type: "response.output_item.done", output_index: event.outputIndex, item });
    } else if (event.type === "thinking_delta") {
      if (reasoningItemId === null || reasoningIndex === null) {
        yield* closeText();
        reasoningItemId = `rs_${crypto.randomUUID()}`;
        reasoningIndex = outputItems.length;
        const item = { type: "reasoning", id: reasoningItemId, summary: [] };
        setOutputItem(reasoningIndex, item);
        yield outputItemAdded(reasoningIndex, item);
        yield contentPartAdded(reasoningIndex, reasoningItemId, { type: "summary_text", text: "" });
      }
      reasoningValue += event.text;
      yield eventFrame({ type: "response.reasoning_summary_text.delta", item_id: reasoningItemId, output_index: reasoningIndex, summary_index: 0, delta: event.text });
    } else if (event.type === "text_delta") {
      if (textItemId === null || textIndex === null) {
        yield* closeReasoning();
        textItemId = `msg_${crypto.randomUUID()}`;
        textIndex = outputItems.length;
        const item = { type: "message", id: textItemId, role: "assistant", status: "in_progress", content: [] };
        setOutputItem(textIndex, item);
        yield outputItemAdded(textIndex, item);
        yield contentPartAdded(textIndex, textItemId, { type: "output_text", text: "", annotations: [] });
      }
      textValue += event.text;
      yield eventFrame({ type: "response.output_text.delta", item_id: textItemId, output_index: textIndex, content_index: 0, delta: event.text });
    } else if (event.type === "tool_call_start") {
      yield* closeActive();
      const index = outputItems.length;
      const item = { type: "function_call", id: event.callId, call_id: event.callId, name: event.name, arguments: "" };
      setOutputItem(index, item);
      activeCalls.set(event.callId, { index, item });
      yield outputItemAdded(index, item);
    } else if (event.type === "tool_call_delta") {
      const active = activeCalls.get(event.callId);
      if (active !== undefined) {
        active.item.arguments = `${String(active.item.arguments ?? "")}${event.delta}`;
        yield eventFrame({ type: "response.function_call_arguments.delta", item_id: event.callId, output_index: active.index, delta: event.delta });
      }
    } else if (event.type === "tool_call_end") {
      const active = activeCalls.get(event.callId);
      if (active !== undefined) {
        yield eventFrame({ type: "response.function_call_arguments.done", item_id: event.callId, output_index: active.index, arguments: active.item.arguments ?? "{}" });
        yield eventFrame({ type: "response.output_item.done", output_index: active.index, item: active.item });
        activeCalls.delete(event.callId);
      }
    } else if (event.type === "usage") {
      usage = event.usage;
    } else if (event.type === "message_stop" && !finished) {
      finished = true;
      finalReason = event.reason;
      yield* closeActive();
      for (const [callId, active] of activeCalls) {
        yield eventFrame({ type: "response.function_call_arguments.done", item_id: callId, output_index: active.index, arguments: active.item.arguments ?? "{}" });
        yield eventFrame({ type: "response.output_item.done", output_index: active.index, item: active.item });
      }
      activeCalls.clear();
      const status = responseStatus(event.reason);
      if (status === "failed") {
        yield eventFrame({ type: "response.failed", response: { id, object: "response", status: "failed", output: outputItems, error: { code: event.error?.kind ?? "stream_error", message: event.error?.message ?? "Stream interrupted" } } });
      } else {
        const response: Record<string, unknown> = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status, output: outputItems.filter((item): item is Record<string, unknown> => item !== undefined), output_text: outputItems.filter((item) => item?.type === "message").map((item) => Array.isArray(item.content) ? item.content.filter(isRecord).map((part) => typeof part.text === "string" ? part.text : "").join("") : "").join("") };
        if (usage !== null) response.usage = responseUsage(usage);
        const incompleteReason = responseIncompleteReason(event.reason);
        if (incompleteReason !== undefined) response.incomplete_details = { reason: incompleteReason };
        yield eventFrame({ type: status === "completed" ? "response.completed" : "response.incomplete", response });
      }
      yield encoder.encode("data: [DONE]\n\n");
    }
  }
  if (!finished) {
    yield* closeActive();
    yield eventFrame({ type: "response.incomplete", response: { id, object: "response", model, status: "incomplete", output: outputItems } });
    yield encoder.encode("data: [DONE]\n\n");
  }
}

export async function* encodeSurfaceStream(surface: Surface, events: AsyncIterable<StreamEvent>, model: string): AsyncGenerator<Uint8Array> {
  if (surface === "openai-chat") {
    yield* encodeOpenAIChat(events, model);
    return;
  }
  if (surface === "openai-responses") {
    yield* encodeResponses(events, model);
    return;
  }
  if (surface === "anthropic-messages") {
    yield* encodeAnthropic(events, model);
    return;
  }
  for await (const event of events) yield frame({ data: event });
}

/** Bridges the async encoder to a backpressure-aware web stream. */
export function createSurfaceStream(surface: Surface, events: AsyncIterable<StreamEvent>, model: string): ReadableStream<Uint8Array> {
  const iterator = encodeSurfaceStream(surface, events, model);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
