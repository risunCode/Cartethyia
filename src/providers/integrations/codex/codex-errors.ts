/**
 * Codex upstream HTTP errors → `GatewayError`. Parses the six
 * `x-codex-*-{used,window,reset}-percent/minutes/at` rate-limit headers,
 * usage/rate-limit error codes, `retry-after`, and canonical
 * upstream-request IDs into structured details the router honors.
 */
import { GatewayError, type GatewayErrorCode } from "../../../transport/gateway-error";
import { parseRetryAfter, extractUpstreamMessage, statusToGatewayErrorCode, upstreamRequestId } from "../../../transport/failure-policy";
import { tryParseJsonObject } from "../../../protocol/primitives";

function toNumberOrUndefined(value: string | null): number | undefined {
  if (value === null || value === undefined || value.trim().length === 0)
    return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toIntOrUndefined(value: string | null): number | undefined {
  if (value === null || value === undefined || value.trim().length === 0)
    return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function mapCodexErrorResponse(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  const parsedForMessage = tryParseJsonObject(text);
  const extracted = extractUpstreamMessage(parsedForMessage ?? text);
  const sanitized =
    extracted.length > 0 ? extracted : `codex upstream returned HTTP ${res.status}`;
  const primaryUsed = toNumberOrUndefined(
    res.headers.get("x-codex-primary-used-percent"),
  );
  const primaryWindow = toIntOrUndefined(
    res.headers.get("x-codex-primary-window-minutes"),
  );
  const primaryReset = toIntOrUndefined(
    res.headers.get("x-codex-primary-reset-at"),
  );
  const secondaryUsed = toNumberOrUndefined(
    res.headers.get("x-codex-secondary-used-percent"),
  );
  const secondaryWindow = toIntOrUndefined(
    res.headers.get("x-codex-secondary-window-minutes"),
  );
  const secondaryReset = toIntOrUndefined(
    res.headers.get("x-codex-secondary-reset-at"),
  );
  const hasRateLimits =
    primaryUsed !== undefined ||
    secondaryUsed !== undefined ||
    primaryWindow !== undefined ||
    secondaryWindow !== undefined;
  const rateLimits = hasRateLimits
    ? {
        primary:
          primaryUsed !== undefined ||
          primaryWindow !== undefined ||
          primaryReset !== undefined
            ? {
                ...(primaryUsed !== undefined
                  ? { used_percent: primaryUsed }
                  : {}),
                ...(primaryWindow !== undefined
                  ? { window_minutes: primaryWindow }
                  : {}),
                ...(primaryReset !== undefined
                  ? { resets_at: primaryReset }
                  : {}),
              }
            : undefined,
        secondary:
          secondaryUsed !== undefined ||
          secondaryWindow !== undefined ||
          secondaryReset !== undefined
            ? {
                ...(secondaryUsed !== undefined
                  ? { used_percent: secondaryUsed }
                  : {}),
                ...(secondaryWindow !== undefined
                  ? { window_minutes: secondaryWindow }
                  : {}),
                ...(secondaryReset !== undefined
                  ? { resets_at: secondaryReset }
                  : {}),
              }
            : undefined,
      }
    : undefined;

  let errorCode: string | undefined;
  let friendlyMessage: string | undefined;
  const parsedBody = tryParseJsonObject(text);
  if (parsedBody !== undefined) {
    const err =
      (parsedBody["error"] as Record<string, unknown> | undefined) ??
      (parsedBody as Record<string, unknown>);
    if (err !== null && typeof err === "object") {
      const codeRaw =
        (err as Record<string, unknown>)["code"] ??
        (err as Record<string, unknown>)["type"];
      if (typeof codeRaw === "string" && codeRaw.length > 0)
        errorCode = codeRaw;
      const messageRaw = (err as Record<string, unknown>)["message"];
      const resetsAt =
        ((err as Record<string, unknown>)["resets_at"] as number | undefined) ??
        primaryReset ??
        secondaryReset;
      const mins =
        resetsAt !== undefined
          ? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000))
          : undefined;
      if (
        errorCode !== undefined &&
        /usage_limit_reached|usage_not_included/i.test(errorCode)
      ) {
        const planType = (err as Record<string, unknown>)["plan_type"];
        const plan =
          typeof planType === "string" && planType.length > 0
            ? ` (${String(planType).toLowerCase()} plan)`
            : "";
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage =
          `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      } else if (
        (errorCode !== undefined && /rate_limit_exceeded/i.test(errorCode)) ||
        res.status === 429
      ) {
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `ChatGPT rate limit exceeded.${when}`.trim();
      }
      // `messageRaw` is intentionally not preferred over the sanitized upstream
      // text when a friendly override is absent — sanitized preserves formatting
      // that consumers rely on and avoids clobbering multi-line details.
      void messageRaw;
    }
  }

  const details: Record<string, unknown> = {};
  const requestId = upstreamRequestId(res.headers);
  if (requestId) details["upstreamRequestId"] = requestId;
  // Retry-after parsing delegates to the account-health kernel (24h clamp
  // included); the x-codex-* rate-limit header parsing above stays local.
  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
  if (retryAfterMs !== null) details["retryAfterMs"] = retryAfterMs;
  if (errorCode !== undefined) {
    details["providerCode"] = errorCode;
    details["code"] = errorCode;
  }
  if (friendlyMessage !== undefined)
    details["friendly_message"] = friendlyMessage;
  if (rateLimits !== undefined) details["rate_limits"] = rateLimits;
  if (primaryUsed !== undefined)
    details["x_codex_primary_used_percent"] = primaryUsed;
  if (secondaryUsed !== undefined)
    details["x_codex_secondary_used_percent"] = secondaryUsed;
  if (primaryReset !== undefined)
    details["x_codex_primary_reset_at"] = primaryReset;
  if (secondaryReset !== undefined)
    details["x_codex_secondary_reset_at"] = secondaryReset;
  if (text.length > 0 && text.length <= 500) details["raw"] = text;

  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  // Delegates to the one canonical table. Codex used to pin every non-auth /
  // rate / proxy status — 5xx included — to `invalid_request`, so a Codex
  // upstream 500 reached the client as "your request was invalid" and telemetry
  // recorded a client fault for an upstream outage.
  const code: GatewayErrorCode = statusToGatewayErrorCode(status);
  if (status === 401 || status === 403) details["credentialEvidence"] = true;
  if (status === 429) details["rateLimitScope"] = "provider";
  const origin = status === 407 ? "network" : "upstream";
  throw new GatewayError(
    code,
    status,
    friendlyMessage ?? sanitized,
    details,
    origin,
  );
}
