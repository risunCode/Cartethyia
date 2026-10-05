/**
 * Z.AI Coding Plan (ZCode) provider.
 *
 * A subscription plan served over Z.AI's OpenAI-compatible coding endpoint,
 * with a dedicated base URL, a durable credential minted by the sign-in flow,
 * and a separate model catalog.
 *
 * The credential is a plain bearer string, so the shared factory forwards it
 * as-is and no credential codec is needed here — the sign-in client is what
 * turns an OAuth grant into that key.
 */
import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { providerBaseUrl } from "../provider-metadata";
import type { ApiKeyProviderSpec } from "./configured-provider";
import type { DiscoveryInput } from "../discovery/discovery-types";

export const ZCODE_PROVIDER_ID = "zcode" as const;

/** Endpoint path every row on this provider is registered against. */
export const ZCODE_ENDPOINT_PATH = "/chat/completions" as const;

interface ZcodeModelOptions {
  readonly vision?: boolean;
  readonly reasoning?: boolean;
}

function zcodeModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: ZcodeModelOptions = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: ZCODE_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: ZCODE_ENDPOINT_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? false,
    reasoning: options.reasoning ?? false,
    toolCall: true,
  });
}

/**
 * Static fallback catalog.
 *
 * `glm-5.3` is served on the coding endpoint but is not advertised by the
 * plan's `/models` listing, which still tops out at the previous SKU — so it is
 * seeded here or live discovery would never surface it. `glm-5.3-flash` is the
 * first natively multimodal GLM coding SKU.
 */
export const ZCODE_MODELS: readonly ModelDefinition[] = [
  zcodeModel("glm-5.3", 1_000_000, 131_072, { reasoning: true }),
  zcodeModel("glm-5.3-flash", 1_000_000, 131_072, { vision: true, reasoning: true }),
];

/** Z.AI Coding Plan adapter spec; the registry builds it via `createApiKeyAdapter`. */
export const ZCODE_SPEC: ApiKeyProviderSpec = {
  provider_id: ZCODE_PROVIDER_ID,
  endpoint_paths_by_wire_family: { chat: ZCODE_ENDPOINT_PATH },
};

export async function discoverZcodeModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchOpenAICompatibleModels({
    baseUrl: providerBaseUrl(ZCODE_PROVIDER_ID),
    providerId: ZCODE_PROVIDER_ID,
    headers: { authorization: `Bearer ${input.credential}` },
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}
