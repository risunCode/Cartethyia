/**
 * Shared Claude Messages wire helpers for API-key adapters.
 *
 * Three adapters speak Anthropic Messages with an operator-owned credential:
 * the plain Anthropic adapter (`x-api-key`), InferHub's Claude-backed models
 * (Bearer), and — for header validation only — the [CC] OAuth adapter.
 * Everything except the auth header, the optional payload hook, and the base
 * URL is identical, so request projection, quirks, URL assembly, JSON
 * encoding, and Claude-wire custom-header validation live here and the
 * callers cannot drift.
 *
 * Deliberately [CC]-OAuth-free: no CLI fingerprint, no CCH billing
 * attestation, no beta negotiation, no Stainless identity. The [CC] OAuth
 * impersonation policy lives in `./claude-code/`.
 */
import type { CanonicalRequest } from "../../transport/canonical-model";
import { canonicalToClaudeMessagesPayload } from "../../protocol/request/messages";
import {
  BUILTIN_DEFAULT_ENDPOINTS,
  endpointUrl,
  filterProviderCustomHeaders,
} from "../../protocol/primitives";
import { isProtectedHeader } from "../../security/outbound-headers";

// Claude-wire custom-header validation

/** Claude-specific reserved request headers beyond the shared base set. */
const CLAUDE_EXTRA_PROTECTED_HEADERS: Readonly<Record<string, true>> = Object.freeze({
  "x-stainless-arch": true,
  "x-stainless-lang": true,
  "x-stainless-os": true,
  "x-stainless-package-version": true,
  "x-stainless-retry-count": true,
  "x-stainless-runtime": true,
  "x-stainless-runtime-version": true,
  "x-stainless-timeout": true,
  "x-account-id": true,
  "x-device-id": true,
  "x-session-id": true,
  "x-claude-code-session-id": true,
  "anthropic-version": true,
  "anthropic-beta": true,
  "x-app": true,
  "x-claude-cch": true,
  "x-anthropic-billing-header": true,
});

function isClaudeProtectedHeader(name: string): boolean {
  return isProtectedHeader(name, CLAUDE_EXTRA_PROTECTED_HEADERS);
}

/** How a configured custom header colliding with a protected name is handled. */
type ProtectedHeaderPolicy = "reject" | "drop";

/** Options controlling custom-header validation. */
export interface ClaudeCustomHeaderOptions {
  readonly protected_policy?: ProtectedHeaderPolicy;
}

/**
 * Validates and normalizes untrusted configured outbound headers. Protected,
 * credential, transport, proxy-identity, and gateway identity names can never
 * be replaced by custom configuration. Delegates to the single factory
 * validator (`filterProviderCustomHeaders`), passing Claude's stainless
 * SDK-identity and client-identity extras as additionally reserved names.
 */
const CLAUDE_CUSTOM_HEADER_EXTRA_ALLOWED: readonly string[] = Object.freeze(
  Object.keys(CLAUDE_EXTRA_PROTECTED_HEADERS),
);
export function filterClaudeCustomHeaders(
  input: Readonly<Record<string, unknown>> | undefined,
  options: ClaudeCustomHeaderOptions = {},
): Record<string, string> {
  if (!input) return {};
  const protectedPolicy = options.protected_policy ?? "reject";
  if (protectedPolicy === "drop") {
    // Partition out reserved names (base handled inside the factory; Claude
    // extras via isClaudeProtectedHeader) so the factory validates the rest.
    const stripped: Record<string, unknown> = {};
    for (const [rawName, rawValue] of Object.entries(input)) {
      if (!isClaudeProtectedHeader(rawName)) stripped[rawName] = rawValue;
    }
    return filterProviderCustomHeaders(stripped, CLAUDE_CUSTOM_HEADER_EXTRA_ALLOWED);
  }
  return filterProviderCustomHeaders(input, CLAUDE_CUSTOM_HEADER_EXTRA_ALLOWED);
}

// API-key Messages request pre-flight

interface ClaudeMessagesRequestOptions {
  /** Canonical request; callers apply provider parameter quirks first. */
  readonly request: CanonicalRequest;
  /** `x-api-key` for the public Anthropic API, `bearer` for Anthropic-compatible resellers. */
  readonly authHeader: "x-api-key" | "bearer";
  readonly credential: {
    readonly secret: string;
    /** Provider/operator headers, applied before the auth header. */
    readonly customHeaders?: Readonly<Record<string, string>> | undefined;
  };
  /** Upstream origin; falls back to the provider's builtin base URL. */
  readonly baseUrl?: string | undefined;
  /** ProviderDispatchTarget endpoint path; defaults to `/v1/messages`. */
  readonly endpointPath?: string | undefined;
  /** Final payload transform, applied after canonical projection. */
  readonly mutatePayload?:
    | ((payload: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  /**
   * Explicit gateway identity (`user-agent: Cartethyia/<version>`). Opt-in
   * per call site — the shared builder never stamps it by default.
   */
  readonly gatewayUserAgent?: string | undefined;
}

interface ClaudeMessagesRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Appends a beta token to the `anthropic-beta` header without duplicates. */
export function ensureAnthropicBeta(headers: Record<string, string>, beta: string): void {
  const betas = (headers["anthropic-beta"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!betas.includes(beta)) betas.push(beta);
  headers["anthropic-beta"] = betas.join(",");
}

export function buildClaudeMessagesRequest(
  options: ClaudeMessagesRequestOptions,
): ClaudeMessagesRequest {
  const { request, credential, authHeader, baseUrl, endpointPath, mutatePayload, gatewayUserAgent } = options;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(gatewayUserAgent ? { "user-agent": gatewayUserAgent } : {}),
    ...(credential.customHeaders ?? {}),
  };
  if (authHeader === "x-api-key") headers["x-api-key"] = credential.secret;
  else headers.authorization = `Bearer ${credential.secret}`;
  // `user_profile_id` requires the `user-profiles` beta on the plain key path.
  const profileId = request.generation_controls["extension:user_profile_id"];
  if (typeof profileId === "string" && profileId.length > 0)
    ensureAnthropicBeta(headers, "user-profiles");

  const projected = canonicalToClaudeMessagesPayload(request, { isOAuth: false });
  const payload = mutatePayload ? mutatePayload(projected) : projected;
  return {
    url: endpointUrl(baseUrl, endpointPath || BUILTIN_DEFAULT_ENDPOINTS.messages),
    headers,
    body: JSON.stringify(payload),
  };
}
