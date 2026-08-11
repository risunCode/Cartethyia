import type { ContentBlock, StreamEvent } from "../../../application/contracts";
import { isRecord } from "../../../application/protocols";

const MAX_REASONING_TEXT = 64 * 1024;

/** Builds a bounded non-visible reasoning content block. */
export function createReasoningBlock(input: {
  readonly text?: string;
  readonly encryptedContent?: string;
  readonly summary?: readonly Readonly<Record<string, unknown>>[];
  readonly raw?: Readonly<Record<string, unknown>>;
}): ContentBlock {
  const text = input.text === undefined ? undefined : input.text.slice(0, MAX_REASONING_TEXT);
  const encryptedContent = input.encryptedContent === undefined ? undefined : input.encryptedContent.slice(0, MAX_REASONING_TEXT);
  const summary = input.summary === undefined ? undefined : input.summary.slice(0, 128).map((item) => ({ ...item }));
  return {
    type: "reasoning",
    ...(text === undefined ? {} : { reasoningText: text }),
    ...(encryptedContent === undefined ? {} : { reasoningEncryptedContent: encryptedContent }),
    ...(summary === undefined ? {} : { reasoningSummary: summary }),
    ...(input.raw === undefined ? {} : { raw: input.raw }),
  };
}

/** Extracts visible summary text from an event sequence without exposing encrypted content. */
export function reasoningTextFromEvents(events: readonly StreamEvent[]): string {
  let text = "";
  for (const event of events) if (event.type === "thinking_delta") text += event.text;
  return text;
}

/** Validates and bounds a native reasoning summary list. */
export function boundedReasoningSummary(value: unknown): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Readonly<Record<string, unknown>>[] = [];
  for (const item of value.slice(0, 128)) {
    if (!isRecord(item)) continue;
    entries.push({ ...item });
  }
  return entries;
}
