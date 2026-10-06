/**
 * Conservative token estimation for admission reservation.
 *
 * The canonical request is model-agnostic: the tokenizer that would price it
 * exactly belongs to the upstream, which has not been chosen yet at admission
 * time, so input is priced in characters (÷4) with flat reserves for parts
 * that carry no text.
 */
import type { CanonicalRequest, ContentPart } from "../../protocol/canonical-model";

/** Reserved output budget when the request names no explicit ceiling. */
export const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 1024;

/**
 * A non-text part's rough token weight, in characters.
 *
 * Tool results, documents, images and audio carry no `text` field, so a
 * text-only walk priced them at zero and a request whose weight was mostly a
 * pasted document or a large tool result could be admitted while its true
 * usage was far above the reserved estimate. Binary payloads have no honest
 * character count, so they get a flat per-part reserve instead — enough that
 * an image- or audio-heavy turn is not free.
 */
const NON_TEXT_PART_CHARS: Record<string, number> = {
  image: 1_500,
  audio: 1_500,
};

function partChars(part: ContentPart): number {
  switch (part.kind) {
    case "text":
      return part.text.length;
    case "refusal":
      return part.text.length;
    case "reasoning":
      return part.summary?.length ?? 0;
    case "toolCall": {
      // The call name and its arguments both go upstream as text.
      let length = part.name.length;
      try {
        length += JSON.stringify(part.arguments ?? "").length;
      } catch {
        // A circular or unserializable argument is priced by its name alone.
      }
      return length;
    }
    case "toolResult": {
      if (typeof part.content === "string") return part.content.length;
      return part.content.reduce((sum, nested) => sum + partChars(nested), 0);
    }
    case "file": {
      // The payload is inlined base64 or a URL reference; neither has a token
      // count derivable from its length, so price a flat reserve like an image
      // plus any human-readable label.
      return (
        (NON_TEXT_PART_CHARS[part.kind] ?? 1_500) +
        (part.filename?.length ?? 0) +
        (part.url?.length ?? 0)
      );
    }
    case "document": {
      return (
        (NON_TEXT_PART_CHARS[part.kind] ?? 1_500) +
        (part.title?.length ?? 0) +
        (part.url?.length ?? 0)
      );
    }
    case "extension":
      return 0;
    default:
      return NON_TEXT_PART_CHARS[part.kind] ?? 0;
  }
}

export function estimateInputTokens(request: CanonicalRequest): number {
  let chars = 0;
  for (const part of request.system ?? []) chars += partChars(part);
  for (const part of request.instructions ?? []) chars += partChars(part);
  for (const message of request.messages)
    for (const part of message.content) chars += partChars(part);
  return Math.max(1, Math.ceil(chars / 4));
}
