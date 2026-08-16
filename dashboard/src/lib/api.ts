/** API client — same-origin fetch to /console/api with 401 handling. */

export interface ApiErrorShape {
  code: string;
  message: string;
}

const SECRET_MESSAGE = /(?:authorization|bearer\s+|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|password|passwd|credential(?:ref|value)?|cookie|prompt|provider[\s_-]?response|response(?:[\s_-]?(?:body|data|payload))?)\s*[:=]/i;
const JWT_VALUE = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/;

/**
 * Keeps operator-facing error text short and free of control characters or
 * common credential/payload markers.
 */
export function sanitizeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0
    || normalized.length > 256
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || SECRET_MESSAGE.test(normalized)
    || JWT_VALUE.test(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(sanitizeErrorMessage(message, "request failed"));
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;

export type ConsoleHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

const SUPPORTED_METHODS: ReadonlySet<ConsoleHttpMethod> = new Set(["GET", "POST", "PATCH", "DELETE"]);
const V2_ROUTE_PREFIX = "/v2/";
const SAFE_CODE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;

function normalizeRoute(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!normalized.startsWith(V2_ROUTE_PREFIX)) {
    throw new ApiError(400, "invalid_route", "dashboard routes must use the console API");
  }
  return normalized;
}

function normalizeMethod(method: string | undefined): ConsoleHttpMethod {
  const normalized = (method ?? "GET").toUpperCase();
  if (!SUPPORTED_METHODS.has(normalized as ConsoleHttpMethod)) {
    throw new ApiError(405, "method_not_allowed", "dashboard transport supports GET, POST, PATCH, and DELETE");
  }
  return normalized as ConsoleHttpMethod;
}

function requestParts(path: string, init: RequestInit): { path: string; method: ConsoleHttpMethod; body: BodyInit | null | undefined; headers: Headers } {
  const normalizedPath = normalizeRoute(path);
  const method = normalizeMethod(init.method);
  const body = init.body;
  if (method === "GET" && body !== undefined && body !== null) {
    throw new ApiError(400, "invalid_request", "GET requests cannot include a body");
  }
  const headers = new Headers(init.headers);
  if (body !== undefined && body !== null && !(body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return { path: normalizedPath, method, body, headers };
}

function isLoginRoute(path: string): boolean {
  return path === "/v2/admin/auth/login";
}

function safeErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
}

function safeErrorMessage(value: unknown, fallback: string): string {
  return sanitizeErrorMessage(value, fallback);
}

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const request = requestParts(path, init);
  const res = await fetch(`/console/api${request.path}`, {
    ...init,
    credentials: "same-origin",
    method: request.method,
    body: request.body,
    headers: request.headers,
  });
  return parseApiResponse<T>(request.path, res);
}

async function parseApiResponse<T>(path: string, res: Response): Promise<T> {
  if (res.status === 401 && !isLoginRoute(path)) {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized", "session expired");
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const err = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as { error?: ApiErrorShape | string }
      : null;
    const bodyError = err?.error !== null && typeof err?.error === "object" ? err.error : null;
    const fallbackCode = res.status === 501 ? "not_implemented" : "error";
    const code = safeErrorCode(bodyError?.code, fallbackCode);
    const message = safeErrorMessage(
      bodyError?.message ?? (typeof err?.error === "string" ? err.error : null),
      `request failed (${res.status})`,
    );
    throw new ApiError(res.status, code, message);
  }
  return parsed as T;
}


/** Execute a raw API request while retaining response headers and body. */
export async function apiRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const request = requestParts(path, init);
  const res = await fetch(`/console/api${request.path}`, {
    ...init,
    credentials: "same-origin",
    method: request.method,
    body: request.body,
    headers: request.headers,
  });
  if (res.status === 401 && !isLoginRoute(request.path)) {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized", "session expired");
  }
  return res;
}

