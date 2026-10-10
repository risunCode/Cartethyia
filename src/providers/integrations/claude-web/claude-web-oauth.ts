import { OAuthClient, type FetchLike } from "../../authentication/oauth-client";
import type { OAuthAuthorizeRequest, OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { oauthCallbackUrl } from "../../../config/providers";
import { encodeClaudeWebCredential, parseClaudeWebCredential } from "./claude-web-auth";
import { validateClaudeWebSession } from "./claude-web";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Paste-only login client for a Claude web session. */
export class ClaudeWebOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;
  protected override readonly providerLabel = "Claude Web";
  protected override readonly clientId = "";
  protected override readonly tokenUrl = "https://claude.ai";
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const targetUrl = new URL(oauthCallbackUrl("claude-web"));
    targetUrl.searchParams.set("state", request.state);
    targetUrl.searchParams.set("code", "claude-web-manual-paste");
    return targetUrl.toString();
  }

  override async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const encoded = encodeClaudeWebCredential(parseClaudeWebCredential(code));
    await validateClaudeWebSession(encoded, this.fetchFn as typeof fetch);
    return { access: encoded, refresh: encoded, expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
  }

  override async refresh(refreshToken: string): Promise<OAuthTokenRefreshResult> {
    const encoded = encodeClaudeWebCredential(parseClaudeWebCredential(refreshToken));
    await validateClaudeWebSession(encoded, this.fetchFn as typeof fetch);
    return { access: encoded, refresh: encoded, expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
  }
}

export const claudeWebOAuthClient = new ClaudeWebOAuthClient();
