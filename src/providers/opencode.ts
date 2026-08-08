import { ProviderAdapterError, capabilitiesOf, createModelCatalog, modelOf, toProviderCallError } from "../open-sse/transport/shared";
import { callChatCompletionsWire } from "../open-sse/transport/protocols/openai";
import type {
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

const OPENCODE_SURFACES: readonly Surface[] = ["openai-chat"];
const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";

const OPENCODE_FREE_MODELS: readonly ProviderModel[] = [
  modelOf("big-pickle", "Big Pickle", capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true, images: true })),
  modelOf("deepseek-v4-flash-free", "DeepSeek V4 Flash Free", capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true })),
  modelOf("mimo-v2.5-free", "Mimo v2.5 Free", capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true, images: true })),
  modelOf("nemotron-3-ultra-free", "Nemotron 3 Ultra Free", capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true, images: true })),
  modelOf("north-mini-code-free", "North Mini Code Free", capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true })),
  modelOf("laguna-s-2.1-free", "Laguna S 2.1 Free", capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true })),
];

const OPENCODE_FALLBACK_CAPABILITIES = capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true, toolCalls: true });

/** OpenCode Free is the unauthenticated public OpenAI-compatible route. */
export class OpenCodeFreeAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "opencodeft",
    displayName: "OpenCode Free",
    protocol: "openai",
    credentialKind: "none",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(OPENCODE_FREE_MODELS);
  readonly capabilities: ProviderCaps = {
    ...OPENCODE_FALLBACK_CAPABILITIES,
    streaming: true,
  };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (this.models.get(modelId) === null) {
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
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "openai-chat") {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`,
        statusCode: 400,
        routeScope: null,
      });
    }
    const request = { ...input.request, model: input.target.upstreamModelId };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      authorization: "Bearer public",
    };
    const userAgent = input.headers?.get("user-agent");
    if (userAgent) headers["user-agent"] = userAgent;
    return callChatCompletionsWire({ ...input, request }, OPENCODE_BASE_URL, headers);
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

export const openCodeFreeModelCatalog = OPENCODE_FREE_MODELS;

/**
 * OpenCode Zen — billed access to the same opencode.ai/zen/v1 route as
 * OpenCode Free, differing only in auth: Zen requires a real, billed API key
 * (higher rate limits and reliability). Model catalog is the Free catalog
 * plus ling-3.0-flash-free.
 */
const OPENCODE_ZEN_MODELS: readonly ProviderModel[] = [
  ...OPENCODE_FREE_MODELS,
  modelOf("ling-3.0-flash-free", "Ling 3.0 Flash Free", capabilitiesOf({ surfaces: OPENCODE_SURFACES, reasoning: true, images: true })),
];

/** OpenCode Zen is the billed, API-key-authenticated OpenCode route. */
export class OpenCodeZenAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "opencodezen",
    displayName: "OpenCode Zen",
    protocol: "openai",
    credentialKind: "api_key",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(OPENCODE_ZEN_MODELS);
  readonly capabilities: ProviderCaps = {
    ...OPENCODE_FALLBACK_CAPABILITIES,
    streaming: true,
  };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (this.models.get(modelId) === null) {
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
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "openai-chat") {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({
        kind: "authentication_failed",
        message: "OpenCode Zen requires an API key.",
        statusCode: 401,
        routeScope: "account",
      });
    }
    const request = { ...input.request, model: input.target.upstreamModelId };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${input.credential}`,
    };
    const userAgent = input.headers?.get("user-agent");
    if (userAgent) headers["user-agent"] = userAgent;
    return callChatCompletionsWire({ ...input, request }, OPENCODE_BASE_URL, headers);
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

export const openCodeZenModelCatalog = OPENCODE_ZEN_MODELS;

