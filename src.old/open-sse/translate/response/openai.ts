import type { ProviderUsage, StopReason, StreamEvent } from "../../../application/contracts";
import { isRecord, narrowList, narrowRecord, narrowText, nullableNumber } from "../../../application/protocols";
import { ProtocolCodecError } from "../errors";
import type { ResponseDocument } from "../contracts";
import { createReasoningBlock, boundedReasoningSummary } from "../concerns/reasoning";
import { usageFromTotalInput } from "./usage";
function chatStopReason(value: string | null): StopReason {
  if (value === "length") return "length";
  if (value === "tool_calls" || value === "function_call") return "tool_call";
  if (value === "content_filter") return "content_filter";
  return "completed";
}

function responsesStopReason(body: Record<string, unknown>, sawTool: boolean): StopReason {
  if (sawTool) return "tool_call";
  const details = narrowRecord(body.incomplete_details);
  if (narrowText(details?.reason) === "max_output_tokens") return "length";
  if (narrowText(details?.reason) === "content_filter") return "content_filter";
  if (narrowText(body.status) === "failed") return "error";
  return "completed";
}
function responsesWebSearchBlock(item: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `web_search_${crypto.randomUUID()}`;
  const action = isRecord(item.action) ? item.action : null;
  const query = typeof action?.query === "string"
    ? action.query
    : Array.isArray(action?.queries)
      ? action.queries.filter((value): value is string => typeof value === "string").join("\n")
      : undefined;
  return {
    type: "server_tool_use",
    id,
    name: "web_search",
    input: query === undefined ? {} : { query },
  };
}
function responsesWebSearchCitations(item: Record<string, unknown>): readonly Readonly<Record<string, unknown>>[] {
  const citations: Readonly<Record<string, unknown>>[] = [];
  const seen = new Set<string>();
  for (const rawPart of Array.isArray(item.content) ? item.content : []) {
    if (!isRecord(rawPart) || !Array.isArray(rawPart.annotations)) continue;
    for (const rawAnnotation of rawPart.annotations) {
      if (!isRecord(rawAnnotation) || rawAnnotation.type !== "url_citation" || typeof rawAnnotation.url !== "string" || seen.has(rawAnnotation.url)) continue;
      seen.add(rawAnnotation.url);
      citations.push({
        type: "web_search_result",
        title: typeof rawAnnotation.title === "string" ? rawAnnotation.title : rawAnnotation.url,
        url: rawAnnotation.url,
      });
    }
  }
  return citations;
}

function responsesWebSearchResultBlock(toolUseId: string, content: readonly Readonly<Record<string, unknown>>[]): Readonly<Record<string, unknown>> {
  return { type: "web_search_tool_result", tool_use_id: toolUseId, content };
}

/** Maps an OpenAI Chat usage record into the shared provider usage contract. */
export function mapChatUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputDetails = narrowRecord(usage.prompt_tokens_details);
  const outputDetails = narrowRecord(usage.completion_tokens_details);
  return usageFromTotalInput(
    nullableNumber(usage.prompt_tokens),
    nullableNumber(usage.completion_tokens),
    nullableNumber(inputDetails?.cached_tokens),
    nullableNumber(inputDetails?.cache_write_tokens),
    nullableNumber(usage.total_tokens),
    nullableNumber(outputDetails?.reasoning_tokens),
  );
}

/** Maps an OpenAI Responses usage record into the shared provider usage contract. */
export function mapResponsesUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputDetails = narrowRecord(usage.input_tokens_details);
  const outputDetails = narrowRecord(usage.output_tokens_details);
  return usageFromTotalInput(
    nullableNumber(usage.input_tokens),
    nullableNumber(usage.output_tokens),
    nullableNumber(inputDetails?.cached_tokens),
    nullableNumber(inputDetails?.cache_write_tokens),
    nullableNumber(usage.total_tokens),
    nullableNumber(outputDetails?.reasoning_tokens),
  );
}

