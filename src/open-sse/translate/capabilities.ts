import type {
  ProviderCaps,
  ProviderModel,
  ReasoningEffort,
  Surface,
} from "../../application/contracts";

export type CanonicalEffort = ReasoningEffort;
export type SupportLevel = "supported" | "unsupported" | "unknown";

export interface ReasoningCapabilities {
  readonly supported: boolean;
  readonly efforts: readonly CanonicalEffort[];
  readonly maxTokens: SupportLevel;
  readonly summary: boolean;
  readonly modes: readonly string[];
}

export interface CacheCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly key: boolean;
  readonly breakpoints: boolean;
  readonly ttl: readonly string[];
  readonly options: readonly string[];
}

export interface ToolCapabilities {
  readonly function: boolean;
  readonly native: readonly string[];
  readonly parallel: boolean;
}

export interface ResponseCapabilities {
  readonly jsonObject: boolean;
  readonly jsonSchema: boolean;
}

export interface MediaCapabilities {
  readonly images: boolean;
  readonly generation: readonly string[];
}

export interface ModelCapabilities {
  readonly surfaces: readonly Surface[];
  readonly streaming: boolean;
  readonly reasoning: ReasoningCapabilities;
  readonly cache: CacheCapabilities;
  readonly tools: ToolCapabilities;
  readonly response: ResponseCapabilities;
  readonly media: MediaCapabilities;
}

const ALL_EFFORTS: readonly CanonicalEffort[] = ["xhigh", "high", "medium", "low", "minimal", "none"];

/** Resolves model capabilities without treating provider aggregate OR flags as model guarantees. */
export function resolveModelCapabilities(provider: ProviderCaps, model: ProviderModel | null, targetSurface: Surface): ModelCapabilities {
  if (model !== null) return fromCaps(model.capabilities, targetSurface);
  return conservativeUnknown(provider, targetSurface);
}

/** Projects the legacy capability shape into the unified feature matrix. */
export function fromCaps(caps: ProviderCaps, targetSurface: Surface): ModelCapabilities {
  const reasoningSupported = caps.reasoning;
  return {
    surfaces: caps.surfaces.includes(targetSurface) ? [...caps.surfaces] : [],
    streaming: caps.streaming,
    reasoning: {
      supported: reasoningSupported,
      efforts: reasoningSupported ? ALL_EFFORTS : [],
      maxTokens: caps.reasoningCapability?.maxBudget === undefined ? "unknown" : "supported",
      summary: reasoningSupported && (targetSurface === "openai-responses" || targetSurface === "openai-chat"),
      modes: reasoningSupported ? ["standard", "pro"] : [],
    },
    cache: {
      read: caps.explicitCache || caps.promptCacheKey,
      write: caps.explicitCache,
      key: caps.promptCacheKey,
      breakpoints: caps.explicitCache,
      ttl: caps.explicitCache ? ["30m", "5m", "1h"] : [],
      options: caps.explicitCache ? ["mode", "ttl"] : [],
    },
    tools: {
      function: caps.toolCalls,
      native: [],
      parallel: caps.toolCalls,
    },
    response: {
      jsonObject: caps.surfaces.includes("openai-chat") || caps.surfaces.includes("openai-responses"),
      jsonSchema: caps.surfaces.includes("openai-responses"),
    },
    media: {
      images: caps.images,
      generation: [...caps.mediaGeneration],
    },
  };
}

function conservativeUnknown(provider: ProviderCaps, targetSurface: Surface): ModelCapabilities {
  return {
    surfaces: provider.surfaces.includes(targetSurface) ? [targetSurface] : [],
    streaming: provider.streaming,
    reasoning: { supported: false, efforts: [], maxTokens: "unknown", summary: false, modes: [] },
    cache: { read: false, write: false, key: false, breakpoints: false, ttl: [], options: [] },
    tools: { function: false, native: [], parallel: false },
    response: { jsonObject: false, jsonSchema: false },
    media: { images: false, generation: [] },
  };
}
