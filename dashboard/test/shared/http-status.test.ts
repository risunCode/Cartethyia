/**
 * Status presentation: the long label, the compact table word, and the tone.
 *
 * Three surfaces read one HTTP status, and they must agree about it:
 *
 * - the Requests table's narrow status cell uses the short word;
 * - the filter buttons and the popover use the full phrase;
 * - the badge colour uses the tone.
 *
 * The suite's job is the agreement. A code the gateway emits must render a
 * *useful* label in every surface, and a code it cannot emit must fall back to
 * its bare digits rather than inventing a phrase — an invented reason is worse
 * than none, because an operator reads it as documentation.
 *
 * The tones carry one deliberate judgement worth pinning: `499` is `warn`, not
 * `err`. The client disconnected; that is not a server defect, and colouring it
 * red sends an operator hunting for a bug that does not exist.
 */
import { describe, expect, test } from "bun:test";
import {
  httpStatusLabel,
  httpStatusShortLabel,
  httpStatusTone,
  type HttpStatusTone,
} from "../../src/shared/http-status";

/**
 * Every status the gateway is documented to return.
 *
 * Taken from the `GatewayErrorCode` → status mapping plus the surfaces' own
 * codes, so this list is the contract rather than a sample of it.
 */
const GATEWAY_STATUSES = [
  200, 400, 401, 403, 404, 409, 413, 415, 422, 429, 499, 500, 501, 502, 503, 504,
] as const;

/**
 * Keyed by the status union itself rather than `number`, so the compiler proves
 * the table is exhaustive and each lookup is a known key — `Record<number, …>`
 * would make every read `string | undefined` under `noUncheckedIndexedAccess`
 * and turn a missing entry into a silently skipped assertion.
 */
type GatewayStatus = (typeof GATEWAY_STATUSES)[number];
type StatusTable<Value> = Record<GatewayStatus, Value>;

describe("httpStatusLabel", () => {
  test("renders the standard phrase for every gateway status", () => {
    const expected: StatusTable<string> = {
      200: "200 OK",
      400: "400 Bad Request",
      401: "401 Unauthorized",
      403: "403 Forbidden",
      404: "404 Not Found",
      409: "409 Conflict",
      413: "413 Payload Too Large",
      415: "415 Unsupported Media Type",
      422: "422 Unprocessable Entity",
      429: "429 Too Many Requests",
      499: "499 Client Closed Request",
      500: "500 Internal Server Error",
      501: "501 Not Implemented",
      502: "502 Bad Gateway",
      503: "503 Service Unavailable",
      504: "504 Gateway Timeout",
    };
    for (const status of GATEWAY_STATUSES) {
      expect({ status, label: httpStatusLabel(status) }).toEqual({
        status,
        label: expected[status],
      });
    }
  });

  test("names 499 even though it has no standard phrase", () => {
    // The gateway emits it for a client abort. Without a name an operator reads
    // the digits as a server-side defect.
    expect(httpStatusLabel(499)).toBe("499 Client Closed Request");
  });

  test("an unmapped code falls back to its bare digits", () => {
    // The module's stated rule: an unknown code gets no invented phrase, because
    // an operator reads a reason phrase as documentation.
    expect(httpStatusLabel(418)).toBe("418");
    expect(httpStatusLabel(0)).toBe("0");
    expect(httpStatusLabel(999)).toBe("999");
  });

  test("no status renders as an empty or partial string", () => {
    for (const status of [...GATEWAY_STATUSES, 418, 999]) {
      const label = httpStatusLabel(status);
      expect(label.length).toBeGreaterThan(0);
      expect(label.startsWith(String(status))).toBe(true);
    }
  });
});

