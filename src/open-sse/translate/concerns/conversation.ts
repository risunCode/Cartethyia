import type { ContentBlock, NormalizedMessage } from "../../../application/contracts";
import { messageText } from "../../../application/protocols";

/** Returns visible text blocks without exposing reasoning or native metadata. */
export function visibleTextParts(message: NormalizedMessage): readonly string[] {
  return message.content
    .filter((block) => block.type === "text" && block.text !== undefined)
    .map((block) => block.text ?? "");
}

/** Returns the canonical visible text for a normalized message. */
export function visibleMessageText(message: NormalizedMessage): string {
  return messageText(message);
}

/** Groups tool-result blocks by call ID while preserving source order. */
export function groupToolResults(blocks: readonly ContentBlock[]): ReadonlyMap<string, readonly ContentBlock[]> {
  const grouped = new Map<string, ContentBlock[]>();
  for (const block of blocks) {
    if (block.type !== "tool_result" || block.toolCallId === undefined) continue;
    const current = grouped.get(block.toolCallId);
    if (current === undefined) grouped.set(block.toolCallId, [block]);
    else current.push(block);
  }
  return grouped;
}

/** Returns all ordered tool-result parts, retaining empty and error results. */
export function orderedToolResultParts(message: NormalizedMessage): readonly ContentBlock[] {
  return message.content.filter((block) => block.type === "tool_result");
}
