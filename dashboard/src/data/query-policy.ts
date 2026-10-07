/**
 * Shared server-state policy for dashboard queries and mutations.
 *
 * Keeping these defaults in one module prevents a hook from silently drifting
 * from the application-wide cache behavior. Sensitive data remains opt-in at
 * each hook and is never prefetched by this policy.
 */
export const DASHBOARD_QUERY_OPTIONS = {
  staleTime: 10_000,
  gcTime: 120_000,
  retry: false,
  refetchOnWindowFocus: false,
} as const;

export const DASHBOARD_MUTATION_OPTIONS = {
  retry: 0,
} as const;

/**
 * How often a live surface re-reads. The number is the contract: a counter
 * the operator is watching moves every few seconds, a list that changes on
 * mutation can wait a minute. Name the cadence at the call site instead of
 * inlining the milliseconds, so two hooks watching the same kind of thing
 * cannot drift apart unnoticed.
 */
export const POLL = {
  /** A page that is filling in and should converge within a second or two. */
  warming: 2_000,
  /** A counter or feed the operator is watching right now. */
  live: 5_000,
  /** Health and status that should feel current but is not a ticker. */
  status: 10_000,
  /** A catalog or overview that changes on mutation, polled as a backstop. */
  catalog: 60_000,
} as const;
