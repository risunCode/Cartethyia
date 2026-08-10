/** API client — same-origin fetch to /console/api with 401 handling. */

export interface ApiErrorShape {
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "QUERY"]);
const CSRF_HEADER = "x-cartethyia-csrf";

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function loadCsrfToken(): Promise<string> {
  if (csrfToken !== null) return csrfToken;
  if (csrfRequest !== null) return csrfRequest;
  csrfRequest = (async () => {
    const response = await fetch("/console/api/csrf", {
      method: "QUERY",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new ApiError(response.status, "unauthorized", "console CSRF bootstrap failed");
    const body = (await response.json()) as { csrfToken?: unknown };
    if (typeof body.csrfToken !== "string" || body.csrfToken.length === 0) throw new ApiError(500, "internal_error", "console CSRF bootstrap returned an invalid token");
    csrfToken = body.csrfToken;
    return body.csrfToken;
  })();
  try {
    return await csrfRequest;
  } finally {
    csrfRequest = null;
  }
}

function clearCsrfToken(): void {
  csrfToken = null;
  csrfRequest = null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // A successful login can replace the session JTI; never reuse a CSRF token
  // derived from the previous browser session.
  if (path === "/login") clearCsrfToken();
  const method = init.method ?? "QUERY";
  const body = init.body ?? (method === "QUERY" ? "{}" : undefined);
  const headers = new Headers(init.headers);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!SAFE_METHODS.has(method) && path !== "/login") headers.set(CSRF_HEADER, await loadCsrfToken());
  const res = await fetch(`/console/api${path}`, {
    credentials: "same-origin",
    ...init,
    method,
    body,
    headers,
  });
  if (path === "/login" && res.ok) clearCsrfToken();
  if (res.status === 401 && path !== "/login") {
    clearCsrfToken();
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
    const err = parsed as { error?: ApiErrorShape } | null;
    throw new ApiError(res.status, err?.error?.code ?? "error", err?.error?.message ?? `request failed (${res.status})`);
  }
  return parsed as T;
}

export const apiGet = <T>(path: string) => {
  const queryString = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  const queryBody = Object.fromEntries(new URLSearchParams(queryString));
  return api<T>(path, { method: "QUERY", body: JSON.stringify(queryBody) });
};
export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) });
export const apiPatch = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PATCH", body: body === undefined ? "{}" : JSON.stringify(body) });
// Sends a body (like apiPost/apiPatch) so `content-type: application/json`
// is set - the console's CSRF guard (src/console/auth/guard.ts) requires
// that header on every mutating request, and `api()` only adds it when a
// body is present. Without this, every DELETE from the dashboard was
// silently rejected with 403 "mutating console requests require
// Content-Type: application/json" - confirmed by a live report.
export const apiDelete = <T>(path: string) => api<T>(path, { method: "DELETE", body: "{}" });
