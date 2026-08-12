import type {
  ModelCacheMode,
  ModelCompatibility,
  ModelSamplingCompatibility,
  ModelToolCompatibility,
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
  readonly effortMap?: Readonly<Record<string, string>>;
  readonly maxTokens: SupportLevel;
  readonly budget?: boolean;
  readonly summary: boolean;
  readonly disable?: boolean;
  readonly modes: readonly string[];
}

export interface SamplingCapabilities {
  readonly temperature: boolean;
  readonly topP: boolean;
  readonly stop: boolean;
}

export interface CacheCapabilities {
  readonly mode?: ModelCacheMode;
  readonly read: boolean;
  readonly write: boolean;
  readonly key: boolean;
  readonly breakpoints: boolean;
  readonly breakpointLimit?: number;
  readonly minimumPrefixTokens?: number;
  readonly ttl: readonly string[];
  readonly options: readonly string[];
}

export interface ToolCapabilities {
  readonly function: boolean;
  readonly native: readonly string[];
  readonly nativeTypes?: readonly string[];
  readonly parallel: boolean;
  readonly resultIdRequired?: boolean;
}

export interface ResponseCapabilities {
  readonly jsonObject: boolean;
  readonly jsonSchema: boolean;
}

export interface ResponseStateCapabilities {
  readonly previousResponseId: boolean;
  readonly staleRepair: boolean;
}

export interface TimeoutProfileCapabilities {
  readonly firstByteMs?: number;
  readonly idleMs?: number;
}

export interface MediaCapabilities {
  readonly images: boolean;
  readonly generation: readonly string[];
}

export interface ModelCapabilities {
  readonly surfaces: readonly Surface[];
  readonly streaming: boolean;
  readonly reasoning: ReasoningCapabilities;
  readonly sampling?: SamplingCapabilities;
  readonly cache: CacheCapabilities;
  readonly tools: ToolCapabilities;
  readonly response: ResponseCapabilities;
  readonly responseState?: ResponseStateCapabilities;
  readonly streamUsage?: boolean;
  readonly timeoutProfile?: TimeoutProfileCapabilities;
  readonly media: MediaCapabilities;
}

const ALL_EFFORTS: readonly CanonicalEffort[] = ["xhigh", "high", "medium", "low", "minimal", "none"];
const DEFAULT_CACHE_TTL: readonly string[] = ["30m", "5m", "1h"];

/** Resolves model capabilities without treating provider aggregate OR flags as model guarantees. */
export function resolveModelCapabilities(provider: ProviderCaps, model: ProviderModel | null, targetSurface: Surface): ModelCapabilities {
  if (model !== null) return fromCaps(model.capabilities, targetSurface, model.compatibility);
  return conservativeUnknown(provider, targetSurface);
}

/** Projects legacy capabilities and optional model-local compatibility metadata into a feature matrix. */
export function fromCaps(caps: ProviderCaps, targetSurface: Surface, compatibility?: ModelCompatibility): ModelCapabilities {
  return {
    surfaces: caps.surfaces.includes(targetSurface) ? [...caps.surfaces] : [],
    streaming: caps.streaming,
    reasoning: resolveReasoning(caps, targetSurface, compatibility?.reasoning),
    sampling: resolveSampling(caps, compatibility?.sampling),
    cache: resolveCache(caps, compatibility?.cache),
    tools: resolveTools(caps, compatibility?.tools),
    response: {
      jsonObject: caps.surfaces.includes("openai-chat") || caps.surfaces.includes("openai-responses"),
      jsonSchema: caps.surfaces.includes("openai-responses"),
    },
    responseState: {
      previousResponseId: compatibility?.responseState?.previousResponseId === true,
      staleRepair: compatibility?.responseState?.staleRepair === true,
    },
    streamUsage: compatibility?.streamUsage === true,
    timeoutProfile: normalizeTimeoutProfile(compatibility?.timeoutProfile),
    media: {
      images: caps.images,
      generation: [...caps.mediaGeneration],
    },
  };
}

function resolveReasoning(
  caps: ProviderCaps,
  targetSurface: Surface,
  descriptor: ModelCompatibility["reasoning"],
): ReasoningCapabilities {
  const supported = caps.reasoning;
  const effortMap = descriptor === undefined ? undefined : normalizeEffortMap(descriptor.effortMap);
  let efforts: readonly CanonicalEffort[] = [];
  let maxTokens: SupportLevel = "unsupported";
  let summary = false;
  let disable = false;
  let modes: readonly string[] = [];
  if (!supported) {
    maxTokens = "unsupported";
  } else if (descriptor === undefined) {
    efforts = [...ALL_EFFORTS];
    maxTokens = caps.reasoningCapability?.maxBudget === undefined ? "unknown" : "supported";
    summary = targetSurface === "openai-responses" || targetSurface === "openai-chat";
    modes = ["standard", "pro"];
  } else {
    if (descriptor.efforts !== undefined) efforts = normalizeEfforts(descriptor.efforts);
    else efforts = Object.keys(effortMap ?? {}).filter(isCanonicalEffort);
    if (descriptor.budget === true) maxTokens = "supported";
    else if (descriptor.budget === false) maxTokens = "unsupported";
    else maxTokens = "unknown";
    summary = descriptor.summary === true;
    disable = descriptor.disable === true;
  }
  return {
    supported,
    efforts,
    ...(effortMap === undefined ? {} : { effortMap }),
    maxTokens,
    budget: maxTokens === "supported",
    summary,
    disable,
    modes,
  };
}

