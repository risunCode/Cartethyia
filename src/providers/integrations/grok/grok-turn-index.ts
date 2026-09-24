/**
 * Monotonic per-session turn index for the `x-grok-turn-idx` header.
 *
 * The official `grok` CLI stamps this header with the conversation's prompt
 * index: incremented once per user prompt and re-sent unchanged for every
 * tool-loop iteration of the same prompt. A client that sends only the newest
 * message (delta-style) would otherwise pin the count at `1` forever, which
 * makes the backend treat successive requests as the same turn.
 *
 * `resolveInboundSessionId` already resolves *which* conversation a request
 * belongs to; this module is the only place that remembers *how far* that
 * conversation has advanced, so the count never regresses for one session.
 */

import type { CanonicalRequest } from "../../../transport/canonical-model";

/** Idle window after which a session's remembered index is discarded. */
const SESSION_TTL_MS = 30 * 60_000;

/** Bound on remembered sessions; oldest insertion is evicted past this. */
const MAX_SESSIONS = 5_000;

interface TurnEntry {
  readonly turn: number;
  lastUsedAt: number;
}

const turns = new Map<string, TurnEntry>();

/** User turns in the request, floored at 1 (a turn is never index 0). */
function userTurnCount(request: CanonicalRequest | undefined): number {
  const messages = request?.messages;
  if (!Array.isArray(messages)) return 1;
  let count = 0;
  for (const message of messages) {
    if (message?.role === "user") count += 1;
  }
  return Math.max(1, count);
}

/**
 * Turn index for one dispatch: the payload's own user-turn count, advanced past
 * the last index seen for the same session so it never goes backwards.
 *
 * Without a session id there is nothing to remember, so the payload count is
 * returned as-is.
 */
export function resolveGrokTurnIndex(
  sessionId: string | undefined,
  request: CanonicalRequest | undefined,
): number {
  const fromInput = userTurnCount(request);
  if (sessionId === undefined || sessionId.length === 0) return fromInput;

  const now = Date.now();
  const previous = turns.get(sessionId);
  const remembered =
    previous !== undefined && now - previous.lastUsedAt <= SESSION_TTL_MS
      ? previous.turn
      : undefined;

  // A full-history client already reports the true index; a delta-style client
  // reports 1 every time, so the stored index is advanced by one for it.
  const turn = remembered === undefined ? fromInput : Math.max(fromInput, remembered + 1);

  // Re-insert so the entry is newest for eviction order.
  turns.delete(sessionId);
  if (turns.size >= MAX_SESSIONS) {
    const oldest = turns.keys().next();
    if (!oldest.done) turns.delete(oldest.value);
  }
  turns.set(sessionId, { turn, lastUsedAt: now });
  return turn;
}

/** Test-only: forget every remembered session index. */
export function _resetGrokTurnIndexForTests(): void {
  turns.clear();
}
