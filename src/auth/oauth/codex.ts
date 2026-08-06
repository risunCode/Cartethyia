import type { AuthContext, AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { AuthorizationCodeDriver, OAuthDriverError, decodeJwtPayload, nonEmpty, tokenFields, type OAuthDriverOptions } from "./base";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CALLBACK_URL = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_ORIGINATOR = "pi";
const CODEX_VERSION = "0.144.1";

const CODEX_AUTH_PATH = "https://api.openai.com/auth";
const CODEX_PROFILE_PATH = "https://api.openai.com/profile";

interface CodexIdentity {
  accountId?: string;
  email?: string;
  planType?: string;
}

function codexIdentity(data: Record<string, unknown>, accessToken: string, idToken: string | undefined): CodexIdentity {
  const accessPayload = decodeJwtPayload(accessToken);
  const idPayload = idToken ? decodeJwtPayload(idToken) : null;
  const accessAuth = accessPayload?.[CODEX_AUTH_PATH];
  const idAuth = idPayload?.[CODEX_AUTH_PATH];
  const profile = accessPayload?.[CODEX_PROFILE_PATH];
  const accountId =
    typeof accessAuth === "object" && accessAuth !== null
      ? nonEmpty((accessAuth as Record<string, unknown>).chatgpt_account_id)
      : undefined;
  const email = typeof profile === "object" && profile !== null ? nonEmpty((profile as Record<string, unknown>).email) : undefined;
  const planType =
    typeof accessAuth === "object" && accessAuth !== null
      ? nonEmpty((accessAuth as Record<string, unknown>).chatgpt_plan_type)
      : undefined;
  const idPlan = typeof idAuth === "object" && idAuth !== null ? nonEmpty((idAuth as Record<string, unknown>).chatgpt_plan_type) : undefined;
  const fallbackAccount = nonEmpty(data.account_id);
  return { accountId: accountId ?? fallbackAccount, email, planType: planType ?? idPlan };
}

/**
 * OpenAI Codex OAuth driver (Authorization Code + PKCE).
 *
 * The access token is an OpenAI auth token whose JWT payload carries the
 * ChatGPT account identity that the Codex Responses transport must pass as
 * `chatgpt-account-id`. `providerAccountId` therefore surfaces that identity
 * so a provider adapter can attach it, and `buildHeaders` carries the Codex
 * wire headers for a follow-on adapter.
 */
export class CodexOAuthDriver extends AuthorizationCodeDriver implements AuthDriver {
  protected override get providerId(): string {
    return "codex";
  }

  protected override authorizeUrl(): string {
    return CODEX_AUTHORIZE_URL;
  }

  start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const redirectUri = input.redirectUri ?? CODEX_CALLBACK_URL;
    const challenge = this.challenge(input);
    return Promise.resolve(
      this.buildStart(input, {
        response_type: "code",
        client_id: CODEX_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: CODEX_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: CODEX_ORIGINATOR,
      }),
    );
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const data = await this.http.postForm(
      CODEX_TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: input.code,
        code_verifier: input.codeVerifier ?? "",
        redirect_uri: input.redirectUri ?? CODEX_CALLBACK_URL,
      },
      "codex",
      "token exchange",
    );
    return this.toTokenSet(data, true);
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postForm(
      CODEX_TOKEN_URL,
      { grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: input.refreshToken },
      "codex",
      "token refresh",
    );
    return this.toTokenSet(data, false);
  }

  override buildHeaders(input: AuthContext): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.credential}`,
      "openai-beta": "responses=experimental",
      originator: CODEX_ORIGINATOR,
      version: CODEX_VERSION,
      "user-agent": `cartethyia/${CODEX_VERSION}`,
      accept: "text/event-stream",
      "content-type": "application/json",
    };
    return headers;
  }

  private toTokenSet(data: Record<string, unknown>, requireRefresh: boolean): TokenSet {
    const fields = tokenFields(data, "codex", requireRefresh ? "token exchange" : "token refresh", this.nowMs(), requireRefresh);
    const identity = codexIdentity(data, fields.access, nonEmpty(data.id_token));
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh ?? (requireRefresh ? undefined : data.refresh_token !== undefined ? nonEmpty(data.refresh_token) : undefined),
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
      scope: nonEmpty(data.scope),
      providerAccountId: identity.accountId,
    };
  }
}
