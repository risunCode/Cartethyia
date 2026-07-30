/**
 * Anthropic — built-in API-key provider (BYOK, official api.anthropic.com).
 * The dispatch pipeline always hands providers an OpenAI Chat-shaped body,
 * so this translates to Anthropic's native Messages shape before forwarding
 * and back on the way out — the same translators `routes/messages.ts` and
 * `routes/responses.ts` already use for their Anthropic fallback paths.
 */

import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError, classifyUpstreamStatus } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { decodeAnthropicStream } from "../../bridge";
import { translateAnthropicResponseToChat, translateChatRequestToAnthropic } from "../../../translate/openai-anthropic";
import type { AnthropicResponse, OpenAIChatRequest } from "../../../translate/types";
import { anthropicModelCatalog } from "./models";

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

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: string): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Anthropic currently supports the OpenAI Chat shape.");
    if (!credential.value) throw new ProviderCallError(401, "authentication", "Anthropic requires an API key.");

    // request.body already went through prepareOutboundRequest once, centrally, in
    // dispatchQualifiedRoute — re-applying it here would double-inject the system
    // prompt / RTK-compress twice / re-run filter rules on already-replaced text.
    const chatBody = { ...request.body, model: target.modelId };
    const anthropicReq = translateChatRequestToAnthropic(chatBody as OpenAIChatRequest);
    const isStreaming = anthropicReq.stream === true;

    const res = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
      method: "POST",
      headers: { "x-api-key": credential.value, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify(anthropicReq),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) throw new ProviderCallError(res.status, classifyUpstreamStatus(res.status), `Anthropic returned ${res.status}.`);
    if (!res.body) throw new ProviderCallError(502, "unavailable", "Anthropic returned an empty response body.");

    if (isStreaming) return { type: "stream", events: decodeAnthropicStream(res.body) };

    const jsonBody: unknown = await res.json();
    if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
      throw new ProviderCallError(502, "malformed_response", "Anthropic returned an unreadable JSON response.");
    }
    return { type: "json", body: translateAnthropicResponseToChat(jsonBody as AnthropicResponse) as unknown as Record<string, unknown> };
  }
}

export const anthropicProvider = new AnthropicProvider();
