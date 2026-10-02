import { GatewayError, type GatewayErrorCode, type GatewayErrorOrigin } from "./gateway-error";
import { isRecord } from "../protocol/primitives";
import { resolveFallbackRetryBaseMs, resolveFallbackRetryCapMs } from "../config";

const MAX_UPSTREAM_ERROR_BYTES = 500;
const MAX_COOLDOWN_MS = 24 * 3600 * 1000;

/** Parses Retry-After seconds or an HTTP date, bounded to one day. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(MAX_COOLDOWN_MS, numeric * 1000);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const delay = parsed - Date.now();
  return delay > 0 ? Math.min(MAX_COOLDOWN_MS, delay) : null;
}

/** Parses x-ratelimit-reset as epoch seconds or a relative delay. */
export function parseRateLimitReset(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const target = numeric >= 1_000_000_000 ? numeric * 1000 : Date.now() + numeric * 1000;
  return Math.min(MAX_COOLDOWN_MS, Math.max(0, target - Date.now()));
}

/** Parses a millisecond-denominated reset header (`retry-after-ms`, `x-ratelimit-reset-ms`). */
export function parseResetAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(MAX_COOLDOWN_MS, Math.round(numeric));
}

/**
 * Reads upstream backoff evidence in reference priority order: millisecond
 * variants first (`retry-after-ms`, then `x-ratelimit-reset-ms`), then the
 * classic `retry-after` / `x-ratelimit-reset` pair.
 */
export function parseUpstreamBackoff(headers: {
  get(name: string): string | null;
}): number | null {
  return (
    parseResetAfterMs(headers.get("retry-after-ms")) ??
    parseRetryAfter(headers.get("retry-after")) ??
    parseResetAfterMs(headers.get("x-ratelimit-reset-ms")) ??
    parseRateLimitReset(headers.get("x-ratelimit-reset")) ??
    parseRateLimitReset(headers.get("x-ratelimit-reset-requests")) ??
    parseRateLimitReset(headers.get("retry-after"))
  );
}

/**
 * Extracts bounded reset durations from provider messages when headers omit
 * them.
 *
 * Two shapes are recognized, because providers state resets both ways:
 *
 *   - **Relative** — "quota will reset in 3 hours", "try again in 30s".
 *   - **Absolute** — "your usage will reset at 2026-09-24 02:12:51 UTC+8"
 *     (WorkBuddy/CodeBuddy `6004`). An absolute stamp is *not* a duration, and
 *     the relative-only pattern silently missed it, so the account fell back to
 *     the generic 15-minute default while the provider had actually parked it
 *     for the rest of the window — the account kept re-entering rotation and
 *     failing every request inside the stated reset window.
 */
/**
 * One `amount unit` pair of a duration phrase: `4h`, `13m`, `2 hours`, `30s`.
 *
 * The unit ends on `(?![a-z])`, not `\b`: a compact compound like `2h30m` puts
 * a digit straight after `h`, which is a word character, so a `\b` would refuse
 * to end the pair and the whole phrase would parse as null. `m(?!s|o)` is what
 * stops a bare `m` from swallowing `ms` (milliseconds) or `mo` (months),
 * neither of which is a reset duration.
 */
const DURATION_PAIR_SOURCE = String.raw`(\d+(?:\.\d+)?)[\s-]*(hours?|hrs?|h|minutes?|mins?|m(?!s|o)|seconds?|secs?|s)(?![a-z])`;

function durationUnitMs(unit: string): number {
  const first = unit.toLowerCase()[0];
  return first === "h" ? 3600_000 : first === "m" ? 60_000 : 1_000;
}

/**
 * Sums the `amount unit` pairs at the head of a duration phrase.
 *
 * Providers state a reset as one compound duration at least as often as a
 * single unit: a daily-limit 429 reads "Try again in 4h 13m". A single-pair
 * parser read only `4h` and dropped the 13 minutes, so the stored retry
 * deadline was earlier than the window the provider had actually stated and the
 * account re-entered rotation before it. Pairs are accepted only while they
 * continue the phrase — separated by whitespace, a comma, or `and` — so a
 * number that merely follows later in the sentence cannot be absorbed.
 */
