import type { ProviderUsage, StopReason, StreamEvent, Surface } from "../../../application/contracts";
import { isRecord, nullableNumber } from "../../../application/protocols";
import type { ResponseDocument } from "../contracts";
import { usageFromTotalInput } from "./usage";
/** Extracts the Gemini response, first candidate, and bounded content parts. */
export function geminiCandidate(body: Record<string, unknown>): { readonly response: Record<string, unknown>; readonly candidate: Record<string, unknown>; readonly parts: readonly Record<string, unknown>[] } {
  const response = isRecord(body.response) ? body.response : body;
  const candidates = response.candidates;
  const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
  return { response, candidate, parts };
}

/** Folds Gemini text, thought, function-call, and inline image parts. */
export function responseParts(parts: readonly Record<string, unknown>[]): {
  readonly text: string;
  readonly calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown>; readonly reasoningSignature?: string }[];
  readonly thought: string;
  readonly reasoningSignature?: string;
  readonly images: readonly { readonly data: string; readonly mimeType: string | null }[];
} {
  const text: string[] = [];
  const thought: string[] = [];
  const calls: Array<{ id: string; name: string; args: Record<string, unknown>; reasoningSignature?: string }> = [];
  const images: Array<{ data: string; mimeType: string | null }> = [];
  let reasoningSignature: string | undefined;
  let callIndex = 0;
  for (const part of parts) {
    if (typeof part.text === "string") {
      if (part.thought === true) {
        thought.push(part.text);
        if (typeof part.thoughtSignature === "string") reasoningSignature ??= part.thoughtSignature;
      } else text.push(part.text);
    }
    const inlineData = isRecord(part.inlineData) ? part.inlineData : null;
    if (inlineData !== null && typeof inlineData.data === "string") images.push({ data: inlineData.data, mimeType: typeof inlineData.mimeType === "string" ? inlineData.mimeType : null });
    if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
      calls.push({ id: typeof part.functionCall.id === "string" ? part.functionCall.id : `call_${callIndex++}`, name: part.functionCall.name, args: isRecord(part.functionCall.args) ? part.functionCall.args : {}, ...(typeof part.thoughtSignature === "string" ? { reasoningSignature: part.thoughtSignature } : {}) });
    }
  }
  return { text: text.join(""), calls, thought: thought.join(""), reasoningSignature, images };
}

/** Maps Gemini usageMetadata into the provider-neutral usage shape. */
export function mapGeminiUsage(body: Record<string, unknown>): ProviderUsage {
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return usageFromTotalInput(
    nullableNumber(usage.promptTokenCount),
    nullableNumber(usage.candidatesTokenCount),
    nullableNumber(usage.cachedContentTokenCount),
    null,
    nullableNumber(usage.totalTokenCount),
  );
}

function stopReason(candidate: Record<string, unknown>, calls: number): StopReason {
  if (calls > 0) return "tool_call";
  if (candidate.finishReason === "MAX_TOKENS") return "length";
  return "completed";
}

export function decodeGeminiResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const { response, candidate, parts } = geminiCandidate(body);
  const output = responseParts(parts);
  const id = typeof response.responseId === "string" ? response.responseId : `gemini-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  if (output.thought.length > 0) events.push({ type: "thinking_delta", text: output.thought, ...(output.reasoningSignature === undefined ? {} : { reasoningSignature: output.reasoningSignature }) });
  if (output.text.length > 0) events.push({ type: "text_delta", text: output.text });
  for (const call of output.calls) events.push({ type: "tool_call_start", callId: call.id, name: call.name, ...(call.reasoningSignature === undefined ? {} : { reasoningSignature: call.reasoningSignature }) }, { type: "tool_call_delta", callId: call.id, delta: JSON.stringify(call.args) }, { type: "tool_call_end", callId: call.id });
  const usage = mapGeminiUsage(body);
  if (usage.inputTokens !== null || usage.outputTokens !== null || usage.totalTokens !== null) events.push({ type: "usage", usage });
  events.push({ type: "message_stop", reason: stopReason(candidate, output.calls.length) });
  return { sourceSurface: "openai-chat", model, events, rawBody: body };
}

/** Encodes a decoded Gemini body into a requested text surface. */
export function translateGeminiResponse(body: Record<string, unknown>, surface: Surface, model: string): Record<string, unknown> {
  const document = decodeGeminiResponse(body, model);
  const events = document.events;
  let text = "";
  let thinking = "";
  const calls: Array<{ id: string; name: string; arguments: string; reasoningSignature?: string }> = [];
  let usage: ProviderUsage | null = null;
  let reason: StopReason = "completed";
  let thinkingSignature: string | undefined;
  for (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "thinking_delta") { thinking += event.text; thinkingSignature ??= event.reasoningSignature; }
    else if (event.type === "tool_call_start") calls.push({ id: event.callId, name: event.name, arguments: "", ...(event.reasoningSignature === undefined ? {} : { reasoningSignature: event.reasoningSignature }) });
    else if (event.type === "tool_call_delta") {
      const call = calls.find((item) => item.id === event.callId);
      if (call !== undefined) call.arguments += event.delta;
    } else if (event.type === "usage") usage = event.usage;
    else if (event.type === "message_stop") reason = event.reason;
  }
  const id = typeof body.responseId === "string" ? body.responseId : `gemini-${crypto.randomUUID()}`;
  const usageBase = usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" as const };
  if (surface === "anthropic-messages") return { id, type: "message", role: "assistant", model, content: [...(thinking ? [{ type: "thinking", thinking, ...(thinkingSignature === undefined ? {} : { signature: thinkingSignature }) }] : []), ...(text ? [{ type: "text", text }] : []), ...calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: parseArguments(call.arguments), ...(call.reasoningSignature === undefined ? {} : { signature: call.reasoningSignature }) }))], stop_reason: reason === "tool_call" ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: usageBase.inputTokens ?? 0, output_tokens: usageBase.outputTokens ?? 0 } };
  if (surface === "openai-responses") return { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: reason === "length" ? "incomplete" : "completed", model, output: [...(thinking ? [{ type: "reasoning", id: `${id}-reasoning`, summary: [{ type: "summary_text", text: thinking }] }] : []), ...(text ? [{ type: "message", id: `${id}-message`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] : []), ...calls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments }))], output_text: text, usage: { input_tokens: usageBase.inputTokens ?? 0, output_tokens: usageBase.outputTokens ?? 0, total_tokens: usageBase.totalTokens ?? 0 } };
  return { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}), ...(thinking ? { reasoning_content: thinking } : {}) }, finish_reason: reason === "tool_call" ? "tool_calls" : reason === "length" ? "length" : "stop" }], usage: { prompt_tokens: usageBase.inputTokens ?? 0, completion_tokens: usageBase.outputTokens ?? 0, total_tokens: usageBase.totalTokens ?? 0 } };
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
/** Converts a Gemini image-generation response to the OpenAI Images body. */
export function translateGeminiImageResponse(body: Record<string, unknown>): Record<string, unknown> {
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
