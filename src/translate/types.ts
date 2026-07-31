/**
 * Wire types — the on-the-wire JSON shapes for each surface. These are
 * intentionally narrower than the full OpenAI/Anthropic spec: only the
 * fields Cartethyia reads or writes are typed, everything else round-trips
 * through `[key: string]: unknown` so unknown fields survive translation
 * instead of getting silently dropped.
 */

// ── OpenAI Chat Completions ────────────────────────────────────────────

export interface OpenAIChatTextPart {
  type: "text";
  text: string;
}

export interface OpenAIChatImagePart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export type OpenAIChatContentPart = OpenAIChatTextPart | OpenAIChatImagePart;

export interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** `"auto"` (default) / `"none"` (never call) / `"required"` (must call some tool) / pin to one named function. */
export type OpenAIChatToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export interface OpenAIChatMessage {
  /** "developer" replaces "system" for o-series/gpt-5 models; Cartethyia treats it identically to "system" wherever the system prompt is extracted. */
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | OpenAIChatContentPart[] | null;
  tool_calls?: OpenAIChatToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Set when the upstream model refused to answer (mirrors Anthropic's `stop_reason:"refusal"`); mutually exclusive with normal `content` in the official spec, but Cartethyia keeps both so no signal is lost in translation. */
  refusal?: string;
  /** Non-standard extension field: carries an Anthropic extended-thinking block's text through the internal Chat-shaped representation every provider dispatch goes through (Chat Completions has no native reasoning-content wire slot). */
  reasoning_content?: string;
  /** Non-standard extension field: the Anthropic thinking block's cryptographic `signature`, carried alongside `reasoning_content` so a replayed thinking block can round-trip back to Anthropic (extended thinking + tool use rejects an unsigned or re-typed thinking block on the next turn). Single-block scope - not modeled per-block, so multiple thinking blocks in one turn (interleaved thinking) keep only the first signature. */
  reasoning_signature?: string;
}

export type OpenAIResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name?: string; schema: Record<string, unknown>; strict?: boolean } };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: { type: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  tool_choice?: OpenAIChatToolChoice;
  response_format?: OpenAIResponseFormat;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  /** `false` pins the model to at most one tool call per turn; translated to Anthropic's `tool_choice.disable_parallel_tool_use`. */
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
}

export interface OpenAIChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_write_tokens?: number;
  /** True when the upstream response omitted a usage block and these counts are a rough estimate. */
  estimated?: boolean;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: OpenAIChatMessage;
    finish_reason: string;
  }[];
  usage: OpenAIChatUsage;
}

// ── Anthropic Messages ──────────────────────────────────────────────────

export interface AnthropicCacheControl {
  type: "ephemeral";
  /** Cache breakpoint lifetime; Anthropic defaults to "5m" when omitted. */
  ttl?: "5m" | "1h";
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** Anthropic allows plain text or a list of blocks (text/image/document/...) inside a tool result. */
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
  cache_control?: AnthropicCacheControl;
}

/** Extended-thinking block — visible reasoning text, present when `thinking` is enabled on the request. */
export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/** Extended-thinking block with `display:"omitted"` - the text is redacted; the `data` payload is opaque and only meaningful back to Anthropic. */
export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

/**
 * Catch-all for Anthropic content-block types this proxy does not model
 * explicitly (`server_tool_use`, `web_search_tool_result`,
 * `web_fetch_tool_result`, `code_execution_tool_result`, `document`,
 * `search_result`, and any block type Anthropic adds later). Preserved
 * verbatim so Anthropic\u2194Anthropic round-trips never silently drop data.
 */
export interface AnthropicOpaqueBlock {
  type: string;
  [key: string]: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicOpaqueBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** `"auto"` (default) / `"any"` (must call some tool) / `"none"` (never call) / pin to one named tool. `disable_parallel_tool_use` forces at most one tool call regardless of variant. */
export type AnthropicToolChoice =
  | { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown>; type?: string; cache_control?: AnthropicCacheControl }[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  /** Extended thinking, translated in from an OpenAI-shaped `reasoning_effort`. */
  thinking?: { type: "enabled"; budget_tokens: number };
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** True when the upstream response omitted a usage block and these counts are a rough estimate. */
  estimated?: boolean;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "pause_turn" | "refusal" | "model_context_window_exceeded" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ── OpenAI Responses API ────────────────────────────────────────────────

export interface OpenAIResponsesTextInput {
  type: "input_text";
  text: string;
}

export interface OpenAIResponsesImageInput {
  type: "input_image";
  image_url: string;
}

export type OpenAIResponsesInputPart = OpenAIResponsesTextInput | OpenAIResponsesImageInput;

export interface OpenAIResponsesMessageItem {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: string | OpenAIResponsesInputPart[];
}

export interface OpenAIResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface OpenAIResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem;

/** Responses' vocabulary matches Chat's, but "specific function" is flat (`{type:"function",name}`), not nested. */
export type OpenAIResponsesToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

export interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIResponsesInputItem[];
  instructions?: string;
  tools?: { type: string; name: string; description?: string; parameters?: Record<string, unknown> }[];
  tool_choice?: OpenAIResponsesToolChoice;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIResponsesOutputTextPart {
  type: "output_text";
  text: string;
}

export interface OpenAIResponsesOutputMessageItem {
  type: "message";
  role: "assistant";
  content: OpenAIResponsesOutputTextPart[];
}

/** Reasoning output item - model's internal reasoning, when requested via `reasoning.summary`/`include`. */
export interface OpenAIResponsesReasoningItem {
  type: "reasoning";
  id?: string;
  summary?: { type: "summary_text"; text: string }[];
  content?: { type: "reasoning_text"; text: string }[];
  encrypted_content?: string;
}

/**
 * Catch-all for built-in-tool output items this proxy does not model
 * explicitly (`web_search_call`, `file_search_call`, `code_interpreter_call`,
 * `image_generation_call`, `mcp_call`, `computer_call`, ...). Recognized so
 * they are never mistaken for a `function_call` (which has a different,
 * incompatible shape) - see `buildChatMessageFromOutput`.
 */
export interface OpenAIResponsesOpaqueOutputItem {
  type: string;
  [key: string]: unknown;
}

export type OpenAIResponsesOutputItem =
  | OpenAIResponsesOutputMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesReasoningItem
  | OpenAIResponsesOpaqueOutputItem;

export interface OpenAIResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  cache_write_tokens?: number;
}

export interface OpenAIResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "incomplete" | "failed";
  incomplete_details?: { reason: "max_output_tokens" | "content_filter" };
  output: OpenAIResponsesOutputItem[];
  output_text?: string;
  usage: OpenAIResponsesUsage;
}
