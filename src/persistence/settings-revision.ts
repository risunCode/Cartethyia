/**
 * Process-wide runtime-settings revision counter.
 *
 * Single staleness source for per-tenant `console_settings` caching: every
 * mutation bumps it, every cache key includes it, so a write instantly
 * invalidates cached reads (with TTL as the backstop, not the mechanism).
 *
 * Lives in `persistence/settings-revision.ts` — not in `console/stores/runtime-settings.ts` — because
 * the hot path (`transport/dispatch/proxy-request.ts`) reads it on every request and must not
 * import the dashboard persistence layer for a monotonic integer.
 */
let revisionCounter = 0;

/** Current revision; cache keys embed this. */
export function currentSettingsRevision(): number {
  return revisionCounter;
}

/** Bumps the revision after a settings mutation. Returns the new revision. */
export function bumpSettingsRevision(): number {
  revisionCounter += 1;
  return revisionCounter;
}
