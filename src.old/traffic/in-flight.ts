/**
 * In-flight proxy request counter — incremented when a proxy request starts
 * and decremented exactly once when it terminates (success, error, or client
 * abort — every path in `runProxyRequest` funnels through a `finally`).
 *
 * Process-global: the idle-point GC scheduler reads it to find a safe
 * collection moment, and the console surfaces it as a live `inFlight` metric
 * on the overview. Subscribers get a push so the dashboard could update over
 * SSE instead of polling. The listener set is capped — when the cap is
 * reached the oldest subscriber (first inserted) is dropped, matching the
 * V8 Set insertion-order semantics already used by the flight tracker.
 */

const MAX_LISTENERS = 128;

let count = 0;
const providerCounts = new Map<string, number>();
const listeners = new Set<(count: number) => void>();
let notifyScheduled = false;

export function incrementInFlight(): void {
  count += 1;
  scheduleNotify();
}

export function decrementInFlight(): void {
  count = Math.max(0, count - 1);
  scheduleNotify();
}

export function getInFlightCount(): number {
  return count;
}

export function beginProviderInFlight(providerId: string): void {
  providerCounts.set(providerId, (providerCounts.get(providerId) ?? 0) + 1);
  scheduleNotify();
}

export function endProviderInFlight(providerId: string): void {
  const active = providerCounts.get(providerId) ?? 0;
  if (active <= 1) providerCounts.delete(providerId);
  else providerCounts.set(providerId, active - 1);
  scheduleNotify();
}

export function getProviderInFlight(): Array<{ readonly providerId: string; readonly active: number }> {
  return [...providerCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([providerId, active]) => ({ providerId, active }));
}

export function subscribeInFlight(listener: (count: number) => void): () => void {
  if (listeners.size >= MAX_LISTENERS) {
    const oldest = listeners.keys().next();
    if (!oldest.done) listeners.delete(oldest.value as (count: number) => void);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Coalesces notifications via microtask so burst traffic fires at most one listener round per microtask. */
function scheduleNotify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const listener of listeners) listener(count);
  });
}

/** Test-only: reset the shared counter and drop all subscribers between tests. */
export function resetInFlightForTests(): void {
  count = 0;
  providerCounts.clear();
  listeners.clear();
  notifyScheduled = false;
}
