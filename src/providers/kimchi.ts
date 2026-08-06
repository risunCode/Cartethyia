import { ProviderAdapterError, capabilitiesOf, createModelCatalog, modelOf, toProviderCallError } from "./shared";
import { callChatCompletionsWire } from "../transport/protocols/openai";
import type {
  ContextStats,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderMetadata,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  ProviderSurface,
  RouteTarget,
  TokenCountInput,
} from "../domain/contracts";
import type { ProviderCallError } from "../domain/contracts";

/**
 * Kimchi — an OpenAI-compatible Chat Completions gateway
 * (https://llm.kimchi.dev/openai/v1) authenticated with the bearer token from
 * the Kimchi CLI configuration. Same wire format as the OpenAI/OpenCode
 * adapters; the only Kimchi-specific bits are its base URL, its fixed CLI
 * User-Agent, and its curated model catalog.
 */

const KIMCHI_SURFACES: readonly ProviderSurface[] = ["openai-chat"];
const KIMCHI_BASE_URL = "https://llm.kimchi.dev/openai/v1";
const KIMCHI_USER_AGENT = "kimchi/0.1.75";

const KIMCHI_MODELS: readonly ProviderModel[] = [
  modelOf("kimi-k2.7", "Kimi K2.7", capabilitiesOf({ surfaces: KIMCHI_SURFACES, reasoning: true, images: true })),
  modelOf("minimax-m3", "MiniMax M3", capabilitiesOf({ surfaces: KIMCHI_SURFACES, reasoning: true, images: true })),
  modelOf("deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: KIMCHI_SURFACES, reasoning: true, images: true })),
  modelOf("nemotron-3-ultra-fp4", "Nemotron 3 Ultra FP4", capabilitiesOf({ surfaces: KIMCHI_SURFACES, reasoning: true })),
];

const KIMCHI_FALLBACK_CAPABILITIES: ProviderCapabilities = capabilitiesOf({ surfaces: KIMCHI_SURFACES, reasoning: true, images: true });

function kimchiAccessToken(credential: string): string {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const access = (parsed as Record<string, unknown>).accessToken;
      if (typeof access === "string" && access.length > 0) return access;
    }
  } catch {
    // Treat malformed JSON as a raw API key so the upstream returns a typed auth error.
  }
  return trimmed;
}

/** Kimchi is a billed OpenAI-compatible Chat Completions gateway. */
export class KimchiAdapter implements ProviderAdapter {
  readonly metadata: ProviderMetadata = {
    id: "kimchi",
    displayName: "Kimchi",
    protocol: "openai",
    credentialKind: "oauth",
    credentialKinds: ["oauth", "api_key"],
  };
  readonly models: ProviderModelCatalog = createModelCatalog(KIMCHI_MODELS);
  readonly capabilities: ProviderCapabilities = {
    ...KIMCHI_FALLBACK_CAPABILITIES,
    streaming: true,
  };

  resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
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
    return { providerId: this.metadata.id, modelId, surface };
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
        message: "A Kimchi bearer credential is required.",
        statusCode: 401,
        routeScope: "account",
      });
    }
    const request = { ...input.request, model: input.target.modelId };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream,application/json",
      authorization: `Bearer ${kimchiAccessToken(input.credential)}`,
      "user-agent": KIMCHI_USER_AGENT,
    };
    return callChatCompletionsWire({ ...input, request, credential: input.credential }, KIMCHI_BASE_URL, headers);
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

export const kimchiModelCatalog = KIMCHI_MODELS;
