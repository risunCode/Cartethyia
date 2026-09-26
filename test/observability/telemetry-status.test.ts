import { expect, test } from "bun:test";
import {
  CAPACITY_HTTP_STATUSES,
  GATEWAY_ERROR_HTTP_MIN,
  GATEWAY_ERROR_STATUSES,
  isGatewayError,
  isGatewayErrorHttpStatus,
  isGatewayErrorStatus,
} from "../../src/observability/telemetry-status";

/**
 * The error-count definition is shared by eight read paths and one durable
 * rollup, so these tests pin the *rule*, not an implementation detail: which
 * requests count, and that the row-level predicate agrees with the aggregate
 * SQL over the same rows (the agreement is asserted against real Postgres in
 * `test/persistence/telemetry-usage-totals.test.ts`).
 *
 * The rule is a principle — a request counts only when the gateway failed at
 * its own job — so the cases below are the *classes*, not a list of codes. The
 * enumerated-list version of this rule missed `401` and `429`.
 */
test("a client abort is never a gateway error", () => {
  expect(isGatewayError("cancelled", 499)).toBe(false);
  expect(isGatewayErrorStatus("cancelled")).toBe(false);
});

test("a successful request is never a gateway error", () => {
  expect(isGatewayError("completed", 200)).toBe(false);
  expect(isGatewayErrorStatus("completed")).toBe(false);
});

test("the gateway's own defects are errors", () => {
  expect(isGatewayError("failed", 500)).toBe(true);
  expect(isGatewayError("truncated", 502)).toBe(true);
  expect(isGatewayError("failed", 504)).toBe(true);
});

test("every 4xx is the caller's outcome, not the gateway's", () => {
  // The abuse vector: each of these is free for the sender to generate and
  // reaches no provider, so counting any of them inflates the error rate at no
  // cost. `401` and `429` were the two the old enumerated list missed.
  for (const code of [400, 401, 403, 404, 409, 413, 415, 422, 429]) {
    expect({ code, verdict: isGatewayError("failed", code) }).toEqual({ code, verdict: false });
  }
});

test("capacity and availability are not defects, even though they are 5xx", () => {
  for (const code of CAPACITY_HTTP_STATUSES) {
    expect({ code, verdict: isGatewayError("failed", code) }).toEqual({ code, verdict: false });
  }
  expect(isGatewayError("truncated", 503)).toBe(false);
});

test("the class rule and the explicit floor agree", () => {
  expect(GATEWAY_ERROR_HTTP_MIN).toBe(500);
  // Below the floor: never a gateway defect. At or above it, except the named
  // capacity statuses: always a defect.
  for (const code of [100, 200, 301, 404, 499]) {
    expect({ code, verdict: isGatewayErrorHttpStatus(code) }).toEqual({ code, verdict: false });
  }
  for (const code of [500, 501, 502, 504, 505]) {
    expect({ code, verdict: isGatewayErrorHttpStatus(code) }).toEqual({ code, verdict: true });
  }
  for (const code of CAPACITY_HTTP_STATUSES) {
    expect({ code, verdict: isGatewayErrorHttpStatus(code) }).toEqual({ code, verdict: false });
  }
});

test("a failure carrying no HTTP status still counts", () => {
  // Rows written before `http_status` existed carry only the lifecycle state;
  // the conservative reading is to count them.
  expect(isGatewayError("failed", null)).toBe(true);
  expect(isGatewayError("failed", undefined)).toBe(true);
});

test("a status outside the enum is not claimed as a gateway error", () => {
  // A row with no lifecycle status (`null`) is not evidence the gateway
  // failed. Counting it here would also disagree with the SQL form, where
  // `status in (...)` is NULL for such a row and therefore false — and that
  // disagreement is what made the durable rollup differ from every read-side
  // count. The request is still recorded and shown.
  expect(isGatewayErrorStatus(null)).toBe(false);
  expect(isGatewayErrorStatus(undefined)).toBe(false);
  expect(isGatewayErrorStatus("something_new")).toBe(false);
  expect(isGatewayError(null, 500)).toBe(false);
  expect(isGatewayError(undefined, 500)).toBe(false);
});

/**
 * The row-level predicate and the SQL predicate are two encodings of one rule,
 * and the SQL form feeds the durable `telemetry_usage_totals` rollup while the
 * row form feeds the read-side counts. A rollup entry cannot be corrected after
 * its raw row is pruned, so a disagreement between the two is permanent.
 *
 * The SQL verdict below is a restatement of `gatewayErrorSql`; the same
 * agreement is asserted by running the real SQL against real Postgres in
 * `test/persistence/telemetry-usage-totals.test.ts`. Both must hold — if only
 * this one runs, it is checking a restatement, not the SQL.
 */
test("the row predicate and the SQL predicate agree on every combination", () => {
  const statuses = ["completed", "failed", "cancelled", "truncated", null, "unknown_future"];
  const httpStatuses = [200, 301, 401, 404, 429, 499, 500, 502, 503, 504, null];
  const capacity = new Set<number>(CAPACITY_HTTP_STATUSES);
  for (const status of statuses) {
    for (const httpStatus of httpStatuses) {
      // `status in (...)` on a NULL/unknown status is NULL, which a
      // `filter (where ...)` treats as false.
      const sqlVerdict =
        (GATEWAY_ERROR_STATUSES as readonly string[]).includes(status ?? "") &&
        (httpStatus === null ||
          (httpStatus >= GATEWAY_ERROR_HTTP_MIN && !capacity.has(httpStatus)));
      expect({ status, httpStatus, verdict: isGatewayError(status, httpStatus) }).toEqual({
        status,
        httpStatus,
        verdict: sqlVerdict,
      });
    }
  }
});

test("the exported rule constants are the ones the predicate implements", () => {
  expect([...GATEWAY_ERROR_STATUSES]).toEqual(["failed", "truncated"]);
  expect([...CAPACITY_HTTP_STATUSES]).toEqual([503]);
  expect(GATEWAY_ERROR_HTTP_MIN).toBe(500);
});
