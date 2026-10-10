/**
 * A production binary bakes NODE_ENV, so that value cannot decide whether a
 * browser may store the session cookie. The configured public origin is the
 * authority, while an unset origin keeps the production fallback.
 */
import { expect, test } from "bun:test";
import { shouldUseSecureSessionCookie } from "../../src/console/auth/session-service";

test("a plain-HTTP public origin keeps the session cookie storable", () => {
  expect(shouldUseSecureSessionCookie({
    NODE_ENV: "production",
    CARTETHYIA_PUBLIC_ORIGIN: "http://203.0.113.10:12800",
  })).toBe(false);
  expect(shouldUseSecureSessionCookie({
    NODE_ENV: "production",
    CARTETHYIA_PUBLIC_ORIGIN: " https://cartethyia.example ",
  })).toBe(true);
  expect(shouldUseSecureSessionCookie({ NODE_ENV: "production" })).toBe(true);
  expect(shouldUseSecureSessionCookie({})).toBe(false);
});
