/**
 * Console session security: cookies, HMAC-SHA256 session tokens, same-origin
 * mutation guard, Argon2id password hashing, and per-IP login rate limiting.
 *
 * Extracted from `services.ts` so the security boundary owns its own file.
 * Mutations require an authenticated session, a JSON content type, and a
 * same-origin request; session cookies are HttpOnly + SameSite with a Secure
 * attribute when served over HTTPS.
 */

import { isIpLiteral } from "../application/protocols";
import { runtimeMemoryLimits } from "../traffic/limits";

// ---------------------------------------------------------------------------
// Security helpers: cookies, sessions, same-origin, mutation guard
// ---------------------------------------------------------------------------

export const SESSION_COOKIE_NAME = "cartethyia_console";
export const CSRF_HEADER_NAME = "x-cartethyia-csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "QUERY"]);
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

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

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** Proxy forwarding is opt-in; platform name detection is never security policy. */
function shouldTrustProxy(configured: boolean): boolean {
  return configured;
}

function forwardedIp(value: string | null): string | null {
  if (value === null) return null;
  for (const token of value.split(",")) {
    const candidate = token.trim().replace(/^\[|\]$/g, "");
    if (isIpLiteral(candidate)) return candidate;
  }
  return null;
}

/** Returns the normalized operator-configured public origin, if valid. */
export function configuredPublicOrigin(env: RuntimeEnvironment = Bun.env): string | null {
  const raw = (env.PUBLIC_ORIGIN ?? "").trim();
  if (raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function clientIp(request: Request, trustProxy: boolean, _env: RuntimeEnvironment = Bun.env): string {
  if (!shouldTrustProxy(trustProxy)) return "127.0.0.1";
  return forwardedIp(request.headers.get("x-forwarded-for")) ??
    forwardedIp(request.headers.get("x-real-ip")) ??
    forwardedIp(request.headers.get("cf-connecting-ip")) ??
    "127.0.0.1";
}

export function isHttpsRequest(request: Request, trustProxy: boolean, _env: RuntimeEnvironment = Bun.env): boolean {
  if (shouldTrustProxy(trustProxy) && request.headers.get("x-forwarded-proto") === "https") return true;
  return request.url.startsWith("https://");
}

/** Same-origin validation for console mutations using the explicit public origin. */
export function isSameOriginRequest(request: Request, trustProxy = false, env: RuntimeEnvironment = Bun.env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const expectedOrigin = configuredPublicOrigin(env);
  try {
    const originUrl = new URL(origin);
    if (expectedOrigin !== null) return originUrl.origin === expectedOrigin;
    const forwardedHost = shouldTrustProxy(trustProxy) ? request.headers.get("x-forwarded-host") : null;
    const host = forwardedHost ?? request.headers.get("host") ?? new URL(request.url).host;
    return originUrl.host === host && originUrl.protocol === new URL(request.url).protocol;
  } catch {
    return false;
  }
}

export function requiresJsonContentType(request: Request): boolean {
  return !SAFE_METHODS.has(request.method) && !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

export function buildSessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/console",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(1, Math.min(Math.floor(maxAgeSec), MAX_SESSION_TTL_SECONDS))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/console; HttpOnly; SameSite=Strict; Max-Age=0`;
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
  if (options.secret.trim().length < 32 || !Number.isInteger(options.pv) || options.pv < 1 || !Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0 || options.ttlSeconds > MAX_SESSION_TTL_SECONDS) {
    throw new Error("invalid console session signing options");
  }
  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(iat)) throw new Error("invalid console session timestamp");
  const payload: SessionTokenPayload = {
    role: "admin",
    pv: options.pv,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + Math.floor(options.ttlSeconds),
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
  if (token === null || token === undefined || token.length === 0 || options.secret.trim().length < 32) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  try {
    const parsedHeader = JSON.parse(decoder.decode(base64UrlDecode(head))) as Record<string, unknown>;
    if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "JWT") return { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "malformed" };
  }

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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
    const value = parsed as Record<string, unknown>;
    const pvValue = typeof value.pv === "number" ? value.pv : null;
    const jtiValue = typeof value.jti === "string" ? value.jti : null;
    const iatValue = typeof value.iat === "number" ? value.iat : null;
    const expValue = typeof value.exp === "number" ? value.exp : null;
    if (value.role !== "admin" || pvValue === null || !Number.isInteger(pvValue) || pvValue < 1 || jtiValue === null || jtiValue.length < 16 || iatValue === null || !Number.isFinite(iatValue) || expValue === null || !Number.isFinite(expValue)) {
      return { ok: false, reason: "malformed" };
    }
    payload = {
      role: "admin",
      pv: pvValue,
      jti: jtiValue,
      iat: iatValue,
      exp: expValue,
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_SESSION_TTL_SECONDS) return { ok: false, reason: "malformed" };
  if (payload.pv !== options.expectedPv) return { ok: false, reason: "stale_pv" };
  return { ok: true, payload };
}

async function signSecurityValue(secret: string, value: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Derives a stateless, session-bound CSRF token from the session JTI. */
export function createConsoleCsrfToken(secret: string, sessionId: string): Promise<string> {
  return signSecurityValue(secret, `csrf:${sessionId}`);
}

export async function verifyConsoleCsrfToken(secret: string, sessionId: string, token: string | null): Promise<boolean> {
  if (token === null || token.length === 0) return false;
  const expected = await createConsoleCsrfToken(secret, sessionId);
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export type GuardVerdict =
  | { readonly ok: true; readonly payload: SessionTokenPayload }
  | { readonly ok: false; readonly status: 401 | 403; readonly code: "unauthorized" | "forbidden"; readonly message: string };

/**
 * Explicit, testable console guard: mutations must carry JSON, a same-origin
 * request, Fetch Metadata that is not cross-site, and a session-bound CSRF
 * token; every request must carry a valid session token.
 */
export async function guardConsoleRequest(
  request: Request,
  options: { readonly jwtSecret: string; readonly passwordVersion: number; readonly trustProxy: boolean; readonly publicOrigin?: string | null; readonly env?: RuntimeEnvironment },
): Promise<GuardVerdict> {
  const mutating = !SAFE_METHODS.has(request.method);
  if (mutating) {
    if (requiresJsonContentType(request)) {
      return { ok: false, status: 403, code: "forbidden", message: "mutating console requests require Content-Type: application/json" };
    }
    const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      return { ok: false, status: 403, code: "forbidden", message: "cross-origin console request rejected" };
    }
    const originEnv = options.publicOrigin === undefined ? options.env : { PUBLIC_ORIGIN: options.publicOrigin ?? "" };
    if (!isSameOriginRequest(request, options.trustProxy, originEnv)) {
      return { ok: false, status: 403, code: "forbidden", message: "same-origin console request required" };
    }
  }
  const token = readCookie(request, SESSION_COOKIE_NAME);
  const result = await verifySessionToken(token, { secret: options.jwtSecret, expectedPv: options.passwordVersion });
  if (!result.ok) {
    return result.reason === "expired"
      ? { ok: false, status: 401, code: "unauthorized", message: "session expired" }
      : { ok: false, status: 401, code: "unauthorized", message: "invalid session" };
  }
  if (mutating && !(await verifyConsoleCsrfToken(options.jwtSecret, result.payload.jti, request.headers.get(CSRF_HEADER_NAME)))) {
    return { ok: false, status: 403, code: "forbidden", message: "invalid console CSRF token" };
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
