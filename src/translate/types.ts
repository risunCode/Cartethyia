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
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIChatContentPart[] | null;
  tool_calls?: OpenAIChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type OpenAIResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name?: string; schema: Record<string, unknown>; strict?: boolean } };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }[];
  tool_choice?: OpenAIChatToolChoice;
  response_format?: OpenAIResponseFormat;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_write_tokens?: number;
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
  content: string;
  is_error?: boolean;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** `"auto"` (default) / `"any"` (must call some tool) / `"none"` (never call) / pin to one named tool. */
export type AnthropicToolChoice = { type: "auto" | "any" | "none" } | { type: "tool"; name: string };

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema: Record<string, unknown>; cache_control?: AnthropicCacheControl }[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "pause_turn" | "refusal" | null;
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
  role: "system" | "user" | "assistant";
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
  tools?: { type: "function"; name: string; description?: string; parameters: Record<string, unknown> }[];
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

export type OpenAIResponsesOutputItem = OpenAIResponsesOutputMessageItem | OpenAIResponsesFunctionCallItem;

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
