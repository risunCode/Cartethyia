import {
  AbortCoordinator,
  ProviderAdapterError,
  aggregateCapabilities,
  capabilitiesOf,
  createModelCatalog,
  executeFetch,
  isRecord,
  lineLimit,
  mapSseStream,
  messageText,
  modelOf,
  nullableNumber,
  readJsonObject,
  readUpstreamError,
  toProviderCallError,
} from "./shared";
import type { SseEvent, StreamMapper } from "./shared";
import type {
  ContextStats,
  CredentialKind,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderMetadata,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  ProviderSurface,
  ProviderUsage,
  RouteTarget,
  TokenCountInput,
} from "../domain/contracts";
import type { ProviderCallError } from "../domain/contracts";
import type { ContentBlock, ImageReference, NormalizedMessage, NormalizedProviderRequest } from "../domain/contracts";
import { buildGeminiPayload, mapGeminiUsage, translateGeminiResponse } from "../domain/protocols/gemini-generate-content";
import { callGeminiWire } from "../transport/protocols/gemini";
import type { StreamEvent } from "../domain/contracts";

/** Direct Gemini Generative Language API adapter. */
const GEMINI_SURFACES: readonly ProviderSurface[] = ["openai-chat", "openai-responses", "anthropic-messages", "images"];
const GEMINI_DEFAULT_MODELS: readonly ProviderModel[] = [
  modelOf("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", capabilitiesOf({ surfaces: GEMINI_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite Preview", capabilitiesOf({ surfaces: GEMINI_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3-flash-preview", "Gemini 3 Flash Preview", capabilitiesOf({ surfaces: GEMINI_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.5-pro", "Gemini 2.5 Pro", capabilitiesOf({ surfaces: GEMINI_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.5-flash", "Gemini 2.5 Flash", capabilitiesOf({ surfaces: GEMINI_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.0-flash", "Gemini 2.0 Flash", capabilitiesOf({ surfaces: GEMINI_SURFACES, images: true })),
  modelOf("gemini-3.1-flash-image-preview", "Gemini 3.1 Flash Image", capabilitiesOf({ surfaces: ["images"], images: true })),
  modelOf("gemini-3-pro-image-preview", "Gemini 3 Pro Image", capabilitiesOf({ surfaces: ["images"], images: true })),
  modelOf("gemini-2.5-flash-image", "Gemini 2.5 Flash Image", capabilitiesOf({ surfaces: ["images"], images: true })),
];
const GEMINI_FALLBACK_CAPABILITIES = capabilitiesOf({ surfaces: GEMINI_SURFACES, reasoning: true, images: true });

export interface GeminiAdapterConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialKind?: CredentialKind;
  readonly models?: readonly ProviderModel[];
}

export class GeminiAdapter implements ProviderAdapter {
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;

  constructor(config: GeminiAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const models = config.models ?? GEMINI_DEFAULT_MODELS;
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, GEMINI_FALLBACK_CAPABILITIES);
    this.metadata = {
      id: config.id ?? "gemini",
      displayName: config.displayName ?? "Google Gemini",
      protocol: "gemini",
      credentialKind: config.credentialKind ?? "api_key",
    };
  }

  resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    if (!this.modelKnown(modelId)) throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`, statusCode: 404, routeScope: "provider" });
    return { providerId: this.metadata.id, modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    return callGeminiWire(input, this.baseUrl, input.credential, input.headers?.get("user-agent") ?? null);
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }

  private modelKnown(modelId: string): boolean {
    return this.models.list.length === 0 || this.models.get(modelId) !== null;
  }

  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id || !this.capabilities.surfaces.includes(input.target.surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" cannot serve this target`, statusCode: 400, routeScope: null });
    if (input.request.stream && !this.capabilities.streaming) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support streaming`, statusCode: 400, routeScope: null });
  }
}

