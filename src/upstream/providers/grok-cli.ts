import type { RouteTarget } from "../../routing/types";
import { decodeResponsesStream } from "../bridge";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import { translateChatRequestToResponses, translateResponsesResponseToChat } from "../../translate/openai-responses";
import type { OpenAIChatRequest, OpenAIResponsesResponse } from "../../translate/types";
import { ProviderCallError } from "./errors";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./types";
import type { ProviderModelCatalog, ProviderModelEntry } from "./models";
import { callSimpleProvider } from "./simple-call";

const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLI_VERSION = "0.2.99";
const GROK_CLI_IDENTIFIER = "grok-shell";
const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

const GROK_MODELS: ProviderModelEntry[] = [
  { id: "grok-4.5", reasoning: true, websearch: true, contextWindow: 400_000, maxOutputTokens: 64_000 },
  { id: "grok-4.5-high", reasoning: true, websearch: true, contextWindow: 400_000, maxOutputTokens: 64_000 },
  { id: "grok-4.5-medium", reasoning: true, websearch: true, contextWindow: 400_000, maxOutputTokens: 64_000 },
  { id: "grok-4.5-low", reasoning: true, websearch: true, contextWindow: 400_000, maxOutputTokens: 64_000 },
];

const grokKnown = new Map(GROK_MODELS.map((model) => [model.id, model]));
const grokModels: ProviderModelCatalog = {
  list: () => [...GROK_MODELS],
  resolve: (modelId) => grokKnown.get(modelId) ?? (modelId.trim() ? { id: modelId, reasoning: true, websearch: true } : undefined),
};

function wantsWebSearch(body: Record<string, unknown>): boolean {
  if (body.web_search_options !== undefined) return true;
  const tools = body.tools;
  return Array.isArray(tools) && tools.some((tool) => {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return false;
    const type = (tool as Record<string, unknown>).type;
    return type === "web_search" || type === "web_search_preview";
  });
}

function webSearchFilters(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const options = body.web_search_options;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  const source = options as Record<string, unknown>;
  const filters = source.filters;
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return undefined;
  const allowed = (filters as Record<string, unknown>).allowed_domains;
  const excluded = (filters as Record<string, unknown>).excluded_domains;
  if (!Array.isArray(allowed) && !Array.isArray(excluded)) return undefined;
  return {
    ...(Array.isArray(allowed) ? { allowed_domains: allowed.filter((value): value is string => typeof value === "string").slice(0, 5) } : {}),
    ...(Array.isArray(excluded) ? { excluded_domains: excluded.filter((value): value is string => typeof value === "string").slice(0, 5) } : {}),
  };
}

function modelEffort(modelId: string): string | undefined {
  const match = modelId.match(/-(low|medium|high|xhigh)$/);
  return match?.[1];
}

class GrokCliProvider implements Provider {
  readonly id = "grok-cli" as const;
  readonly display = {
    name: "Grok CLI",
    icon: "grok",
    authKind: "oauth" as const,
    authHint: "Connect a SuperGrok or X Premium Plus account with xAI OAuth.",
    credentialUrl: "https://grok.com/",
  };
  readonly models = grokModels;

  resolveTarget(modelId: string): RouteTarget | undefined {
    if (!this.models.resolve(modelId)) return undefined;
    return { provider: this.id, modelId, surface: "openai-chat", credential: "oauth", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Grok CLI currently accepts the OpenAI Chat shape.");
    if (credential.kind !== "oauth" || !credential.value) throw new ProviderCallError(401, "authentication", "Grok CLI requires an OAuth credential.");

    const chatBody = { ...request.body, model: target.modelId } as OpenAIChatRequest;
    const responsesBody = translateChatRequestToResponses(chatBody) as Record<string, unknown>;
    responsesBody.store = false;
    responsesBody.stream = true;
    const modelEffortValue = modelEffort(target.modelId);
    const upstreamModel = modelEffortValue ? target.modelId.slice(0, -(modelEffortValue.length + 1)) : target.modelId;
    responsesBody.model = upstreamModel;
    const input = responsesBody.input;
    if (Array.isArray(input)) {
      for (const item of input) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (record.role === "developer") record.role = "system";
      }
    }
    const supportsReasoningEffort = !upstreamModel.includes("composer");
    responsesBody.reasoning = supportsReasoningEffort && modelEffortValue
      ? { effort: modelEffortValue, summary: "concise" }
      : { summary: "concise" };
    if (supportsReasoningEffort) responsesBody.include = ["reasoning.encrypted_content"];

    if (wantsWebSearch(request.body)) {
      const existingTools = Array.isArray(responsesBody.tools) ? responsesBody.tools : [];
      const filters = webSearchFilters(request.body);
      responsesBody.tools = [...existingTools, { type: "web_search", ...(filters ? { filters } : {}) }];
    }

    const metadata = credential.providerMetadata ?? {};
    const sessionId = credential.accountId ?? crypto.randomUUID();
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.value}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": GROK_CLI_USER_AGENT,
      "x-grok-client-identifier": GROK_CLI_IDENTIFIER,
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-grok-session-id": sessionId,
      "x-grok-conv-id": sessionId,
      "x-grok-req-id": crypto.randomUUID(),
      "x-grok-turn-idx": "1",
    };
    if (metadata.email) headers["x-email"] = metadata.email;
    if (metadata.userId) headers["x-userid"] = metadata.userId;
    if (metadata.deviceId || metadata.agentId) headers["x-grok-agent-id"] = metadata.deviceId ?? metadata.agentId ?? "";
    headers["x-grok-model-override"] = upstreamModel;

    return callSimpleProvider({
      url: `${GROK_CLI_BASE_URL}/responses`,
      headers,
      body: responsesBody,
      signal,
      providerLabel: "Grok CLI",
      isStreaming: true,
      decodeStream: decodeResponsesStream,
      translateJson: (json) => translateResponsesResponseToChat(json as unknown as OpenAIResponsesResponse) as unknown as Record<string, unknown>,
      fetcher: proxy ? buildProxyFetcher(proxy) : undefined,
    });
  }
}

export const grokCliProvider = new GrokCliProvider();
