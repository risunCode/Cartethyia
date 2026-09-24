/**
 * OpenAI-family in-stream error frames → typed `GatewayError`.
 *
 * A `200 OK` whose SSE body carries an explicit error envelope is an upstream
 * failure that arrived *after* the status line. The chat, responses, and codex
 * decoders used to record it only as a terminal `state: "failed"`, which left
 * the client with no `error.code`, no message, and telemetry with the
 * `unknown_error` category — while the Claude (`messages.ts`) and Gemini
 * decoders already threw for the identical event. This module is the one
 * classifier those surfaces share.
 *
 * Classification reads **structured identifiers only** (`error.type`,
 * `error.code`, a numeric `error.status`) and never message prose. A substring
 * rule like `{ text: "capacity" }` fires on any message containing the word —
 * including text the client itself wrote — and scanning for phrases such as
 * "context window" in prose misfires the same way. A frame we cannot classify
 * beyond "the upstream declared a failure" becomes `platform_unavailable`,
 * which is honest: the upstream failed and we do not know more.
 */
import { GatewayError } from "../transport/gateway-error";
import { extractUpstreamMessage, isContextLengthFailure, statusToGatewayErrorCode } from "../transport/failure-policy";
import { isRecord } from "./primitives";

/**
 * Provider identifiers for a rate limit or exhausted quota. These are the
 * names the OpenAI-compatible family actually emits in `error.type` /
 * `error.code`.
 */
const QUOTA_IDENTIFIERS: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
  "quota_exceeded",
  "usage_limit_reached",
  "usage_not_included",
]);

/** Provider identifiers for an upstream outage or overloaded backend. */
const OVERLOAD_IDENTIFIERS: ReadonlySet<string> = new Set([
  "overloaded_error",
  "server_error",
  "internal_error",
  "api_error",
  "service_unavailable",
  "capacity_exhausted",
  "model_at_capacity",
  "server_is_overloaded",
]);

/** Provider identifiers for a rejected credential. */
const AUTH_IDENTIFIERS: ReadonlySet<string> = new Set([
  "authentication_error",
  "invalid_api_key",
  "permission_error",
  "insufficient_scope",
]);

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

function numericStatus(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 400 && candidate < 600)
      return candidate;
  }
  return undefined;
}

/**
 * Frame discriminators that are not error identifiers. A top-level
 * `{"type":"error","code":"rate_limit_exceeded"}` frame uses `type` to name the
 * *frame*, so reading it as the error identifier shadowed the real `code`.
 */
const FRAME_TYPE_VALUES: ReadonlySet<string> = new Set([
  "error",
  "response.failed",
  "response.error",
]);

/**
 * Classifies one error envelope pulled out of a 200-OK stream into the shared
 * `GatewayError` contract, or `undefined` when the frame carries no error.
 *
 * The caller unwraps the envelope first (`json.error`, or `response.error` for
 * a `response.failed` frame), so this function only ever sees the error object
 * itself. `label` is the per-surface fallback message an operator uses to tell
 * which upstream produced the failure.
 */
export function gatewayErrorFromStreamError(
  error: unknown,
  label: string,
): GatewayError | undefined {
  if (error === undefined || error === null) return undefined;
  // Cline-style `{"error": "Not Found"}`: the upstream declared a failure with
  // no structure to classify it by.
  if (typeof error === "string") {
    return new GatewayError("platform_unavailable", 502, error.slice(0, 500) || label, {}, "upstream");
  }
  if (!isRecord(error)) return undefined;

  const message = extractUpstreamMessage(error);
  const rawType = firstString(error["type"])?.toLowerCase();
  const type = rawType !== undefined && FRAME_TYPE_VALUES.has(rawType) ? undefined : rawType;
  const identifier = type ?? firstString(error["code"])?.toLowerCase();
  // A frame that names a context overflow outranks everything else: the client
  // must shorten the prompt, and a retry of the same bytes cannot succeed.
  if (isContextLengthFailure(error)) {
    return new GatewayError("context_length_exceeded", 413, message || label, { providerCode: identifier }, "upstream");
  }
  const explicitStatus = numericStatus(error["status"], error["statusCode"], error["status_code"]);
  if (explicitStatus !== undefined) {
    const code = statusToGatewayErrorCode(explicitStatus);
    return new GatewayError(code, explicitStatus, message || label, { providerStatus: explicitStatus, ...(identifier ? { providerCode: identifier } : {}) }, "upstream");
  }
  if (identifier !== undefined) {
    if (QUOTA_IDENTIFIERS.has(identifier))
      return new GatewayError("quota_exceeded", 429, message || label, { providerCode: identifier, rateLimitScope: "provider" }, "upstream");
    if (AUTH_IDENTIFIERS.has(identifier))
      return new GatewayError("authentication_failed", 401, message || label, { providerCode: identifier, credentialEvidence: true }, "upstream");
    if (OVERLOAD_IDENTIFIERS.has(identifier))
      return new GatewayError("platform_unavailable", 502, message || label, { providerCode: identifier }, "upstream");
  }
  // The upstream declared a failure inside a 200 OK. Without a recognizable
  // identifier the honest classification is "the upstream failed".
  return new GatewayError("platform_unavailable", 502, message || label, { ...(identifier ? { providerCode: identifier } : {}) }, "upstream");
}