function parseCompoundDuration(text: string): number | null {
  const pairs = new RegExp(DURATION_PAIR_SOURCE, "gi");
  let totalMs = 0;
  let lastEnd = 0;
  let matched = false;
  for (let pair = pairs.exec(text); pair !== null; pair = pairs.exec(text)) {
    const gap = text.slice(lastEnd, pair.index);
    const continues = matched ? /^[\s,]*(?:and\s+)?$/i.test(gap) : /^\s*$/.test(gap);
    if (!continues) break;
    const amount = Number(pair[1]);
    if (!Number.isFinite(amount) || amount <= 0) break;
    totalMs += amount * durationUnitMs(pair[2] ?? "");
    matched = true;
    lastEnd = pair.index + pair[0].length;
  }
  return matched ? Math.round(totalMs) : null;
}

export function parseProviderResetDuration(message: string): number | null {
  const trigger =
    /(?:quota will reset|resets?|try again|retry(?:ing)?)\s+(?:in|after|over)\s+(?:a\s+)?(?:rolling\s+)?/i.exec(
      message,
    );
  if (trigger) {
    const parsed = parseCompoundDuration(message.slice(trigger.index + trigger[0].length));
    if (parsed !== null) return Math.min(MAX_COOLDOWN_MS, parsed);
  }
  return parseAbsoluteResetTimestamp(message);
}

/**
 * Reads an absolute reset instant out of a provider message, e.g.
 * `will reset at 2026-09-24 02:12:51 UTC+8`. Returns the delay from now,
 * bounded to one day, or null when no future timestamp is present.
 *
 * `Date.parse` cannot read the space-separated `YYYY-MM-DD HH:MM:SS` form with
 * a bare `UTC±H` offset, so the parts are normalized explicitly rather than
 * relying on engine-specific leniency.
 */
export function parseAbsoluteResetTimestamp(message: string): number | null {
  const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(?:UTC|GMT)?\s*([+-]\d{1,2})?(?::?(\d{2}))?/i.exec(
    message,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offsetHours, offsetMinutes] = match;
  if (!year || !month || !day || !hour || !minute || !second) return null;
  // A bare `UTC+8` means a whole-hour offset; `+08:30`-style halves are rare
  // but cheap to honor. No offset at all is read as UTC (providers that omit
  // it always label the stamp "UTC" in practice).
  const sign = offsetHours?.startsWith("-") ? -1 : 1;
  const offsetTotalMinutes =
    offsetHours === undefined
      ? 0
      : sign * (Math.abs(Number(offsetHours)) * 60 + Number(offsetMinutes ?? 0));
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(utcMs)) return null;
  const targetMs = utcMs - offsetTotalMinutes * 60_000;
  const delay = targetMs - Date.now();
  // A past stamp is not a usable reset (clock skew, stale cached error); fall
  // through to the caller's default instead of returning a negative delay.
  if (!Number.isFinite(delay) || delay <= 0) return null;
  return Math.min(MAX_COOLDOWN_MS, Math.round(delay));
}
/** Extracts a bounded, newline-free provider message from any error envelope. */
export function extractUpstreamMessage(body: unknown): string {
  let raw = "";
  if (typeof body === "string") raw = body;
  else if (isRecord(body)) {
    // Cline-style {"error":"Not Found","success":false} — error is a string, not an envelope.
    if (typeof body.error === "string" && body.error.trim()) raw = body.error;
    else {
      const envelope = isRecord(body.error) ? body.error : body;
      const message = (envelope as Record<string, unknown>).message;
      const code = (envelope as Record<string, unknown>).code;
      if (typeof message === "string" && message.trim()) raw = message;
      else if (typeof code === "string" && code.trim()) raw = code;
      else if (typeof body.message === "string" && body.message.trim()) raw = body.message;
      // WorkBuddy/CodeBuddy put the human-readable text in a top-level `msg`
      // while `extError.message` repeats it; without this the operator saw an
      // empty message for a 400 that had a perfectly clear one.
      else if (typeof body.msg === "string" && body.msg.trim()) raw = body.msg;
      else if (typeof (envelope as Record<string, unknown>).msg === "string" && String((envelope as Record<string, unknown>).msg).trim())
        raw = String((envelope as Record<string, unknown>).msg);
      else if (typeof (envelope as Record<string, unknown>).error === "string" && String((envelope as Record<string, unknown>).error).trim())
        raw = String((envelope as Record<string, unknown>).error);
    }
  }
  return raw.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_UPSTREAM_ERROR_BYTES);
}