/** Download a raw API response, surfacing structured server errors. */
export async function apiDownload(path: string, init: RequestInit = {}): Promise<{ blob: Blob; filename: string | null }> {
  const normalizedPath = normalizeRoute(path);
  const res = await apiRaw(normalizedPath, { ...init, method: init.method ?? "GET" });
  if (!res.ok) {
    await parseApiResponse<never>(normalizedPath, res);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="?([^"]+)"?/)?.[1] ?? null;
  return { blob: await res.blob(), filename };
}


// ---------------------------------------------------------------------------
// Dashboard fetchAPI wrapper
// ---------------------------------------------------------------------------
//
// Higher-level client layered on top of `api()` that the dashboard pages
// should reach for. It adds:
//
//   * Authorization header injection from `userSession()` signals.
//   * In-memory TTL cache for idempotent GETs.
//   * Automatic retry with exponential backoff for transient failures.
//   * Structured `ApiError` propagation.
//
// Cache invalidation is exposed via `invalidateApiCache()` and the
// settings-aware `onSettingsChanged()` helper used by the Settings page.

import { apiCache, getCacheKey } from "./cache";
import {
  userSession,
  login as storeLogin,
  logout as storeLogout,
} from "./store";
import type {
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  LogoutResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from "../types/api";

/** HTTP methods accepted by `fetchAPI`. */
export type FetchApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Per-request options for `fetchAPI`. */
export interface FetchApiOptions {
  /** HTTP method (default: "GET"). Only GET responses are eligible for caching. */
  method?: FetchApiMethod;
  /** Override request body. Objects are JSON-encoded automatically. */
  body?: BodyInit | Record<string, unknown> | null;
  /** Extra headers merged on top of the defaults. */
  headers?: Record<string, string>;
  /** Bypass the cache entirely on read and write (default: false). */
  noCache?: boolean;
  /** Skip storing the response in cache after a successful fetch (default: false). */
  noStore?: boolean;
  /** Override cache TTL in milliseconds. Falls back to the per-endpoint default. */
  cacheTtlMs?: number;
  /** Query parameters appended to the URL and folded into the cache key. */
  params?: Record<string, string | number | boolean>;
  /** Override the number of retry attempts (default: 2). Set to 0 to disable. */
  retries?: number;
  /** Abort signal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/** Default number of retry attempts for transient failures. */
const DEFAULT_RETRIES = 2;
/** Base delay for the exponential backoff schedule, in milliseconds. */
const RETRY_BASE_DELAY_MS = 250;
/** Cap on the exponential backoff, in milliseconds. */
const RETRY_MAX_DELAY_MS = 4_000;
/** Methods whose responses are safe to cache. */
const CACHEABLE_METHODS: ReadonlySet<FetchApiMethod> = new Set<FetchApiMethod>(["GET"]);

/** Status codes that are safe to retry (network hiccups + 5xx + 429). */
function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** Sleep helper used between retry attempts; honors the abort signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * High-level dashboard fetch wrapper.
 *
 * Behaviour:
 *   * Injects the bearer token from `userSession()` for non-login routes.
 *   * Caches `GET` responses in the shared `apiCache`, keyed by URL + params.
 *   * Retries transient failures with exponential backoff (up to `retries`).
 *   * Surfaces server errors as structured `ApiError` instances.
 */
export async function fetchAPI<T>(path: string, options: FetchApiOptions = {}): Promise<T> {
  const method: FetchApiMethod = options.method ?? "GET";
  const cacheKey = getCacheKey(path, options.params);
  const cacheable = CACHEABLE_METHODS.has(method) && !options.noStore;

  if (cacheable && !options.noCache) {
    const hit = apiCache.get<T>(cacheKey);
    if (hit !== null) {
      return hit;
    }
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };

  // Authentication header — never attach to the login route.
  if (!isLoginRoute(path)) {
    const token = userSession().token;
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    }
  }

  const init: RequestInit = {
    method,
    headers,
    credentials: "same-origin",
  };
  if (options.signal) {
    init.signal = options.signal;
  }
  if (options.body !== undefined && options.body !== null) {
    if (options.body instanceof FormData || typeof options.body === "string") {
      init.body = options.body;
    } else {
      init.body = JSON.stringify(options.body);
      if (!("content-type" in headers)) {
        headers["content-type"] = "application/json";
      }
    }
  }

  const maxAttempts = Math.max(0, options.retries ?? DEFAULT_RETRIES) + 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const data = await api<T>(path, init);
      if (cacheable && !options.noCache) {
        apiCache.set(cacheKey, data, options.cacheTtlMs);
      }
      return data;
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ApiError
        ? isRetryableStatus(err.status)
        : true;
      if (!retryable || attempt === maxAttempts - 1) {
        throw err;
      }
      const backoff = Math.min(
        RETRY_BASE_DELAY_MS * 2 ** attempt,
        RETRY_MAX_DELAY_MS,
      );
      try {
        await sleep(backoff, options.signal);
      } catch (sleepErr) {
        if (sleepErr instanceof DOMException && sleepErr.name === "AbortError") {
          throw err;
        }
        throw sleepErr;
      }
    }
  }

  // Unreachable — the loop always returns or throws — but keeps the type system happy.
  throw lastError instanceof Error
    ? lastError
    : new ApiError(0, "unknown_error", "request failed");
}

