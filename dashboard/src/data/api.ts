import type { SessionResponse, SessionUser } from "./contracts";

export interface ApiErrorShape {
  readonly status: number;
  readonly message: string;
  readonly code?: string;
  readonly origin?: "cartethyia" | "upstream" | "network";
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Request options accepted by the same-origin console client. */
export interface ConsoleRequestInit extends RequestInit {
  /**
   * Skip the CSRF header for unauthenticated auth endpoints such as
   * login and first-boot setup. Mutating dashboard endpoints keep protection
   * enabled by default.
   */
  readonly csrf?: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_EXEMPT_PATHS = new Set(["/auth/login", "/auth/setup"]);
const CSRF_COOKIE_NAME = "csrf_token";

/**
 * Canonical guard for dashboard wire boundaries. List endpoints assert
 * `Array.isArray` explicitly before calling this on elements. Quota and auth
 * payloads are object envelopes, so this strict guard is safe.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fallback when a response carries no message of its own.
 *
 * The status decides whose failure it is. A 502 is the upstream's refusal
 * relayed through the gateway, and labelling it "Console request failed" told
 * the operator the console was broken when the provider had rejected the
 * account. The console is only blamed for the statuses it actually produces.
 */
export function fallbackRequestMessage(status: number, origin?: ApiErrorShape["origin"]): string {
  const whose =
    origin === "upstream" || (origin === undefined && status >= 500)
      ? "Upstream"
      : origin === "network"
        ? "Network"
        : "Console";
  return `${whose} request failed (${status})`;
}

function responseMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
    if (isRecord(payload.error) && typeof payload.error.message === "string")
      return payload.error.message;
  }
  return fallbackRequestMessage(status, responseOrigin(payload));
}

function responseCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.code === "string") return payload.code;
  if (isRecord(payload.error) && typeof payload.error.code === "string") return payload.error.code;
  return undefined;
}
function responseOrigin(payload: unknown): ApiErrorShape["origin"] {
  if (!isRecord(payload)) return undefined;
  const candidate =
    typeof payload.origin === "string"
      ? payload.origin
      : isRecord(payload.error) && typeof payload.error.origin === "string"
        ? payload.error.origin
        : undefined;
  return candidate === "cartethyia" || candidate === "upstream" || candidate === "network"
    ? candidate
    : undefined;
}

function responseDetails(payload: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(payload)) return undefined;
  const details = isRecord(payload.details)
    ? payload.details
    : isRecord(payload.error) && isRecord(payload.error.details)
      ? payload.error.details
      : undefined;
  return details;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    const error: ApiErrorShape = {
      status: response.status,
      code: "invalid_response",
      message: `Upstream returned a non-JSON response (${response.status})`,
    };
    throw error;
  }
}

function throwApiError(payload: unknown, status: number): never {
  const code = responseCode(payload);
  const origin = responseOrigin(payload);
  const details = responseDetails(payload);
  const error: ApiErrorShape = {
    status,
    message: responseMessage(payload, status),
    ...(code ? { code } : {}),
    ...(origin ? { origin } : {}),
    ...(details ? { details } : {}),
  };
  throw error;
}

/**
 * Reads the double-submit CSRF token from `document.cookie`. The server sets
 * it as a readable cookie at login/refresh, so mutations need no token
 * fetch round-trip — the value is echoed back in `X-CSRF-Token`.
 */
