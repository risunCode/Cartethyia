import type { OAuthRefresher, OAuthRefreshResult, OAuthTokenRecord } from "./credentials";
import { makeProviderError } from "../../traffic";
import { assertPublicUrlAtDispatch } from "../../security/ssrf-guard";
import { OAuthDriverError, type OAuthFetch } from "./oauth/base";
import type { AuthDriverRegistry } from "./drivers";
import type { TokenSet } from "./contracts";

const OAUTH_REFRESH_TIMEOUT_MS = 15_000;
const OAUTH_RESPONSE_MAX_BYTES = 64 * 1024;
const OAUTH_ACCESS_TOKEN_MAX_LENGTH = 32_384;
const OAUTH_MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;
const OAUTH_MAX_ERROR_MESSAGE_LENGTH = 240;
const OAUTH_HTTPS_ONLY: Readonly<Record<string, true>> = { "https:": true };

/**
 * Reads and JSON-parses a response body under a hard byte bound, never
 * calling the unbounded `response.json()`. Returns null for oversized,
 * absent, or malformed bodies.
 */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown | null> {
  const contentLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return null;
  }
}

/** Strictly narrows an OAuth token response (bounded access token, optional clamped expiry, optional rotated refresh token). */
function parseTokenBody(body: unknown, nowMs: number): { readonly accessToken: string; readonly expiresAtMs: number | null; readonly refreshToken: string | null } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > OAUTH_ACCESS_TOKEN_MAX_LENGTH) return null;
  const expiresIn = record["expires_in"];
  const expiresAtMs = typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? nowMs + Math.floor(Math.min(Math.max(0, expiresIn), OAUTH_MAX_EXPIRES_IN_SECONDS) * 1000)
    : null;
  const rotated = record["refresh_token"];
  return {
    accessToken,
    expiresAtMs,
    refreshToken: typeof rotated === "string" && rotated.length > 0 ? rotated : null,
  };
}

function failure(statusCode: number, kind: "credential_unavailable" | "provider_unavailable" | "authentication_failed" | "provider_protocol_error" | "network_unavailable", retryable: boolean, sanitizedMessage: string): OAuthRefreshResult {
  return { ok: false, error: makeProviderError(kind, sanitizedMessage, { retryable, routeScope: "account", statusCode }) };
}

export interface EnvOAuthRefresherOptions {
  /** Resolves the provider id for an account; the env-based path is keyed per provider. */
  readonly resolveProvider: (accountId: string) => Promise<string | null>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchFn?: OAuthFetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly nowMs?: () => number;
  /** DNS lookup for the SSRF guard; tests inject a public address, production uses Bun DNS. */
  readonly lookup?: (hostname: string) => Promise<readonly { readonly address: string }[]>;
}

/**
 * Bounded, env-configured OAuth refresh fallback for providers that have no
 * registered {@link AuthDriver}. Reads
 * `CARTETHYIA_OAUTH_<PROVIDER>_TOKEN_URL/CLIENT_ID/CLIENT_SECRET` from the
 * environment and refreshes with a hard byte bound, a bounded timeout, an
 * HTTPS-only SSRF guard, and strictly narrowed token parsing. This is the
 * legacy generic path, kept only as a safe fallback for providers without a
 * driver.
 */
export function createEnvOAuthRefresher(options: EnvOAuthRefresherOptions): OAuthRefresher {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? OAUTH_REFRESH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? OAUTH_RESPONSE_MAX_BYTES;
  const nowMs = options.nowMs ?? (() => Date.now());

  return {
    async refresh({ accountId, token }) {
      const refreshToken = token?.refreshToken ?? null;
      const providerId = await options.resolveProvider(accountId);
      if (providerId === null || refreshToken === null) {
        return failure(503, "credential_unavailable", true, "OAuth refresh token is unavailable");
      }
      const suffix = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const tokenUrl = env[`CARTETHYIA_OAUTH_${suffix}_TOKEN_URL`];
      const clientId = env[`CARTETHYIA_OAUTH_${suffix}_CLIENT_ID`];
      const clientSecret = env[`CARTETHYIA_OAUTH_${suffix}_CLIENT_SECRET`];
      if (!tokenUrl || !clientId || !clientSecret) {
        return failure(503, "credential_unavailable", true, "OAuth refresh configuration is unavailable");
      }
      try {
        await assertPublicUrlAtDispatch(tokenUrl, { label: "OAuth token URL", allowedProtocols: OAUTH_HTTPS_ONLY, lookup: options.lookup });
      } catch {
        return failure(503, "credential_unavailable", false, "OAuth refresh configuration is invalid");
      }
      try {
        const response = await fetchFn(tokenUrl, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status >= 300 && response.status < 400) {
          return failure(response.status, "provider_unavailable", true, "OAuth token endpoint returned an unexpected redirect");
        }
        if (!response.ok) {
          return failure(response.status || 503, response.status === 401 ? "authentication_failed" : "provider_unavailable", response.status !== 401, "OAuth token refresh failed");
        }
        const body = await readResponseBody(response, maxBytes);
        const record = body === null ? null : parseTokenBody(body, nowMs());
        if (record === null) {
          return failure(502, "provider_protocol_error", false, "OAuth token response was invalid");
        }
        return { ok: true, token: { accessToken: record.accessToken, expiresAtMs: record.expiresAtMs, refreshToken: record.refreshToken ?? refreshToken, kind: "oauth" } };
      } catch {
        return failure(503, "network_unavailable", true, "OAuth token refresh network request failed");
      }
    },
  };
}

