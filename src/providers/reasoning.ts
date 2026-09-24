import type { CanonicalRequest, ReasoningEffort, ReasoningIntent } from "../transport/canonical-model";
import { isRecord } from "../protocol/primitives";

/**
 * The effective reasoning effort for a canonical intent, deriving one from an
 * Anthropic-shaped `thinking` block when no explicit effort is set.
 *
 * An Anthropic client states reasoning as `thinking: { type, budget_tokens }`,
 * which the canonical model keeps as `thinking_type`/`budget_tokens` — fields
 * the OpenAI-family wires do not define. Every OpenAI-style consumer therefore
 * needs the same translation, and two of them deriving it independently is how
 * a wire ends up with an unmappable reasoning object. Returns `undefined` when
 * the intent carries no reasoning at all (or explicitly disables it).
 */
export function reasoningEffortFromIntent(reasoning: ReasoningIntent | undefined): ReasoningEffort | undefined {
  if (reasoning === undefined) return undefined;
  if (reasoning.thinking_type === "disabled") return "none";
  if (reasoning.effort !== undefined) return reasoning.effort;
  if (reasoning.thinking_type !== "enabled" && reasoning.thinking_type !== "adaptive") return undefined;
  const budget = reasoning.budget_tokens;
  if (budget === undefined) return "high";
  if (budget >= 16_000) return "max";
  if (budget >= 4_096) return "high";
  return "low";
}

/** Projects canonical reasoning intent onto OpenAI-style effort controls. */
export function applyOpenAIReasoning(payload: Record<string, unknown>, request: CanonicalRequest | undefined): void {
  if (request === undefined || payload["reasoning_effort"] !== undefined) return;
  const effort = reasoningEffortFromIntent(request.reasoning);
  if (effort === undefined) return;
  payload["reasoning_effort"] = effort;
}

/** Applies the DeepSeek chat contract shared by CodeBuddy and WorkBuddy. */
export function applyDeepSeekReasoning(payload: Record<string, unknown>): void {
  const model = typeof payload["model"] === "string" ? payload["model"].trim().toLowerCase() : "";
  if (!model.startsWith("deepseek")) return;
  const thinking = isRecord(payload["thinking"]) ? payload["thinking"] : undefined;
  const type = typeof thinking?.["type"] === "string" ? thinking["type"].trim().toLowerCase() : "";
  if (type === "disabled") {
    delete payload["reasoning_effort"];
    delete payload["reasoningEffort"];
    return;
  }
  if (thinking === undefined) payload["thinking"] = { type: "enabled" };
  else if (type.length === 0) thinking["type"] = "enabled";
  if (typeof payload["reasoning_effort"] !== "string" || payload["reasoning_effort"].length === 0)
    payload["reasoning_effort"] = "high";
}

/** Backfills DeepSeek assistant reasoning_content required for replayed turns. */
export function backfillDeepSeekReasoningContent(payload: Record<string, unknown>): void {
  const thinking = payload["thinking"];
  const thinkingEnabled = isRecord(thinking) && thinking["type"] === "enabled";
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  const hasTrace = messages.some(
    (message) =>
      isRecord(message) &&
      ((typeof message["reasoning"] === "string" && message["reasoning"].length > 0) ||
        "reasoning_content" in message),
  );
  if (!thinkingEnabled && !hasTrace) return;
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    if (typeof message["reasoning_content"] === "string") continue;
    // Only a real trace is backfilled. Writing `""` onto every assistant turn
    // made the payload claim reasoning it did not have: the upstream reads the
    // empty field as "thinking mode with the reasoning stripped", and rejects
    // the next turn with "the reasoning content from the previous turn must be
    // passed back in thinking mode". A turn with nothing to replay stays
    // without the field so the provider sees a normal assistant turn.
    if (typeof message["reasoning"] !== "string" || message["reasoning"].length === 0) continue;
    message["reasoning_content"] = message["reasoning"];
  }
}

/** Returns Gemini's minimum output budget for a canonical reasoning intent. */
export function geminiThinkingOutputFloor(reasoning: CanonicalRequest["reasoning"]): number | undefined {
  if (reasoning === undefined || reasoning.thinking_type === "disabled") return undefined;
  if (reasoning.budget_tokens !== undefined) return geminiBudgetOutputFloor(reasoning.budget_tokens);
  if (reasoning.effort !== undefined && reasoning.effort !== "none") return geminiLevelOutputFloor(reasoning.effort);
  return undefined;
}

/** Builds the Anthropic thinking block from canonical reasoning intent. */
export function buildAnthropicThinkingPayload(reasoning: ReasoningIntent): Record<string, unknown> {
  const blockBinding =
    reasoning.prefix_mismatch_behavior === undefined
      ? undefined
      : { prefix_mismatch_behavior: reasoning.prefix_mismatch_behavior };
  return {
    type: reasoning.thinking_type ?? "adaptive",
    ...(reasoning.budget_tokens === undefined ? {} : { budget_tokens: reasoning.budget_tokens }),
    ...(reasoning.display === undefined ? {} : { display: reasoning.display }),
    ...(blockBinding === undefined ? {} : { block_binding: blockBinding }),
  };
}

function geminiBudgetOutputFloor(budget: number): number {
  if (!Number.isFinite(budget)) return 32768;
  if (budget <= 1024) return 8192;
  if (budget <= 8192) return 16384;
  if (budget <= 24576) return 32768;
  return 65535;
}

function geminiLevelOutputFloor(level: string): number {
  switch (level) {
    case "minimal":
      return 4096;
    case "low":
      return 8192;
    case "medium":
      return 16384;
    case "high":
    case "xhigh":
    case "max":
      return 65535;
    default:
      return 65535;
  }
}

