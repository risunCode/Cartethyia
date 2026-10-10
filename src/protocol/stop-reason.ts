import type { CanonicalStopReason } from "./canonical-model";

/**
 * Canonical stop reason mapped onto each surface's wire vocabulary.
 *
 * One table, one column per surface. The surfaces genuinely disagree — Chat
 * reports a refusal as `content_filter` so a refusal is never hidden as a
 * usable completion, Messages reports its own `refusal`, and only Messages has
 * a `pause_turn` word — so the divergence is data here rather than four
 * near-identical switch blocks that drift apart.
 *
 * `satisfies` keeps the table exhaustive: a new canonical reason that no column
 * covers fails to compile instead of silently falling through to a default.
 */
const WIRE_STOP_REASONS = {
  chat: {
    stop: "stop",
    length: "length",
    tool_use: "tool_calls",
    content_filter: "content_filter",
    refusal: "content_filter",
    error: "error",
    cancelled: "error",
    pause_turn: "stop",
  },
  messages: {
    stop: "end_turn",
    length: "max_tokens",
    tool_use: "tool_use",
    content_filter: "refusal",
    refusal: "refusal",
    error: "end_turn",
    cancelled: "end_turn",
    pause_turn: "pause_turn",
  },
} satisfies Record<string, Record<CanonicalStopReason, string>>;

export type StopReasonWireFamily = keyof typeof WIRE_STOP_REASONS;

/**
 * Maps a canonical stop reason onto `wire`'s vocabulary, falling back when the
 * terminal carried none: Chat has no null finish_reason and defaults to `stop`,
 * while Messages omits `stop_reason` entirely.
 */
export function canonicalStopReasonToWire(
  wire: StopReasonWireFamily,
  reason: CanonicalStopReason | undefined,
  fallback: string,
): string {
  if (reason === undefined) return fallback;
  return WIRE_STOP_REASONS[wire][reason];
}

/** Chat's finish_reason, defaulting to `stop`. */
export function chatFinishReason(reason: CanonicalStopReason | undefined): string {
  return canonicalStopReasonToWire("chat", reason, "stop");
}

/** Messages' stop_reason, or `null` when the terminal recorded none. */
export function messagesStopReason(reason: CanonicalStopReason | undefined): string | null {
  return reason === undefined ? null : canonicalStopReasonToWire("messages", reason, "end_turn");
}
