/**
 * [OpenAI]-compatible /v1/responses response decoder: wire JSON/SSE → canonical events.
 */
import { canonicalTerminal } from "../../protocol/primitives";
import type { CanonicalEvent, CanonicalRequest, ContentPart } from "../../transport/canonical-model";
import { GatewayError } from "../../transport/gateway-error";
import { isRecord, readOutputIndex } from "../primitives";
import { decodeSseEvents } from "../../transport/streaming";
import { gatewayErrorFromStreamError } from "../stream-error-frames";
import { usageFromProvider, readResponsesReasoningDelta } from "../../providers/usage";
import { createToolEmitLedger } from "../../transport/tool-identity";

export function mapResponsesStopReason(
  status: unknown,
  hasToolCall: boolean,
): "stop" | "length" | "tool_use" | "error" | undefined {
  if (status === "completed") return hasToolCall ? "tool_use" : "stop";
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  return undefined;
}


function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The model-facing name the Responses wire uses for computer-use tool calls. */
const COMPUTER_TOOL_NAME = "computer";

/**
 * Maps a `computer_call_output.output` payload onto canonical content parts.
 * Computer outputs carry a screenshot (`image_url`/`url`) or plain text; both
 * must survive the round trip so a replaying client sees the same bytes.
 */
function computerOutputToContent(output: unknown): ContentPart[] {
  if (typeof output === "string") return [{ kind: "text", text: output }];
  if (isRecord(output)) {
    const imageUrl = output["image_url"] ?? output["url"];
    if (typeof imageUrl === "string") {
      return [{ kind: "image", payload: { type: "output_image", image_url: imageUrl } }];
    }
    if (typeof output["text"] === "string") return [{ kind: "text", text: output["text"] }];
  }
  return [{ kind: "text", text: JSON.stringify(output ?? "") }];
}

function detailsCachedTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage["input_tokens_details"];
  if (!isRecord(details)) return undefined;
  return numericField(details["cached_tokens"]);
}

/**
 * The xAI Grok wire (grok Responses adapter) splits usage across
 * lifecycle frames: `response.created` / `response.in_progress` carry the
 * real `input_tokens_details.cached_tokens` (e.g. 145592), while
 * `response.completed` repeats totals with a truncated cached count
 * (commonly 128) — pinned by the grok streaming fixture
 * (`grok.test.ts`). Other OpenAI-compat aggregator bridges repeat the
 * same shape. Keep later totals, keep the largest cached count, and never
 * let a later 0/128 wipe a prior hit.
 */
export function mergeResponsesUsage(
  current: Record<string, unknown> | null | undefined,
  update: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  // Some bridges (CodeBuddy intl) emit `"usage": null` frames; a null update
  // carries no counts and must not reach Object.entries. The parameter type
  // says `null` because that is a real upstream shape, not a caller mistake.
  if (update === undefined || update === null) return current ?? undefined;
  if (current === undefined || current === null) return { ...update };
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (key === "input_tokens_details" || key === "output_tokens_details") continue;
    if (value !== undefined) merged[key] = value;
  }
  const currentCached = detailsCachedTokens(current) ?? 0;
  const updateCached = detailsCachedTokens(update);
  const cached = Math.max(currentCached, updateCached ?? 0);
  const updateDetails = isRecord(update["input_tokens_details"])
    ? update["input_tokens_details"]
    : undefined;
  const currentDetails = isRecord(current["input_tokens_details"])
    ? current["input_tokens_details"]
    : undefined;
  if (updateDetails !== undefined || currentDetails !== undefined || cached > 0) {
    merged["input_tokens_details"] = {
      ...(currentDetails ?? {}),
      ...(updateDetails ?? {}),
      cached_tokens: cached,
    };
  }
  const updateOut = isRecord(update["output_tokens_details"])
    ? update["output_tokens_details"]
    : undefined;
  const currentOut = isRecord(current["output_tokens_details"])
    ? current["output_tokens_details"]
    : undefined;
  if (updateOut !== undefined || currentOut !== undefined) {
    merged["output_tokens_details"] = { ...(currentOut ?? {}), ...(updateOut ?? {}) };
  }
  return merged;
}


