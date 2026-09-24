// Thinking-config normalization on canonical requests.
//
// Provider-native extended thinking (Anthropic `thinking` object) is only
// honored on a fresh user turn. On a tool-result turn the upstream rejects it,
// so the native config (`thinking_type` + `budget_tokens`) is dropped while the
// request-level effort intent (OpenAI `reasoning_effort`) survives — that field
// is a property of the request, not of the turn.
import type { CanonicalRequest, WireFamily } from "../canonical-model";

/**
 * Canonical reasoning effort ladder, ordered least to most intensive.
 * Provides a unified effort scale across OpenAI, Anthropic, and open-weight models.
 */
export const REASONING_EFFORT_LADDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LADDER)[number];

/** Standard OpenAI Responses wire supported efforts (OpenAI, OpenCode, Azure). Responses API has no 'max' tier. */
export const RESPONSES_WIRE_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Full 6-tier effort scale for models that support 'max' (Claude, MiMo, Kimi, DeepSeek). */
export const EXTENDED_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Standard 4-tier effort scale (Gemini, Qwen). */
export const BASE_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

/**
 * The `mimo-v2.6` family rejects every effort outside this set.
 *
 * Verified live against OpenCode's `/zen/v1` on 2026-09-22: `minimal`, `xhigh`,
 * and `max` each answer `500 {"type":"error","error":{"message":"Internal server
 * error"}}` — an opaque failure that names nothing, so the caller sees a dead
 * request rather than a bad parameter — while `low`/`medium`/`high` and an
 * omitted field answer `200`. Its siblings on the very same endpoint
 * (`mimo-v2.5-free`, `nemotron-3-ultra-free`, `big-pickle`) accept the full
 * ladder, so this is a property of the model rather than of the route.
 *
 * Narrowing is the safe direction: every level here is accepted by all hosts of
 * the id, so the worst case for a host that would also take `xhigh` is that the
 * request runs one tier below what the caller asked for instead of failing.
 */
const MIMO_V26_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = ["low", "medium", "high"];

/**
 * `low..max`: the OpenAI 5.6/6/daybreak generation and the new-gen Claude
 * adaptive models (`fable`/`mythos`/`opus-5`/`sonnet-5`/`opus-4-7`/`opus-4-8`)
 * all serve `max`, and none of them advertises `minimal`.
 */
const LOW_TO_MAX_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** `gpt-5.5` rows: neither `minimal` nor `max`. */
const GPT55_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Claude adaptive 4.6 pair: `low..high`, no `xhigh`/`max`. */
const CLAUDE_ADAPTIVE_46_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
];

/**
 * Resolves the valid reasoning effort levels for a given model and wire family.
 *
 * Priority order:
 * 1. Explicit model-declared `reasoningEfforts` from the catalog.
 * 2. Wire family constraint: the Responses wire API (`/v1/responses`) does not
 *    support 'max' (capped at 'xhigh') unless the model's published ladder
 *    includes it.
 * 3. Model family heuristics, matching each family's published ladder:
 *    - Muse Spark (Meta on OpenCode / Fireworks): `["minimal", "low", "medium", "high", "xhigh"]`
 *    - Gemini: `["minimal", "low", "medium", "high"]`
 *    - Claude: per-generation — 4.6 adaptive stops at `high`, budget-era 4.5/4.1
 *      tops out at `xhigh`, new-gen adaptive is `low..max`.
 *    - DeepSeek, Kimi, MiMo: full extended ladder including 'max'
 *    - Default: extended ladder.
 */
export function resolveSupportedReasoningEfforts(
  modelId?: string,
  wireFamily?: WireFamily,
  declaredEfforts?: readonly string[],
): readonly ReasoningEffortLevel[] {
  if (declaredEfforts !== undefined && declaredEfforts.length > 0) {
    const filtered = declaredEfforts.filter((e): e is ReasoningEffortLevel =>
      REASONING_EFFORT_LADDER.includes(e as ReasoningEffortLevel),
    );
    if (filtered.length > 0) return filtered;
  }

  const id = (modelId ?? "").toLowerCase();

  if (wireFamily === "responses") {
    // Catalog ladders for the ChatGPT/OpenAI generations: `gpt-5.5`
    // is the one row that stops at `xhigh`.
    if (id.includes("gpt-5.5")) return GPT55_SUPPORTED_EFFORTS;
    if (id.includes("gpt-5.6") || id.includes("gpt-6") || id.includes("daybreak")) {
      return LOW_TO_MAX_SUPPORTED_EFFORTS;
    }
    return RESPONSES_WIRE_SUPPORTED_EFFORTS;
  }

  if (id.includes("muse")) {
    return RESPONSES_WIRE_SUPPORTED_EFFORTS;
  }
  if (id.includes("gemini")) {
    return BASE_SUPPORTED_EFFORTS;
  }
  // Checked before the generic default, which would hand this family `xhigh`
  // and `max` — both of which it answers with an opaque 500.
  if (id.includes("mimo-v2.6")) {
    return MIMO_V26_SUPPORTED_EFFORTS;
  }
  // Claude catalog ladders: `output_config.effort` rides the
  // Messages wire, so an out-of-ladder tier is an upstream rejection risk.
  // Dot-tolerant (`cb/claude-opus-4.6`) because gateway-prefixed ids keep the
  // upstream separator.
  if (id.includes("claude")) {
    const claudeId = id.replaceAll(".", "-");
    if (claudeId.includes("opus-4-6") || claudeId.includes("sonnet-4-6")) {
      return CLAUDE_ADAPTIVE_46_SUPPORTED_EFFORTS;
    }
    if (
      claudeId.includes("fable") ||
      claudeId.includes("mythos") ||
      claudeId.includes("opus-5") ||
      claudeId.includes("sonnet-5") ||
      claudeId.includes("opus-4-7") ||
      claudeId.includes("opus-4-8")
    ) {
      return LOW_TO_MAX_SUPPORTED_EFFORTS;
    }
    if (
      claudeId.includes("opus-4-5") ||
      claudeId.includes("sonnet-4-5") ||
      claudeId.includes("haiku-4-5") ||
      claudeId.includes("opus-4-1") ||
      claudeId.includes("opus-4-0") ||
      claudeId.includes("sonnet-4-0")
    ) {
      // Budget-mode rows: `minimal..xhigh`, no `max` — same shape as the
      // responses-wire default.
      return RESPONSES_WIRE_SUPPORTED_EFFORTS;
    }
  }

  return EXTENDED_SUPPORTED_EFFORTS;
}