/**
 * The provider's own error code from an upstream error body, as a string.
 *
 * Upstreams disagree about where it lives and what type it is:
 *
 *   - `{"error":{"code":"invalid_api_key"}}` — nested, string
 *   - `{"code":11148,"extError":{"code":"tool_call_sequence_broken"}}` —
 *     top-level **number**, with a more specific string nested in `extError`
 *
 * Reading only a nested string dropped the code for the second family
 * entirely, so the operator saw a bare message with no provider code.
 */
export function upstreamProviderCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const nested = isRecord(body.error) ? body.error : undefined;
  const ext = isRecord(body.extError) ? body.extError : undefined;
  for (const candidate of [ext?.code, nested?.code, body.code]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  // A numeric code is still the provider's identifier; keep it as text so an
  // operator can search for it. The nested string above wins when both exist.
  const numeric = ext?.code ?? nested?.code ?? body.code;
  if (typeof numeric === "number" && Number.isFinite(numeric)) return String(numeric);
  return undefined;
}

/** Extracts the stable request ID header used in provider diagnostics. */
export function upstreamRequestId(headers: Headers | undefined): string | undefined {
  return headers?.get("x-request-id") ?? headers?.get("request-id") ?? headers?.get("x-amzn-requestid") ?? headers?.get("cf-ray") ?? undefined;
}

/**
 * Canonical status→code mapping for upstream HTTP failures.
 *
 * Structured error identifiers are refined by `classifyUpstreamError`; this
 * status-only table keeps distinct HTTP failure classes distinct without
 * guessing whether a generic 404 names a model or an upstream route.
 */
export function statusToGatewayErrorCode(status: number): GatewayErrorCode {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 402 || status === 429) return "quota_exceeded";
  if (status === 404) return "upstream_not_found";
  if (status === 407) return "proxy_auth_required";
  if (status === 408 || status === 504) return "deadline_exceeded";
  if (status === 409) return "upstream_conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 422) return "upstream_unprocessable";
  if (status === 529) return "capacity_exhausted";
  if (status >= 500 && status <= 599) return "platform_unavailable";
  return "invalid_request";
}

/** Normalized account-health evidence and retry decision for one failure. */
export interface UpstreamFailurePolicy {
  readonly retryable: boolean;
  readonly mutatesAccount: boolean;
  readonly cooldownMs?: number;
  readonly category: string;
  readonly scope?: "account" | "provider" | "network";
  readonly origin: GatewayErrorOrigin;
  readonly providerCode?: string;
  readonly credentialEvidence?: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
  /** Provider that produced the failure, for the buddy `11140` policy block. */
  readonly providerId?: string;
}

