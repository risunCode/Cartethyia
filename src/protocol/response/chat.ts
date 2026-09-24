/**
 * [OpenAI]-compatible /chat/completions response decoder: wire JSON/SSE → canonical events.
 */
import { canonicalTerminal } from "../../protocol/primitives";
import { GatewayError } from "../../transport/gateway-error";
import { type CanonicalEvent, type CanonicalRequest } from "../../transport/canonical-model";
import { decodeSseEvents } from "../../transport/streaming";
import { gatewayErrorFromStreamError } from "../stream-error-frames";
import { mergeResponsesUsage } from "./responses";
import { normalizeUsage, readReasoningText } from "../../providers/usage";
import { createToolEmitLedger } from "../../transport/tool-identity";

export function mapChatStopReason(
  reason: unknown,
): "stop" | "length" | "tool_use" | "content_filter" | undefined {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "content_filter") return "content_filter";
  return undefined;
}

export function parseChatResponseToEvents(
  json: Record<string, unknown>,
  request: CanonicalRequest,
): CanonicalEvent[] {
  const id = (json["id"] as string) ?? "resp_chat";
  const model = (json["model"] as string) ?? request.model;
  const systemFingerprint =
    typeof json["system_fingerprint"] === "string" ? json["system_fingerprint"] : undefined;
  const events: CanonicalEvent[] = [
    {
      type: "response_start",
      sequence_number: 1,
      event_id: id,
      model,
      ...(systemFingerprint === undefined ? {} : { system_fingerprint: systemFingerprint }),
    },
  ];
  const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.["message"] as Record<string, unknown> | undefined;
  if (message) {
    const reasoning = readReasoningText(message);
    if (typeof reasoning === "string" && reasoning.length > 0) {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        // `reasoning_content` is the readable reasoning stream (Responses
        // `reasoning_text`), not a summary — keep it in `payload` only.
        content: { kind: "reasoning", payload: reasoning },
      });
    }
    const content = message["content"] as string | null;
    if (content) {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        content: { kind: "text", text: content },
      });
    }
    const refusal = message["refusal"];
    if (typeof refusal === "string" && refusal.length > 0) {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        content: { kind: "refusal", text: refusal },
      });
    }
    const toolCalls = message["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc["function"] as Record<string, unknown> | undefined;
        const itemId = typeof tc["id"] === "string" ? tc["id"] : undefined;
        events.push({
          type: "tool_call_delta",
          sequence_number: events.length + 1,
          response_id: id,
          ...(itemId === undefined ? {} : { item_id: itemId }),
          call_id: tc["id"] as string,
          name: fn?.["name"] as string,
          arguments_delta: fn?.["arguments"] as string,
        });
      }
    }
    // Audio output (`modalities: ["audio"]`) rides on `message.audio`; carry it
    // as an extension part so the Chat encoder can re-emit the same object.
    const audio = message["audio"];
    if (audio !== null && typeof audio === "object") {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        content: { kind: "extension", name: "audio", payload: audio },
      });
    }
  }
  const rawUsage = json["usage"] as Record<string, unknown> | undefined;
  const usageRecord = normalizeUsage(
    rawUsage
      ? {
          ...rawUsage,
          input_tokens: rawUsage["input_tokens"] ?? rawUsage["prompt_tokens"],
          output_tokens: rawUsage["output_tokens"] ?? rawUsage["completion_tokens"],
        }
      : {},
  );
  const providerStopReason = first?.["finish_reason"];
  const chatJsonStopReason = mapChatStopReason(providerStopReason);
  const chatJsonProviderStopReason =
    typeof providerStopReason === "string" ? providerStopReason : undefined;
  events.push(
    canonicalTerminal({
      sequenceNumber: events.length + 1,
      responseId: id,
      state: "complete",
      stopReason: chatJsonStopReason,
      providerStopReason: chatJsonProviderStopReason,
      usage: usageRecord,
    }),
  );
  return events;
}

