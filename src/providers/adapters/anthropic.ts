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
import type { ModelDefinition } from "../model-definition";
import type { CanonicalEvent, CanonicalRequest } from "../../protocol/canonical-model";
import { GatewayError } from "../../protocol/gateway-error";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "../integrations/shared/claude-messages";
import { sendClaudeMessagesRequest } from "../../protocol/upstream/send-claude-messages";
import { applyParamQuirks } from "../../transport/translation/quirks";
import type { ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext, ProviderId } from "../contracts";
import { providerBaseUrl } from "../metadata";

/** Construction options for the plain Anthropic API-key adapter. */
interface AnthropicAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly base_url?: string;
  readonly custom_headers?: Readonly<Record<string, unknown>>;
  /**
   * Provider this adapter serves. Defaults to `anthropic`; an Anthropic-compatible
   * upstream on its own host (DeepSeek's `/anthropic` surface) passes its own id
   * so the registry's identity check holds and per-provider quirks resolve.
   */
  readonly provider_id?: ProviderId;
}

/**
 * Plain Anthropic API-key Messages adapter. Rejects every non-`api_key`
 * credential kind at the dispatch boundary so operator-owned traffic can
 * never share the same fetch as [CC] OAuth impersonation.
 */
export class AnthropicApiKeyAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string | undefined;
  private readonly customHeaders: Readonly<Record<string, unknown>> | undefined;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.base_url;
    this.customHeaders = options.custom_headers;
    this.provider_id = options.provider_id ?? ("anthropic" as const);
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
        `${this.provider_id} supports messages only`,
      );
    }
    if (context.credential.credential_kind !== "api_key") {
      throw new GatewayError(
        "invalid_request",
        400,
        `${this.provider_id}: x-api-key credential required (got credential_kind=${context.credential.credential_kind})`,
      );
    }
    if (
      context.credential.secret === undefined ||
      context.credential.secret.length === 0
    ) {
      throw new GatewayError(
        "invalid_request",
        400,
        `${this.provider_id}: API key is missing a secret value`,
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

/**
 * Builds the Messages adapter for an Anthropic-compatible provider that is not
 * itself `anthropic` — DeepSeek's `/anthropic` surface, for instance. The id and
 * base URL are explicit because this adapter serves a provider's own host, and
 * `assertAdapterIdentity` in the registry requires the adapter to report the id
 * it was registered under.
 */
export function createAnthropicCompatibleAdapter(options: {
  readonly provider_id: ProviderId;
  readonly base_url: string;
  readonly fetch?: typeof fetch;
}): ProviderAdapter {
  return new AnthropicApiKeyAdapter({
    provider_id: options.provider_id,
    base_url: options.base_url,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/**
 * DeepSeek's Messages models are served through DeepSeek's own Anthropic-
 * compatible host, which speaks the `messages` wire (not the OpenAI chat wire it
 * also serves). The base URL carries the `/anthropic` root because the wire
 * path is appended to it (`/anthropic/v1/messages`); the provider's id is
 * `deepseek` so the registry's identity check and provider-keyed quirks (e.g.
 * `applyParamQuirks`) resolve against DeepSeek, not the Anthropic builtin.
 *
 * The OpenAI-compatible `deepseek` base URL is unchanged and still serves the
 * provider's `/v1/models` discovery; only the dispatch wire moves to Messages.
 */
export function createDeepseekAnthropicAdapter(): ProviderAdapter {
  return createAnthropicCompatibleAdapter({
    provider_id: "deepseek" as const,
    base_url: providerBaseUrl("deepseek").replace(/\/+$/, "") + "/anthropic",
  });
}

import { defineModel } from "../model-definition";

export const ANTHROPIC_MODELS: readonly ModelDefinition[] = [
  // Current-generation SKUs and limits: the 5-series ships at 1M/128k,
  // opus-4-5 is a 200k/64k budget-era row, and haiku-4-5 keeps its 200k window.
  defineModel({ id: "claude-mythos-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true,}),
  defineModel({ id: "claude-mythos-5-1", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true,}),
  defineModel({ id: "claude-opus-5-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true,}),
  defineModel({ id: "claude-opus-4-6", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true,}),
  defineModel({ id: "claude-sonnet-4-6", wireFamily: "messages", endpoint: "/v1/messages", ctx: 1000000, out: 128000, vision: true, reasoning: true,}),
  defineModel({ id: "claude-opus-4-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 200000, out: 64000, vision: true, reasoning: true,}),
  defineModel({ id: "claude-haiku-4-5", wireFamily: "messages", endpoint: "/v1/messages", ctx: 200000, out: 64000, vision: true, reasoning: true,}),
];

