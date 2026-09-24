import type { ContentPart } from "../canonical-model";

/** Creates a canonical text content part without applying wire-specific parsing. */
export function textPart(text: string): ContentPart {
  return { kind: "text", text };
}
