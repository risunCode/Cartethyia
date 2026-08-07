import { jsonObject, narrowList, narrowRecord, narrowText, nullableNumber } from "../protocols";
import type { ProviderCaps, ProviderMeta, Protocol, Surface } from "../contracts";

let idCounter = 0;
function nextFallbackId(prefix: string): string {
  idCounter = (idCounter + 1) | 0;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Resolves the provider-native wire surface while preserving the client surface in the normalized request. */
export function resolveWireSurface(metadata: ProviderMeta, capabilities: ProviderCaps, clientSurface: Surface): Surface | null {
  if (clientSurface === "images") return capabilities.surfaces.includes("images") ? "images" : null;
  if (clientSurface === "web-search") return capabilities.surfaces.includes("web-search") ? "web-search" : null;
  if (capabilities.surfaces.includes(clientSurface)) return clientSurface;
  if (metadata.protocol === "anthropic") return capabilities.surfaces.includes("anthropic-messages") ? "anthropic-messages" : null;
  if (metadata.protocol === "gemini") {
    if (capabilities.surfaces.includes("openai-chat")) return "openai-chat";
    if (capabilities.surfaces.includes("openai-responses")) return "openai-responses";
    return null;
  }
  if (metadata.protocol === "exa") return capabilities.surfaces.includes("web-search") ? "web-search" : null;
  if (capabilities.surfaces.includes("openai-chat")) return "openai-chat";
  return capabilities.surfaces.includes("openai-responses") ? "openai-responses" : null;
}

/** Converts a provider's non-stream body from its wire shape to the client's requested surface. */
export function translateBody(
  body: Record<string, unknown>,
  protocol: Protocol,
  wireSurface: Surface,
  clientSurface: Surface,
): Record<string, unknown> {
  if (wireSurface === clientSurface || clientSurface === "images" || protocol === "gemini") return body;
  const conv = CONVERSIONS[wireSurface]?.[clientSurface];
  return conv !== undefined ? conv(body) : body;
}

/**
 * Two-hop conversion table keyed by `[from][to]`. Routes via `openai-chat`
 * as the hub: surfaces without a direct edge compose through it.
 *   - anthropic-messages → openai-responses: anthropicToChat → chatToResponses
 *   - openai-responses → anthropic-messages: responsesToChat → chatToAnthropic
 */
const CONVERSIONS: Partial<Record<Surface, Partial<Record<Surface, (body: Record<string, unknown>) => Record<string, unknown>>>>> = {
  "openai-chat": {
    "anthropic-messages": chatToAnthropic,
    "openai-responses": chatToResponses,
  },
  "anthropic-messages": {
    "openai-chat": anthropicToChat,
    "openai-responses": (body) => chatToResponses(anthropicToChat(body)),
  },
  "openai-responses": {
    "openai-chat": responsesToChat,
    "anthropic-messages": (body) => chatToAnthropic(responsesToChat(body)),
  },
};

function chatToAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  const choice = narrowRecord(narrowList(body.choices)[0]);
  const message = narrowRecord(choice?.message) ?? {};
  const content: Record<string, unknown>[] = [];
  const reasoning = narrowText(message.reasoning_content);
  if (reasoning !== null && reasoning.length > 0) content.push({ type: "thinking", thinking: reasoning });
  const rawContent = message.content;
  if (typeof rawContent === "string" && rawContent.length > 0) content.push({ type: "text", text: rawContent });
  for (const raw of narrowList(rawContent)) {
    const part = narrowRecord(raw);
    if (part === null) continue;
    const partText = narrowText(part.text) ?? narrowText(part.content);
    if (partText !== null && partText.length > 0) content.push({ type: "text", text: partText });
  }
  for (const raw of narrowList(message.tool_calls)) {
    const call = narrowRecord(raw);
    const fn = narrowRecord(call?.function);
    if (fn !== null) content.push({ type: "tool_use", id: narrowText(call?.id) ?? `toolu_${content.length}`, name: narrowText(fn.name) ?? "", input: jsonObject(fn.arguments) });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const usage = narrowRecord(body.usage);
  const inputTokens = nullableNumber(usage?.prompt_tokens) ?? 0;
  const outputTokens = nullableNumber(usage?.completion_tokens) ?? 0;
  const cachedTokens = nullableNumber(narrowRecord(usage?.prompt_tokens_details)?.cached_tokens) ?? 0;
  const finish = narrowText(choice?.finish_reason);
  return {
    id: narrowText(body.id) ?? nextFallbackId("msg"),
    type: "message",
    role: "assistant",
    model: narrowText(body.model) ?? "",
    content,
    stop_reason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}) },
  };
}

