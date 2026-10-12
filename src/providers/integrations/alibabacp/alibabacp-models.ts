/**
 * Alibaba Token Plan model catalog.
 *
 * The plan is a subscription: models.dev prices every row here at zero, so
 * `defineModel` resolves cost to zero and this file carries no cost column.
 * Context, output, and capability come from the same base-catalog row via
 * `providerId: "alibabacp"` → the `alibaba-token-plan` remap in
 * `models-dev-catalog.ts`.
 *
 * One catalog serves both plans. The international and mainland hosts carry the
 * same model ids, and the base catalog files them identically under
 * `alibaba-token-plan` and `alibaba-token-plan-cn` — same context, same output,
 * same modalities on every row — so there is nothing per-region to declare. The
 * region is per-account transport state and belongs in the credential, not here.
 *
 * The image/video rows (`qwen-image-*`, `wan2.7-*`, `happyhorse-*`) are absent:
 * this provider serves the chat surface, and a generation model published on it
 * is not a row this catalog can honestly declare.
 */
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";

export const ALIBABACP_PROVIDER_ID = "alibabacp" as const;

/** Chat path below the region's `/compatible-mode/v1` base. */
const CHAT_ENDPOINT = "/chat/completions";

type CatalogRow = readonly [id: string, vision: boolean, document: boolean, reasoning: boolean];

function alibabacpModel([id, vision, document, reasoning]: CatalogRow): ModelDefinition {
  return defineModel({
    id,
    providerId: ALIBABACP_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: CHAT_ENDPOINT,
    vision,
    document,
    reasoning,
    toolCall: true,
  });
}

/** Static Alibaba Token Plan catalog. */
export const ALIBABACP_MODELS: readonly ModelDefinition[] = [
  ["deepseek-v3.2", false, false, true] as const,
  ["deepseek-v4-flash", false, false, true] as const,
  ["deepseek-v4-flash-0731", false, false, true] as const,
  ["deepseek-v4-pro", false, false, true] as const,
  ["deepseek-v4-pro-0813", false, false, true] as const,
  ["deepseek-v4.1-flash", true, false, true] as const,
  ["glm-5", false, false, true] as const,
  ["glm-5.1", false, false, true] as const,
  ["glm-5.2", false, false, true] as const,
  ["glm-5.3", false, false, true] as const,
  ["kimi-k2.5", true, false, true] as const,
  ["kimi-k2.6", true, false, true] as const,
  ["kimi-k2.7-code", true, false, true] as const,
  ["MiniMax-M2.5", false, false, true] as const,
  ["qwen3.6-flash", true, false, true] as const,
  ["qwen3.6-plus", true, false, true] as const,
  ["qwen3.7-max", false, false, true] as const,
  ["qwen3.7-plus", true, false, true] as const,
  ["qwen3.8-flash", true, false, true] as const,
  ["qwen3.8-max", true, true, true] as const,
  ["qwen3.8-max-preview", true, false, true] as const,
].map(alibabacpModel);