export function parseResponsesResponseToEvents(
  json: Record<string, unknown>,
  request: CanonicalRequest,
): CanonicalEvent[] {
  const id = (json["id"] as string) ?? "resp_responses";
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
  const output = (json["output"] as Array<Record<string, unknown>>) ?? [];
  let hasToolCall = false;
  const ledger = createToolEmitLedger();
  for (const item of output) {
    if (item["type"] === "message") {
      const content = (item["content"] as Array<Record<string, unknown>>) ?? [];
      for (const part of content) {
        if (part["type"] === "output_text" && typeof part["text"] === "string") {
          const itemId = typeof item["id"] === "string" ? item["id"] : undefined;
          events.push({
            type: "content_delta",
            sequence_number: events.length + 1,
            response_id: id,
            ...(itemId === undefined ? {} : { item_id: itemId }),
            output_index: output.indexOf(item),
            content: { kind: "text", text: part["text"] },
          });
        }
        if (part["type"] === "refusal" && typeof part["refusal"] === "string") {
          events.push({
            type: "content_delta",
            sequence_number: events.length + 1,
            response_id: id,
            content: { kind: "refusal", text: part["refusal"] },
          });
        }
      }
    } else if (item["type"] === "reasoning") {
      const summaryParts = (item["summary"] as Array<Record<string, unknown>> | undefined) ?? [];
      const summaries = summaryParts
        .map((part, index) => ({
          index,
          text: typeof part["text"] === "string" ? part["text"] : "",
        }))
        .filter((part) => part.text.length > 0);
      const encryptedContent =
        typeof item["encrypted_content"] === "string" ? item["encrypted_content"] : undefined;
      const itemId = typeof item["id"] === "string" ? item["id"] : undefined;
      const outputIndex = output.indexOf(item);
      const emittedSummaries = summaries.length > 0 ? summaries : [{ index: 0, text: "" }];
      for (const [position, summary] of emittedSummaries.entries()) {
        events.push({
          type: "content_delta",
          sequence_number: events.length + 1,
          response_id: id,
          ...(itemId === undefined ? {} : { item_id: itemId }),
          output_index: outputIndex,
          content: {
            kind: "reasoning",
            payload: null,
            ...(summary.text.length > 0 ? { summary: summary.text } : {}),
            summary_index: summary.index,
            ...(position === 0 && encryptedContent !== undefined
              ? { encrypted_content: encryptedContent }
              : {}),
          },
        });
      }
    } else if (item["type"] === "function_call") {
      hasToolCall = true;
      const itemId = typeof item["id"] === "string" ? item["id"] : undefined;
      const rawCallId =
        (item["call_id"] as string) ??
        itemId ??
        // Ids are mandatory on compliant complete items; synthesize a
        // per-slot one anyway so two id-less items never share a call.
        ledger.nextOrphanId("call");
      const name = item["name"] as string;
      const args = (item["arguments"] as string) ?? "";
      // Collapse only normalized id variants or an explicit different-id
      // duplicate. Distinct calls with identical names/arguments are valid.
      if (
        ledger.isDuplicateDefinition(rawCallId, name, args) ||
        !ledger.claimFirstEmission(rawCallId, name, args)
      )
        continue;
      events.push({
        type: "tool_call_delta",
        sequence_number: events.length + 1,
        response_id: id,
        ...(itemId === undefined ? {} : { item_id: itemId }),
        output_index: output.indexOf(item),
        call_id: rawCallId,
        name,
        arguments_delta: args,
      });
    } else if (item["type"] === "computer_call") {
      hasToolCall = true;
      const callId =
        (item["call_id"] as string) ??
        (item["id"] as string) ??
        ledger.nextOrphanId(COMPUTER_TOOL_NAME);
      const actions = Array.isArray(item["actions"])
        ? item["actions"]
        : item["action"] === undefined
          ? []
          : [item["action"]];
      const args = JSON.stringify({ actions });
      if (
        ledger.isDuplicateDefinition(callId, COMPUTER_TOOL_NAME, args) ||
        !ledger.claimFirstEmission(callId, COMPUTER_TOOL_NAME, args)
      )
        continue;
      events.push({
        type: "tool_call_delta",
        sequence_number: events.length + 1,
        response_id: id,
        ...(typeof item["id"] === "string" ? { item_id: item["id"] } : {}),
        output_index: output.indexOf(item),
        call_id: callId,
        name: COMPUTER_TOOL_NAME,
        arguments_delta: args,
      });
    } else if (item["type"] === "computer_call_output") {
      const callId = typeof item["call_id"] === "string" ? item["call_id"] : undefined;
      if (callId !== undefined) {
        events.push({
          type: "tool_result",
          sequence_number: events.length + 1,
          response_id: id,
          call_id: callId,
          content: computerOutputToContent(item["output"]),
        });
      }
    } else if (typeof item["type"] === "string") {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        output_index: output.indexOf(item),
        content: { kind: "extension", name: `responses:${item["type"]}`, payload: item },
      });
    }
  }
  const status = json["status"];
  const usage = json["usage"] as Record<string, unknown> | undefined;
  const respJsonStopReason = mapResponsesStopReason(status, hasToolCall);
  const respJsonProviderStopReason = typeof status === "string" ? status : undefined;
  events.push(
    canonicalTerminal({
      sequenceNumber: events.length + 1,
      responseId: id,
      state: status === "cancelled" ? "aborted" : status === "failed" ? "failed" : "complete",
      stopReason: respJsonStopReason,
      providerStopReason: respJsonProviderStopReason,
      usage: usageFromProvider(usage),
    }),
  );
  return events;
}

