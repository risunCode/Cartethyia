import { ProviderAdapterError, toProviderCallError } from "../open-sse/transport/errors";
import { capabilitiesOf, createModelCatalog } from "../open-sse/transport/catalog";
import { callChatCompletionsWire } from "../open-sse/transport/protocols/openai";
import type {
  Adapter,
  ProviderCaps,
  ProviderMeta,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  Surface,
  RouteTarget,
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";

const CLOUDFLARE_SURFACES: readonly Surface[] = ["openai-chat"];
const CLOUDFLARE_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: CLOUDFLARE_SURFACES, reasoning: true, images: false });
const CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4/accounts";

interface CloudflareCredential {
  readonly apiKey: string;
  readonly accountId: string;
}

function parseCredential(value: string): CloudflareCredential {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid object");
    const record = parsed as Record<string, unknown>;
    if (typeof record.apiKey !== "string" || record.apiKey.trim().length === 0) throw new Error("missing api key");
    if (typeof record.accountId !== "string" || !/^[a-f0-9]{32}$/i.test(record.accountId.trim())) throw new Error("invalid account id");
    return { apiKey: record.apiKey.trim(), accountId: record.accountId.trim() };
  } catch {
    throw new ProviderAdapterError({
      kind: "authentication_failed",
      message: "Cloudflare requires a JSON credential with apiKey and a 32-character accountId.",
      statusCode: 401,
      routeScope: "account",
    });
  }
}

/** Cloudflare Workers AI OpenAI-compatible account endpoint. */
export class CloudflareAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "cloudflare",
    displayName: "Cloudflare Workers AI",
    protocol: "openai",
    credentialKind: "api_key",
    credentialUrl: "https://dash.cloudflare.com/profile/api-tokens",
  };
  readonly capabilities: ProviderCaps = CLOUDFLARE_CAPABILITIES;
  readonly models: ProviderModelCatalog = createModelCatalog([]);

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "openai-chat") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    }
    const credential = parseCredential(input.credential);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: input.request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${credential.apiKey}`,
    };
    return callChatCompletionsWire(input, `${CLOUDFLARE_BASE_URL}/${credential.accountId}/ai/v1`, headers);
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}
