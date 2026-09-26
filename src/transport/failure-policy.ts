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
 * This is the single source of truth for every upstream HTTP status. Callers
 * that need an intentional deviation (e.g. an adapter that treats 401/403 as a
 * proxy auth problem) should call this function and then apply their explicit
 * override on top of the result — never restate the table.
 *
 * A second, contradictory table (`statusToErrorCategory`) used to live beside
 * this one and disagreed with it on 5xx and 529. It is gone: the two callers
 * that used it only ever re-derived a code from it, so the disagreement bought
 * nothing and cost a false `proxy_unreachable` label on every generic upstream
 * 5xx (the dashboard reads that code as "network proxy was unreachable").
 *
 * Deliberately absent: a 404 → `model_not_found` branch. An upstream 404 does
 * not mean "model not found" — it also means "that route does not exist here",
 * and the two are indistinguishable without parsing free-text messages, which
 * this taxonomy refuses to do. A 404 body distinguishes a route-level from a
 * model-level miss only in prose, so blanket-mapping 404 would mislabel a
 * route-level misconfiguration as a per-request model problem.
 * `invalid_request` is the honest bucket for an unclassified 4xx.
 */
export function statusToGatewayErrorCode(status: number): GatewayErrorCode {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 429) return "quota_exceeded";
  if (status === 407) return "proxy_auth_required";
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
  const scope = error.origin === "network" ? "network" : credentialEvidence ? "account" : "provider";
  const retryAfterMs = typeof error.details.retryAfterMs === "number" ? error.details.retryAfterMs : undefined;
  const retryable = error.code === "capability_unsupported" || error.code === "model_not_found" || error.code === "admission_unavailable" || error.code === "capacity_exhausted" || error.code === "accounts_unavailable" || error.code === "quota_exceeded" || error.code === "authentication_failed" || error.code === "proxy_auth_required" || error.status === 401 || error.status === 403 || error.status === 429 || (error.status >= 500 && error.status <= 504);
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
  // A named overflow outranks the status bucket: the upstream may send it as a
  // generic 400, where `invalid_request` told the client its syntax was wrong
  // and invited a byte-identical retry that could never fit. The envelope
  // status becomes 413 so a status-only client reads "too large" too, while
  // `providerStatus` below keeps the literal upstream status for diagnostics.
  const contextLength = isContextLengthFailure(parsedBody);
  const code: GatewayErrorCode = contextLength ? "context_length_exceeded" : statusToGatewayErrorCode(response.status);
  const status = contextLength ? 413 : response.status;
  const extracted = extractUpstreamMessage(parsedBody ?? text);
  const message = (extracted.length > 0 ? extracted : text.trim() || `Provider returned HTTP ${status}.`).slice(0, MAX_UPSTREAM_ERROR_BYTES).replace(/[\r\n]+/g, " ");
  const retryAfterMs = parseUpstreamBackoff(response.headers);
  const requestId = upstreamRequestId(response.headers);
  throw new GatewayError(code, status, message, {
    providerId,
    providerStatus: response.status,
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { upstreamRequestId: requestId } : {}),
    raw: text.slice(0, MAX_UPSTREAM_ERROR_BYTES).replace(/[\r\n]+/g, " "),
    ...(retryAfterMs === null || retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(response.status === 429 ? { rateLimitScope: "provider" } : {}),
    ...(response.status === 401 || response.status === 403 ? { credentialEvidence: true } : {}),
  }, response.status === 407 ? "network" : "upstream");
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