// ---------------------------------------------------------------------------
// Cache invalidation helpers
// ---------------------------------------------------------------------------

/** Invalidate a single cached entry by URL + params. */
export function invalidateApiCache(path: string, params?: Record<string, string | number | boolean>): void {
  apiCache.invalidate(getCacheKey(path, params));
}

/** Invalidate every cache entry whose key matches a substring or regex. */
export function invalidateApiCachePattern(pattern: string | RegExp): void {
  if (pattern instanceof RegExp) {
    apiCache.invalidatePattern(pattern.source);
  } else {
    apiCache.invalidatePattern(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}

/** Drop the entire dashboard cache. */
export function clearApiCache(): void {
  apiCache.clear();
}

/** Endpoints whose cached values must be discarded when the user changes settings. */
const SETTINGS_DEPENDENT_PATTERNS: readonly RegExp[] = [
  /\/api\/dashboard\/summary/,
  /\/api\/dashboard\/usage/,
  /\/api\/dashboard\/providers/,
  /\/api\/dashboard\/quota/,
  /\/api\/dashboard\/settings/,
  /\/api\/share/,
];

/**
 * Settings change handler — invalidates every cached response that
 * depends on user-tunable configuration. Call this from the Settings
 * page after a successful PATCH so the next fetch re-hits the server.
 */
export function onSettingsChanged(): void {
  for (const pattern of SETTINGS_DEPENDENT_PATTERNS) {
    apiCache.invalidatePattern(pattern.source);
  }
}

// ---------------------------------------------------------------------------
// Authentication flow
// ---------------------------------------------------------------------------

/**
 * Authenticate against the API, persist the session in the store
 * signals, and return the parsed response.
 *
 * The login response is intentionally NOT cached — it must always travel
 * to the server.
 */
export async function login(credentials: LoginRequest): Promise<LoginResponse> {
  const response = await api<LoginResponse>("/v2/admin/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
    headers: { "content-type": "application/json" },
  });
  const userRecord = response.user as unknown as Record<string, unknown>;
  if (response.refreshToken) {
    userRecord.refreshToken = response.refreshToken;
  }
  storeLogin(response.token, userRecord);
  scheduleTokenRefresh(response.token, response.refreshToken, response.expiresAt);
  return response;
}

/**
 * Exchange a refresh token for a new session token. The store signal is
 * updated in place and the refresh timer rescheduled for the new expiry.
 */
export async function refreshSession(request: RefreshTokenRequest): Promise<RefreshTokenResponse> {
  const response = await api<RefreshTokenResponse>("/v2/admin/auth/refresh", {
    method: "POST",
    body: JSON.stringify(request),
    headers: { "content-type": "application/json" },
  });
  // Preserve the current user while swapping the token.
  const current = userSession();
  const userRecord: Record<string, unknown> = current.user
    ? { ...current.user, refreshToken: request.refreshToken }
    : { refreshToken: request.refreshToken };
  storeLogin(response.token, userRecord);
  scheduleTokenRefresh(response.token, request.refreshToken, response.expiresAt);
  return response;
}

/**
 * Tear down the session on both sides: notify the API (best effort)
 * and clear the store signals + cached responses.
 */
export async function logout(request: LogoutRequest = {}): Promise<LogoutResponse> {
  let response: LogoutResponse = { success: true };
  try {
    response = await api<LogoutResponse>("/v2/admin/auth/logout", {
      method: "POST",
      body: Object.keys(request).length > 0 ? JSON.stringify(request) : undefined,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // Local logout still proceeds even if the API call fails — the
    // user must always be able to sign out of a stale or broken session.
  } finally {
    cancelTokenRefresh();
    storeLogout();
    clearApiCache();
  }
  return response;
}

// ---------------------------------------------------------------------------
// Token refresh scheduler
// ---------------------------------------------------------------------------

/** Active timer for the next automatic token refresh. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Cached refresh token used by the scheduled refresh job. */
let cachedRefreshToken: string | null = null;

/** Proactive refresh happens when 80% of the token lifetime has elapsed. */
const REFRESH_LEAD_RATIO = 0.8;
/** Minimum lead time before refresh (in ms) when no expiry is supplied. */
const REFRESH_MIN_LEAD_MS = 30_000;
/** Default token lifetime used when the server omits `expiresAt`. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1 hour

/** Convert a possibly-mixed timestamp into a millisecond expiry. */
function resolveExpiryMs(expiresAt: number | undefined, fallbackLifetimeMs: number): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    // Accept both epoch milliseconds and epoch seconds for resilience.
    return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  }
  return Date.now() + fallbackLifetimeMs;
}

/**
 * Schedule a proactive refresh based on the response expiry.
 * Existing timers are always cancelled before scheduling a new one.
 */
function scheduleTokenRefresh(token: string, refreshToken: string | undefined, expiresAt: number | undefined): void {
  cancelTokenRefresh();
  if (typeof window === "undefined" || !token) return;
  cachedRefreshToken = refreshToken ?? cachedRefreshToken;
  if (!cachedRefreshToken) return;
  const expiryMs = resolveExpiryMs(expiresAt, DEFAULT_TOKEN_LIFETIME_MS);
  const lead = Math.max(REFRESH_MIN_LEAD_MS, (expiryMs - Date.now()) * (1 - REFRESH_LEAD_RATIO));
  const delay = Math.max(0, expiryMs - Date.now() - lead);
  refreshTimer = setTimeout(() => {
    void runScheduledRefresh();
  }, delay);
}

/** Cancel any pending refresh timer. Safe to call when none is scheduled. */
function cancelTokenRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  cachedRefreshToken = null;
}

/**
 * Run the scheduled refresh. Uses the cached refresh token captured at
 * the most recent login; if none is available, falls back to the
 * unauthorized handler so the app can prompt the user to re-authenticate.
 */
async function runScheduledRefresh(): Promise<void> {
  refreshTimer = null;
  const current = userSession();
  if (!current.token) return;
  if (!cachedRefreshToken) {
    // No refresh token available — surface an auth failure so the app
    // can prompt the user to re-authenticate via the unauthorized handler.
    onUnauthorized?.();
    return;
  }
  try {
    await refreshSession({ refreshToken: cachedRefreshToken });
  } catch {
    onUnauthorized?.();
  }
}
