/**
 * Console session security: cookies, HMAC-SHA256 session tokens, same-origin
 * mutation guard, Argon2id password hashing, and per-IP login rate limiting.
 *
 * Extracted from `services.ts` so the security boundary owns its own file.
 * Mutations require an authenticated session, a JSON content type, and a
 * same-origin request; session cookies are HttpOnly + SameSite with a Secure
 * attribute when served over HTTPS.
 */

import { runtimeMemoryLimits } from "../traffic/limits";

// ---------------------------------------------------------------------------
// Security helpers: cookies, sessions, same-origin, mutation guard
// ---------------------------------------------------------------------------

export const SESSION_COOKIE_NAME = "cartethyia_console";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function clientIp(request: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded !== null && forwarded.length > 0) return forwarded.split(",")[0]!.trim();
    const real = request.headers.get("x-real-ip");
    if (real !== null && real.length > 0) return real;
  }
  return "127.0.0.1";
}

export function isHttpsRequest(request: Request, trustProxy: boolean): boolean {
  if (trustProxy && request.headers.get("x-forwarded-proto") === "https") return true;
  return request.url.startsWith("https://");
}

/**
 * Same-origin validation for mutating console calls: when an Origin header
 * is present its host must match the effective request host. An absent
 * Origin (curl, server clients) is allowed — CSRF protection is layered on
 * the SameSite cookie attribute anyway.
 *
 * `x-forwarded-host` is only trusted when `trustProxy` is true — otherwise
 * the client-controlled header could spoof the host and bypass CSRF.
 */
export function isSameOriginRequest(request: Request, trustProxy: boolean = false): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const originHost = new URL(origin).host;
    const host =
      (trustProxy ? request.headers.get("x-forwarded-host") : null) ??
      request.headers.get("host") ??
      new URL(request.url).host;
    return originHost === host;
  } catch {
    return false;
  }
}

export function requiresJsonContentType(request: Request): boolean {
  return !SAFE_METHODS.has(request.method) && !(request.headers.get("content-type") ?? "").includes("application/json");
}

/**
 * Secure session cookie for the console: HttpOnly, SameSite=Lax, scoped to
 * /console, with `Secure` appended when served over HTTPS.
 */
export function buildSessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/console",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/console; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export interface SessionTokenPayload {
  readonly role: "admin";
  /** settings.password_version at issue time — a password change invalidates every token. */
  readonly pv: number;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export interface SignSessionTokenOptions {
  readonly secret: string;
  readonly pv: number;
  readonly ttlSeconds: number;
  readonly nowSeconds?: number;
}

