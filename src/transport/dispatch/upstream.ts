import type { ValidatedOutboundFetch } from "../../providers/provider-registry";
import { GATEWAY_SECURITY_HEADERS } from "../../security/outbound-headers";

const FORWARDED_REQUEST_HEADERS = new Set([
  "user-agent",
  "anthropic-beta",
  "x-claude-code-session-id",
  "x-conversation-id",
  "x-session-id",
  "x-session-affinity",
  "x-opencode-session",
  "prompt-cache-key",
  "prompt_cache_key",
  "session-id",
]);

export function forwardedRequestHeaders(request: Request): Record<string, string> {
  const forwarded: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) forwarded[name.toLowerCase()] = value;
  });
  return forwarded;
}

export function proxySuccessHeaders(state: { requestId: string }): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-request-id": state.requestId,
    ...GATEWAY_SECURITY_HEADERS,
  };
}

export function buildUpstreamDispatchContext(input: {
  readonly credential: unknown;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly headers: Record<string, string>;
  readonly outboundFetch?: ValidatedOutboundFetch;
}): Record<string, unknown> {
  return {
    credential: input.credential,
    deadline: input.deadline,
    abort_signal: input.signal,
    ...(Object.keys(input.headers).length > 0 ? { request_headers: input.headers } : {}),
    ...(input.outboundFetch ? { outbound_fetch: input.outboundFetch } : {}),
  } as Record<string, unknown>;
}