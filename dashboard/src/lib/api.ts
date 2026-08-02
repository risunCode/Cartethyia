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

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/console/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && path !== "/login") {
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

export const apiGet = <T>(path: string) => api<T>(path);
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
