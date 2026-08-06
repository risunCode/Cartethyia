import type { AuthContext, AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { OAuthDriverError, OAuthHttpClient, type OAuthDriverOptions } from "./base";

const AUTHORIZE_URL = "https://api.cline.bot/api/v1/auth/authorize";
const TOKEN_URL = "https://api.cline.bot/api/v1/auth/token";
const DEFAULT_EXPIRES_MS = 3_600_000;

function accessToken(credential: string): string | undefined {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) return trimmed.length > 0 ? trimmed : undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>).accessToken;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function decodeCode(code: string): Record<string, unknown> | null {
  try {
    const padded = code + "=".repeat((4 - (code.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const end = decoded.lastIndexOf("}");
    if (end < 0) return null;
    const parsed: unknown = JSON.parse(decoded.slice(0, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function tokenSet(data: Record<string, unknown>, nowMs: number): TokenSet {
  const access = typeof data.access_token === "string" ? data.access_token : typeof data.accessToken === "string" ? data.accessToken : undefined;
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : typeof data.refreshToken === "string" ? data.refreshToken : undefined;
  if (!access) throw new OAuthDriverError("validation", "ClinePass OAuth response is missing an access token.", 502, false);
  const expires = typeof data.expires_at === "string" ? data.expires_at : typeof data.expiresAt === "string" ? data.expiresAt : undefined;
  const userInfo = typeof data.userInfo === "object" && data.userInfo !== null && !Array.isArray(data.userInfo) ? data.userInfo as Record<string, unknown> : data;
  return {
    accessToken: access,
    ...(refresh ? { refreshToken: refresh } : {}),
    expiresAt: expires ?? new Date(nowMs + DEFAULT_EXPIRES_MS).toISOString(),
    email: typeof data.email === "string" ? data.email : typeof userInfo.email === "string" ? userInfo.email : undefined,
  };
}

/** ClinePass OAuth flow; Cline encodes browser token data in the callback code. */
export class ClinePassOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const redirectUri = input.redirectUri ?? "http://127.0.0.1:1456/callback";
    const params = new URLSearchParams({ client_type: "extension", callback_url: redirectUri, redirect_uri: redirectUri });
    return { authorizationUrl: `${AUTHORIZE_URL}?${params.toString()}`, state: input.state ?? crypto.randomUUID(), expiresAtMs: this.nowMs() + 300_000 };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const decoded = decodeCode(input.code);
    if (decoded !== null) return tokenSet(decoded, this.nowMs());
    const response = await this.http.postJson(TOKEN_URL, { grant_type: "authorization_code", code: input.code, client_type: "extension", redirect_uri: input.redirectUri ?? "http://127.0.0.1:1456/callback" }, "clinepass", "token exchange");
    const body = typeof response.data === "object" && response.data !== null && !Array.isArray(response.data) ? response.data as Record<string, unknown> : response;
    return tokenSet(body, this.nowMs());
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const response = await this.http.postJson("https://api.cline.bot/api/v1/auth/refresh", { refreshToken: input.refreshToken, grantType: "refresh_token" }, "clinepass", "token refresh");
    const body = typeof response.data === "object" && response.data !== null && !Array.isArray(response.data) ? response.data as Record<string, unknown> : response;
    return tokenSet(body, this.nowMs());
  }

  buildHeaders(input: AuthContext): Record<string, string> {
    const token = accessToken(input.credential);
    return token ? { authorization: `Bearer ${token.startsWith("workos:") ? token : `workos:${token}`}` } : {};
  }
}
