import type { Adapter, ProviderCallError, ProviderMeta, ProviderOutput, ProviderRequest, RouteTarget, Surface } from "../../application/contracts";
import { callChatCompletionsWire, callResponsesWire } from "./protocols/openai";
import { callAnthropicWire } from "./protocols/anthropic";
import { aggregateCapabilities, capabilitiesOf, createModelCatalog } from "./catalog";
import { resolveModelCapabilities } from "../translate/capabilities";
import type { OpenAIAdapterConfig, ProviderCatalogAdapter } from "./contracts";
import { ProviderAdapterError, toProviderCallError } from "./errors";

const OPENAI_SURFACES = ["openai-chat", "openai-responses"] as const;
const OPENAI_FALLBACK_CAPS = capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true });

/** Builds the eager catalog half of an OpenAI-compatible adapter. */
export function describeOpenAIAdapter(config: OpenAIAdapterConfig): ProviderCatalogAdapter {
  const models = config.models ?? [];
  const modelCatalog = createModelCatalog(models);
  const capabilities = aggregateCapabilities(models, OPENAI_FALLBACK_CAPS);
  const metadata: ProviderMeta = {
    id: config.id,
    displayName: config.displayName,
    protocol: "openai",
    credentialKind: config.credentialKind,
    ...(config.credentialUrl ? { credentialUrl: config.credentialUrl } : {}),
  };
  return {
    metadata,
    capabilities,
    models: modelCatalog,
    resolveTarget(modelId: string, surface: Surface): RouteTarget {
      if (!capabilities.surfaces.includes(surface)) {
        throw new ProviderAdapterError({
          kind: "capability_unsupported",
          message: `Provider "${metadata.id}" does not support surface "${surface}"`,
          statusCode: 400,
          routeScope: null,
        });
      }
      const entry = modelCatalog.get(modelId);
      if (entry !== null && !entry.capabilities.surfaces.includes(surface)) {
        throw new ProviderAdapterError({
          kind: "capability_unsupported",
          message: `Model "${modelId}" on provider "${metadata.id}" does not support surface "${surface}"`,
          statusCode: 400,
          routeScope: "provider",
        });
      }
      const upstreamModelId = entry?.upstreamId ?? modelId;
      return { providerId: metadata.id, modelId, upstreamModelId, surface };
    },
  };
}


/**
 * Creates a standalone OpenAI-compatible adapter with Chat Completions,
 * Responses, and Anthropic Messages wire support when a catalog declares it.
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): Adapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const catalog = describeOpenAIAdapter(config);
  const auth = config.auth ?? "bearer";

  function assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== catalog.metadata.id) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Adapter "${catalog.metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!catalog.capabilities.surfaces.includes(input.target.surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${catalog.metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    const model = catalog.models.get(input.target.modelId);
    if (model !== null && !model.capabilities.surfaces.includes(input.target.surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Model "${input.target.modelId}" on provider "${catalog.metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: "provider",
      });
    }
    if (input.request.stream && !catalog.capabilities.streaming) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Adapter "${catalog.metadata.id}" does not support streaming`,
        statusCode: 400,
        routeScope: null,
      });
    }
  }

  return {
    ...catalog,
    async call(input: ProviderRequest): Promise<ProviderOutput> {
      assertSupported(input);
      const { request, credential } = input;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
      };
      if (auth === "bearer" && credential.length > 0) headers.authorization = `Bearer ${credential}`;
      else if (auth === "x-api-key" && credential.length > 0) headers["x-api-key"] = credential;
      if (input.target.surface === "anthropic-messages") {
        const modelCapabilities = resolveModelCapabilities(catalog.capabilities, catalog.models.get(input.target.modelId), input.target.surface);
        headers["anthropic-version"] = "2023-06-01";
        return callAnthropicWire(input, baseUrl, headers, catalog.capabilities, modelCapabilities);
      }
      const modelCapabilities = resolveModelCapabilities(catalog.capabilities, catalog.models.get(input.target.modelId), input.target.surface);
      if (input.target.surface === "openai-responses") return callResponsesWire(input, baseUrl, headers, { explicitCache: modelCapabilities.cache.breakpoints, capabilities: modelCapabilities });
      return callChatCompletionsWire(input, baseUrl, headers, {}, { explicitCache: modelCapabilities.cache.breakpoints, capabilities: modelCapabilities });
    },
    mapError(error: unknown): ProviderCallError {
      return toProviderCallError(error);
    },
  };
}
