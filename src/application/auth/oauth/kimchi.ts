import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { nonEmpty, OAuthDriverError, OAuthHttpClient, type OAuthDriverOptions } from "./base";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_POLL_INTERVAL_SECONDS = 5;
const KIMI_DEFAULT_TTL_MS = 15 * 60_000;
const KIMI_EXPIRY_SKEW_MS = 5 * 60_000;

interface KimiSession {
  readonly deviceCode: string;
  readonly expiresAtMs: number;
  readonly intervalSeconds: number;
}

interface KimiTokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
  readonly interval?: unknown;
}

function commonHeaders(deviceId: string): Record<string, string> {
  return {
    "User-Agent": "KimiCLI/1.0.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.0.0",
    "X-Msh-Device-Name": typeof process !== "undefined" ? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown" : "unknown",
    "X-Msh-Device-Model": `${typeof process !== "undefined" ? process.platform : "unknown"} ${typeof process !== "undefined" ? process.arch : "unknown"}`,
    "X-Msh-Os-Version": typeof process !== "undefined" ? process.version : "unknown",
    "X-Msh-Device-Id": deviceId,
  };
}

function tokenSetFromResponse(data: KimiTokenResponse, fallbackRefreshToken?: string, nowMs = Date.now()): TokenSet {
  const accessToken = nonEmpty(data.access_token);
  const refreshToken = nonEmpty(data.refresh_token) ?? fallbackRefreshToken;
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : null;
  if (accessToken === undefined || refreshToken === undefined || expiresIn === null) {
    throw new OAuthDriverError("validation", "Kimi token response is missing access, refresh, or expiry fields.", 502);
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(nowMs + expiresIn * 1000 - KIMI_EXPIRY_SKEW_MS).toISOString(),
  };
}

/** Kimi Code device authorization driver used by the Kimchi provider adapter. */
export class KimchiOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  readonly capabilities: AuthDriverCapabilities = {
    supportsStart: true,
    supportsPoll: true,
    supportsExchange: false,
    supportsRefresh: true,
    supportsRevoke: false,
    accessOnly: false,
  };
  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;
  private readonly deviceId = crypto.randomUUID().replaceAll("-", "");
  private readonly sessions = new Map<string, KimiSession>();

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const data = await this.http.postForm(
      `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`,
      { client_id: KIMI_CLIENT_ID },
      "kimchi",
      "device authorization",
      commonHeaders(this.deviceId),
    ) as KimiTokenResponse & { device_code?: unknown; user_code?: unknown; verification_uri?: unknown; verification_uri_complete?: unknown; expires_in?: unknown; interval?: unknown };
    const deviceCode = nonEmpty(data.device_code);
    const userCode = nonEmpty(data.user_code);
    const verificationUri = nonEmpty(data.verification_uri);
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw new OAuthDriverError("validation", "Kimi device authorization response is missing required fields.", 502);
    }
    const expiresInSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : KIMI_DEFAULT_TTL_MS / 1000;
    const intervalSeconds = typeof data.interval === "number" && data.interval > 0 ? data.interval : KIMI_POLL_INTERVAL_SECONDS;
    this.sessions.set(state, { deviceCode, expiresAtMs: this.nowMs() + expiresInSeconds * 1000, intervalSeconds });
    return {
      authorizationUrl: nonEmpty(data.verification_uri_complete) ?? verificationUri,
      verificationUri,
      userCode,
      state,
      expiresAtMs: this.nowMs() + expiresInSeconds * 1000,
      intervalSeconds,
      flow: "device",
    };
  }

  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }> {
    const session = this.sessions.get(state);
    if (session === undefined || session.expiresAtMs <= this.nowMs()) {
      this.sessions.delete(state);
      return { status: "expired" };
    }
    const result = await this.http.postFormResult(
      `${KIMI_OAUTH_HOST}/api/oauth/token`,
      { client_id: KIMI_CLIENT_ID, device_code: session.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      "kimchi",
      "device token polling",
      commonHeaders(this.deviceId),
    );
    const data = (result.body ?? {}) as KimiTokenResponse;
    const error = nonEmpty(data.error);
    if (error === "authorization_pending") return { status: "pending", intervalSeconds: session.intervalSeconds };
    if (error === "slow_down") return { status: "pending", intervalSeconds: Math.max(session.intervalSeconds + 5, typeof data.interval === "number" ? data.interval : 0) };
    if (error === "expired_token") {
      this.sessions.delete(state);
      return { status: "expired" };
    }
    if (error === "access_denied") {
      this.sessions.delete(state);
      throw new OAuthDriverError("authorization_denied", "Kimi device authorization was denied.", 403, false);
    }
    if (!result.ok) {
      throw new OAuthDriverError("polling", `Kimi device token polling failed with HTTP ${result.status}.`, result.status, result.status >= 500 || result.status === 429);
    }
    const tokenSet = tokenSetFromResponse(data, undefined, this.nowMs());
    this.sessions.delete(state);
    return { status: "completed", tokenSet };
  }

  async exchange(_input: OAuthExchangeInput): Promise<TokenSet> {
    throw new OAuthDriverError("validation", "Kimi OAuth uses device authorization and does not accept callback codes.", 400, false);
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postForm(
      `${KIMI_OAUTH_HOST}/api/oauth/token`,
      { grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: KIMI_CLIENT_ID },
      "kimchi",
      "token refresh",
      commonHeaders(this.deviceId),
    ) as KimiTokenResponse;
    return tokenSetFromResponse(data, input.refreshToken, this.nowMs());
  }
}
