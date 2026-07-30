/**
 * OpenAI Chat Completions ⇄ Anthropic Messages — both route directions live
 * here since they're a genuine bidirectional pair (no name collisions
 * between the two halves): one when the client speaks OpenAI Chat shape and
 * the upstream is Anthropic, the other when the client speaks Anthropic
 * Messages shape and the upstream is OpenAI.
 *
 * `openai-to-anthropic direction`: OpenAI Chat request → Anthropic (sent
 * upstream); Anthropic response → OpenAI Chat (sent back to client).
 * `anthropic-to-openai direction`: Anthropic Messages request → OpenAI Chat
 * (sent upstream); OpenAI Chat response → Anthropic Messages (sent back to
 * client).
 */

import { config } from "../config";
import { applyCacheBreakpoint, normalizeAnthropicUsage, normalizeOpenAIUsage } from "./concerns/cache";
import { anthropicStopToOpenAIFinish, isOpenAIFinishReason, openAIFinishToAnthropicStop } from "./concerns/finishReasons";
import {
  denormalizeToAnthropicBlock,
  denormalizeToAnthropicMessages,
  denormalizeToOpenAIChatMessages,
  normalizeAnthropicBlock,
  normalizeAnthropicMessages,
  normalizeOpenAIChatMessages,
} from "./concerns/normalize";
import {
  anthropicToolChoiceToOpenAIChat,
  anthropicToolToUnified,
  openAIChatToolToUnified,
  openAIToolChoiceToAnthropic,
  unifiedToolToAnthropic,
  unifiedToolToOpenAIChat,
  fixMissingToolResults,
  sanitizeAnthropicToolIds,
} from "./concerns/tools";
import type {
  AnthropicRequest,
  AnthropicResponse,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIResponseFormat,
} from "./types";

/** Floor so a tool call's `arguments` JSON has room to complete instead of being cut off mid-stream. */
const MIN_TOKENS_FOR_TOOL_CALLING = 4096;

/**
 * Anthropic's Messages API has no grammar-enforced structured-output mode
 * reachable through this proxy, so `response_format` (OpenAI Chat only) is
 * folded into the Anthropic `system` prompt as a BEST-EFFORT instruction —
 * this is NOT equivalent to OpenAI's `strict: true` JSON Schema mode: Claude
 * can still emit prose around/instead of the JSON. Callers/docs must not
 * present this as equivalent — see docs/FORMATS.md.
 */
