/**
 * Codex Responses → canonical events (non-stream path) and Codex streaming
 * frame processor. Also owns the shared reasoning-item → `content_delta`
 * helper and the `mapCodexStopReason` decision table that both the
 * non-stream converter and the frame processor depend on.
 *
 * Includes the whitespace-loop safety net that mirrors reference
 * `CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT` — a model stuck
 * emitting only whitespace tool-call-argument deltas would otherwise hang
 * the dispatch loop forever.
 */
import { GatewayError } from "../../transport/gateway-error";
import { type CanonicalEvent, type CanonicalRequest, type CanonicalStopReason } from "../../transport/canonical-model";
import { usageFromProvider, readResponsesReasoningDelta } from '../../providers/usage';
import { canonicalTerminal, decodeCodexToolCallId, isRecord, readOutputIndex } from '../primitives';
import { gatewayErrorFromStreamError } from '../stream-error-frames';

export function mapCodexStopReason(
  status: unknown,
  hasToolCall: boolean,
  endTurn?: unknown,
): CanonicalStopReason | undefined {
  if (typeof status !== "string") return undefined;
  // `in_progress`/`queued` map to `stop` so early snapshots don't stall the
  // canonical terminal.
  if (status === "in_progress" || status === "queued") return "stop";
  if (status === "completed") {
    if (hasToolCall) {
      // For completed tool-use with `end_turn:false`, callers escalate to
      // `pause_turn` after this function; tool_use takes precedence here.
      return "tool_use";
    }
    if (endTurn === false) return "pause_turn" as CanonicalStopReason;
    return "stop";
  }
  if (status === "incomplete") {
    // An incomplete stream that produced a tool call is a tool-use stop, not a
    // length stop; the caller decides executability. A truncated non-tool
    // stream is `length`.
    return hasToolCall ? "tool_use" : "length";
  }
  if (status === "failed" || status === "cancelled") return "error";
  return undefined;
}

function reasoningSummary(item: Record<string, unknown>): string | undefined {
  const summary = item["summary"];
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary)) {
    const texts: string[] = [];
    for (const part of summary) {
      if (typeof part === "string") texts.push(part);
      else if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        texts.push(part.text);
      }
    }
    return texts.filter((t) => t.length > 0).join("\n\n") || undefined;
  }
  return typeof item["content"] === "string" ? item["content"] : undefined;
}

export function reasoningEvent(
  item: Record<string, unknown>,
  sequence_number: number,
): CanonicalEvent {
  const summary = reasoningSummary(item);
  const encrypted = item["encrypted_content"];
  return {
    type: "content_delta",
    sequence_number,
    content: {
      kind: "reasoning",
      payload: summary ?? encrypted ?? "",
      ...(summary === undefined ? {} : { summary }),
      ...(typeof encrypted === "string"
        ? { encrypted_content: encrypted }
        : {}),
      ...(summary === undefined && typeof encrypted === "string"
        ? { opaque: true as const }
        : {}),
    },
  };
}

