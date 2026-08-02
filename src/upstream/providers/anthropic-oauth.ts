import type { RouteTarget } from "../../routing/types";
import { decodeAnthropicStream } from "../bridge";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import { translateAnthropicResponseToChat, translateChatRequestToAnthropic } from "../../translate/openai-anthropic";
import type { AnthropicResponse, OpenAIChatRequest } from "../../translate/types";
import { ProviderCallError } from "./errors";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./types";
import { anthropicModelCatalog } from "./anthropic-models";
import { callSimpleProvider } from "./simple-call";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27"].join(",");

class AnthropicOAuthProvider implements Provider {
  readonly id = "anthropic-oauth" as const;
  readonly display = {
    name: "Claude Code",
    icon: "claude-code",
    authKind: "oauth" as const,
    authHint: "Connect your Claude Code account with OAuth Authorization Code + PKCE.",
    credentialUrl: "https://docs.anthropic.com/en/docs/claude-code/iam",
  };
  readonly models = anthropicModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    if (!this.models.resolve(modelId)) return undefined;
    return { provider: this.id, modelId, surface: "openai-chat", credential: "oauth", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Anthropic OAuth currently accepts the OpenAI Chat shape.");
    if (credential.kind !== "oauth" || !credential.value) throw new ProviderCallError(401, "authentication", "Claude Code requires an OAuth credential.");
    const chatBody = { ...request.body, model: target.modelId } as OpenAIChatRequest;
    const anthropicReq = translateChatRequestToAnthropic(chatBody);
    return callSimpleProvider({
      url: `${ANTHROPIC_BASE_URL}/messages`,
      headers: {
        authorization: `Bearer ${credential.value}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA,
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": "claude-code/1.0.0",
        "x-app": "cli",
        "content-type": "application/json",
      },
      body: anthropicReq,
      signal,
      providerLabel: "Claude Code",
      isStreaming: anthropicReq.stream === true,
      decodeStream: decodeAnthropicStream,
      translateJson: (json) => translateAnthropicResponseToChat(json as unknown as AnthropicResponse) as unknown as Record<string, unknown>,
      fetcher: proxy ? buildProxyFetcher(proxy) : undefined,
    });
  }
}

export const anthropicOAuthProvider = new AnthropicOAuthProvider();
