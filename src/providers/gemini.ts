import { ProviderAdapterError, toProviderCallError } from "../open-sse/transport/errors";
import { aggregateCapabilities, capabilitiesOf, createModelCatalog, modelOf } from "../open-sse/transport/catalog";
import type {
  CredentialKind,
  Adapter,
  ProviderCaps,
  ProviderMeta,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  Surface,
  RouteTarget,
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";
import { callGeminiWire } from "../open-sse/transport/protocols/gemini";

/** Direct Gemini Generative Language API adapter. */
const GEMINI_SURFACES: readonly Surface[] = ["openai-chat", "openai-responses", "anthropic-messages", "images"];
const GEMINI_TEXT_SURFACES: readonly Surface[] = ["openai-chat", "openai-responses", "anthropic-messages"];
const GEMINI_DEFAULT_MODELS: readonly ProviderModel[] = [
  modelOf("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite Preview", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3-flash-preview", "Gemini 3 Flash Preview", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.5-pro", "Gemini 2.5 Pro", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.5-flash", "Gemini 2.5 Flash", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.0-flash", "Gemini 2.0 Flash", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, images: true })),
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

export class GeminiAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
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

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    return callGeminiWire(input, this.baseUrl, input.credential);
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }


  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id || !this.capabilities.surfaces.includes(input.target.surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" cannot serve this target`, statusCode: 400, routeScope: null });
    if (input.request.stream && !this.capabilities.streaming) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support streaming`, statusCode: 400, routeScope: null });
  }
}

