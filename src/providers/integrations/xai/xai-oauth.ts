/**
 * xAI Grok subscription device-code OAuth client.
 *
 * xAI runs one authorization server (`auth.x.ai`) with one public client
 * registration for its Grok subscriptions, so the client id, device endpoint,
 * and token endpoint here are the same values the Grok Build provider uses —
 * they are declared once in this module because they are facts about xAI, not
 * about either Cartethyia provider, and `grok-oauth.ts` imports them rather
 * than restating them.
 *
 * What differs between the two products is the **label source**: the
 * subscription's identity comes from the OIDC userinfo endpoint, while the Grok
 * Build CLI reads it from its own proxy. Each client therefore fetches its own
 * label and shares everything else.
 *
 * The grant is a normal refresh grant (`offline_access`), so this client
 * registers a refresher: the access token is a short-lived JWT and re-minting it
 * from the refresh token is what keeps an account usable without a new device
 * authorization.
 */
import {
  devicePollBackoff,
  nonEmptyTrimmedString,
  parseDeviceAuthStart,
  postFormTokenRequest,
  readJsonResponse,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";

/** Public xAI OAuth client id for the Grok subscriptions; not a secret. */
/** One authorization server, one public client registration for both Grok products. */
const XAI_AUTH_SERVER = {
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  deviceUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  userinfoUrl: "https://auth.x.ai/oauth2/userinfo",
} as const;

export { XAI_AUTH_SERVER };
export const XAI_CLIENT_ID = XAI_AUTH_SERVER.clientId;
export const XAI_DEVICE_URL = XAI_AUTH_SERVER.deviceUrl;
export const XAI_TOKEN_URL = XAI_AUTH_SERVER.tokenUrl;
export const XAI_USERINFO_URL = XAI_AUTH_SERVER.userinfoUrl;

/**
 * Scopes the subscription token needs.
 *
 * `offline_access` is what makes the refresh grant available; `api:access` is
 * what admits the token to `api.x.ai`. The rest are the OIDC identity scopes the
 * userinfo label is read from.
 */
export const XAI_SCOPE = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
].join(" ");

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
  interval?: unknown;
}

interface UserInfoPayload {
  email?: unknown;
  sub?: unknown;
  name?: unknown;
}

/**
 * Identity the OIDC userinfo endpoint reports.
 *
 * `sub` is the account's stable upstream id. It is persisted in `auth_state`
 * rather than discarded: the access token does not carry it, so anything that
 * needs to name the account upstream has no other source for it.
 */
interface XaiIdentity {
  readonly label?: string | undefined;
  readonly sub?: string | undefined;
}

function xaiAuthState(identity: XaiIdentity): Record<string, unknown> | undefined {
  return identity.sub === undefined ? undefined : { sub: identity.sub };
}

/** Reads the account label and upstream subject from the OIDC userinfo endpoint. */
async function fetchXaiIdentity(
  accessToken: string,
  fetcher: FetchLike,
): Promise<XaiIdentity> {
  try {
    const response = await fetcher(XAI_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return {};
    const payload = (await response.json()) as UserInfoPayload;
    const sub = nonEmptyTrimmedString(payload.sub);
    return {
      label:
        nonEmptyTrimmedString(payload.email) ??
        nonEmptyTrimmedString(payload.name) ??
        sub,
      ...(sub === undefined ? {} : { sub }),
    };
  } catch {
    return {};
  }
}

function formHeaders(): Record<string, string> {
  return { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
}

/** Device-code OAuth client for xAI Grok subscriptions (SuperGrok / X Premium+). */
export class XaiOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "xAI Grok Subscription";
  protected override readonly clientId = XAI_CLIENT_ID;
  protected override readonly tokenUrl = XAI_TOKEN_URL;
  protected override readonly scopes = XAI_SCOPE;

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const response = await this.fetchFn(XAI_DEVICE_URL, {
      method: "POST",
      headers: formHeaders(),
      body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }),
    });
    const payload = await readJsonResponse(response, "xAI device authorization");
    // Same 900 s bound as the Redis device correlation: never advertise a
    // lifetime the store cannot honor.
    const start = parseDeviceAuthStart(payload, { intervalSeconds: 5, expiresInSeconds: 900 });
    if (!start) throw new Error("xAI device response omitted required fields");
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const response = await this.fetchFn(XAI_TOKEN_URL, {
      method: "POST",
      headers: formHeaders(),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceAuthId,
        client_id: XAI_CLIENT_ID,
      }),
    });
    // Read the body before classifying: xAI answers a pending poll with an
    // `error` field, and a non-2xx response is a real failure that must not be
    // mistaken for a login still in progress.
    const raw = await response.text();
    let payload: TokenPayload;
    try {
      payload = JSON.parse(raw) as TokenPayload;
    } catch {
      return { status: "failed", reason: "xAI token endpoint returned invalid JSON" };
    }
    const error = nonEmptyTrimmedString(payload.error);
    const verdict = devicePollBackoff(error, payload.interval);
    if (verdict !== undefined) return verdict;
    if (!response.ok) {
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(payload.error_description) ??
          error ??
          `xAI token polling failed (${response.status})`,
      };
    }
    // A 2xx is not by itself a completed authorization: the endpoint can answer
    // 200 with an `error` field and no token, and reading that as success would
    // persist an account whose credential is the empty string.
    if (nonEmptyTrimmedString(payload.access_token) === undefined) {
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(payload.error_description) ??
          error ??
          "xAI token response omitted access_token",
      };
    }
    const result = this.parseTokenResponse(payload);
    const identity = await fetchXaiIdentity(result.access, this.fetchFn);
    const authState = xaiAuthState(identity);
    return {
      status: "complete",
      result: this.toExchangeResult({
        ...result,
        ...(identity.label === undefined ? {} : { accountLabel: identity.label }),
        ...(authState === undefined ? {} : { auth_state: authState }),
      }),
    };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const payload = (await postFormTokenRequest({
      url: XAI_TOKEN_URL,
      fetchFn: this.fetchFn,
      params: {
        grant_type: "refresh_token",
        client_id: XAI_CLIENT_ID,
        refresh_token: refreshToken,
      },
      headers: formHeaders(),
      signal,
      timeoutMs: 15_000,
      label: "xAI token refresh",
    })) as TokenPayload;
    const result = this.parseTokenResponse(payload, refreshToken);
    // Same reasoning as login: `sub` is not in the token, so a refresh is the
    // only chance to correct a stored id that changed. Best-effort — a failed
    // lookup returns nothing and the stored state stands.
    const identity = await fetchXaiIdentity(result.access, this.fetchFn);
    const authState = xaiAuthState(identity);
    return this.toRefreshResult({
      ...result,
      ...(identity.label === undefined ? {} : { accountLabel: identity.label }),
      ...(authState === undefined ? {} : { auth_state: authState }),
    });
  }
}

export const xaiOAuthClient = new XaiOAuthClient();
