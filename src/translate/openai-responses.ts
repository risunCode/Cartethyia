/**
 * OpenAI Chat Completions ⇄ OpenAI Responses — both route directions live
 * here since they're a genuine bidirectional pair (no name collisions
 * between the two halves). Both surfaces are OpenAI's own vocabulary (not
 * cross-provider), so this translates directly between wire shapes instead
 * of routing through the cross-provider UnifiedMessage model — Responses
 * `input_text`/`input_image` map 1:1 onto Chat's `text`/`image_url`, no
 * provider-specific block semantics (e.g. Anthropic's separate
 * `tool_result` message role) apply.
 *
 * `chat-to-responses direction`: client speaks Chat shape, upstream is the
 * Responses API. `responses-to-chat direction`: client speaks Responses
 * shape, upstream is Chat Completions.
 */

import {
  openAIChatToolChoiceToResponses,
  openAIChatToolToUnified,
  openAIResponsesToolToUnified,
  responsesToolChoiceToOpenAIChat,
  unifiedToolToOpenAIChat,
  unifiedToolToOpenAIResponses,
} from "./concerns/tools";
import type { OpenAIChatToolDef, OpenAIResponsesToolDef } from "./concerns/tools";
import type {
  OpenAIChatContentPart,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIResponsesFunctionCallItem,
  OpenAIResponsesInputItem,
  OpenAIResponsesOutputItem,
  OpenAIResponsesOutputMessageItem,
  OpenAIResponsesReasoningItem,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
} from "./types";

// ── OpenAI Chat request → Responses upstream ─────────────────────────────

function chatMessageToResponsesItems(msg: OpenAIChatMessage): OpenAIResponsesInputItem[] {
  const items: OpenAIResponsesInputItem[] = [];

  if (msg.role === "tool") {
    items.push({ type: "function_call_output", call_id: msg.tool_call_id ?? "", output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "") });
    return items;
  }

  for (const call of msg.tool_calls ?? []) {
    items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }

  if (msg.content === null) return items;

  const content = typeof msg.content === "string" ? msg.content : msg.content.map((p) => (p.type === "text" ? { type: "input_text" as const, text: p.text } : { type: "input_image" as const, image_url: p.image_url.url }));
  const hasContent = typeof content === "string" ? content.length > 0 : content.length > 0;
  if (hasContent) items.push({ type: "message", role: msg.role, content });

  return items;
}

export function translateChatRequestToResponses(req: OpenAIChatRequest): OpenAIResponsesRequest {
  const input = req.messages.flatMap(chatMessageToResponsesItems);
  const out: OpenAIResponsesRequest = { model: req.model, input };

  if (req.tools && req.tools.length > 0) {
    // A client can mix custom function tools with Chat-side built-in
    // extensions in the same array; those have no `.function` field at all
    // - reading it unconditionally used to crash the whole request instead
    // of just dropping the tool this proxy can't represent. Routed through
    // the shared tools.ts helpers (not reconstructed inline) so a
    // zero-argument tool missing `parameters` also gets the same schema
    // default Chat<->Anthropic already applies, instead of silently
    // shipping `parameters: undefined` to the Responses API.
    const functionTools = req.tools.filter((t): t is OpenAIChatToolDef => t.type === "function" && t.function !== undefined);
    if (functionTools.length > 0) out.tools = functionTools.map((t) => unifiedToolToOpenAIResponses(openAIChatToolToUnified(t)));
  }
  if (req.max_completion_tokens !== undefined) out.max_output_tokens = req.max_completion_tokens;
  else if (req.max_tokens !== undefined) out.max_output_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  const toolChoice = openAIChatToolChoiceToResponses(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stream !== undefined) out.stream = req.stream;

  return out;
}

export function translateResponsesResponseToChat(resp: OpenAIResponsesResponse): OpenAIChatResponse {
  const message = buildChatMessageFromOutput(resp.output);
  const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;

  return {
    id: resp.id,
    object: "chat.completion",
    created: resp.created_at,
    model: resp.model,
    choices: [{ index: 0, message, finish_reason: responsesStatusToChatFinish(resp) }],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.total_tokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
      cache_write_tokens: resp.usage.cache_write_tokens,
    },
  };
}

function buildChatMessageFromOutput(output: OpenAIResponsesOutputItem[]): OpenAIChatMessage {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]> = [];

  for (const item of output) {
    if (item.type === "message") {
      const msg = item as OpenAIResponsesOutputMessageItem;
      for (const part of msg.content) textParts.push(part.text);
    } else if (item.type === "function_call") {
      const call = item as OpenAIResponsesFunctionCallItem;
      toolCalls.push({ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } });
    } else if (item.type === "reasoning") {
      const reasoning = item as OpenAIResponsesReasoningItem;
      const summaryText = (reasoning.summary ?? []).map((s) => s.text).join("\n");
      const contentText = (reasoning.content ?? []).map((c) => c.text).join("\n");
      const text = [summaryText, contentText].filter((s) => s.length > 0).join("\n");
      if (text) reasoningParts.push(text);
    }
    // Any other built-in-tool output item (web_search_call, file_search_call,
    // code_interpreter_call, image_generation_call, mcp_call, computer_call,
    // ...) has no Chat Completions equivalent slot. Previously this branch
    // mis-typed every non-message item as a function_call, synthesizing a
    // bogus tool call with undefined id/name/arguments instead of dropping
    // it cleanly - fixed by only handling the item types Chat can represent.
  }

  const message: OpenAIChatMessage = { role: "assistant", content: textParts.length > 0 ? textParts.join("") : null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningParts.length > 0) (message as unknown as Record<string, unknown>).reasoning_content = reasoningParts.join("\n");
  return message;
}

