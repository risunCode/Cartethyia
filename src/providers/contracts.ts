// Provider contracts: adapter boundary, dispatch context, credential shape,
// and provider identifier parsing. Pure types + leaf helpers with no registry
// or resolution state.

import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../protocol/canonical-model";
import { GatewayError } from "../protocol/gateway-error";
import { BUNDLED_PROVIDER_METADATA, type BundledProviderId } from "./metadata";

/** Closed union of every shipped provider ID. */
export const BUNDLED_PROVIDER_IDS = BUNDLED_PROVIDER_METADATA.map((definition) => definition.id) as readonly BundledProviderId[];

/** Normalized builtin or validated custom provider identifier. */
declare const customProviderIdBrand: unique symbol;
export type CustomProviderId = string & { readonly [customProviderIdBrand]: true };
export type ProviderId = BundledProviderId | CustomProviderId;

/** Credential alternatives supported by the control-plane resolver. */
export type CredentialKind =
  "none" | "api_key" | "oauth" | "scoped_access_token" | "workload_identity";

/** Credential returned by control-plane resolution and consumed by adapters. */
export interface ResolvedCredential {
  readonly provider_id: ProviderId;
  readonly account_id?: string | undefined;
  readonly credential_kind: CredentialKind;
  readonly secret?: Uint8Array | undefined;
  /** Operator-configured outbound headers, filtered by the owning adapter. */
  readonly custom_headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Per-account upstream auth configuration that is not a secret — auth method,
   * region, profile ARN, OAuth client id, token endpoint. Carried beside the
   * secret because the request an adapter builds depends on it and a single
   * opaque credential string cannot express both. Never holds secrets.
   */
  readonly auth_state?: Readonly<Record<string, unknown>> | undefined;
}

export function readCredentialSecret(credential: ResolvedCredential, errorMessage?: string): string {
  const raw = credential.secret ? new TextDecoder().decode(credential.secret).trim() : "";
  if (!raw) {
    throw new GatewayError(
      "authentication_failed",
      401,
      errorMessage ?? "Provider credential secret is missing or empty",
    );
  }
  return raw;
}

/** Fetch capability that validates DNS answers and redirects before each request. */
export type ValidatedOutboundFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Provider WebSocket session over validated WSS egress. */
export interface ProviderWebSocketSession {
  send(message: string): void;
  receive(signal: AbortSignal): Promise<string>;
  close(code?: number, reason?: string): void;
}

/** WSS connector bound to the request's selected network-pool slot. */
export type ValidatedOutboundWebSocket = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<ProviderWebSocketSession>;

/** Context passed from routing to a provider adapter. */
export interface ProviderDispatchContext {
  readonly credential: ResolvedCredential;
  readonly deadline: number;
  readonly abort_signal: AbortSignal;
  readonly outbound_fetch?: ValidatedOutboundFetch | undefined;
  /** Validated WSS egress bound to the same selected network pool as HTTP. */
  readonly outbound_websocket?: ValidatedOutboundWebSocket | undefined;
  /** Built-in API-key route-selected fallback User-Agent; custom providers leave this unset. */
  readonly user_agent?: string | undefined;
  /** Original inbound headers needed only for provider-specific negotiation. */
  readonly request_headers?: Readonly<Record<string, string>> | undefined;
  /** Stable per-conversation cache affinity passed through dispatch. */
  readonly conversation_affinity?: string | undefined;
  /** Opaque identity shared by retries of one logical gateway request. */
  readonly request_identity?: object | undefined;
}

const USER_AGENT_HEADER_NAME = /^user-agent$/i;
const USER_AGENT_HEADER_LENGTH = "user-agent".length;

function hasUserAgentHeader(headers: Record<string, string>): boolean {
  for (const headerName in headers) {
    if (headerName.length !== USER_AGENT_HEADER_LENGTH) continue;
    if (Object.hasOwn(headers, headerName) && USER_AGENT_HEADER_NAME.test(headerName)) return true;
  }
  return false;
}

/** Uses the route identity as a fallback without replacing provider-supplied headers. */
export function applyRouteUserAgent(
  headers: Record<string, string>,
  credential: ResolvedCredential,
  userAgent: string | undefined,
): void {
  if (
    credential.credential_kind === "oauth" ||
    credential.credential_kind === "scoped_access_token" ||
    userAgent === undefined
  ) {
    return;
  }
  if (hasUserAgentHeader(headers)) return;
  headers["user-agent"] = userAgent;
}