/**
 * Clamps a requested reasoning effort against a target model/wire's supported ladder.
 *
 * If the requested effort is not in the supported list, it gracefully steps down to the
 * highest supported level that is less than or equal to the requested index in the canonical ladder.
 * Synonyms are normalized: 'ultra' -> 'max', 'off' -> 'none'.
 * Returns undefined for 'none' / unrequested.
 */
export function clampReasoningEffort(
  requested: string | undefined,
  supported: readonly ReasoningEffortLevel[],
): ReasoningEffortLevel | undefined {
  if (!requested || typeof requested !== "string") return undefined;
  const raw = requested.toLowerCase().trim();
  const normalized = raw === "ultra" ? "max" : raw === "off" ? "none" : raw;
  if (normalized === "none") return undefined;

  const reqLevel = normalized as ReasoningEffortLevel;
  if (supported.includes(reqLevel)) {
    return reqLevel;
  }

  const requestedIndex = REASONING_EFFORT_LADDER.indexOf(reqLevel);
  if (requestedIndex === -1) return undefined;

  let clamped: ReasoningEffortLevel | undefined;
  for (const level of supported) {
    if (REASONING_EFFORT_LADDER.indexOf(level) > requestedIndex) break;
    clamped = level;
  }
  return clamped ?? supported[0];
}

export interface ThinkingNormalizationOptions {
  readonly wireFamily?: WireFamily;
  readonly modelId?: string;
  readonly supportedEfforts?: readonly string[];
}

/**
 * True when there are no messages or the last message is a user turn. A request
 * with no history is treated as user-originated.
 */
function isLastMessageFromUser(request: CanonicalRequest): boolean {
  const last = request.messages[request.messages.length - 1];
  return last === undefined || last.role === "user";
}

/**
 * True when the conversation replays provider thinking blocks (signed,
 * opaque, or encrypted). Anthropic rejects those blocks unless the matching
 * `thinking` config is also present, so a config drop must never leave them
 * orphaned.
 */
export function hasReplayedThinkingBlocks(request: CanonicalRequest): boolean {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "reasoning") continue;
      if (
        part.opaque === true ||
        part.encrypted_content !== undefined ||
        part.signature !== undefined
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Drops provider-native thinking config when the last message is not a user
 * turn. `effort` is request-level intent and is preserved.
 *
 * The drop is suppressed when the conversation replays thinking blocks: a
 * config-less request carrying signed/encrypted blocks is rejected upstream
 * ("thinking is not enabled"), so the two must stay in sync. Returns the same
 * reference when there is nothing to change; never mutates the input.
 */
export function normalizeThinkingConfig(
  request: CanonicalRequest,
  options?: ThinkingNormalizationOptions,
): CanonicalRequest {
  let reasoning = request.reasoning;
  let changed = false;

  // Step 1: Normalize turn-based native thinking blocks (drop on non-user turns unless replaying blocks)
  if (!isLastMessageFromUser(request) && reasoning !== undefined) {
    if (
      (reasoning.thinking_type !== undefined || reasoning.budget_tokens !== undefined) &&
      !hasReplayedThinkingBlocks(request)
    ) {
      reasoning = { ...reasoning };
      delete reasoning.thinking_type;
      delete reasoning.budget_tokens;
      changed = true;
    }
  }

  // Step 2: Normalize effort against model/wire capabilities if effort is present
  if (reasoning?.effort !== undefined) {
    const supported = resolveSupportedReasoningEfforts(
      options?.modelId ?? request.model,
      options?.wireFamily,
      options?.supportedEfforts,
    );
    const clamped = clampReasoningEffort(reasoning.effort, supported);
    if (clamped !== reasoning.effort) {
      reasoning = { ...reasoning };
      if (clamped === undefined) delete reasoning.effort;
      else reasoning.effort = clamped;
      changed = true;
    }
  }

  if (!changed) return request;
  if (reasoning === undefined) {
    const next = { ...request };
    delete next.reasoning;
    return next;
  }
  return { ...request, reasoning };
}
