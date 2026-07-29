/**
 * AgentRouter — free-credits ($200 on signup) multi-model gateway speaking
 * native Anthropic Messages. Gates on client identity: it only accepts
 * requests that look like the real Claude Code CLI, so every header below
 * (User-Agent, Stainless fingerprint, beta flags, session id) is required,
 * not cosmetic — dropping any of them gets requests rejected upstream.
 * @see https://agentrouter.org
 */

import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { decodeAnthropicStream } from "../../bridge";
import { translateAnthropicResponseToChat, translateChatRequestToAnthropic } from "../../../translate/openai-anthropic";
import type { AnthropicResponse, OpenAIChatRequest } from "../../../translate/types";
import { agentRouterModelCatalog } from "./models";

const AGENTROUTER_URL = "https://agentrouter.org/v1/messages?beta=true";

// Field order AgentRouter's client-identity check expects a genuine Claude
// Code CLI request body to arrive in.
const BODY_FIELD_ORDER = ["model", "messages", "system", "tools", "tool_choice", "metadata", "max_tokens", "thinking", "output_config", "stream"] as const;

function reorderBody(body: Record<string, unknown>): Record<string, unknown> {
  const reordered: Record<string, unknown> = {};
  const remaining = new Set(Object.keys(body));
  for (const key of BODY_FIELD_ORDER) {
    if (key in body) {
      reordered[key] = body[key];
      remaining.delete(key);
    }
  }
  for (const key of remaining) reordered[key] = body[key];
  return reordered;
}

function buildHeaders(apiKey: string, stream: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": "claude-cli/2.1.195 (external, sdk-cli)",
    "x-claude-code-session-id": crypto.randomUUID(),
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "0.94.0",
    "x-stainless-os": "MacOS",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    accept: stream ? "text/event-stream" : "application/json",
    "accept-encoding": "gzip, deflate, br, zstd",
    "x-api-key": apiKey,
  };
}

function upstreamErrorKind(status: number): "authentication" | "invalid_request" | "rate_limited" | "unavailable" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

class AgentRouterProvider implements Provider {
  readonly id = "agentrouter" as const;
  readonly display = {
    name: "AgentRouter",
    icon: "agentrouter",
    authKind: "api-key" as const,
    authHint: "Sign up at agentrouter.org for $200 in free credits (no card required), then paste your API key.",
    credentialUrl: "https://agentrouter.org/register",
  };
  readonly models = agentRouterModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    return { provider: "agentrouter", modelId, surface: "openai-chat", credential: "provider-bearer", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: string): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "AgentRouter currently supports the OpenAI Chat shape.");
    if (!credential.value) throw new ProviderCallError(401, "authentication", "AgentRouter requires an API key.");

    const chatBody = { ...request.body, model: target.modelId };
    const anthropicReq = reorderBody(translateChatRequestToAnthropic(chatBody as OpenAIChatRequest) as unknown as Record<string, unknown>);
    const isStreaming = anthropicReq.stream === true;

    const res = await fetch(AGENTROUTER_URL, {
      method: "POST",
      headers: buildHeaders(credential.value, isStreaming),
      body: JSON.stringify(anthropicReq),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) throw new ProviderCallError(res.status, upstreamErrorKind(res.status), `AgentRouter returned ${res.status}.`);
    if (!res.body) throw new ProviderCallError(502, "unavailable", "AgentRouter returned an empty response body.");

    if (isStreaming) return { type: "stream", events: decodeAnthropicStream(res.body) };

    const jsonBody: unknown = await res.json();
    if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
      throw new ProviderCallError(502, "malformed_response", "AgentRouter returned an unreadable JSON response.");
    }
    return { type: "json", body: translateAnthropicResponseToChat(jsonBody as AnthropicResponse) as unknown as Record<string, unknown> };
  }
}

export const agentRouterProvider = new AgentRouterProvider();
