/**
 * xAI Grok subscription provider (`xai`).
 *
 * This is the **paid** xAI API at `api.x.ai`, reached with the SuperGrok /
 * X Premium+ OAuth token from the xAI device flow. It is deliberately a
 * separate provider from `grok`: that one is the Grok Build *free* CLI surface
 * at `cli-chat-proxy.grok.com`, which carries the CLI's own session, turn-index,
 * and identity headers. The two share an authorization server and a client id
 * but not a base URL, a header set, or a model roster, so keeping them apart
 * means neither one's wire contract can drift into the other.
 *
 * The wire is the plain OpenAI Responses shape, so no bespoke adapter is
 * needed: the shared `OpenAICompatibleAdapter` serializes it and only the base
 * URL, the `/v1` endpoint paths, and the effort mapping below are xAI-specific.
 */
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../compatible-adapter";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import type { ProviderAdapter, ProviderDispatchContext } from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";
import { getGrokVersion } from "../../operations/client-versions";
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

export const XAI_PROVIDER_ID = "xai" as const;
export const XAI_BASE_URL = providerBaseUrl("xai");
/** Endpoint paths on the versioned `api.x.ai/v1` root. */
export const XAI_RESPONSES_PATH = "/responses" as const;
export const XAI_MODELS_PATH = "/models" as const;

/**
 * xAI's own reasoning-effort scale is `low`/`medium`/`high`.
 *
 * It has no `minimal` and no tier above `high`, so the canonical values the
 * shared Responses codec emits for those two are translated here. The mapping
 * is applied **after** translation, which is why `max` arrives as `xhigh`: the
 * codec clamps the canonical scale to the Responses wire's
 * `minimal…xhigh` ladder first, and `xhigh` is what xAI must not receive.
 */
const XAI_EFFORT_MAP: Readonly<Record<string, string>> = Object.freeze({
  minimal: "low",
  xhigh: "high",
  max: "high",
});

/**
 * Rewrites the effort dial to the value xAI accepts.
 *
 * `reasoning.effort` is read and replaced in place; a request with no
 * reasoning block is left exactly as the shared codec serialized it.
 */
function normalizeXaiPayload(payload: Record<string, unknown>): void {
  const reasoning = payload.reasoning;
  if (reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning)) return;
  const effort = (reasoning as Record<string, unknown>).effort;
  if (typeof effort !== "string") return;
  const mapped = XAI_EFFORT_MAP[effort];
  if (mapped !== undefined) (reasoning as Record<string, unknown>).effort = mapped;
}

const xaiModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: { readonly vision?: boolean; readonly reasoning?: boolean } = {},
): ModelDefinition =>
  defineModel({
    id: modelId,
    providerId: XAI_PROVIDER_ID,
    wireFamily: "responses",
    endpoint: XAI_RESPONSES_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? true,
    reasoning: options.reasoning ?? true,
    toolCall: true,});

/**
 * Static fallback catalog.
 *
 * The account's own `/v1/models` is authoritative for what the subscription may
 * use; this list is the offline floor, and its limits come from the models.dev
 * snapshot's `xai` rows where it knows the id.
 */
export const XAI_MODELS: readonly ModelDefinition[] = [
  xaiModel("grok-4.7", 500_000, 64_000),
  xaiModel("grok-4.6", 500_000, 64_000),
  xaiModel("grok-4.5", 500_000, 64_000),
  xaiModel("grok-4.3", 1_000_000, 64_000),
  xaiModel("grok-build", 512_000, 64_000),
];

const xaiConfig = withBearerAuthentication({
  provider_id: XAI_PROVIDER_ID,
  base_url: XAI_BASE_URL,
  endpoint_paths_by_wire_family: { responses: XAI_RESPONSES_PATH },
  prePayload: normalizeXaiPayload,
  // xAI gates on the CLI client identity the same way the Grok Build surface
  // does; the version is resolved from its published client, not invented.
  buildExtraHeaders: (_context: ProviderDispatchContext, _request?: CanonicalRequest) => {
    const version = getGrokVersion();
    return {
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": version,
    };
  },
});

/** xAI Grok subscription adapter. */
export const xaiAdapter: ProviderAdapter = new OpenAICompatibleAdapter(xaiConfig);

/** Factory for tests and custom egress. */
export function createXaiAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  if (!fetchImpl) return xaiAdapter;
  return new OpenAICompatibleAdapter(
    withBearerAuthentication({ ...xaiConfig, fetchImpl }),
  );
}
