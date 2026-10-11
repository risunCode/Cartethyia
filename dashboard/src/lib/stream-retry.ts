/**
 * Reconnect delay for a dropped SSE stream.
 *
 * One value for every stream in the dashboard — the console log tail, the live
 * pool feed, and the share page's stats subscription — because a duplicated
 * constant drifts: one copy gets tuned during a bug fix and the others keep the
 * old value, so identical streams reconnect on different schedules and the one
 * that tuned looks fixed while the others hammer the gateway.
 */
export const STREAM_RETRY_MS = 5_000;
