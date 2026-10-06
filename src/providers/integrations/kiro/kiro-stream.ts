// Kiro EventStream → canonical events.
//
// The upstream streams AWS EventStream messages whose payloads are small JSON
// objects. This module owns what each event type means and how the upstream's
// own stop vocabulary maps onto the canonical one; framing and CRCs belong to
// `aws-event-stream.ts`.
//
// Two upstream behaviours shape the design:
//
//  * Text and reasoning arrive as separate event types, but reasoning can also
//    be embedded in a text event between `<thinking>` markers. The markers are
//    lifted out here so a client never sees them, and a marker split across two
//    events is buffered rather than leaked.
//  * The upstream may report a stop reason in a dedicated event, in the
//    metadata event, or not at all. The canonical stream needs exactly one, so
//    the reasons are merged by severity rather than overwritten by whichever
//    arrived last.

import type { CanonicalStopReason } from "../../../protocol/canonical-model";

/** One parsed event from the upstream, before interpretation. */
export interface KiroRawEvent {
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string | null;
}

/** A delta the adapter should emit. */
export type KiroStreamDelta =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments_delta: string;
    }
  | { readonly kind: "usage"; readonly usage: KiroUsage };

/** Usage the upstream reported, in the units it reported them. */
export interface KiroUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Provider-billed credits, when the metering event carried them. */
  readonly credits?: number;
  /** Context-window usage as a percentage of the model's window. */
  readonly contextUsagePercentage?: number;
}

/** The outcome of feeding one event to the decoder. */
export interface KiroEventOutcome {
  readonly deltas: readonly KiroStreamDelta[];
  /**
   * Set when the upstream reported an explicit stop. The caller records it and
   * emits the terminal event when the stream ends.
   */
  readonly stopReason?: CanonicalStopReason;
  /** Raw upstream stop string, preserved for diagnostics. */
  readonly providerStopReason?: string;
  /** Set when the upstream sent an error/exception message. */
  readonly failure?: { readonly message: string };
}

/** Stop reasons that mean "the model ran out of room", not "it finished". */
const TRUNCATION_REASONS = new Set(["max_tokens", "model_context_window_exceeded"]);

/**
 * Maps the upstream's stop vocabulary onto the canonical one.
 *
 * The upstream is inconsistent about casing and separators (`end_turn`,
 * `endTurn`, `END_TURN` all appear), so normalization happens before matching
 * and an unrecognized value is preserved rather than collapsed to a default —
 * an unknown reason is evidence, and reporting it as `stop` would hide it.
 */
export function normalizeKiroStopReason(raw: string | undefined): CanonicalStopReason | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "end_turn":
    case "endturn":
    case "stop":
    case "stop_sequence":
      return "stop";
    case "tool_use":
    case "tooluse":
    case "tool_calls":
      return "tool_use";
    case "max_tokens":
    case "maxtokens":
    case "max_output_tokens":
    case "length":
    case "model_context_window_exceeded":
      return "length";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "refusal":
      return "refusal";
    default:
      return undefined;
  }
}

