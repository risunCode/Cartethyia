/**
 * Dashboard fetch helper — typed wrapper around the same-origin
 * `/api/dashboard/...` endpoints with cache-middleware integration.
 *
 * Uses the same TTL table as `lib/cache.ts`, so dashboard reads benefit
 * from the existing TTL configuration without requiring callers to wire up
 * the cache directly.
 */

import { apiCache, getCacheKey } from "./cache";
import { ApiError, sanitizeErrorMessage } from "./api";

export interface DashboardFetchOptions {
  /** Cache TTL override (ms). Falls back to the table in cache.ts. */
  ttlMs?: number;
  /** Extra cache-key discriminators (e.g. range, period). */
  params?: Record<string, string | number | boolean>;
  /** Force a network read and ignore cached entries. */
  bypassCache?: boolean;
}

export class DashboardFetchError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "DashboardFetchError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Typed fetch for `/api/dashboard/...` endpoints. Reads through `apiCache`
 * first; on miss, fetches and stores the parsed JSON with the configured TTL.
 */
export async function dashboardFetch<T>(endpoint: string, options: DashboardFetchOptions = {}): Promise<T> {
  const cacheKey = getCacheKey(endpoint, options.params);

  if (!options.bypassCache) {
    const cached = apiCache.get<T>(cacheKey);
    if (cached !== null) {
      return cached;
    }
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Network error";
    throw new DashboardFetchError(sanitizeErrorMessage(message, "Network error"), 0, "network_error");
  }

  if (!response.ok) {
    let code = `http_${response.status}`;
    let detail = response.statusText || `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown; error?: unknown };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") detail = body.message;
      else if (typeof body.error === "string") detail = body.error;
    } catch {
      // body is not JSON; keep status text
    }
    throw new DashboardFetchError(sanitizeErrorMessage(detail, `Request failed (${response.status})`), response.status, code);
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch (cause) {
    throw new DashboardFetchError("Invalid JSON response", 200, "invalid_json");
  }

  apiCache.set(cacheKey, data, options.ttlMs);
  return data;
}

/** Convenience: wraps dashboardFetch so it returns null instead of throwing on network errors. */
export async function dashboardFetchSafe<T>(endpoint: string, options: DashboardFetchOptions = {}): Promise<T | null> {
  try {
    return await dashboardFetch<T>(endpoint, options);
  } catch (error) {
    if (error instanceof ApiError || error instanceof DashboardFetchError) {
      console.warn(`dashboardFetchSafe(${endpoint})`, error.message);
    }
    return null;
  }
}
