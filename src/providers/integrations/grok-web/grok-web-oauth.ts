import { OAuthClient, type FetchLike } from "../../authentication/oauth-client";
import type { OAuthAuthorizeRequest, OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { GatewayError } from "../../../protocol/gateway-error";
import { oauthCallbackUrl } from "../../../config/providers";
import { encodeGrokWebCredential, grokWebCookieHeader, parseGrokWebCredential } from "./grok-web-auth";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

/** Confirms the stored Grok session can open a temporary conversation. */
export async function validateGrokWebSession(encoded: string, fetchFn: typeof fetch = globalThis.fetch): Promise<void> {
  const creds = parseGrokWebCredential(encoded);
  const response = await fetchFn("https://grok.com/rest/app-chat/conversations/new", {
    method: "POST",
    headers: {
      Cookie: grokWebCookieHeader(creds),
      Origin: "https://grok.com",
      Referer: "https://grok.com/",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ modelName: "grok-3", temporary: true }),
  });
  if (response.status === 401 || response.status === 403) throw new GatewayError("authentication_failed", 401, "Grok Web session is not signed in");
  if (!response.ok) throw new GatewayError("transport_unavailable", response.status, `Grok Web session validation returned HTTP ${response.status}`);
}

/** Paste-only login client for a Grok web session. */
export class GrokWebOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;
  protected override readonly providerLabel = "Grok Web";
  protected override readonly clientId = "";
  protected override readonly tokenUrl = "https://grok.com";
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const targetUrl = new URL(oauthCallbackUrl("grok-web"));
    targetUrl.searchParams.set("state", request.state);
    targetUrl.searchParams.set("code", "grok-web-manual-paste");
    return targetUrl.toString();
  }

  override async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const encoded = encodeGrokWebCredential(parseGrokWebCredential(code));
    await validateGrokWebSession(encoded, this.fetchFn as typeof fetch);
    return { access: encoded, refresh: encoded, expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
  }

  override async refresh(refreshToken: string): Promise<OAuthTokenRefreshResult> {
    const encoded = encodeGrokWebCredential(parseGrokWebCredential(refreshToken));
    await validateGrokWebSession(encoded, this.fetchFn as typeof fetch);
    return { access: encoded, refresh: encoded, expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
  }
}

export const grokWebOAuthClient = new GrokWebOAuthClient();
