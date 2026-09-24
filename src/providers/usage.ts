import type { UsageRecord } from "../transport/canonical-model";
export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}
import { modelsDevCatalog } from "./discovery/models-dev-catalog";

/**
 * Extract cost multipliers from catalog model cost JSONB.
 * Expected structure: { input: number, output: number, cache_read?: number, cache_write?: number, source?: string, timestamp?: string }
 */
function extractCostMultipliers(cost: unknown): {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning?: number;
  source: string;
  timestamp: string;
} | null {
  if (!cost || typeof cost !== "object") return null;

  const costObj = cost as Record<string, unknown>;
  const input =
    typeof costObj.input === "number" && Number.isFinite(costObj.input) ? costObj.input : null;
  const output =
    typeof costObj.output === "number" && Number.isFinite(costObj.output) ? costObj.output : null;

  // If input or output missing or non-finite, cannot calculate cost.
  if (input === null || output === null) return null;

  const cacheRead =
    typeof costObj.cache_read === "number" && Number.isFinite(costObj.cache_read)
      ? costObj.cache_read
      : input;
  const cacheWrite =
    typeof costObj.cache_write === "number" && Number.isFinite(costObj.cache_write)
      ? costObj.cache_write
      : input;
  const reasoning =
    typeof costObj.reasoning === "number" && Number.isFinite(costObj.reasoning)
      ? costObj.reasoning
      : undefined;

  return {
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    source: typeof costObj.source === "string" ? costObj.source : "",
    timestamp: typeof costObj.timestamp === "string" ? costObj.timestamp : "",
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

interface UsageCostBasis {
  readonly inputTokens: number;
  readonly cachedInputTokens: number | "unavailable";
  readonly cacheWriteTokens: number | "unavailable";
  readonly uncachedInputTokens: number | "unavailable";
  readonly outputTokens: number;
  readonly reasoningTokens: number | "unavailable";
}

function calculateEstimatedCost(basis: UsageCostBasis, rawCost: unknown): number | undefined {
  const multipliers = extractCostMultipliers(rawCost);
  if (!multipliers) return undefined;
  const uncached = Math.max(0, typeof basis.uncachedInputTokens === "number" ? basis.uncachedInputTokens : 0);
  const cached = typeof basis.cachedInputTokens === "number" ? basis.cachedInputTokens : 0;
  const writes = typeof basis.cacheWriteTokens === "number" ? basis.cacheWriteTokens : 0;
  const reasoning = typeof basis.reasoningTokens === "number" ? basis.reasoningTokens : 0;
  const visibleOutput = Math.max(0, basis.outputTokens - reasoning);
  return (
    uncached * multipliers.input +
    cached * multipliers.cache_read +
    writes * multipliers.cache_write +
    visibleOutput * multipliers.output +
    reasoning * (multipliers.reasoning ?? multipliers.output)
  ) / 1_000_000;
}

/** Reprices canonical usage using the routed model's persisted/catalog price. */
export function repriceUsage(
  usage: UsageRecord,
  providerId: string,
  modelId: string,
  catalogCost?: unknown,
): UsageRecord {
  const rawCost = catalogCost ?? modelsDevCatalog.resolve(providerId, modelId)?.cost;
  const estimatedCost = calculateEstimatedCost(
    {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      cacheWriteTokens: usage.cache_write_tokens,
      uncachedInputTokens: usage.uncached_input_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.reasoning_tokens,
    },
    rawCost,
  );
  return estimatedCost === undefined ? usage : { ...usage, estimated_cost: estimatedCost };
}

/**
 * Normalize provider-specific usage data into canonical UsageRecord.
 * Handles Anthropic (cache_read_input_tokens, cache_creation_input_tokens, output_tokens_details.thinking_tokens)
 * and OpenAI (input_tokens_details.cached_tokens, output_tokens_details.reasoning_tokens).
 * For GPT-5.6+, includes cache_write_tokens; pre-5.6 has no write field (use "unavailable").
 *
 * @param input Raw provider usage response (can be Anthropic or OpenAI format)
 */
export function normalizeUsage(input: Record<string, unknown>): UsageRecord {
  // Raw fresh-token count. Anthropic-shape payloads report ONLY fresh tokens
  // here (cache reads/writes are separate fields); OpenAI-shape payloads
  // report the all-in total with the cached subset in details.
  let input_tokens =
    typeof input.input_tokens === "number"
      ? Math.max(0, input.input_tokens)
      : typeof input.prompt_tokens === "number"
        ? Math.max(0, input.prompt_tokens)
        : 0;
  const output_tokens =
    typeof input.output_tokens === "number"
      ? Math.max(0, input.output_tokens)
      : typeof input.completion_tokens === "number"
        ? Math.max(0, input.completion_tokens)
        : 0;

  // Handle Anthropic cache reads
  let cached_input_tokens: number | "unavailable" = "unavailable";
  const anthropic_cache_read =
    typeof input.cache_read_input_tokens === "number" ? input.cache_read_input_tokens : null;
  if (anthropic_cache_read !== null) {
    cached_input_tokens = anthropic_cache_read;
  }

  // Handle OpenAI cached tokens (only if not already set from Anthropic).
  // DeepSeek-family bridges (CodeBuddy et al.) report the real hit count flat
  // as `prompt_cache_hit_tokens` while stamping `*_tokens_details.cached_tokens`
  // with a constant 0 — read the flat field FIRST so the zeroed details never
  // shadow a genuine cache hit.
  const deepseekCacheHit =
    typeof input.prompt_cache_hit_tokens === "number" ? input.prompt_cache_hit_tokens : null;
  if (deepseekCacheHit !== null) {
    cached_input_tokens = deepseekCacheHit;
  }
  if (
    cached_input_tokens === "unavailable" &&
    input.input_tokens_details &&
    typeof input.input_tokens_details === "object"
  ) {
    const details = input.input_tokens_details as Record<string, unknown>;
    if (typeof details.cached_tokens === "number") {
      cached_input_tokens = details.cached_tokens;
    }
  }
  // Chat Completions reports cached tokens under `prompt_tokens_details`
  // (the Responses API uses `input_tokens_details` above).
  if (
    cached_input_tokens === "unavailable" &&
    input.prompt_tokens_details &&
    typeof input.prompt_tokens_details === "object"
  ) {
    const details = input.prompt_tokens_details as Record<string, unknown>;
    if (typeof details.cached_tokens === "number") {
      cached_input_tokens = details.cached_tokens;
    }
  }
  // DeepSeek-family providers report cached tokens flat as
  // `prompt_cache_hit_tokens` — already consumed above with priority over
  // the zeroed `*_tokens_details.cached_tokens` those bridges also emit.
  // Flat `cached_tokens` is the intermediate shape `mapGeminiUsage`
  // (Gemini/Antigravity) and CommandCode emit; `cachedContentTokenCount` is
  // Gemini's raw `usageMetadata` field. Both were previously dropped.
  if (
    cached_input_tokens === "unavailable" &&
    typeof input.cached_tokens === "number"
  ) {
    cached_input_tokens = input.cached_tokens;
  }
  if (
    cached_input_tokens === "unavailable" &&
    typeof input.cachedContentTokenCount === "number"
  ) {
    cached_input_tokens = input.cachedContentTokenCount;
  }

  // Handle cache write tokens: Anthropic uses cache_creation_input_tokens
  let cache_write_tokens: number | "unavailable" = "unavailable";
  const anthropic_cache_write =
    typeof input.cache_creation_input_tokens === "number"
      ? input.cache_creation_input_tokens
      : null;
  if (anthropic_cache_write !== null) {
    cache_write_tokens = anthropic_cache_write;
  } else if (input.cache_creation && typeof input.cache_creation === "object") {
    const breakdown = input.cache_creation as Record<string, unknown>;
    const ephemeral5m =
      typeof breakdown.ephemeral_5m_input_tokens === "number"
        ? breakdown.ephemeral_5m_input_tokens
        : 0;
    const ephemeral1h =
      typeof breakdown.ephemeral_1h_input_tokens === "number"
        ? breakdown.ephemeral_1h_input_tokens
        : 0;
    if (ephemeral5m > 0 || ephemeral1h > 0) cache_write_tokens = ephemeral5m + ephemeral1h;
  }
  // Derive uncached input and the canonical all-in total. Anthropic-shape
  // input (marked by the cache_read_input_tokens field, which has no OpenAI
  // equivalent) reports fresh tokens only in input_tokens, so the canonical
  // total is fresh + read + written. Everything else reports an all-in total
  // with the cached subset inside, so uncached is total minus cached. A lone
  // cache_creation field without a read field is treated as an OpenAI-ish
  // inclusive total: the creation count is the write volume, not extra input.
  const hasAnthropicCacheShape = anthropic_cache_read !== null;
  let uncached_input_tokens: number | "unavailable" = "unavailable";
  if (typeof cached_input_tokens === "number") {
    if (hasAnthropicCacheShape) {
      uncached_input_tokens = input_tokens;
      input_tokens +=
        cached_input_tokens + (typeof cache_write_tokens === "number" ? cache_write_tokens : 0);
    } else {
      uncached_input_tokens = Math.max(0, input_tokens - Math.min(input_tokens, cached_input_tokens));
      cached_input_tokens = Math.min(input_tokens, cached_input_tokens);
    }
  } else if (hasAnthropicCacheShape && typeof cache_write_tokens === "number") {
    // Write-only report (no reads): fresh + written, nothing cached.
    input_tokens += cache_write_tokens;
  }

  // Handle reasoning tokens: Anthropic and OpenAI both use output_tokens_details
  let reasoning_tokens: number | "unavailable" = "unavailable";
  const details: NonNullable<UsageRecord["details"]> = {};
  const outputDetails = [input.output_tokens_details, input.completion_tokens_details].find(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object",
  );
  if (outputDetails !== undefined) {
    // Anthropic uses thinking_tokens
    if (typeof outputDetails.thinking_tokens === "number") {
      reasoning_tokens = outputDetails.thinking_tokens;
    }
    // OpenAI uses reasoning_tokens
    else if (typeof outputDetails.reasoning_tokens === "number") {
      reasoning_tokens = outputDetails.reasoning_tokens;
    }
    if (typeof outputDetails.accepted_prediction_tokens === "number")
      details.accepted_prediction_tokens = outputDetails.accepted_prediction_tokens;
    if (typeof outputDetails.rejected_prediction_tokens === "number")
      details.rejected_prediction_tokens = outputDetails.rejected_prediction_tokens;
  }

  // Calculate cost from the models.dev catalog using the raw upstream model id.
  const rawCost =
    typeof input.model === "string" ? modelsDevCatalog.costFor("", input.model) : undefined;
  const estimated_cost = calculateEstimatedCost(
    {
      inputTokens: input_tokens,
      cachedInputTokens: cached_input_tokens,
      cacheWriteTokens: cache_write_tokens,
      uncachedInputTokens: uncached_input_tokens,
      outputTokens: output_tokens,
      reasoningTokens: reasoning_tokens,
    },
    rawCost,
  ) ?? 0;
  return {
    input_tokens,
    cached_input_tokens,
    cache_write_tokens,
    uncached_input_tokens,
    output_tokens,
    reasoning_tokens,
    estimated_cost,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

/**
 * Single usage-to-wire home: every surface encodes canonical usage through
 * these builders so a new upstream token field is mapped once. Each builder
 * implements exactly its surface's historical math.
 */

/** Chat Completions wire usage (`prompt/completion_tokens` + details). */
export function usageToChatWire(usage: UsageRecord): OpenAiUsage {
  const result: OpenAiUsage = {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
  const promptDetails: NonNullable<OpenAiUsage["prompt_tokens_details"]> = {};
  if (typeof usage.cached_input_tokens === "number")
    promptDetails.cached_tokens = usage.cached_input_tokens;
  if (Object.keys(promptDetails).length > 0) result.prompt_tokens_details = promptDetails;
  const completionDetails: NonNullable<OpenAiUsage["completion_tokens_details"]> = {};
  if (typeof usage.reasoning_tokens === "number")
    completionDetails.reasoning_tokens = usage.reasoning_tokens;
  if (typeof usage.details?.accepted_prediction_tokens === "number")
    completionDetails.accepted_prediction_tokens = usage.details.accepted_prediction_tokens;
  if (typeof usage.details?.rejected_prediction_tokens === "number")
    completionDetails.rejected_prediction_tokens = usage.details.rejected_prediction_tokens;
  if (Object.keys(completionDetails).length > 0)
    result.completion_tokens_details = completionDetails;
  return result;
}

/**
 * Responses wire usage. Keeps the historical root+nested duality: cached and
 * reasoning counts appear both as top-level fields and inside
 * `*_tokens_details` (the xAI bridge reads the root fields — see
 * `mergeResponsesUsage`'s max-guard).
 */
export function usageToResponsesWire(usage: UsageRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
  if (typeof usage.cached_input_tokens === "number") {
    result.cached_input_tokens = usage.cached_input_tokens;
    result.input_tokens_details = { cached_tokens: usage.cached_input_tokens };
  }
  if (typeof usage.reasoning_tokens === "number") {
    result.reasoning_tokens = usage.reasoning_tokens;
    result.output_tokens_details = { reasoning_tokens: usage.reasoning_tokens };
  }
  return result;
}

/**
 * Messages wire usage. Real Anthropic semantics: `input_tokens` counts only
 * newly processed tokens, separate from
 * `cache_read_input_tokens`/`cache_creation_input_tokens` — a client that
 * sums all three (as the official SDK docs instruct) must not double-count.
 * Falls back to the raw total when the upstream never reported cache info
 * (`cached_input_tokens` "unavailable"), since there is then nothing to
 * subtract.
 */
export function usageToMessagesWire(usage: UsageRecord | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const hasCacheInfo = typeof usage.cached_input_tokens === "number";
  const result: Record<string, unknown> = {
    input_tokens: hasCacheInfo
      ? Math.max(
          0,
          typeof usage.uncached_input_tokens === "number"
            ? usage.uncached_input_tokens
            : usage.input_tokens,
        )
      : usage.input_tokens,
    output_tokens: usage.output_tokens,
  };
  if (hasCacheInfo) result.cache_read_input_tokens = usage.cached_input_tokens;
  if (typeof usage.cache_write_tokens === "number")
    result.cache_creation_input_tokens = usage.cache_write_tokens;
  if (typeof usage.reasoning_tokens === "number")
    result.output_tokens_details = { thinking_tokens: usage.reasoning_tokens };
  return result;
}

/**
 * Single reasoning-text home: upstream delta/message keys carrying reasoning
 * text on OpenAI-family chat wires. Wire-specific readers (chat non-stream +
 * stream decoders, qoder's enveloped parser) keep their own emptiness policy
 * and event shapes — only the key lookup lives here, so a new upstream key
 * is added once and every reader picks it up.
 */
export const REASONING_TEXT_KEYS: readonly string[] = ["reasoning_content", "reasoning"];

/** First string found under a known reasoning-text key, or undefined. */
export function readReasoningText(source: Record<string, unknown>): string | undefined {
  for (const key of REASONING_TEXT_KEYS) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  // Qwen/MiniMax-family `reasoning_details[]` parts carrying text fragments.
  const details = source["reasoning_details"];
  if (Array.isArray(details)) {
    const text = details
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as Record<string, unknown>)?.["text"] === "string"
            ? ((part as Record<string, unknown>)["text"] as string)
            : "",
      )
      .join("");
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * Single Responses-summary home: Responses-family event types carrying
 * reasoning summary deltas. The shared summary shape
 * (`response.reasoning_summary_text.delta` + string `delta`) is read here;
 * codex's `response.reasoning_text.delta` variant keeps its item routing
 * locally in `protocol/response/codex.ts` (wire-specific, not shared).
 */
export const RESPONSES_REASONING_DELTA_TYPES: readonly string[] = [
  "response.reasoning_summary_text.delta",
];

/** String `delta` of a known reasoning-summary event, or undefined. */
export function readResponsesReasoningDelta(event: Record<string, unknown>): string | undefined {
  const type = event["type"];
  if (typeof type !== "string") return undefined;
  if (!(RESPONSES_REASONING_DELTA_TYPES as readonly string[]).includes(type)) return undefined;
  return typeof event["delta"] === "string" ? event["delta"] : undefined;
}
