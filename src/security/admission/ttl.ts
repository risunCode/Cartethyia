/**
 * Lease and counter lifetimes, and the calendar bucket keys they key on.
 *
 * These live together because they are one arithmetic problem: a counter
 * must outlive the lease that charges it, and a lease key must outlive the
 * horizon the sweeper reads. Splitting them across files is how those
 * invariants silently break, so the reasoning stays in one place.
 */
export const LEASE_TTL_MS = 3600_000;

/**
 * The lease key's own Redis TTL is deliberately LONGER than the `expires_at`
 * horizon the lease hash records.
 *
 * `expires_at` is the moment the sweeper becomes allowed to reclaim the lease.
 * If the key TTL equalled that horizon, Redis would evict the hash at exactly
 * the moment `reapIfExpired` wanted to read it: `HGET state` would return nil,
 * the sweep would skip it, and a crash between reserve and release would strand
 * the held concurrency / tenant-concurrency slot for as long as the counter
 * keeps being refreshed — every later reserve re-arms the counter's own TTL, so
 * a key still in use never recovers its leaked slot. The grace window keeps the
 * hash readable for several sweep intervals past the horizon, so the recovery
 * path actually runs.
 *
 * Exported so the invariant is asserted directly: a lease key must outlive the
 * horizon it records by more than one sweep interval (`sweepLeases` runs every
 * 30s, wired in `runtime/dependencies.ts`).
 */
const LEASE_TTL_GRACE_SECONDS = 120;
/** Seconds after which a lease hash is reapable (`expires_at` horizon). */
export const LEASE_REAP_HORIZON_SECONDS = Math.ceil(LEASE_TTL_MS / 1000);
/** Seconds the lease hash itself lives; must exceed the reap horizon. */
export const LEASE_KEY_TTL_SECONDS = LEASE_REAP_HORIZON_SECONDS + LEASE_TTL_GRACE_SECONDS;

/**
 * TTLs for the token-budget counters, in seconds.
 *
 * Daily lives just past two days (a day bucket plus slack to cover a request
 * straddling midnight); monthly and lifetime share one 35-day window — long
 * enough that a month bucket is never evicted mid-month, and it is the *only*
 * thing bounding `admission:lifetime:*`, which has no natural bucket to expire
 * on. Every writer below must therefore carry its own TTL: a plain `SET`
 * without one creates a key that outlives every bucket it feeds.
 */
export const DAILY_COUNTER_TTL_SECONDS = 172800;
export const MONTHLY_COUNTER_TTL_SECONDS = 3024000;
export const LIFETIME_COUNTER_TTL_SECONDS = 3024000;
/** RPM window plus slack; concurrency slots are held for the request duration. */
export const RPM_WINDOW_TTL_SECONDS = 65;
// Must exceed the lease's own lifetime (`LEASE_TTL_MS` + grace), otherwise a
// request held longer than this lets its concurrency counter expire underneath
// a still-live lease and a later reserve INCRs from zero. Derived rather than
// hard-coded so raising the lease TTL cannot silently reopen the hole.
export const CONCURRENCY_TTL_SECONDS = LEASE_KEY_TTL_SECONDS;

export function dailyBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
export function monthlyBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}
