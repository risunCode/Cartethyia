// Tool-call ID sanitization for canonical requests.
//
// Anthropic-compatible endpoints require tool_use.id / tool_result.tool_use_id
// to match ^[a-zA-Z0-9_-]+$. Canonical requests may carry provider-native IDs
// with characters those endpoints reject, so IDs are normalized here before a
// strict wire encoder runs. The same original→sanitized mapping is applied to
// both the `toolCall` and its matching `toolResult` so pairing is preserved.

import type { CanonicalRequest } from "../canonical-model";

/** Anthropic tool ID contract: alphanumerics, underscore, hyphen only. */
export const TOOL_ID_PATTERN: RegExp = /^[a-zA-Z0-9_-]+$/;

const INVALID_TOOL_ID_CHARS = /[^a-zA-Z0-9_-]/g;

/**
 * Strips characters Anthropic tool IDs reject. Responses-style composite
 * `call_id|item_id` values are split first (first segment wins), matching
 * the wire builder's composite handling, so both layers agree instead of
 * one stripping the separator the other splits on. Returns `null` when the
 * input is not a non-empty string or nothing valid remains, so callers can
 * fall back to a deterministic generated ID.
 */
export function sanitizeToolId(id: unknown): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const base = id.includes("|") ? (id.split("|")[0] ?? id) : id;
  const sanitized = base.replace(INVALID_TOOL_ID_CHARS, "");
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Deterministic positional tool-call ID. Deterministic (no clock/random) so
 * identical histories produce byte-identical requests — cache-friendly and
 * directly testable.
 */
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName?: string): string {
  const name = toolName ? `_${toolName.replace(INVALID_TOOL_ID_CHARS, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

/**
 * Rewrites every invalid tool-call/tool-result `call_id` to a valid one while
 * keeping call/result pairs matched: an invalid `toolCall` records
 * original→sanitized, and each `toolResult` reuses that mapping. A `toolResult`
 * with no originating call (or a valid one) is left alone; an orphan invalid
 * result is sanitized independently. Returns the same reference when every ID
 * is already valid, otherwise a new request — the input is never mutated.
 */
export function sanitizeRequestToolIds(request: CanonicalRequest): CanonicalRequest {
  const replacements = new Map<string, string>();

  for (const [msgIndex, message] of request.messages.entries()) {
    for (const [partIndex, part] of message.content.entries()) {
      if (part.kind !== "toolCall" || TOOL_ID_PATTERN.test(part.call_id)) continue;
      replacements.set(
        part.call_id,
        sanitizeToolId(part.call_id) ?? generateToolCallId(msgIndex, partIndex, part.name),
      );
    }
  }

  let changed = false;

  const messages = request.messages.map((message, msgIndex) => {
    let messageChanged = false;
    const content = message.content.map((part, partIndex) => {
      if (part.kind === "toolCall") {
        if (TOOL_ID_PATTERN.test(part.call_id)) return part;
        const callId =
          replacements.get(part.call_id) ??
          sanitizeToolId(part.call_id) ??
          generateToolCallId(msgIndex, partIndex, part.name);
        messageChanged = true;
        return { ...part, call_id: callId };
      }
      if (part.kind === "toolResult") {
        if (TOOL_ID_PATTERN.test(part.call_id)) return part;
        const callId =
          replacements.get(part.call_id) ??
          sanitizeToolId(part.call_id) ??
          generateToolCallId(msgIndex, partIndex);
        messageChanged = true;
        return { ...part, call_id: callId };
      }
      return part;
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? { ...request, messages } : request;
}