export async function* decodeChatSseStream(
  body: ReadableStream<Uint8Array>,
  request: CanonicalRequest,
  signal?: AbortSignal,
): AsyncIterable<CanonicalEvent> {
  let seq = 1;
  let finishReason: unknown;
  let rawUsage: Record<string, unknown> | undefined;
  // Last seen tool-call id (and name) per wire index. OpenAI streams the id
  // (and name) only on the first fragment of each call; later fragments carry
  // just `function.arguments`. Without this memory every continuation fragment
  // becomes a separate phantom call downstream. A fragment that carries a
  // *different* name than the recorded call at its index starts a new call
  // (sequential index reuse) instead of merging into the old one. Bridges that
  // omit `index` on every fragment still have one signal left — the most
  // recent call — so that is the fallback before declaring a fragment orphaned.
  const lastToolIdByIndex = new Map<number, string>();
  const lastToolNameByIndex = new Map<number, string>();
  let lastSeenToolId: string | undefined;
  let lastSeenToolName: string | undefined;
  // Single emission ledger: one entry per logical call.
  const ledger = createToolEmitLedger();
  yield {
    type: "response_start",
    sequence_number: seq++,
    model: request.model,
  } as CanonicalEvent;
  for await (const sse of decodeSseEvents(body, { signal })) {
    const data = sse.data.trim();
    // [DONE] is the spec'd terminal marker: stop decoding without waiting
    // for TCP close. Waiting (continue) deadlocks gated bridges where the
    // close itself depends on our terminal event; anything after [DONE] is
    // malformed and ignored.
    if (data === "[DONE]") break;
    if (!data) continue;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      // An explicit error envelope inside a 200 OK is an upstream failure that
      // arrived after the status line. Recording it only as a `failed` terminal
      // left the client with no code and telemetry with `unknown_error`, so the
      // frame is raised as a typed error like the Claude and Gemini decoders
      // already do. `{error: {...}}` is the documented shape; a top-level
      // `type: "error"` frame carries the error object itself.
      const streamError = gatewayErrorFromStreamError(
        json["error"] ?? (json["type"] === "error" ? json : undefined),
        "upstream returned an error frame",
      );
      if (streamError !== undefined) throw streamError;
      // Merge, don't overwrite: split-usage bridges (xAI pattern: prompt
      // tokens early, totals late) would otherwise lose prompt/cache counts.
      rawUsage = mergeResponsesUsage(
        rawUsage,
        json["usage"] as Record<string, unknown> | undefined,
      );
      const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
      for (const choice of choices) {
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        // Empty-string deltas are keepalive/placeholder frames some bridges
        // emit between real chunks. Forwarding them as content is not
        // cosmetic: downstream surface encoders open a block per content
        // event, so a run of empty text deltas interleaved with empty
        // reasoning deltas fragments one answer into alternating
        // text/thinking blocks.
        if (typeof delta?.["content"] === "string" && delta["content"].length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: delta["content"] },
          } as CanonicalEvent;
        }
        const reasoningText = delta ? readReasoningText(delta) : undefined;
        if (typeof reasoningText === "string" && reasoningText.length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "reasoning", payload: null, summary: reasoningText },
          } as CanonicalEvent;
        }
        const calls = (delta?.["tool_calls"] as Array<Record<string, unknown>>) ?? [];
        for (const call of calls) {
          const fn = call["function"] as Record<string, unknown> | undefined;
          // A missing or non-integer index carries no routing information:
          // only a validated integer may join fragments, otherwise fragments
          // would collapse onto call 0 (some bridges omit `index` or send
          // floats). `trackToolCall` downstream pins unknown indexes by id.
          const rawIndex = call["index"];
          const index =
            typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0
              ? rawIndex
              : undefined;
          const rawId = call["id"];
          const realId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;
          const rawName = fn?.["name"];
          const fragName = typeof rawName === "string" && rawName.length > 0 ? rawName : undefined;
          // Name compatibility decides whether an id-less fragment continues
          // the call already known at its index (or, when the bridge omits
          // `index` entirely, the most recent call) or starts a new one.
          const indexName = index === undefined ? undefined : lastToolNameByIndex.get(index);
          const indexId = index === undefined ? undefined : lastToolIdByIndex.get(index);
          const inheritable =
            fragName === undefined ||
            (index === undefined ? lastSeenToolName : indexName) === undefined ||
            fragName === (index === undefined ? lastSeenToolName : indexName);
          let id: string;
          // Index emitted downstream only when the wire index genuinely
          // identifies this call (an explicit id at that index). Inherited
          // and orphaned fragments omit it so the tracker pins them by id
          // memory; re-emitting the shared wire index would overwrite the
          // first call's slot in the index-keyed materializer.
          let emitIndex: number | undefined;
          let establishedNew = false;
          if (realId !== undefined) {
            id = realId;
            emitIndex = index;
            establishedNew = true;
          } else if (index !== undefined && indexId !== undefined && inheritable) {
            id = indexId;
          } else if (index === undefined && lastSeenToolId !== undefined && inheritable) {
            id = lastSeenToolId;
          } else {
            // Same index with a different (or first-seen) name, or no identity
            // to inherit: a new call. Split instead of concatenating two JSON
            id = ledger.nextOrphanId(index === undefined ? "call" : `call-${index}-frag`);
            establishedNew = true;
          }
          lastSeenToolId = id;
          if (fragName !== undefined) lastSeenToolName = fragName;
          if (index !== undefined) {
            // A continuation must not erase the name recorded for its call;
            // only a newly established call (or a fragment that restates the
            // name) rewrites the index memory.
            if (establishedNew) lastToolIdByIndex.set(index, id);
            if (fragName !== undefined) lastToolNameByIndex.set(index, fragName);
            else if (establishedNew) lastToolNameByIndex.delete(index);
          }
          const rawArgs = fn?.["arguments"];
          const args = typeof rawArgs === "string" ? rawArgs : "";
          // Only a *second identity* carrying the same name and full arguments
          // is a duplicate definition. A repeat of the same id is a
          // continuation fragment and must always yield its delta.
          const duplicate =
            establishedNew &&
            fragName !== undefined &&
            ledger.isDuplicateDefinition(id, fragName, args);
          if (!duplicate) {
            if (establishedNew) ledger.claimFirstEmission(id, fragName, args);
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              call_id: id,
              ...(emitIndex === undefined ? {} : { index: emitIndex }),
              ...(fragName === undefined ? {} : { name: fragName }),
              arguments_delta: args,
            } as CanonicalEvent;
          }
        }
        const audioDelta = delta?.["audio"];
        if (audioDelta !== null && typeof audioDelta === "object") {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "extension", name: "audio", payload: audioDelta },
          } as CanonicalEvent;
        }
        finishReason = choice["finish_reason"] ?? finishReason;
      }
    } catch (error: unknown) {
      // A typed upstream error is not a decode failure — rethrow it so the
      // classified code (quota, overload, context length) survives.
      if (error instanceof GatewayError) throw error;
      // Corrupt upstream bytes, not a client mistake: `invalid_request` made
      // the client retry an identical request against the same broken stream.
      throw new GatewayError(
        "platform_unavailable",
        502,
        error instanceof Error
          ? `Malformed SSE event: ${error.message}`
          : "Malformed SSE event",
        {},
        "upstream",
      );
    }
  }
  const chatStopReason = mapChatStopReason(finishReason);
  const chatProviderStopReason =
    typeof finishReason === "string" ? finishReason : undefined;
  // A stream that ends without any finish_reason was truncated (TCP cut,
  // upstream died mid-body). It must never bill as a success: report failed
  // so telemetry, usage, and health all record the failure.
  const truncated = finishReason === undefined;
  yield canonicalTerminal({
    sequenceNumber: seq++,
    state: signal?.aborted
      ? "aborted"
      : finishReason === "error" || finishReason === "failed" || truncated
        ? "failed"
        : "complete",
    stopReason: chatStopReason,
    providerStopReason: chatProviderStopReason,
    usage: normalizeUsage(rawUsage ?? {}),
  });
}