/** Classifies one dispatch failure for both fallback routing and account health. */
export function classifyUpstreamFailure(error: unknown): UpstreamFailurePolicy {
  if (!(error instanceof GatewayError)) {
    return { retryable: true, mutatesAccount: false, category: "network", scope: "network", origin: "network" };
  }
  const providerCode = typeof error.details.providerCode === "string" ? error.details.providerCode : undefined;
  const providerId = typeof error.details.providerId === "string" ? error.details.providerId : undefined;
  const credentialEvidence = error.details.credentialEvidence === true || error.details.accountScope === true;
  const policyAccountEvidence = providerCode === "11140";
  let scope: "network" | "account" | "provider";
  if (error.origin === "network") scope = "network";
  else if (credentialEvidence || policyAccountEvidence) scope = "account";
  else scope = "provider";
  const retryAfterMs = typeof error.details.retryAfterMs === "number" ? error.details.retryAfterMs : undefined;
  const retryable =
    error.code === "capability_unsupported" ||
    error.code === "model_not_found" ||
    error.code === "admission_unavailable" ||
    error.code === "capacity_exhausted" ||
    error.code === "accounts_unavailable" ||
    error.code === "accounts_rate_limited" ||
    error.code === "quota_exceeded" ||
    error.code === "authentication_failed" ||
    error.code === "proxy_auth_required" ||
    error.code === "deadline_exceeded" ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 429 ||
    (error.status >= 500 && error.status <= 504);
  return {
    retryable,
    mutatesAccount: error.origin === "upstream" && scope === "account",
    category: error.code,
    scope,
    origin: error.origin,
    ...(providerCode ? { providerCode } : {}),
    ...(providerId ? { providerId } : {}),
    ...(credentialEvidence ? { credentialEvidence: true } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs, cooldownMs: retryAfterMs }),
    statusCode: error.status,
  };
}

/**
 * Terminal telemetry category for one failed attempt.
 *
 * A raw abort is not an unexplained gateway failure: our own deadline timers
 * abort with a `TimeoutError`, a client disconnect bridges the inbound signal
 * or the stream's `cancel()` (both `AbortError`s), and the stall watchdog
 * aborts with a `GatewayError` the reader may surface only as an abort.
 * Labeling every non-GatewayError `unknown_error` recorded ordinary client
 * cancels as "the upstream failure could not be classified" — blameless
 * diagnostics lost the real outcome. Only a failure with no abort behind it
 * stays unknown.
 */
export function classifyTerminalCategory(
  error: unknown,
  signal: AbortSignal,
): GatewayErrorCode | "unknown_error" {
  if (error instanceof GatewayError) return error.code;
  const reason: unknown = signal.reason;
  // The reader often rejects with a bare AbortError while the signal carries
  // the actual cause (watchdog deadline, shutdown).
  if (reason instanceof GatewayError) return reason.code;
  if (signal.aborted) {
    if (reason instanceof DOMException && reason.name === "TimeoutError") return "deadline_exceeded";
    return "transport_closed";
  }
  return "unknown_error";
}

/**
 * Whether a failed attempt is a **client cancel** — the one case the console
 * records as `cancelled` (499) rather than `failed`.
 *
 * The request controller aborts for three different reasons, and only one of
 * them is the client's:
 *
 * - **Client disconnect** — the inbound signal bridges the client's
 *   `AbortError`; the request truly has no client left.
 * - **Deadline / stall watchdog** — our own timer aborts with a
 *   `deadline_exceeded` `GatewayError` or a `TimeoutError`. The client is
 *   still there and is owed the 504/502.
 * - **Drain** — a shutdown `GatewayError`; the caller gets a 503.
 *
 * Reading `signal.aborted` alone conflated all three: a request that failed
 * because the upstream ended without a terminal event (`transport_unavailable`,
 * 502) was recorded `cancelled`/499 whenever the watchdog had also fired,
 * producing a row whose status (499), error category (`transport_unavailable`)
 * and http status (502) disagreed — the drawer could not be trusted. The
 * decision must key on *why* the controller aborted, not that it did.
 *
 * A `transport_closed` `GatewayError` is our own "no client left" marker (the
 * attempt loop raises it when the signal is already aborted at entry), so it
 * counts as a cancel even without a signal reason. Every other abort —
 * including a bare `AbortError` whose signal reason is a watchdog/drain
 * `GatewayError` — is a failure, not a cancel.
 */
export function isClientCancellation(error: unknown, signal: AbortSignal): boolean {
  // A typed error names the outcome directly: only our own "no client left"
  // marker is a cancel, whatever the signal says.
  if (error instanceof GatewayError) return error.code === "transport_closed";
  // Otherwise the reader rejected with a bare abort and the signal reason says
  // why. A watchdog (deadline/stall) or drain abort is a gateway-side outcome.
  const reason: unknown = signal.reason;
  if (reason instanceof GatewayError) return false;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return false;
  return signal.aborted && reason instanceof DOMException && reason.name === "AbortError";
}

