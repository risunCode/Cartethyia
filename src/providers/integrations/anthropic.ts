/**
 * Anthropic (API-key). Plain `/v1/messages` traffic against the public
 * Anthropic API using an operator-owned `x-api-key`. No [CC] CLI
 * impersonation, no CCH billing header, no beta-feature negotiation beyond
 * passthrough — those exist purely for the OAuth [CC] adapter and have
 * no business running for a caller presenting a real API key.
 *
 * Model catalog is declared in code (not DB-seeded) — see the
 * `ModelDefinition` doc comment in `providers/contracts.ts`.
 *
 * Factory-blocked (Phase C4): Anthropic Messages envelope
 * (`canonicalToClaudeMessagesPayload` + Messages SSE decode) — non-OpenAI
 * wire the factory cannot serialize; stays bespoke.
 */
import type { ModelDefinition } from "../provider-registry";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { GatewayError } from "../../transport/gateway-error";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "./claude-messages";
import { sendClaudeMessagesRequest } from "../../protocol/transport/messages";
import { applyParamQuirks } from "../../transport/translation/quirks";
import type {
  ProviderDispatchTarget,
  ProviderAdapter,
  ProviderDispatchContext,
} from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";

/** Construction options for the plain Anthropic API-key adapter. */
interface AnthropicAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly base_url?: string;
  readonly custom_headers?: Readonly<Record<string, unknown>>;
}

/**
 * Plain Anthropic API-key Messages adapter. Rejects every non-`api_key`
 * credential kind at the dispatch boundary so operator-owned traffic can
 * never share the same fetch as [CC] OAuth impersonation.
 */
export class AnthropicApiKeyAdapter implements ProviderAdapter {
  readonly provider_id = "anthropic" as const;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string | undefined;
  private readonly customHeaders: Readonly<Record<string, unknown>> | undefined;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.base_url;
    this.customHeaders = options.custom_headers;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        "anthropic supports messages only",
      );
    }
    if (context.credential.credential_kind !== "api_key") {
      throw new GatewayError(
        "invalid_request",
        400,
        `anthropic: x-api-key credential required (got credential_kind=${context.credential.credential_kind})`,
      );
    }
    if (
      context.credential.secret === undefined ||
      context.credential.secret.length === 0
    ) {
      throw new GatewayError(
        "invalid_request",
        400,
        "anthropic: API key is missing a secret value",
      );
    }
    const apiKey = new TextDecoder().decode(context.credential.secret);
    const customHeaders = filterClaudeCustomHeaders({
      ...this.customHeaders,
      ...context.credential.custom_headers,
    });
    const outbound = buildClaudeMessagesRequest({
      request: applyParamQuirks(request, candidate.provider_id),
      authHeader: "x-api-key",
      credential: {
        secret: apiKey,
        // Anthropic's browser-CORS opt-in; operator overrides still win
        // because the credential headers spread after it.
        customHeaders: {
          "anthropic-dangerous-direct-browser-access": "true",
          ...customHeaders,
        },
      },
      baseUrl: this.baseUrl,
      endpointPath: candidate.endpoint_path,
    });
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

export function createAnthropicAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new AnthropicApiKeyAdapter({
    base_url: providerBaseUrl("anthropic"),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

import { defineModel } from "../model-definition";

export const ANTHROPIC_MODELS: readonly ModelDefinition[] = [
  // Current-generation SKUs and limits: the 5-series ships at 1M/128k,
  // opus-4-5 is a 200k/64k budget-era row, and haiku-4-5 keeps its 200k window.
  defineModel({ id: "claude-mythos-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-mythos-5-1", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-5-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-4-6", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-sonnet-4-6", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-4-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 200000, out: 64000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-haiku-4-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 200000, out: 64000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-3-5-haiku", wireFamily: "messages", endpoint: "/v1/messages", ctx: 200000, out: 64000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-3-7-sonnet", wireFamily: "messages", endpoint: "/v1/messages", ctx: 200000, out: 64000, vision: true, reasoning: true, webSearch: true }),
];

