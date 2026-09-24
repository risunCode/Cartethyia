import type { CanonicalRequest } from "../../transport/canonical-model";
import type { ProviderDispatchContext } from "../provider-registry";

const SESSION_HEADERS = [
  "x-conversation-id",
  "x-session-id",
  "x-session-affinity",
  "x-opencode-session",
  "x-claude-code-session-id",
  "prompt_cache_key",
  "prompt-cache-key",
  "session-id",
] as const;

export function resolveInboundSessionId(
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
): string | undefined {
  const headers = context?.request_headers;
  for (const name of SESSION_HEADERS) {
    const value = headers?.[name]?.trim();
    if (value) return value;
  }
  const conversationId = request?.conversation?.conversation_id;
  return typeof conversationId === "string" && conversationId.trim()
    ? conversationId.trim()
    : undefined;
}

/**
 * Canonical prompt-cache affinity, independent of the inbound surface.
 *
 * Chat stores the caller key at `extension:prompt_cache_key` and Responses at
 * `extension:responses.prompt_cache_key`; Messages has neither and carries
 * affinity in `metadata.user_id`. Reading only one of those makes the same
 * conversation miss the upstream cache the moment the client switches wires.
 * Client IP is deliberately absent: it is telemetry, not cache identity.
 */
export function resolvePromptCacheKey(request?: CanonicalRequest): string | undefined {
  const controls = request?.generation_controls;
  for (const name of [
    "extension:prompt_cache_key",
    "extension:responses.prompt_cache_key",
    "extension:metadata_user_id",
  ] as const) {
    const value = controls?.[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return resolveInboundSessionId(undefined, request);
}