export function readConsoleCsrfCookie(): string | undefined {
  if (typeof document === "undefined" || typeof document.cookie !== "string") return undefined;
  for (const part of document.cookie.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    if (part.slice(0, eqIndex).trim() === CSRF_COOKIE_NAME) {
      const value = part.slice(eqIndex + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function shouldUseCsrf(path: string, method: string, init: ConsoleRequestInit): boolean {
  if (init.csrf === false || SAFE_METHODS.has(method)) return false;
  return !CSRF_EXEMPT_PATHS.has(path);
}

/** Session transitions surfaced to the shell from a fresh failing response. */
export type SessionTransitionKind = "expired" | "banned";

/**
 * Auth/bootstrap endpoints own their 401/403 story locally (bad credentials,
 * lockout-before-identity, "unauthenticated" envelope). Fanning them out into
 * a shell-wide transition would bounce the login page on a wrong password.
 */
const SESSION_TRANSITION_EXEMPT_PATHS = new Set([
  "/auth/login",
  "/auth/setup",
  "/auth/setup/restore",
  "/auth/session",
  "/auth/first-boot",
]);

/**
 * Console-origin 403 codes that are scope/tenant/routing policy denials rather
 * than a security lockout. They stay inline on the page; only an unrecognized
 * 403 is treated as a ban so a locked-out client is bounced to /banned.
 */
const NON_BAN_FORBIDDEN_CODES = new Set([
  "insufficient_scope",
  "tenant_required",
  "provider_is_builtin",
  "invalid_scope",
  "invalid_request",
  "not_authorized",
]);

type SessionTransitionListener = (kind: SessionTransitionKind) => void;

let sessionTransitionListener: SessionTransitionListener | undefined;

/**
 * Registers the single shell listener that reacts to 401/403 responses by
 * redirecting the active shell. `App` wires this once; feature code never
 * calls it directly. Passing `undefined` detaches.
 */
export function setSessionTransitionListener(listener: SessionTransitionListener | undefined): void {
  sessionTransitionListener = listener;
}

function signalSessionTransition(kind: SessionTransitionKind): void {
  sessionTransitionListener?.(kind);
}

/**
 * Fans a fresh failure out to the shell only when it is a console-origin auth
 * failure (not an upstream/network provider failure) representing the current
 * dashboard session expiring (401) or the client being banished (403).
 */
function maybeSignalSessionTransition(path: string, status: number, payload: unknown): void {
  if (SESSION_TRANSITION_EXEMPT_PATHS.has(path)) return;
  if (status !== 401 && status !== 403) return;
  if (responseOrigin(payload) === "upstream" || responseOrigin(payload) === "network") return;
  if (status === 401) {
    signalSessionTransition("expired");
    return;
  }
  const code = responseCode(payload);
  if (code !== undefined && NON_BAN_FORBIDDEN_CODES.has(code)) return;
  signalSessionTransition("banned");
}

/** Calls a same-origin console endpoint and parses its typed JSON response. */
export async function consoleRequest<TResponse>(
  path: string,
  init: ConsoleRequestInit = {},
): Promise<TResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body != null && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (shouldUseCsrf(path, method, init) && !headers.has("X-CSRF-Token")) {
    const csrf = readConsoleCsrfCookie();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  const { csrf: _csrf, ...requestInit } = init;
  void _csrf;
  const execute = (): Promise<Response> =>
    fetch(`/console/api${path}`, {
      ...requestInit,
      method,
      credentials: "same-origin",
      headers,
    });

  const response = await execute();
  const payload: unknown = await readJson(response);
  if (!response.ok) {
    maybeSignalSessionTransition(path, response.status, payload);
    throwApiError(payload, response.status);
  }
  return payload as TResponse;
}
export interface TransferProgress {
  readonly loaded: number;
  readonly total: number | null;
}

export async function consoleBytes(
  path: string,
  onProgress?: (progress: TransferProgress) => void,
): Promise<Uint8Array> {
  const response = await fetch(`/console/api${path}`, { credentials: "same-origin" });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    maybeSignalSessionTransition(path, response.status, payload);
    throwApiError(payload, response.status);
  }
  return readBodyBytes(response, onProgress);
}

export async function consoleUpload<TResponse>(
  path: string,
  body: string,
  onProgress?: (progress: TransferProgress) => void,
): Promise<TResponse> {
  const total = new TextEncoder().encode(body).byteLength;
  const response = await new Promise<Response>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/console/api${path}`);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", "application/json");
    request.setRequestHeader("Accept", "application/json");
    const csrf = readConsoleCsrfCookie();
    if (csrf) request.setRequestHeader("X-CSRF-Token", csrf);
    request.upload.onprogress = (event) => {
      onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : total });
    };
    request.onload = () => resolve(new Response(request.responseText, { status: request.status }));
    request.onerror = () => reject(new Error("Network request failed"));
    request.send(body);
  });
  const payload: unknown = await readJson(response);
  if (!response.ok) {
    maybeSignalSessionTransition(path, response.status, payload);
    throwApiError(payload, response.status);
  }
  return payload as TResponse;
}

async function readBodyBytes(
  response: Response,
  onProgress?: (progress: TransferProgress) => void,
): Promise<Uint8Array> {
  const total = Number(response.headers.get("content-length"));
  const known = Number.isFinite(total) && total > 0 ? total : null;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    loaded += next.value.byteLength;
    onProgress?.({ loaded, total: known });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
/**
 * Loads the current signed-in console user, or `null` when the session is
 * not authenticated. Single helper for every dashboard session check
 * (route guard + `useSessionUser`) so the wire mapping cannot diverge.
 */
export async function fetchSessionUser(): Promise<SessionUser | null> {
  const result = await consoleRequest<SessionResponse>("/auth/session");
  if (result.status !== "authenticated") return null;
  return {
    id: result.user_id,
    username: result.username,
    email: result.email,
    displayName: result.display_name,
    isFirstBoot: result.is_first_boot,
    sessionExpiresAt: result.session_expires_at,
    isPlatformAdmin: result.is_platform_admin,
  };
}
