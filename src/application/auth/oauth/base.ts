import type { OAuthStartInput, OAuthStartResult } from "../contracts";
import { assertPublicUrl, SsrfGuardError } from "../../../security/ssrf-guard";

/**
 * Shared plumbing for provider OAuth drivers.
 *
 * The active `AuthDriver` contract is intentionally thin: token exchange and
 * refresh return a provider-neutral {@link TokenSet}. Providers build their own
 * wire headers directly from the credential — auth does not leak transport
 * concerns through the driver contract.
 *
 * Because the contract does not expose transport/fetch injection, every driver
 * below is a *pure driver*: it accepts an injectable `fetch` (with a timeout
 * and injectable clock) at construction time so tests never touch the network
 * and callers can route through a proxy or a local transport. Excluded
 * providers (Devin/Grok) are intentionally not represented here.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const OAUTH_REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_RESPONSE_MAX_BYTES = 64 * 1024;

/** Injectable fetch-compatible transport (mirrors the global `fetch` shape). */
export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OAuthDriverOptions {
  readonly fetch?: OAuthFetch;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** Typed OAuth driver failure; `status` mirrors an HTTP status where applicable. */
export class OAuthDriverError extends Error {
  readonly kind: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAt: string | null;

  constructor(kind: string, message: string, status = 502, retryable = false, retryAt: string | null = null) {
    super(message);
    this.name = "OAuthDriverError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
    this.retryAt = retryAt;
  }
}


export function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Coerces an unverified base64 (optionally base64url) string to its UTF-8 text without Buffer. */
export function base64Decode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Generates an RFC 7636 PKCE verifier/challenge pair. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  const verifier = bytesToBase64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(base64Decode(payload));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseTokenExpiry(expiresIn: unknown, provider: string, nowMs: number): number {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthDriverError("validation", `${provider} OAuth response is missing expires_in.`, 502);
  }
  return nowMs + expiresIn * 1_000 - OAUTH_REFRESH_SKEW_MS;
}

/** Parses `access_token` / `refresh_token` / `expires_in` from an OAuth token response. */
export function tokenFields(
  data: Record<string, unknown>,
  provider: string,
  operation: string,
  nowMs: number,
  requireRefresh = true,
): { access: string; refresh: string | undefined; expiresAtMs: number } {
  const access = nonEmpty(data.access_token);
  const refresh = nonEmpty(data.refresh_token);
  if (!access || (requireRefresh && !refresh)) {
    throw new OAuthDriverError("validation", `${provider} OAuth ${operation} response is missing token fields.`, 502);
  }
  return { access, refresh, expiresAtMs: parseTokenExpiry(data.expires_in, provider, nowMs) };
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OAuthDriverError("validation", "OAuth response was not an object.", 502);
  }
  return value as Record<string, unknown>;
}

/**
 * Timeout-bounded OAuth HTTP client. Every failure is normalized to an
 * {@link OAuthDriverError}; 5xx / 408 / 429 are flagged retryable, matching
 * the legacy token keeper's error policy.
 */
export interface OAuthHttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly retryAt: string | null;
}

export class OAuthHttpClient {
  private readonly fetchFn: OAuthFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly nowMs: () => number;

