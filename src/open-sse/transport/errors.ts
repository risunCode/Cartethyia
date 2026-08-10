import { boundedRetryAt, deriveErrorSource, sanitizeMessage, type ApplicationErrorKind, type ProviderCallError } from "../../application/contracts";
import { isUsageLimitOutcome, parseRateLimitReason } from "../../application/rate-limit";
import { isRecord } from "../../application/protocols";
import { ProtocolCodecError } from "../translate/errors";
import { readBoundedText } from "./body-reader";
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
// ---------------------------------------------------------------- typed errors

export interface ProviderAdapterErrorOptions {
  readonly kind: ApplicationErrorKind;
  readonly message: string;
  readonly statusCode?: number | null;
  readonly retryable?: boolean;
  readonly routeScope?: "account" | "proxy" | "provider" | null;
  readonly retryAt?: string | null;
}

/**
 * Typed failure for adapter-level problems (unsupported surfaces, protocol
 * violations, upstream HTTP statuses, timeouts). Always convertible to the
 * application ProviderCallError shape via {@link toProviderCallError}.
 */
export class ProviderAdapterError extends Error {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;
  readonly retryAt: string | null;

  constructor(options: ProviderAdapterErrorOptions) {
    super(options.message);
    this.name = "ProviderAdapterError";
    this.kind = options.kind;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable ?? false;
    this.routeScope = options.routeScope ?? "provider";
    this.retryAt = options.retryAt ?? null;
  }

  toProviderCallError(): ProviderCallError {
    return {
      statusCode: this.statusCode,
      kind: this.kind,
      retryable: this.retryable,
      routeScope: this.routeScope,
      source: deriveErrorSource(this.kind, this.routeScope),
      sanitizedMessage: sanitizeMessage(this.message),
      retryAt: this.retryAt,
    };
  }
}

const MAX_RETRY_AFTER_DELAY_MS = 30_000;

function mapUpstreamError(statusCode: number, message: string, retryAfterSeconds: number | null, _errorKind: string | null): ProviderAdapterError {
  const retryAt = boundedRetryAt(retryAfterSeconds, Date.now(), MAX_RETRY_AFTER_DELAY_MS);
  switch (statusCode) {
    case 400:
      return new ProviderAdapterError({ kind: "invalid_request", message, statusCode, routeScope: "provider" });
    case 401:
      return new ProviderAdapterError({ kind: "authentication_failed", message, statusCode, routeScope: "account" });
    case 402:
      // Payment Required: account-local billing cap (xAI Grok Build balance,
      // DeepSeek insufficient balance, OpenRouter credit exhaustion). Rotate
      // to a sibling credential — this is never a transient blip.
      return new ProviderAdapterError({ kind: "quota_exceeded", message, statusCode, retryable: true, routeScope: "account" });
    case 403:
      return new ProviderAdapterError({ kind: "authorization_denied", message, statusCode, routeScope: "account" });
    case 404:
      return new ProviderAdapterError({ kind: "model_not_found", message, statusCode, routeScope: "provider" });
    case 407:
      // The outbound proxy rejected the request (RFC 9110 Proxy-Authentication
      // Required): the proxy route itself is the fault, so the failure is
      // retryable and scoped to the proxy â€” health recording then penalizes
      // the proxy, not the provider or account.
      return new ProviderAdapterError({ kind: "network_unavailable", message, statusCode, retryable: true, routeScope: "proxy" });
    case 408:
      return new ProviderAdapterError({ kind: "provider_unavailable", message, statusCode, retryable: true, routeScope: "provider" });
    case 409:
      return new ProviderAdapterError({ kind: "concurrency_exceeded", message, statusCode, retryable: true, routeScope: "provider" });
    case 413:
      return new ProviderAdapterError({ kind: "invalid_request", message, statusCode, routeScope: "provider" });
    case 422:
      return new ProviderAdapterError({ kind: "invalid_request", message, statusCode, routeScope: "provider" });
    case 429: {
      const reason = parseRateLimitReason(message);
      const quotaHint = reason === "QUOTA_EXHAUSTED" || isUsageLimitOutcome(statusCode, message);
      return new ProviderAdapterError({
        kind: quotaHint ? "quota_exceeded" : "provider_rate_limited",
        message,
        statusCode,
        retryable: true,
        routeScope: "account",
        retryAt,
      });
    }
    default:
      if (statusCode >= 500) {
        return new ProviderAdapterError({ kind: "provider_unavailable", message, statusCode, retryable: true, routeScope: "provider", retryAt });
      }
      return new ProviderAdapterError({ kind: "provider_protocol_error", message, statusCode, routeScope: "provider" });
  }
}

