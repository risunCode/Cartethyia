/**
 * In-flight request de-duplication.
 *
 * When several callers ask for the same resource at the same moment (e.g. two
 * console requests triggering the same version lookup), only one upstream call
 * should run. `dedupeRequest` collapses concurrent calls for an identical key
 * onto one promise and forgets the key once it settles, so a later call starts
 * fresh instead of returning a stale result.
 */

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` for `key`, sharing one in-flight promise across concurrent callers.
 * The entry is removed when the promise settles, so this de-duplicates bursts
 * rather than caching. Failures propagate to every waiter and are not memoized.
 */
export function dedupeRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing as Promise<T>;

  const task = fn().finally(() => {
    // Only clear the entry this call created; a later call may have replaced it.
    if (inFlight.get(key) === task) inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

/** Number of keys currently in flight. Test/observability helper. */
export function inFlightRequestCount(): number {
  return inFlight.size;
}

/** Clears all in-flight keys. Test-only. */
export function resetDeduplicationForTesting(): void {
  inFlight.clear();
}
