import { AbortCoordinator } from "../abort-coordinator";
import { ProviderAdapterError, readUpstreamError } from "../errors";
import { executeFetch } from "../fetch";
import { lineLimit, parseSseData } from "../sse-decoder";
import { mapSseStream } from "../stream-mapper";
import { readJsonObject } from "../body-reader";
import type { SseEvent, StreamMapper } from "../contracts";
import type { ProviderOutput, ProviderRequest, SafeErrorSummary, StopReason, StreamEvent } from "../../../application/contracts";
import { isRecord } from "../../../application/protocols";
import { sanitizeMessage } from "../../../application/contracts";
import { buildChatPayload, mapChatUsage } from "../../translate/codecs/openai-chat";
import { buildResponsesPayload, mapResponsesUsage } from "../../translate/codecs/openai-responses";

// ---------------------------------------------------------------- HTTP execution

/**
 * Executes a Chat Completions wire call (shared with the native adapter,
 * which speaks the same wire format). Streams are decoded through the chat
 * SSE mapper; the coordinator's lifetime is handed off to the stream.
 */
export async function callChatCompletionsWire(
  input: ProviderRequest,
  baseUrl: string,
  headers: Record<string, string>,
  payloadOverrides: Readonly<Record<string, unknown>> = {},
): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const payload = { ...buildChatPayload(request), ...payloadOverrides, model: input.target.upstreamModelId };
  const coordinator = new AbortCoordinator(signal, {
    connectTimeoutMs: request.limits.connectTimeoutMs,
    totalTimeoutMs: request.limits.totalTimeoutMs,
  });
  let streamHandedOff = false;
  try {
    const response = await executeFetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
    if (!response.ok) throw await readUpstreamError(response);
    if (!request.stream) {
      const body = await readJsonObject(response, coordinator);
      const usageRecord = isRecord(body.usage) ? body.usage : null;
      return { mode: "non_stream", body, usage: usageRecord !== null ? mapChatUsage(usageRecord) : undefined };
    }
    if (!response.body) {
      throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Upstream returned an empty stream body", routeScope: "provider" });
    }
    streamHandedOff = true;
    const events = mapSseStream(
      { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
      createOpenAIChatStreamMapper(),
    );
    return { mode: "stream", events };
  } finally {
    if (!streamHandedOff) coordinator.dispose();
  }
}

/**
 * Executes a Responses wire call. Streams are decoded through the responses
 * SSE mapper; the coordinator's lifetime is handed off to the stream.
 */