/**
 * Bounded, retryability-aware mapping of any thrown value into the application
 * ProviderCallError shape. Used by every adapter's `mapError`.
 */
export function toProviderCallError(error: unknown): ProviderCallError {
  if (error instanceof ProviderAdapterError) return error.toProviderCallError();
  if (error instanceof ProtocolCodecError) return error.toProviderCallError(sanitizeMessage(error));
  if (isAbortError(error)) {
    return { statusCode: null, kind: "client_aborted", retryable: false, routeScope: null, source: "client", sanitizedMessage: "Request aborted", retryAt: null };
  }
  if (error instanceof TypeError) {
    return { statusCode: null, kind: "network_unavailable", retryable: true, routeScope: "proxy", source: "upstream", sanitizedMessage: sanitizeMessage(error), retryAt: null };
  }
  // E8: narrow the catch-all. ReferenceError/SyntaxError are internal bugs,
  // not upstream protocol errors — classify them as internal so debugging
  // doesn't chase a phantom provider issue.
  if (error instanceof ReferenceError || error instanceof SyntaxError) {
    return { statusCode: null, kind: "internal_error", retryable: false, routeScope: null, source: "internal", sanitizedMessage: sanitizeMessage(error), retryAt: null };
  }
  return { statusCode: null, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: sanitizeMessage(error), retryAt: null };
}
const MAX_ERROR_BODY_BYTES = 16_384;

const MAX_RETRY_AFTER_SECONDS = MAX_RETRY_AFTER_DELAY_MS / 1_000;

/**
 * Parses an HTTP `Retry-After` header value into bounded, non-negative
 * seconds (RFC 9110 Â§10.2.3). Accepts both the delta-seconds form and the
 * HTTP-date form; an HTTP-date in the past clamps to 0s. Any value beyond
 * {@link MAX_RETRY_AFTER_SECONDS} is clamped to the cap so a bogus or
 * hostile header can never extend a retry window past the safe maximum.
 * Returns null for absent/empty/unparseable values.
 */
export function parseRetryAfterSeconds(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let seconds: number | null = null;
  if (/^-\d/.test(trimmed)) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) seconds = parsed;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) seconds = Math.max(0, (at - nowMs) / 1_000);
  }
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Reads a bounded error body and maps the upstream HTTP status into a typed
 * ProviderAdapterError with sanitized message, retryability, account/proxy
 * route scoping, and a bounded retry-at window.
 */
export async function readUpstreamError(response: Response): Promise<never> {
  const statusCode = response.status;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"), Date.now());
  const bodyText = await readBoundedText(response.body, MAX_ERROR_BODY_BYTES);
  let message = "";
  let errorKind: string | null = null;
  if (bodyText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (isRecord(parsed)) {
        if (isRecord(parsed.error)) {
          if (typeof parsed.error.message === "string") message = parsed.error.message;
          errorKind = typeof parsed.error.type === "string" ? parsed.error.type : typeof parsed.error.code === "string" ? parsed.error.code : null;
        } else if (typeof parsed.message === "string") {
          message = parsed.message;
        } else if (typeof parsed.detail === "string") {
          message = parsed.detail;
        }
      }
    } catch {
      message = bodyText.slice(0, 500);
    }
  }
  throw mapUpstreamError(statusCode, message.length > 0 ? message : `Upstream provider returned HTTP ${statusCode}`, retryAfterSeconds, errorKind);
}