// Typed gateway failures: the stable public error codes, the error class, and
// the sanitizers that keep upstream payloads out of public envelopes.

/** Stable typed error codes returned at gateway boundaries. */
export type GatewayErrorCode =
  | "capability_unsupported"
  | "ambiguous_model"
  | "model_not_found"
  | "upstream_not_found"
  | "context_length_exceeded"
  | "request_too_large"
  | "accounts_unavailable"
  | "accounts_rate_limited"
  | "capacity_exhausted"
  | "proxy_pool_capacity_exceeded"
  | "proxy_pool_cooldown"
  | "proxy_pool_unavailable"
  | "proxy_pool_unhealthy"
  | "invalid_pool_limits"
  | "admission_unavailable"
  | "slug_reserved"
  | "quota_exceeded"
  | "authentication_failed"
  | "policy_rejected"
  | "invalid_request"
  | "not_found"
  | "link_not_found"
  | "link_expired"
  | "link_revoked"
  | "link_disabled"
  | "invalid_sequence"
  | "invalid_lifecycle"
  | "unsupported_field"
  | "unsupported_media_type"
  | "upstream_conflict"
  | "upstream_unprocessable"
  | "internal_error"
  | "transport_unavailable"
  | "tunnel_setup_failed"
  | "platform_unavailable"
  | "tenant_capacity_exhausted"
  | "tls_rejected"
  | "proxy_auth_required"
  | "deadline_exceeded"
  | "transport_closed"
  | "max_connections_exceeded"
  | "proxy_unreachable"
  | "tool_call_loop_detected"
  | "client_router_denied"
  | "model_abuse_banned"
  | "shutting_down"
  | "restart_for_update";

/** Identifies which boundary produced a safe public error. */
export type GatewayErrorOrigin = "cartethyia" | "upstream" | "network";

/**
 * Error with a client-safe stable code, origin, and sanitized metadata.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly origin: GatewayErrorOrigin;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GatewayErrorCode,
    status: number,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    origin: GatewayErrorOrigin = "cartethyia",
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.origin = origin;
    this.details = details;
  }
}

/**
 * Legacy origin brand prefixes. Older builds stamped these into the public
 * `message`; strip them so a value that crossed two shapers is not doubled
 * and so clients never see product branding in the error text.
 *
 * Blame lives in the structured `origin` field (`cartethyia` | `upstream` |
 * `network`). The public message is always `code: explanatory` for every
 * origin — gateway and upstream look the same on the wire.
 */
const LEGACY_ORIGIN_LABELS: readonly string[] = [
  "Cartethyia Error:",
  "Upstream Error:",
  "Network Error:",
];

function stripLegacyOriginLabel(message: string): string {
  const trimmed = message.trim();
  for (const prefix of LEGACY_ORIGIN_LABELS) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trimStart();
  }
  return trimmed;
}

/**
 * Public client-facing error text: `code: explanatory`.
 *
 * Applied once: a message that already starts with `code:` is returned
 * unchanged. Origin is never written into the text — clients that need the
 * layer read `error.origin`.
 */
export function formatPublicErrorMessage(code: string, message: string): string {
  const explanatory = stripLegacyOriginLabel(message);
  if (explanatory.length === 0) return code;
  if (explanatory === code || explanatory.startsWith(`${code}:`)) return explanatory;
  return `${code}: ${explanatory}`;
}

/** Formats a gateway error for public/internal clients without mutating it. */
export function explainGatewayError(error: GatewayError): string {
  return formatPublicErrorMessage(error.code, error.message);
}

const PUBLIC_ERROR_DETAIL_KEYS = new Set([
  "accountId",
  "accountScope",
  "available",
  "capacity",
  "configuredPools",
  "cooldownReason",
  "currentInflight",
  "credentialEvidence",
  "model",
  "poolId",
  "pools",
  "providerCode",
  "providerId",
  "providerStatus",
  "providerScope",
  "raw",
  "rateLimitScope",
  "reason",
  "reasons",
  "candidate_count",
  "requestId",
  "retryAfterMs",
  "retryAt",
  "safeMessage",
  "scope",
  "status",
  "upstreamRequestId",
  "upstreamStatus",
  "maxInflight",
  "weight",
]);
function sanitizePublicDetail(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[redacted]";
  if (Array.isArray(value))
    return value.slice(0, 32).map((entry) => sanitizePublicDetail(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sanitizePublicDetail(entry, depth + 1),
    ]),
  );
}

/** Returns bounded allowlisted details suitable for public error envelopes. */
export function publicGatewayErrorDetails(
  error: GatewayError,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(error.details)
      .filter(([key]) => PUBLIC_ERROR_DETAIL_KEYS.has(key))
      .map(([key, value]) => [key, sanitizePublicDetail(value)]),
  );
}

/** Serializes a GatewayError with the same public shape as transport errors. */
export function publicGatewayErrorBody(error: GatewayError): {
  readonly error: {
    readonly origin: GatewayErrorOrigin;
    readonly code: GatewayErrorCode;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
} {
  return {
    error: {
      origin: error.origin,
      code: error.code,
      message: explainGatewayError(error),
      details: publicGatewayErrorDetails(error),
    },
  };
}

/** Creates the typed rejection required when a semantic feature is unavailable. */
export function capabilityUnsupported(
  capability: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayError {
  return new GatewayError(
    "capability_unsupported",
    400,
    `The selected route does not support capability: ${capability}`,
    { capability, ...details },
  );
}
