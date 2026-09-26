import { describe, expect, test } from "bun:test";
import { httpStatusLabel, httpStatusTone } from "../../src/lib/http-status";
import { STATUS_CODES } from "node:http";

/**
 * The Requests filter buttons and the status cell render a code with its
 * reason phrase, derived from the code rather than hardcoded per status. These
 * pin that every code the gateway can actually return has a phrase, and that
 * the phrases agree with the platform's own table — a hand-written phrase that
 * disagrees with the standard would be worse than no phrase.
 */
describe("httpStatusLabel", () => {
  test("every status the gateway can return has a reason phrase", () => {
    // The set the backend actually emits, extracted from every
    // `new GatewayError(...)` / `new ConsoleDomainError(...)` in src/.
    const emitted = [200, 400, 401, 403, 404, 409, 413, 415, 422, 429, 499, 500, 501, 502, 503, 504];
    for (const code of emitted) {
      const label = httpStatusLabel(code);
      // A bare number means the phrase is missing, which is the regression.
      expect(label).not.toBe(String(code));
      expect(label.startsWith(`${code} `)).toBe(true);
    }
  });

  test("phrases match the platform's own status table", () => {
    // `499` is not registered with the platform (it is an nginx convention the
    // gateway adopts for a client abort), so it is asserted separately below.
    for (const [code, phrase] of Object.entries(STATUS_CODES)) {
      const numeric = Number(code);
      if (!Number.isInteger(numeric) || numeric === 499) continue;
      if (httpStatusLabel(numeric) === String(numeric)) continue; // not in our table
      expect(httpStatusLabel(numeric)).toBe(`${numeric} ${phrase}`);
    }
  });

  test("499 names the client abort rather than a server defect", () => {
    expect(httpStatusLabel(499)).toBe("499 Client Closed Request");
  });

  test("an unknown code falls back to the bare number", () => {
    // Never invent a phrase for a code we do not know about.
    expect(httpStatusLabel(599)).toBe("599");
    expect(httpStatusLabel(0)).toBe("0");
  });
});

describe("httpStatusTone", () => {
  test("success is green, client abort is amber, failures are red", () => {
    expect(httpStatusTone(200)).toBe("ok");
    expect(httpStatusTone(499)).toBe("warn");
    expect(httpStatusTone(404)).toBe("err");
    expect(httpStatusTone(500)).toBe("err");
    expect(httpStatusTone(503)).toBe("err");
  });

  test("tone is derived from the code, so a new status is styled correctly", () => {
    // The filter buttons render whatever the backend reports; before this,
    // colour came from a hardcoded `data-status="200|499|503"` list, so any
    // other status rendered unstyled.
    expect(httpStatusTone(418)).toBe("err");
    expect(httpStatusTone(302)).toBe("warn");
  });
});
