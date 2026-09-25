/**
 * Claude Messages wire — canonical events: stop-reason mapping, content-block
 * parsing, usage normalization, non-stream conversion, and the SSE stream
 * decoder. Pure data transformation — no network I/O (see
 * `../transport/messages.ts` for the executor).
 */
import { canonicalTerminal } from "../../protocol/primitives";
import { GatewayError } from "../../transport/gateway-error";
import { type CanonicalEvent, type CanonicalRequest, type CanonicalStopReason, type ContentPart, type UsageRecord } from "../../transport/canonical-model";
import { decodeSseEvents } from '../../transport/streaming';
import { usageFromProvider } from '../../providers/usage';
import { mapClaudeStreamError } from '../../protocol/messages-errors';
import {
  finiteNumber,
  stringValue,
  unprefixClaudeToolName,
  type ClaudeWireObject,
  isRecord,
} from '../primitives';

export function mapClaudeStopReason(raw: string): CanonicalStopReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      // Unknown upstream reasons conservatively complete as a normal stop.
      return "stop";
  }
}

export function parseClaudeContent(value: unknown, isOAuth = false): ContentPart {
  if (stringValue(value)) return { kind: "text", text: value };
  if (!isRecord(value))
    return { kind: "extension", name: "messages:unknown", payload: value };
  const type = value.type;
  if (type === "text")
    return { kind: "text", text: stringValue(value.text) ? value.text : "" };
  if (type === "image") return { kind: "image", payload: value };
  if (type === "tool_use") {
    if (!stringValue(value.id) || !stringValue(value.name)) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        "Claude response tool_use is missing id or name",
        {},
        "upstream",
      );
    }
    return {
      kind: "toolCall",
      call_id: value.id,
      name: unprefixClaudeToolName(value.name, isOAuth),
      arguments: value.input ?? {},
      ...(finiteNumber(value.index) ? { index: value.index } : {}),
    };
  }
  if (type === "tool_result") {
    if (!stringValue(value.tool_use_id)) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        "Claude response tool_result is missing tool_use_id",
        {},
        "upstream",
      );
    }
    const content = stringValue(value.content)
      ? value.content
      : Array.isArray(value.content)
        ? value.content.map((content) => parseClaudeContent(content, isOAuth))
        : value.content == null
          ? ""
          : [{ kind: "text" as const, text: String(value.content) }];
    return {
      kind: "toolResult",
      call_id: value.tool_use_id,
      content,
      ...(value.is_error === true ? { is_error: true } : {}),
    };
  }
  if (type === "thinking") {
    const thinking = stringValue(value.thinking) ? value.thinking : "";
    return {
      kind: "reasoning",
      payload: thinking,
      summary: thinking,
      ...(stringValue(value.signature) ? { signature: value.signature } : {}),
    };
  }
  if (type === "redacted_thinking") {
    return { kind: "reasoning", payload: value, opaque: true };
  }
  if (type === "server_tool_use" || type === "search_result") {
    return { kind: "extension", name: type, payload: value };
  }
  return {
    kind: "extension",
    name: stringValue(type) ? `messages:${type}` : "messages:unknown",
    payload: value,
  };
}

export function responseUsage(value: unknown): UsageRecord | undefined {
  return usageFromProvider(value);
}

export function eventContent(
  content: readonly ContentPart[],
  sequence: number,
): { events: CanonicalEvent[]; sequence: number } {
  const events: CanonicalEvent[] = [];
  let next = sequence;
  for (const part of content) {
    if (part.kind === "toolCall") {
      events.push({
        type: "tool_call_delta",
        sequence_number: next++,
        call_id: part.call_id,
        ...(part.index === undefined ? {} : { index: part.index }),
        name: part.name,
        arguments_delta: JSON.stringify(part.arguments),
      });
    } else if (part.kind === "toolResult") {
      const resultContent =
        typeof part.content === "string"
          ? [{ kind: "text" as const, text: part.content }]
          : part.content;
      events.push({
        type: "tool_result",
        sequence_number: next++,
        call_id: part.call_id,
        content: resultContent,
      });
    } else {
      events.push({
        type: "content_delta",
        sequence_number: next++,
        content: part,
      });
    }
  }
  return { events, sequence: next };
}