/** ProviderDispatchTarget identity already resolved by routing before credential leasing. */
export interface ProviderDispatchTarget {
  readonly provider_id: ProviderId;
  readonly model_id: string;
  readonly wire_family: WireFamily;
  readonly endpoint_path: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

/** Provider adapter boundary: canonical request/events in, no public HTTP routes. */
export interface ProviderAdapter {
  readonly provider_id: ProviderId;
  dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent>;
  /**
   * Optional native-protocol capability. A provider whose catalog serves a
   * non-`llm` service kind (System One) implements the matching method; the
   * native route handler looks it up and dispatches the caller's opaque body
   * through it. The body is forwarded untouched — the method only adds the
   * provider's auth/identity headers and posts it to `endpoint_path`.
   *
   * An adapter without this method is simply not eligible for the route, which
   * is why it is optional rather than a required no-op.
   */
  systemone?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Response>;
  /**
   * Optional native web-search capability, the analogue of {@link systemone}
   * for the `/v1/search` route. The caller's body is opaque (`{query,
   * max_results, …}`); the adapter maps it onto the provider's own search API
   * and returns the raw upstream `Response`, which the route normalizes into
   * the unified search envelope. The route performs the SSRF/credential work,
   * so an adapter without this method is simply not eligible.
   */
  websearch?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<WebSearchOutcome>;
  /**
   * Optional native image-generation capability for `POST
   * /v1/images/generations`. The caller's body is opaque (`{prompt, n, size,
   * …}`); the adapter maps it onto the provider's own image API and returns the
   * generated images.
   *
   * Optional rather than a required no-op: an adapter that does not implement
   * it is not eligible for the route, which is what lets a provider advertise
   * `imageGeneration` in its catalog without every adapter having to answer for
   * a surface it cannot serve. The route handles the endpoint POST itself when
   * this is absent, so the capability is reachable through the candidate's
   * `endpoint_path` either way.
   */
  generateImage?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<ImageGenerationOutcome>;
  /**
   * Posts an opaque body to a candidate's own endpoint and returns the raw
   * upstream response.
   *
   * The shared escape hatch for a service the gateway does not model: the
   * candidate names the path, the adapter supplies the host, and the body is
   * forwarded untouched. `generateImage` uses it as its fallback so a provider
   * can serve images from its own path without a bespoke mapping, and it is
   * what lets `/v1/images/generations` work at all for an adapter that has not
   * written an image method.
   */
  dispatchNativeService?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Response>;
}

/**
 * The normalized result of one image-generation dispatch.
 *
 * Deliberately open: images arrive as URLs or base64 depending on the
 * provider, and the gateway must not transcode between them. `data` is passed
 * through exactly as the upstream produced it so a caller that asked for
 * `b64_json` still receives base64.
 */
export interface ImageGenerationOutcome {
  readonly created?: number;
  readonly data: readonly Record<string, unknown>[];
  readonly usage?: Record<string, unknown> | null;
}

/** One provider-independent web-search hit, normalized from a provider's own response shape. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published_at?: string | null;
  /** Provider relevance score, clamped to `[0, 1]`; absent when the provider reports none. */
  readonly score?: number | null;
}

/**
 * The normalized result of one web-search dispatch. The adapter owns both the
 * request mapping onto its provider's search API and the normalization of that
 * provider's response shape into this vocabulary, so the `/v1/search` route
 * never learns any provider's wire. A failed upstream throws a `GatewayError`
 * carrying the upstream status — the same contract as `systemone` — so the
 * attempt loop's retry classifier sees it; a success returns this.
 */
export interface WebSearchOutcome {
  readonly results: readonly WebSearchResult[];
  readonly total_results?: number | null;
}

/**
 * Normalizes a provider slug, rejecting anything that is not one. Persisted
 * IDs are already canonical, so no alias mapping is applied: an unknown or
 * misspelled slug is a caller error.
 */
function normalizeProviderSlug(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(trimmed)) {
    throw new GatewayError("invalid_request", 400, "Provider ID must be a lowercase slug");
  }
  return trimmed;
}

/** Returns true for one of Cartethyia's reserved builtin IDs, case-insensitively. */
export function isBundledProviderId(value: string): value is BundledProviderId {
  const normalized = value.trim().toLowerCase();
  return (BUNDLED_PROVIDER_IDS as readonly string[]).includes(normalized);
}

/** Normalizes a provider identifier before persistence or registry lookup. */
export function parseProviderId(value: string): ProviderId {
  const normalized = normalizeProviderSlug(value);
  return isBundledProviderId(normalized) ? normalized : normalized as CustomProviderId;
}

/**
 * Validates a custom/BYOK slug before any provider row is written.
 * Builtin collisions are case-insensitive and fail with typed `slug_reserved`.
 */
export function parseCustomProviderId(value: string): CustomProviderId {
  const normalized = parseProviderId(value);
  if (isBundledProviderId(normalized)) {
    throw new GatewayError(
      "slug_reserved",
      409,
      "The provider ID is reserved for a builtin provider",
      { provider_id: normalized },
    );
  }
  return normalized as CustomProviderId;
}
