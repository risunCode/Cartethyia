/** xAI Grok Build device-code OAuth client. */
import { devicePollBackoff, nonEmptyTrimmedString, parseDeviceAuthStart, postFormTokenRequest, readJsonResponse } from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";
import { XAI_AUTH_SERVER } from "../xai/xai-oauth";

/**
 * The Grok Build client registers against the same authorization server as
 * the xAI subscription client, so the client id and the device/token
 * endpoints are read from the one declaration rather than restated here.
 */
export const GROK_CLIENT_ID = XAI_AUTH_SERVER.clientId;
export const GROK_DEVICE_URL = XAI_AUTH_SERVER.deviceUrl;
export const GROK_TOKEN_URL = XAI_AUTH_SERVER.tokenUrl;
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
} from "../../operations/client-versions";

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
  interval?: unknown;
}
interface UserPayload {
  email?: unknown;
  userId?: unknown;
  principalId?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  hasGrokCodeAccess?: unknown;
  subscriptionTier?: unknown;
}

/**
 * Identity Grok's proxy reports, kept beyond the display label.
 *
 * `userId`/`principalId` are the account's upstream identity — the token does
 * not carry them and the gateway cannot derive them, so they are persisted in
 * `auth_state` rather than thrown away once the label is chosen.
 */
interface GrokIdentity {
  readonly label?: string | undefined;
  readonly userId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly hasGrokCodeAccess?: boolean | undefined;
  readonly subscriptionTier?: string | undefined;
}

function grokAuthState(identity: GrokIdentity): Record<string, unknown> | undefined {
  const state: Record<string, unknown> = {};
  if (identity.userId !== undefined) state["userId"] = identity.userId;
  if (identity.principalId !== undefined) state["principalId"] = identity.principalId;
  if (identity.hasGrokCodeAccess !== undefined)
    state["hasGrokCodeAccess"] = identity.hasGrokCodeAccess;
  if (identity.subscriptionTier !== undefined)
    state["subscriptionTier"] = identity.subscriptionTier;
  return Object.keys(state).length > 0 ? state : undefined;
}

async function fetchGrokIdentity(
  accessToken: string,
  fetcher: FetchLike,
): Promise<GrokIdentity> {
  try {
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
    if (!response.ok) return {};
    const payload = (await response.json()) as UserPayload;
    const displayName =
      [nonEmptyTrimmedString(payload.firstName), nonEmptyTrimmedString(payload.lastName)]
        .filter((part): part is string => part !== undefined)
        .join(" ")
        .trim() || undefined;
    return {
      label:
        displayName ??
        nonEmptyTrimmedString(payload.email) ??
        nonEmptyTrimmedString(payload.userId) ??
        nonEmptyTrimmedString(payload.principalId),
      ...(nonEmptyTrimmedString(payload.userId) === undefined
        ? {}
        : { userId: nonEmptyTrimmedString(payload.userId)! }),
      ...(nonEmptyTrimmedString(payload.principalId) === undefined
        ? {}
        : { principalId: nonEmptyTrimmedString(payload.principalId)! }),
      ...(typeof payload.hasGrokCodeAccess === "boolean"
        ? { hasGrokCodeAccess: payload.hasGrokCodeAccess }
        : {}),
      ...(nonEmptyTrimmedString(payload.subscriptionTier) === undefined
        ? {}
        : { subscriptionTier: nonEmptyTrimmedString(payload.subscriptionTier)! }),
    };
  } catch {
    return {};
  }
}

function authHeaders(): Record<string, string> {
  const version = getGrokVersion();
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": buildGrokAuthUserAgent(version),
    "x-grok-client-version": version,
    "x-grok-client-surface": "ui",
  };
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
    // The device correlation lives in Redis with the store's 900 s TTL: a
    // longer advertised lifetime would outlive the correlation and force a
    // restart at 900 s even when the provider code is still valid.
    const start = parseDeviceAuthStart(payload, {
      intervalSeconds: 5,
      expiresInSeconds: 900,
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
    const verdict = devicePollBackoff(error, payload.interval);
    if (verdict !== undefined) return verdict;
    if (!response.ok) {
      return { status: "failed", reason: nonEmptyTrimmedString(payload.error_description) ?? error ?? `token polling failed (${response.status})` };
    }
    // A 2xx is not by itself a completed authorization: the endpoint can answer
    // 200 with an `error` field and no token. Returning `failed` rather than
    // letting the shared parser throw keeps the verdict inside the poll
    // contract — the dashboard's poll error path stops polling but shows no
    // reason, so a throw would look like a spinner that never ends.
    if (nonEmptyTrimmedString(payload.access_token) === undefined) {
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(payload.error_description) ??
          error ??
          "grok token response omitted access_token",
      };
    }
    const result = this.parseTokenResponse(payload);
    const identity = await fetchGrokIdentity(result.access, this.fetchFn);
    const authState = grokAuthState(identity);
    return {
      status: "complete",
      result: this.toExchangeResult({
        ...result,
        ...(identity.label === undefined ? {} : { accountLabel: identity.label }),
        // Omitted when the proxy reported nothing, which leaves any stored
        // state alone rather than blanking it.
        ...(authState === undefined ? {} : { auth_state: authState }),
      }),
    };
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
    // Re-read the identity on refresh: a persisted id that went stale is
    // otherwise never corrected, and the call is best-effort — a failure
    // returns nothing, which the store reads as "keep what we have".
    const identity = await fetchGrokIdentity(result.access, this.fetchFn);
    const authState = grokAuthState(identity);
    return this.toRefreshResult({
      ...result,
      ...(identity.label === undefined ? {} : { accountLabel: identity.label }),
      ...(authState === undefined ? {} : { auth_state: authState }),
    });
  }
}

export const grokOAuthClient = new GrokOAuthClient();
