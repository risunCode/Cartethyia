import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";

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
 * `ctx` and `out` are the model's real limits. Opus 5/4.8/4.7 and Sonnet 5/5.5
 * carry 1M context; the 4.5-era rows and both Haiku rows carry 200k. `auto`
 * routes upstream and is declared at 1M/32k.
 *
 * The non-Anthropic row is GLM 5 at 200k/64k. GPT 5.5 and the 5.6 rows keep
 * 272k/128k. DeepSeek V3.2, Qwen3 Coder Next, and MiniMax M2.5 are retired and
 * must not return through discovery.
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
  kiroModel({ id: "auto", ctx: 1_000_000, out: 32_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-opus-5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-opus-4.8", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-opus-4.7", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-opus-4.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-sonnet-5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-sonnet-5.5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-sonnet-4.5", ctx: 1_000_000, out: 64_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-haiku-4.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-haiku-5.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.5", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-sol", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-terra", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-luna", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  // The non-Anthropic rows reject image and audio input upstream.
  kiroModel({ id: "glm-5", ctx: 200_000, out: 64_000, reasoning: true, toolCall: true }),
];

/**
 * The context window of a model id, as this catalog declares it.
 *
 * The upstream reports prompt size only as a *percentage* of the model's window
 * (`contextUsageEvent`), never as a token count, so recovering a token figure
 * needs the denominator. This is the only place Kiro states one.
 *
 * Matching is case-insensitive and falls back to 200k rather than returning
 * `undefined`: a token estimate derived from the wrong window is still far
 * closer than reporting nothing. A discovery-synced row this catalog does not
 * name takes that same default.
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
