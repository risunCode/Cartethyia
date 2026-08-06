import type { AuthContext, AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { AuthorizationCodeDriver, tokenFields } from "./base";
import { claudeCodeOAuthBetas } from "../../providers/claude-code-fingerprint";

/**
 * Anthropic OAuth driver — the "Claude Code" account flow (Claude Pro/Max).
 *
 * Authorization happens on `claude.ai` (not `platform.claude.com`: the
 * platform endpoint only issues `org:create_api_key` console tokens and never
 * grants `user:inference`). The access token authorizes the Anthropic
 * Messages transport used by the Anthropic OAuth provider adapter, which the
 * driver's `buildHeaders` mirrors the required OAuth beta, interleaved thinking,
 * context management, and `x-app: cli` headers.
 *
 * Identity: the token response inlines `account: { uuid, email_address }`
 * (and `organization` on login); older or partial responses fall back to
 * `/api/claude_cli/bootstrap`. Like the official client, refresh does NOT
 * re-read the organization — the org a credential is scoped to is fixed at
 * login and must not be rewritten by a background refresh.
 */

export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const ANTHROPIC_OAUTH_BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
export const ANTHROPIC_OAUTH_CALLBACK_PORT = 54545;
export const ANTHROPIC_OAUTH_CALLBACK_PATH = "/callback";
export const ANTHROPIC_OAUTH_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const ANTHROPIC_OAUTH_VERSION = "2023-06-01";
export const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";
const ANTHROPIC_BOOTSTRAP_MODEL = "claude-opus-4-8";

/**
 * Absolute lifetime of an Anthropic OAuth grant family (~30 days from the
 * interactive login). Refresh-token rotation does NOT extend it; consumers
 * use this as a display heuristic to warn before the deadline, not as a wire
 * contract.
 */
export const ANTHROPIC_OAUTH_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string; name?: string };
}

interface AnthropicBootstrapResponse {
  oauth_account?: {
    account_uuid?: string;
    account_email?: string;
    organization_uuid?: string;
    organization_name?: string;
  };
}

interface AnthropicIdentity {
  accountId?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonEmptyName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function identityFromTokenResponse(data: AnthropicTokenResponse): AnthropicIdentity {
  return {
    accountId: nonEmpty(data.account?.uuid),
    email: nonEmpty(data.account?.email_address),
    orgId: nonEmpty(data.organization?.uuid),
    orgName: nonEmptyName(data.organization?.name),
  };
}

/**
 * Authorization-code + PKCE driver for Claude Code. PKCE is generated per
 * login by the caller (the console's session manager) and threaded through
 * {@link OAuthStartInput.codeChallenge} / {@link OAuthExchangeInput.codeVerifier}.
 */
export class AnthropicOAuthDriver extends AuthorizationCodeDriver implements AuthDriver {
  protected override get providerId(): string {
    return "claude";
  }

  protected override authorizeUrl(): string {
    return ANTHROPIC_OAUTH_AUTHORIZE_URL;
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const challenge = this.challenge(input);
    return this.buildStart(input, {
      code: "true",
      response_type: "code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      redirect_uri: input.redirectUri ?? `http://127.0.0.1:${ANTHROPIC_OAUTH_CALLBACK_PORT}${ANTHROPIC_OAUTH_CALLBACK_PATH}`,
      scope: ANTHROPIC_OAUTH_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const fragmentIndex = input.code.indexOf("#");
    const code = fragmentIndex >= 0 ? input.code.slice(0, fragmentIndex) : input.code;
    const fragmentState = fragmentIndex >= 0 ? input.code.slice(fragmentIndex + 1) : "";
    const state = fragmentState.length > 0 ? fragmentState : input.state;
    const data = await this.http.postJson(
      ANTHROPIC_OAUTH_TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        code,
        ...(state !== undefined && state.length > 0 ? { state } : {}),
        redirect_uri: input.redirectUri ?? `http://127.0.0.1:${ANTHROPIC_OAUTH_CALLBACK_PORT}${ANTHROPIC_OAUTH_CALLBACK_PATH}`,
        code_verifier: input.codeVerifier ?? "",
      },
      "claude",
      "token exchange",
    );
    const fields = tokenFields(data, "claude", "token exchange", this.nowMs(), true);
    const response = data as unknown as AnthropicTokenResponse;
    const identity = await this.resolveIdentity(response, fields.access, { includeOrg: true });
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh,
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
      providerAccountId: identity.accountId,
      email: identity.email,
      orgId: identity.orgId,
      orgName: identity.orgName,
    };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postJson(
      ANTHROPIC_OAUTH_TOKEN_URL,
      { grant_type: "refresh_token", client_id: ANTHROPIC_OAUTH_CLIENT_ID, refresh_token: input.refreshToken },
      "claude",
      "token refresh",
      { "anthropic-beta": "oauth-2025-04-20" },
    );
    const fields = tokenFields(data, "claude", "token refresh", this.nowMs(), false);
    const response = data as unknown as AnthropicTokenResponse;
    const identity = await this.resolveIdentity(response, fields.access, { includeOrg: false });
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh ?? input.refreshToken,
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
      providerAccountId: identity.accountId,
      email: identity.email,
    };
  }

  override buildHeaders(input: AuthContext): Record<string, string> {
    return {
      authorization: `Bearer ${input.credential}`,
      "anthropic-version": ANTHROPIC_OAUTH_VERSION,
      "anthropic-beta": claudeCodeOAuthBetas.join(","),
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "content-type": "application/json",
      accept: "text/event-stream",
    };
  }

  /**
   * Account identity from the token response, falling back to the Claude Code
   * bootstrap endpoint for older or partial responses. `includeOrg` is
   * login-only: the org a token is scoped to is captured once at login and
   * deliberately never refreshed afterwards.
   */
  private async resolveIdentity(data: AnthropicTokenResponse, accessToken: string, options: { includeOrg: boolean }): Promise<AnthropicIdentity> {
    const identity = identityFromTokenResponse(data);
    const orgSatisfied = !options.includeOrg || identity.orgId !== undefined;
    if (identity.accountId !== undefined && identity.email !== undefined && orgSatisfied) return identity;
    const bootstrap = await this.fetchBootstrapIdentity(accessToken);
    return {
      accountId: identity.accountId ?? bootstrap.accountId,
      email: identity.email ?? bootstrap.email,
      orgId: identity.orgId ?? bootstrap.orgId,
      orgName: identity.orgName ?? bootstrap.orgName,
    };
  }

  /** Best-effort bootstrap identity; failures degrade to the token-response identity. */
  private async fetchBootstrapIdentity(accessToken: string): Promise<AnthropicIdentity> {
    const url = `${ANTHROPIC_OAUTH_BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(ANTHROPIC_BOOTSTRAP_MODEL)}`;
    const result = await this.http.tryGet(
      url,
      {
        accept: "application/json, text/plain, */*",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      "claude",
      "bootstrap identity",
    );
    if (!result.ok) return {};
    try {
      const parsed: unknown = JSON.parse(result.text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const account = (parsed as AnthropicBootstrapResponse).oauth_account;
      if (typeof account !== "object" || account === null) return {};
      return {
        accountId: nonEmpty(account.account_uuid),
        email: nonEmpty(account.account_email),
        orgId: nonEmpty(account.organization_uuid),
        orgName: nonEmptyName(account.organization_name),
      };
    } catch {
      return {};
    }
  }
}