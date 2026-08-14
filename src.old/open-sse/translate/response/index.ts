import type { ProviderUsage, StopReason, StreamEvent, Surface } from "../../../application/contracts";
import { isRecord, jsonObject, narrowList, narrowRecord, narrowText, nullableNumber } from "../../../application/protocols";
import { ProtocolCodecError } from "../errors";
import type { ResponseDocument } from "../contracts";
import { foldResponseEvents, orderedResponseItems } from "../concerns/response";
import { lookupResponseTranslation, registerResponseTranslation, type ResponseTranslationContext } from "../registry";
import { decodeAnthropicResponse } from "./anthropic";
import { decodeChatResponse, decodeResponsesResponse } from "./openai";
import { decodeGeminiResponse } from "./gemini";
import { fullPromptTokens, usageNumber } from "./usage";

function responseUsage(usage: ProviderUsage | null): Record<string, unknown> | undefined {
  if (usage === null) return undefined;
  const input = usageNumber(usage.inputTokens);
  const output = usageNumber(usage.outputTokens);
  const cached = usageNumber(usage.cacheReadTokens);
  const written = usageNumber(usage.cacheWriteTokens);
  const prompt = fullPromptTokens(usage);
  return {
    input_tokens: prompt,
    output_tokens: output,
    total_tokens: usageNumber(usage.totalTokens) || prompt + output,
    input_tokens_details: {
      cached_tokens: cached,
      ...(written > 0 ? { cache_write_tokens: written } : {}),
    },
    output_tokens_details: { reasoning_tokens: usageNumber(usage.reasoningTokens ?? null) },
  };
}

function openAIStop(reason: StopReason, hasTool: boolean): string {
  if (reason === "error") return "error";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  if (reason === "tool_call" || hasTool) return "tool_calls";
  return "stop";
}

function anthropicStop(reason: StopReason): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_call") return "tool_use";
  if (reason === "content_filter") return "refusal";
  if (reason === "compaction") return "compaction";
  if (reason === "pause_turn") return "pause_turn";
  return "end_turn";
}

function responseStatus(reason: StopReason): "completed" | "incomplete" | "failed" {
  if (reason === "error") return "failed";
  return reason === "length" || reason === "content_filter" ? "incomplete" : "completed";
}

function responseIncompleteReason(reason: StopReason): string | undefined {
  if (reason === "length") return "max_output_tokens";
  if (reason === "content_filter") return "content_filter";
  return undefined;
}

function messageContent(events: readonly StreamEvent[]): readonly Record<string, unknown>[] {
  return orderedResponseItems(events).flatMap((item) => {
    if (item.kind === "thinking") return [{ type: "thinking", thinking: item.text }];
    if (item.kind === "text") return [{ type: "text", text: item.text }];
    if (item.kind === "server_tool") return [{ ...item.block }];
    if (item.kind === "compaction") return [{ type: "compaction", content: item.text }];
    if (item.kind === "context") return [{ ...item.item }];
    return [{ type: "tool_use", id: item.callId, name: item.name, input: jsonObject(item.arguments) }];
  });
}


function decodeWebSearchResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const id = narrowText(body.id) ?? `search-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  const results = narrowList(body.search_results).filter(isRecord);
  if (results.length > 0) events.push({ type: "server_tool_result", block: { type: "web_search_tool_result", content: results } });
  const choice = narrowRecord(narrowList(body.choices)[0]);
  const message = narrowRecord(choice?.message);
  const text = narrowText(message?.content) ?? narrowText(body.output_text);
  if (text !== null && text.length > 0) events.push({ type: "text_delta", text });
  events.push({ type: "message_stop", reason: "completed" });
  return { sourceSurface: "web-search", model, events, rawBody: body };
}

/** Decodes a provider response body into the shared semantic event document. */
export function decodeNonStreamResponse(surface: Surface, body: Record<string, unknown>, model: string): ResponseDocument {
  if (surface === "openai-chat") return decodeChatResponse(body, model);
  if (surface === "openai-responses") return decodeResponsesResponse(body, model);
  if (surface === "anthropic-messages") return decodeAnthropicResponse(body, model);
  if (surface === "web-search") return decodeWebSearchResponse(body, model);
  if (surface === "images") return { sourceSurface: surface, model, events: [], rawBody: body };
  return decodeGeminiResponse(body, model);
}

/** Encodes canonical response events into a client-facing non-stream body. */
export function encodeNonStreamResponse(targetSurface: Surface, document: ResponseDocument): Record<string, unknown> {
  const folded = foldResponseEvents(document.events);
  const id = folded.id || `${targetSurface}-${crypto.randomUUID()}`;
  const toolCalls = folded.toolCalls.map((call) => ({ id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } }));
  if (targetSurface === "openai-chat") {
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: document.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: folded.text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(folded.thinking.length > 0 ? { reasoning_content: folded.thinking } : {}),
        },
        finish_reason: openAIStop(folded.reason, toolCalls.length > 0),
      }],
      ...(folded.usage === null ? {} : {
        usage: {
          prompt_tokens: fullPromptTokens(folded.usage),
          completion_tokens: usageNumber(folded.usage.outputTokens),
          total_tokens: usageNumber(folded.usage.totalTokens) || fullPromptTokens(folded.usage) + usageNumber(folded.usage.outputTokens),
          prompt_tokens_details: {
            cached_tokens: usageNumber(folded.usage.cacheReadTokens),
            ...(usageNumber(folded.usage.cacheWriteTokens) > 0 ? { cache_write_tokens: usageNumber(folded.usage.cacheWriteTokens) } : {}),
          },
          completion_tokens_details: { reasoning_tokens: usageNumber(folded.usage.reasoningTokens ?? null) },
        },
      }),
    };
  }
  if (targetSurface === "anthropic-messages") {
    const content = messageContent(document.events);
    const output = content.length > 0 ? content : [{ type: "text", text: "" }];
    return {
      id,
      type: "message",
      role: "assistant",
      model: document.model,
      content: output,
      stop_reason: anthropicStop(folded.reason),
      stop_sequence: null,
      ...(folded.usage === null ? {} : { usage: { input_tokens: usageNumber(folded.usage.inputTokens), output_tokens: usageNumber(folded.usage.outputTokens), cache_read_input_tokens: usageNumber(folded.usage.cacheReadTokens), cache_creation_input_tokens: usageNumber(folded.usage.cacheWriteTokens) } }),
    };
  }
  if (targetSurface === "openai-responses") {
    const output: Record<string, unknown>[] = [];
    let reasoningCount = 0;
    let messageCount = 0;
    for (const item of orderedResponseItems(document.events)) {
      if (item.kind === "thinking") {
        const suffix = reasoningCount === 0 ? "" : `-${reasoningCount}`;
        output.push({ type: "reasoning", id: `${id}-reasoning${suffix}`, summary: [{ type: "summary_text", text: item.text }] });
        reasoningCount += 1;
      } else if (item.kind === "text") {
        const suffix = messageCount === 0 ? "" : `-${messageCount}`;
        output.push({ type: "message", id: `${id}-message${suffix}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: item.text, annotations: [] }] });
        messageCount += 1;
      } else if (item.kind === "tool_call") output.push({ type: "function_call", id: item.callId, call_id: item.callId, name: item.name, arguments: item.arguments, status: "completed" });
      else if (item.kind === "compaction") output.push({ type: "compaction", content: item.text });
      else if (item.kind === "context") output.push({ ...item.item });
      else if (item.kind === "server_tool") output.push({ ...item.block });
    }
    const status = responseStatus(folded.reason);
    const body: Record<string, unknown> = { id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model: document.model, output, output_text: folded.text };
    const usage = responseUsage(folded.usage);
    if (usage !== undefined) body.usage = usage;
    const incompleteReason = responseIncompleteReason(folded.reason);
    if (incompleteReason !== undefined) body.incomplete_details = { reason: incompleteReason };
    if (folded.error !== undefined) body.error = folded.error;
    return body;
  }
  throw new ProtocolCodecError({ kind: "capability_unsupported", message: `Non-stream response encoding is unsupported for surface "${targetSurface}"`, statusCode: 400, routeScope: null });
}

function projectDocument(document: ResponseDocument, context: ResponseTranslationContext): ResponseDocument {
  return { ...document, sourceSurface: context.targetSurface, model: context.model };
}

function registerBuiltInResponseTranslations(): void {
  const edges: readonly [Surface, Surface][] = [
    ["openai-chat", "openai-responses"],
    ["openai-responses", "openai-chat"],
    ["openai-chat", "anthropic-messages"],
    ["anthropic-messages", "openai-chat"],
    ["web-search", "anthropic-messages"],
    ["web-search", "openai-chat"],
  ];
  for (const [from, to] of edges) registerResponseTranslation(from, to, projectDocument);
}

registerBuiltInResponseTranslations();

/** Translates a non-stream response through a direct semantic projection edge. */
export function translateNonStreamResponse(body: Record<string, unknown>, sourceSurface: Surface, targetSurface: Surface, model: string): Record<string, unknown> {
  if (sourceSurface === targetSurface) return body;
  if (sourceSurface === "images" || targetSurface === "images") {
    throw new ProtocolCodecError({ kind: "capability_unsupported", message: `Non-stream translation from ${sourceSurface} to ${targetSurface} is unsupported`, statusCode: 400, routeScope: null });
  }
  const document = decodeNonStreamResponse(sourceSurface, body, model);
  const projector = lookupResponseTranslation(sourceSurface, targetSurface);
  if (projector === undefined) {
    throw new ProtocolCodecError({ kind: "capability_unsupported", message: `No direct non-stream translation from ${sourceSurface} to ${targetSurface}`, statusCode: 400, routeScope: null });
  }
  const projected = projector(document, { sourceSurface, targetSurface, model });
  return encodeNonStreamResponse(targetSurface, projected);
}
