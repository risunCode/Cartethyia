import type { AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { AuthorizationCodeDriver, decodeJwtPayload, nonEmpty, OAuthDriverError } from "./base";

const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://api.devin.ai";
const DEVIN_TOKEN_PATH = "/auth/cli/token";
const DEVIN_CALLBACK_URL = "http://127.0.0.1:59653/callback";
const DEVIN_FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60_000;

function tokenExpiry(token: string, nowMs: number): string {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp)
    ? new Date(exp * 1000 - 5 * 60_000).toISOString()
    : new Date(nowMs + DEVIN_FALLBACK_EXPIRES_MS).toISOString();
}

/** Devin browser PKCE OAuth driver, compatible with the oh-my-pi CLI flow. */
export class DevinOAuthDriver extends AuthorizationCodeDriver implements AuthDriver {
  protected override get providerId(): string {
    return "devin";
  }

  protected override authorizeUrl(): string {
    return `${DEVIN_WEBAPP_URL}/auth/cli/continue`;
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const redirectUri = input.redirectUri ?? DEVIN_CALLBACK_URL;
    return this.buildStart(input, {
      redirect_uri: redirectUri,
      prompt: "select_account",
      code_challenge: this.challenge(input),
      code_challenge_method: "S256",
    });
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const code = nonEmpty(input.code);
    const codeVerifier = nonEmpty(input.codeVerifier);
    if (code === undefined || codeVerifier === undefined) {
      throw new OAuthDriverError("validation", "Devin authorization code and PKCE verifier are required.", 400, false);
    }
    const data = await this.http.postJson(
      `${DEVIN_API_URL}${DEVIN_TOKEN_PATH}`,
      { code, code_verifier: codeVerifier },
      "devin",
      "token exchange",
      { accept: "application/json" },
    );
    const token = nonEmpty(data.token);
    if (token === undefined) throw new OAuthDriverError("validation", "Devin token exchange returned an empty token.", 502, false);
    return { accessToken: token, refreshToken: token, expiresAt: tokenExpiry(token, this.nowMs()) };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    return { accessToken: input.refreshToken, refreshToken: input.refreshToken, expiresAt: tokenExpiry(input.refreshToken, this.nowMs()) };
  }
}
