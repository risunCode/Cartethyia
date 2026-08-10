import type { AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import {
  AuthorizationCodeDriver,
  base64Decode,
  createPkce,
  nonEmpty,
  OAuthDriverError,
  OAUTH_STATE_TTL_MS,
  parseJsonRecord,
  type OAuthDriverOptions,
} from "./base";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const CURSOR_POLL_INTERVAL_SECONDS = 2;
const CURSOR_MAX_CONSECUTIVE_ERRORS = 3;

interface CursorSession {
  readonly uuid: string;
  readonly verifier: string;
  readonly expiresAtMs: number;
  consecutiveErrors: number;
}

interface CursorTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
}

function cursorTokenResponse(data: Record<string, unknown>, operation: string, fallbackRefreshToken?: string): CursorTokenResponse {
  const accessToken = nonEmpty(data.accessToken) ?? nonEmpty(data.access_token);
  const refreshToken = nonEmpty(data.refreshToken) ?? nonEmpty(data.refresh_token) ?? fallbackRefreshToken;
  if (accessToken === undefined || refreshToken === undefined) {
    throw new OAuthDriverError("validation", `Cursor OAuth ${operation} response is missing token fields.`, 502);
  }
  return { accessToken, refreshToken };
}

function cursorExpiry(accessToken: string, nowMs: number): string {
  const payload = accessToken.split(".")[1];
  if (payload !== undefined) {
    try {
      const decoded = JSON.parse(base64Decode(payload)) as { exp?: unknown };
      if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp) && decoded.exp > 0) {
        return new Date(decoded.exp * 1_000).toISOString();
      }
    } catch {
      // Cursor may return an opaque access token; use a bounded fallback expiry.
    }
  }
  return new Date(nowMs + 60 * 60_000).toISOString();
}

/** OAuth driver for Cursor's PKCE deep-control login and token polling flow. */
export class CursorOAuthDriver extends AuthorizationCodeDriver implements AuthDriver {
  protected override get providerId(): string {
    return "cursor";
  }
  protected override authorizeUrl(): string {
    return CURSOR_LOGIN_URL;
  }

  private readonly sessions = new Map<string, CursorSession>();

  constructor(options: OAuthDriverOptions = {}) {
    super(options);
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const { verifier, challenge } = await createPkce();
    const uuid = crypto.randomUUID();
    const url = new URL(CURSOR_LOGIN_URL);
    url.searchParams.set("challenge", challenge);
    url.searchParams.set("uuid", uuid);
    url.searchParams.set("mode", "login");
    url.searchParams.set("redirectTarget", "cli");
    this.sessions.set(state, {
      uuid,
      verifier,
      expiresAtMs: this.nowMs() + OAUTH_STATE_TTL_MS,
      consecutiveErrors: 0,
    });
    return {
      authorizationUrl: url.toString(),
      verificationUri: CURSOR_LOGIN_URL,
      state,
      expiresAtMs: this.nowMs() + OAUTH_STATE_TTL_MS,
      intervalSeconds: CURSOR_POLL_INTERVAL_SECONDS,
      flow: "device",
    };
  }

  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }> {
    const session = this.sessions.get(state);
    if (session === undefined || session.expiresAtMs <= this.nowMs()) {
      this.sessions.delete(state);
      return { status: "expired" };
    }
    const result = await this.http.tryGet(
      `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(session.uuid)}&verifier=${encodeURIComponent(session.verifier)}`,
      {},
      "cursor",
      "authorization polling",
    );
    if (result.status === 404 || result.status === 202) {
      session.consecutiveErrors = 0;
      return { status: "pending", intervalSeconds: CURSOR_POLL_INTERVAL_SECONDS };
    }
    if (result.status === 0 || result.status === 429 || result.status >= 500) {
      session.consecutiveErrors += 1;
      if (session.consecutiveErrors < CURSOR_MAX_CONSECUTIVE_ERRORS) {
        return { status: "pending", intervalSeconds: CURSOR_POLL_INTERVAL_SECONDS };
      }
      throw new OAuthDriverError("polling", "Cursor authorization polling failed repeatedly.", result.status || 503, true);
    }
    if (!result.ok) {
      this.sessions.delete(state);
      throw new OAuthDriverError("polling", `Cursor authorization polling failed with HTTP ${result.status}.`, result.status);
    }
    let data: Record<string, unknown>;
    try {
      data = parseJsonRecord(JSON.parse(result.text) as unknown);
    } catch {
      this.sessions.delete(state);
      throw new OAuthDriverError("validation", "Cursor authorization polling returned invalid JSON.", 502);
    }
    const token = cursorTokenResponse(data, "polling");
    this.sessions.delete(state);
    return {
      status: "completed",
      tokenSet: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: cursorExpiry(token.accessToken, this.nowMs()),
      },
    };
  }

  async exchange(_input: OAuthExchangeInput): Promise<TokenSet> {
    throw new OAuthDriverError("validation", "Cursor OAuth uses its polling flow and does not accept callback codes.", 400);
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postJson(
      CURSOR_REFRESH_URL,
      {},
      "cursor",
      "token refresh",
    );
    const token = cursorTokenResponse(data, "token refresh", input.refreshToken);
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: cursorExpiry(token.accessToken, this.nowMs()),
    };
  }
}
