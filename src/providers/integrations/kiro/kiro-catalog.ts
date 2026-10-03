import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

/** Provider id this catalog belongs to. */
export const KIRO_PROVIDER_ID = "kiro" as const;

/**
 * The adapter's own RPC path. Kiro has no chat-shaped route: the endpoint is a
 * single `generateAssistantResponse` operation the adapter posts a conversation
 * ledger to, so the path is recorded here for catalog completeness rather than
 * selected by wire family.
 */
export const KIRO_GENERATE_PATH = "/generateAssistantResponse" as const;

/**
 * Effort tiers the Kiro models that accept an effort field advertise.
 *
 * The upstream has no `minimal` or `max` tier on either schema, so the ladder
 * stops at `xhigh` and the builder maps the canonical extremes onto it.
 */
const KIRO_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/**
 * One Kiro model row.
 *
 * `ctx` and `out` are the model's real limits — Opus-5/4.8/4.7 and Sonnet-5
 * carry 1M context per the Anthropic catalog (`claude.ts`) and models.dev; the
 * 4.5-era rows and Haiku 200k. The old uniform 500k overstated older Claude
 * models and understated the newest.
 *
 * The non-Anthropic rows use the upstream family defaults: DeepSeek V3.2
 * 128k/64k, Qwen3 Coder Next 1M, GLM 5 204.8k/131k, MiniMax M2.5 204.8k/131k. GPT
 * 5.6's 272k/128k is unchanged.
 */
function kiroModel(options: {
  readonly id: string;
  readonly ctx: number;
  readonly out: number;
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly webSearch?: boolean;
}): ModelDefinition {
  return defineModel({
    id: options.id,
    providerId: KIRO_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: KIRO_GENERATE_PATH,
    ctx: options.ctx,
    out: options.out,
    ...(options.vision === undefined ? {} : { vision: options.vision }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.toolCall === undefined ? {} : { toolCall: options.toolCall }),
    ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
    ...(options.reasoning ? { reasoningEfforts: KIRO_EFFORTS } : {}),
  });
}

/**
 * Offline seed catalog.
 *
 * The upstream's own model list is authoritative and is fetched at discovery
 * time; this row set is what a request can be routed to before that has ever
 * run, so it names the family the service is documented to serve rather than
 * guessing at what an individual account's plan reaches.
 */
export const KIRO_MODELS: readonly ModelDefinition[] = [
  kiroModel({ id: "claude-opus-5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true, webSearch: true }),
  kiroModel({ id: "claude-opus-4.8", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true, webSearch: true }),
  kiroModel({ id: "claude-opus-4.7", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true, webSearch: true }),
  kiroModel({ id: "claude-opus-4.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true, webSearch: true }),
  kiroModel({ id: "claude-sonnet-5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true, webSearch: true }),
  kiroModel({ id: "claude-sonnet-4.5", ctx: 1_000_000, out: 64_000, vision: true, reasoning: true, toolCall: true, webSearch: true }),
  kiroModel({ id: "claude-haiku-4.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true, webSearch: true }),
  kiroModel({ id: "gpt-5.6-sol", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-terra", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-luna", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  // The non-Anthropic rows reject image and audio input upstream.
  kiroModel({ id: "deepseek-3.2", ctx: 128_000, out: 64_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "qwen3-coder-next", ctx: 1_000_000, out: 64_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "glm-5", ctx: 204_800, out: 131_072, reasoning: true, toolCall: true }),
  kiroModel({ id: "MiniMax-M2.5", ctx: 204_800, out: 131_072, reasoning: true, toolCall: true }),
];

/**
 * The context window of a model id, as this catalog declares it.
 *
 * The upstream reports prompt size only as a *percentage* of the model's window
 * (`contextUsageEvent`), never as a token count, so recovering a token figure
 * needs the denominator. This is the only place Kiro states one.
 *
 * Matching is case-insensitive and falls back to the family default rather than
 * returning `undefined`: a token estimate derived from the wrong window is still
 * far closer than reporting nothing, and every Anthropic row here shares one
 * window. A discovery-synced row not in this list takes that same default.
 */
export function kiroContextWindow(modelId: string): number {
  const normalized = modelId.trim().toLowerCase();
  for (const model of KIRO_MODELS) {
    if (model.modelId.toLowerCase() === normalized && model.contextLimit !== null) return model.contextLimit;
  }
  return KIRO_DEFAULT_CONTEXT_WINDOW;
}

/** Window used for a model this catalog does not name; the Anthropic rows' value. */
export const KIRO_DEFAULT_CONTEXT_WINDOW = 200_000;
