/** USD per 1M tokens, sourced from the provider's published rate card (models.dev). */
export interface ModelPricing {
  input: number;
  output: number;
  /** Cached-read token price, when the provider prices cache reads separately from fresh input. */
  cacheRead?: number;
  /** Cache-write token price, when the provider charges to populate the cache. */
  cacheWrite?: number;
}

export interface ProviderModelEntry {
  id: string;
  /** True when the model supports extended/chain-of-thought reasoning. */
  reasoning?: boolean;
  /** True when the model accepts image/PDF input. */
  vision?: boolean;
  /** True when the model supports web search / grounding. */
  websearch?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  description?: string;
  /**
   * Omitted for aggregator/subscription providers with no fixed per-token
   * vendor price (OpenCode Free/Zen/Go, AgentRouter, Kimchi, Qoder, Command
   * Code, Devin, Cursor CLI, Ollama) — those are billed as a flat plan, not
   * metered per token, so a per-model rate card doesn't apply.
   */
  pricing?: ModelPricing;
}

export interface ProviderModelCatalog {
  list(): ProviderModelEntry[];
  resolve(modelId: string): ProviderModelEntry | undefined;
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
  };
}
