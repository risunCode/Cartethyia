import type { ProviderUsage, StopReason, StreamEvent } from "../../../application/contracts";
import { isRecord, narrowList, narrowRecord, narrowText, nullableNumber } from "../../../application/protocols";
import { ProtocolCodecError } from "../errors";
import type { ResponseDocument } from "../contracts";
import { createReasoningBlock } from "../concerns/reasoning";

function stopReason(value: string | null): StopReason {
  if (value === "max_tokens") return "length";
  if (value === "tool_use") return "tool_call";
  if (value === "compaction") return "compaction";
  if (value === "pause_turn") return "pause_turn";
  if (value === "refusal") return "content_filter";
  return "completed";
}

function usageRecord(value: unknown): ProviderUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = nullableNumber(value.input_tokens);
  const outputTokens = nullableNumber(value.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    cacheReadTokens: nullableNumber(value.cache_read_input_tokens),
    cacheWriteTokens: nullableNumber(value.cache_creation_input_tokens),
    source: "provider",
  };
}

/** Decodes an Anthropic Messages body into canonical response events. */
export function decodeAnthropicResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const content = body.content;
  if (content !== undefined && !Array.isArray(content)) {
    throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "Anthropic response content must be an array", statusCode: 502, routeScope: "provider" });
  }
  const id = narrowText(body.id) ?? `msg_${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  for (const raw of narrowList(content)) {
    const block = narrowRecord(raw);
    if (block === null) continue;
    const type = narrowText(block.type);
    if (type === "text") {
      const text = narrowText(block.text);
      if (text !== null) events.push({ type: "text_delta", text });
    } else if (type === "thinking") {
      const text = narrowText(block.thinking);
      const reasoning = createReasoningBlock({ text: text ?? undefined, raw: block });
      if (reasoning.reasoningText !== undefined) events.push({ type: "thinking_delta", text: reasoning.reasoningText });
    } else if (type === "tool_use") {
      const callId = narrowText(block.id) ?? `toolu_${events.length}`;
      const name = narrowText(block.name) ?? "";
      const input = isRecord(block.input) ? JSON.stringify(block.input) : "{}";
      events.push({ type: "tool_call_start", callId, name }, { type: "tool_call_delta", callId, delta: input }, { type: "tool_call_end", callId });
    } else if (type === "compaction") {
      const text = narrowText(block.content) ?? "";
      events.push({ type: "compaction_start" });
      if (text.length > 0) events.push({ type: "compaction_delta", text });
      events.push({ type: "compaction_stop" });
    } else if (type?.startsWith("server_") === true || type?.endsWith("_tool_result") === true) {
      events.push({ type: "server_tool_result", block });
    }
  }
  const usage = usageRecord(body.usage);
  if (usage !== null) events.push({ type: "usage", usage });
  events.push({ type: "message_stop", reason: stopReason(narrowText(body.stop_reason)) });
  return { sourceSurface: "anthropic-messages", model, events, rawBody: body };
}

/** Maps provider usage for Anthropic transport and response translation. */
export function mapAnthropicUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputTokens = nullableNumber(usage.input_tokens);
  const outputTokens = nullableNumber(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    cacheReadTokens: nullableNumber(usage.cache_read_input_tokens),
    cacheWriteTokens: nullableNumber(usage.cache_creation_input_tokens),
    source: "provider",
  };
}