function resolveSampling(caps: ProviderCaps, descriptor: ModelSamplingCompatibility | undefined): SamplingCapabilities {
  if (descriptor !== undefined) {
    return {
      temperature: samplingFlag(descriptor.temperature, "temperature", descriptor.supported),
      topP: samplingFlag(descriptor.topP, "top_p", descriptor.supported),
      stop: samplingFlag(descriptor.stop, "stop", descriptor.supported),
    };
  }
  const supported = caps.quirks?.supportedResponseControls;
  const dropped = caps.quirks?.droppedFields ?? [];
  return {
    temperature: legacySamplingFlag("temperature", supported, dropped),
    topP: legacySamplingFlag("top_p", supported, dropped, "topP"),
    stop: legacySamplingFlag("stop", supported, dropped),
  };
}

function resolveCache(caps: ProviderCaps, descriptor: ModelCompatibility["cache"]): CacheCapabilities {
  if (descriptor === undefined) {
    const mode: ModelCacheMode = caps.explicitCache ? "explicit" : caps.promptCacheKey ? "implicit" : "none";
    return {
      mode,
      read: caps.explicitCache || caps.promptCacheKey,
      write: caps.explicitCache,
      key: caps.promptCacheKey,
      breakpoints: caps.explicitCache,
      ttl: caps.explicitCache ? DEFAULT_CACHE_TTL : [],
      options: caps.explicitCache ? ["mode", "ttl"] : [],
    };
  }
  const mode = descriptor.mode ?? "none";
  const breakpointLimit = positiveNumber(descriptor.breakpoints, true);
  const minimumPrefixTokens = positiveNumber(descriptor.minimumPrefixTokens, true);
  const breakpoints = breakpointLimit !== undefined;
  const ttl = descriptor.ttl === true ? DEFAULT_CACHE_TTL : [];
  const options = [
    ...(descriptor.mode !== undefined && mode !== "none" ? ["mode"] : []),
    ...(descriptor.ttl === true ? ["ttl"] : []),
    ...(breakpoints ? ["breakpoints"] : []),
    ...(minimumPrefixTokens === undefined ? [] : ["minimum_prefix_tokens"]),
  ];
  return {
    mode,
    read: mode !== "none",
    write: mode !== "none",
    key: mode === "explicit",
    breakpoints,
    ...(breakpointLimit === undefined ? {} : { breakpointLimit }),
    ...(minimumPrefixTokens === undefined ? {} : { minimumPrefixTokens }),
    ttl,
    options,
  };
}

function resolveTools(caps: ProviderCaps, descriptor: ModelToolCompatibility | undefined): ToolCapabilities {
  const nativeTypes = descriptor === undefined ? [] : normalizeNativeTypes(descriptor.nativeTypes);
  return {
    function: caps.toolCalls,
    native: nativeTypes,
    nativeTypes,
    parallel: descriptor?.parallel === true,
    resultIdRequired: descriptor?.resultIdRequired === true,
  };
}

function conservativeUnknown(provider: ProviderCaps, targetSurface: Surface): ModelCapabilities {
  return {
    surfaces: provider.surfaces.includes(targetSurface) ? [targetSurface] : [],
    streaming: provider.streaming,
    reasoning: { supported: false, efforts: [], maxTokens: "unknown", budget: false, summary: false, disable: false, modes: [] },
    sampling: { temperature: false, topP: false, stop: false },
    cache: { mode: "none", read: false, write: false, key: false, breakpoints: false, ttl: [], options: [] },
    tools: { function: false, native: [], nativeTypes: [], parallel: false, resultIdRequired: false },
    response: { jsonObject: false, jsonSchema: false },
    responseState: { previousResponseId: false, staleRepair: false },
    streamUsage: false,
    timeoutProfile: {},
    media: { images: false, generation: [] },
  };
}

function normalizeEfforts(values: readonly CanonicalEffort[]): readonly CanonicalEffort[] {
  return values.filter((value, index): value is CanonicalEffort => isCanonicalEffort(value) && values.indexOf(value) === index);
}

function normalizeEffortMap(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value).filter(([key, mapped]) => isCanonicalEffort(key) && mapped.trim().length > 0);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function normalizeNativeTypes(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return value.filter((item, index): item is string => item.trim().length > 0 && value.indexOf(item) === index);
}

function samplingFlag(value: boolean | undefined, field: "temperature" | "top_p" | "stop", supported: readonly string[] | undefined): boolean {
  if (value !== undefined) return value;
  return supported?.includes(field) ?? false;
}

function legacySamplingFlag(field: string, supported: readonly string[] | undefined, dropped: readonly string[], ...aliases: readonly string[]): boolean {
  if (supported !== undefined) return supported.includes(field) || aliases.some((alias) => supported.includes(alias));
  return !dropped.includes(field) && !aliases.some((alias) => dropped.includes(alias));
}

function normalizeTimeoutProfile(profile: ModelCompatibility["timeoutProfile"]): TimeoutProfileCapabilities {
  if (profile === undefined) return {};
  const firstByteMs = positiveNumber(profile.firstByteMs);
  const idleMs = positiveNumber(profile.idleMs);
  return {
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
    ...(idleMs === undefined ? {} : { idleMs }),
  };
}

function positiveNumber(value: number | undefined, allowZero = false): number | undefined {
  if (value === undefined || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) return undefined;
  return value;
}

function isCanonicalEffort(value: string): value is CanonicalEffort {
  return ALL_EFFORTS.includes(value as CanonicalEffort);
}