export function parseCodexResponsesJsonToEvents(
  json: Record<string, unknown>,
  request: CanonicalRequest,
): CanonicalEvent[] {
  const id = (json["id"] as string | undefined) ?? "resp_codex";
  const model = (json["model"] as string | undefined) ?? request.model;
  const events: CanonicalEvent[] = [
    { type: "response_start", sequence_number: 1, event_id: id, model },
  ];
  let seq = 2;

  const output =
    (json["output"] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const item of output) {
    const type = item["type"] as string | undefined;
    if (type === "message") {
      const content = item["content"] as
        | Array<Record<string, unknown>>
        | undefined;
      if (content !== undefined) {
        for (const block of content) {
          const bType = block["type"] as string | undefined;
          if (bType === "output_text" && typeof block["text"] === "string") {
            events.push({
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: block["text"] as string },
            });
          } else if (
            bType === "refusal" &&
            typeof block["refusal"] === "string"
          ) {
            events.push({
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: block["refusal"] as string },
            });
          }
        }
      }
    } else if (type === "reasoning") {
      events.push(reasoningEvent(item, seq++));
    } else if (type === "function_call") {
      const rawCallId =
        (item["call_id"] as string | undefined) ??
        (item["id"] as string | undefined) ??
        "call";
      const decodedCallId = decodeCodexToolCallId(rawCallId);
      events.push({
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: decodedCallId,
        name: (item["name"] as string | undefined) ?? undefined,
        arguments_delta: (item["arguments"] as string | undefined) ?? "",
      } as CanonicalEvent);
    } else if (type === "custom_tool_call") {
      const rawCallId =
        (item["call_id"] as string | undefined) ??
        (item["id"] as string | undefined) ??
        "call";
      const decodedCallId = decodeCodexToolCallId(rawCallId);
      const input = (item["input"] as string | undefined) ?? "";
      events.push({
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: decodedCallId,
        name: (item["name"] as string | undefined) ?? undefined,
        arguments_delta: input,
      } as CanonicalEvent);
    } else if (type === "computer_call") {
      const rawCallId =
        (item["call_id"] as string | undefined) ??
        (item["id"] as string | undefined) ??
        "call";
      const decodedCallId = decodeCodexToolCallId(rawCallId);
      events.push({
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: decodedCallId,
        name: "computer",
        arguments_delta: JSON.stringify((item["action"] as unknown) ?? {}),
      } as CanonicalEvent);
    }
  }
  // Fallback for chat-like shape (choices).
  if (output.length === 0) {
    const choices = json["choices"] as
      | Array<Record<string, unknown>>
      | undefined;
    if (choices !== undefined && choices.length > 0) {
      const first = choices[0];
      if (first !== undefined) {
        const msg = first["message"] as Record<string, unknown> | undefined;
        if (
          msg !== undefined &&
          typeof msg["content"] === "string" &&
          msg["content"].length > 0
        ) {
          events.push({
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: msg["content"] },
          });
        }
      }
    }
  }

  const usage = usageFromProvider(json["usage"]);
  const status =
    typeof json["status"] === "string" ? json["status"] : undefined;
  const hasToolCall = output.some(
    (item) =>
      item["type"] === "function_call" ||
      item["type"] === "custom_tool_call" ||
      item["type"] === "computer_call",
  );
  const endTurn =
    (json["end_turn"] as boolean | undefined) ??
    ((json["response"] as Record<string, unknown> | undefined)?.["end_turn"] as
      | boolean
      | undefined);
  // An incomplete response that produced a tool call is always a tool-use
  // stop; every other incomplete response is a length stop. There is no
  // separate executability gate — the branch that used to scan tool arguments
  // for parseable JSON returned `tool_use` on both outcomes, so the scan and
  // the `incomplete_details.reason` read could not change the result.
  const stopReason = mapCodexStopReason(status, hasToolCall, endTurn);
  let finalStopReason = stopReason;
  if (endTurn === false && stopReason === "stop") {
    finalStopReason = "pause_turn" as CanonicalStopReason;
  }
  events.push(
    canonicalTerminal({
      sequenceNumber: seq++,
      state:
        status === "failed"
          ? "failed"
          : status === "cancelled"
            ? "aborted"
            : "complete",
      stopReason: finalStopReason,
      providerStopReason: status,
      stopDetails: endTurn === false ? { type: "pause_turn" } : undefined,
      usage,
    }),
  );
  return events;
}

type OpenItemEntry = {
  item: Record<string, unknown>;
  blockIndex: number;
  outputIndex?: number | undefined;
  itemId?: string | undefined;
};

