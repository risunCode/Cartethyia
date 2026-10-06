import type { CanonicalRequest, ContentPart } from "../../protocol/canonical-model";
import type { ProviderDispatchContext } from "../contracts";
import { createHash } from "node:crypto";
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
  if (typeof conversationId === "string" && conversationId.trim()) {
    return conversationId.trim();
  }
  // When the client sends no session header or conversation ID, derive a stable
  // affinity key from the opening turn (system prompt or first user turn).
  // This enables prompt-cache hits across turns for stateless HTTP clients.
  return deriveConversationAffinity(request);
}

function deriveConversationAffinity(request?: CanonicalRequest): string | undefined {
  if (!request) return undefined;
  // If request has system prompt, use that
  if (request.system && request.system.length > 0) {
    const text = request.system
      .map((p: ContentPart) => (p.kind === "text" ? p.text : ""))
      .join("");
    if (text.trim().length >= 30) {
      return `aff_${createHash("sha256").update(text.trim().slice(0, 2048)).digest("hex").slice(0, 24)}`;
    }
  }
  // Otherwise use the first message
  const first = request.messages[0];
  if (!first) return undefined;
  const firstText = first.content
    .map((p: ContentPart) => (p.kind === "text" ? p.text : ""))
    .join("");
  if (firstText.trim().length >= 30) {
    return `aff_${createHash("sha256").update(firstText.trim().slice(0, 2048)).digest("hex").slice(0, 24)}`;
  }
  return undefined;
}

/**
 * Canonical prompt-cache affinity, independent of the inbound surface.
 *
 * Chat stores the caller key at `extension:prompt_cache_key` and Responses at
 * `extension:responses.prompt_cache_key`; Messages has neither and carries
 * affinity in `metadata.user_id`. Dispatch context then supplies inbound
 * session headers (`x-session-id`, `session-id`, `prompt-cache-key`, …).
 * Reading only one of those makes the same conversation miss the upstream
 * cache the moment the client switches wires. Client IP is deliberately
 * absent: it is telemetry, not cache identity.
 */
export function resolvePromptCacheKey(
  request?: CanonicalRequest,
  context?: ProviderDispatchContext,
): string | undefined {
  const controls = request?.generation_controls;
  for (const name of [
    "extension:prompt_cache_key",
    "extension:responses.prompt_cache_key",
    "extension:metadata_user_id",
  ] as const) {
    const value = controls?.[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return resolveInboundSessionId(context, request);
}
