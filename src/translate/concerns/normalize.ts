/**
 * Surface ⇄ Unified normalize/denormalize.
 *
 * Every translator (`openai-to-anthropic.ts`, `anthropic-to-openai.ts`, etc.)
 * goes through these two steps instead of hand-rolling block parsing per
 * pair — normalize the wire shape into `UnifiedMessage[]`, then denormalize
 * into whatever the target wire shape wants. Adding a fifth surface later
 * means adding one normalize + one denormalize function here, not touching
 * the 4 existing translators.
 */

import { decodeImageBase64, parseDataUri, toDataUri, ImageValidationError } from "./image";
import { parseToolArguments, stringifyToolArguments } from "./tools";
import type {
  UnifiedBlock,
  UnifiedImageBlock,
  UnifiedMessage,
  UnifiedRole,
} from "./blocks";
import { isImageBlock, isOpaqueBlock, isTextBlock, isThinkingBlock, isToolCallBlock, isToolResultBlock, toAnthropicRole } from "./blocks";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRedactedThinkingBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  OpenAIChatContentPart,
  OpenAIChatMessage,
  OpenAIResponsesInputItem,
  OpenAIResponsesInputPart,
} from "../types";

function imageBlockFromUrl(url: string, cache: boolean): UnifiedImageBlock {
  const parsed = parseDataUri(url);
  if ("remoteUrl" in parsed) {
    return { type: "image", source: { kind: "url", url: parsed.remoteUrl }, cache };
  }
  try {
    const decoded = decodeImageBase64(parsed.base64);
    return { type: "image", source: { kind: "base64", mediaType: decoded.mediaType, data: parsed.base64 }, cache };
  } catch (err) {
    if (err instanceof ImageValidationError) throw err;
    throw new ImageValidationError("failed to decode inline image");
  }
}

function imageBlockToUrl(block: UnifiedImageBlock): string {
  return block.source.kind === "url" ? block.source.url : toDataUri(block.source.mediaType, block.source.data);
}

// ── OpenAI Chat Completions ⇄ Unified ────────────────────────────────────

export function normalizeOpenAIChatMessages(messages: OpenAIChatMessage[]): UnifiedMessage[] {
  return messages.map((msg): UnifiedMessage => {
    const blocks: UnifiedBlock[] = [];

    if (msg.role === "tool") {
      blocks.push({
        type: "tool_result",
        toolCallId: msg.tool_call_id ?? "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
        isError: false,
        cache: false,
      });
      return { role: "tool", blocks };
    }

    // Chat Completions has no wire slot for extended-thinking content; a
    // client echoing a prior assistant turn's `reasoning_content` /
    // `reasoning_signature` extension fields back (Cartethyia's own carrier -
    // see denormalizeToOpenAIChatMessages below) is reconstructed into a
    // proper thinking block here so the signature survives round-tripping
    // back to Anthropic instead of being silently dropped.
    if (msg.reasoning_content) {
      blocks.push({ type: "thinking", text: msg.reasoning_content, signature: msg.reasoning_signature, cache: false });
    }

    if (typeof msg.content === "string") {
      if (msg.content.length > 0) blocks.push({ type: "text", text: msg.content, cache: false });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") blocks.push({ type: "text", text: part.text, cache: false });
        else blocks.push(imageBlockFromUrl(part.image_url.url, false));
      }
    }

    for (const call of msg.tool_calls ?? []) {
      blocks.push({
        type: "tool_call",
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments),
        cache: false,
      });
    }

    return { role: msg.role as UnifiedRole, blocks };
  });
}

