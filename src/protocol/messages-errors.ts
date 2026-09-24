/**
 * Claude upstream error → canonical GatewayError mapping.
 *
 * Both transport paths share one status→code table: non-2xx HTTP responses
 * (`mapClaudeHttpError`) and in-stream SSE `type: error` frames
 * (`mapClaudeStreamError`). Each path keeps its own envelope extraction; the
 * classification below is the single authority for codes, retry hints, and
 * credential evidence.
 */
import { GatewayError } from "../transport/gateway-error";
import { extractUpstreamMessage, statusToGatewayErrorCode, upstreamRequestId } from "../transport/failure-policy";
import { isRecord } from "./primitives";

interface ClaudeErrorExtras {
  readonly providerCode?: string;
  readonly requestId?: string;
}

/** Shared status→code classification for both the HTTP and SSE error paths. */
function claudeErrorFromStatus(
  status: number,
  message: string,
  extras: ClaudeErrorExtras = {},
): GatewayError {
  const details = {
    upstreamStatus: status,
    ...(extras.providerCode ? { providerCode: extras.providerCode } : {}),
    ...(extras.requestId ? { upstreamRequestId: extras.requestId } : {}),
    raw: message,
    ...(status === 429 ? { rateLimitScope: "provider" } : {}),
    ...(status === 401 || status === 403 ? { credentialEvidence: true } : {}),
  };
  const code = statusToGatewayErrorCode(status);
  if (code === "proxy_auth_required") {
    return new GatewayError(code, status, message, details, "network");
  }
  const enrichedDetails =
    code === "capacity_exhausted" ? { ...details, rateLimitScope: "provider" } : details;
  return new GatewayError(code, status, message, enrichedDetails, "upstream");
}

/**
 * Maps Claude HTTP failures to canonical gateway errors so handler
 * retry/account-health logic matches on codes, never message text.
 * Streaming JSON 401/429/5xx responses flow through here exactly like
 * non-streaming ones; only actual SSE `type: error` frames are stream
 * event failures.
 */
export function mapClaudeHttpError(status: number, body: string, headers?: Headers): GatewayError {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = undefined;
  }
  const extracted = extractUpstreamMessage(parsedBody ?? body);
  const message = extracted.length > 0 ? extracted : `claude error ${status}`;
  let providerCode: string | undefined;
  try {
    const parsedRecord = isRecord(parsedBody) ? parsedBody : undefined;
    const envelope =
      parsedRecord !== undefined && "error" in parsedRecord
        ? parsedRecord.error
        : parsedBody;
    if (isRecord(envelope) && typeof envelope.code === "string") providerCode = envelope.code;
  } catch {
    // The bounded body remains available as the safe upstream detail.
  }
  const requestId = upstreamRequestId(headers);
  return claudeErrorFromStatus(status, message, {
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * Maps one SSE `type: error` frame into a canonical gateway error. The caller
 * unwraps the frame first (the payload may be `{ error: {...} }` or the error
 * object itself), matching the non-streaming envelope shape.
 */
export function mapClaudeStreamError(error: unknown, headers?: Headers): GatewayError {
  const status =
    isRecord(error) && typeof error.status === "number" ? error.status : 502;
  const providerCode =
    isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const message =
    isRecord(error) && typeof error.message === "string"
      ? error.message
      : "Claude stream returned an error";
  const requestId = upstreamRequestId(headers);
  return claudeErrorFromStatus(status, message.slice(0, 500), {
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { requestId } : {}),
  });
}
