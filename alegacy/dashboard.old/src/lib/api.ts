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

export type DaemonHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

const SUPPORTED_METHODS: ReadonlySet<DaemonHttpMethod> = new Set(["GET", "POST", "PATCH", "DELETE"]);
const V2_ROUTE_PREFIX = "/v2/";
const SAFE_CODE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;

function normalizeRoute(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!normalized.startsWith(V2_ROUTE_PREFIX)) {
    throw new ApiError(400, "invalid_route", "dashboard routes must use the V2 daemon API");
  }
  return normalized;
}

function normalizeMethod(method: string | undefined): DaemonHttpMethod {
  const normalized = (method ?? "GET").toUpperCase();
  if (!SUPPORTED_METHODS.has(normalized as DaemonHttpMethod)) {
    throw new ApiError(405, "method_not_allowed", "dashboard transport supports GET, POST, PATCH, and DELETE");
  }
  return normalized as DaemonHttpMethod;
}

function requestParts(path: string, init: RequestInit): { path: string; method: DaemonHttpMethod; body: BodyInit | null | undefined; headers: Headers } {
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


/** Execute a raw daemon response while retaining response headers and body. */
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

/** Download a V2 daemon response, surfacing structured server errors. */
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



