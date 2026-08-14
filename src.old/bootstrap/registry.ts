import { resolveModelMetadata, type ModelMetadataLookup, type ModelMetadataResolver, type ResolvedModelMetadata } from "../application/model-metadata";
import type { RouteSnapshotCache } from "../application/routing-snapshot";
import { ProviderRegistry } from "../providers/registry";
import type { ConfigPersistence } from "../storage";

export interface ModelMetadataResolverDependencies {
  readonly config: ConfigPersistence;
  readonly registry: ProviderRegistry;
  readonly routeSnapshots: RouteSnapshotCache;
}

/** Builds canonical model metadata from provider catalogs and configured custom providers. */
export function createModelMetadataResolver({ config, registry, routeSnapshots }: ModelMetadataResolverDependencies): ModelMetadataResolver {
  const lookup: ModelMetadataLookup = (providerId, modelId) => {
    const adapter = registry.get(providerId);
    if (adapter === null) return null;
    const model = adapter.models.get(modelId);
    const custom = config.customProviders.getBySlug(providerId);
    const context = model?.context ?? { inputTokens: null, outputTokens: null };
    const pricing = model?.pricing ?? { inputPerMillion: null, outputPerMillion: null };
    return {
      context: {
        inputTokens: context.inputTokens ?? null,
        outputTokens: context.outputTokens ?? null,
      },
      categories: model?.categories ?? [],
      pricing: {
        inputPerMillion: pricing.inputPerMillion ?? null,
        outputPerMillion: pricing.outputPerMillion ?? null,
      },
      source: custom !== null ? "custom" : "catalog",
      updatedAt: custom !== null ? custom.updatedAt : null,
    };
  };
  return {
    lookup,
    resolve: async (rawModel: string): Promise<ResolvedModelMetadata | null> => {
      const snapshot = await routeSnapshots.get();
      return resolveModelMetadata(rawModel, { prefixes: snapshot.prefixes, aliases: snapshot.aliases, combos: snapshot.combos }, lookup);
    },
  };
}
