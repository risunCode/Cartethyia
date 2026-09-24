/**
 * In-flight proxy request counter — incremented when the request state store
 * admits a request, decremented exactly once when its state is cleaned up
 * (success, error, or client abort all funnel through `cleanup`, which is
 * idempotent). Pub/sub lets the console push the live count over SSE instead
 * of polling.
 *
 * Process-local: each gateway instance reports its own flights. The floor at
 * zero keeps a missed teardown (a path that never cleans up) from driving
 * the gauge negative; it cannot shrink a leak, only its sign.
 */
import { metrics } from "../../observability/metrics";

let count = 0;
const listeners = new Set<(count: number) => void>();

export function incrementInFlight(): void {
  count += 1;
  metrics.proxy_in_flight.set(count);
  notify();
}

export function decrementInFlight(): void {
  count = Math.max(0, count - 1);
  metrics.proxy_in_flight.set(count);
  notify();
}

export function getInFlightCount(): number {
  return count;
}

export function subscribeInFlight(listener: (count: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener(count);
}

/** Test-only: reset the shared counter and drop all subscribers between tests. */
export function resetInFlightForTests(): void {
  count = 0;
  listeners.clear();
}