export function denormalizeToOpenAIChatMessages(messages: UnifiedMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];

  for (const msg of messages) {
    const toolResults = msg.blocks.filter(isToolResultBlock);
    for (const tr of toolResults) {
      // OpenAI Chat's `role:"tool"` message has no error-flag field; prefix
      // visibly instead of silently dropping is_error — the model needs to
      // know this tool call FAILED, not assume the content is a success result.
      const flat = flattenToolResultContent(tr.content);
      out.push({ role: "tool", content: tr.isError ? `[tool_error] ${flat}` : flat, tool_call_id: tr.toolCallId });
    }
    if (toolResults.length === msg.blocks.length && toolResults.length > 0) continue;

    const contentParts: OpenAIChatContentPart[] = [];
    const thinkingParts: string[] = [];
    // First signature seen wins - blocks are flattened to one string, so a
    // turn with multiple signed thinking blocks (interleaved thinking) can
    // only carry one signature through this extension-field carrier anyway.
    let thinkingSignature: string | undefined;
    for (const b of msg.blocks) {
      if (isTextBlock(b)) contentParts.push({ type: "text", text: b.text });
      else if (isImageBlock(b)) contentParts.push({ type: "image_url", image_url: { url: imageBlockToUrl(b) } });
      // Chat Completions has no wire slot for reasoning content; thinking
      // blocks are surfaced through the same `reasoning_content` extension
      // field openai-anthropic.ts already populates, instead of vanishing.
      else if (isThinkingBlock(b) && b.text) {
        thinkingParts.push(b.text);
        if (thinkingSignature === undefined) thinkingSignature = b.signature;
      }
      // Opaque blocks (server_tool_use, web_search_tool_result, ...) have no
      // Chat Completions representation and are intentionally dropped here -
      // unlike surfaces that DO have a slot for them (Anthropic-to-Anthropic
      // round-trips), where denormalizeToAnthropicBlock round-trips them.
    }

    const toolCalls = msg.blocks.filter(isToolCallBlock).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: stringifyToolArguments(tc.input) },
    }));

    if (contentParts.length === 0 && toolCalls.length === 0 && thinkingParts.length === 0) continue;

    const allText = contentParts.every((p) => p.type === "text");
    const content: OpenAIChatMessage["content"] =
      contentParts.length === 0 ? null : allText ? contentParts.map((p) => (p.type === "text" ? p.text : "")).join("") : contentParts;

    const chatMsg: OpenAIChatMessage = { role: msg.role === "tool" ? "assistant" : msg.role, content };
    if (toolCalls.length > 0) chatMsg.tool_calls = toolCalls;
    if (thinkingParts.length > 0) {
      chatMsg.reasoning_content = thinkingParts.join("\n");
      if (thinkingSignature !== undefined) chatMsg.reasoning_signature = thinkingSignature;
    }
    out.push(chatMsg);
  }

  return out;
}

// ── Anthropic Messages ⇄ Unified ─────────────────────────────────────────

/** Flattens tool-result sub-content into the plain string every surface except Anthropic's own tool_result accepts. Image/thinking/opaque sub-blocks become a short bracketed placeholder so the model still knows something was attached instead of it silently vanishing. */
export function flattenToolResultContent(content: string | UnifiedBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (isTextBlock(b)) return b.text;
      if (isImageBlock(b)) return "[image attached]";
      if (isThinkingBlock(b)) return b.text ?? "[redacted thinking]";
      if (isOpaqueBlock(b)) return `[${b.originalType} attached]`;
      return `[${b.type} attached]`;
    })
    .join("\n");
}

function normalizeAnthropicToolResultContent(content: string | AnthropicContentBlock[]): string | UnifiedBlock[] {
  if (typeof content === "string") return content;
  // Anthropic tool_result sub-blocks are text/image/document/search_result -
  // never another tool_use/tool_result - but normalizeAnthropicBlock handles
  // any shape gracefully (opaque passthrough) if that ever changes upstream.
  return content.map((b) => normalizeAnthropicBlock(b));
}

export function normalizeAnthropicBlock(block: AnthropicContentBlock): UnifiedBlock {
  const cache = "cache_control" in block && block.cache_control !== undefined;
  if (block.type === "text") return { type: "text", text: (block as AnthropicTextBlock).text, cache };
  if (block.type === "image") {
    const source = (block as AnthropicImageBlock).source;
    if (source.type === "url") return { type: "image", source: { kind: "url", url: source.url }, cache };
    return { type: "image", source: { kind: "base64", mediaType: decodeImageBase64(source.data).mediaType, data: source.data }, cache };
  }
  if (block.type === "tool_use") {
    const b = block as AnthropicToolUseBlock;
    return { type: "tool_call", id: b.id, name: b.name, input: b.input, cache };
  }
  if (block.type === "tool_result") {
    const b = block as AnthropicToolResultBlock;
    return { type: "tool_result", toolCallId: b.tool_use_id, content: normalizeAnthropicToolResultContent(b.content), isError: b.is_error ?? false, cache };
  }
  if (block.type === "thinking") {
    const b = block as AnthropicThinkingBlock;
    return { type: "thinking", text: b.thinking, signature: b.signature, cache };
  }
  if (block.type === "redacted_thinking") {
    const b = block as AnthropicRedactedThinkingBlock;
    return { type: "thinking", redactedData: b.data, cache };
  }
  // server_tool_use, web_search_tool_result, web_fetch_tool_result,
  // code_execution_tool_result, document, search_result, and any future
  // Anthropic block type - preserved verbatim instead of silently dropped
  // (a bare `undefined` here used to crash every downstream consumer).
  return { type: "opaque", originalType: block.type, raw: block as unknown as Record<string, unknown>, cache };
}

