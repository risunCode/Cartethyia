import { isRecord, messageText, nullableNumber } from "../protocols";
import type { ContentBlock, ImageReference, ProxyRequest, Surface, ProviderUsage } from "../contracts";

export function buildGeminiPayload(request: ProxyRequest): Record<string, unknown> {
  const system = request.messages.filter((message) => message.role === "system" || message.role === "developer").flatMap((message) => {
    const t = messageText(message);
    return t ? [{ text: t }] : [];
  });
  const contents = request.messages.filter((message) => message.role !== "system" && message.role !== "developer").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: message.content.flatMap(toGeminiPart) }));
  const payload: Record<string, unknown> = { contents };
  if (system.length > 0) payload.systemInstruction = { role: "user", parts: system };
  if (request.tools.length > 0) payload.tools = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema })) }];
  const generationConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== null) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.responseFormat !== "text") generationConfig.responseMimeType = "application/json";
  if (request.reasoning === "enabled") generationConfig.thinkingConfig = { thinkingBudget: Math.min(request.maxOutputTokens ?? 8192, 32_768) };
  if (request.sourceSurface === "images") generationConfig.responseModalities = ["TEXT", "IMAGE"];
  if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;
  return payload;
}

function toGeminiPart(block: ContentBlock): Record<string, unknown>[] {
  if (block.type === "text") return [{ text: block.text ?? "" }];
  if (block.type === "image" && block.image) return [toGeminiImage(block.image)];
  if (block.type === "tool_use") return [{ functionCall: { name: block.toolName ?? "", args: parseJsonObject(block.toolArguments ?? block.text ?? "{}"), ...(block.toolCallId ? { id: block.toolCallId } : {}) } }];
  if (block.type === "tool_result") return [{ functionResponse: { name: block.toolName ?? block.toolCallId ?? "tool", response: parseJsonObject(block.text ?? "") } }];
  return [];
}

function toGeminiImage(image: ImageReference): Record<string, unknown> {
  if (image.kind === "data") return { inlineData: { mimeType: image.mediaType ?? "image/png", data: image.value.replace(/^data:[^;,]+;base64,/, "") } };
  return { fileData: { fileUri: image.value, mimeType: image.mediaType ?? "application/octet-stream" } };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { content: value };
  } catch {
    return value.length > 0 ? { content: value } : {};
  }
}

export function geminiCandidate(body: Record<string, unknown>): { readonly response: Record<string, unknown>; readonly candidate: Record<string, unknown>; readonly parts: readonly Record<string, unknown>[] } {
  const response = isRecord(body.response) ? body.response : body;
  const candidate = Array.isArray(response.candidates) && isRecord(response.candidates[0]) ? response.candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
  return { response, candidate, parts };
}

export function responseParts(parts: readonly Record<string, unknown>[]): { readonly text: string; readonly calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[]; readonly thought: string } {
  const text: string[] = [];
  const thought: string[] = [];
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  for (const part of parts) {
    if (typeof part.text === "string") (part.thought === true ? thought : text).push(part.text);
    if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") calls.push({ id: typeof part.functionCall.id === "string" ? part.functionCall.id : `call_${crypto.randomUUID()}`, name: part.functionCall.name, args: isRecord(part.functionCall.args) ? part.functionCall.args : {} });
  }
  return { text: text.join(""), calls, thought: thought.join("") };
}

/** Translates a Gemini response body into the client-facing surface shape. */
export function translateGeminiResponse(body: Record<string, unknown>, surface: Surface, model: string): Record<string, unknown> {
  const { response, candidate, parts } = geminiCandidate(body);
  const output = responseParts(parts);
  const usage = mapGeminiUsage(body);
  const id = typeof response.responseId === "string" ? response.responseId : `gemini-${crypto.randomUUID()}`;
  const stop = output.calls.length > 0 ? "tool_call" : candidate.finishReason === "MAX_TOKENS" ? "length" : "completed";
  if (surface === "anthropic-messages") return { id, type: "message", role: "assistant", model, content: [...(output.thought ? [{ type: "thinking", thinking: output.thought }] : []), ...(output.text ? [{ type: "text", text: output.text }] : []), ...output.calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args }))], stop_reason: stop === "tool_call" ? "tool_use" : stop === "length" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0 } };
  if (surface === "openai-responses") return { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model, output: [{ type: "message", id: `${id}-message`, role: "assistant", content: [{ type: "output_text", text: output.text, annotations: [] }] }, ...output.calls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))], output_text: output.text, usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0, total_tokens: usage.totalTokens ?? 0 } };
  return { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: output.text || null, ...(output.calls.length > 0 ? { tool_calls: output.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }, finish_reason: output.calls.length > 0 ? "tool_calls" : candidate.finishReason === "MAX_TOKENS" ? "length" : "stop" }], usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: usage.totalTokens ?? 0 } };
}

/** Maps Gemini usageMetadata into the provider-neutral usage shape. */
export function mapGeminiUsage(body: Record<string, unknown>): ProviderUsage {
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  const inputTokens = nullableNumber(usage.promptTokenCount);
  const outputTokens = nullableNumber(usage.candidatesTokenCount);
  const totalTokens = nullableNumber(usage.totalTokenCount);
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens: nullableNumber(usage.cachedContentTokenCount), cacheWriteTokens: null, source: "provider" };
}