/** Signs an HMAC-SHA256 console session token (compact JWT-style). */
export async function signSessionToken(options: SignSessionTokenOptions): Promise<string> {
  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: SessionTokenPayload = {
    role: "admin",
    pv: options.pv,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + options.ttlSeconds,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const data = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;
  const key = await hmacKey(options.secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export type SessionTokenFailure = "malformed" | "signature" | "expired" | "stale_pv";
export type SessionTokenResult = { readonly ok: true; readonly payload: SessionTokenPayload } | { readonly ok: false; readonly reason: SessionTokenFailure };

export interface VerifySessionTokenOptions {
  readonly secret: string;
  readonly expectedPv: number;
  readonly nowSeconds?: number;
}

/** Verifies a console session token: constant-time signature check, expiry, password version. */
export async function verifySessionToken(token: string | null | undefined, options: VerifySessionTokenOptions): Promise<SessionTokenResult> {
  if (token === null || token === undefined || token.length === 0) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];

  const key = await hmacKey(options.secret);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${head}.${body}`)));
  let given: Uint8Array;
  try {
    given = base64UrlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length) return { ok: false, reason: "signature" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
  if (diff !== 0) return { ok: false, reason: "signature" };

  let payload: SessionTokenPayload;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(base64UrlDecode(body)));
    if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
    const value = parsed as Record<string, unknown>;
    if (value.role !== "admin" || typeof value.pv !== "number" || typeof value.exp !== "number") {
      return { ok: false, reason: "malformed" };
    }
    payload = {
      role: "admin",
      pv: value.pv,
      jti: typeof value.jti === "string" ? value.jti : "",
      iat: typeof value.iat === "number" ? value.iat : 0,
      exp: value.exp,
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (payload.pv !== options.expectedPv) return { ok: false, reason: "stale_pv" };
  return { ok: true, payload };
}

export type GuardVerdict =
  | { readonly ok: true; readonly payload: SessionTokenPayload }
  | { readonly ok: false; readonly status: 401 | 403; readonly code: "unauthorized" | "forbidden"; readonly message: string };

/**
 * Explicit, testable console guard: mutations must carry a JSON content
 * type and be same-origin; every request must carry a valid session token.
 * Returns a typed verdict; the router maps it to the error envelope.
 */
export async function guardConsoleRequest(
  request: Request,
  options: { readonly jwtSecret: string; readonly passwordVersion: number; readonly trustProxy: boolean },
): Promise<GuardVerdict> {
  if (!SAFE_METHODS.has(request.method)) {
    if (requiresJsonContentType(request)) {
      return { ok: false, status: 403, code: "forbidden", message: "mutating console requests require Content-Type: application/json" };
    }
    if (!isSameOriginRequest(request, options.trustProxy)) {
      return { ok: false, status: 403, code: "forbidden", message: "cross-origin console request rejected" };
    }
  }
  const token = readCookie(request, SESSION_COOKIE_NAME);
  const result = await verifySessionToken(token, { secret: options.jwtSecret, expectedPv: options.passwordVersion });
  if (!result.ok) {
    return result.reason === "expired"
      ? { ok: false, status: 401, code: "unauthorized", message: "session expired" }
      : { ok: false, status: 401, code: "unauthorized", message: "invalid session" };
  }
  return { ok: true, payload: result.payload };
}

/** Argon2id password hashing for the console login (Bun). */
export async function hashConsolePassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 });
}

export async function verifyConsolePassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-IP login rate limiter
// ---------------------------------------------------------------------------

/** Bounded per-IP login failure limiter. */
export interface LoginLimiter {
  check(ip: string): { readonly allowed: boolean; readonly retryAfterSec: number | null };
  recordFailure(ip: string): { readonly allowed: boolean; readonly retryAfterSec: number | null };
  recordSuccess(ip: string): void;
}

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_LOCK_MS = 15 * 60_000;

/** In development mode, login rate limiting is disabled entirely. */
const IS_DEV: boolean = Bun.env.NODE_ENV === "development";

/** Effective max tracked IPs for login limiter: env override, or adaptive from RSS. */
function resolveLoginMaxTrackedIps(): number {
  if (runtimeMemoryLimits.loginMaxTrackedIps > 0) return runtimeMemoryLimits.loginMaxTrackedIps;
  const rssBytes = process.memoryUsage?.().rss ?? 256 * 1024 * 1024;
  return Math.min(Math.max(Math.floor(rssBytes / 2_048), 5_000), 200_000);
}

export class MemoryLoginLimiter implements LoginLimiter {
  private readonly entries = new Map<string, { failures: number; windowStartMs: number; lockedUntilMs: number | null }>();

  private entry(ip: string): { failures: number; windowStartMs: number; lockedUntilMs: number | null } {
    let entry = this.entries.get(ip);
    const now = Date.now();
    if (entry === undefined || entry.windowStartMs + LOGIN_WINDOW_MS <= now) {
      entry = { failures: 0, windowStartMs: now, lockedUntilMs: null };
      if (this.entries.size >= resolveLoginMaxTrackedIps()) {
        const oldestKey = this.entries.keys().next().value as string | undefined;
        if (oldestKey !== undefined) this.entries.delete(oldestKey);
      }
      this.entries.set(ip, entry);
    }
    return entry;
  }

  check(ip: string): { readonly allowed: boolean; readonly retryAfterSec: number | null } {
    if (IS_DEV) return { allowed: true, retryAfterSec: null };
    const entry = this.entry(ip);
    if (entry.lockedUntilMs !== null) {
      const remaining = entry.lockedUntilMs - Date.now();
      if (remaining > 0) return { allowed: false, retryAfterSec: Math.ceil(remaining / 1000) };
      entry.lockedUntilMs = null;
    }
    return { allowed: true, retryAfterSec: null };
  }

  recordFailure(ip: string): { readonly allowed: boolean; readonly retryAfterSec: number | null } {
    if (IS_DEV) return { allowed: true, retryAfterSec: null };
    const entry = this.entry(ip);
    entry.failures += 1;
    if (entry.failures >= LOGIN_MAX_FAILURES) {
      entry.lockedUntilMs = Date.now() + LOGIN_LOCK_MS;
      entry.failures = 0;
      return { allowed: false, retryAfterSec: LOGIN_LOCK_MS / 1000 };
    }
    return { allowed: true, retryAfterSec: null };
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }
}