function responseFormatToSystemInstruction(format: OpenAIResponseFormat | undefined): string | undefined {
  if (format === undefined) return undefined;
  if (format.type === "json_object") {
    return "You must respond with valid JSON. Respond ONLY with a JSON object, no other text.";
  }
  const schemaJson = JSON.stringify(format.json_schema.schema, null, 2);
  return `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;
}

// ── OpenAI Chat request → Anthropic upstream ─────────────────────────────

/** Chat Completions has no separate `system` field — a leading `role:"system"` message plays that role. */
function extractSystemMessage(messages: OpenAIChatMessage[]): { system: string | undefined; rest: OpenAIChatMessage[] } {
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    return { system: first.content, rest: messages.slice(1) };
  }
  return { system: undefined, rest: messages };
}

export function translateChatRequestToAnthropic(req: OpenAIChatRequest): AnthropicRequest {
  const { system: extractedSystem, rest } = extractSystemMessage(req.messages);
  const unified = sanitizeAnthropicToolIds(fixMissingToolResults(normalizeOpenAIChatMessages(rest)));

  // response_format has no Anthropic equivalent — folded into the system
  // prompt as a best-effort instruction (see responseFormatToSystemInstruction above).
  const formatInstruction = responseFormatToSystemInstruction(req.response_format);
  const system = formatInstruction === undefined ? extractedSystem : [extractedSystem, formatInstruction].filter((s): s is string => s !== undefined).join("\n\n");

  const breakpoint = config.cache.markersEnabled
    ? applyCacheBreakpoint(system, unified)
    : { system, systemCached: false, messages: unified };
  // Anthropic requires max_tokens to be large enough to hold a full tool
  // call's `arguments` JSON — a client that didn't override the default and
  // is using tools gets a floor bumped up so the model doesn't get cut off
  // mid-argument-JSON (which produces unparsable, unrecoverable arguments).
  const requestedMaxTokens = req.max_completion_tokens ?? req.max_tokens ?? 4096;
  const hasTools = (req.tools?.length ?? 0) > 0;
  const out: AnthropicRequest = {
    model: req.model,
    max_tokens: hasTools ? Math.max(requestedMaxTokens, MIN_TOKENS_FOR_TOOL_CALLING) : requestedMaxTokens,
    messages: denormalizeToAnthropicMessages(breakpoint.messages),
  };

  if (breakpoint.system !== undefined) {
    out.system = breakpoint.systemCached
      ? [{ type: "text", text: breakpoint.system, cache_control: { type: "ephemeral" } }]
      : breakpoint.system;
  }
  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => unifiedToolToAnthropic(openAIChatToolToUnified(t)));
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  const toolChoice = openAIToolChoiceToAnthropic(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.stream !== undefined) out.stream = req.stream;

  return out;
}

export function translateAnthropicResponseToChat(resp: AnthropicResponse): OpenAIChatResponse {
  const unifiedMsg = { role: "assistant" as const, blocks: resp.content.map((b) => normalizeAnthropicBlock(b)) };
  const [chatMsg] = denormalizeToOpenAIChatMessages([unifiedMsg]);
  const responseText = resp.content.filter((b) => (b as unknown as Record<string, unknown>).type === "text").map((b) => (b as unknown as Record<string, unknown>).text as string ?? "").join("");
  const usage = normalizeAnthropicUsage(resp.usage, responseText);

  // Extract thinking blocks → reasoning_content (L1)
  const thinkingBlocks = resp.content.filter((b) => (b as unknown as Record<string, unknown>).type === "thinking");
  const reasoningContent = thinkingBlocks.length > 0
    ? thinkingBlocks.map((b) => (b as unknown as Record<string, unknown>).thinking as string ?? "").join("\n")
    : undefined;

  const message = chatMsg ?? { role: "assistant" as const, content: "" };
  if (reasoningContent) (message as unknown as Record<string, unknown>).reasoning_content = reasoningContent;

  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicStopToOpenAIFinish(resp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: usage.freshInputTokens + usage.cacheReadTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.freshInputTokens + usage.cacheReadTokens + usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
      ...(usage.estimated ? { estimated: true } : {}),
    },
  };
}

// ── Anthropic Messages request → OpenAI upstream ─────────────────────────

function systemFieldToText(system: AnthropicRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

export function translateMessagesRequestToChat(req: AnthropicRequest): OpenAIChatRequest {
  const unified = normalizeAnthropicMessages(req.messages);
  const system = systemFieldToText(req.system);

  const breakpoint = config.cache.markersEnabled
    ? applyCacheBreakpoint(system, unified)
    : { system, systemCached: false, messages: unified };

  const messages: OpenAIChatMessage[] = [];
  if (breakpoint.system !== undefined) {
    messages.push({ role: "system", content: breakpoint.system });
  }
  messages.push(...denormalizeToOpenAIChatMessages(breakpoint.messages));

  const out: OpenAIChatRequest = { model: req.model, messages, max_tokens: req.max_tokens };

  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => unifiedToolToOpenAIChat(anthropicToolToUnified(t)));
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  const toolChoice = anthropicToolChoiceToOpenAIChat(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences !== undefined) out.stop = req.stop_sequences;
  if (req.stream !== undefined) out.stream = req.stream;

  return out;
}

export function translateChatResponseToMessages(resp: OpenAIChatResponse): AnthropicResponse {
  const choice = resp.choices?.[0];
  const message = choice?.message;
  const unified = message ? normalizeOpenAIChatMessages([message])[0] : undefined;
  const responseText = typeof message?.content === "string" ? message.content : "";
  const usage = normalizeOpenAIUsage(resp.usage, responseText);

  // When the upstream returns no choices (e.g. reasoning consumed the entire
  // token budget), produce a valid but minimal Anthropic response instead of
  // crashing or returning an empty content array that confuses clients.
  const content = unified && unified.blocks.length > 0
    ? unified.blocks.map((b) => denormalizeToAnthropicBlock(b))
    : [{ type: "text" as const, text: "(model produced no visible output — reasoning tokens may have been exhausted)" }];

  return {
    id: resp.id ?? `msg-${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: resp.model ?? "unknown",
    content,
    stop_reason: choice && isOpenAIFinishReason(choice.finish_reason) ? openAIFinishToAnthropicStop(choice.finish_reason) : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.freshInputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
      ...(usage.estimated ? { estimated: true } : {}),
    },
  };
}