/** Converts one complete Claude Messages response into canonical events. */
export function claudeResponseToEvents(
  json: Record<string, unknown>,
  request: CanonicalRequest,
  isOAuth = false,
): readonly CanonicalEvent[] {
  const id = stringValue(json.id) ? json.id : "msg_claude";
  const model = stringValue(json.model) ? json.model : request.model;
  const events: CanonicalEvent[] = [
    {
      type: "message_start",
      sequence_number: 1,
      event_id: id,
      model,
    },
  ];
  const blocks = Array.isArray(json.content)
    ? json.content.map((content) => parseClaudeContent(content, isOAuth))
    : [];
  let sequence = 2;
  for (const block of blocks) {
    const result = eventContent([block], sequence);
    events.push(...result.events);
    sequence = result.sequence;
  }
  const reason = stringValue(json.stop_reason) ? json.stop_reason : undefined;
  const usage = responseUsage(json.usage);
  const stopDetails = isRecord(json.stop_details)
    ? (json.stop_details as Record<string, unknown>)
    : undefined;
  const deltaStopDetails = isRecord((json as Record<string, unknown>).delta)
    ? isRecord(
        ((json as Record<string, unknown>).delta as Record<string, unknown>)
          .stop_details,
      )
      ? (((json as Record<string, unknown>).delta as Record<string, unknown>)
          .stop_details as Record<string, unknown>)
      : undefined
    : undefined;
  const effectiveDetails = stopDetails ?? deltaStopDetails;
  events.push(
    canonicalTerminal({
      sequenceNumber: sequence,
      state: "complete",
      stopReason: reason === undefined ? undefined : mapClaudeStopReason(reason),
      providerStopReason: reason,
      stopDetails: effectiveDetails,
      usage,
    }),
  );
  return events;
}

interface ClaudeStreamState {
  readonly calls: Map<number, { call_id: string; name?: string }>;
  stop_reason: string | undefined;
  stop_details: Record<string, unknown> | undefined;
  usage: UsageRecord | undefined;
  /**
   * Raw provider usage fields merged across `message_start.message.usage`
   * (carries input/cache-read/cache-write counts) and `message_delta.usage`
   * (carries the final `output_tokens`) — gap report S8. Anthropic never
   * repeats the input-side fields in `message_delta`, so normalizing only
   * the last-seen `usage` object (the prior behavior) silently dropped
   * cache accounting entirely.
   */
  rawUsage: Record<string, unknown> | undefined;
  sawMessageStop: boolean;
  isOAuth: boolean;
}