  constructor(options: OAuthDriverOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_OAUTH_RESPONSE_MAX_BYTES);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async postForm(
    url: string,
    body: Record<string, string>,
    provider: string,
    operation: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    return this.send(
      url,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() },
      provider,
      operation,
    );
  }

  async postJson(
    url: string,
    body: Record<string, unknown>,
    provider: string,
    operation: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    return this.send(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, provider, operation);
  }
  async getJson(
    url: string,
    provider: string,
    operation: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    return this.send(url, { method: "GET", headers }, provider, operation);
  }
  /** POST form and preserve a bounded JSON error body for device-flow polling. */
  async postFormResult(
    url: string,
    body: Record<string, string>,
    provider: string,
    operation: string,
    headers: Record<string, string> = {},
  ): Promise<OAuthHttpResult> {
    return this.request(
      url,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() },
      provider,
      operation,
    );
  }

  /** POST JSON and preserve a bounded JSON error body for protocol-specific flows. */
  async postJsonResult(
    url: string,
    body: Record<string, unknown>,
    provider: string,
    operation: string,
    headers: Record<string, string> = {},
  ): Promise<OAuthHttpResult> {
    return this.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, provider, operation);
  }

  /** GET that never throws on HTTP errors / network failure — for best-effort enrichment calls. */
  async tryGet(url: string, headers: Record<string, string>, _provider: string, _operation: string): Promise<{ ok: boolean; status: number; text: string }> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, { headers });
      const text = await this.readBoundedText(response);
      return text === null ? { ok: false, status: response.status, text: "" } : { ok: response.ok, status: response.status, text };
    } catch {
      return { ok: false, status: 0, text: "" };
    }
  }

  private async send(url: string, init: RequestInit, provider: string, operation: string): Promise<Record<string, unknown>> {
    const result = await this.request(url, init, provider, operation);
    if (!result.ok) {
      const retryable = result.status >= 500 || result.status === 408 || result.status === 429;
      throw new OAuthDriverError(`${operation}-http`, `${provider} OAuth ${operation} failed with HTTP ${result.status}.`, result.status, retryable, result.retryAt);
    }
    if (result.body === null) throw new OAuthDriverError("malformed-response", `${provider} OAuth ${operation} returned invalid JSON.`, 502);
    return result.body;
  }

  private async request(url: string, init: RequestInit, provider: string, operation: string): Promise<OAuthHttpResult> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, init);
    } catch (error) {
      if (error instanceof OAuthDriverError) throw error;
      throw new OAuthDriverError("network", `${provider} OAuth ${operation} network request failed.`, 503, true);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new OAuthDriverError("redirect", `${provider} OAuth ${operation} returned an unexpected redirect.`, 502, false);
    }
    const contentType = response.headers.get("content-type");
    if (!response.ok && !isJsonContentType(contentType)) {
      return { ok: false, status: response.status, body: null, retryAt: parseRetryAfter(response.headers.get("retry-after"), this.nowMs()) };
    }
    if (!isJsonContentType(contentType)) {
      throw new OAuthDriverError("content-type", `${provider} OAuth ${operation} returned an unexpected content type.`, 502, false);
    }
    const text = await this.readBoundedText(response);
    if (text === null) {
      if (!response.ok) return { ok: false, status: response.status, body: null, retryAt: parseRetryAfter(response.headers.get("retry-after"), this.nowMs()) };
      throw new OAuthDriverError("response-too-large", `${provider} OAuth ${operation} response exceeded the size limit.`, 502, false);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = parseJsonRecord(JSON.parse(text) as unknown);
    } catch {
      if (!response.ok) return { ok: false, status: response.status, body: null, retryAt: parseRetryAfter(response.headers.get("retry-after"), this.nowMs()) };
      throw new OAuthDriverError("malformed-response", `${provider} OAuth ${operation} returned invalid JSON.`, 502);
    }
    return { ok: response.ok, status: response.status, body, retryAt: parseRetryAfter(response.headers.get("retry-after"), this.nowMs()) };
  }

  private async fetchWithTimeout(input: string | URL | Request, init: RequestInit): Promise<Response> {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    try {
      assertPublicUrl(rawUrl, { label: "OAuth URL", allowedProtocols: { "https:": true } });
    } catch (error) {
      if (error instanceof SsrfGuardError) throw new OAuthDriverError("validation", error.message, 400, false);
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(input, { ...init, redirect: "manual", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new OAuthDriverError("timeout", "OAuth request timed out.", 502, true);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBoundedText(response: Response): Promise<string | null> {
    const contentLength = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(contentLength) && contentLength > this.maxBytes) return null;
    if (response.body === null) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        totalBytes += value.byteLength;
        if (totalBytes > this.maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(buffer);
  }
}

function isJsonContentType(contentType: string | null): boolean {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === "application/json" || normalized.endsWith("+json");
}

function parseRetryAfter(value: string | null, nowMs: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return new Date(nowMs + Number(trimmed) * 1000).toISOString();
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Shared {@link OAuthStartResult} shaping and PKCE/state handling for authorization-code drivers. */
export abstract class AuthorizationCodeDriver {
  protected readonly http: OAuthHttpClient;
  protected readonly nowMs: () => number;
  readonly kind = "oauth" as const;

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  protected abstract get providerId(): string;

  /** Returns the authorization URL for the given provider using injected state/challenge. */
  protected buildStart(input: OAuthStartInput, params: Record<string, string>): OAuthStartResult {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const url = new URL(this.authorizeUrl());
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), state, expiresAtMs: this.nowMs() + OAUTH_STATE_TTL_MS };
  }

  protected challenge(input: OAuthStartInput): string {
    if (input.codeChallenge && input.codeChallenge.length > 0) return input.codeChallenge;
    throw new OAuthDriverError("validation", `${this.providerId} requires a PKCE code challenge for its authorization flow.`, 400, false);
  }

  protected abstract authorizeUrl(): string;
}

