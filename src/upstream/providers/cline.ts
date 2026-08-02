import type { RouteTarget } from "../../routing/types";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import { decodeOpenAIChatStream } from "../bridge";
import { ProviderCallError } from "./errors";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./types";
import { callSimpleProvider } from "./simple-call";
import { createModelCatalog } from "./models";
import { DEFAULT_RETRY_CONFIG, withRetry } from "../retry";

const CLINE_CHAT_URL = "https://api.cline.bot/api/v1/chat/completions";
const CLINE_MODELS = createModelCatalog([
  { id: "deepseek/deepseek-v4-flash", reasoning: true, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { id: "z-ai/glm-5.2", reasoning: true, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { id: "openai/gpt-5.6-sol-pro", reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: "openai/gpt-5.6-sol", reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: "openai/gpt-5.6-terra-pro", reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: "openai/gpt-5.6-terra", reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: "openai/gpt-5.6-luna-pro", reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: "openai/gpt-5.6-luna", reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: "minimax/minimax-m2.5", reasoning: true, contextWindow: 196_608, maxOutputTokens: 32_768 },
  { id: "google/gemini-3.1-flash-lite-preview", contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: "kwaipilot/kat-coder-pro-v2", reasoning: true, contextWindow: 131_072, maxOutputTokens: 32_768 },
]);

function unwrapClineResponse(json: Record<string, unknown>): Record<string, unknown> {
  const data = json.data;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : json;
}

function ensureClineSystemMessage(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const hasSystemMessage = messages.some((message) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
    const role = (message as Record<string, unknown>).role;
    return role === "system" || role === "developer";
  });
  if (hasSystemMessage) return body;
  return {
    ...body,
    messages: [{ role: "system", content: "Answer directly in 2-4 sentences. Do not explain your reasoning." }, ...messages],
  };
}

class ClineProvider implements Provider {
  readonly id = "cline" as const;
  readonly display = {
    name: "Cline",
    icon: "cline",
    authKind: "oauth" as const,
    authHint: "Connect your Cline account with OAuth Authorization Code flow.",
    credentialUrl: "https://app.cline.bot",
  };
  readonly models = CLINE_MODELS;

  resolveTarget(modelId: string): RouteTarget | undefined {
    if (!this.models.resolve(modelId)) return undefined;
    return { provider: this.id, modelId, surface: "openai-chat", credential: "oauth", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Cline supports the OpenAI Chat shape.");
    if (credential.kind !== "oauth" || !credential.value) throw new ProviderCallError(401, "authentication", "Cline requires an OAuth credential.");
    const token = credential.value.startsWith("workos:") ? credential.value : `workos:${credential.value}`;
    const body = ensureClineSystemMessage({
      ...request.body,
      model: target.modelId,
      stream: request.body.stream === true,
    });
    const call = () => callSimpleProvider({
      url: CLINE_CHAT_URL,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        "http-referer": "https://cline.bot",
        "x-title": "Cline",
        "x-platform": "server",
        "x-platform-version": "1.0.0",
        "x-client-type": "cline-cli",
        "x-client-version": "4.0.11",
        "x-core-version": "4.0.11",
        "x-is-multi-root": "false",
        "user-agent": "Cline/4.0.11",
      },
      body,
      signal,
      providerLabel: "Cline",
      isStreaming: body.stream === true,
      decodeStream: decodeOpenAIChatStream,
      translateJson: unwrapClineResponse,
      fetcher: proxy ? buildProxyFetcher(proxy) : undefined,
    });
    return withRetry(
      call,
      { ...DEFAULT_RETRY_CONFIG, maxRetries: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
      undefined,
      (error) => error instanceof ProviderCallError && error.status === 500 && /empty response content/i.test(error.message),
    );
  }
}

export const clineProvider = new ClineProvider();
