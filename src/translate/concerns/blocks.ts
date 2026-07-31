/**
 * Unified content-block model.
 *
 * OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages each use
 * a different shape for multi-part message content. Every translator in
 * `translate/` converts through THIS shape instead of talking directly
 * OpenAI-shape ⇄ Anthropic-shape — one normalize step, one denormalize step,
 * instead of 6 bespoke pairwise converters.
 */

export type UnifiedRole = "system" | "user" | "assistant" | "tool";

export interface UnifiedTextBlock {
  type: "text";
  text: string;
  /** Present if this block should be tagged as an Anthropic cache breakpoint. */
  cache: boolean;
}

export interface UnifiedImageBlock {
  type: "image";
  /** Remote images (OpenAI `image_url` pointing at http(s)) pass through untouched — we never fetch them ourselves. */
  source: { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string };
  cache: boolean;
}

export interface UnifiedToolCallBlock {
  type: "tool_call";
  /** Correlation id: Anthropic `tool_use.id`, OpenAI `tool_calls[].id` / `call_id`. */
  id: string;
  name: string;
  /** Always an object (Anthropic `input` is native object; OpenAI `arguments` is parsed here). */
  input: Record<string, unknown>;
  cache: boolean;
}

export interface UnifiedToolResultBlock {
  type: "tool_result";
  /** Matches the originating UnifiedToolCallBlock.id. */
  toolCallId: string;
  /** Anthropic tool results can carry rich content (text + images); a surface that only accepts plain text (OpenAI Chat's tool role) gets it flattened by the denormalizer. */
  content: string | UnifiedBlock[];
  isError: boolean;
  cache: boolean;
}

/** Extended-thinking / reasoning content. `text` is absent when this represents an Anthropic `redacted_thinking` block (opaque `redactedData` only). */
export interface UnifiedThinkingBlock {
  type: "thinking";
  text?: string;
  signature?: string;
  /** Anthropic redacted_thinking's opaque encrypted payload - preserved verbatim for round-tripping back to Anthropic, never interpreted. */
  redactedData?: string;
  cache: boolean;
}

/**
 * Passthrough for a source block type this proxy does not model explicitly
 * (Anthropic server_tool_use/web_search_tool_result/document/... or OpenAI
 * Responses' built-in-tool output items). Carries the original block
 * verbatim so same-surface round-trips never silently drop data, at the
 * cost of being opaque to any denormalizer targeting a different surface.
 */
export interface UnifiedOpaqueBlock {
  type: "opaque";
  originalType: string;
  raw: Record<string, unknown>;
  cache: boolean;
}

export type UnifiedBlock =
  | UnifiedTextBlock
  | UnifiedImageBlock
  | UnifiedToolCallBlock
  | UnifiedToolResultBlock
  | UnifiedThinkingBlock
  | UnifiedOpaqueBlock;

export interface UnifiedMessage {
  role: UnifiedRole;
  blocks: UnifiedBlock[];
}

/**
 * Role mapping — Anthropic has no "system" message role (it's a top-level
 * `system` field instead), Anthropic has no "tool" role (tool results are
 * `user` messages with tool_result blocks), OpenAI has both as first-class
 * message roles.
 */

/** Anthropic Messages API only accepts these two roles inside `messages[]`. */
export type AnthropicRole = "user" | "assistant";

export function toAnthropicRole(role: UnifiedRole): AnthropicRole {
  // Anthropic folds "system" into the top-level `system` field (handled by the
  // caller before this ever runs) and folds "tool" results into "user" turns.
  return role === "assistant" ? "assistant" : "user";
}

export function textBlock(text: string, cache = false): UnifiedTextBlock {
  return { type: "text", text, cache };
}

export function isTextBlock(b: UnifiedBlock): b is UnifiedTextBlock {
  return b.type === "text";
}

export function isImageBlock(b: UnifiedBlock): b is UnifiedImageBlock {
  return b.type === "image";
}

export function isToolCallBlock(b: UnifiedBlock): b is UnifiedToolCallBlock {
  return b.type === "tool_call";
}

export function isToolResultBlock(b: UnifiedBlock): b is UnifiedToolResultBlock {
  return b.type === "tool_result";
}

export function isThinkingBlock(b: UnifiedBlock): b is UnifiedThinkingBlock {
  return b.type === "thinking";
}

export function isOpaqueBlock(b: UnifiedBlock): b is UnifiedOpaqueBlock {
  return b.type === "opaque";
}

/** Concatenate all text blocks in a message — used when a target shape wants plain string content. */
export function flattenText(blocks: UnifiedBlock[]): string {
  return blocks.filter(isTextBlock).map((b) => b.text).join("");
}
