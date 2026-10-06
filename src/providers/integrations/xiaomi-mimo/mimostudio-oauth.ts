import { OAuthClient, type FetchLike } from "../../authentication/oauth-client";
import {
  type OAuthAuthorizeRequest,
  type OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { GatewayError } from "../../../protocol/gateway-error";
import { oauthCallbackUrl } from "../../../config/providers";
import {
  parseMimoStudioCredential,
  encodeMimoStudioCredential,
} from "./mimostudio-auth";
import { fetchMimoStudioQuota } from "./mimostudio-quota";

export class MimoStudioOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;

  protected override readonly providerLabel = "MiMo Studio";
  protected override readonly clientId = "xiaomichatbot";
  protected override readonly tokenUrl = "https://aistudio.xiaomimimo.com";
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const targetUrl = new URL(oauthCallbackUrl("mimostudio"));
    targetUrl.searchParams.set("state", request.state);
    targetUrl.searchParams.set("code", "studio-manual-paste");
    return targetUrl.toString();
  }

  override async exchangeCode(
    code: string,
    _codeVerifier: string,
    _redirectUri: string,
    _state?: string,
  ): Promise<OAuthExchangeResult> {
    const creds = parseMimoStudioCredential(code);
    const quota = await fetchMimoStudioQuota(encodeMimoStudioCredential(creds), this.fetchFn as typeof fetch);
    if (quota.error) {
      throw new GatewayError(
        "authentication_failed",
        401,
        `MiMo Studio verification failed: ${quota.error}`,
      );
    }

    const label = creds.userId ? `MiMo Studio (${creds.userId})` : "MiMo Studio";
    return {
      access: encodeMimoStudioCredential(creds),
      refresh: encodeMimoStudioCredential(creds),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      accountLabel: label,
    };
  }

  override async refresh(refreshToken: string, _signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const creds = parseMimoStudioCredential(refreshToken);
    const quota = await fetchMimoStudioQuota(encodeMimoStudioCredential(creds), this.fetchFn as typeof fetch);
    if (quota.error) {
      throw new GatewayError(
        "authentication_failed",
        401,
        `MiMo Studio refresh failed: ${quota.error}`,
      );
    }

    return {
      access: encodeMimoStudioCredential(creds),
      refresh: encodeMimoStudioCredential(creds),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  }
}

export const mimoStudioOAuthClient = new MimoStudioOAuthClient();
