/**
 * In-flight proxy request counter — incremented when `createRequestTracker`
 * starts a request, decremented exactly once when it terminates (success,
 * error, or client abort — every path in tracker.ts funnels through
 * `persist()`). Pub/sub mirrors `console/logs/ring.ts` so the console can
 * push live updates over SSE instead of polling.
 */

let count = 0;
const listeners = new Set<(count: number) => void>();

export function incrementInFlight(): void {
  count++;
  notify();
}

export function decrementInFlight(): void {
  count = Math.max(0, count - 1);
  notify();
}

export function getInFlightCount(): number {
  return count;
}

export function subscribeInFlight(listener: (count: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener(count);
}

/** Test-only: reset the shared counter and drop all subscribers between tests. */
export function resetInFlightForTests(): void {
  count = 0;
  listeners.clear();
}
