import { AbortCoordinator } from "../abort-coordinator";
import { ProviderAdapterError, readUpstreamError } from "../errors";
import { executeFetch } from "../fetch";
import { lineLimit, parseSseData } from "../sse-decoder";
import { mapSseStream } from "../stream-mapper";
import { readJsonObject } from "../body-reader";
import type { SseEvent, StreamMapper } from "../contracts";
import type { ApplicationErrorKind, ProviderCaps, ProviderOutput, ProviderRequest, ProviderUsage, StopReason, StreamEvent } from "../../../application/contracts";
import { isRecord, nullableNumber } from "../../../application/protocols";
import type { ModelCapabilities } from "../../translate/capabilities";
import { buildMessagesPayload } from "../../translate/request/anthropic";
import { classifyCompatibilityRejection, recordCompatibilityFallback, removeCompatibilityProjection } from "../../translate/fallback";
import { mapAnthropicUsage } from "../../translate/response/anthropic";
// ---------------------------------------------------------------- SSE mapping

function mapAnthropicStopReason(stopReason: string): StopReason {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_call";
    case "refusal":
      return "content_filter";
    case "compaction":
      return "compaction";
    case "pause_turn":
      return "pause_turn";
    case "end_turn":
    case "stop_sequence":
    default:
      return "completed";
  }
}

function isNativeAnthropicBlock(block: Record<string, unknown>): boolean {
  const type = block.type;
  return typeof type === "string" && type.startsWith("server_");
}

function isServerToolResultBlock(block: Record<string, unknown>): boolean {
  const type = block.type;
  return typeof type === "string" && type.endsWith("_tool_result");
}

function mapAnthropicStreamError(type: string): { kind: ApplicationErrorKind; retryable: boolean; routeScope: "account" | "provider" } {
  switch (type) {
    case "rate_limit_error":
      return { kind: "provider_rate_limited", retryable: true, routeScope: "account" };
    case "overloaded_error":
    case "api_error":
      return { kind: "provider_unavailable", retryable: true, routeScope: "provider" };
    case "authentication_error":
      return { kind: "authentication_failed", retryable: false, routeScope: "account" };
    case "permission_error":
      return { kind: "authorization_denied", retryable: false, routeScope: "account" };
    case "invalid_request_error":
    case "request_too_large":
    case "not_found_error":
      return { kind: "invalid_request", retryable: false, routeScope: "provider" };
    default:
      return { kind: "provider_protocol_error", retryable: false, routeScope: "provider" };
  }
}

/**
 * Messages SSE mapper: message_start carries the upstream id, thinking and
 * text deltas map to thinking_delta/text_delta, tool input JSON fragments
 * map to tool_call_delta, native server-tool blocks retain their lifecycle
 * and payloads, message_delta emits aggregated usage and pause_turn, and
 * message_stop terminates with the mapped stop reason.
 */