export async function* decodeResponsesSseStream(
  body: ReadableStream<Uint8Array>,
  request: CanonicalRequest,
  signal?: AbortSignal,
): AsyncIterable<CanonicalEvent> {
  let seq = 1;
  let status: unknown;
  let rawUsage: Record<string, unknown> | undefined;
  let hasToolCall = false;
  const callInfo = new Map<string, { name?: string; call_id?: string }>();
  // Single emission ledger: one entry per logical call, so a call cannot be
  // defined twice no matter which frame carries it.
  const ledger = createToolEmitLedger();
  // Last function-call id seen on `output_item.added`, both overall and per
  // output slot. Argument deltas reference their call by `item_id`, but
  // backends that omit it (or emit deltas for an item whose `added` frame
  // never arrived) would otherwise collapse into a phantom shared call — the
  // same split this file's chat sibling fixed by per-index id inheritance.
  let lastFunctionCallId: string | undefined;
  const lastFunctionCallIdByOutputIndex = new Map<number, string>();
  // Name per resolved call id, so an argument delta that identified its call
  // only by output slot still carries the tool name to the surface encoder.
  const callNameById = new Map<string, string>();
  // Call ids whose name has already been emitted in a delta. Backends that
  // name a call only on `output_item.done` (after the argument deltas) get a
  // name-only follow-up delta; without this set that recovery would re-fire
  // for every already-named call.
  const namedCalls = new Set<string>();
  yield {
    type: "response_start",
    sequence_number: seq++,
    model: request.model,
  } as CanonicalEvent;
  for await (const sse of decodeSseEvents(body, { signal })) {
    const data = sse.data.trim();
    // [DONE] is the spec'd terminal marker: stop decoding without waiting
    // for TCP close (see chat.ts). Anything after [DONE] is ignored.
    if (data === "[DONE]") break;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch (error: unknown) {
      // Corrupt upstream bytes, not a client mistake (see chat.ts).
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
    const eventType = event["type"];
    // An explicit failure inside a 200 OK. Two shapes carry one: a top-level
    // `type: "error"` frame (the error object itself), and a `response.failed`
    // terminal whose `response.error` explains why. Both used to be recorded
    // only as a `failed` terminal, so the client got no code and telemetry got
    // `unknown_error`; the Claude and Gemini decoders already raised.
    const failedResponse = eventType === "response.failed" && isRecord(event["response"]) ? event["response"] : undefined;
    const streamError = gatewayErrorFromStreamError(
      eventType === "error" ? event : failedResponse?.["error"],
      "upstream returned a failed response",
    );
    if (streamError !== undefined) throw streamError;
    // Responses SSE has three canonical categories:
    //   1. content-bearing deltas       -> canonical content/tool events
    //   2. terminal envelopes           -> drive the synthesized `terminal` frame
    //   3. lifecycle / bookkeeping      -> already subsumed by our synthetic
    //      `response_start` + `terminal` frames; MUST be dropped.
    switch (eventType) {
      case "response.output_text.delta": {
        const delta = event["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: delta },
          } as CanonicalEvent;
        }
        break;
      }
      case "response.reasoning_summary_text.delta": {
        const summary = readResponsesReasoningDelta(event);
        if (typeof summary === "string" && summary.length > 0) {
          const summaryIndex =
            typeof event["summary_index"] === "number" && Number.isInteger(event["summary_index"])
              ? event["summary_index"]
              : 0;
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: {
              kind: "reasoning",
              payload: null,
              summary,
              summary_index: summaryIndex,
            },
          } as CanonicalEvent;
        }
        break;
      }
      case "response.output_item.added": {
        const item = event["item"] as Record<string, unknown> | undefined;
        const addedIndex = readOutputIndex(event);
        if (item?.["type"] === "function_call") {
          const itemId = typeof item["id"] === "string" ? (item["id"] as string) : undefined;
          const itemCallId =
            typeof item["call_id"] === "string" ? (item["call_id"] as string) : undefined;
          // Key distinct id-less items uniquely: a shared literal would let
          // two parallel calls read each other's name/call_id.
          const id = itemId ?? itemCallId ?? ledger.nextOrphanId("call");
          callInfo.set(id, {
            name: item["name"] as string,
            ...(itemCallId === undefined ? {} : { call_id: itemCallId }),
          });
          const resolvedCallId = itemCallId ?? itemId;
          if (resolvedCallId !== undefined) {
            lastFunctionCallId = resolvedCallId;
            if (addedIndex !== undefined)
              lastFunctionCallIdByOutputIndex.set(addedIndex, resolvedCallId);
          }
          const itemName = item["name"];
          if (typeof itemName === "string" && itemName.length > 0 && resolvedCallId !== undefined)
            callNameById.set(resolvedCallId, itemName);
        } else if (item?.["type"] === "computer_call") {
          hasToolCall = true;
          // `added` and `done` must derive the same id for the same call even
          // when the upstream omits call_id/id; the output slot is the only
          // identity both frames share, so fall back to it instead of a
          // literal every parallel call would share.
          const callId =
            (item["call_id"] as string) ??
            (item["id"] as string) ??
            ledger.nextOrphanId(COMPUTER_TOOL_NAME);
          const actions = Array.isArray(item["actions"]) ? item["actions"] : [];
          const args = JSON.stringify({ actions });
          if (ledger.claimFirstEmission(callId, COMPUTER_TOOL_NAME, args)) {
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              ...(typeof item["id"] === "string" ? { item_id: item["id"] } : {}),
              call_id: callId,
              name: COMPUTER_TOOL_NAME,
              arguments_delta: args,
            } as CanonicalEvent;
          }
        } else if (item?.["type"] === "reasoning") {
          const summaryParts =
            (item["summary"] as Array<Record<string, unknown>> | undefined) ?? [];
          const summaries = summaryParts
            .map((part, index) => ({
              index,
              text: typeof part["text"] === "string" ? part["text"] : "",
            }))
            .filter((part) => part.text.length > 0);
          const encryptedContent =
            typeof item["encrypted_content"] === "string" ? item["encrypted_content"] : undefined;
          const itemId = typeof item["id"] === "string" ? item["id"] : undefined;
          const emittedSummaries = summaries.length > 0 ? summaries : [{ index: 0, text: "" }];
          for (const [position, summary] of emittedSummaries.entries()) {
            yield {
              type: "content_delta",
              sequence_number: seq++,
              ...(itemId === undefined ? {} : { item_id: itemId }),
              content: {
                kind: "reasoning",
                payload: null,
                ...(summary.text.length > 0 ? { summary: summary.text } : {}),
                summary_index: summary.index,
                ...(position === 0 && encryptedContent !== undefined
                  ? { encrypted_content: encryptedContent }
                  : {}),
              },
            } as CanonicalEvent;
          }
        }
        break;
      }
      case "response.output_item.done": {
        const item = event["item"] as Record<string, unknown> | undefined;
        if (item?.["type"] === "function_call") {
          // A backend that emits no `response.function_call_arguments.delta`
          // frames (or whose stream is cut before them) still delivers the
          // complete item here. Without this branch the call is never
          // surfaced, so a tool-using turn ends as a plain stop and the
          // client sees the model "stop" instead of calling a tool.
          hasToolCall = true;
          const itemId = typeof item["id"] === "string" ? (item["id"] as string) : undefined;
          const doneIndex = readOutputIndex(event);
          const callId =
            (item["call_id"] as string) ??
            itemId ??
            (doneIndex === undefined ? undefined : lastFunctionCallIdByOutputIndex.get(doneIndex)) ??
            ledger.nextOrphanId("call");
          const args = (item["arguments"] as string) ?? "";
          const name =
            (item["name"] as string) ?? callInfo.get(itemId ?? callId)?.name ?? callNameById.get(callId);
          // A call that already streamed argument deltas keeps its streamed
          // payload; re-emitting the full `arguments` here would duplicate it.
          if (
            !ledger.isDuplicateDefinition(callId, name ?? "", args) &&
            ledger.claimFirstEmission(callId, name, args) &&
            !ledger.hasStreamedArguments(callId)
          ) {
            if (name !== undefined) namedCalls.add(callId);
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              ...(itemId === undefined ? {} : { item_id: itemId }),
              call_id: callId,
              name,
              arguments_delta: args,
            } as CanonicalEvent;
          } else if (
            name !== undefined &&
            ledger.hasStreamedArguments(callId) &&
            !namedCalls.has(callId)
          ) {
            // Late-name recovery: the backend named the call only here, after
            // its argument deltas streamed under the (then-)nameless call id.
            // Emit a name-only delta so the surface encoder can attach the
            // fragments it parked instead of failing the call at terminal.
            namedCalls.add(callId);
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              ...(itemId === undefined ? {} : { item_id: itemId }),
              call_id: callId,
              name,
              arguments_delta: "",
            } as CanonicalEvent;
          }
        } else if (item?.["type"] === "computer_call") {
          const callId =
            (item["call_id"] as string) ??
            (item["id"] as string) ??
            ledger.nextOrphanId(COMPUTER_TOOL_NAME);
          const actions = Array.isArray(item["actions"]) ? item["actions"] : [];
          const args = JSON.stringify({ actions });
          if (
            !ledger.isDuplicateDefinition(callId, COMPUTER_TOOL_NAME, args) &&
            ledger.claimFirstEmission(callId, COMPUTER_TOOL_NAME, args)
          ) {
            hasToolCall = true;
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              ...(typeof item["id"] === "string" ? { item_id: item["id"] } : {}),
              call_id: callId,
              name: COMPUTER_TOOL_NAME,
              arguments_delta: args,
            } as CanonicalEvent;
          }
        } else if (item?.["type"] === "computer_call_output") {
          const callId = typeof item["call_id"] === "string" ? item["call_id"] : undefined;
          if (callId !== undefined) {
            yield {
              type: "tool_result",
              sequence_number: seq++,
              call_id: callId,
              content: computerOutputToContent(item["output"]),
            } as CanonicalEvent;
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        hasToolCall = true;
        const rawItemId = event["item_id"];
        const itemId = typeof rawItemId === "string" && rawItemId.length > 0 ? rawItemId : undefined;
        const deltaIndex = readOutputIndex(event);
        const info = itemId === undefined ? undefined : callInfo.get(itemId);
        // Resolve identity by item id first, then by the output slot the
        // arguments belong to (bridges that drop `item_id` keep
        // `output_index`), and only then by the last-seen call. The final
        // fallback is unique per orphan so parallel calls never merge.
        const callId =
          info?.call_id ??
          itemId ??
          (deltaIndex === undefined ? undefined : lastFunctionCallIdByOutputIndex.get(deltaIndex)) ??
          lastFunctionCallId ??
          ledger.nextOrphanId("call");
        // A continuation, not a call definition: never gated, but it marks
        // the call so a terminal frame does not re-emit the full arguments.
        ledger.markStreamedArguments(callId);
        const deltaName = info?.name ?? callNameById.get(callId);
        if (deltaName !== undefined) namedCalls.add(callId);
        yield {
          type: "tool_call_delta",
          sequence_number: seq++,
          call_id: callId,
          name: deltaName,
          arguments_delta: (event["delta"] as string) ?? "",
        } as CanonicalEvent;
        break;
      }
      case "response.function_call_arguments.done": {
        // Terminal for one call's arguments. A backend may skip the delta
        // frames entirely and emit only this frame with the full `arguments`;
        // surface the call from here so a tool-using turn is never lost.
        hasToolCall = true;
        const rawItemId = event["item_id"];
        const itemId = typeof rawItemId === "string" && rawItemId.length > 0 ? rawItemId : undefined;
        const doneIdx = readOutputIndex(event);
        const rawCallId = event["call_id"];
        const itemInfo = itemId === undefined ? undefined : callInfo.get(itemId);
        const callId =
          (typeof rawCallId === "string" && rawCallId.length > 0 ? rawCallId : undefined) ??
          itemInfo?.call_id ??
          itemId ??
          (doneIdx === undefined ? undefined : lastFunctionCallIdByOutputIndex.get(doneIdx)) ??
          lastFunctionCallId ??
          ledger.nextOrphanId("call");
        const args = (event["arguments"] as string) ?? "";
        const name = itemInfo?.name ?? callInfo.get(callId)?.name ?? callNameById.get(callId);
        if (
          !ledger.isDuplicateDefinition(callId, name ?? "", args) &&
          ledger.claimFirstEmission(callId, name, args) &&
          !ledger.hasStreamedArguments(callId)
        ) {
          if (name !== undefined) namedCalls.add(callId);
          yield {
            type: "tool_call_delta",
            sequence_number: seq++,
            ...(itemId === undefined ? {} : { item_id: itemId }),
            call_id: callId,
            name,
            arguments_delta: args,
          } as CanonicalEvent;
        } else if (
          name !== undefined &&
          ledger.hasStreamedArguments(callId) &&
          !namedCalls.has(callId)
        ) {
          // Same late-name recovery as `output_item.done`: this frame may be
          // the first to carry the name for already-streamed arguments.
          namedCalls.add(callId);
          yield {
            type: "tool_call_delta",
            sequence_number: seq++,
            ...(itemId === undefined ? {} : { item_id: itemId }),
            call_id: callId,
            name,
            arguments_delta: "",
          } as CanonicalEvent;
        }
        break;
      }
      case "response.created":
      case "response.in_progress":
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = isRecord(event["response"]) ? event["response"] : undefined;
        if (
          eventType === "response.completed" ||
          eventType === "response.incomplete" ||
          eventType === "response.failed"
        ) {
          status = response?.["status"] ?? String(eventType).slice("response.".length);
        }
        rawUsage = mergeResponsesUsage(
          rawUsage,
          isRecord(response?.["usage"]) ? response["usage"] : undefined,
        );
        // A backend may report a tool call only here — either because it emits
        // no incremental frames at all, or because it appends a sibling call
        // that never streamed. Without this walk those calls are lost and the
        // turn ends as a plain stop. Only calls that were never emitted are
        // surfaced, so a call already streamed from its own frames is not
        // duplicated.
        const output = response?.["output"];
        if (Array.isArray(output)) {
          for (const raw of output) {
            if (!isRecord(raw) || raw["type"] !== "function_call") continue;
            const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
            // Never emit a nameless definition: that is the exact class of
            // malformed history this file's sibling fix exists to prevent.
            if (name.length === 0) continue;
            const itemId = typeof raw["id"] === "string" ? raw["id"] : undefined;
            const itemCallId = typeof raw["call_id"] === "string" ? raw["call_id"] : undefined;
            // `call_id` is the join key the incremental paths use, so it wins
            // over the item `id` here too — otherwise a recovered call would be
            // identified differently from the same call streamed frame-by-frame.
            const callId = itemCallId ?? itemId ?? ledger.nextOrphanId("call");
            const args = typeof raw["arguments"] === "string" ? raw["arguments"] : "";
            if (!ledger.claimFirstEmission(callId, name, args)) continue;
            hasToolCall = true;
            callNameById.set(callId, name);
            namedCalls.add(callId);
            lastFunctionCallId = callId;
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              ...(itemId === undefined ? {} : { item_id: itemId }),
              call_id: callId,
              name,
              arguments_delta: args,
            } as CanonicalEvent;
          }
        }
        break;
      }
      default:
        // Unknown event types are preserved as extension content (mirroring
        // the non-streaming parser) instead of silently dropped: lifecycle
        // frames the switch already names stay cased above, so anything
        // reaching here is provider-specific content a future wire may need.
        if (typeof eventType === "string") {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "extension", name: `responses:${eventType}`, payload: event },
          } as CanonicalEvent;
        }
        break;
    }
  }
  const responsesStopReason = mapResponsesStopReason(status, hasToolCall);
  const responsesProviderStopReason = typeof status === "string" ? status : undefined;
  // No terminal envelope (response.completed/incomplete/failed) means the
  // stream was truncated. Never report a cut stream as complete.
  const truncated = status === undefined;
  yield canonicalTerminal({
    sequenceNumber: seq++,
    state:
      status === "cancelled" ? "aborted" : status === "failed" || truncated ? "failed" : "complete",
    stopReason: responsesStopReason,
    providerStopReason: responsesProviderStopReason,
    usage: usageFromProvider(rawUsage),
  });
}
