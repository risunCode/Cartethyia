export type ModelCapability = "text" | "vision" | "reasoning" | "tools" | "streaming" | "json";

export interface ProviderModelEntry {
  id: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  description?: string;
}

export interface ProviderModelCatalog {
  list(): ProviderModelEntry[];
  resolve(modelId: string): ProviderModelEntry | undefined;
  hasCapability(modelId: string, capability: ModelCapability): boolean;
}

export function createModelCatalog(models: ProviderModelEntry[]): ProviderModelCatalog {
  const lookup = new Map<string, ProviderModelEntry>();
  for (const model of models) {
    lookup.set(model.id, model);
  }

  return {
    list() {
      return models;
    },
    resolve(modelId: string) {
      return lookup.get(modelId);
    },
    hasCapability(modelId: string, capability: ModelCapability) {
      const model = lookup.get(modelId);
      if (!model) return false;
      return model.capabilities.includes(capability);
    },
  };
}
