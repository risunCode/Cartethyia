import type { RouteTarget } from "../../routing/types";
import { decodeOpenAIChatStream } from "../bridge";
import { ProviderCallError } from "./index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./index";
import { callSimpleProvider } from "./simple-call";
import { createModelCatalog } from "./models";
import type { ProviderModelCatalog, ProviderModelEntry } from "./models";

export interface OpenAICompatibleProviderConfig {
  id: Exclude<Provider["id"], "opencode-free" | "commandcode" | "kimchi" | "devin" | "qoder" | "custom" | "cursor" | "anthropic">;
  name: string;
  icon: string;
  baseUrl: string;
  credentialUrl: string;
  models: ProviderModelEntry[];
  /** Override the generated "Paste an API key from {host}." auth hint with custom copy. */
  authHint?: string;
  /**
   * Gate routing to exactly the curated `models` list (via the shared
   * strict `createModelCatalog`) instead of accepting any non-blank model
   * id. Used by providers whose curated list is an intentional allowlist,
   * not just a display sample of a larger open catalog.
   */
  strict?: boolean;
}

function passthroughCatalog(models: ProviderModelEntry[]): ProviderModelCatalog {
  const known = new Map(models.map((model) => [model.id, model]));

  // Any non-blank model id routes (the vendor's own /models endpoint is the
  // real gate); an id outside the curated list just has no known vision flag.
  return {
    list: () => models,
    resolve: (modelId) => known.get(modelId) ?? (modelId.trim() ? { id: modelId } : undefined),
  };
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleProviderConfig): Provider {
  const models = config.strict ? createModelCatalog(config.models) : passthroughCatalog(config.models);

  return {
    id: config.id,
    display: {
      name: config.name,
      icon: config.icon,
      authKind: "api-key",
      authHint: config.authHint ?? `Paste an API key from ${new URL(config.credentialUrl).hostname}.`,
      credentialUrl: config.credentialUrl,
    },
    models,
    resolveTarget(modelId: string): RouteTarget | undefined {
      if (!models.resolve(modelId)) return undefined;
      return { provider: config.id, modelId, surface: "openai-chat", credential: "provider-bearer", weight: 1 };
    },
    async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal): Promise<ProviderResult> {
      if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", `${config.name} supports the OpenAI Chat shape.`);
      if (!credential.value) throw new ProviderCallError(401, "authentication", `${config.name} requires an API key.`);

      const body = { ...request.body, model: target.modelId } as Record<string, unknown>;
      return callSimpleProvider({
        url: `${config.baseUrl}/chat/completions`,
        headers: { authorization: `Bearer ${credential.value}`, "content-type": "application/json" },
        body,
        signal,
        providerLabel: config.name,
        isStreaming: body.stream === true,
        decodeStream: decodeOpenAIChatStream,
      });
    },
  };
}