export interface DriverAwareRefresherOptions {
  readonly drivers: AuthDriverRegistry;
  /** Resolves the provider id for an account so the right driver (or fallback) is used. */
  readonly resolveProvider: (accountId: string) => Promise<string | null>;
  /** Safe bounded fallback used only when no driver handles the provider. */
  readonly fallback?: OAuthRefresher;
}

function tokenRecordFromTokenSet(token: TokenSet, previousRefreshToken: string | null): OAuthTokenRecord {
  let expiresAtMs: number | null = null;
  if (typeof token.expiresAt === "string" && token.expiresAt.length > 0) {
    const parsed = Date.parse(token.expiresAt);
    if (Number.isFinite(parsed)) expiresAtMs = parsed;
  }
  const accessToken = token.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > OAUTH_ACCESS_TOKEN_MAX_LENGTH) {
    throw new OAuthDriverError("validation", "OAuth driver returned an unusable access token.", 502, false);
  }
  return { accessToken, expiresAtMs, refreshToken: token.refreshToken ?? previousRefreshToken, kind: "oauth" };
}

function driverRefreshFailure(error: unknown): OAuthRefreshResult {
  if (error instanceof OAuthDriverError) {
    let raw = error.message;
    if (raw.length > OAUTH_MAX_ERROR_MESSAGE_LENGTH) raw = `${raw.slice(0, OAUTH_MAX_ERROR_MESSAGE_LENGTH)}…`;
    const normalized = raw.toLowerCase();
    // Token endpoints report revoked, expired, reused, and invalid grants as
    // HTTP 400. These are permanent account failures, not provider outages.
    if (error.status === 400 || error.status === 401 || error.status === 403 || /(invalid_grant|refresh.?token.?reuse|revok|expired)/.test(normalized)) {
      return failure(error.status, "authentication_failed", false, raw);
    }
    if (error.status === 429) return failure(error.status, "provider_unavailable", true, raw);
    if (error.status >= 500) return failure(error.status, "provider_unavailable", error.retryable, raw);
    return failure(error.status >= 400 && error.status < 500 ? error.status : 502, "provider_protocol_error", error.retryable, raw);
  }
  return failure(503, "provider_unavailable", true, "OAuth token refresh failed");
}

/**
 * Provider-driver-first OAuth refresh. When a driver is registered for the
 * account's provider, its `refresh` drives the refresh (single-flight is left
 * to the central TokenRefreshPool); otherwise the safe bounded env fallback —
 * when present — handles it. A provider with neither a driver nor env
 * configuration resolves to a typed `credential_unavailable` failure, so
 * absence of a driver is the only reason a provider is not OAuth-refreshable.
 */
export function createDriverAwareOAuthRefresher(options: DriverAwareRefresherOptions): OAuthRefresher {
  return {
    async refresh({ accountId, token }) {
      const providerId = await options.resolveProvider(accountId);
      if (providerId === null) {
        return failure(503, "credential_unavailable", true, "OAuth account is unavailable");
      }
      const refreshToken = token?.refreshToken ?? null;
      const driver = options.drivers.get(providerId);
      if (driver?.refresh !== undefined) {
        if (refreshToken === null) {
          return failure(503, "credential_unavailable", true, "OAuth refresh token is unavailable");
        }
        try {
          const next = await driver.refresh({ providerId, accountId, refreshToken });
          return { ok: true, token: tokenRecordFromTokenSet(next, refreshToken) };
        } catch (error) {
          return driverRefreshFailure(error);
        }
      }
      if (options.fallback !== undefined) {
        return options.fallback.refresh({ accountId, token });
      }
      return failure(503, "credential_unavailable", true, "OAuth refresh is not configured for this provider");
    },
  };
}