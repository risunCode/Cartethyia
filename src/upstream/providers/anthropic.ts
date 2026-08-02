/**
 * Anthropic — built-in API-key provider (BYOK, official api.anthropic.com).
 * The dispatch pipeline always hands providers an OpenAI Chat-shaped body,
 * so this translates to Anthropic's native Messages shape before forwarding
 * and back on the way out — the same translators `routes/messages.ts` and
 * `routes/responses.ts` already use for their Anthropic fallback paths.
 */

import type { RouteTarget } from "../../routing/types";
import { ProviderCallError } from "./index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./index";
import { decodeAnthropicStream } from "../bridge";
import { callSimpleProvider } from "./simple-call";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import { translateAnthropicResponseToChat, translateChatRequestToAnthropic } from "../../translate/openai-anthropic";
import type { AnthropicResponse, OpenAIChatRequest } from "../../translate/types";
import { anthropicModelCatalog } from "./anthropic-models";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  readonly display = {
    name: "Anthropic",
    icon: "anthropic",
    authKind: "api-key" as const,
    authHint: "Paste your official Anthropic API key (starts with sk-ant-...) from console.anthropic.com.",
    credentialUrl: "https://console.anthropic.com/settings/keys",
  };
  readonly models = anthropicModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    return { provider: "anthropic", modelId, surface: "openai-chat", credential: "provider-bearer", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Anthropic currently supports the OpenAI Chat shape.");
    if (!credential.value) throw new ProviderCallError(401, "authentication", "Anthropic requires an API key.");

    const chatBody = { ...request.body, model: target.modelId };
    const anthropicReq = translateChatRequestToAnthropic(chatBody as OpenAIChatRequest);

    return callSimpleProvider({
      url: `${ANTHROPIC_BASE_URL}/messages`,
      headers: { "x-api-key": credential.value, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: anthropicReq,
      signal,
      providerLabel: "Anthropic",
      isStreaming: anthropicReq.stream === true,
      decodeStream: decodeAnthropicStream,
      translateJson: (json) => translateAnthropicResponseToChat(json as unknown as AnthropicResponse) as unknown as Record<string, unknown>,
      fetcher: proxy ? buildProxyFetcher(proxy) : undefined,
    });
  }

  async countTokens(target: RouteTarget, body: Record<string, unknown>, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<{ inputTokens: number }> {
    if (!credential.value) throw new ProviderCallError(401, "authentication", "Anthropic requires an API key.");

    // count_tokens is Anthropic's own native shape end to end - the caller
    // already sends `model`/`messages`/`system`/`tools`/`tool_choice` as-is,
    // no Chat<->Anthropic translation needed. `stream`/`max_tokens` have no
    // meaning for this endpoint (it never generates anything) and Anthropic
    // rejects unrecognized fields on some accounts, so they're stripped.
    const { stream: _stream, max_tokens: _maxTokens, ...rest } = body;
    const outbound = { ...rest, model: target.modelId };

    const result = await callSimpleProvider({
      url: `${ANTHROPIC_BASE_URL}/messages/count_tokens`,
      headers: { "x-api-key": credential.value, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: outbound,
      signal,
      providerLabel: "Anthropic",
      isStreaming: false,
      // count_tokens has no streaming variant - decodeStream is required by
      // the shared helper's type but is never invoked for a non-streaming call.
      decodeStream: decodeAnthropicStream,
      fetcher: proxy ? buildProxyFetcher(proxy) : undefined,
    });
    const json = result.type === "json" ? result.body : {};
    const inputTokens = typeof json.input_tokens === "number" ? json.input_tokens : 0;
    return { inputTokens };
  }
}

export const anthropicProvider = new AnthropicProvider();
