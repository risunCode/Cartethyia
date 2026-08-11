import type {
  CredentialKind,
  ModelCapabilityCategory,
  ModelContextLimits,
  ModelTokenPricing,
  ProviderCaps,
  ProviderMeta,
  ProviderModel,
  ProviderModelCatalog,
  RouteTarget,
  StreamEvent,
  Surface,
} from "../../application/contracts";
import type { AbortCoordinator } from "./abort-coordinator";

/** One decoded server-sent event. */
export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

/** Bounds and lifecycle state used by the SSE decoder. */
export interface SseDecodeConfig {
  readonly body: ReadableStream<Uint8Array>;
  readonly coordinator: AbortCoordinator;
  readonly maxLineBytes: number;
  readonly maxEventBytes?: number;
  readonly idleTimeoutMs?: number;
}

/** Maps one decoded SSE event into zero or more application stream events. */
export type StreamMapper = (sse: SseEvent) => StreamEvent | readonly StreamEvent[] | null;

/** Capability defaults used when constructing provider catalogs. */
export interface CapabilitySeed {
  readonly surfaces: readonly Surface[];
  readonly streaming?: boolean;
  readonly reasoning?: boolean;
  readonly toolCalls?: boolean;
  readonly images?: boolean;
  readonly explicitCache?: boolean;
  readonly promptCacheKey?: boolean;
  readonly search?: boolean;
}

/** Optional normalized metadata used to describe a provider model. */
export interface ModelMetadataSeed {
  readonly upstreamId?: string;
  readonly context?: Partial<ModelContextLimits> | null;
  readonly categories?: readonly ModelCapabilityCategory[] | null;
  readonly pricing?: Partial<ModelTokenPricing> | null;
}

/** Configuration for one OpenAI-compatible provider. */
export interface OpenAIAdapterConfig {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly credentialKind: CredentialKind;
  readonly credentialUrl?: string;
  readonly auth?: "bearer" | "x-api-key" | "none";
  readonly models?: readonly ProviderModel[];
}

/** Eager catalog surface used by lazy provider registration. */
export interface ProviderCatalogAdapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  resolveTarget(modelId: string, surface: Surface): RouteTarget;
}
