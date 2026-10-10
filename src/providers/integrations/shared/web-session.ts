import type { CanonicalMessage, CanonicalRequest, ContentPart } from "../../../protocol/canonical-model";

/**
 * Flattens one content part to inline text for a web-session prompt.
 *
 * Web sessions take a single rendered prompt rather than a structured body, so
 * every provider that uses one needs the same flattening. `onUnsupported`
 * decides what a part the upstream cannot represent does: substituting a
 * placeholder keeps a mixed conversation renderable, while throwing rejects the
 * request before it reaches the upstream. Both behaviors exist in the tree
 * today, so the choice stays at the call site instead of being unified away.
 */
export function webTextOf(
  part: ContentPart,
  onUnsupported: (part: ContentPart) => string,
): string {
  if (part.kind === "text" || part.kind === "refusal") return part.text;
  if (part.kind === "toolResult") {
    const content =
      typeof part.content === "string"
        ? part.content
        : part.content.map((entry) => webTextOf(entry, onUnsupported)).filter(Boolean).join("\n");
    return `tool_result ${part.call_id}: ${content}`;
  }
  return onUnsupported(part);
}

/** Renders one message as `<role>: <text>` lines, one per non-empty part. */
export function webRenderMessage(
  message: CanonicalMessage,
  onUnsupported: (part: ContentPart) => string,
): string[] {
  const render = (text: string): string =>
    message.role === "system" ? `system: ${text}` : `${message.role}: ${text}`;
  return message.content
    .map((part) => webTextOf(part, onUnsupported))
    .filter(Boolean)
    .map(render);
}

/** Renders a whole request — system block then messages — into one prompt. */
export function webRenderPrompt(
  request: CanonicalRequest,
  onUnsupported: (part: ContentPart) => string,
): string {
  const lines: string[] = [];
  for (const part of request.system ?? []) {
    const text = webTextOf(part, onUnsupported);
    if (text) lines.push(`system: ${text}`);
  }
  for (const message of request.messages) lines.push(...webRenderMessage(message, onUnsupported));
  return lines.join("\n");
}

/** Narrows an unknown JSON value to a record, or an empty record. */
export function webRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads one cookie out of a serialized cookie header; empty when absent. */
export function webCookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}
