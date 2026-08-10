import type { ModelCapabilityCategory, ProviderCaps, ProviderModel, ProviderModelCatalog, Surface } from "../../application/contracts";
import type { CapabilitySeed, ModelMetadataSeed } from "./contracts";

/** Creates an immutable model catalog with O(1) model lookup. */
export function createModelCatalog(models: readonly ProviderModel[]): ProviderModelCatalog {
  const byId = new Map<string, ProviderModel>();
  for (const model of models) byId.set(model.id, model);
  return {
    list: Object.freeze([...models]),
    get: (modelId: string): ProviderModel | null => byId.get(modelId) ?? null,
  };
}

/** Converts capability defaults into the normalized provider capability shape. */
export function capabilitiesOf(seed: CapabilitySeed): ProviderCaps {
  return {
    surfaces: [...seed.surfaces],
    streaming: seed.streaming ?? true,
    reasoning: seed.reasoning ?? false,
    toolCalls: seed.toolCalls ?? true,
    images: seed.images ?? false,
    explicitCache: seed.explicitCache ?? false,
    promptCacheKey: seed.promptCacheKey ?? false,
  };
}

/** Derives normalized model categories from provider capabilities. */
export function categoriesOf(capabilities: ProviderCaps): readonly ModelCapabilityCategory[] {
  const categories: ModelCapabilityCategory[] = [];
  if (capabilities.images) categories.push("vision");
  if (capabilities.surfaces.some((surface) => surface !== "images")) categories.push("text");
  if (capabilities.reasoning) categories.push("reasoning");
  return categories;
}

/** Builds one normalized provider model record. */
export function modelOf(id: string, displayName: string, capabilities: ProviderCaps, metadata: ModelMetadataSeed = {}): ProviderModel {
  return {
    id,
    displayName,
    capabilities,
    ...(metadata.upstreamId !== undefined ? { upstreamId: metadata.upstreamId } : {}),
    context: {
      inputTokens: metadata.context?.inputTokens ?? null,
      outputTokens: metadata.context?.outputTokens ?? null,
    },
    categories: metadata.categories ?? categoriesOf(capabilities),
    pricing: {
      inputPerMillion: metadata.pricing?.inputPerMillion ?? null,
      outputPerMillion: metadata.pricing?.outputPerMillion ?? null,
    },
  };
}

/** Aggregates model capabilities, preserving fallback semantics for empty catalogs. */
export function aggregateCapabilities(models: readonly ProviderModel[], fallback: ProviderCaps): ProviderCaps {
  if (models.length === 0) return { ...fallback, surfaces: [...fallback.surfaces] };
  const surfaces: Surface[] = [];
  let streaming = false;
  let reasoning = false;
  let toolCalls = false;
  let images = false;
  let explicitCache = false;
  let promptCacheKey = false;
  for (const model of models) {
    const caps = model.capabilities;
    for (const surface of caps.surfaces) {
      if (!surfaces.includes(surface)) surfaces.push(surface);
    }
    streaming ||= caps.streaming;
    reasoning ||= caps.reasoning;
    toolCalls ||= caps.toolCalls;
    images ||= caps.images;
    explicitCache ||= caps.explicitCache;
    promptCacheKey ||= caps.promptCacheKey;
  }
  return { surfaces, streaming, reasoning, toolCalls, images, explicitCache, promptCacheKey };
}
