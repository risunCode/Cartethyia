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
import type { AnthropicToolDef, OpenAIChatToolDef } from "./concerns/tools";
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
 * OpenAI-shaped `reasoning_effort` has no Anthropic equivalent in the request
 * body verbatim — Anthropic controls reasoning depth via a `thinking` block
 * with a manual `budget_tokens` (min 1024, must stay under `max_tokens`).
 * Any client that already sends `reasoning_effort` (Model Studio's "Think"
 * selector, or a future OpenAI-shaped caller) gets real extended thinking on
 * Anthropic-family targets instead of the field being silently dropped.
 * A provider that doesn't understand `thinking` at all just ignores the
 * extra field — the same graceful passthrough every unrecognized JSON field
 * already gets, so nothing breaks for models that don't support it.
 */
const REASONING_EFFORT_TO_THINKING_BUDGET: Record<string, number> = {
  // "none" is intentionally absent - it means "no thinking", the same as
  // the field being unset, and must map to `undefined` rather than a real
  // budget.
  minimal: 1024,
  low: 2000,
  medium: 6000,
  high: 12000,
  xhigh: 24000,
  max: 32000,
};

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

/**
 * Chat Completions has no separate `system` field — a leading `role:"system"`
 * message plays that role. `"developer"` is the o-series/gpt-5 replacement
 * for `"system"` and is treated identically here.
 */
function extractSystemMessage(messages: OpenAIChatMessage[]): { system: string | undefined; rest: OpenAIChatMessage[] } {
  const first = messages[0];
  if ((first?.role === "system" || first?.role === "developer") && typeof first.content === "string") {
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
  const thinkingBudget = typeof req.reasoning_effort === "string" ? REASONING_EFFORT_TO_THINKING_BUDGET[req.reasoning_effort] : undefined;
  const out: AnthropicRequest = {
    model: req.model,
    // budget_tokens must stay under max_tokens, so a thinking request also
    // floors max_tokens — same reasoning as the tool-calling floor above.
    max_tokens: Math.max(
      hasTools ? Math.max(requestedMaxTokens, MIN_TOKENS_FOR_TOOL_CALLING) : requestedMaxTokens,
      thinkingBudget !== undefined ? thinkingBudget + 1024 : 0
    ),
    messages: denormalizeToAnthropicMessages(breakpoint.messages),
  };
  if (thinkingBudget !== undefined) out.thinking = { type: "enabled", budget_tokens: thinkingBudget };

  if (breakpoint.system !== undefined) {
    out.system = breakpoint.systemCached
      ? [{ type: "text", text: breakpoint.system, cache_control: { type: "ephemeral" } }]
      : breakpoint.system;
  }
  if (req.tools && req.tools.length > 0) {
    // A client can legally mix custom function tools with Responses-family
    // built-in tools (web_search, code_interpreter, computer_use, ...) in
    // the same array. Those have no `.function` field at all - reading it
    // unconditionally used to crash the whole request with a raw TypeError
    // instead of just dropping the tool this proxy can't represent.
    const functionTools = req.tools.filter((t): t is OpenAIChatToolDef => t.type === "function" && t.function !== undefined);
    if (functionTools.length > 0) out.tools = functionTools.map((t) => unifiedToolToAnthropic(openAIChatToolToUnified(t)));
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  const toolChoice = openAIToolChoiceToAnthropic(req.tool_choice);
  // `parallel_tool_calls: false` has no standalone Anthropic request field -
  // it only exists as a flag on `tool_choice`, so a client that sets it
  // without also pinning tool_choice still needs one synthesized (defaults
  // to "auto") for the flag to have anywhere to live.
  if (req.parallel_tool_calls === false) {
    out.tool_choice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };
  } else if (toolChoice !== undefined) {
    out.tool_choice = toolChoice;
  }
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

  // Thinking blocks are extracted into `reasoning_content` by
  // denormalizeToOpenAIChatMessages itself now (see normalize.ts) - no
  // separate ad-hoc scan needed here.
  const message = chatMsg ?? { role: "assistant" as const, content: "" };
  // A refusal has no dedicated content block - Anthropic signals it purely
  // via stop_reason - so it's surfaced through Chat's own `refusal` field
  // too, not just finish_reason, for a client that inspects message.refusal.
  if (resp.stop_reason === "refusal") message.refusal = responseText || "The model declined to respond.";

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
    // Anthropic server-side tools (computer_20250124, bash_20250124,
    // text_editor_20250124, web_search_20250305, ...) carry a `type` other
    // than absent/"custom" and no client-schema slot - there is no OpenAI
    // function-tool equivalent to translate them into, so they're dropped
    // instead of forwarded with a synthesized, meaningless empty schema.
    const functionTools = req.tools.filter((t) => t.type === undefined || t.type === "custom");
    if (functionTools.length > 0) out.tools = functionTools.map((t) => unifiedToolToOpenAIChat(anthropicToolToUnified(t)));
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  const toolChoice = anthropicToolChoiceToOpenAIChat(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (req.tool_choice?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences !== undefined) out.stop = req.stop_sequences;
  if (req.stream !== undefined) out.stream = req.stream;

  return out;
}

export function translateChatResponseToMessages(resp: OpenAIChatResponse): AnthropicResponse {
  // Anthropic Messages has no multi-candidate concept - if the upstream Chat
  // response carries `n > 1` choices, only the first is representable here
  // (there is no lossless mapping for the rest).
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
