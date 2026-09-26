import type {
  ProviderDispatchTarget,
  ProviderId,
  ProviderAdapter,
  ProviderDispatchContext,
} from "../provider-registry";
import type { CanonicalRequest, WireFamily } from "../../transport/canonical-model";
import { GatewayError } from "../../transport/gateway-error";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../compatible-adapter";
import { providerBaseUrl } from "../provider-metadata";

export function ensurePayloadModel(
  payload: Record<string, unknown>,
  candidate: ProviderDispatchTarget,
  providerName: string,
): string {
  const value = payload["model"];
  const model = typeof value === "string" && value.trim() ? value.trim() : candidate.model_id.trim();
  if (!model) throw new GatewayError("invalid_request", 400, `${providerName} model is required`);
  payload["model"] = model;
  return model;
}
/**
 * Declarative description of one bearer-authenticated OpenAI-compatible provider.
 *
 * A spec carries data only: identity, wire contract, endpoint paths, and the
 * per-provider hooks the shared factory already supports. `base_url` is
 * resolved from `BUNDLED_PROVIDER_METADATA` via `providerBaseUrl(provider_id)` so a
 * provider's upstream origin has exactly one declaration.
 */
export interface ApiKeyProviderSpec {
  readonly provider_id: ProviderId;
  /**
   * Upstream origin. Defaults to `providerBaseUrl(provider_id)` so a provider's
   * base URL has exactly one declaration; only adapters whose origin differs
   * from the bundled metadata (Cline, Grok Build, …) set it explicitly.
   */
  readonly base_url?: string;
  /** Endpoint path per wire family; families absent here fall back to `BUILTIN_DEFAULT_ENDPOINTS`. */
  readonly endpoint_paths_by_wire_family?: Partial<Record<WireFamily, string>>;
  /** Static headers applied to every dispatch, before `buildExtraHeaders`. */
  readonly extra_headers?: Readonly<Record<string, string>>;
  /** Per-dispatch header hook for providers needing fresh values (correlation IDs, credential-derived auth). */
  readonly buildExtraHeaders?: (
    context: ProviderDispatchContext,
    request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** `"never"` withholds `Authorization` for genuinely public endpoints (OpenCode Free). */
  readonly credential_forwarding?: "account" | "never";
  /**
   * Opts this provider into the gateway identity (`Cartethyia/<version>` as
   * the upstream `user-agent`). Explicit only: providers with their own
   * first-party identity (Codex, Claude Code) and unprovisioned BYOK rows
   * never get it.
   */
  readonly gatewayUserAgent?: boolean;
  /** `false` drops OpenAI prompt-cache controls from the payload (OpenCode). */
  readonly promptCache?: boolean;
  /** Canonical request hook, applied before wire translation. Use for
   * provider-side request contracts (e.g. OpenCode Free's agent tool
   * fingerprint) so every wire codec serializes the same canonical input.
   * Raw post-serialization fixes belong in `prePayload`, not here. */
  readonly prepareRequest?: (request: CanonicalRequest) => CanonicalRequest;
  /** Final payload mutation, after canonical translation. */
  readonly prePayload?: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
}

/** Builds the adapter for one spec; `fetchImpl` is the transport seam. */
export function createApiKeyAdapter(
  spec: ApiKeyProviderSpec,
  fetchImpl?: typeof fetch,
): ProviderAdapter {
  return new OpenAICompatibleAdapter(
    withBearerAuthentication({
      provider_id: spec.provider_id,
      base_url: spec.base_url ?? providerBaseUrl(spec.provider_id),
      endpoint_paths_by_wire_family: spec.endpoint_paths_by_wire_family ?? {},
      ...(spec.extra_headers ? { extra_headers: spec.extra_headers } : {}),
      ...(spec.buildExtraHeaders ? { buildExtraHeaders: spec.buildExtraHeaders } : {}),
      ...(spec.credential_forwarding ? { credential_forwarding: spec.credential_forwarding } : {}),
      ...(spec.promptCache === false ? { supports_prompt_caching: false } : {}),
      ...(spec.prepareRequest ? { prepareRequest: spec.prepareRequest } : {}),
      ...(spec.prePayload ? { prePayload: spec.prePayload } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(spec.gatewayUserAgent === true ? { gateway_user_agent: true } : {}),
    }),
  );
}