/** Whether the raw reason names a truncation. */
export function isKiroTruncationReason(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return TRUNCATION_REASONS.has(raw.trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

/**
 * Stateful decoder for one stream.
 *
 * Stateful because a `<thinking>` marker can be split across two events: the
 * decoder holds back a trailing partial marker instead of emitting it, so the
 * client never sees half a tag.
 */
export class KiroStreamDecoder {
  #inThinking = false;
  #pendingText = "";

  /** Interprets one upstream event. */
  decode(event: KiroRawEvent): KiroEventOutcome {
    const messageType = event.headers[":message-type"];
    if (messageType === "error" || messageType === "exception") {
      const message = stopReasonLikeMessage(parsePayload(event.payload));
      return { deltas: [], failure: { message } };
    }

    const eventType = event.headers[":event-type"] ?? "";
    switch (eventType) {
      case "assistantResponseEvent":
        return { deltas: this.#textDeltas(readString(event.payload, "content")) };
      case "reasoningContentEvent":
        return { deltas: this.#reasoningDeltas(readReasoning(event.payload)) };
      case "codeEvent":
        return { deltas: this.#textDeltas(readString(event.payload, "content")) };
      case "toolUseEvent":
        return { deltas: this.#toolDeltas(event.payload) };
      case "messageStopEvent":
        return stopOutcome(stopReasonOf(unwrap(parsePayload(event.payload))));
      case "metadataEvent":
      case "MetadataEvent":
        return stopOutcome(stopReasonOf(unwrap(parsePayload(event.payload), "metadataEvent", "metadata")));
      case "contextUsageEvent": {
        const percentage = numberField(unwrap(parsePayload(event.payload)), "contextUsagePercentage");
        return percentage === undefined
          ? { deltas: [] }
          : { deltas: [{ kind: "usage", usage: { contextUsagePercentage: percentage } }] };
      }
      case "meteringEvent": {
        const credits = numberField(unwrap(parsePayload(event.payload), "meteringEvent"), "usage");
        return credits === undefined
          ? { deltas: [] }
          : { deltas: [{ kind: "usage", usage: { credits } }] };
      }
      case "metricsEvent": {
        const metrics = unwrap(parsePayload(event.payload), "metricsEvent");
        const inputTokens = numberField(metrics, "inputTokens");
        const outputTokens = numberField(metrics, "outputTokens");
        const cacheReadTokens =
          numberField(metrics, "cacheReadInputTokens") ?? numberField(metrics, "cache_read_input_tokens");
        const cacheWriteTokens =
          numberField(metrics, "cacheCreationInputTokens") ?? numberField(metrics, "cache_creation_input_tokens");
        const usage: KiroUsage = {
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
          ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        };
        return Object.keys(usage).length === 0 ? { deltas: [] } : { deltas: [{ kind: "usage", usage }] };
      }
      default:
        // An unknown event type is not an error: the upstream adds types over
        // time and a stream that carries one is still a valid answer.
        return { deltas: [] };
    }
  }

  /**
   * Emits any text still held back for a possible split marker.
   *
   * Called once the stream ends, because at that point no continuation is
   * coming and holding the bytes back would drop real output.
   */
  flush(): readonly KiroStreamDelta[] {
    const pending = this.#pendingText;
    this.#pendingText = "";
    if (pending.length === 0) return [];
    if (this.#inThinking) return [{ kind: "reasoning", text: pending }];
    return [{ kind: "text", text: pending }];
  }

  /**
   * Splits text around `<thinking>` markers.
   *
   * A trailing `<` or a prefix of the opening/closing tag is held back so a tag
   * split across events is still recognized on the next call.
   */
  #textDeltas(text: string): readonly KiroStreamDelta[] {
    const deltas: KiroStreamDelta[] = [];
    let remaining = this.#pendingText + text;
    this.#pendingText = "";
    for (;;) {
      const marker = this.#inThinking ? "</thinking>" : "<thinking>";
      const index = remaining.indexOf(marker);
      if (index >= 0) {
        const before = remaining.slice(0, index);
        if (before.length > 0) {
          deltas.push(this.#inThinking ? { kind: "reasoning", text: before } : { kind: "text", text: before });
        }
        this.#inThinking = !this.#inThinking;
        remaining = remaining.slice(index + marker.length);
        continue;
      }
      // Hold back a suffix that could be the start of the marker.
      const hold = longestMarkerPrefix(remaining, marker);
      const emit = remaining.slice(0, remaining.length - hold);
      if (emit.length > 0) {
        deltas.push(this.#inThinking ? { kind: "reasoning", text: emit } : { kind: "text", text: emit });
      }
      this.#pendingText = remaining.slice(remaining.length - hold);
      break;
    }
    return deltas;
  }

  #reasoningDeltas(text: string): readonly KiroStreamDelta[] {
    // Reasoning that arrives while a text-side `<thinking>` block is open is
    // still reasoning; the two sources are the same channel.
    return text.length === 0 ? [] : [{ kind: "reasoning", text }];
  }

  #toolDeltas(payload: string | null): readonly KiroStreamDelta[] {
    const parsed = parsePayload(payload);
    if (parsed === undefined) return [];
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const deltas: KiroStreamDelta[] = [];
    for (const value of values) {
      if (value === null || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const callId = typeof record.toolUseId === "string" ? record.toolUseId.trim() : "";
      if (name.length === 0 || callId.length === 0) continue;
      const args = record.input;
      const argumentsDelta =
        typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args);
      deltas.push({ kind: "tool_call", call_id: callId, name, arguments_delta: argumentsDelta });
    }
    return deltas;
  }
}

/** Length of the longest suffix of `text` that prefixes `marker`. */
function longestMarkerPrefix(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function parsePayload(payload: string | null): unknown {
  if (payload === null) return undefined;
  const trimmed = payload.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Unwraps one nesting level of a decoded payload.
 *
 * The upstream wraps a payload's fields under a key named for the event in some
 * versions and sends them at the top level in others, so each of `keys` is tried
 * before falling back to the object itself.
 */
function unwrap(value: unknown, ...keys: string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const nested = record[key];
    if (nested !== undefined && nested !== null) return nested;
  }
  return record;
}

function readString(payload: string | null, key: string): string {
  const value = unwrap(parsePayload(payload));
  if (value === null || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

/**
 * Reads a reasoning event's text.
 *
 * The upstream has sent this payload as a bare string, as `{text}`, and as
 * `{content}` across versions; all three are accepted rather than picking one.
 */
function readReasoning(payload: string | null): string {
  const parsed = parsePayload(payload);
  if (typeof parsed === "string") return parsed;
  const value = unwrap(parsed, "reasoningContentEvent");
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

/** Reads a stop reason out of an already-decoded event object. */
function stopReasonOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const raw = record.stopReason ?? record.stop_reason;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Reads the `message` field an upstream error payload carries. */
function stopReasonLikeMessage(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return "Kiro upstream sent an EventStream error";
}

/**
 * Builds the outcome for an event that only reports a stop reason.
 *
 * The raw string is always preserved; the canonical reason is added only when
 * the vocabulary is recognized, so an unknown reason stays visible as unknown.
 */
function stopOutcome(raw: string | undefined): KiroEventOutcome {
  const canonical = normalizeKiroStopReason(raw);
  return {
    deltas: [],
    ...(raw === undefined ? {} : { providerStopReason: raw }),
    ...(canonical === undefined ? {} : { stopReason: canonical }),
  };
}

/** Reads a numeric field from an already-decoded object. */
function numberField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  const parsed = typeof field === "number" ? field : typeof field === "string" ? Number(field) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
