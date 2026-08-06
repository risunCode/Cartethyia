import type { AuthContext, AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { OAuthDriverError, OAuthHttpClient, type OAuthDriverOptions, type OAuthFetch } from "./base";

/**
 * Cline device-flow OAuth driver, ported from the official Cline SDK
 * (`sdk/packages/core/src/auth/cline.ts` + `@cline/shared` env config).
 * Cline authenticates through WorkOS User Management:
 *   POST https://api.workos.com/user_management/authorize/device  (start)
 *   POST https://api.workos.com/user_management/authenticate     (poll + refresh)
 * The SDK never revokes tokens, so `revoke` is intentionally absent.
 */

export const CLINE_WORKOS_API_BASE_URL = "https://api.workos.com";
export const CLINE_API_BASE_URL = "https://api.cline.bot";
export const CLINE_DEVICE_AUTHORIZATION_PATH = "/user_management/authorize/device";
export const CLINE_TOKEN_PATH = "/user_management/authenticate";
export const CLINE_REGISTER_PATH = "/api/v1/auth/register";
export const CLINE_REFRESH_PATH = "/api/v1/auth/refresh";
export const CLINE_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const CLINE_DEVICE_DEFAULT_EXPIRES_IN_SECONDS = 300;
export const CLINE_DEVICE_DEFAULT_INTERVAL_SECONDS = 5;
export const CLINE_DEFAULT_TIMEOUT_MS = 30_000;
export const CLINE_MAX_DEVICE_SESSIONS = 500;

/** Official production WorkOS client id from `@cline/shared` CLINE_ENVIRONMENTS. */
export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

interface ClineDeviceContext {
  readonly deviceCode: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
  readonly startedAtMs: number;
}

export interface ClineOAuthDriverOptions extends OAuthDriverOptions {
  /** WorkOS public client id; defaults to the official Cline production client. */
  readonly clientId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts the bearer access token from a stored credential (bundle JSON or raw token). */
function accessTokenFromCredential(credential: string): string | undefined {
  const trimmed = credential.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).accessToken === "string") {
        const access = (parsed as Record<string, unknown>).accessToken as string;
        return access.length > 0 ? access : undefined;
      }
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function parseClineAuthResponse(response: Record<string, unknown>, operation: string, nowMs: number, fallbackRefreshToken?: string): TokenSet {
  if (response.success !== true || typeof response.data !== "object" || response.data === null || Array.isArray(response.data)) {
    throw new OAuthDriverError("validation", `Cline ${operation} returned an invalid auth response.`, 502, false);
  }
  const data = response.data as Record<string, unknown>;
  const accessToken = typeof data.accessToken === "string" && data.accessToken.length > 0 ? data.accessToken : undefined;
  const refreshToken = typeof data.refreshToken === "string" && data.refreshToken.length > 0 ? data.refreshToken : fallbackRefreshToken;
  if (accessToken === undefined || refreshToken === undefined) {
    throw new OAuthDriverError("validation", `Cline ${operation} returned incomplete credentials.`, 502, false);
  }
  const expiresAt = typeof data.expiresAt === "string" && data.expiresAt.length > 0
    ? data.expiresAt
    : new Date(nowMs + (typeof data.expiresIn === "number" && data.expiresIn > 0 ? data.expiresIn : 3600) * 1000).toISOString();
  const userInfo = typeof data.userInfo === "object" && data.userInfo !== null && !Array.isArray(data.userInfo) ? data.userInfo as Record<string, unknown> : {};
  return {
    accessToken,
    refreshToken,
    expiresAt,
    providerAccountId: typeof userInfo.clineUserId === "string" ? userInfo.clineUserId : undefined,
    email: typeof userInfo.email === "string" ? userInfo.email : undefined,
  };
}

export class ClineOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;
  readonly clientId: string;
  private readonly devices = new Map<string, ClineDeviceContext>();

  constructor(options: ClineOAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.clientId = options.clientId ?? process.env.CLINE_WORKOS_CLIENT_ID ?? CLINE_WORKOS_CLIENT_ID;
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const data = await this.http.postForm(`${CLINE_WORKOS_API_BASE_URL}${CLINE_DEVICE_AUTHORIZATION_PATH}`, { client_id: this.clientId }, "cline", "device authorization");
    const deviceCode = typeof data.device_code === "string" && data.device_code.length > 0 ? data.device_code : undefined;
    const userCode = typeof data.user_code === "string" && data.user_code.length > 0 ? data.user_code : undefined;
    const verificationUri = typeof data.verification_uri === "string" && data.verification_uri.length > 0 ? data.verification_uri : undefined;
    if (!deviceCode || !userCode || !verificationUri) {
      throw new OAuthDriverError("validation", "Cline device authorization response is missing required fields.", 502, false);
    }
    const verificationUriComplete = typeof data.verification_uri_complete === "string" && data.verification_uri_complete.length > 0 ? data.verification_uri_complete : undefined;
    const expiresInSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : CLINE_DEVICE_DEFAULT_EXPIRES_IN_SECONDS;
    const intervalSeconds = typeof data.interval === "number" && data.interval > 0 ? data.interval : CLINE_DEVICE_DEFAULT_INTERVAL_SECONDS;
    if (this.devices.size >= CLINE_MAX_DEVICE_SESSIONS) {
      const oldest = this.devices.keys().next().value;
      if (oldest !== undefined) this.devices.delete(oldest);
    }
    this.devices.set(state, { deviceCode, expiresInSeconds, intervalSeconds, startedAtMs: this.nowMs() });
    return {
      authorizationUrl: verificationUriComplete ?? verificationUri,
      state,
      userCode,
      verificationUri,
      expiresAtMs: this.nowMs() + expiresInSeconds * 1_000,
    };
  }

  /**
   * Non-blocking device-flow poll: makes a single WorkOS authenticate
   * request and returns the result. Uses raw fetch because WorkOS returns
   * HTTP 400 for authorization_pending / slow_down / expired_token, which
   * the standard postForm would throw on.
   */
  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly tokenSet?: TokenSet }> {
    const context = this.devices.get(state);
    if (context === undefined) return { status: "expired" };
    if (this.nowMs() > context.startedAtMs + context.expiresInSeconds * 1_000) {
      this.devices.delete(state);
      return { status: "expired" };
    }
    let response: Response;
    try {
      response = await fetch(`${CLINE_WORKOS_API_BASE_URL}${CLINE_TOKEN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: CLINE_DEVICE_GRANT_TYPE,
          device_code: context.deviceCode,
          client_id: this.clientId,
        }).toString(),
      });
    } catch {
      return { status: "pending" };
    }
    const data: Record<string, unknown> = await response.json() as Record<string, unknown>;
    const error = typeof data.error === "string" ? data.error : undefined;
    if (error === undefined && response.ok) {
      const accessToken = typeof data.access_token === "string" ? data.access_token : undefined;
      const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
      if (accessToken === undefined || refreshToken === undefined) {
        throw new OAuthDriverError("validation", "Cline WorkOS token response is missing credentials.", 502, false);
      }
      const registered = await this.http.postJson(
        `${CLINE_API_BASE_URL}${CLINE_REGISTER_PATH}`,
        { accessToken, refreshToken },
        "cline",
        "token registration",
      );
      this.devices.delete(state);
      return { status: "completed", tokenSet: parseClineAuthResponse(registered, "token registration", this.nowMs(), refreshToken) };
    }
    if (error === "authorization_pending" || error === "slow_down") return { status: "pending" };
    // expired_token, access_denied, invalid_grant
    this.devices.delete(state);
    return { status: "expired" };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const context = input.state !== undefined ? this.devices.get(input.state) ?? null : null;
    const deviceCode = context?.deviceCode ?? input.code;
    if (!deviceCode) {
      throw new OAuthDriverError("validation", "Cline device flow requires an active start session or a device code.", 400, false);
    }
    const startedAtMs = context?.startedAtMs ?? this.nowMs();
    const expiresInSeconds = context?.expiresInSeconds ?? CLINE_DEVICE_DEFAULT_EXPIRES_IN_SECONDS;
    const deadlineMs = startedAtMs + expiresInSeconds * 1_000;
    let intervalSeconds = Math.max(1, context?.intervalSeconds ?? CLINE_DEVICE_DEFAULT_INTERVAL_SECONDS);
    while (this.nowMs() <= deadlineMs) {
      const data = await this.http.postForm(`${CLINE_WORKOS_API_BASE_URL}${CLINE_TOKEN_PATH}`, {
        grant_type: CLINE_DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: this.clientId,
      }, "cline", "token exchange");
      const error = typeof data.error === "string" ? data.error : undefined;
      if (error === undefined) {
        const accessToken = typeof data.access_token === "string" ? data.access_token : undefined;
        const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
        if (accessToken === undefined || refreshToken === undefined) {
          throw new OAuthDriverError("validation", "Cline WorkOS token response is missing credentials.", 502, false);
        }
        const registered = await this.http.postJson(
          `${CLINE_API_BASE_URL}${CLINE_REGISTER_PATH}`,
          { accessToken, refreshToken },
          "cline",
          "token registration",
        );
        if (context !== null && input.state !== undefined) this.devices.delete(input.state);
        return parseClineAuthResponse(registered, "token registration", this.nowMs(), refreshToken);
      }
      if (error === "authorization_pending") {
        await sleep(intervalSeconds * 1_000);
      } else if (error === "slow_down") {
        intervalSeconds += 1;
        await sleep(intervalSeconds * 1_000);
      } else if (error === "access_denied" || error === "expired_token" || error === "invalid_grant") {
        throw new OAuthDriverError("authorization_denied", "Cline device authorization was denied or expired.", 400, false);
      } else {
        throw new OAuthDriverError("token exchange", "Cline device token polling failed.", 502, true);
      }
    }
    throw new OAuthDriverError("timeout", "Cline device authorization timed out.", 408, true);
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postJson(
      `${CLINE_API_BASE_URL}${CLINE_REFRESH_PATH}`,
      { refreshToken: input.refreshToken, grantType: "refresh_token" },
      "cline",
      "token refresh",
    );
    return parseClineAuthResponse(data, "token refresh", this.nowMs(), input.refreshToken);
  }

  buildHeaders(input: AuthContext): Record<string, string> {
    const access = accessTokenFromCredential(input.credential);
    if (access === undefined) return {};
    const bearer = access.startsWith("workos:") ? access : `workos:${access}`;
    return { authorization: `Bearer ${bearer}` };
  }
}

export type { OAuthFetch };