/** The three terminal fields that must never disagree about one failed attempt. */
export interface TerminalOutcome {
  readonly status: "cancelled" | "failed";
  readonly errorCategory: GatewayErrorCode | "unknown_error";
  readonly errorOrigin: GatewayErrorOrigin;
}

/**
 * Derives a failed attempt's status, error category, and error origin **from
 * one decision**, so the three can never contradict each other.
 *
 * They used to be computed independently at each dispatch call site, and they
 * drifted: a request that failed on an upstream condition could be recorded
 * `cancelled` (499) while its category said `transport_unavailable` and its
 * http status said 502 — a row no operator could trust. Bundling them here
 * makes the inconsistency unrepresentable: a cancel always carries
 * `transport_closed` (the only category a cancel can produce), and any other
 * outcome carries the real code and origin.
 */
export function classifyTerminalOutcome(error: unknown, signal: AbortSignal): TerminalOutcome {
  return {
    status: isClientCancellation(error, signal) ? "cancelled" : "failed",
    errorCategory: classifyTerminalCategory(error, signal),
    // A non-GatewayError outcome has no upstream origin to claim: it is ours.
    errorOrigin: error instanceof GatewayError ? error.origin : "cartethyia",
  };
}

/**
 * Structured upstream identifiers meaning "the request exceeded the model's
 * context window".
 *
 * Matched as exact identifiers on `error.code` / `error.type` (and the same
 * keys at the top level) — never as substrings of a free-text message. A
 * substring rule fires on any message containing the word, including text the
 * client itself wrote, and prose scans for phrases like "context window" or
 * "too many tokens" misfire the same way. Those heuristics
 * mislabel unrelated failures, so we read only the machine-readable field.
 *
 * Consequence, stated plainly: an upstream that reports overflow *only* in
 * prose (Anthropic's `invalid_request_error` with "prompt is too long") is not
 * recognized here and keeps its generic code. That is the deliberate cost of
 * refusing text matching — a wrong `context_length_exceeded` is worse than a
 * missing one, because it tells the client to truncate a prompt that was fine.
 */
const CONTEXT_LENGTH_CODES: ReadonlySet<string> = new Set([
  "context_length_exceeded",
  "context_too_large",
  "model_context_window_exceeded",
]);

/** True when an upstream error body names a context-window overflow. */
export function isContextLengthFailure(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const envelope = isRecord(body.error) ? body.error : body;
  for (const candidate of [envelope.code, envelope.type, body.code, body.type]) {
    if (typeof candidate === "string" && CONTEXT_LENGTH_CODES.has(candidate.toLowerCase())) return true;
  }
  return false;
}
const QUOTA_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
  "quota_exceeded",
  "usage_limit_reached",
  "usage_not_included",
  "subscription:free-usage-exhausted",
  "resource_exhausted",
]);
const CAPACITY_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "overloaded_error",
  "capacity_exhausted",
  "model_at_capacity",
  "server_is_overloaded",
  "model_capacity",
]);
const AUTH_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "authentication_error",
  "invalid_api_key",
  "permission_error",
  "insufficient_scope",
  "unauthenticated",
  "permission_denied",
  "permissiondenied",
]);
const PLATFORM_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "server_error",
  "internal_error",
  "internal_server_error",
  "api_error",
  "service_unavailable",
  "service_unavailable_error",
  "internal",
  "unavailable",
]);
const FRAME_TYPE_IDENTIFIERS: ReadonlySet<string> = new Set([
  "error",
  "response.failed",
  "response.error",
]);

/** Finds a machine-readable provider error code or type without reading prose. */
export function upstreamErrorIdentifier(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const nested = isRecord(body.error) ? body.error : undefined;
  const ext = isRecord(body.extError) ? body.extError : undefined;
  for (const candidate of [ext?.code, nested?.code, body.code]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  for (const candidate of [
    ext?.type,
    nested?.type,
    body.type,
    ext?.status,
    nested?.status,
    body.status,
  ]) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    const normalized = candidate.trim().toLowerCase();
    if (!FRAME_TYPE_IDENTIFIERS.has(normalized) && !/^\d{3}$/.test(normalized))
      return candidate.trim();
  }
  const numericCode = ext?.code ?? nested?.code ?? body.code;
  return typeof numericCode === "number" && Number.isFinite(numericCode)
    ? String(numericCode)
    : undefined;
}

