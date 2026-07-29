/**
 * OpenAI — built-in API-key provider (BYOK, official api.openai.com). Body is
 * already OpenAI Chat-shaped by the time it reaches a provider, so this is a
 * near-direct forward, matching the console's "API Key Providers" section
 * (see 9router's own OpenAI/Anthropic entries).
 */

import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { decodeOpenAIChatStream } from "../../bridge";
import { openaiModelCatalog } from "./models";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

function upstreamErrorKind(status: number): "authentication" | "invalid_request" | "rate_limited" | "unavailable" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

class OpenAIProvider implements Provider {
  readonly id = "openai" as const;
  readonly display = {
    name: "OpenAI",
    icon: "openai",
    authKind: "api-key" as const,
    authHint: "Paste your official OpenAI API key (starts with sk-...) from platform.openai.com.",
    credentialUrl: "https://platform.openai.com/api-keys",
  };
  readonly models = openaiModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    return { provider: "openai", modelId, surface: "openai-chat", credential: "provider-bearer", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: string): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "OpenAI currently supports the OpenAI Chat shape.");
    if (!credential.value) throw new ProviderCallError(401, "authentication", "OpenAI requires an API key.");

    // request.body already went through prepareOutboundRequest once, centrally, in
    // dispatchQualifiedRoute — re-applying it here would double-inject the system
    // prompt / RTK-compress twice / re-run filter rules on already-replaced text.
    const outboundBody = { ...request.body, model: target.modelId } as Record<string, unknown>;
    const isStreaming = outboundBody.stream === true;

    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.value}`, "content-type": "application/json" },
      body: JSON.stringify(outboundBody),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) throw new ProviderCallError(res.status, upstreamErrorKind(res.status), `OpenAI returned ${res.status}.`);
    if (!res.body) throw new ProviderCallError(502, "unavailable", "OpenAI returned an empty response body.");

    if (isStreaming) return { type: "stream", events: decodeOpenAIChatStream(res.body) };

    const jsonBody: unknown = await res.json();
    if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
      throw new ProviderCallError(502, "malformed_response", "OpenAI returned an unreadable JSON response.");
    }
    return { type: "json", body: jsonBody as Record<string, unknown> };
  }
}

export const openaiProvider = new OpenAIProvider();