describe("httpStatusShortLabel", () => {
  test("keeps every word at five characters or fewer", () => {
    // The constraint that makes the Requests table's numeric columns line up:
    // a longer word wraps the cell.
    for (const status of GATEWAY_STATUSES) {
      const [, word = ""] = httpStatusShortLabel(status).split(" ");
      expect(word.length).toBeLessThanOrEqual(5);
    }
  });

  test("renders the documented short word for each status", () => {
    const expected: StatusTable<string> = {
      200: "200 OK",
      400: "400 BAD",
      401: "401 AUTH",
      403: "403 DENY",
      404: "404 MISS",
      409: "409 CONFL",
      413: "413 LARGE",
      415: "415 TYPE",
      422: "422 UNPRO",
      429: "429 RATE",
      499: "499 ABORT",
      500: "500 ERR",
      501: "501 TODO",
      502: "502 GATE",
      503: "503 DOWN",
      504: "504 TIME",
    };
    for (const status of GATEWAY_STATUSES) {
      expect({ status, short: httpStatusShortLabel(status) }).toEqual({
        status,
        short: expected[status],
      });
    }
  });

  test("distinguishes a client abort from a server error", () => {
    // The two most confusable outcomes in the table: one is the caller leaving,
    // the other is the gateway failing.
    expect(httpStatusShortLabel(499)).not.toBe(httpStatusShortLabel(500));
    expect(httpStatusShortLabel(499)).toBe("499 ABORT");
    expect(httpStatusShortLabel(500)).toBe("500 ERR");
  });

  test("an unmapped code falls back to its bare digits", () => {
    expect(httpStatusShortLabel(418)).toBe("418");
    expect(httpStatusShortLabel(999)).toBe("999");
  });

  test("every short label starts with its own status code", () => {
    for (const status of [...GATEWAY_STATUSES, 418]) {
      expect(httpStatusShortLabel(status).startsWith(String(status))).toBe(true);
    }
  });
});

describe("httpStatusTone", () => {
  test("200 is the only ok tone", () => {
    for (const status of GATEWAY_STATUSES) {
      const expected: HttpStatusTone = status === 200 ? "ok" : status === 499 ? "warn" : "err";
      expect({ status, tone: httpStatusTone(status) }).toEqual({ status, tone: expected });
    }
  });

  test("499 is warn, not err", () => {
    // The deliberate judgement: the client left. Colouring it red sends an
    // operator hunting for a server bug that does not exist.
    expect(httpStatusTone(499)).toBe("warn");
  });

  test("4xx and 5xx are errors", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504]) {
      expect({ status, tone: httpStatusTone(status) }).toEqual({ status, tone: "err" });
    }
  });

  test("a success code other than 200 is not reported as ok", () => {
    // The gateway answers 200 for a completed proxy request. Anything else in
    // the 2xx range would be a new behavior, and rendering it green before that
    // is confirmed would hide it — `warn` is the honest default.
    expect(httpStatusTone(201)).toBe("warn");
    expect(httpStatusTone(204)).toBe("warn");
  });

  test("an informational or redirect code is warn", () => {
    expect(httpStatusTone(100)).toBe("warn");
    expect(httpStatusTone(301)).toBe("warn");
  });

  test("every gateway status has a tone", () => {
    for (const status of GATEWAY_STATUSES) {
      expect(["ok", "err", "warn"]).toContain(httpStatusTone(status));
    }
  });
});

describe("the three surfaces agree", () => {
  test("every status has both a long and a short label", () => {
    // A code with a tone but no label (or vice versa) renders as an empty cell
    // or an uncoloured badge.
    for (const status of GATEWAY_STATUSES) {
      expect(httpStatusLabel(status)).toBeString();
      expect(httpStatusShortLabel(status)).toBeString();
      expect(httpStatusTone(status)).toBeString();
    }
  });

  test("the short word is never longer than the long phrase", () => {
    // The short label exists to save space; a "short" form that is longer than
    // the phrase would defeat the table it was written for.
    for (const status of GATEWAY_STATUSES) {
      expect(httpStatusShortLabel(status).length).toBeLessThanOrEqual(
        httpStatusLabel(status).length,
      );
    }
  });

  test("an unmapped code is consistent across all three surfaces", () => {
    // The fallback must be the same everywhere, or the filter button and the row
    // it filters would show different text for one request.
    expect(httpStatusLabel(418)).toBe("418");
    expect(httpStatusShortLabel(418)).toBe("418");
    expect(httpStatusTone(418)).toBe("err");
  });
});
