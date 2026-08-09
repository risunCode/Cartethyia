import type { AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { AuthorizationCodeDriver, decodeJwtPayload, nonEmpty, tokenFields } from "./base";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CALLBACK_URL = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_ORIGINATOR = "pi";

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
  const accessProfile = accessPayload?.[CODEX_PROFILE_PATH];
  const idProfile = idPayload?.[CODEX_PROFILE_PATH];
  const accessAuthRecord = accessAuth && typeof accessAuth === "object" ? accessAuth as Record<string, unknown> : null;
  const idAuthRecord = idAuth && typeof idAuth === "object" ? idAuth as Record<string, unknown> : null;
  const accessProfileRecord = accessProfile && typeof accessProfile === "object" ? accessProfile as Record<string, unknown> : null;
  const idProfileRecord = idProfile && typeof idProfile === "object" ? idProfile as Record<string, unknown> : null;
  const accountId =
    nonEmpty(accessAuthRecord?.chatgpt_account_id) ??
    nonEmpty(idAuthRecord?.chatgpt_account_id) ??
    nonEmpty(data.account_id) ??
    nonEmpty(data.chatgpt_account_id);
  const email = nonEmpty(accessProfileRecord?.email) ?? nonEmpty(idProfileRecord?.email) ?? nonEmpty(data.email);
  const planType = nonEmpty(accessAuthRecord?.chatgpt_plan_type) ?? nonEmpty(idAuthRecord?.chatgpt_plan_type);
  return { accountId, email, planType };
}

/**
 * OpenAI Codex OAuth driver (Authorization Code + PKCE).
 *
 * The access token is an OpenAI auth token whose JWT payload carries the
 * ChatGPT account identity that the Codex Responses transport must pass as
 * `chatgpt-account-id`. `providerAccountId` therefore surfaces that identity
 * so a provider adapter can attach it.
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

  private toTokenSet(data: Record<string, unknown>, requireRefresh: boolean): TokenSet {
    const fields = tokenFields(data, "codex", requireRefresh ? "token exchange" : "token refresh", this.nowMs(), requireRefresh);
    const identity = codexIdentity(data, fields.access, nonEmpty(data.id_token));
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh ?? (requireRefresh ? undefined : data.refresh_token !== undefined ? nonEmpty(data.refresh_token) : undefined),
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
      scope: nonEmpty(data.scope),
      providerAccountId: identity.accountId,
      email: identity.email,
    };
  }
}
