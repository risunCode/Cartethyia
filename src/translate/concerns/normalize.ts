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
import { isImageBlock, isTextBlock, isToolCallBlock, isToolResultBlock, toAnthropicRole } from "./blocks";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
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
      out.push({ role: "tool", content: tr.isError ? `[tool_error] ${tr.content}` : tr.content, tool_call_id: tr.toolCallId });
    }
    if (toolResults.length === msg.blocks.length && toolResults.length > 0) continue;

    const contentParts: OpenAIChatContentPart[] = [];
    for (const b of msg.blocks) {
      if (isTextBlock(b)) contentParts.push({ type: "text", text: b.text });
      else if (isImageBlock(b)) contentParts.push({ type: "image_url", image_url: { url: imageBlockToUrl(b) } });
    }

    const toolCalls = msg.blocks.filter(isToolCallBlock).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: stringifyToolArguments(tc.input) },
    }));

    if (contentParts.length === 0 && toolCalls.length === 0) continue;

    const allText = contentParts.every((p) => p.type === "text");
    const content: OpenAIChatMessage["content"] =
      contentParts.length === 0 ? null : allText ? contentParts.map((p) => (p.type === "text" ? p.text : "")).join("") : contentParts;

    const chatMsg: OpenAIChatMessage = { role: msg.role === "tool" ? "assistant" : msg.role, content };
    if (toolCalls.length > 0) chatMsg.tool_calls = toolCalls;
    out.push(chatMsg);
  }

  return out;
}

// ── Anthropic Messages ⇄ Unified ─────────────────────────────────────────

export function normalizeAnthropicBlock(block: AnthropicContentBlock): UnifiedBlock {
  const cache = block.cache_control !== undefined;
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, cache };
    case "image":
      if (block.source.type === "url") return { type: "image", source: { kind: "url", url: block.source.url }, cache };
      return { type: "image", source: { kind: "base64", mediaType: decodeImageBase64(block.source.data).mediaType, data: block.source.data }, cache };
    case "tool_use":
      return { type: "tool_call", id: block.id, name: block.name, input: block.input, cache };
    case "tool_result":
      return { type: "tool_result", toolCallId: block.tool_use_id, content: block.content, isError: block.is_error ?? false, cache };
  }
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
  const b: AnthropicContentBlock = { type: "tool_result", tool_use_id: block.toolCallId, content: block.content, is_error: block.isError };
  if (cache_control) b.cache_control = cache_control;
  return b;
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
      out.push({ type: "function_call_output", call_id: tr.toolCallId, output: tr.content });
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
