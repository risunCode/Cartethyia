/**
 * The buddy-family static catalog row.
 *
 * CodeBuddy (intl + CN) and WorkBuddy describe their static fallback catalogs
 * with the same seven-field tuple and build each row the same way, differing
 * only in the wire endpoint the row targets. Both had their own copy of the
 * tuple type and the builder, so a new column meant editing two identical
 * declarations.
 *
 * Only the row shape and the builder are shared. Identity headers are not:
 * `codebuddyHeaders` and `workbuddyHeaders` send genuinely different bytes
 * (`X-Product`/`X-IDE-Type`/`X-Domain` versus `origin`/`referer` and the
 * account-derived `x-user-id`/`x-machine-id`/`x-session-id`), and those stay
 * with their own provider.
 */
import { GatewayError } from "../../../protocol/gateway-error";
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";

/** One static catalog row: id, display name, flags, limits, optional tool override. */
export type BuddyRawEntry = readonly [
  string,
  string,
  boolean,
  boolean,
  number | null,
  number | null,
  /** Explicit tool support. Omitted → derived from the base catalog. */
  boolean?,
];

/** The image-generation ids the international buddy providers serve. */
const BUDDY_IMAGE_MODEL_IDS: readonly { id: string; endpoint: string; ctx: number; out: number }[] = [
  { id: "gemini-2.5-flash-image", endpoint: "/chat/completions", ctx: 1_000_000, out: 64_000 },
  { id: "gemini-3.0-pro-image", endpoint: "/chat/completions", ctx: 1_000_000, out: 64_000 },
  { id: "gemini-3.1-flash-image", endpoint: "/chat/completions", ctx: 1_000_000, out: 64_000 },
  { id: "gpt-image-2", endpoint: "/chat/completions", ctx: 400_000, out: 128_000 },
  { id: "gpt-image-2.5", endpoint: "/chat/completions", ctx: 400_000, out: 128_000 },
];

/**
 * The video-generation ids the international buddy providers serve.
 *
 * `seedance-2.5` is the text-to-video model the buddy facade exposes. It is a
 * distinct service kind (`videoGeneration`), not a chat or image row, so it is
 * built by {@link makeBuddyVideoModels} and reached through
 * `/v1/videos/generations` rather than a chat wire. CodeBuddy CN is
 * deliberately absent — it publishes a different roster.
 */
const BUDDY_VIDEO_MODEL_IDS: readonly { id: string; endpoint: string; ctx: number; out: number }[] = [
  { id: "seedance-2.5", endpoint: "/videos/generations", ctx: 1_000_000, out: 128_000 },
];

/**
 * Ids that belong to the image-generation rows rather than the chat roster.
 *
 * A caller mapping `BUDDY_SHARED_RAW` through {@link makeBuddyModel} must skip
 * these, or the same model id lands in the catalog twice under two service
 * kinds and becomes ambiguous to resolve.
 */
export const BUDDY_IMAGE_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_IMAGE_MODEL_IDS.map((entry) => entry.id),
);

/**
 * Builds the image-generation rows for one buddy provider.
 *
 * Shared rather than copied per provider: cb and WorkBuddy serve the same image
 * models from the same facade, so the roster and the declared capabilities are
 * one decision instead of two that drift. CodeBuddy CN is deliberately absent —
 * it publishes a different roster.
 *
 * `endpoint` is explicit because the two families disagree about the path their
 * base URL expects, and a bare `defineModel` would infer the generic default
 * and produce a URL the upstream rejects.
 */
export function makeBuddyImageModels(
  providerId: string,
  endpoint: string,
): readonly ModelDefinition[] {
  return BUDDY_IMAGE_MODEL_IDS.map((entry) =>
    defineModel({
      id: entry.id,
      providerId,
      serviceKind: "imageGeneration",
      wireFamily: "chat",
      endpoint,
      ctx: entry.ctx,
      out: entry.out,
      vision: true,
      output: ["image"],
      // An image generator takes a prompt, not a tool-calling conversation.
      toolCall: false,
    }),
  );
}

/**
 * Builds the video-generation rows for one buddy provider.
 *
 * Shared for the same reason as {@link makeBuddyImageModels}: the roster is one
 * decision, not one per provider that drifts. A video row produces `["video"]`
 * on the `videoGeneration` surface and is reached through the native video
 * route, not a chat wire, so `endpoint` names the upstream generation path
 * rather than a chat-completions path.
 */
export function makeBuddyVideoModels(
  providerId: string,
  endpoint: string,
): readonly ModelDefinition[] {
  return BUDDY_VIDEO_MODEL_IDS.map((entry) =>
    defineModel({
      id: entry.id,
      providerId,
      serviceKind: "videoGeneration",
      wireFamily: "chat",
      endpoint,
      ctx: entry.ctx,
      out: entry.out,
      vision: true,
      output: ["video"],
      toolCall: false,
    }),
  );
}

/**
 * Ids that belong to the video-generation rows rather than the chat roster.
 *
 * The video analogue of {@link BUDDY_IMAGE_MODEL_ID_SET}: a caller mapping the
 * shared chat tuple must skip these so `seedance-2.5` never lands in the
 * catalog twice under two service kinds.
 */
export const BUDDY_VIDEO_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_VIDEO_MODEL_IDS.map((entry) => entry.id),
);

/**
 * Builds one buddy catalog row.
 *
 * `endpoint` is explicit rather than left to the generic `/chat/completions`
 * default because the two families disagree about it: CodeBuddy's base URL
 * carries a version segment the default joins onto correctly, while
 * WorkBuddy's does not — the default would produce
 * `https://www.workbuddy.ai/chat/completions`, which that upstream answers
 * with a 405 HTML page. Callers pass the endpoint their base URL actually
 * serves, and `undefined` for the default.
 */