/** Structured classification used consistently by HTTP and in-stream errors. */
export interface UpstreamErrorClassification {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly origin: GatewayErrorOrigin;
  readonly credentialEvidence?: boolean;
  readonly rateLimitScope?: "provider";
}

/** Maps a machine-readable provider identifier before falling back to status alone. */
export function classifyUpstreamError(
  status: number | undefined,
  identifier?: string,
): UpstreamErrorClassification {
  const normalized = identifier?.trim().toLowerCase();
  const upstreamStatus = status ?? 502;
  const serverStatus =
    status !== undefined && status >= 500 && status <= 599 ? status : undefined;
  if (status === 407)
    return { code: "proxy_auth_required", status: 407, origin: "network" };
  if (normalized === "proxy_auth_required" || normalized === "proxy_authentication_error")
    return { code: "proxy_auth_required", status: 407, origin: "network" };
  if (normalized === "11140")
    return { code: "policy_rejected", status: 403, origin: "upstream" };
  if (normalized !== undefined && CONTEXT_LENGTH_CODES.has(normalized))
    return { code: "context_length_exceeded", status: 413, origin: "upstream" };
  if (normalized !== undefined && QUOTA_ERROR_IDENTIFIERS.has(normalized))
    return {
      code: "quota_exceeded",
      status: status === 402 || status === 429 ? status : 429,
      origin: "upstream",
      rateLimitScope: "provider",
    };
  if (normalized !== undefined && AUTH_ERROR_IDENTIFIERS.has(normalized)) {
    let authStatus: number;
    if (status === 401 || status === 403) authStatus = status;
    else if (
      normalized === "permission_error" ||
      normalized === "insufficient_scope" ||
      normalized === "permission_denied" ||
      normalized === "permissiondenied"
    )
      authStatus = 403;
    else authStatus = 401;
    return {
      code: "authentication_failed",
      status: authStatus,
      origin: "upstream",
      credentialEvidence: true,
    };
  }
  if (normalized !== undefined && CAPACITY_ERROR_IDENTIFIERS.has(normalized))
    return {
      code: "capacity_exhausted",
      status: status === 503 || status === 529 ? status : 529,
      origin: "upstream",
    };
  if (normalized !== undefined && PLATFORM_ERROR_IDENTIFIERS.has(normalized))
    return {
      code: "platform_unavailable",
      status: serverStatus ?? 502,
      origin: "upstream",
    };
  if (normalized === "model_not_found")
    return { code: "model_not_found", status: 404, origin: "upstream" };
  if (
    normalized === "not_found_error" ||
    normalized === "resource_not_found" ||
    normalized === "not_found"
  )
    return { code: "upstream_not_found", status: 404, origin: "upstream" };
  if (normalized === "conflict_error" || normalized === "already_exists")
    return { code: "upstream_conflict", status: 409, origin: "upstream" };
  if (normalized === "request_too_large" || normalized === "payload_too_large")
    return { code: "request_too_large", status: 413, origin: "upstream" };
  if (normalized === "unsupported_media_type" || normalized === "invalid_content_type")
    return { code: "unsupported_media_type", status: 415, origin: "upstream" };
  if (normalized === "unprocessable_entity" || normalized === "unprocessable_entity_error")
    return { code: "upstream_unprocessable", status: 422, origin: "upstream" };
  if (
    normalized === "timeout_error" ||
    normalized === "upstream_timeout" ||
    normalized === "deadline_exceeded"
  )
    return { code: "deadline_exceeded", status: 504, origin: "upstream" };
  if (
    normalized === "invalid_request_error" ||
    normalized === "invalid_argument" ||
    normalized === "invalid_parameter" ||
    normalized === "bad_request"
  )
    return { code: "invalid_request", status: 400, origin: "upstream" };
  const code = statusToGatewayErrorCode(upstreamStatus);
  return {
    code,
    status: upstreamStatus,
    origin: code === "proxy_auth_required" ? "network" : "upstream",
    ...(code === "authentication_failed" ? { credentialEvidence: true } : {}),
    ...(upstreamStatus === 429 || upstreamStatus === 529
      ? { rateLimitScope: "provider" as const }
      : {}),
  };
}


