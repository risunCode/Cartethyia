import type { OAuthStartInput, OAuthStartResult } from "../contracts";

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
 * providers (Devin/Cursor/Grok) are intentionally not represented here.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const OAUTH_REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

/** Injectable fetch-compatible transport (mirrors the global `fetch` shape). */
export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OAuthDriverOptions {
  readonly fetch?: OAuthFetch;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
}

/** Typed OAuth driver failure; `status` mirrors an HTTP status where applicable. */
export class OAuthDriverError extends Error {
  readonly kind: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(kind: string, message: string, status = 502, retryable = false) {
    super(message);
    this.name = "OAuthDriverError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
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
export class OAuthHttpClient {
  private readonly fetchFn: OAuthFetch;
  private readonly timeoutMs: number;

  constructor(options: OAuthDriverOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
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

  /** GET that never throws on HTTP errors / network failure — for best-effort enrichment calls. */
  async tryGet(url: string, headers: Record<string, string>, _provider: string, _operation: string): Promise<{ ok: boolean; status: number; text: string }> {
    let response: Response;
    try {
      response = await this.withTimeout(this.fetchFn(url, { headers }));
    } catch {
      return { ok: false, status: 0, text: "" };
    }
    return { ok: response.ok, status: response.status, text: await response.text() };
  }

  private async send(url: string, init: RequestInit, provider: string, operation: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.withTimeout(this.fetchFn(url, init));
    } catch (error) {
      if (error instanceof OAuthDriverError) throw error;
      throw new OAuthDriverError("timeout", `${provider} OAuth ${operation} timed out.`, 502, true);
    }
    const text = await response.text();
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      throw new OAuthDriverError(`${operation}-http`, `${provider} OAuth ${operation} failed with HTTP ${response.status}.`, response.status, retryable);
    }
    try {
      return parseJsonRecord(JSON.parse(text) as unknown);
    } catch {
      throw new OAuthDriverError("malformed-response", `${provider} OAuth ${operation} returned invalid JSON.`, 502);
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OAuthDriverError("timeout", "OAuth request timed out.", 502, true)), this.timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
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