function streamEventToCanonical(
  event: ClaudeWireObject,
  state: ClaudeStreamState,
  sequence: number,
): { events: CanonicalEvent[]; sequence: number } {
  const events: CanonicalEvent[] = [];
  let next = sequence;
  const type = event.type;
  if (type === "message_start") {
    const message = isRecord(event.message) ? event.message : undefined;
    const usage =
      message !== undefined && isRecord(message.usage)
        ? message.usage
        : undefined;
    if (usage !== undefined) {
      state.rawUsage = { ...state.rawUsage, ...usage };
      state.usage = responseUsage(state.rawUsage);
    }
    return { events, sequence: next };
  }
  if (type === "content_block_start") {
    const index = finiteNumber(event.index) ? event.index : 0;
    const block = isRecord(event.content_block) ? event.content_block : {};
    if (block.type === "tool_use" && stringValue(block.id)) {
      state.calls.set(index, {
        call_id: block.id,
        ...(stringValue(block.name)
          ? { name: unprefixClaudeToolName(block.name, state.isOAuth) }
          : {}),
      });
      // Anthropic sends `input: {}` as a *placeholder* on content_block_start,
      // with the real arguments arriving as `input_json_delta` fragments.
      // Emitting the placeholder as an argument fragment corrupts the
      // concatenation (`{}{"city":"Jakarta"}` is not valid JSON), so only a
      // genuinely populated object is forwarded; a bridge that really does
      // send complete arguments here still gets them through.
      if (
        isRecord(block.input) &&
        Object.keys(block.input).length > 0
      ) {
        events.push({
          type: "tool_call_delta",
          sequence_number: next++,
          call_id: block.id,
          ...(stringValue(block.name) ? { name: unprefixClaudeToolName(block.name, state.isOAuth) } : {}),
          arguments_delta: JSON.stringify(block.input),
        });
      }
    } else if (
      block.type === "server_tool_use" ||
      block.type === "search_result"
    ) {
      events.push({
        type: "content_delta",
        sequence_number: next++,
        content: parseClaudeContent(block),
      });
    }
    return { events, sequence: next };
  }
  if (type === "content_block_delta") {
    const index = finiteNumber(event.index) ? event.index : 0;
    const delta = isRecord(event.delta) ? event.delta : {};
    if (delta.type === "text_delta") {
      // Empty deltas carry no content; emitting them opens an empty text
      // block downstream (the alternating text/thinking fragmentation).
      if (stringValue(delta.text) && delta.text.length > 0) {
        events.push({
          type: "content_delta",
          sequence_number: next++,
          content: {
            kind: "text",
            text: delta.text,
          },
        });
      }
    } else if (delta.type === "thinking_delta") {
      if (stringValue(delta.thinking) && delta.thinking.length > 0) {
        events.push({
          type: "content_delta",
          sequence_number: next++,
          content: {
            kind: "reasoning",
            payload: delta.thinking,
            summary: delta.thinking,
          },
        });
      }
    } else if (delta.type === "signature_delta") {
      events.push({
        type: "content_delta",
        sequence_number: next++,
        content: {
          kind: "reasoning",
          payload: "",
          signature: stringValue(delta.signature) ? delta.signature : "",
        },
      });
    } else if (delta.type === "input_json_delta") {
      const call = state.calls.get(index);
      events.push({
        type: "tool_call_delta",
        sequence_number: next++,
        call_id: call?.call_id ?? `call-${index}`,
        ...(call?.name === undefined ? {} : { name: call.name }),
        arguments_delta: stringValue(delta.partial_json)
          ? delta.partial_json
          : "",
      });
    } else if (delta.type === "redacted_thinking_delta") {
      events.push({
        type: "content_delta",
        sequence_number: next++,
        content: {
          kind: "reasoning",
          payload: { type: "redacted_thinking", data: delta.data },
          opaque: true,
        },
      });
    }
    return { events, sequence: next };
  }
  if (type === "message_delta") {
    const delta = isRecord(event.delta) ? event.delta : {};
    if (stringValue(delta.stop_reason)) state.stop_reason = delta.stop_reason;
    if (isRecord(delta.stop_details))
      state.stop_details = delta.stop_details as Record<string, unknown>;
    else if (isRecord(event.stop_details))
      state.stop_details = event.stop_details as Record<string, unknown>;
    if (isRecord(event.usage)) {
      state.rawUsage = {
        ...state.rawUsage,
        ...(event.usage as Record<string, unknown>),
      };
      state.usage = responseUsage(state.rawUsage);
    }
    return { events, sequence: next };
  }
  if (type === "message_stop") {
    state.sawMessageStop = true;
    return { events, sequence: next };
  }
  if (type === "ping") {
    events.push({ type: "keepalive", sequence_number: next++ });
  }
  return { events, sequence: next };
}

export async function* parseClaudeSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  isOAuth = false,
): AsyncIterable<CanonicalEvent> {
  const state: ClaudeStreamState = {
    calls: new Map(),
    stop_reason: undefined,
    stop_details: undefined,
    usage: undefined,
    rawUsage: undefined,
    sawMessageStop: false,
    isOAuth,
  };
  let sequence = 1;
  for await (const sse of decodeSseEvents(body, { signal })) {
    // [DONE] is the terminal marker: break without waiting for TCP close.
    if (sse.data.trim() === "[DONE]") break;
    let decoded: unknown;
    try {
      decoded = JSON.parse(sse.data) as unknown;
    } catch {
      throw new GatewayError(
        "platform_unavailable",
        502,
        "Malformed Claude SSE event",
        {},
        "upstream",
      );
    }
    if (!isRecord(decoded))
      throw new GatewayError(
        "platform_unavailable",
        502,
        "Invalid Claude SSE event",
        {},
        "upstream",
      );
    if (sse.event === "error" || decoded.type === "error") {
      const error = isRecord(decoded.error) ? decoded.error : decoded;
      throw mapClaudeStreamError(error);
    }
    const result = streamEventToCanonical(decoded, state, sequence);
    sequence = result.sequence;
    yield* result.events;
  }
  if (!state.sawMessageStop) {
    throw new GatewayError(
      "platform_unavailable",
      502,
      "Claude stream ended before message_stop",
      {},
      "upstream",
    );
  }
  yield canonicalTerminal({
    sequenceNumber: sequence,
    state: "complete",
    stopReason:
      state.stop_reason === undefined ? undefined : mapClaudeStopReason(state.stop_reason),
    providerStopReason: state.stop_reason,
    stopDetails: state.stop_details,
    usage: state.usage,
  });
}
