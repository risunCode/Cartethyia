/**
 * Text utils — canonical message-content flattening shared by provider transports.
 *
 * Replaces the previously duplicated `flattenText` copies in the commandcode,
 * cursor, and devin transports. OpenAI-style message content may be a plain
 * string or an array of parts ({ text } objects or raw strings); this collapses
 * either shape into one string.
 */

/**
 * Flatten OpenAI-style message content into a single string.
 *
 * @param separator joiner between array parts — commandcode historically used
 *   "\n" while cursor/devin used ""; callers pass their own to stay bit-identical.
 */
export function flattenMessageText(content: unknown, separator = ""): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join(separator);
  }
  return String(content);
}

/**
 * Extract model ids from an OpenAI/Anthropic-style `/models` payload.
 * Reads `data` or `models` arrays, pulls `id` (or `name`), and drops blanks.
 *
 * @param dedup when true, collapse duplicate ids (providers.ts behavior).
 */
export function extractModelIds(payload: unknown, dedup = false): string[] {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const data = root?.data ?? root?.models;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? ((entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).name) : entry))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return (dedup ? [...new Set(ids)] : ids).slice(0, 200);
}

/**
 * Pull a short text sample out of a non-streaming chat/completions response body
 * for diagnostics. Checks `choices[0].message.content`, `choices[0].text`, then
 * top-level `output_text`.
 */
export function extractResponseSample(body: Record<string, unknown>): string {
  const nested = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : body;
  const choices = nested.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const msg = message as Record<string, unknown>;
        // Prefer final content; fall back to reasoning_content if the
        // model spent its entire budget thinking and emitted no visible text.
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content) return content;
        const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
        if (reasoning) return reasoning;
      }
      const text = (first as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  const outputText = nested.output_text ?? body.output_text;
  if (typeof outputText === "string") return outputText;
  return ""
}
