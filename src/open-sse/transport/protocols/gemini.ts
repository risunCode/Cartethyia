import { AbortCoordinator } from "../abort-coordinator";
import { ProviderAdapterError, readUpstreamError } from "../errors";
import { executeFetch } from "../fetch";
import { lineLimit } from "../sse-decoder";
import { mapSseStream } from "../stream-mapper";
import { readJsonObject } from "../body-reader";
import type { SseEvent, StreamMapper } from "../contracts";
import type { ProviderOutput, ProviderRequest, StreamEvent } from "../../../application/contracts";
import { isRecord } from "../../../application/protocols";
import { buildGeminiPayload, mapGeminiUsage, translateGeminiResponse } from "../../translate/codecs/gemini-generate-content";
import { geminiCandidate, responseParts } from "../../translate/codecs/gemini-generate-content";

/** SSE stream mapper for Gemini-style generateContent streams. */
export function createGeminiGenerateContentStreamMapper(): StreamMapper {
  let started = false;
  let stopped = false;
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
    if (output.thought) events.push({ type: "thinking_delta", text: output.thought });
    if (output.text) events.push({ type: "text_delta", text: output.text });
    for (const call of output.calls) {
      if (!activeCalls.has(call.id)) {
        activeCalls.add(call.id);
        events.push({ type: "tool_call_start", callId: call.id, name: call.name });
      }
      const argumentsText = JSON.stringify(call.args);
      if (argumentsText.length > 0 && argumentsText !== "{}") events.push({ type: "tool_call_delta", callId: call.id, delta: argumentsText });
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

function translateGeminiImageResponse(body: Record<string, unknown>): Record<string, unknown> {
  const { response, parts } = geminiCandidate(body);
  const data: Record<string, unknown>[] = [];
  let revisedPrompt = "";
  for (const part of parts) {
    const inlineData = isRecord(part.inlineData) ? part.inlineData : null;
    if (inlineData !== null && typeof inlineData.data === "string") {
      data.push({ b64_json: inlineData.data, ...(typeof inlineData.mimeType === "string" ? { mime_type: inlineData.mimeType } : {}) });
    }
    if (typeof part.text === "string" && part.text.trim().length > 0) revisedPrompt += `${revisedPrompt.length > 0 ? " " : ""}${part.text.trim()}`;
  }
  return { created: Math.floor(Date.now() / 1000), data, ...(revisedPrompt.length > 0 ? { revised_prompt: revisedPrompt } : {}), ...(typeof response.responseId === "string" ? { id: response.responseId } : {}) };
}

/** Executes a Gemini generateContent request after the provider supplies credentials. */
export async function callGeminiWire(input: ProviderRequest, baseUrl: string, credential: string, userAgent: string | null): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const action = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${baseUrl}/models/${encodeURIComponent(input.target.upstreamModelId)}:${action}`;
  const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
  let streamHandedOff = false;
  try {
    const response = await executeFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: request.stream ? "text/event-stream" : "application/json", "x-goog-api-key": credential, ...(userAgent ? { "user-agent": userAgent } : {}) }, body: JSON.stringify(buildGeminiPayload(request)) }, coordinator, network, input.capture);
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