export function createAnthropicMessagesStreamMapper(toolNameTransform: (name: string) => string = (name) => name): StreamMapper {
  let started = false;
  let id: string | null = null;
  let inputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let outputTokens: number | null = null;
  let stopReason: StopReason | null = null;
  const toolIds = new Map<number, string>();
  const nativeBlockIndexes = new Set<number>();
  const compactionBlocks = new Set<number>();
  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) return null;
    const type = parsed.type;
    if (typeof type !== "string") return null;
    switch (type) {
      case "message_start": {
        const message = parsed.message;
        if (isRecord(message)) {
          if (typeof message.id === "string") id = message.id;
          const usage = message.usage;
          if (isRecord(usage)) {
            inputTokens = nullableNumber(usage.input_tokens);
            cacheReadTokens = nullableNumber(usage.cache_read_input_tokens);
            cacheWriteTokens = nullableNumber(usage.cache_creation_input_tokens);
          }
        }
        if (started) return null;
        started = true;
        return { type: "message_start", id: id ?? `msg_${crypto.randomUUID()}` };
      }
      case "content_block_start": {
        const index = nullableNumber(parsed.index) ?? -1;
        const block = parsed.content_block;
        if (isRecord(block) && block.type === "compaction") {
          compactionBlocks.add(index);
          return { type: "compaction_start" };
        }
        if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string") {
          const name = toolNameTransform(typeof block.name === "string" ? block.name : "");
          toolIds.set(index, block.id);
          return { type: "tool_call_start", callId: block.id, name };
        }
        if (isRecord(block) && isServerToolResultBlock(block)) return { type: "server_tool_result", block };
        if (isRecord(block) && isNativeAnthropicBlock(block)) {
          nativeBlockIndexes.add(index);
          return { type: "native_block_start", index, block };
        }
        return null;
      }
      case "content_block_delta": {
        const index = nullableNumber(parsed.index) ?? -1;
        const delta = parsed.delta;
        if (!isRecord(delta)) return null;
        if (delta.type === "compaction_delta") {
          const content = delta.content;
          return compactionBlocks.has(index) && typeof content === "string" && content.length > 0 ? { type: "compaction_delta", text: content } : null;
        }
        if (nativeBlockIndexes.has(index)) return { type: "native_block_delta", index, delta };
        if (delta.type === "text_delta") {
          const text = delta.text;
          return typeof text === "string" && text.length > 0 ? { type: "text_delta", text } : null;
        }
        if (delta.type === "thinking_delta") {
          const thinking = delta.thinking;
          return typeof thinking === "string" && thinking.length > 0 ? { type: "thinking_delta", text: thinking } : null;
        }
        if (delta.type === "input_json_delta") {
          const partial = delta.partial_json;
          const callId = toolIds.get(index);
          return typeof partial === "string" && partial.length > 0 && callId !== undefined ? { type: "tool_call_delta", callId, delta: partial } : null;
        }
        return null;
      }
      case "content_block_stop": {
        const index = nullableNumber(parsed.index) ?? -1;
        if (nativeBlockIndexes.delete(index)) return { type: "native_block_stop", index };
        if (compactionBlocks.delete(index)) return { type: "compaction_stop" };
        const callId = toolIds.get(index);
        if (callId === undefined) return null;
        toolIds.delete(index);
        return { type: "tool_call_end", callId };
      }
      case "message_delta": {
        const delta = parsed.delta;
        if (isRecord(delta) && typeof delta.stop_reason === "string") stopReason = mapAnthropicStopReason(delta.stop_reason);
        const usage = parsed.usage;
        if (isRecord(usage)) outputTokens = nullableNumber(usage.output_tokens);
        const usageEvent = mapAnthropicUsage({
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheWriteTokens,
        });
        return { type: "usage", usage: usageEvent };
      }
      case "message_stop":
        return { type: "message_stop", reason: stopReason ?? "completed" };
      case "error": {
        const error = parsed.error;
        const errorType = isRecord(error) && typeof error.type === "string" ? error.type : "";
        const mapped = mapAnthropicStreamError(errorType);
        const message = isRecord(error) && typeof error.message === "string" ? error.message : "Upstream stream error";
        throw new ProviderAdapterError({
          kind: mapped.kind,
          message,
          retryable: mapped.retryable,
          routeScope: mapped.routeScope,
        });
      }
      default:
        return null;
    }
  };
}


/** Executes an Anthropic Messages request after the provider supplies auth headers. */
export async function callAnthropicWire(
  input: ProviderRequest,
  baseUrl: string,
  headers: Record<string, string>,
  capabilities: ProviderCaps,
  modelCapabilities?: ModelCapabilities,
): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const payload = buildMessagesPayload(request, capabilities, { modelCapabilities });
  payload.model = input.target.upstreamModelId;
  const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
  let streamHandedOff = false;
  try {
    let response = await executeFetch(`${baseUrl}/messages`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
    if (!response.ok) {
      try {
        await readUpstreamError(response);
      } catch (error) {
        const rejection = error instanceof ProviderAdapterError ? classifyCompatibilityRejection(error.toProviderCallError()) : null;
        if (rejection === null || !rejection.retryable || !removeCompatibilityProjection(payload, rejection)) throw error;
        recordCompatibilityFallback(input, rejection);
        response = await executeFetch(`${baseUrl}/messages`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      }
    }
    if (!response.ok) throw await readUpstreamError(response);
    if (!request.stream) {
      const body = await readJsonObject(response, coordinator);
      const usageRecord = isRecord(body.usage) ? body.usage : null;
      return { mode: "non_stream", body, usage: usageRecord !== null ? mapAnthropicUsage(usageRecord) : undefined };
    }
    if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Upstream returned an empty stream body", routeScope: "provider" });
    streamHandedOff = true;
    return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, createAnthropicMessagesStreamMapper()) };
  } finally {
    if (!streamHandedOff) coordinator.dispose();
  }
}