export async function callResponsesWire(
  input: ProviderRequest,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const payload = buildResponsesPayload(request);
  payload.model = input.target.upstreamModelId;
  const coordinator = new AbortCoordinator(signal, {
    connectTimeoutMs: request.limits.connectTimeoutMs,
    totalTimeoutMs: request.limits.totalTimeoutMs,
  });
  let streamHandedOff = false;
  try {
    const response = await executeFetch(`${baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
    if (!response.ok) throw await readUpstreamError(response);
    if (!request.stream) {
      const body = await readJsonObject(response, coordinator);
      const usageRecord = isRecord(body.usage) ? body.usage : null;
      return { mode: "non_stream", body, usage: usageRecord !== null ? mapResponsesUsage(usageRecord) : undefined };
    }
    if (!response.body) {
      throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Upstream returned an empty stream body", routeScope: "provider" });
    }
    streamHandedOff = true;
    const events = mapSseStream(
      { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
      createOpenAIResponsesStreamMapper(),
    );
    return { mode: "stream", events };
  } finally {
    if (!streamHandedOff) coordinator.dispose();
  }
}

/** Executes OpenAI's hosted Responses image-generation tool for generation/edit requests. */
export async function callHostedImageWire(
  input: ProviderRequest,
  url: string,
  headers: Record<string, string>,
): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const payload = buildResponsesPayload(request);
  payload.model = input.target.upstreamModelId;
  payload.tools = [{ type: "image_generation", action: request.imageOperation === "edit" ? "edit" : "generate", output_format: "webp" }];
  payload.tool_choice = { type: "image_generation" };
  payload.store = false;
  payload.stream = false;
  const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
  try {
    const response = await executeFetch(url, { method: "POST", headers: { ...headers, accept: "application/json" }, body: JSON.stringify(payload) }, coordinator, network, input.capture);
    if (!response.ok) throw await readUpstreamError(response);
    const body = await readJsonObject(response, coordinator);
    const data: Array<Record<string, unknown>> = [];
    let revisedPrompt: string | undefined;
    const output = body.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!isRecord(item) || item.type !== "image_generation_call" || typeof item.result !== "string") continue;
        data.push({ b64_json: item.result });
        if (typeof item.revised_prompt === "string") revisedPrompt = item.revised_prompt;
      }
    }
    if (data.length === 0) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Image provider returned no generated image", retryable: false, routeScope: "provider" });
    const usageRecord = isRecord(body.usage) ? body.usage : null;
    return { mode: "non_stream", body: { created: Math.floor(Date.now() / 1000), data: revisedPrompt === undefined ? data : data.map((entry) => ({ ...entry, revised_prompt: revisedPrompt })) }, usage: usageRecord === null ? undefined : mapResponsesUsage(usageRecord) };
  } finally {
    coordinator.dispose();
  }
}

// ---------------------------------------------------------------- SSE mapping

function deltaString(delta: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = delta[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
function responsesFailureSummary(response: Record<string, unknown> | null): SafeErrorSummary {
  const error = response !== null && isRecord(response.error) ? response.error : null;
  const code = error !== null && typeof error.code === "string" ? error.code : "";
  const message = error !== null && typeof error.message === "string" ? error.message : "Upstream Responses request failed";
  const normalized = code.toLowerCase();
  const kind =
    normalized.includes("rate_limit") ? "provider_rate_limited" :
    normalized.includes("quota") ? "quota_exceeded" :
    normalized.includes("server") || normalized.includes("overload") ? "provider_unavailable" :
    normalized === "authentication_error" ? "authentication_failed" :
    normalized === "permission_error" ? "authorization_denied" :
    normalized === "invalid_request" || normalized === "invalid_prompt" ? "invalid_request" :
    normalized === "max_output_tokens" ? "stream_truncated" :
    "provider_protocol_error";
  return { statusCode: null, kind, message: sanitizeMessage(message), retryAt: null };
}

function mapChatFinishReason(finishReason: string | null): StopReason {
  switch (finishReason) {
    case "length":
      return "length";
    case "tool_calls":
      return "tool_call";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "completed";
  }
}

/**
 * Chat Completions SSE mapper: reasoning deltas (reasoning_content /
 * reasoning / thinking) become thinking_delta, visible output becomes
 * text_delta, tool call argument fragments become tool_call_delta, and the
 * trailing usage chunk (include_usage) becomes a usage event.
 */
export function createOpenAIChatStreamMapper(): StreamMapper {
  let started = false;
  let id: string | null = null;
  let lastFinishReason: string | null = null;
  const toolIdsByIndex = new Map<number, string>();
  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    if (sse.data === "[DONE]") {
      const events: StreamEvent[] = [];
      for (const callId of toolIdsByIndex.values()) events.push({ type: "tool_call_end", callId });
      toolIdsByIndex.clear();
      events.push({ type: "message_stop", reason: mapChatFinishReason(lastFinishReason) });
      return events;
    }
    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) return null;
    const events: StreamEvent[] = [];
    if (typeof parsed.id === "string") id = parsed.id;
    if (!started) {
      events.push({ type: "message_start", id: id ?? `chatcmpl-${crypto.randomUUID()}` });
      started = true;
    }
    const usage = parsed.usage;
    if (isRecord(usage)) events.push({ type: "usage", usage: mapChatUsage(usage) });
    const choices = parsed.choices;
    if (Array.isArray(choices)) {
      const first = choices[0];
      if (isRecord(first)) {
        if (typeof first.finish_reason === "string") lastFinishReason = first.finish_reason;
        const delta = first.delta;
        if (isRecord(delta)) {
          const thinking = deltaString(delta, ["reasoning_content", "reasoning", "thinking"]);
          const content = deltaString(delta, ["content"]);
          if (thinking !== null) events.push({ type: "thinking_delta", text: thinking });
          if (content !== null) events.push({ type: "text_delta", text: content });
          const toolCalls = delta.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const raw of toolCalls) {
              if (!isRecord(raw)) continue;
              const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : 0;
              const fn = isRecord(raw.function) ? raw.function : null;
              const incomingId = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
              const callId = toolIdsByIndex.get(index) ?? incomingId ?? `tool_call_${index}`;
              if (!toolIdsByIndex.has(index)) {
                toolIdsByIndex.set(index, callId);
                const name = fn && typeof fn.name === "string" ? fn.name : "";
                events.push({ type: "tool_call_start", callId, name });
              }
              const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
              if (args.length > 0) events.push({ type: "tool_call_delta", callId, delta: args });
            }
          }
        }
      }
    }
    return events.length > 0 ? events : null;
  };
}

/**
 * Responses API SSE mapper: output_text.delta becomes text_delta, reasoning
 * deltas become thinking_delta, function_call_arguments deltas become
 * tool_call_delta, and the terminal response.completed carries usage and the
 * stop reason.
 */
export function createOpenAIResponsesStreamMapper(): StreamMapper {
  let started = false;
  let id: string | null = null;
  let stopReason: StopReason | null = null;
  const callIds = new Map<number, string>();
  const activeCalls = new Set<string>();
  const emitted = new Set<string>();
  const callAliases = new Map<string, string>();
  const startIfNeeded = (events: StreamEvent[]): StreamEvent[] => {
    if (!started) {
      started = true;
      events.unshift({ type: "message_start", id: id ?? `resp_${crypto.randomUUID()}` });
    }
    return events;
  };
  const resolveCallId = (itemId: string | null, outputIndex: number): string => {
    if (itemId !== null) {
      const alias = callAliases.get(itemId);
      if (alias !== undefined) return alias;
      if (activeCalls.has(itemId)) return itemId;
    }
    const indexed = callIds.get(outputIndex);
    if (indexed !== undefined) return indexed;
    if (itemId !== null && activeCalls.size === 1) {
      const onlyCall = activeCalls.values().next().value;
      if (typeof onlyCall === "string") {
        callAliases.set(itemId, onlyCall);
        return onlyCall;
      }
    }
    return itemId ?? `call_${outputIndex}`;
  };
  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) return null;
    const type = parsed.type;
    if (typeof type !== "string") return null;
    // The guards above return null before any StreamEvent[] allocation; the
    // switch below only allocates an array when a case actually produces events.
    switch (type) {
      case "response.created": {
        const response = parsed.response;
        if (isRecord(response) && typeof response.id === "string") id = response.id;
        if (started) return null;
        started = true;
        return { type: "message_start", id: id ?? `resp_${crypto.randomUUID()}` };
      }
      case "response.output_text.delta": {
        const delta = parsed.delta;
        return typeof delta === "string" && delta.length > 0 ? { type: "text_delta", text: delta } : null;
      }
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const delta = parsed.delta;
        return typeof delta === "string" && delta.length > 0 ? { type: "thinking_delta", text: delta } : null;
      }
      case "response.function_call_arguments.delta": {
        const rawItemId = typeof parsed.item_id === "string" ? parsed.item_id : null;
        const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : -1;
        const delta = typeof parsed.delta === "string" ? parsed.delta : "";
        if (delta.length === 0) return null;
        const callId = resolveCallId(rawItemId, outputIndex);
        emitted.add(callId);
        return { type: "tool_call_delta", callId, delta };
      }
      case "response.output_item.added": {
        const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : -1;
        const item = parsed.item;
        if (isRecord(item) && item.type === "compaction") {
          return startIfNeeded([{ type: "context_item", phase: "added", outputIndex, item }]);
        }
        if (isRecord(item) && item.type === "function_call") {
          const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${outputIndex}`;
          const itemId = typeof item.id === "string" ? item.id : null;
          const name = typeof item.name === "string" ? item.name : "";
          callIds.set(outputIndex, callId);
          if (itemId !== null && itemId !== callId) callAliases.set(itemId, callId);
          activeCalls.add(callId);
          return [...startIfNeeded([{ type: "tool_call_start", callId, name }])];
        }
        return null;
      }
      case "response.output_item.done": {
        const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : -1;
        const item = parsed.item;
        if (isRecord(item) && item.type === "compaction") {
          return startIfNeeded([{ type: "context_item", phase: "done", outputIndex, item }]);
        }
        if (isRecord(item) && item.type === "function_call") {
          const rawItemId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : null;
          const callId = resolveCallId(rawItemId, outputIndex);
          const args = typeof item.arguments === "string" ? item.arguments : "";
          const events: StreamEvent[] = [];
          if (args.length > 0 && !emitted.has(callId)) {
            emitted.add(callId);
            events.push({ type: "tool_call_delta", callId, delta: args });
          }
          if (activeCalls.delete(callId)) events.push({ type: "tool_call_end", callId });
          return events.length > 0 ? startIfNeeded(events) : null;
        }
        return null;
      }
      case "response.incomplete":
        stopReason = "length";
        return null;
      case "response.failed": {
        stopReason = "error";
        const response = isRecord(parsed.response) ? parsed.response : null;
        const events: StreamEvent[] = [];
        for (const callId of activeCalls) events.push({ type: "tool_call_end", callId });
        activeCalls.clear();
        events.push({ type: "message_stop", reason: "error", error: responsesFailureSummary(response) });
        return startIfNeeded(events);
      }
      case "response.usage": {
        const usage = parsed.usage;
        return isRecord(usage) ? { type: "usage", usage: mapResponsesUsage(usage) } : null;
      }
      case "response.completed": {
        const response = parsed.response;
        const events: StreamEvent[] = [];
        if (isRecord(response)) {
          const usage = response.usage;
          if (isRecord(usage)) events.push({ type: "usage", usage: mapResponsesUsage(usage) });
          const status = typeof response.status === "string" ? response.status : "";
          if (stopReason === null) {
            stopReason = status === "completed" ? "completed" : status === "incomplete" ? "length" : "error";
          }
        } else if (stopReason === null) {
          stopReason = "completed";
        }
        for (const callId of activeCalls) events.push({ type: "tool_call_end", callId });
        activeCalls.clear();
        events.push({ type: "message_stop", reason: stopReason });
        return startIfNeeded(events);
      }
      case "response.error": {
        const message = typeof parsed.message === "string" ? parsed.message : "Upstream responses stream errored";
        const code = typeof parsed.code === "string" ? parsed.code : null;
        throw new ProviderAdapterError({
          kind: code === "max_output_tokens" ? "stream_truncated" : "provider_protocol_error",
          message,
          retryable: false,
          routeScope: "provider",
        });
      }
      default:
        return null;
    }
  };
}
