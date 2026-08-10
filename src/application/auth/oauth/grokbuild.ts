import type { AuthDriver, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { OAuthDriverError, OAuthHttpClient, type OAuthDriverOptions } from "./base";

/**
 * Grok Build device-flow OAuth driver, ported from the official grok-shell
 * client (grok-shell/0.2.99 talking to auth.x.ai). Grok Build authenticates
 * through xAI's OAuth2 device-code endpoint:
 *   POST https://auth.x.ai/oauth2/device/code   (start)
 *   POST https://auth.x.ai/oauth2/token         (poll + refresh)
 *
 * The same client_id is shared with the xai API-key OAuth driver, but the
 * scope includes `grok-cli:access` and `conversations:read/write` — broader
 * than the api-only scope. `referrer=grok-build` identifies the device-code
 * grant source.
 *
 * Source of truth: wire capture of official @xai-official/grok 0.2.99.
 */

export const GROK_BUILD_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_BUILD_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const GROK_BUILD_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const GROK_BUILD_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const GROK_BUILD_REFERRER = "grok-build";
export const GROK_BUILD_REFRESH_LEAD_MS = 5 * 60_000;
export const GROK_BUILD_DEVICE_DEFAULT_EXPIRES_IN_SECONDS = 300;
export const GROK_BUILD_DEVICE_DEFAULT_INTERVAL_SECONDS = 5;
export const GROK_BUILD_MAX_DEVICE_SESSIONS = 500;

interface GrokBuildDeviceContext {
  readonly deviceCode: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
  readonly startedAtMs: number;
}

export interface GrokBuildOAuthDriverOptions extends OAuthDriverOptions {
  readonly clientId?: string;
}

function parseGrokBuildTokenResponse(
  data: Record<string, unknown>,
  operation: string,
  nowMs: number,
  requireRefresh: boolean,
  fallbackRefreshToken?: string,
): TokenSet {
  const accessToken = typeof data.access_token === "string" && data.access_token.length > 0 ? data.access_token : undefined;
  if (accessToken === undefined) {
    throw new OAuthDriverError("validation", `Grok Build ${operation} response is missing an access token.`, 502, false);
  }
  const refreshToken = typeof data.refresh_token === "string" && data.refresh_token.length > 0 ? data.refresh_token : fallbackRefreshToken;
  if (refreshToken === undefined && requireRefresh) {
    throw new OAuthDriverError("validation", `Grok Build ${operation} response is missing a refresh token.`, 502, false);
  }
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  const expiresAtMs = nowMs + expiresIn * 1_000;
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
    scope: typeof data.scope === "string" && data.scope.length > 0 ? data.scope : GROK_BUILD_SCOPE,
  };
}

/**
 * Grok Build device-code OAuth driver. Implements start/poll/refresh on the
 * standard OAuth2 device-authorization grant (RFC 8628). The Grok Build
 * adapter builds its own wire headers (grok-shell User-Agent and
 * `x-xai-token-auth` marker — never a Cartethyia identity).
 */
export class GrokBuildOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;
  readonly clientId: string;
  private readonly devices = new Map<string, GrokBuildDeviceContext>();

  constructor(options: GrokBuildOAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.clientId = options.clientId ?? GROK_BUILD_CLIENT_ID;
  }

  async start(_input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = crypto.randomUUID();
    const data = await this.http.postForm(
      GROK_BUILD_DEVICE_CODE_URL,
      {
        client_id: this.clientId,
        scope: GROK_BUILD_SCOPE,
        referrer: GROK_BUILD_REFERRER,
      },
      "grok-build",
      "device authorization",
    );
    const deviceCode = typeof data.device_code === "string" && data.device_code.length > 0 ? data.device_code : undefined;
    const userCode = typeof data.user_code === "string" && data.user_code.length > 0 ? data.user_code : undefined;
    const verificationUri = typeof data.verification_uri === "string" && data.verification_uri.length > 0 ? data.verification_uri : undefined;
    if (!deviceCode || !userCode || !verificationUri) {
      throw new OAuthDriverError("validation", "Grok Build device authorization response is missing required fields.", 502, false);
    }
    const verificationUriComplete = typeof data.verification_uri_complete === "string" && data.verification_uri_complete.length > 0 ? data.verification_uri_complete : undefined;
    const expiresInSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : GROK_BUILD_DEVICE_DEFAULT_EXPIRES_IN_SECONDS;
    const intervalSeconds = typeof data.interval === "number" && data.interval > 0 ? data.interval : GROK_BUILD_DEVICE_DEFAULT_INTERVAL_SECONDS;
    if (this.devices.size >= GROK_BUILD_MAX_DEVICE_SESSIONS) {
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
      intervalSeconds,
    };
  }

  /**
   * Non-blocking device-flow poll: makes a single token request and preserves
   * bounded JSON error bodies for authorization_pending / slow_down.
   */
  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly tokenSet?: TokenSet }> {
    const context = this.devices.get(state);
    if (context === undefined) return { status: "expired" };
    if (this.nowMs() > context.startedAtMs + context.expiresInSeconds * 1_000) {
      this.devices.delete(state);
      return { status: "expired" };
    }
    let result;
    try {
      result = await this.http.postFormResult(
        GROK_BUILD_TOKEN_URL,
        { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: context.deviceCode, client_id: this.clientId },
        "grok-build",
        "device authorization",
      );
    } catch {
      return { status: "pending" };
    }
    const data = result.body ?? {};
    const error = typeof data.error === "string" ? data.error : undefined;
    if (error === undefined && result.ok) {
      const tokenSet = parseGrokBuildTokenResponse(data, "token exchange", this.nowMs(), true);
      this.devices.delete(state);
      return { status: "completed", tokenSet };
    }
    if (error === "authorization_pending" || error === "slow_down") return { status: "pending" };
    this.devices.delete(state);
    return { status: "expired" };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postForm(
      GROK_BUILD_TOKEN_URL,
      {
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: input.refreshToken,
        referrer: GROK_BUILD_REFERRER,
      },
      "grok-build",
      "token refresh",
    );
    return parseGrokBuildTokenResponse(data, "token refresh", this.nowMs(), false, input.refreshToken);
  }
}
