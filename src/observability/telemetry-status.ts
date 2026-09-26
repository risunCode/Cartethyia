/**
 * The single definition of which requests count as *gateway* errors.
 *
 * Six independent sites used to answer this question with their own copy of
 * `status in ('failed', 'truncated')`: the usage summary, the health window,
 * the usage breakdown, the retained-usage rollup (`telemetry_usage_totals`),
 * the public share page, and the client-IP breakdown. A definition spread over
 * six predicates is not a definition — it is six chances to drift, and the
 * rollup made the drift durable: once a request is counted into
 * `telemetry_usage_totals.errors` it stays counted after the raw row is pruned.
 *
 * The rule, stated as a principle rather than a list of codes:
 *
 * **A request counts against the gateway only when the gateway itself failed
 * to do its job.** Everything else is somebody else's outcome, and is recorded
 * and displayed but never counted.
 *
 * That principle decides every case:
 *
 * - **Any `4xx` is the caller's outcome, never the gateway's.** A `4xx` means
 *   the request was refused, not that the gateway malfunctioned. This matters
 *   most where it is cheap to generate: a `401` from a bogus key, a `404` from
 *   an unregistered `/v1/*` path, a `429` from the caller's own quota, and a
 *   `413` from an oversized body all cost the sender nothing and reach no
 *   provider, so counting any of them hands an abuser a free way to inflate
 *   the error rate. Enumerating "the bad ones" was the previous approach and it
 *   missed `401`/`429`; excluding the class cannot miss one.
 * - **`499`** is a client abort (`transport_closed`). The client leaving is
 *   expected behavior — the request may even have been served — and it is
 *   tracked as its own count. Being below `500`, it is excluded by the class
 *   rule as well, so it needs no special case.
 * - **`503`** is capacity or availability: the gateway *correctly* refusing work
 *   it cannot do right now (`admission_unavailable`, `accounts_unavailable`,
 *   `shutting_down`, `platform_unavailable`). Retryable, self-inflicted, and an
 *   operator-capacity signal rather than a defect. It is the one `5xx` that is
 *   not a gateway defect, so it is named explicitly.
 * - **`500`, `502`, `504`** — an internal error, a stream that ended before
 *   completion, a deadline that expired — are the gateway failing at its job.
 *   These count.
 *
 * Excluded requests are still recorded, still rendered in the Requests table,
 * still filterable, and still openable in the detail drawer. "Not an error"
 * means "not counted against the gateway", never "not logged".
 *
 * Kept free of runtime layer imports so both `persistence` (the rollup) and
 * `console` (the read models) can share it without a layer cycle.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** The lifecycle statuses that can represent a gateway failure. */
export const GATEWAY_ERROR_STATUSES = ["failed", "truncated"] as const;

/**
 * The first HTTP status that represents a server-side failure. Everything below
 * is a client outcome and is excluded by class; see the module doc for why that
 * is a class rule rather than an enumerated list.
 */
export const GATEWAY_ERROR_HTTP_MIN = 500;

/**
 * The `5xx` statuses that are *not* gateway defects, even though they are
 * server errors: capacity and availability. Named explicitly because they are
 * the only exceptions above `GATEWAY_ERROR_HTTP_MIN`.
 */
export const CAPACITY_HTTP_STATUSES = [503] as const;

const CAPACITY_HTTP_STATUS_SET: ReadonlySet<number> = new Set(CAPACITY_HTTP_STATUSES);

/**
 * Whether a terminal lifecycle status represents a gateway failure, before the
 * HTTP status refinement below. `cancelled` and `completed` do not; a status
 * outside the enum (`null` on a row written before the column, or a future
 * state) does **not** count either.
 *
 * Excluding an unknown status is deliberate, and it is what makes this
 * predicate agree with the SQL form below. `status in ('failed','truncated')`
 * evaluates to NULL — therefore not counted — for a NULL or unrecognized
 * status, so treating one as an error here would make the row-level answer and
 * the aggregate answer disagree on exactly those rows. Since the aggregate
 * feeds the durable rollup, a disagreement is uncorrectable after pruning.
 * "Unknown" means "we cannot claim this was the gateway's fault".
 */
export function isGatewayErrorStatus(status: string | null | undefined): boolean {
  return (GATEWAY_ERROR_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Whether an HTTP status is a gateway defect: a `5xx` that is not one of the
 * capacity/availability statuses.
 */
export function isGatewayErrorHttpStatus(httpStatus: number): boolean {
  return httpStatus >= GATEWAY_ERROR_HTTP_MIN && !CAPACITY_HTTP_STATUS_SET.has(httpStatus);
}

/**
 * Whether one terminal request counts as a gateway error.
 *
 * Both halves must hold: the lifecycle status must be a failure, and the wire
 * status must be a server-side defect. `httpStatus` is optional because rows
 * written before the column existed carry only the lifecycle status; those fall
 * back to the lifecycle answer, which is the conservative reading for
 * historical data.
 */
export function isGatewayError(
  status: string | null | undefined,
  httpStatus?: number | null,
): boolean {
  if (!isGatewayErrorStatus(status)) return false;
  if (httpStatus === undefined || httpStatus === null) return true;
  return isGatewayErrorHttpStatus(httpStatus);
}

/**
 * SQL predicate matching the requests that count as gateway errors, for the
 * aggregate queries that must not materialize rows into the heap.
 *
 * Derived from the same constants `isGatewayError` reads — the status list from
 * `GATEWAY_ERROR_STATUSES`, the floor from `GATEWAY_ERROR_HTTP_MIN`, the
 * exceptions from `CAPACITY_HTTP_STATUSES` — so the two forms cannot drift.
 * They are pinned to the same verdict for every `(status, httpStatus)`
 * combination by `test/observability/telemetry-status.test.ts` and against real
 * Postgres by `test/persistence/telemetry-usage-totals.test.ts`; before that pin
 * existed, an unknown status was an error row-level but not in SQL, which made
 * the durable rollup disagree with every read-side count.
 */
export function gatewayErrorSql(status: AnyColumn, httpStatus: AnyColumn): SQL {
  const included = sql.join(
    GATEWAY_ERROR_STATUSES.map((value) => sql`${value}`),
    sql`, `,
  );
  const capacity = sql.join(
    CAPACITY_HTTP_STATUSES.map((code) => sql`${code}`),
    sql`, `,
  );
  return sql`(${status} in (${included}) and (${httpStatus} is null or (${httpStatus} >= ${GATEWAY_ERROR_HTTP_MIN} and ${httpStatus} not in (${capacity}))))`;
}
