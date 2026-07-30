/**
 * Finish/stop reason mapping — three vocabularies, one truth table.
 *
 * OpenAI Chat Completions: stop | length | tool_calls | content_filter | function_call
 * OpenAI Responses:        completed | incomplete | failed (plus incomplete_details.reason)
 * Anthropic Messages:      end_turn | max_tokens | tool_use | stop_sequence | pause_turn | refusal
 */

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

const OPENAI_FINISH_REASONS = new Set<string>(["stop", "length", "tool_calls", "content_filter", "function_call"]);

export function isOpenAIFinishReason(value: string): value is OpenAIFinishReason {
  return OPENAI_FINISH_REASONS.has(value);
}

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "pause_turn"
  | "refusal"
  | null;

const ANTHROPIC_TO_OPENAI: Record<Exclude<AnthropicStopReason, null>, OpenAIFinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  pause_turn: "stop",
  refusal: "content_filter",
};

const OPENAI_TO_ANTHROPIC: Record<OpenAIFinishReason, AnthropicStopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
  function_call: "tool_use",
};

export function anthropicStopToOpenAIFinish(reason: AnthropicStopReason): OpenAIFinishReason {
  if (reason === null) return "stop";
  return ANTHROPIC_TO_OPENAI[reason] ?? "stop";
}

/**
 * Same mapping as `anthropicStopToOpenAIFinish`, but a stream/materialized
 * result's own tracked tool-call state wins over the reported stop reason
 * (an upstream that reports e.g. `end_turn` while it actually emitted tool
 * calls should still surface as `tool_calls`). Used by providers that
 * reconstruct a Chat response from a raw event stream (bridge.ts,
 * result.ts) rather than translating an already-well-formed Anthropic body.
 */
export function anthropicStopToOpenAIFinishWithTools(reason: AnthropicStopReason, hadToolCalls: boolean): OpenAIFinishReason {
  if (hadToolCalls) return "tool_calls";
  return anthropicStopToOpenAIFinish(reason);
}

export function openAIFinishToAnthropicStop(reason: OpenAIFinishReason): Exclude<AnthropicStopReason, null> {
  return OPENAI_TO_ANTHROPIC[reason] ?? "end_turn";
}

/** OpenAI Responses API uses `status` + optional `incomplete_details.reason` instead of a single enum. */
export function anthropicStopToResponsesStatus(
  reason: AnthropicStopReason
): { status: "completed" | "incomplete"; incompleteReason?: "max_output_tokens" | "content_filter" } {
  if (reason === "max_tokens") return { status: "incomplete", incompleteReason: "max_output_tokens" };
  if (reason === "refusal") return { status: "incomplete", incompleteReason: "content_filter" };
  return { status: "completed" };
}
