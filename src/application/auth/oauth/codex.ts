import type { AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { AuthorizationCodeDriver, decodeJwtPayload, nonEmpty, tokenFields, OAuthDriverError } from "./base";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CALLBACK_URL = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_ORIGINATOR = "pi";
const CODEX_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const CODEX_DEVICE_REDIRECT_URL = "https://auth.openai.com/deviceauth/callback";
const CODEX_DEVICE_TTL_MS = 15 * 60_000;

interface CodexDeviceSession {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly expiresAtMs: number;
  readonly intervalSeconds: number;
}


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
 * OpenAI Codex OAuth driver.
 *
 * Codex uses the device-code flow as its primary login path so the dashboard
 * does not depend on the fixed localhost:1455 callback listener. The device
 * token response supplies a short-lived authorization code plus its PKCE
 * verifier, which is exchanged for the normal Codex token set below.
 *
 * The access token is an OpenAI auth token whose JWT payload carries the
 * ChatGPT account identity that the Codex Responses transport must pass as
 * `chatgpt-account-id`. `providerAccountId` therefore surfaces that identity
 * so a provider adapter can attach it.
 */
export class CodexOAuthDriver extends AuthorizationCodeDriver implements AuthDriver {
  private readonly deviceSessions = new Map<string, CodexDeviceSession>();
  protected override get providerId(): string {
    return "codex";
  }

  protected override authorizeUrl(): string {
    return CODEX_AUTHORIZE_URL;
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    if (input.flow !== "device") {
      const redirectUri = input.redirectUri ?? CODEX_CALLBACK_URL;
      return this.buildStart(input, {
        response_type: "code",
        client_id: CODEX_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: CODEX_SCOPE,
        code_challenge: this.challenge(input),
        code_challenge_method: "S256",
        originator: CODEX_ORIGINATOR,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
      });
    }
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const data = await this.http.postJson(
      CODEX_DEVICE_USERCODE_URL,
      { client_id: CODEX_CLIENT_ID },
      "codex",
      "device authorization",
    );
    const deviceAuthId = nonEmpty(data.device_auth_id);
    const userCode = nonEmpty(data.user_code) ?? nonEmpty(data.usercode);
    const intervalValue = data.interval;
    const intervalSeconds = typeof intervalValue === "number" && Number.isFinite(intervalValue)
      ? Math.max(1, Math.floor(intervalValue))
      : typeof intervalValue === "string" && /^\d+$/.test(intervalValue.trim())
        ? Math.max(1, Number.parseInt(intervalValue, 10))
        : 5;
    if (deviceAuthId === undefined || userCode === undefined) {
      throw new OAuthDriverError("validation", "codex device authorization response is missing device credentials.", 502, true);
    }
    const expiresAtMs = this.nowMs() + CODEX_DEVICE_TTL_MS;
    this.deviceSessions.set(state, { deviceAuthId, userCode, expiresAtMs, intervalSeconds });
    return {
      authorizationUrl: CODEX_DEVICE_VERIFICATION_URL,
      verificationUri: CODEX_DEVICE_VERIFICATION_URL,
      userCode,
      intervalSeconds,
      state,
      expiresAtMs,
      flow: "device",
    };
  }

  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }> {
    const session = this.deviceSessions.get(state);
    if (session === undefined) return { status: "expired" };
    if (session.expiresAtMs <= this.nowMs()) {
      this.deviceSessions.delete(state);
      return { status: "expired" };
    }
    const result = await this.http.postJsonResult(
      CODEX_DEVICE_TOKEN_URL,
      { device_auth_id: session.deviceAuthId, user_code: session.userCode },
      "codex",
      "device authorization",
    );
    if (result.status === 403 || result.status === 404) return { status: "pending", intervalSeconds: session.intervalSeconds };
    if (!result.ok || result.body === null) {
      throw new OAuthDriverError("device-auth", `codex device authorization failed with HTTP ${result.status}.`, result.status, result.status >= 500 || result.status === 429, result.retryAt);
    }
    const authorizationCode = nonEmpty(result.body.authorization_code);
    const codeVerifier = nonEmpty(result.body.code_verifier);
    if (authorizationCode === undefined || codeVerifier === undefined) {
      throw new OAuthDriverError("validation", "codex device authorization response is missing PKCE fields.", 502, true);
    }
    const tokenData = await this.http.postForm(
      CODEX_TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: CODEX_DEVICE_REDIRECT_URL,
      },
      "codex",
      "device token exchange",
    );
    this.deviceSessions.delete(state);
    return { status: "completed", tokenSet: this.toTokenSet(tokenData, true) };
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
