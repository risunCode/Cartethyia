import type { ApiKeyProviderSpec } from "./configured-provider";

const AIHUBMIX_PROVIDER_ID = "aihubmix" as const;

/**
 * AiHubMix serves the same model ids on chat and responses, so both wire
 * families are declared and `candidate.wire_family` picks the endpoint.
 */
import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";

export const AIHUBMIX_FALLBACK_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-5", providerId: AIHUBMIX_PROVIDER_ID, reasoning: true, vision: true }),
  defineModel({ id: "gpt-5-mini", providerId: AIHUBMIX_PROVIDER_ID, reasoning: true }),
  defineModel({ id: "", providerId: AIHUBMIX_PROVIDER_ID, reasoning: true, vision: true }),
  defineModel({ id: "gemini-3-pro", providerId: AIHUBMIX_PROVIDER_ID, reasoning: true, vision: true }),
];


/** AiHubMix adapter spec; the registry builds it via `createApiKeyAdapter`. */
export const AIHUBMIX_SPEC: ApiKeyProviderSpec = {
  provider_id: AIHUBMIX_PROVIDER_ID,
  endpoint_paths_by_wire_family: {
    chat: "/chat/completions",
    responses: "/responses",
  },
};
