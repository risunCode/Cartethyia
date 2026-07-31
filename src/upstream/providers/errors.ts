/**
 * Provider error types and helpers — classification, extraction, and
 * factory for `ProviderCallError`. Shared by every provider transport
 * and by `simple-call.ts` / `callMaterializingProvider`.
 */

import { UpstreamError } from "../error";

export { UpstreamError } from "../error";

export class ProviderCallError extends Error {
  status: number;
  kind: "authentication" | "invalid_request" | "rate_limited" | "unavailable" | "malformed_response";

  constructor(
    status: number,
    kind: "authentication" | "invalid_request" | "rate_limited" | "unavailable" | "malformed_response",
    message: string
  ) {
    super(message);
    this.status = status;
    this.kind = kind;
  }

  toUpstreamError(): UpstreamError {
    return new UpstreamError(this.message, this.status, "");
  }
}

/**
 * Canonical HTTP status → `ProviderCallError` kind mapping. Every provider
 * transport hits the same upstream failure classes (auth, rate limit,
 * generic 4xx, everything else); this is the single place that decides how
 * a raw status maps to one.
 */
export function classifyUpstreamStatus(status: number): "authentication" | "invalid_request" | "rate_limited" | "unavailable" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

/**
 * Reads a Response body for error-message extraction without ever throwing —
 * a body can legitimately fail to read (already consumed, connection reset
 * mid-stream, a test double reusing one Response instance across calls) and
 * that failure must never mask the real HTTP status/error being reported.
 */
export async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Best-effort extraction of the actual error text an upstream API returned,
 * so a caller sees e.g. "Insufficient balance" instead of a generic
 * "<Provider> rejected this request." wrapper that hides what's actually
 * wrong. Handles the common OpenAI/Anthropic-style `{error:{message}}`
 * shape, a bare `{message}`/`{error:"..."}}`, and falls back to the raw
 * body text (truncated) for a plain-text error response.
 */
export function extractUpstreamErrorMessage(bodyText: string, maxLen = 300): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === "string" && err.trim()) return err.trim().slice(0, maxLen);
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, maxLen);
      }
      if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim().slice(0, maxLen);
      if (typeof obj.detail === "string" && obj.detail.trim()) return obj.detail.trim().slice(0, maxLen);
    }
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}\u2026` : trimmed;
}

/**
 * Canonical provider HTTP failure factory. Every simple provider transport
 * (Kimchi, Qoder, Command Code, OpenCode Zen) threw the same four-branch
 * template with only the provider name — and occasionally the auth
 * message — varying; this is the single source for that shape. Prefers the
 * upstream's own error text (from `bodyText`) over the generic wrapper
 * whenever the response body actually says something.
 */
export function providerHttpError(status: number, provider: string, authMessage?: string, bodyText?: string): ProviderCallError {
  const kind = classifyUpstreamStatus(status);
  const upstreamMessage = bodyText ? extractUpstreamErrorMessage(bodyText) : undefined;
  if (kind === "authentication") return new ProviderCallError(status, kind, authMessage ?? upstreamMessage ?? `${provider} rejected the supplied credential.`);
  if (kind === "rate_limited") return new ProviderCallError(status, kind, upstreamMessage ?? `${provider} is rate-limiting this request.`);
  if (kind === "invalid_request") return new ProviderCallError(status, kind, upstreamMessage ?? `${provider} rejected this request.`);
  // Preserve the upstream's own status (500, 503, ...) instead of collapsing
  // every non-4xx failure to a hardcoded 502 — callers checking for a
  // specific relayed status (retry logic, tests) rely on it coming through.
  return new ProviderCallError(status, kind, upstreamMessage ?? `${provider} is unavailable.`);
}
