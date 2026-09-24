// Bespoke by wire protocol (Phase C4): the AgentRouter Claude CLI
// fingerprint — the `anthropic-beta` list, the Stainless identity headers,
// `x-app: cli`, and a per-request `x-claude-code-session-id` — is layered on
// top of the shared Claude Messages request. Projection, URL resolution, SSE
// decoding, and stop-reason mapping all come from the canonical pieces
// (`buildClaudeMessagesRequest` + `sendClaudeMessagesRequest`), matching the
// kimi and claude-code Messages adapters.
//
// The fingerprint cannot ride on the builder's `customHeaders`:
// `CLAUDE_EXTRA_PROTECTED_HEADERS` rejects `anthropic-beta`, `x-app`, the
// `x-stainless-*` family, `x-claude-code-session-id`, and `anthropic-version`
// for operator-supplied headers, so they are layered onto the built headers
// at this call site instead.
import { GatewayError } from "../../transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { readCredentialSecret, type ProviderDispatchTarget, type ProviderAdapter, type ProviderDispatchContext } from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";
import { buildClaudeMessagesRequest } from "./claude-messages";
import { sendClaudeMessagesRequest } from "../../protocol/transport/messages";

export const AGENTROUTER_PROVIDER_ID = "agentrouter" as const;
export const AGENTROUTER_BASE_URL = `${providerBaseUrl("agentrouter")}/v1/messages?beta=true`;

/**
 * The AgentRouter CLI fingerprint headers. Every value is part of the
 * provider's wire identity and must stay byte-identical. `content-type`,
 * `anthropic-version`, and `x-api-key` are already produced by
 * `buildClaudeMessagesRequest` with these same values and are therefore not
 * repeated here.
 */
function agentRouterFingerprintHeaders(stream: boolean): Record<string, string> {
  return {
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
  };
}

// AgentRouter model catalog.

import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";

export const AGENTROUTER_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "claude-sonnet-4-5",
    wireFamily: "messages",
    endpoint: "/v1/messages?beta=true",
    ctx: 200_000,
    out: 64_000,
    vision: true,
    reasoning: true,
    toolCall: true,
    webSearch: false,
  }),
];

interface AgentRouterAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class AgentRouterAdapter implements ProviderAdapter {
  readonly provider_id = AGENTROUTER_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: AgentRouterAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? AGENTROUTER_BASE_URL;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      throw new GatewayError("capability_unsupported", 400, `agentrouter supports messages only, got ${candidate.wire_family}`);
    }
    const apiKey = readCredentialSecret(context.credential, "AgentRouter API key is required");

    // Endpoint resolution stays provider-specific: an absolute candidate path
    // wins, a non-default path is appended to the origin with the Messages
    // beta, and the default keeps the `?beta=true` base URL. The resolved
    // absolute URL is handed to the shared builder, whose `endpointUrl`
    // returns absolute paths verbatim.
    const url =
      candidate.endpoint_path && candidate.endpoint_path.startsWith("http")
        ? candidate.endpoint_path
        : candidate.endpoint_path && candidate.endpoint_path.length > 0 && candidate.endpoint_path !== "/v1/messages" && candidate.endpoint_path !== "/v1/messages?beta=true"
          ? `${this.baseUrl.replace(/\?beta=true$/, "")}${candidate.endpoint_path.startsWith("/") ? candidate.endpoint_path : `/${candidate.endpoint_path}`}?beta=true`
          : this.baseUrl;

    const outbound = buildClaudeMessagesRequest({
      request,
      authHeader: "x-api-key",
      credential: { secret: apiKey },
      endpointPath: url,
      mutatePayload: (payload) => {
        payload["model"] = candidate.model_id || request.model;
        return payload;
      },
    });
    Object.assign(outbound.headers, agentRouterFingerprintHeaders(request.stream));

    yield* sendClaudeMessagesRequest(
      outbound.url,
      outbound.headers,
      outbound.body,
      context,
      request,
      this.fetchFn,
    );
  }
}

export function createAgentRouterAdapter(options: AgentRouterAdapterOptions = {}): ProviderAdapter {
  return new AgentRouterAdapter(options);
}
