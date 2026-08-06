import type { ProviderSurface, ProviderUsage, StopReason, StreamEvent } from "../../domain/contracts";

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
  const input = usageNumber(usage.inputTokens);
  const output = usageNumber(usage.outputTokens);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usageNumber(usage.totalTokens) || input + output,
    input_tokens_details: { cached_tokens: usageNumber(usage.cacheReadTokens) },
    output_tokens_details: { reasoning_tokens: 0 },
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
      yield chunk({}, null, {
        prompt_tokens: usageNumber(event.usage.inputTokens) + usageNumber(event.usage.cacheReadTokens),
        completion_tokens: usageNumber(event.usage.outputTokens),
        total_tokens: usageNumber(event.usage.inputTokens) + usageNumber(event.usage.cacheReadTokens) + usageNumber(event.usage.outputTokens),
        prompt_tokens_details: { cached_tokens: usageNumber(event.usage.cacheReadTokens) },
      });
    } else if (event.type === "message_stop" && !finished) {
      finished = true;
      if (event.reason === "error") {
        yield frame({ data: { error: { message: "Stream interrupted", type: "stream_error" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] } });
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
  let thinkingBlock: number | null = null;
  const toolBlockById = new Map<string, number>();

  const startMessage = (): Uint8Array => frame({ event: "message_start", data: { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
  const stopBlock = (index: number): Uint8Array => frame({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  const closeTextBlocks = function* (): Generator<Uint8Array> {
    if (thinkingBlock !== null) { yield stopBlock(thinkingBlock); thinkingBlock = null; }
    if (textBlock !== null) { yield stopBlock(textBlock); textBlock = null; }
  };

  for await (const event of events) {
    if (event.type === "message_start") {
      id = event.id || id;
      if (!started) { started = true; yield startMessage(); }
      continue;
    }
    if (!started) { started = true; yield startMessage(); }
    if (event.type === "thinking_delta") {
      if (thinkingBlock === null) {
        yield* closeTextBlocks();
        thinkingBlock = ++blockIndex;
        yield frame({ event: "content_block_start", data: { type: "content_block_start", index: thinkingBlock, content_block: { type: "thinking", thinking: "" } } });
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
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: event.callId, name: event.name, input: {} } } });
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
      if (event.reason === "error") {
        yield frame({ event: "error", data: { type: "error", error: { type: "stream_error", message: "Stream interrupted" } } });
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
  let text = "";
  let finalReason: StopReason = "completed";
  let usage: ProviderUsage | null = null;
  const activeCalls = new Set<string>();
  const next = (): number => sequence++;
  const created = (): Uint8Array => frame({ data: { type: "response.created", sequence_number: next(), response: { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress" } } });

  for await (const event of events) {
    if (event.type === "message_start") {
      id = event.id || id;
      if (!started) { started = true; yield created(); }
      continue;
    }
    if (!started) { started = true; yield created(); }
    if (event.type === "text_delta") {
      text += event.text;
      yield frame({ data: { type: "response.output_text.delta", sequence_number: next(), item_id: id, delta: event.text } });
    } else if (event.type === "thinking_delta") {
      yield frame({ data: { type: "response.reasoning_summary_text.delta", sequence_number: next(), item_id: id, delta: event.text } });
    } else if (event.type === "tool_call_start") {
      activeCalls.add(event.callId);
      yield frame({ data: { type: "response.output_item.added", sequence_number: next(), item: { type: "function_call", call_id: event.callId, name: event.name, arguments: "" } } });
    } else if (event.type === "tool_call_delta") {
      activeCalls.add(event.callId);
      yield frame({ data: { type: "response.function_call_arguments.delta", sequence_number: next(), item_id: event.callId, delta: event.delta } });
    } else if (event.type === "tool_call_end") {
      activeCalls.delete(event.callId);
      yield frame({ data: { type: "response.function_call_arguments.done", sequence_number: next(), item_id: event.callId } });
    } else if (event.type === "usage") {
      usage = event.usage;
    } else if (event.type === "message_stop" && !finished) {
      finished = true;
      finalReason = event.reason;
      for (const callId of activeCalls) yield frame({ data: { type: "response.function_call_arguments.done", sequence_number: next(), item_id: callId } });
      activeCalls.clear();
      const status = responseStatus(event.reason);
      if (status === "failed") {
        yield frame({ data: { type: "response.failed", sequence_number: next(), response: { id, object: "response", status: "failed", error: { message: "Stream interrupted" } } } });
      } else {
        const response: Record<string, unknown> = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status, output_text: text };
        if (usage !== null) response.usage = responseUsage(usage);
        const incompleteReason = responseIncompleteReason(event.reason);
        if (incompleteReason !== undefined) response.incomplete_details = { reason: incompleteReason };
        yield frame({ data: { type: status === "completed" ? "response.completed" : "response.incomplete", sequence_number: next(), response } });
      }
      yield encoder.encode("data: [DONE]\n\n");
    }
  }
  if (!finished) {
    const status = responseStatus(finalReason);
    yield frame({ data: { type: status === "failed" ? "response.failed" : "response.incomplete", sequence_number: next(), response: { id, object: "response", model, status } } });
    yield encoder.encode("data: [DONE]\n\n");
  }
}

export async function* encodeSurfaceStream(surface: ProviderSurface, events: AsyncIterable<StreamEvent>, model: string): AsyncGenerator<Uint8Array> {
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
