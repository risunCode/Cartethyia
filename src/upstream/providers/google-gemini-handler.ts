import { parseSSEStream } from "../sse";
import type { StreamEvent } from "../bridge";
import { ProviderCallError } from "./errors";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Decodes Cloud Code Assist SSE frames into Cartethyia's provider event stream. */
export async function* decodeGoogleGeminiStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  for await (const frame of parseSSEStream(body)) {
    let parsed: unknown;
    try { parsed = JSON.parse(frame.data) as unknown; } catch { continue; }
    const root = asRecord(parsed);
    const upstreamError = asRecord(root?.error);
    if (upstreamError) {
      const message = typeof upstreamError.message === "string" ? upstreamError.message : "Antigravity returned an upstream stream error.";
      const code = typeof upstreamError.code === "number" ? upstreamError.code : 502;
      const kind = code === 401 || code === 403 ? "authentication" : code === 429 ? "rate_limited" : code >= 500 ? "unavailable" : "invalid_request";
      throw new ProviderCallError(code, kind, `Antigravity: ${message}`);
    }
    const response = asRecord(root?.response) ?? root;
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    const candidate = asRecord(candidates[0]);
    const content = asRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (typeof part?.thoughtSignature === "string" && part.thoughtSignature.length > 0) yield { type: "thinking_signature", signature: part.thoughtSignature };
      if (typeof part?.text === "string" && part.text.length > 0) {
        yield part.thought === true ? { type: "thinking_delta", text: part.text } : { type: "text_delta", text: part.text };
      }
      const functionCall = asRecord(part?.functionCall);
      if (functionCall && typeof functionCall.name === "string") {
        const id = typeof functionCall.id === "string" ? functionCall.id : crypto.randomUUID();
        yield { type: "tool_call_start", id, name: functionCall.name };
        yield { type: "tool_call_args_delta", id, argumentsDelta: JSON.stringify(functionCall.args ?? {}) };
        yield { type: "tool_call_end", id };
      }
    }
    const usage = asRecord(response?.usageMetadata) ?? asRecord(root?.usageMetadata);
    if (usage) yield {
      type: "usage",
      inputTokens: typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : typeof usage.inputTokenCount === "number" ? usage.inputTokenCount : 0,
      outputTokens: typeof usage.candidatesTokenCount === "number" ? usage.candidatesTokenCount : typeof usage.outputTokenCount === "number" ? usage.outputTokenCount : 0,
      reasoningTokens: typeof usage.thoughtsTokenCount === "number" ? usage.thoughtsTokenCount : typeof usage.reasoningTokenCount === "number" ? usage.reasoningTokenCount : 0,
      cacheReadTokens: typeof usage.cachedContentTokenCount === "number" ? usage.cachedContentTokenCount : 0,
      cacheWriteTokens: 0,
    };
    if (typeof candidate?.finishReason === "string") yield { type: "finish", stopReason: candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
  }
}