/** Shared incremental parser for a single `response.*` frame. */
export class CodexStreamFrameProcessor {
  #seq: number;
  hasToolCall = false;
  terminalStatus: string | undefined;
  terminalUsage: Record<string, unknown> | undefined;
  terminalEndTurn: boolean | undefined;
  terminalIncompleteDetails: unknown | undefined;
  readonly #reasoningDeltaIds = new Set<string>();
  // output_index routing + `output_item.added` registration.
  readonly #openItems = new Map<string, OpenItemEntry>();
  readonly #openItemsByOutputIndex = new Map<number, OpenItemEntry>();
  // Track tool call argument accumulation, read when the terminal event
  // reconciles the streamed arguments against the authoritative ones.
  readonly #toolCallArgs = new Map<string, string[]>();
  // Whitespace-loop guard: a model stuck emitting only whitespace tool-call
  // argument deltas would otherwise hang the dispatch loop forever.
  readonly #whitespaceDeltaTracking = new Map<
    string,
    { count: number; chars: number }
  >();
  static readonly WHITESPACE_DELTA_EVENT_LIMIT = 256;
  static readonly WHITESPACE_DELTA_CHAR_LIMIT = 16 * 1024;
  constructor(startSeq: number) {
    this.#seq = startSeq;
  }

  /**
   * Resolves which tool call a stream delta belongs to.
   *
   * `response.function_call_arguments.delta` / `custom_tool_call_input.delta`
   * frames carry `item_id` and `output_index`, not `call_id` — so defaulting
   * to a literal would make every parallel call share one id and merge their
   * arguments into corrupt JSON. Look the call up in the items registered by
   * `response.output_item.added` instead, and prefer the item id (a unique
   * handle) over a shared literal when the upstream never names the call id.
   */
  #resolveToolIdentity(json: Record<string, unknown>): {
    callId: string;
    name: string | undefined;
  } {
    const itemId =
      typeof json["item_id"] === "string" ? (json["item_id"] as string) : undefined;
    const outputIndex = readOutputIndex(json);
    const entry =
      (itemId === undefined ? undefined : this.#openItems.get(itemId)) ??
      (outputIndex === undefined
        ? undefined
        : this.#openItemsByOutputIndex.get(outputIndex));
    const frameName =
      typeof json["name"] === "string" && (json["name"] as string).length > 0
        ? (json["name"] as string)
        : undefined;
    const entryName = entry === undefined ? undefined : entry.item["name"];
    const name =
      frameName ??
      (typeof entryName === "string" && entryName.length > 0 ? entryName : undefined);
    const rawCallId =
      typeof json["call_id"] === "string" ? (json["call_id"] as string) : undefined;
    if (rawCallId !== undefined)
      return { callId: decodeCodexToolCallId(rawCallId), name };
    const entryCallId = entry === undefined ? undefined : entry.item["call_id"];
    if (typeof entryCallId === "string")
      return { callId: decodeCodexToolCallId(entryCallId), name };
    if (itemId !== undefined) return { callId: itemId, name };
    if (entry?.itemId !== undefined) return { callId: entry.itemId, name };
    if (outputIndex !== undefined) return { callId: `idx_${outputIndex}`, name };
    return { callId: "call", name };
  }

  /**
   * Trips a hard error once a tool call has emitted only whitespace-only
   * argument deltas past the reference's event/char thresholds — a
   * pathological model loop that would otherwise never reach `.done`.
   */
  #checkWhitespaceLoopGuard(key: string, delta: string): void {
    if (delta.trim().length > 0) {
      this.#whitespaceDeltaTracking.delete(key);
      return;
    }
    const prev = this.#whitespaceDeltaTracking.get(key) ?? {
      count: 0,
      chars: 0,
    };
    const next = { count: prev.count + 1, chars: prev.chars + delta.length };
    this.#whitespaceDeltaTracking.set(key, next);
    if (
      next.count > CodexStreamFrameProcessor.WHITESPACE_DELTA_EVENT_LIMIT ||
      next.chars > CodexStreamFrameProcessor.WHITESPACE_DELTA_CHAR_LIMIT
    ) {
      throw new GatewayError(
        "tool_call_loop_detected",
        502,
        "Codex whitespace-loop guard tripped: tool call emitted only whitespace argument deltas past the safety threshold",
        { call_key: key, event_count: next.count, char_count: next.chars },
      );
    }
  }

  /** Returns true once a frame carrying the terminal status/type has been seen. */
  get isDone(): boolean {
    return this.terminalStatus !== undefined;
  }

  /** Processes one parsed `response.*` frame, returning zero or more canonical events. */
  process(json: Record<string, unknown>): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];
    const t = json["type"] as string | undefined;
    if (t === "response.output_item.added") {
      const item = json["item"] as Record<string, unknown> | undefined;
      const outputIndex = readOutputIndex(json);
      const itemId =
        item !== undefined && typeof item["id"] === "string"
          ? (item["id"] as string)
          : undefined;
      const entry: OpenItemEntry = {
        item: item ?? {},
        blockIndex: this.#seq,
        outputIndex,
        itemId,
      };
      if (itemId !== undefined) this.#openItems.set(itemId, entry);
      if (outputIndex !== undefined)
        this.#openItemsByOutputIndex.set(outputIndex, entry);
      // `function_call` items carry no state this decoder needs at `added`
      // time; the arguments arrive through the `.delta`/`.done` events below.
    } else if (
      t === "response.output_text.delta" &&
      typeof json["delta"] === "string" &&
      json["delta"].length > 0
    ) {
      events.push({
        type: "content_delta",
        sequence_number: this.#seq++,
        content: { kind: "text", text: json["delta"] as string },
      } as CanonicalEvent);
    } else if (
      t === "response.refusal.delta" &&
      typeof json["delta"] === "string" &&
      json["delta"].length > 0
    ) {
      events.push({
        type: "content_delta",
        sequence_number: this.#seq++,
        content: { kind: "text", text: json["delta"] as string },
      } as CanonicalEvent);
    } else if (
      t === "response.function_call_arguments.delta" &&
      typeof json["delta"] === "string"
    ) {
      const { callId, name } = this.#resolveToolIdentity(json);
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;
      const key = itemId ?? callId;
      this.#checkWhitespaceLoopGuard(key, json["delta"] as string);
      const chunks = this.#toolCallArgs.get(key) ?? [];
      chunks.push(json["delta"] as string);
      this.#toolCallArgs.set(key, chunks);
      events.push({
        type: "tool_call_delta",
        sequence_number: this.#seq++,
        call_id: callId,
        name,
        arguments_delta: json["delta"] as string,
      } as CanonicalEvent);
      this.hasToolCall = true;
    } else if (
      t === "response.custom_tool_call_input.delta" &&
      typeof json["delta"] === "string"
    ) {
      const { callId, name } = this.#resolveToolIdentity(json);
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;
      const key = itemId ?? callId;
      const chunks = this.#toolCallArgs.get(key) ?? [];
      chunks.push(json["delta"] as string);
      this.#toolCallArgs.set(key, chunks);
      events.push({
        type: "tool_call_delta",
        sequence_number: this.#seq++,
        call_id: callId,
        name,
        arguments_delta: json["delta"] as string,
      } as CanonicalEvent);
      this.hasToolCall = true;
    } else if (
      t === "response.reasoning_summary_text.delta" &&
      typeof json["delta"] === "string"
    ) {
      const summary = readResponsesReasoningDelta(json);
      if (summary !== undefined) {
        events.push(reasoningEvent({ summary }, this.#seq++));
        const reasoningItemId =
          typeof json["item_id"] === "string" ? json["item_id"] : undefined;
        if (reasoningItemId !== undefined)
          this.#reasoningDeltaIds.add(reasoningItemId);
      }
    } else if (
      t === "response.reasoning_text.delta" &&
      typeof json["delta"] === "string"
    ) {
      events.push(reasoningEvent({ summary: json["delta"] }, this.#seq++));
    } else if (t === "response.function_call_arguments.done") {
      const rawCallId =
        (json["call_id"] as string | undefined) ??
        (json["item_id"] as string | undefined);
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;
      let key: string | undefined;
      if (itemId !== undefined) key = itemId;
      else if (rawCallId !== undefined) key = decodeCodexToolCallId(rawCallId);
      else {
        const outputIndex = readOutputIndex(json);
        if (outputIndex !== undefined) key = `idx_${outputIndex}`;
      }
      const finalArgs = (json as Record<string, unknown>)["arguments"];
      if (typeof finalArgs === "string" && key !== undefined) {
        this.#toolCallArgs.set(key, [finalArgs]);
      }
      this.hasToolCall = true;
    } else if (t === "response.custom_tool_call_input.done") {
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;
      const rawCallId = (json["call_id"] as string | undefined) ?? itemId;
      let key: string | undefined;
      if (itemId !== undefined) key = itemId;
      else if (rawCallId !== undefined) key = decodeCodexToolCallId(rawCallId);
      const finalInput = (json as Record<string, unknown>)["input"];
      if (typeof finalInput === "string" && key !== undefined)
        this.#toolCallArgs.set(key, [finalInput]);
      this.hasToolCall = true;
    } else if (t === "response.output_item.done") {
      const item = json["item"];
      if (item && typeof item === "object") {
        const outputItem = item as Record<string, unknown>;
        const outputItemId =
          typeof outputItem["id"] === "string" ? outputItem["id"] : undefined;
        const outputIndex = readOutputIndex(json);
        const encrypted = outputItem["encrypted_content"];
        if (outputItem["type"] === "reasoning") {
          const summaryAlreadyStreamed =
            outputItemId !== undefined && this.#reasoningDeltaIds.has(outputItemId);
          if (typeof encrypted === "string" && summaryAlreadyStreamed) {
            events.push(
              reasoningEvent({ encrypted_content: encrypted }, this.#seq++),
            );
          } else if (!summaryAlreadyStreamed) {
            events.push(reasoningEvent(outputItem, this.#seq++));
          }
        }
        if (outputItem["type"] === "function_call") {
          this.hasToolCall = true;
          const callIdRaw =
            typeof outputItem["call_id"] === "string"
              ? (outputItem["call_id"] as string)
              : undefined;
          const decodedCallId =
            callIdRaw !== undefined
              ? decodeCodexToolCallId(callIdRaw)
              : undefined;
          const authoritative =
            typeof outputItem["arguments"] === "string"
              ? (outputItem["arguments"] as string)
              : undefined;
          if (authoritative !== undefined && decodedCallId !== undefined) {
            const key = outputItemId ?? decodedCallId;
            this.#toolCallArgs.set(key, [authoritative]);
          }
          if (outputItemId !== undefined) this.#openItems.delete(outputItemId);
          if (outputIndex !== undefined)
            this.#openItemsByOutputIndex.delete(outputIndex);
        } else if (outputItem["type"] === "custom_tool_call") {
          this.hasToolCall = true;
          const callIdRaw =
            typeof outputItem["call_id"] === "string"
              ? (outputItem["call_id"] as string)
              : undefined;
          const decodedCallId =
            callIdRaw !== undefined
              ? decodeCodexToolCallId(callIdRaw)
              : undefined;
          const authoritative =
            typeof outputItem["input"] === "string"
              ? (outputItem["input"] as string)
              : undefined;
          if (authoritative !== undefined && decodedCallId !== undefined) {
            const key = outputItemId ?? decodedCallId;
            this.#toolCallArgs.set(key, [authoritative]);
          }
          if (outputItemId !== undefined) this.#openItems.delete(outputItemId);
          if (outputIndex !== undefined)
            this.#openItemsByOutputIndex.delete(outputIndex);
        } else if (outputItem["type"] === "computer_call") {
          this.hasToolCall = true;
          if (outputItemId !== undefined) this.#openItems.delete(outputItemId);
          if (outputIndex !== undefined)
            this.#openItemsByOutputIndex.delete(outputIndex);
        } else {
          if (outputItemId !== undefined) this.#openItems.delete(outputItemId);
          if (outputIndex !== undefined)
            this.#openItemsByOutputIndex.delete(outputIndex);
        }
      }
    } else if (
      t === "response.completed" ||
      t === "response.incomplete" ||
      t === "response.failed" ||
      t === "response.cancelled" ||
      t === "response.done"
    ) {
      this.terminalStatus = t.slice("response.".length);
      const response = json["response"];
      if (response && typeof response === "object") {
        const responseObj = response as Record<string, unknown>;
        if (typeof responseObj["status"] === "string")
          this.terminalStatus = responseObj["status"];
        if (responseObj["usage"] && typeof responseObj["usage"] === "object") {
          this.terminalUsage = responseObj["usage"] as Record<string, unknown>;
        }
        if ("end_turn" in responseObj)
          this.terminalEndTurn = responseObj["end_turn"] as boolean | undefined;
        if ("incomplete_details" in responseObj)
          this.terminalIncompleteDetails = responseObj["incomplete_details"];
      }
      if ("end_turn" in json)
        this.terminalEndTurn = json["end_turn"] as boolean | undefined;
      if (
        "incomplete_details" in json &&
        this.terminalIncompleteDetails === undefined
      )
        this.terminalIncompleteDetails = json["incomplete_details"];
    } else if (t === "response.metadata") {
      // Header capture happens in the dispatch loop via
      // `captureSessionHeadersFromResponse`; no canonical event to emit.
    } else if (t === "error") {
      // An explicit error frame inside a 200 OK is an upstream failure, not a
      // truncated stream: classify it so the client receives a code instead of
      // a bare `failed` terminal. `response.error` carries the detail when the
      // frame is a `response.failed`-style envelope.
      const streamError = gatewayErrorFromStreamError(
        json["error"] ?? (isRecord(json["response"]) ? json["response"]["error"] : undefined),
        "upstream returned an error frame",
      );
      if (streamError !== undefined) throw streamError;
      this.terminalStatus = "failed";
    } else if (typeof json["delta"] === "string" && json["delta"].length > 0) {
      events.push({
        type: "content_delta",
        sequence_number: this.#seq++,
        content: { kind: "text", text: json["delta"] as string },
      } as unknown as CanonicalEvent);
    } else {
      const choices = json["choices"] as
        | Array<Record<string, unknown>>
        | undefined;
      if (choices !== undefined) {
        for (const ch of choices) {
          const delta = ch["delta"] as Record<string, unknown> | undefined;
          if (
            typeof delta?.["content"] === "string" &&
            delta["content"].length > 0
          ) {
            events.push({
              type: "content_delta",
              sequence_number: this.#seq++,
              content: { kind: "text", text: delta["content"] },
            } as CanonicalEvent);
          }
        }
      }
    }
    return events;
  }

  /** Builds the terminal canonical event once the stream has ended. */
  terminalEvent(): CanonicalEvent {
    // An incomplete terminal always promotes to tool_use when any tool call
    // was seen, so no separate executability scan is needed here.
    const effectiveHasToolCall = this.hasToolCall;
    let stopReason = mapCodexStopReason(
      this.terminalStatus,
      effectiveHasToolCall,
      this.terminalEndTurn,
    );
    if (this.terminalEndTurn === false && stopReason === "stop") {
      stopReason = "pause_turn" as CanonicalStopReason;
    }
    const usage = usageFromProvider(this.terminalUsage);
    return canonicalTerminal({
      sequenceNumber: this.#seq++,
      // No terminal status means the stream ended without a terminal frame
      // (truncated). A cut stream must never report complete.
      state:
        this.terminalStatus === "failed" || this.terminalStatus === undefined
          ? "failed"
          : this.terminalStatus === "cancelled"
            ? "aborted"
            : "complete",
      stopReason,
      providerStopReason: this.terminalStatus,
      stopDetails:
        this.terminalEndTurn === false ? { type: "pause_turn" } : undefined,
      usage,
    });
  }
}
