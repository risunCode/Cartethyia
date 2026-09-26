import { describe, expect, test } from "bun:test";
import { securePolicyForRequest } from "../../../src/console/auth/session";
import type { SessionCookiePolicy } from "../../../src/console/auth/service";
import type { TrustedProxyBoundary } from "../../../src/config";

/**
 * Session-cookie `Secure` upgrade.
 *
 * The boot-time policy only sees the configured origin string. Behind a
 * TLS-terminating proxy the origin leg reads `http` while the client leg is
 * `https`, and a non-Secure session cookie would then travel in the clear. The
 * upgrade is therefore conditional, and the condition is the security boundary:
 * a client-sent `x-forwarded-proto` is honored *only* when the TCP peer is
 * inside the trusted-proxy allowlist, because otherwise any caller could claim
 * TLS and have the cookie marked Secure (or, worse, have the boundary trusted
 * for client-IP resolution).
 */
const insecure: SessionCookiePolicy = {
  maxAge: 3600,
  httpOnly: true,
  sameSite: "Lax",
  secure: false,
};

const trustedBoundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/8"] };
const disabledBoundary: TrustedProxyBoundary = { mode: "disabled" };

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("securePolicyForRequest", () => {
  test("an already-secure policy is returned unchanged", () => {
    const secure: SessionCookiePolicy = { ...insecure, secure: true };
    const result = securePolicyForRequest(
      request("http://origin.test/console"),
      secure,
      disabledBoundary,
      undefined,
    );
    expect(result).toBe(secure);
  });

  test("an https origin upgrades the policy without any proxy header", () => {
    const result = securePolicyForRequest(
      request("https://origin.test/console"),
      insecure,
      disabledBoundary,
      undefined,
    );
    expect(result.secure).toBe(true);
    // Only `secure` changes; the rest of the policy is preserved.
    expect(result.maxAge).toBe(insecure.maxAge);
    expect(result.sameSite).toBe(insecure.sameSite);
    expect(result.httpOnly).toBe(insecure.httpOnly);
  });

  test("an http origin with no trusted peer stays insecure", () => {
    const result = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "https" }),
      insecure,
      disabledBoundary,
      "203.0.113.9",
    );
    // The header is present but the peer is untrusted, so it is ignored.
    expect(result.secure).toBe(false);
    expect(result).toBe(insecure);
  });

  test("an http origin with a missing peer address stays insecure", () => {
    const result = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "https" }),
      insecure,
      trustedBoundary,
      undefined,
    );
    expect(result.secure).toBe(false);
  });

  test("a trusted peer's https forwarded proto upgrades the policy", () => {
    const result = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "https" }),
      insecure,
      trustedBoundary,
      "10.1.2.3",
    );
    expect(result.secure).toBe(true);
  });

  test("a trusted peer's http forwarded proto does not upgrade", () => {
    const result = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "http" }),
      insecure,
      trustedBoundary,
      "10.1.2.3",
    );
    expect(result.secure).toBe(false);
  });

  test("a trusted peer with no forwarded proto stays insecure", () => {
    const result = securePolicyForRequest(
      request("http://origin.test/console"),
      insecure,
      trustedBoundary,
      "10.1.2.3",
    );
    expect(result.secure).toBe(false);
  });

  test("only the first entry of a forwarded chain is honored", () => {
    const upgraded = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "https, http" }),
      insecure,
      trustedBoundary,
      "10.1.2.3",
    );
    expect(upgraded.secure).toBe(true);

    // A chain whose *first* hop is http is not upgraded, even if a later hop
    // claims https — the client leg is the first entry.
    const notUpgraded = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "http, https" }),
      insecure,
      trustedBoundary,
      "10.1.2.3",
    );
    expect(notUpgraded.secure).toBe(false);
  });

  test("the forwarded value is matched case-insensitively and trimmed", () => {
    const result = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "  HTTPS  " }),
      insecure,
      trustedBoundary,
      "10.1.2.3",
    );
    expect(result.secure).toBe(true);
  });

  test("an untrusted peer cannot upgrade even with a valid-looking header", () => {
    const result = securePolicyForRequest(
      request("http://origin.test/console", { "x-forwarded-proto": "https" }),
      insecure,
      trustedBoundary,
      "198.51.100.7",
    );
    expect(result.secure).toBe(false);
  });
});