/** Converts one failed upstream response into the shared GatewayError contract. */
export async function mapUpstreamHttpError(response: Response, providerId: string): Promise<never> {
  const text = await response.text().catch(() => "");
  let providerCode: string | undefined;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
    providerCode = upstreamProviderCode(parsedBody);
  } catch {
    parsedBody = undefined;
  }
  const identifier = upstreamErrorIdentifier(parsedBody) ?? providerCode;
  const classification = isContextLengthFailure(parsedBody)
    ? { code: "context_length_exceeded" as const, status: 413, origin: "upstream" as const }
    : classifyUpstreamError(response.status, identifier);
  const extracted = extractUpstreamMessage(parsedBody ?? text);
  const message = (extracted.length > 0 ? extracted : text.trim() || `Provider returned HTTP ${response.status}.`).slice(0, MAX_UPSTREAM_ERROR_BYTES).replace(/[\r\n]+/g, " ");
  const retryAfterMs = parseUpstreamBackoff(response.headers);
  const requestId = upstreamRequestId(response.headers);
  const reportedProviderCode = providerCode ?? identifier;
  throw new GatewayError(classification.code, classification.status, message, {
    providerId,
    providerStatus: response.status,
    ...(reportedProviderCode ? { providerCode: reportedProviderCode } : {}),
    ...(requestId ? { upstreamRequestId: requestId } : {}),
    raw: text.slice(0, MAX_UPSTREAM_ERROR_BYTES).replace(/[\r\n]+/g, " "),
    ...(retryAfterMs === null || retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(classification.rateLimitScope
      ? { rateLimitScope: classification.rateLimitScope }
      : {}),
    ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
  }, classification.origin);
}

const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
/** Extracts a bounded human-readable title or text excerpt from an HTML error page. */
export function extractHtmlTitle(html: string): string {
  const match = TITLE_PATTERN.exec(html);
  if (match?.[1]) {
    const title = match[1].replace(/\s+/g, " ").trim();
    if (title) return title;
  }
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Throws a typed transport error when an upstream returns an HTML error page. */
export async function throwIfHtmlResponse(response: Response): Promise<void> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return;
  const body = await response.text().catch(() => "");
  const summary = body ? extractHtmlTitle(body) : `HTTP ${response.status}`;
  // The page came from the upstream (an edge proxy or the origin itself), so
  // it is an upstream failure: attributing it to `cartethyia` made the console
  // blame the gateway for a provider/edge response.
  throw new GatewayError(
    "transport_unavailable",
    502,
    `Upstream returned an HTML error page: ${summary}`.slice(0, 300),
    { upstreamStatus: response.status, contentType },
    "upstream",
  );
}

/** True when fallback routing should try another candidate. */
export function isRetryableFailure(error: unknown): boolean {
  return classifyUpstreamFailure(error).retryable;
}

/**
 * Capped exponential backoff with full jitter for a zero-based attempt index.
 * The base and cap are operator-tunable (`CARTETHYIA_FALLBACK_RETRY_BASE_MS`,
 * `CARTETHYIA_FALLBACK_RETRY_CAP_MS`) and default to 100ms / 2000ms.
 */
export function fallbackRetryDelayMs(attemptIndex: number): number {
  const exp = Math.min(resolveFallbackRetryCapMs(), resolveFallbackRetryBaseMs() * 2 ** attemptIndex);
  return Math.random() * exp;
}

/** Sleeps until the delay expires or the request is aborted. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new GatewayError("transport_closed", 499, "request was cancelled"));
  if (ms <= 0) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new GatewayError("transport_closed", 499, "request was cancelled")); };
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}