function responsesStatusToChatFinish(resp: OpenAIResponsesResponse): OpenAIChatResponse["choices"][number]["finish_reason"] {
  if (resp.output.some((item) => item.type === "function_call")) return "tool_calls";
  if (resp.status === "incomplete" && resp.incomplete_details?.reason === "max_output_tokens") return "length";
  if (resp.status === "incomplete" && resp.incomplete_details?.reason === "content_filter") return "content_filter";
  return "stop";
}

// ── OpenAI Responses request → Chat Completions upstream ────────────────

function responsesItemToChatMessages(item: OpenAIResponsesInputItem): OpenAIChatMessage[] {
  if (item.type === "function_call") {
    return [{ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] }];
  }
  if (item.type === "function_call_output") {
    return [{ role: "tool", content: item.output, tool_call_id: item.call_id }];
  }

  const content: OpenAIChatMessage["content"] =
    typeof item.content === "string"
      ? item.content
      : item.content.map((p): OpenAIChatContentPart => (p.type === "input_text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.image_url } }));
  return [{ role: item.role, content }];
}

export function translateResponsesRequestToChat(req: OpenAIResponsesRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });

  if (typeof req.input === "string") {
    if (req.input.length > 0) messages.push({ role: "user", content: req.input });
  } else {
    messages.push(...req.input.flatMap(responsesItemToChatMessages));
  }

  const out: OpenAIChatRequest = { model: req.model, messages };

  if (req.tools && req.tools.length > 0) {
    // Built-in Responses tools (web_search_preview, code_interpreter,
    // computer_use_preview, file_search, image_generation, ...) have a
    // `type` other than "function" and no `name`/`parameters` at all -
    // reading them unconditionally used to synthesize a garbage function
    // tool named "undefined" with `parameters: undefined` instead of being
    // dropped, since Chat Completions has no equivalent slot for them.
    const functionTools = req.tools.filter((t): t is OpenAIResponsesToolDef => t.type === "function");
    if (functionTools.length > 0) out.tools = functionTools.map((t) => unifiedToolToOpenAIChat(openAIResponsesToolToUnified(t)));
  }
  if (req.max_output_tokens !== undefined) out.max_completion_tokens = req.max_output_tokens;
  const toolChoice = responsesToolChoiceToOpenAIChat(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stream !== undefined) out.stream = req.stream;

  return out;
}

export function translateChatResponseToResponses(resp: OpenAIChatResponse): OpenAIResponsesResponse {
  // The Responses API has no multi-candidate concept - if the upstream Chat
  // response carries `n > 1` choices, only the first is representable here
  // and the rest are intentionally not sent (there is no lossless mapping).
  const choice = resp.choices?.[0];
  const message = choice?.message;
  const output = buildResponsesOutput(message);
  const outputText = output
    .filter((item): item is Extract<OpenAIResponsesOutputItem, { type: "message" }> => item.type === "message")
    .flatMap((item) => item.content.map((c) => c.text))
    .join("");

  const cachedTokens = resp.usage.prompt_tokens_details?.cached_tokens ?? 0;

  const out: OpenAIResponsesResponse = {
    id: resp.id,
    object: "response",
    created_at: resp.created,
    model: resp.model,
    status: choice?.finish_reason === "length" ? "incomplete" : choice?.finish_reason === "content_filter" ? "incomplete" : "completed",
    output,
    output_text: outputText,
    usage: {
      input_tokens: resp.usage.prompt_tokens,
      output_tokens: resp.usage.completion_tokens,
      total_tokens: resp.usage.total_tokens,
      input_tokens_details: { cached_tokens: cachedTokens },
      cache_write_tokens: resp.usage.cache_write_tokens,
    },
  };
  if (out.status === "incomplete") {
    out.incomplete_details = { reason: choice?.finish_reason === "length" ? "max_output_tokens" : "content_filter" };
  }
  return out;
}

function buildResponsesOutput(message: OpenAIChatMessage | undefined): OpenAIResponsesOutputItem[] {
  if (!message) return [];
  const items: OpenAIResponsesOutputItem[] = [];

  const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((p) => p.type === "text").map((p) => (p.type === "text" ? p.text : "")).join("") : "";
  if (text.length > 0) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

  for (const call of message.tool_calls ?? []) {
    items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }

  return items;
}
