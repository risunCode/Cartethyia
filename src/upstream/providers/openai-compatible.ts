import type { RouteTarget } from "../../routing/types";
import { decodeOpenAIChatStream } from "../bridge";
import { ProviderCallError } from "./index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./index";
import type { ModelCapability, ProviderModelCatalog, ProviderModelEntry } from "./models";

export interface OpenAICompatibleProviderConfig {
  id: Exclude<Provider["id"], "opencode-free" | "commandcode" | "kimchi" | "devin" | "qoder" | "custom" | "cursor" | "openai" | "anthropic" | "xmimo">;
  name: string;
  icon: string;
  baseUrl: string;
  credentialUrl: string;
  models: ProviderModelEntry[];
}

function passthroughCatalog(models: ProviderModelEntry[]): ProviderModelCatalog {
  const known = new Map(models.map((model) => [model.id, model]));
  const capabilities: ModelCapability[] = ["text", "vision", "reasoning", "tools", "streaming", "json"];

  return {
    list: () => models,
    resolve: (modelId) => known.get(modelId) ?? (modelId.trim() ? { id: modelId, capabilities } : undefined),
    hasCapability: (modelId, capability) => (known.get(modelId)?.capabilities ?? capabilities).includes(capability),
  };
}

function errorKind(status: number): "authentication" | "invalid_request" | "rate_limited" | "unavailable" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleProviderConfig): Provider {
  const models = passthroughCatalog(config.models);

  return {
    id: config.id,
    display: {
      name: config.name,
      icon: config.icon,
      authKind: "api-key",
      authHint: `Paste an API key from ${new URL(config.credentialUrl).hostname}.`,
      credentialUrl: config.credentialUrl,
    },
    models,
    resolveTarget(modelId: string): RouteTarget | undefined {
      if (!models.resolve(modelId)) return undefined;
      return { provider: config.id, modelId, surface: "openai-chat", credential: "provider-bearer", weight: 1 };
    },
    async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: string): Promise<ProviderResult> {
      if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", `${config.name} supports the OpenAI Chat shape.`);
      if (!credential.value) throw new ProviderCallError(401, "authentication", `${config.name} requires an API key.`);

      // request.body is already run through prepareOutboundRequest once, centrally,
      // by dispatchQualifiedRoute before any provider.call() is reached — re-running
      // it here would double-inject the system prompt / RTK-compress / filter-rule pass.
      const body = { ...request.body, model: target.modelId } as Record<string, unknown>;
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.value}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
        ...(proxy ? { proxy } : {}),
      });

      if (!response.ok) throw new ProviderCallError(response.status, errorKind(response.status), `${config.name} returned ${response.status}.`);
      if (!response.body) throw new ProviderCallError(502, "unavailable", `${config.name} returned an empty response body.`);
      if (body.stream === true) return { type: "stream", events: decodeOpenAIChatStream(response.body) };

      const json: unknown = await response.json();
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new ProviderCallError(502, "malformed_response", `${config.name} returned an unreadable JSON response.`);
      return { type: "json", body: json as Record<string, unknown> };
    },
  };
}
