// Thinking-config normalization on canonical requests.
//
// Provider-native extended thinking (Anthropic `thinking` object) is only
// honored on a fresh user turn. On a tool-result turn the upstream rejects it,
// so the native config (`thinking_type` + `budget_tokens`) is dropped while the
// request-level effort intent (OpenAI `reasoning_effort`) survives — that field
// is a property of the request, not of the turn.
import type { CanonicalRequest, ReasoningIntent, WireFamily } from "../canonical-model";

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

/**
 * A client-requested thinking level written onto the model name as
 * `model(level)` or `model(budget)`.
 *
 * `mode: "auto"` means "let the provider decide" and `mode: "none"` means
 * "reasoning off" — both are distinct from an absent suffix, which means the
 * caller expressed no opinion at all.
 */
export type ThinkingSuffixIntent =
  | { readonly mode: "level"; readonly level: ReasoningEffortLevel }
  | { readonly mode: "budget"; readonly budget: number }
  | { readonly mode: "none" }
  | { readonly mode: "auto" };

/**
 * A parsed model name: the bare id the router and upstream must see, plus the
 * thinking level the caller asked for (or null when they asked for none).
 */
export interface ParsedThinkingSuffix {
  readonly model: string;
  readonly intent: ThinkingSuffixIntent | null;
}

/**
 * Level → thinking budget in tokens.
 *
 * The ladder is the published Anthropic/Gemini scale, kept here as the single
 * source of truth for both directions. `none` is 0 because "off" is the one
 * value the ladder cannot express as a positive budget.
 */
export const LEVEL_TO_BUDGET: Readonly<Record<ReasoningEffortLevel | "none", number>> = {
  none: 0,
  minimal: 512,
  low: 1_024,
  medium: 8_192,
  high: 24_576,
  xhigh: 32_768,
  max: 128_000,
};

/**
 * Upper bound (inclusive) for each tier when reading a budget back as a level.
 *
 * These are the reference implementation's thresholds, kept verbatim so the two
 * cannot drift. They are the midpoints between adjacent `LEVEL_TO_BUDGET`
 * values, except `low`/`medium`, which the reference pins at the round 4_096
 * rather than the midpoint 4_608.
 */
const BUDGET_LEVEL_CEILINGS: readonly (readonly [ReasoningEffortLevel, number])[] = [
  ["minimal", 768],
  ["low", 4_096],
  ["medium", 16_384],
  ["high", 28_672],
  ["xhigh", 80_384],
];

/**
 * Nearest ladder level for a token budget.
 *
 * The previous heuristic here bucketed everything from 4_096 up as `high`, so a
 * deliberate 4_096-token budget read as a bigger ask than it was — the same
 * input the reference calls `low`. Reading through one shared table keeps a
 * budget expressed as tokens and the same request expressed as a level
 * agreeing.
 *
 * Returns null for a non-positive budget (no reasoning).
 */
export function budgetToLevel(budget: number): ReasoningEffortLevel | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  for (const [level, ceiling] of BUDGET_LEVEL_CEILINGS) {
    if (budget <= ceiling) return level;
  }
  return "max";
}

/**
 * Splits a thinking suffix off a model name.
 *
 * The syntax is `model(level)` — parentheses, deliberately, not a dash. A dash
 * suffix would be ambiguous: this catalog contains 73 ids that end in a level
 * word, and for 22 of them the truncated prefix is itself a real model
 * (`gemini-3.1-pro-high` → `gemini-3.1-pro`, `gpt-5.1-codex-max` →
 * `gpt-5.1-codex`, `o3-mini-high` → `o3-mini`). Stripping those would silently
 * redirect a request to a different model. No model id in the catalog contains
 * a parenthesis, so this form is unambiguous without consulting any catalog.
 *
 * An unrecognized or empty value leaves the model untouched: a typo must not
 * fail an otherwise valid request.
 */
export function parseThinkingSuffix(model: string): ParsedThinkingSuffix {
  const match = /^(.*)\(([^()]*)\)\s*$/.exec(model);
  if (match === null) return { model, intent: null };
  const bare = match[1]!.trim();
  // A name that is nothing but a suffix (`(high)`) is not a model we can route;
  // leave it alone so the caller gets a normal model-not-found rather than a
  // confusing empty-name error.
  if (bare.length === 0) return { model, intent: null };
  const raw = match[2]!.trim().toLowerCase();
  if (raw === "none" || raw === "off") return { model: bare, intent: { mode: "none" } };
  if (raw === "auto") return { model: bare, intent: { mode: "auto" } };
  // `ultra` is a vendor synonym for the top tier, matching `clampReasoningEffort`.
  if (raw === "ultra") return { model: bare, intent: { mode: "level", level: "max" } };
  if (/^\d+$/.test(raw)) {
    const budget = Number(raw);
    return budget > 0
      ? { model: bare, intent: { mode: "budget", budget } }
      : { model, intent: null };
  }
  if (REASONING_EFFORT_LADDER.includes(raw as ReasoningEffortLevel)) {
    return { model: bare, intent: { mode: "level", level: raw as ReasoningEffortLevel } };
  }
  return { model, intent: null };
}

