/**
 * The console's list-limit parser: the one place a `?limit=` value becomes a
 * bounded integer.
 *
 * Four list endpoints share this parser, and the module's own comment records
 * why: each previously spelled out the same `Number()` → finiteness check →
 * clamp, "which is exactly how a limit silently stops being enforced on one
 * endpoint while the others keep clamping". So the suite's job is the *contract*
 * every endpoint now inherits:
 *
 * - **A non-numeric value is a caller error, never a silent default.** Falling
 *   back on `?limit=abc` would report success for a request the operator can see
 *   was malformed, and the page would show the default page size as if it had
 *   been asked for.
 * - **The result is always a finite integer in `[1, max]`.** A zero or negative
 *   limit reaching SQL would either return nothing or be rejected by the driver;
 *   a value past the cap would let one request pull the whole table.
 * - **`undefined` and `""` mean "not supplied".** An HTML form and a hand-written
 *   URL both produce `""` for an empty field, and both should take the default.
 */
import { describe, expect, test } from "bun:test";
import { parseQueryLimit } from "../../src/console/shared/query";
import { ConsoleDomainError } from "../../src/console/shared/errors";

describe("parseQueryLimit — the default", () => {
  test("undefined takes the fallback", () => {
    expect(parseQueryLimit(undefined, 50, 200)).toBe(50);
  });

  test("an empty string takes the fallback", () => {
    // `?limit=` is what an HTML form submits for an untouched field and what a
    // hand-written URL produces. `Number("")` is 0, so without the explicit check
    // this would clamp to 1 instead of taking the default.
    expect(parseQueryLimit("", 50, 200)).toBe(50);
  });

  test("the fallback is used verbatim when it is inside the range", () => {
    // The fallback is not clamped — it is the endpoint's own default and is
    // expected to be sane. Pinned so a change that clamped it would be visible.
    expect(parseQueryLimit(undefined, 1, 200)).toBe(1);
    expect(parseQueryLimit(undefined, 200, 200)).toBe(200);
  });
});

describe("parseQueryLimit — accepted values", () => {
  test("a numeric string inside the range is returned as an integer", () => {
    expect(parseQueryLimit("50", 10, 200)).toBe(50);
    expect(parseQueryLimit("1", 10, 200)).toBe(1);
    expect(parseQueryLimit("200", 10, 200)).toBe(200);
  });

  test("a value past the cap is clamped down to it", () => {
    // The cap is what stops one request pulling the whole table. Clamping rather
    // than rejecting is the documented behaviour: an over-large limit is not a
    // caller error, it is a request for as much as the endpoint will give.
    expect(parseQueryLimit("201", 10, 200)).toBe(200);
    expect(parseQueryLimit("1000000", 10, 200)).toBe(200);
    expect(parseQueryLimit("999999999999999999999", 10, 200)).toBe(200);
  });

  test("zero, a negative value, and a fraction are clamped up to 1", () => {
    // A limit below 1 has no meaning — it would return no rows and the page would
    // look empty rather than broken. `Math.floor` runs before the clamp, so 0.9
    // becomes 0 and then 1.
    for (const raw of ["0", "-1", "-100", "0.9", "0.1"]) {
      expect(parseQueryLimit(raw, 10, 200)).toBe(1);
    }
  });

  test("a fractional value is floored", () => {
    // `LIMIT 50.7` is not valid SQL; flooring is the documented conversion.
    expect(parseQueryLimit("50.9", 10, 200)).toBe(50);
    expect(parseQueryLimit("1.5", 10, 200)).toBe(1);
  });

  test("a value written in exponent form is accepted", () => {
    // `Number("1e2")` is 100, and the parser is a `Number` conversion rather than
    // a digit check. Pinned because a reader might expect a rejection.
    expect(parseQueryLimit("1e2", 10, 200)).toBe(100);
    // And it is still clamped.
    expect(parseQueryLimit("1e9", 10, 200)).toBe(200);
  });

  test("surrounding whitespace is tolerated by the Number conversion", () => {
    // `Number(" 50 ")` is 50. A hand-written URL with a stray space should not
    // read as a malformed request.
    expect(parseQueryLimit(" 50 ", 10, 200)).toBe(50);
    expect(parseQueryLimit("\t50\n", 10, 200)).toBe(50);
  });

  test("a leading plus sign is accepted", () => {
    // `Number("+50")` is 50. Pinned as measured.
    expect(parseQueryLimit("+50", 10, 200)).toBe(50);
  });
});

