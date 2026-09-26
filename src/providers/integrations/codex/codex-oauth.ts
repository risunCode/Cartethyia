import {
  decodeJwtPayload,
  type OAuthDevicePollResult,
  type OAuthDeviceStartResult,
  type OAuthExchangeResult,
  OAuthFlowStore,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";
import { getRedis } from "../../../persistence/redis";
import type { RedisClient } from "../../../persistence/redis";
import { isRecord } from "../../../protocol/primitives";
import {
  CODEX_DEVICE_TTL_SECONDS,
  parseCodexDeviceStart,
  pollCodexDeviceAuth,
  startCodexDeviceAuth,
} from "./codex-device-code";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const CODEX_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  email?: unknown;
}

interface TokenProfile {
  readonly accountId?: string;
  readonly email?: string;
}

function tokenProfile(accessToken: string, idToken: unknown): TokenProfile {
  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = typeof idToken === "string" ? decodeJwtPayload(idToken) : undefined;
  const authClaim = "https://api.openai.com/auth";
  const profileClaim = "https://api.openai.com/profile";
  const accessAuth = isRecord(accessClaims?.[authClaim]) ? accessClaims[authClaim] : undefined;
  const idAuth = isRecord(idClaims?.[authClaim]) ? idClaims[authClaim] : undefined;
  const accessProfile = isRecord(accessClaims?.[profileClaim]) ? accessClaims[profileClaim] : undefined;
  const idProfile = isRecord(idClaims?.[profileClaim]) ? idClaims[profileClaim] : undefined;
  const accountId = accessAuth?.chatgpt_account_id ?? idAuth?.chatgpt_account_id;
  const email = accessProfile?.email ?? idProfile?.email;
  return {
    ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
    ...(typeof email === "string" && email.trim().length > 0 ? { email: email.trim() } : {}),
  };
}

function expiresAt(expiresIn: unknown): Date {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < 0)
    throw new Error("Codex token response omitted a valid expires_in");
  return new Date(Date.now() + expiresIn * 1000);
}

function asExchangeTokenResponse(body: TokenResponse): OAuthExchangeResult {
  if (
    typeof body.access_token !== "string" ||
    body.access_token.length === 0 ||
    typeof body.refresh_token !== "string" ||
    body.refresh_token.length === 0
  )
    throw new Error("Codex token response omitted access or refresh token");
  const profile = tokenProfile(body.access_token, body.id_token);
  if (!profile.accountId) throw new Error("Codex token response omitted a valid account identity");
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: expiresAt(body.expires_in),
    ...(profile.email ? { accountLabel: profile.email } : {}),
  };
}

function asRefreshTokenResponse(body: TokenResponse): OAuthTokenRefreshResult {
  if (typeof body.access_token !== "string" || body.access_token.length === 0)
    throw new Error("Codex token response omitted access token");
  return {
    access: body.access_token,
    ...(typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? { refresh: body.refresh_token }
      : {}),
    expiresAt: expiresAt(body.expires_in),
  };
}

async function exchangeCodeForToken(
  code: string,
  verifier: string,
  redirectUri: string,
  fetchFn: FetchLike,
): Promise<OAuthExchangeResult> {
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const response = await fetchFn(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const data = (await response.json()) as TokenResponse;
  return asExchangeTokenResponse(data);
}

/** Codex OAuth login and refresh client (browser PKCE + device code). */
export class CodexOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = true;

  protected override readonly providerLabel = "Codex";
  protected override readonly clientId = CODEX_CLIENT_ID;
  protected override readonly tokenUrl = CODEX_TOKEN_URL;
  protected override readonly authorizeUrl = CODEX_AUTHORIZE_URL;
  protected override readonly scopes = CODEX_SCOPE;

  #flowStore: OAuthFlowStore | undefined;

  constructor(fetchFn: FetchLike = globalThis.fetch, flowStore?: OAuthFlowStore | RedisClient) {
    super(fetchFn);
    if (flowStore instanceof OAuthFlowStore) {
      this.#flowStore = flowStore;
    } else if (flowStore) {
      this.#flowStore = new OAuthFlowStore(flowStore);
    }
  }

  #requireStore(): OAuthFlowStore {
    if (this.#flowStore) return this.#flowStore;
    const redis = getRedis();
    this.#flowStore = new OAuthFlowStore(redis);
    return this.#flowStore;
  }

  protected override extraAuthorizeParams(): Record<string, string> | undefined {
    return {
      originator: "codex_cli_rs",
    };
  }

  override async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthExchangeResult> {
    return exchangeCodeForToken(code, codeVerifier, redirectUri, this.fetchFn);
  }

  override async startDeviceAuth(): Promise<OAuthDeviceStartResult> {
    const started = await startCodexDeviceAuth(CODEX_CLIENT_ID, this.fetchFn);
    await this.#requireStore().saveDeviceState(started.deviceAuthId, { ...started });
    return {
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: started.userCode,
      deviceAuthId: started.deviceAuthId,
      intervalSeconds: started.intervalSeconds,
      expiresInSeconds: CODEX_DEVICE_TTL_SECONDS,
    };
  }

  override async pollDeviceAuth(deviceAuthId: string): Promise<OAuthDevicePollResult> {
    const store = this.#requireStore();
    const stored = await store.getDeviceState(deviceAuthId);
    const device = stored === undefined ? undefined : parseCodexDeviceStart(stored);
    if (device === undefined) return { status: "failed", reason: "unknown device authorization" };
    // One attempt per call: the dashboard polls on its own interval, so this
    // returns `pending` between attempts rather than blocking the request.
    const authorization = await pollCodexDeviceAuth(device, this.fetchFn);
    if (authorization === undefined) return { status: "pending" };
    const result = await exchangeCodeForToken(
      authorization.authorizationCode,
      authorization.codeVerifier,
      CODEX_DEVICE_REDIRECT_URI,
      this.fetchFn,
    );
    // Only after the exchange has succeeded: the authorization code is
    // single-use, so dropping the state first would strand a failed exchange
    // with no way to retry, forcing the operator through device authorization
    // again.
    await store.deleteDeviceState(deviceAuthId);
    return { status: "complete", result };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim() ? text.trim().slice(0, 200) : "token refresh failed";
      throw new Error(detail);
    }
    const payload = (JSON.parse(text) as TokenResponse) ?? {};
    return asRefreshTokenResponse(payload);
  }
}

export const codexOAuthClient = new CodexOAuthClient();
export { exchangeCodeForToken };
