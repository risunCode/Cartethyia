import type { CanonicalEvent } from "../../protocol/canonical-model";

export interface ReasoningSummaryIdentity {
  readonly itemId?: string;
  readonly outputIndex?: number;
  readonly summaryIndex?: number;
}

/** Returns the source identity of one reasoning-summary delta, if present. */
export function reasoningSummaryIdentity(
  event: CanonicalEvent,
): ReasoningSummaryIdentity | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "reasoning") return undefined;
  if (
    event.item_id === undefined &&
    event.output_index === undefined &&
    event.content.summary_index === undefined
  )
    return undefined;
  return {
    ...(event.item_id === undefined ? {} : { itemId: event.item_id }),
    ...(event.output_index === undefined ? {} : { outputIndex: event.output_index }),
    ...(event.content.summary_index === undefined
      ? {}
      : { summaryIndex: event.content.summary_index }),
  };
}

/** Whether two deltas belong to distinct source summary parts/items. */
export function reasoningSummaryHasBoundary(
  previous: ReasoningSummaryIdentity | undefined,
  current: ReasoningSummaryIdentity | undefined,
): boolean {
  if (previous === undefined || current === undefined) return false;
  return (
    (previous.itemId !== undefined &&
      current.itemId !== undefined &&
      previous.itemId !== current.itemId) ||
    (previous.outputIndex !== undefined &&
      current.outputIndex !== undefined &&
      previous.outputIndex !== current.outputIndex) ||
    previous.summaryIndex !== current.summaryIndex
  );
}

/** Separates distinct summary parts without splitting token fragments. */
export function reasoningSummarySeparator(
  previous: ReasoningSummaryIdentity | undefined,
  current: ReasoningSummaryIdentity | undefined,
  previousText: string | undefined,
  currentText: string,
): string {
  if (!reasoningSummaryHasBoundary(previous, current)) return "";
  if (/\s$/.test(previousText ?? "") || /^\s/.test(currentText)) return "";
  if (/^(?:#{1,6}\s|\*\*|__)/.test(currentText)) return "\n\n";
  if (/\*\*$|__$/.test(previousText ?? "")) return "\n\n";
  if (/[.!?][)"'\]]*$/.test(previousText ?? "")) {
    return /^[A-ZÀ-ÖØ-Þ]/.test(currentText) ? "\n\n" : " ";
  }
  return "";
}
