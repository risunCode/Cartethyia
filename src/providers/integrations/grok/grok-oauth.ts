/** xAI Grok Build device-code OAuth client. */
import { isDevicePollPending, nonEmptyTrimmedString, parseDeviceAuthStart, postFormTokenRequest, readJsonResponse } from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";

export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828" as const;
export const GROK_DEVICE_URL = "https://auth.x.ai/oauth2/device/code" as const;
export const GROK_TOKEN_URL = "https://auth.x.ai/oauth2/token" as const;
export const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user" as const;
export const GROK_SCOPE = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");
import {
  buildGrokAuthUserAgent,
  getGrokVersion,
  refreshGrokVersion,
} from "../../operations/client-versions";

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}
interface UserPayload {
  email?: unknown;
  userId?: unknown;
  principalId?: unknown;
}

function authHeaders(): Record<string, string> {
  refreshGrokVersion();
  const version = getGrokVersion();
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": buildGrokAuthUserAgent(version),
    "x-grok-client-version": version,
    "x-grok-client-surface": "ui",
  };
}

async function fetchUserLabel(accessToken: string, fetcher: FetchLike): Promise<string | undefined> {
  try {
    refreshGrokVersion();
    const version = getGrokVersion();
    const response = await fetcher(GROK_USER_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": buildGrokAuthUserAgent(version),
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": version,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as UserPayload;
    return nonEmptyTrimmedString(payload.email) ?? nonEmptyTrimmedString(payload.userId) ?? nonEmptyTrimmedString(payload.principalId);
  } catch {
    return undefined;
  }
}

/** Device-code OAuth client for Grok Build CLI subscriptions. */
export class GrokOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "grok";
  protected override readonly clientId = GROK_CLIENT_ID;
  protected override readonly tokenUrl = GROK_TOKEN_URL;
  protected override readonly scopes = GROK_SCOPE;

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const body = new URLSearchParams({
      client_id: GROK_CLIENT_ID,
      scope: GROK_SCOPE,
      referrer: "grok-build",
    });
    const response = await this.fetchFn(GROK_DEVICE_URL, {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const payload = await readJsonResponse(response, "grok device authorization");
    const start = parseDeviceAuthStart(payload, {
      intervalSeconds: 5,
      expiresInSeconds: 1_800,
    });
    if (!start) throw new Error("grok device response omitted required fields");
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
    };
  }

  override async pollDeviceAuth(deviceAuthId: string, _context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceAuthId,
      client_id: GROK_CLIENT_ID,
    });
    const response = await this.fetchFn(GROK_TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const raw = await response.text();
    let payload: TokenPayload;
    try {
      payload = JSON.parse(raw) as TokenPayload;
    } catch {
      return { status: "failed", reason: "grok token endpoint returned invalid JSON" };
    }
    const error = nonEmptyTrimmedString(payload.error);
    if (isDevicePollPending(error)) return { status: "pending" };
    if (!response.ok) {
      return { status: "failed", reason: nonEmptyTrimmedString(payload.error_description) ?? error ?? `token polling failed (${response.status})` };
    }
    const result = this.parseTokenResponse(payload);
    const accountLabel = await fetchUserLabel(result.access, this.fetchFn);
    return { status: "complete", result: this.toExchangeResult({ ...result, accountLabel }) };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const payload = (await postFormTokenRequest({
      url: GROK_TOKEN_URL,
      fetchFn: this.fetchFn,
      params: {
        grant_type: "refresh_token",
        client_id: GROK_CLIENT_ID,
        refresh_token: refreshToken,
      },
      headers: authHeaders(),
      signal,
      timeoutMs: 15_000,
      label: "grok token refresh",
    })) as TokenPayload;
    const result = this.parseTokenResponse(payload, refreshToken);
    return this.toRefreshResult(result);
  }
}

export const grokOAuthClient = new GrokOAuthClient();
