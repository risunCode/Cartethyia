import type { ProviderCatalogAdapter } from "../../open-sse/transport/contracts";
import { ProviderAdapterError } from "../../open-sse/transport/errors";
import { createModelCatalog } from "../../open-sse/transport/catalog";
import type { ProviderCaps, ProviderMeta, ProviderModel, RouteTarget, Surface } from "../../application/contracts";

const DEVIN_SURFACES: readonly Surface[] = ["openai-chat"];
const DEVIN_MODEL_ID = "swe-1-6-slow";
const DEVIN_FALLBACK_CAPABILITIES: ProviderCaps = {
  surfaces: DEVIN_SURFACES,
  streaming: true,
  reasoning: true,
  toolCalls: true,
  images: false,
  explicitCache: false,
  promptCacheKey: false,
};

export const DEVIN_MODEL: ProviderModel = {
  id: DEVIN_MODEL_ID,
  displayName: "SWE-1.6 Slow",
  capabilities: DEVIN_FALLBACK_CAPABILITIES,
  context: { inputTokens: 200_000, outputTokens: 64_000 },
};

export const DEVIN_CATALOG: ProviderCatalogAdapter = {
  metadata: {
    id: "devin",
    displayName: "Devin",
    protocol: "devin",
    credentialKind: "oauth",
    credentialKinds: ["oauth", "api_key"],
  } satisfies ProviderMeta,
  capabilities: DEVIN_FALLBACK_CAPABILITIES,
  models: createModelCatalog([DEVIN_MODEL]),
  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!DEVIN_SURFACES.includes(surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Devin does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    if (modelId !== DEVIN_MODEL_ID) throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the Devin catalog`, statusCode: 404, routeScope: "provider" });
    return { providerId: "devin", modelId: DEVIN_MODEL_ID, upstreamModelId: DEVIN_MODEL_ID, surface };
  },
};