export function normalizeAnthropicMessages(messages: AnthropicMessage[]): UnifiedMessage[] {
  return messages.map((msg) => ({
    role: msg.role as UnifiedRole,
    blocks: typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content, cache: false }] : msg.content.map(normalizeAnthropicBlock),
  }));
}

export function denormalizeToAnthropicBlock(block: UnifiedBlock): AnthropicContentBlock {
  const cache_control = block.cache ? ({ type: "ephemeral" } as const) : undefined;
  if (isTextBlock(block)) {
    const b: AnthropicContentBlock = { type: "text", text: block.text };
    if (cache_control) b.cache_control = cache_control;
    return b;
  }
  if (isImageBlock(block)) {
    const source = block.source.kind === "url" ? ({ type: "url", url: block.source.url } as const) : ({ type: "base64", media_type: block.source.mediaType, data: block.source.data } as const);
    const b: AnthropicContentBlock = { type: "image", source };
    if (cache_control) b.cache_control = cache_control;
    return b;
  }
  if (isToolCallBlock(block)) {
    const b: AnthropicContentBlock = { type: "tool_use", id: block.id, name: block.name, input: block.input };
    if (cache_control) b.cache_control = cache_control;
    return b;
  }
  if (isToolResultBlock(block)) {
    const content = typeof block.content === "string" ? block.content : block.content.map((sub) => denormalizeToAnthropicBlock(sub));
    const b: AnthropicContentBlock = { type: "tool_result", tool_use_id: block.toolCallId, content, is_error: block.isError };
    if (cache_control) b.cache_control = cache_control;
    return b;
  }
  if (isThinkingBlock(block)) {
    if (block.redactedData !== undefined) return { type: "redacted_thinking", data: block.redactedData };
    return { type: "thinking", thinking: block.text ?? "", signature: block.signature };
  }
  // Opaque block - round-trip the original Anthropic shape verbatim.
  return block.raw as unknown as AnthropicContentBlock;
}

/**
 * Anthropic only allows `user` and `assistant` roles inside `messages[]`.
 * `system` messages must be extracted by the caller before this runs;
 * `tool` messages fold into `user` turns (tool_result blocks).
 */
export function denormalizeToAnthropicMessages(messages: UnifiedMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // caller extracts system separately
    const role = toAnthropicRole(msg.role);
    const content = msg.blocks.map(denormalizeToAnthropicBlock);
    if (content.length === 0) continue;
    out.push({ role, content });
  }
  return out;
}

// ── OpenAI Responses ⇄ Unified ───────────────────────────────────────────

export function normalizeOpenAIResponsesInput(input: string | OpenAIResponsesInputItem[]): UnifiedMessage[] {
  if (typeof input === "string") {
    return input.length > 0 ? [{ role: "user", blocks: [{ type: "text", text: input, cache: false }] }] : [];
  }

  return input.map((item): UnifiedMessage => {
    if (item.type === "function_call") {
      return {
        role: "assistant",
        blocks: [{ type: "tool_call", id: item.call_id, name: item.name, input: parseToolArguments(item.arguments), cache: false }],
      };
    }
    if (item.type === "function_call_output") {
      return { role: "tool", blocks: [{ type: "tool_result", toolCallId: item.call_id, content: item.output, isError: false, cache: false }] };
    }
    const blocks: UnifiedBlock[] =
      typeof item.content === "string"
        ? [{ type: "text", text: item.content, cache: false }]
        : item.content.map((p): UnifiedBlock => (p.type === "input_text" ? { type: "text", text: p.text, cache: false } : imageBlockFromUrl(p.image_url, false)));
    return { role: item.role as UnifiedRole, blocks };
  });
}

export function denormalizeToOpenAIResponsesInput(messages: UnifiedMessage[]): OpenAIResponsesInputItem[] {
  const out: OpenAIResponsesInputItem[] = [];
  for (const msg of messages) {
    for (const tr of msg.blocks.filter(isToolResultBlock)) {
      out.push({ type: "function_call_output", call_id: tr.toolCallId, output: flattenToolResultContent(tr.content) });
    }
    for (const tc of msg.blocks.filter(isToolCallBlock)) {
      out.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: stringifyToolArguments(tc.input) });
    }

    const contentBlocks = msg.blocks.filter((b) => isTextBlock(b) || isImageBlock(b));
    if (contentBlocks.length === 0) continue;

    const parts: OpenAIResponsesInputPart[] = contentBlocks.map((b) =>
      isTextBlock(b) ? { type: "input_text", text: b.text } : { type: "input_image", image_url: imageBlockToUrl(b as UnifiedImageBlock) }
    );
    out.push({ type: "message", role: msg.role === "tool" ? "user" : (msg.role as "system" | "user" | "assistant"), content: parts });
  }
  return out;
}
