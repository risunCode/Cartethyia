import { AbortCoordinator } from "../abort-coordinator";
import { ProviderAdapterError, readUpstreamError } from "../errors";
import { executeFetch } from "../fetch";
import { lineLimit } from "../sse-decoder";
import { mapSseStream } from "../stream-mapper";
import { readJsonObject } from "../body-reader";
import type { SseEvent, StreamMapper } from "../contracts";
import type { ProviderOutput, ProviderRequest, StreamEvent } from "../../../application/contracts";
import { isRecord } from "../../../application/protocols";
import { buildGeminiPayload } from "../../translate/request/gemini";
import { geminiCandidate, mapGeminiUsage, responseParts, translateGeminiImageResponse, translateGeminiResponse } from "../../translate/response/gemini";

/** SSE stream mapper for Gemini-style generateContent streams. */
export function createGeminiGenerateContentStreamMapper(): StreamMapper {
  let started = false;
  let stopped = false;
  let nextNativeBlockIndex = 0;
  const activeCalls = new Set<string>();
  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    let parsed: unknown;
    try { parsed = JSON.parse(sse.data); } catch { return null; }
    if (!isRecord(parsed)) return null;
    if (isRecord(parsed.error)) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: typeof parsed.error.message === "string" ? parsed.error.message : "Gemini stream returned an error", routeScope: "provider" });
    const { response, candidate, parts } = geminiCandidate(parsed);
    const output = responseParts(parts);
    const events: StreamEvent[] = [];
    if (!started) { started = true; events.push({ type: "message_start", id: typeof response.responseId === "string" ? response.responseId : `gemini-${crypto.randomUUID()}` }); }
    if (output.thought) events.push({ type: "thinking_delta", text: output.thought, ...(output.reasoningSignature === undefined ? {} : { reasoningSignature: output.reasoningSignature }) });
    if (output.text) events.push({ type: "text_delta", text: output.text });
    for (const call of output.calls) {
      if (!activeCalls.has(call.id)) {
        activeCalls.add(call.id);
        events.push({ type: "tool_call_start", callId: call.id, name: call.name, ...(call.reasoningSignature === undefined ? {} : { reasoningSignature: call.reasoningSignature }) });
      }
      const argumentsText = JSON.stringify(call.args);
      if (argumentsText.length > 0 && argumentsText !== "{}") events.push({ type: "tool_call_delta", callId: call.id, delta: argumentsText });
    }
    for (const image of output.images) {
      const index = nextNativeBlockIndex++;
      events.push(
        { type: "native_block_start", index, block: { type: "image", source: { type: "base64", media_type: image.mimeType ?? "image/png", data: image.data } } },
        { type: "native_block_stop", index },
      );
    }
    if (isRecord(parsed.usageMetadata)) {
      const usage = mapGeminiUsage(parsed);
      if (usage.totalTokens !== null || usage.inputTokens !== null || usage.outputTokens !== null) events.push({ type: "usage", usage });
    }
    if (typeof candidate.finishReason === "string" && !stopped) {
      stopped = true;
      for (const callId of activeCalls) events.push({ type: "tool_call_end", callId });
      activeCalls.clear();
      events.push({ type: "message_stop", reason: candidate.finishReason === "MAX_TOKENS" ? "length" : output.calls.length > 0 ? "tool_call" : "completed" });
    }
    return events.length > 0 ? events : null;
  };
}


/** Executes a Gemini generateContent request after the provider supplies credentials. */
export async function callGeminiWire(input: ProviderRequest, baseUrl: string, credential: string): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const action = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${baseUrl}/models/${encodeURIComponent(input.target.upstreamModelId)}:${action}`;
  const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
  let streamHandedOff = false;
  try {
    const response = await executeFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: request.stream ? "text/event-stream" : "application/json", "x-goog-api-key": credential }, body: JSON.stringify(buildGeminiPayload(request)) }, coordinator, network, input.capture);
    if (!response.ok) throw await readUpstreamError(response);
    if (!request.stream) {
      const body = await readJsonObject(response, coordinator);
      const translated = request.sourceSurface === "images" ? translateGeminiImageResponse(body) : translateGeminiResponse(body, input.target.surface, request.model);
      return { mode: "non_stream", body: translated, usage: mapGeminiUsage(body) };
    }
    if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Gemini returned an empty stream body", routeScope: "provider" });
    streamHandedOff = true;
    return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, createGeminiGenerateContentStreamMapper()) };
  } finally {
    if (!streamHandedOff) coordinator.dispose();
  }
}
