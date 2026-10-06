/**
 * Claude upstream error → canonical GatewayError mapping.
 *
 * Both transport paths use the shared structured classifier for non-2xx HTTP
 * responses (`mapClaudeHttpError`) and in-stream SSE `type: error` frames
 * (`mapClaudeStreamError`). Each path keeps its own envelope extraction; the
 * classifier is the single authority for codes, retries, and credential
 * evidence.
 */
import { GatewayError } from "./gateway-error";
import {
  classifyUpstreamError,
  extractUpstreamMessage,
  upstreamErrorIdentifier,
  upstreamRequestId,
} from "../transport/failure-policy";
import { isRecord } from "./codecs";

interface ClaudeErrorExtras {
  readonly providerCode?: string;
  readonly requestId?: string;
}

/** Shared structured classification for both the HTTP and SSE error paths. */
function claudeErrorFromStatus(
  status: number,
  message: string,
  extras: ClaudeErrorExtras = {},
): GatewayError {
  const classification = classifyUpstreamError(status, extras.providerCode);
  const details = {
    upstreamStatus: status,
    ...(extras.providerCode ? { providerCode: extras.providerCode } : {}),
    ...(extras.requestId ? { upstreamRequestId: extras.requestId } : {}),
    raw: message,
    ...(classification.rateLimitScope
      ? { rateLimitScope: classification.rateLimitScope }
      : {}),
    ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
  };
  return new GatewayError(
    classification.code,
    classification.status,
    message,
    details,
    classification.origin,
  );
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
  const providerCode = upstreamErrorIdentifier(parsedBody);
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
  const providerCode = upstreamErrorIdentifier(error);
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
