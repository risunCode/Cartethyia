import type { RouteTarget } from "../../routing/types";
import { decodeResponsesStream } from "../bridge";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import { translateChatRequestToResponses, translateResponsesResponseToChat } from "../../translate/openai-responses";
import type { OpenAIChatRequest, OpenAIResponsesResponse } from "../../translate/types";
import { ProviderCallError } from "./errors";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./types";
import type { ProviderModelCatalog } from "./models";
import { callSimpleProvider } from "./simple-call";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_VERSION = "0.144.1";
const CODEX_MODELS = [
  { id: "gpt-5.6-sol", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000 },
  { id: "gpt-5.6-terra", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000 },
  { id: "gpt-5.6-luna", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000 },
  { id: "gpt-5.5", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000 },
  { id: "gpt-5.4-mini", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 128000 },
] as const;

const codexKnown = new Map<string, (typeof CODEX_MODELS)[number]>(CODEX_MODELS.map((model) => [model.id, model]));
const codexModels: ProviderModelCatalog = {
  list: () => [...CODEX_MODELS],
  resolve: (modelId) => codexKnown.get(modelId) ?? (modelId.trim() ? { id: modelId } : undefined),
};

class CodexProvider implements Provider {
  readonly id = "openai-codex" as const;
  readonly display = {
    name: "OpenAI Codex",
    icon: "openai",
    authKind: "oauth" as const,
    authHint: "Connect a ChatGPT account with OAuth Authorization Code + PKCE.",
    credentialUrl: "https://developers.openai.com/codex/auth",
  };
  readonly models = codexModels;

  resolveTarget(modelId: string): RouteTarget | undefined {
    if (!this.models.resolve(modelId)) return undefined;
    return { provider: this.id, modelId, surface: "openai-chat", credential: "oauth", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Codex currently accepts the OpenAI Chat shape.");
    if (credential.kind !== "oauth" || !credential.value) throw new ProviderCallError(401, "authentication", "Codex requires an OAuth credential.");
    const chatBody = { ...request.body, model: target.modelId } as OpenAIChatRequest;
    chatBody.messages = chatBody.messages.map((message) => message.role === "system" ? { ...message, role: "developer" } : message);
    const responsesBody = translateChatRequestToResponses(chatBody);
    responsesBody.store = false;
    responsesBody.stream = true;
    const accountId = credential.providerMetadata?.chatgptAccountId;
    if (!accountId) throw new ProviderCallError(401, "authentication", "Codex OAuth credential is missing its ChatGPT account identity.");

    return callSimpleProvider({
      url: `${CODEX_BASE_URL}/codex/responses`,
      headers: {
        authorization: `Bearer ${credential.value}`,
        "chatgpt-account-id": accountId,
        "openai-beta": "responses=experimental",
        originator: "pi",
        version: CODEX_VERSION,
        "user-agent": `cartethyia/${CODEX_VERSION}`,
        accept: responsesBody.stream === true ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: responsesBody,
      signal,
      providerLabel: "OpenAI Codex",
      isStreaming: responsesBody.stream === true,
      decodeStream: decodeResponsesStream,
      translateJson: (json) => translateResponsesResponseToChat(json as unknown as OpenAIResponsesResponse) as unknown as Record<string, unknown>,
      fetcher: proxy ? buildProxyFetcher(proxy) : undefined,
    });
  }
}

export const codexProvider = new CodexProvider();