function anthropicToChat(body: Record<string, unknown>): Record<string, unknown> {
  const blocks = narrowList(body.content).map(narrowRecord).filter((block): block is Record<string, unknown> => block !== null);
  const textParts = blocks.filter((block) => block.type === "text").map((block) => narrowText(block.text) ?? "");
  const thinking = blocks.filter((block) => block.type === "thinking").map((block) => narrowText(block.thinking) ?? "").join("");
  const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
    id: narrowText(block.id) ?? `toolu_${nextFallbackId("toolu")}`,
    type: "function",
    function: { name: narrowText(block.name) ?? "", arguments: JSON.stringify(narrowRecord(block.input) ?? {}) },
  }));
  const message: Record<string, unknown> = { role: "assistant", content: textParts.join("") };
  if (thinking.length > 0) message.reasoning_content = thinking;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = narrowRecord(body.usage);
  const inputTokens = nullableNumber(usage?.input_tokens);
  const outputTokens = nullableNumber(usage?.output_tokens);
  const stopReason = narrowText(body.stop_reason);
  return {
    id: narrowText(body.id) ?? nextFallbackId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: narrowText(body.model) ?? "",
    choices: [{ index: 0, message, finish_reason: stopReason === "tool_use" ? "tool_calls" : stopReason === "max_tokens" ? "length" : "stop" }],
    usage: { prompt_tokens: inputTokens ?? 0, completion_tokens: outputTokens ?? 0, total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0) },
  };
}

function chatToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const choice = narrowRecord(narrowList(body.choices)[0]);
  const message = narrowRecord(choice?.message) ?? {};
  const output: Record<string, unknown>[] = [];
  const responseId = narrowText(body.id) ?? nextFallbackId("resp");
  const reasoning = narrowText(message.reasoning_content);
  if (reasoning !== null && reasoning.length > 0) output.push({ type: "reasoning", id: `rs_${responseId}`, summary: [{ type: "summary_text", text: reasoning }] });
  const content = narrowText(message.content);
  if (content !== null && content.length > 0) output.push({ type: "message", id: `msg_${responseId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: content, annotations: [] }] });
  for (const raw of narrowList(message.tool_calls)) {
    const call = narrowRecord(raw);
    const fn = narrowRecord(call?.function);
    if (fn !== null) output.push({ type: "function_call", id: narrowText(call?.id) ?? nextFallbackId("fc"), call_id: narrowText(call?.id) ?? nextFallbackId("call"), name: narrowText(fn.name) ?? "", arguments: narrowText(fn.arguments) ?? "{}", status: "completed" });
  }
  const usage = narrowRecord(body.usage);
  const inputTokens = nullableNumber(usage?.prompt_tokens) ?? 0;
  const outputTokens = nullableNumber(usage?.completion_tokens) ?? 0;
  return {
    id: responseId.startsWith("chatcmpl-") ? `resp_${responseId}` : responseId,
    object: "response",
    created_at: nullableNumber(body.created) ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: narrowText(body.model) ?? "",
    output,
    output_text: content ?? "",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: nullableNumber(usage?.total_tokens) ?? inputTokens + outputTokens },
  };
}

function responsesToChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  const reasoningParts: string[] = [];
  for (const raw of narrowList(body.output)) {
    const item = narrowRecord(raw);
    if (item?.type === "message") {
      const parts = narrowList(item.content).map(narrowRecord).filter((part): part is Record<string, unknown> => part !== null);
      const textContent = parts.filter((part) => part.type === "output_text" || part.type === "text").map((part) => narrowText(part.text) ?? "").join("");
      messages.push({ role: "assistant", content: textContent });
    } else if (item?.type === "reasoning") {
      for (const rawSummary of narrowList(item.summary)) {
        const summary = narrowRecord(rawSummary);
        const summaryText = narrowText(summary?.text);
        if (summaryText !== null) reasoningParts.push(summaryText);
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({ id: narrowText(item.call_id) ?? narrowText(item.id) ?? `call_${toolCalls.length}`, type: "function", function: { name: narrowText(item.name) ?? "", arguments: narrowText(item.arguments) ?? "{}" } });
    }
  }
  const message = messages[0] ?? { role: "assistant", content: narrowText(body.output_text) ?? "" };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = narrowRecord(body.usage);
  const inputTokens = nullableNumber(usage?.input_tokens) ?? 0;
  const outputTokens = nullableNumber(usage?.output_tokens) ?? 0;
  return { id: narrowText(body.id) ?? nextFallbackId("chatcmpl"), object: "chat.completion", created: nullableNumber(body.created_at) ?? Math.floor(Date.now() / 1000), model: narrowText(body.model) ?? "", choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: nullableNumber(usage?.total_tokens) ?? inputTokens + outputTokens } };
}
