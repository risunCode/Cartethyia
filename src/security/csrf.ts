// Generic HTTP cookie mechanics: CSRF double-submit validation and cookie parsing.
// These are generic HTTP security primitives used by both console and data plane.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { isRecord } from "../protocol/primitives";

/**
 * Stateless double-submit CSRF protection for the HTTP request pipeline.
 *
 * Cookie parsing and comparison are generic HTTP mechanics: the server issues
 * a readable `csrf_token` cookie at login/refresh, unsafe same-origin
 * mutations echo it in `x-csrf-token`, and validation uses a constant-time
 * string comparison without DB I/O or per-token state.
 *
 * An attacker page on another origin can trigger cookie-authenticated requests
 * but cannot read the cookie value, so it cannot forge the header.
 */
export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * Name of the session cookie whose presence gates CSRF validation in
 * `transport/middleware/ingress.ts`. Defined once here (next to the CSRF check that reads
 * it) instead of once per layer; `console/auth/session-resolver.ts` reuses it.
 */
export const SESSION_COOKIE_NAME = "session_token";

/**
 * Minimal cookie policy the CSRF helpers need. `console`'s
 * `SessionCookiePolicy` structurally satisfies this (extra fields are fine),
 * so call sites keep passing their existing policy object unchanged.
 */
export interface CsrfCookiePolicy {
  readonly maxAge: number;
  readonly sameSite: "Lax" | "Strict" | "None";
  readonly secure: boolean;
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function parseCookieHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    if (part.slice(0, eqIndex).trim() === name) {
      const value = part.slice(eqIndex + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/** Reads one named cookie from a raw `Cookie` request header. */
export function parseCookieValue(request: Request, name: string): string | undefined {
  return parseCookieHeader(request.headers.get("cookie"), name);
}

export interface CookieLike {
  readonly value?: unknown;
  set?(options: Record<string, unknown>): unknown;
}

export function asCookie(value: unknown): CookieLike | undefined {
  return isRecord(value) ? (value as unknown as CookieLike) : undefined;
}

/**
 * Double-submit check: the `x-csrf-token` header must equal the
 * `csrf_token` cookie using a timing-safe comparison. No database involved.
 */
export function isCsrfValid(request: Request): boolean {
  const header = request.headers.get(CSRF_HEADER_NAME);
  const cookie = parseCookieValue(request, CSRF_COOKIE_NAME);
  if (!header || !cookie) return false;
  const a = Buffer.from(header, "utf-8");
  const b = Buffer.from(cookie, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function csrfCookieOptions(
  policy: CsrfCookiePolicy,
  value: string,
  maxAgeOverride?: number,
): Record<string, unknown> {
  return {
    value,
    maxAge: maxAgeOverride ?? policy.maxAge,
    // Readable by dashboard JS on purpose — that is the whole point of
    // double-submit. Session authentication stays in the HttpOnly cookie.
    httpOnly: false,
    sameSite: policy.sameSite.toLowerCase(),
    secure: policy.secure,
    path: "/",
  };
}

export function setCsrfCookie(cookies: unknown, policy: CsrfCookiePolicy, value: string): void {
  if (!isRecord(cookies)) throw new Error("CSRF cookie support is unavailable");
  const cookie = asCookie(cookies[CSRF_COOKIE_NAME]);
  if (!cookie || typeof cookie.set !== "function") {
    throw new Error("CSRF cookie support is unavailable");
  }
  cookie.set(csrfCookieOptions(policy, value));
}

export function clearCsrfCookie(cookies: unknown, policy: CsrfCookiePolicy): void {
  if (!isRecord(cookies)) return;
  const cookie = asCookie(cookies[CSRF_COOKIE_NAME]);
  if (!cookie || typeof cookie.set !== "function") return;
  cookie.set({ ...csrfCookieOptions(policy, "", 0), expires: new Date(0) });
}
