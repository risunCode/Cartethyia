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
import { callAnthropicWire } from "../open-sse/transport/protocols/anthropic";

/**
 * Anthropic adapter: the "anthropic-messages" surface over the Messages
 * wire format. Declares explicit prompt caching (cache_control + beta
 * header) and extended thinking.
 */

const ANTHROPIC_SURFACES: readonly Surface[] = ["anthropic-messages"];

const ANTHROPIC_DEFAULT_MODELS: readonly ProviderModel[] = [
  modelOf("claude-opus-4-1", "Claude Opus 4.1", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-sonnet-4-5", "Claude Sonnet 4.5", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-haiku-4-5", "Claude Haiku 4.5", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-3-7-sonnet", "Claude 3.7 Sonnet", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-3-5-haiku-latest", "Claude 3.5 Haiku", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, images: true, explicitCache: true, promptCacheKey: true })),
];

const ANTHROPIC_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({
  surfaces: ANTHROPIC_SURFACES,
  reasoning: true,
  images: true,
  explicitCache: true,
  promptCacheKey: true,
});
const FORWARDABLE_GATEWAY_HEADERS: Record<string, true> = { "x-app": true, "x-client-request-id": true };
const BLOCKED_GATEWAY_HEADERS: Record<string, true> = {
  authorization: true,
  "proxy-authorization": true,
  "x-api-key": true,
  host: true,
  "content-length": true,
  connection: true,
  "transfer-encoding": true,
};

function forwardGatewayHeaders(source: Headers | undefined, target: Record<string, string>): void {
  if (source === undefined) return;
  for (const [name, value] of source) {
    const normalized = name.toLowerCase();
    if (BLOCKED_GATEWAY_HEADERS[normalized] === true) continue;
    if (FORWARDABLE_GATEWAY_HEADERS[normalized] !== true && !normalized.startsWith("anthropic-") && !normalized.startsWith("x-claude-code-")) continue;
    if (normalized === "anthropic-version" || normalized === "anthropic-beta") continue;
    target[normalized] = value;
  }
}


export interface AnthropicAdapterConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialKind?: CredentialKind;
  readonly auth?: "x-api-key" | "bearer";
  readonly models?: readonly ProviderModel[];
}

export class AnthropicAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;
  private readonly auth: "x-api-key" | "bearer";

  constructor(config: AnthropicAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const models = config.models ?? ANTHROPIC_DEFAULT_MODELS;
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, ANTHROPIC_FALLBACK_CAPABILITIES);
    this.metadata = {
      id: config.id ?? "anthropic",
      displayName: config.displayName ?? "Anthropic",
      protocol: "anthropic",
      credentialKind: config.credentialKind ?? "api_key",
    };
    this.auth = config.auth ?? "x-api-key";
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
    const { request, credential } = input;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      "anthropic-version": input.headers?.get("anthropic-version") ?? "2023-06-01",
    };
    const incomingBeta = input.headers?.get("anthropic-beta");
    if (incomingBeta) headers["anthropic-beta"] = incomingBeta;
    else if (this.capabilities.explicitCache && this.capabilities.promptCacheKey) headers["anthropic-beta"] = "prompt-caching-2024-07-31";
    forwardGatewayHeaders(input.headers, headers);
    const userAgent = input.headers?.get("user-agent");
    if (userAgent) headers["user-agent"] = userAgent;
    if (this.auth === "bearer") headers.authorization = `Bearer ${credential}`;
    else headers["x-api-key"] = credential;
    return callAnthropicWire(input, this.baseUrl, headers, this.capabilities);
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
}

