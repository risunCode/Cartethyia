/**
 * Which requests count against the gateway.
 *
 * The rule is a principle, not a list: **a request counts only when the gateway
 * itself failed to do its job.** Everything else — the caller's refusal, the
 * provider's capacity, the client walking away — is recorded and displayed but
 * never counted.
 *
 * That distinction is load-bearing because the count feeds a *durable* rollup
 * (`telemetry_usage_totals`). Once a request is counted there it stays counted
 * after the raw row is pruned, so a wrong answer is not merely displayed, it is
 * frozen. The cases below are therefore written as classes rather than as
 * examples: an unenumerated `4xx` must behave like every other `4xx`, and an
 * unknown lifecycle status must be classified exactly as the SQL form
 * classifies it, or the row-level and aggregate answers disagree on precisely
 * the rows nobody will notice.
 *
 * The SQL predicate is asserted structurally (it is built from the same
 * constants), because its real behavior is covered by the telemetry suites that
 * run it against Postgres.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPACITY_HTTP_STATUSES,
  GATEWAY_ERROR_HTTP_MIN,
  GATEWAY_ERROR_STATUSES,
  gatewayErrorSql,
  isGatewayError,
  isGatewayErrorHttpStatus,
  isGatewayErrorStatus,
} from "../../src/observability/telemetry-status";

describe("isGatewayErrorStatus", () => {
  test("the two failure statuses count", () => {
    expect(isGatewayErrorStatus("failed")).toBe(true);
    expect(isGatewayErrorStatus("truncated")).toBe(true);
  });

  test("a successful completion does not count", () => {
    expect(isGatewayErrorStatus("completed")).toBe(false);
  });

  test("a client cancellation does not count", () => {
    // The client left. The request may even have been served; either way the
    // gateway did its job.
    expect(isGatewayErrorStatus("cancelled")).toBe(false);
  });

  test("an unknown status does not count", () => {
    // Deliberate, and it is what makes this predicate agree with the SQL form:
    // `status in (...)` is NULL — therefore not counted — for an unrecognized
    // value. "Unknown" means "we cannot claim this was the gateway's fault".
    expect(isGatewayErrorStatus("something-new")).toBe(false);
    expect(isGatewayErrorStatus("")).toBe(false);
  });

  test("a null or undefined status does not count", () => {
    expect(isGatewayErrorStatus(null)).toBe(false);
    expect(isGatewayErrorStatus(undefined)).toBe(false);
  });

  test("matching is exact, not a prefix", () => {
    expect(isGatewayErrorStatus("fail")).toBe(false);
    expect(isGatewayErrorStatus("failed_softly")).toBe(false);
  });
});

describe("isGatewayErrorHttpStatus", () => {
  test("an ordinary server error counts", () => {
    expect(isGatewayErrorHttpStatus(500)).toBe(true);
    expect(isGatewayErrorHttpStatus(502)).toBe(true);
    expect(isGatewayErrorHttpStatus(504)).toBe(true);
  });

  test("every capacity status is excluded", () => {
    // The gateway correctly refusing work it cannot do right now. That is an
    // operator-capacity signal, not a defect.
    for (const status of CAPACITY_HTTP_STATUSES) {
      expect({ status, counted: isGatewayErrorHttpStatus(status) }).toEqual({
        status,
        counted: false,
      });
    }
  });

  test("the 4xx class is excluded wholesale, not enumerated", () => {
    // The previous approach listed "the bad ones" and missed 401 and 429, which
    // are the cheapest for an abuser to generate: a bogus key and an exhausted
    // quota both cost the sender nothing and reach no provider, so counting
    // them handed out a free way to inflate the error rate.
    for (let status = 400; status < 500; status += 1) {
      expect({ status, counted: isGatewayErrorHttpStatus(status) }).toEqual({
        status,
        counted: false,
      });
    }
  });

  test("499 is excluded as a client abort, without needing a special case", () => {
    // It falls below the 500 floor, so the class rule already covers it.
    expect(isGatewayErrorHttpStatus(499)).toBe(false);
  });

  test("2xx and 3xx are excluded", () => {
    expect(isGatewayErrorHttpStatus(200)).toBe(false);
    expect(isGatewayErrorHttpStatus(301)).toBe(false);
  });

  test("the floor is exactly 500", () => {
    expect(GATEWAY_ERROR_HTTP_MIN).toBe(500);
    expect(isGatewayErrorHttpStatus(499)).toBe(false);
    expect(isGatewayErrorHttpStatus(500)).toBe(true);
  });

  test("a status above 599 is still a server error", () => {
    // A non-standard server code is still the server failing; excluding it by an
    // upper bound would hide it.
    expect(isGatewayErrorHttpStatus(600)).toBe(true);
  });
});

describe("isGatewayError", () => {
  test("both halves must hold", () => {
    expect(isGatewayError("failed", 500)).toBe(true);
    expect(isGatewayError("failed", 502)).toBe(true);
    // A failure status with a caller-facing code is not a gateway defect.
    expect(isGatewayError("failed", 400)).toBe(false);
    // A server code on a successful lifecycle is not a failure either.
    expect(isGatewayError("completed", 500)).toBe(false);
  });

  test("a capacity status on a failed lifecycle does not count", () => {
    // `503` is the gateway correctly refusing work; it is retryable and
    // self-inflicted rather than a defect.
    expect(isGatewayError("failed", 503)).toBe(false);
    expect(isGatewayError("truncated", 503)).toBe(false);
  });

  test("a missing HTTP status falls back to the lifecycle answer", () => {
    // Rows written before the column existed carry only the lifecycle status.
    // Counting them is the conservative reading for historical data: a `failed`
    // row with no status was very likely a real failure.
    expect(isGatewayError("failed", null)).toBe(true);
    expect(isGatewayError("failed", undefined)).toBe(true);
    expect(isGatewayError("truncated")).toBe(true);
  });

  test("a missing HTTP status does not resurrect a non-failure", () => {
    expect(isGatewayError("completed", null)).toBe(false);
    expect(isGatewayError("cancelled", undefined)).toBe(false);
    expect(isGatewayError(null, null)).toBe(false);
  });

  test("a failed 401 from a bogus key does not inflate the error rate", () => {
    // The concrete abuse case: a caller rotating invalid keys must not be able
    // to move the gateway's own error rate.
    expect(isGatewayError("failed", 401)).toBe(false);
  });

  test("a failed 429 from the caller's own quota does not inflate it either", () => {
    expect(isGatewayError("failed", 429)).toBe(false);
  });

  test("a failed 404 from an unregistered path does not inflate it", () => {
    expect(isGatewayError("failed", 404)).toBe(false);
  });

  test("a failed 413 from an oversized body does not inflate it", () => {
    expect(isGatewayError("failed", 413)).toBe(false);
  });

  test("a genuine internal error does count", () => {
    expect(isGatewayError("failed", 500)).toBe(true);
  });
});

describe("the constants the SQL form is built from", () => {
  test("the lifecycle statuses are exactly the two failure states", () => {
    // The SQL `in (...)` list is generated from this tuple; widening it without
    // widening the row-level predicate would make the two forms disagree.
    expect([...GATEWAY_ERROR_STATUSES]).toEqual(["failed", "truncated"]);
  });

  test("the capacity statuses are the documented exceptions", () => {
    expect([...CAPACITY_HTTP_STATUSES]).toEqual([503, 529]);
  });

  test("no capacity status falls below the error floor", () => {
    // A capacity exception below 500 would be redundant (the class rule already
    // excludes it) and would hide that the list is about `5xx` semantics.
    for (const status of CAPACITY_HTTP_STATUSES) {
      expect(status).toBeGreaterThanOrEqual(GATEWAY_ERROR_HTTP_MIN);
    }
  });

  test("gatewayErrorSql builds a predicate from those constants", () => {
    // The predicate's *behavior* needs Postgres to verify, which the telemetry
    // suites do. This asserts the one structural property that makes the two
    // forms share a definition: the fragment is built by `sql.join`ing the
    // configured constants, so a change to `GATEWAY_ERROR_STATUSES` or
    // `CAPACITY_HTTP_STATUSES` reaches the SQL without a second edit. The
    // rendered text is collected recursively because drizzle nests the joined
    // lists inside the outer fragment.
    const column = { name: "http_status" } as never;
    const predicate = gatewayErrorSql(column as never, column as never);
    const rendered = collectSqlText(predicate);
    expect(rendered).toContain("failed");
    expect(rendered).toContain("truncated");
    expect(rendered).toContain(String(GATEWAY_ERROR_HTTP_MIN));
    for (const status of CAPACITY_HTTP_STATUSES) {
      expect(rendered).toContain(String(status));
    }
  });
});

/** Every string and number reachable from a drizzle SQL fragment, joined. */
function collectSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectSqlText).join(" ");
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(collectSqlText).join(" ");
  }
  return "";
}
