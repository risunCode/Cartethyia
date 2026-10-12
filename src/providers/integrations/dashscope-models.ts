/**
 * Alibaba DashScope (mainland) model catalog.
 *
 * The roster is the one the host publishes on its coding endpoint
 * (`https://coding.dashscope.aliyuncs.com/v1/chat/completions`), taken from the
 * 9router provider registry the operator pointed at. That host is the mainland
 * Coding Plan, so the base catalog files these limits under
 * `alibaba-coding-plan-cn`; the `dashscope` remap in `models-dev-catalog.ts`
 * points at it, which is why every row below carries only capability flags.
 *
 * The chat path is unprefixed because the base URL already ends at `/v1` —
 * `joinUrl` concatenates verbatim, so a `/v1/chat/completions` path here would
 * dispatch to `/v1/v1/chat/completions`.
 *
 * 9router lists 8 models; the base catalog files 4 more for the same host
 * (`qwen3.6-flash`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`). Those are
 * absent here rather than guessed in — this provider has live `/v1/models`
 * discovery, so a row it does not publish yet arrives through the sync control
 * instead of being asserted ahead of the upstream.
 */
import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../model-definition";

export const DASHSCOPE_PROVIDER_ID = "dashscope" as const;

/** Chat path below the `/v1`-rooted base. */
const CHAT_ENDPOINT = "/chat/completions";

type CatalogRow = readonly [id: string, vision: boolean, reasoning: boolean];

function dashscopeModel([id, vision, reasoning]: CatalogRow): ModelDefinition {
  return defineModel({
    id,
    providerId: DASHSCOPE_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: CHAT_ENDPOINT,
    vision,
    reasoning,
    toolCall: true,
  });
}

/** Static Alibaba DashScope catalog; live discovery adds to it per account. */
export const DASHSCOPE_MODELS: readonly ModelDefinition[] = [
  ["glm-4.7", false, true] as const,
  ["glm-5", false, true] as const,
  ["kimi-k2.5", true, true] as const,
  ["MiniMax-M2.5", false, true] as const,
  ["qwen3-coder-next", false, false] as const,
  ["qwen3-coder-plus", false, false] as const,
  ["qwen3-max-2026-01-23", false, false] as const,
  ["qwen3.5-plus", true, true] as const,
].map(dashscopeModel);