export function makeBuddyModel(
  entry: BuddyRawEntry,
  providerId: string,
  endpoint?: string,
): ModelDefinition {
  if (!entry[0]) throw new GatewayError("invalid_request", 400, "invalid model");
  const image = BUDDY_IMAGE_MODEL_ID_SET.has(entry[0]);
  return defineModel({
    id: entry[0],
    providerId,
    ...(image ? { serviceKind: "imageGeneration" as const, output: ["image"] as const } : {}),
    ...(endpoint === undefined ? {} : { endpoint }),
    reasoning: entry[2],
    vision: entry[3],
    ctx: entry[4],
    out: entry[5],
    ...(image ? { toolCall: false } : entry[6] === undefined ? {} : { toolCall: entry[6] }),
  });
}

/**
 * The shared model roster for the two international buddy sites.
 *
 * CodeBuddy intl and WorkBuddy serve the same model set from the same console
 * directory shape, so the two catalogs were kept as separate hand-written lists
 * and had already drifted: each carried ids the other lacked. One list is the
 * single source of truth, and each provider maps it with its own endpoint
 * (`workbuddy.ts` needs the explicit `/v2/chat/completions`, `codebuddy.ts`
 * takes the family default) — the endpoint is the only thing that differs.
 *
 * CodeBuddy CN is deliberately NOT on this list: its console publishes a
 * different roster (its own `glm-5v-turbo` / `kimi-k3-1` ids and CN-specific
 * output ceilings), so it keeps its own table.
 */
export const BUDDY_SHARED_RAW: readonly BuddyRawEntry[] = [
  ["auto", "Auto", true, true, 168_000, null],
  ["primary-model", "Primary", true, true, 272_000, 72_000],
  ["claude-opus-4.6", "Claude Opus 4.6", true, true, 200_000, 64_000],
  ["claude-opus-4.7-1m", "Claude Opus 4.7 1M", true, true, 1_000_000, 64_000],
  ["claude-sonnet-4.6", "Claude Sonnet 4.6", true, true, 200_000, 32_000],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, false, 1_000_000, 384_000],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", true, false, 1_000_000, 384_000],
  ["deepseek-v4.1-flash-sg", "DeepSeek V4.1 Flash SG", true, false, 1_000_000, 128_000],
  ["deepseek-v4.1-pro", "DeepSeek V4.1 Pro", true, false, 1_000_000, 384_000],
  ["gemini-2.5-flash-image", "Gemini 2.5 Flash Image", true, true, 1_000_000, 64_000],
  ["gemini-3.0-pro-image", "Gemini 3.0 Pro Image", true, true, 1_000_000, 64_000],
  ["gemini-3.1-flash-image", "Gemini 3.1 Flash Image", true, true, 1_000_000, 64_000],
  ["gemini-3.1-pro", "Gemini 3.1 Pro", true, true, 1_048_576, 65_536],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", true, true, 1_048_576, 65_536],
  ["glm-5.1", "GLM-5.1", true, false, 200_000, 131_072],
  ["glm-5.2", "GLM-5.2", true, false, 1_000_000, 131_072],
  ["glm-5.3", "GLM-5.3", true, false, 1_000_000, 131_072],
  ["glm-5.3-flash", "GLM-5.3 Flash", true, false, 1_000_000, 131_072],
  ["glm-5v-turbo", "GLM-5V Turbo", true, true, 200_000, 131_072],
  ["gpt-5.3-codex", "GPT-5.3 Codex", true, true, 400_000, 128_000],
  ["gpt-5.4", "GPT-5.4", true, true, 1_050_000, 128_000],
  ["gpt-5.5", "GPT-5.5", true, true, 1_050_000, 128_000],
  ["gpt-5.6-luna", "GPT-5.6 Luna", true, true, 1_050_000, 128_000],
  ["gpt-5.6-sol", "GPT-5.6 Sol", true, true, 1_050_000, 128_000],
  ["gpt-5.6-terra", "GPT-5.6 Terra", true, true, 1_050_000, 128_000],
  ["gpt-6-astra", "GPT-6 Astra", true, true, 1_050_000, 128_000],
  ["gpt-6.1-sol", "GPT-6.1 Sol", true, true, 1_050_000, 128_000],
  ["gpt-image-2", "GPT-Image-2", true, true, 400_000, 128_000],
  ["gpt-image-2.5", "GPT-Image-2.5", true, true, 400_000, 128_000],
  ["grok-4.6", "Grok 4.6", true, true, 500_000, 500_000],
  ["grok-4.7", "Grok 4.7", true, true, 500_000, 500_000],
  ["hy3", "Hy3", true, false, 1_000_000, 64_000, true],
  ["hy4-preview", "Hy4 Preview", true, false, 1_000_000, 64_000, true],
  ["hy4-preview-f", "Hy4 Preview F", true, false, 1_000_000, 64_000, true],
  ["kimi-k2.5", "Kimi K2.5", true, false, 164_000, 262_144],
  ["kimi-k2.6", "Kimi K2.6", true, false, 256_000, 262_144],
  ["kimi-k2.7", "Kimi K2.7", true, false, 256_000, 65_536],
  ["kimi-k2.8-preview", "Kimi K2.8 Preview", true, false, 256_000, 65_536],
  ["kimi-k3", "Kimi K3", true, false, 1_048_576, 131_072],
  ["kimi-k3.1", "Kimi K3.1", true, false, 1_000_000, 131_072],
  ["minimax-m3", "MiniMax-M3", true, false, 512_000, 512_000],
];