describe("parseQueryLimit — rejected values", () => {
  test("a non-numeric value is a 400, not a silent default", () => {
    // The module's stated rule. A silent fallback would report success for a
    // request the operator can see was malformed, and the page would show the
    // default page size as if it had been asked for.
    for (const raw of ["abc", "50abc", "abc50", "1,2", "50 60", "--1", "1-2", "null", "NaN"]) {
      expect(() => parseQueryLimit(raw, 10, 200)).toThrow(ConsoleDomainError);
    }
  });

  test("the rejection carries the documented code and status", () => {
    // The code is what the console's error handler maps to a message; the status
    // is what the client sees.
    let failure: unknown = null;
    try {
      parseQueryLimit("abc", 10, 200);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConsoleDomainError);
    const domain = failure as ConsoleDomainError;
    expect(domain.code).toBe("invalid_limit");
    expect(domain.status).toBe(400);
    expect(domain.message).toContain("finite number");
  });

  test("Infinity is rejected rather than clamped to the cap", () => {
    // `Number("Infinity")` is infinite, so the finiteness check fires. Clamping
    // would make `?limit=Infinity` a working way to ask for the maximum, which
    // the cap already provides — and it would hide a client bug.
    expect(() => parseQueryLimit("Infinity", 10, 200)).toThrow(ConsoleDomainError);
    expect(() => parseQueryLimit("-Infinity", 10, 200)).toThrow(ConsoleDomainError);
  });

  test("a whitespace-only value is rejected, not treated as absent", () => {
    // `"   "` is not `""`, so it goes down the `Number` path where it becomes 0
    // and then clamps to 1 — NOT the fallback. Pinned as measured: the
    // absent-value check is on the empty string specifically, so a padded blank
    // reads as a limit of 1 rather than as "not supplied".
    expect(parseQueryLimit("   ", 50, 200)).toBe(1);
  });

  test("a hex or binary literal is accepted because Number accepts it", () => {
    // `Number("0x10")` is 16. Pinned as measured — the parser is a `Number`
    // conversion, not a decimal-digit check, so these forms work.
    expect(parseQueryLimit("0x10", 10, 200)).toBe(16);
    expect(parseQueryLimit("0b101", 10, 200)).toBe(5);
    expect(parseQueryLimit("0o17", 10, 200)).toBe(15);
  });
});

describe("parseQueryLimit — the invariant across the whole input space", () => {
  test("every accepted result is a finite integer within [1, max]", () => {
    // The contract every endpoint inherits, asserted as a sweep rather than case
    // by case: whatever comes in, what reaches SQL is a bounded integer.
    const accepted = [
      undefined,
      "",
      "0",
      "-1",
      "1",
      "2.5",
      "50",
      "199",
      "200",
      "201",
      "1e9",
      " 42 ",
      "+7",
      "0x10",
      "0b1",
      "0o7",
    ];
    for (const raw of accepted) {
      const value = parseQueryLimit(raw, 25, 200);
      expect(Number.isInteger(value)).toBe(true);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(200);
    }
  });

  test("the cap is inclusive and one past it clamps to the cap", () => {
    // The boundary from both sides, so an off-by-one in the clamp is caught.
    expect(parseQueryLimit("199", 10, 200)).toBe(199);
    expect(parseQueryLimit("200", 10, 200)).toBe(200);
    expect(parseQueryLimit("201", 10, 200)).toBe(200);
  });

  test("a max of 1 collapses every accepted value to 1", () => {
    // A degenerate cap still has to produce a usable limit rather than 0.
    for (const raw of ["0", "1", "50", "1000"]) {
      expect(parseQueryLimit(raw, 1, 1)).toBe(1);
    }
  });

  test("the parser does not mutate or retain anything between calls", () => {
    // It is called once per request on a shared module; a cached value would leak
    // one endpoint's limit into another's.
    expect(parseQueryLimit("50", 10, 200)).toBe(50);
    expect(parseQueryLimit(undefined, 10, 200)).toBe(10);
    expect(parseQueryLimit("50", 10, 200)).toBe(50);
  });
});