/**
 * The model name a client would write to request `level`, i.e. the inverse of
 * {@link parseThinkingSuffix}: `claude-sonnet-4-5` + `low` → `claude-sonnet-4-5(low)`.
 *
 * Exists so the naming rule lives in one place: the dashboard renders the
 * routable id an operator should copy, and a hand-written `(level)` string there
 * would drift from the parser the moment either side changes. `auto` and `none`
 * are real suffix values the parser accepts, so they round-trip too; an absent
 * level (no opinion) leaves the bare id.
 */
export function formatThinkingSuffix(model: string, level: ReasoningEffortLevel | "auto" | "none" | null): string {
  if (level === null) return model;
  return `${model}(${level})`;
}

/**
 * Writes a parsed suffix intent onto a request's reasoning state.
 *
 * The suffix wins over whatever the body said: it is the more specific,
 * per-request statement of intent, and a caller who writes both is asking for
 * the model name to decide.
 *
 * A numeric budget is normalized to its nearest ladder tier rather than carried
 * through as a token count. That is deliberate — the tier is what the per-model
 * clamp understands, so `model(128000)` on a model that tops out at `high`
 * lands on `high` instead of leaving a 128k budget next to a clamped effort.
 * Normalizing to the tier is what makes one suffix mean the same thing on every
 * model.
 */
export function withThinkingSuffixIntent(
  request: CanonicalRequest,
  intent: ThinkingSuffixIntent,
): CanonicalRequest {
  const reasoning: ReasoningIntent = { ...(request.reasoning ?? {}) };

  if (intent.mode === "none") {
    // `disabled` is the explicit switch: clearing `effort` alone leaves the
    // upstream free to reason, because absence means "no opinion", not "off".
    reasoning.thinking_type = "disabled";
    delete reasoning.effort;
    delete reasoning.budget_tokens;
  } else if (intent.mode === "auto") {
    delete reasoning.effort;
    delete reasoning.budget_tokens;
    if (reasoning.thinking_type === "disabled") delete reasoning.thinking_type;
  } else {
    const level = intent.mode === "budget" ? budgetToLevel(intent.budget) : intent.level;
    if (level === null) return request;
    reasoning.effort = level;
    delete reasoning.budget_tokens;
    if (reasoning.thinking_type === "disabled") delete reasoning.thinking_type;
  }

  if (Object.keys(reasoning).length === 0) {
    const next = { ...request };
    delete next.reasoning;
    return next;
  }
  return { ...request, reasoning };
}

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
 * Whether a Claude model wants *adaptive* thinking (`thinking.type: "adaptive"`
 * + `output_config.effort`) or *budget* thinking (`thinking.type: "enabled"` +
 * `budget_tokens`).
 *
 * The two generations reject each other's shape: an adaptive-era model answers
 * a budget block with `thinking.budget_tokens: Extra inputs are not permitted`,
 * and a budget-era model answers an adaptive block with `adaptive thinking is
 * not supported on this model` (verified live against the Anthropic OAuth
 * route — opus-4-5/sonnet-4-5/haiku-4-5 400 on adaptive, while
 * opus-4-6+/sonnet-4-6+/5-series accept it).
 *
 * Adaptive era, per the reference catalog: Opus 4.6+, Sonnet 4.6+, and the
 * 5-series (fable/mythos/opus-5/sonnet-5). Everything older is budget era.
 * The rule is stated once here so the Messages codec and the effort ladder
 * cannot disagree about which generation a model belongs to.
 */
export function claudeUsesAdaptiveThinking(modelId: string): boolean {
  const id = modelId.toLowerCase().replaceAll(".", "-");
  if (id.includes("fable") || id.includes("mythos")) return true;
  if (id.includes("opus-5") || id.includes("sonnet-5")) return true;
  if (id.includes("opus-4-6") || id.includes("sonnet-4-6")) return true;
  if (id.includes("opus-4-7") || id.includes("opus-4-8")) return true;
  return false;
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
  // Don't clamp if provider declares it supports the level but we haven't updated constants yet.
  // Fall through to direct return for any ladder member the caller asked for.
  if (supported.includes(reqLevel)) return reqLevel;
  // Unknown string → drop, don't invent a fallback.
  const requestedIndex = REASONING_EFFORT_LADDER.indexOf(reqLevel);
  if (requestedIndex === -1) return undefined;

  let clamped: ReasoningEffortLevel | undefined;
  for (const level of supported) {
    if (REASONING_EFFORT_LADDER.indexOf(level) > requestedIndex) break;
    clamped = level;
  }
  // No smaller supported level exists (caller asked below floor): use floor rather than max.
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

  // Only clamp when caller actually set an effort AND provider declares a ladder.
  // If provider doesn't declare supportedEfforts, don't invent a 32k clamp — pass through.
  if (reasoning?.effort !== undefined && options?.supportedEfforts !== undefined && options.supportedEfforts.length > 0) {
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