/** Decodes an OpenAI Chat Completions body into canonical response events. */
export function decodeChatResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const choices = body.choices;
  if (!Array.isArray(choices)) {
    throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "OpenAI Chat response choices must be an array", statusCode: 502, routeScope: "provider" });
  }
  const choice = narrowRecord(choices[0]) ?? {};
  const message = narrowRecord(choice.message) ?? {};
  const id = narrowText(body.id) ?? `chatcmpl-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  const reasoning = narrowText(message.reasoning_content);
  if (reasoning !== null && reasoning.length > 0) events.push({ type: "thinking_delta", text: reasoning });
  const content = message.content;
  if (typeof content === "string" && content.length > 0) events.push({ type: "text_delta", text: content });
  if (Array.isArray(content)) {
    for (const raw of content) {
      const part = narrowRecord(raw);
      const text = narrowText(part?.text) ?? narrowText(part?.content);
      if (text !== null && text.length > 0) events.push({ type: "text_delta", text });
    }
  }
  for (const raw of narrowList(message.tool_calls)) {
    const call = narrowRecord(raw);
    const fn = narrowRecord(call?.function);
    if (fn === null) continue;
    const callId = narrowText(call?.id) ?? `call_${events.length}`;
    const name = narrowText(fn.name) ?? "";
    const args = narrowText(fn.arguments) ?? "{}";
    events.push({ type: "tool_call_start", callId, name }, { type: "tool_call_delta", callId, delta: args }, { type: "tool_call_end", callId });
  }
  const usage = isRecord(body.usage) ? mapChatUsage(body.usage) : null;
  if (usage !== null) events.push({ type: "usage", usage });
  events.push({ type: "message_stop", reason: chatStopReason(narrowText(choice.finish_reason)) });
  return { sourceSurface: "openai-chat", model, events, rawBody: body };
}

/** Decodes an OpenAI Responses body into canonical response events. */
export function decodeResponsesResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const output = body.output;
  if (output !== undefined && !Array.isArray(output)) {
    throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "OpenAI Responses output must be an array", statusCode: 502, routeScope: "provider" });
  }
  const id = narrowText(body.id) ?? `resp_${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  let sawTool = false;
  const webSearches: Array<{ readonly id: string; readonly block: Readonly<Record<string, unknown>> }> = [];
  const webSearchCitations = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const raw of narrowList(output)) {
    const item = narrowRecord(raw);
    if (item === null) continue;
    const type = narrowText(item.type);
    if (type === "message") {
      const citations = responsesWebSearchCitations(item);
      if (citations.length > 0) {
        for (const search of webSearches) {
          const results = webSearchCitations.get(search.id) ?? [];
          for (const citation of citations) {
            if (!results.some((result) => result.url === citation.url)) results.push(citation);
          }
          webSearchCitations.set(search.id, results);
        }
      }
      for (const rawPart of narrowList(item.content)) {
        const part = narrowRecord(rawPart);
        const text = narrowText(part?.text);
        if ((part?.type === "output_text" || part?.type === "text") && text !== null) events.push({ type: "text_delta", text });
      }
    } else if (type === "reasoning") {
      const summary = boundedReasoningSummary(item.summary);
      const reasoning = createReasoningBlock({ encryptedContent: narrowText(item.encrypted_content) ?? undefined, summary, raw: item });
      if (summary !== undefined) {
        for (const entry of summary) {
          const text = narrowText(entry.text);
          if (text !== null && text.length > 0) events.push({ type: "thinking_delta", text });
        }
      } else if (reasoning.reasoningText !== undefined) {
        events.push({ type: "thinking_delta", text: reasoning.reasoningText });
      }
    } else if (type === "web_search_call") {
      const outputIndex = events.length;
      const block = responsesWebSearchBlock(item);
      const id = typeof block.id === "string" ? block.id : `web_search_${outputIndex}`;
      webSearches.push({ id, block });
      webSearchCitations.set(id, []);
      events.push(
        { type: "native_block_start", index: outputIndex, block },
        { type: "native_block_stop", index: outputIndex },
      );
    } else if (type === "function_call") {
      sawTool = true;
      const callId = narrowText(item.call_id) ?? narrowText(item.id) ?? `call_${events.length}`;
      const name = narrowText(item.name) ?? "";
      const args = narrowText(item.arguments) ?? "{}";
      events.push({ type: "tool_call_start", callId, name }, { type: "tool_call_delta", callId, delta: args }, { type: "tool_call_end", callId });
    } else if (type === "compaction") {
      const text = narrowText(item.content) ?? "";
      events.push({ type: "compaction_start" });
      if (text.length > 0) events.push({ type: "compaction_delta", text });
      events.push({ type: "compaction_stop" });
    } else if (type !== "function_call_output" && type !== "unknown") {
      events.push({ type: "context_item", phase: "added", outputIndex: events.length, item }, { type: "context_item", phase: "done", outputIndex: events.length, item });
    }
  }
  for (const search of webSearches) {
    events.push({ type: "server_tool_result", block: responsesWebSearchResultBlock(search.id, webSearchCitations.get(search.id) ?? []) });
  }
  if (narrowText(body.output_text) !== null && events.every((event) => event.type !== "text_delta")) events.push({ type: "text_delta", text: narrowText(body.output_text) ?? "" });
  const usage = isRecord(body.usage) ? mapResponsesUsage(body.usage) : null;
  if (usage !== null) events.push({ type: "usage", usage });
  events.push({ type: "message_stop", reason: responsesStopReason(body, sawTool) });
  return { sourceSurface: "openai-responses", model, events, rawBody: body };
}
