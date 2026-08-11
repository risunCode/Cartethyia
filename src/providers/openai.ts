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
import { callHostedImageWire, callResponsesWire } from "../open-sse/transport/protocols/openai";
/**
 * OpenAI adapter: Responses API ("openai-responses") and hosted image
 * generation over the OpenAI wire format. Chat-compatible clients are
 * translated to Responses by the surface resolver.
 */

const OPENAI_SURFACES: readonly Surface[] = ["openai-responses", "images"];

const OPENAI_DEFAULT_MODELS: readonly ProviderModel[] = [
  modelOf("gpt-5.6", "GPT-5.6", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.6-sol", "GPT-5.6 Sol", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.6-terra", "GPT-5.6 Terra", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.6-luna", "GPT-5.6 Luna", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5", "GPT-5", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5-mini", "GPT-5 Mini", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true })),
  modelOf("gpt-5-nano", "GPT-5 Nano", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true })),
  modelOf("gpt-4.1", "GPT-4.1", capabilitiesOf({ surfaces: OPENAI_SURFACES, images: true })),
  modelOf("gpt-4.1-mini", "GPT-4.1 Mini", capabilitiesOf({ surfaces: OPENAI_SURFACES, images: true })),
  modelOf("gpt-4.1-nano", "GPT-4.1 Nano", capabilitiesOf({ surfaces: OPENAI_SURFACES })),
  modelOf("gpt-4o", "GPT-4o", capabilitiesOf({ surfaces: OPENAI_SURFACES, images: true })),
  modelOf("gpt-4o-mini", "GPT-4o Mini", capabilitiesOf({ surfaces: OPENAI_SURFACES, images: true })),
  modelOf("o3", "O3", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true })),
  modelOf("o4-mini", "O4 Mini", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true })),
  modelOf("dall-e-3", "DALL-E 3", capabilitiesOf({ surfaces: ["images"], images: true })),
  modelOf("gpt-image-1", "GPT Image 1", capabilitiesOf({ surfaces: ["images"], images: true })),
];

const OPENAI_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: OPENAI_SURFACES });

export interface OpenAIAdapterConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialKind?: CredentialKind;
  readonly models?: readonly ProviderModel[];
}

export class OpenAIAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;

  constructor(config: OpenAIAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const models = config.models ?? OPENAI_DEFAULT_MODELS;
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, OPENAI_FALLBACK_CAPABILITIES);
    this.metadata = {
      id: config.id ?? "openai",
      displayName: config.displayName ?? "OpenAI",
      protocol: "openai",
      credentialKind: config.credentialKind ?? "api_key",
    };
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!this.modelKnown(modelId)) {
      throw new ProviderAdapterError({
        kind: "model_not_found",
        message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`,
        statusCode: 404,
        routeScope: "provider",
      });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    const { credential } = input;
    if (input.target.surface === "images") {
      return callHostedImageWire(input, `${this.baseUrl}/responses`, this.authHeaders(credential, false));
    }
    return callResponsesWire(input, this.baseUrl, this.authHeaders(credential, input.request.stream));
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }

  private modelKnown(modelId: string): boolean {
    return this.models.list.length === 0 || this.models.get(modelId) !== null;
  }

  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Adapter "${this.metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!this.capabilities.surfaces.includes(input.target.surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (input.request.stream && !this.capabilities.streaming) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support streaming`,
        statusCode: 400,
        routeScope: null,
      });
    }
  }

  private authHeaders(credential: string, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${credential}`,
    };
    return headers;
  }
}





