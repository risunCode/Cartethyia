/**
 * Cross-app constants with a single owner.
 *
 * A constant duplicated per hook drifts silently: one copy gets tuned during a
 * bug fix and the others keep the old value, so identical streams reconnect on
 * different schedules. Anything referenced by more than one module belongs here.
 */

/** Delay before a dropped console SSE stream is re-opened. */
export const STREAM_RETRY_MS = 5_000;
