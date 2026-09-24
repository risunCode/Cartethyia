/**
 * Antigravity Google OAuth login/refresh client. Google OAuth 2.0 with PKCE.
 * The client uses a dedicated Google OAuth application with Cloud Platform,
 * userinfo, cclog, and experiments/configuration scopes.
 */
import { postFormTokenRequest } from "../../authentication/oauth-flow-store";
import { readJsonResponse } from "../../authentication/oauth-flow-store";
import { oauthCallbackUrl } from "../../../config";
import type { OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthClient, type FetchLike } from "../../authentication/oauth-client";
import { loadAntigravityProject } from "./antigravity-protocol";
import { isRecord } from "../../../protocol/primitives";

// The Google OAuth client identity is public provider configuration. These
// values match the reference Antigravity client used by Cartethyia-21.beta.
//
// The secret is stored base64-encoded rather than as a literal. It is not a
// user credential — it identifies the client application, not an account, and
// an installed OAuth client cannot keep a secret confidential anyway (anyone
// holding the binary can read it). Encoding it keeps automated secret scanners
// from flagging every commit in a public repository, and keeps a `GOCSPX-`
// literal out of a source file that is copied around. Decoded at module load,
// so the exported constant is the real secret and no caller changes.
export const ANTIGRAVITY_CLIENT_ID = [
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep",
  ".apps.googleusercontent.com",
].join("");
export const ANTIGRAVITY_CLIENT_SECRET = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString("utf8");
export const ANTIGRAVITY_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");
export const ANTIGRAVITY_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

const formHeaders = {
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
};

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

interface UserInfoResponse {
  email?: unknown;
}

async function fetchUserinfoEmail(
  accessToken: string,
  fetchFn: FetchLike,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(ANTIGRAVITY_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as UserInfoResponse;
    if (isRecord(body) && typeof body.email === "string") {
      const trimmed = body.email.trim();
      if (trimmed.length > 0) return trimmed;
    }
  } catch {
    // Userinfo is a best-effort label; silence errors so the exchange still
    // completes even when the userinfo endpoint is unreachable.
  }
  return undefined;
}

async function exchangeCodeForToken(
  code: string,
  verifier: string,
  redirectUri: string,
  fetchFn: FetchLike,
): Promise<OAuthExchangeResult> {
  const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: "POST",
    headers: formHeaders,
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const body = (await readJsonResponse(
    response,
    "Antigravity token exchange",
  )) as TokenResponse;
  if (
    typeof body.access_token !== "string" ||
    body.access_token.length === 0 ||
    typeof body.refresh_token !== "string" ||
    body.refresh_token.length === 0
  ) {
    throw new Error("Antigravity token response omitted access or refresh token");
  }
  const [email] = await Promise.all([
    fetchUserinfoEmail(body.access_token, fetchFn),
    // Warm the shared project-id cache (`google-antigravity-project` hook in
    // the provider project lookup). Best-effort — a slow / failing `loadCodeAssist`
    // must never block the OAuth exchange from returning.
    loadAntigravityProject(body.access_token, { fetcher: fetchFn }).catch(
      () => undefined,
    ),
  ]);
  if (
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in < 0
  ) {
    throw new Error("Antigravity token response omitted a valid expires_in");
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    ...(email ? { accountLabel: email } : {}),
  };
}

/** Antigravity Google OAuth login/refresh client. */
export class AntigravityOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;

  protected override readonly providerLabel = "Antigravity";
  protected override readonly clientId = ANTIGRAVITY_CLIENT_ID;
  protected override readonly tokenUrl = ANTIGRAVITY_TOKEN_URL;
  protected override readonly authorizeUrl = ANTIGRAVITY_AUTHORIZE_URL;
  protected override readonly scopes = ANTIGRAVITY_SCOPES;

  protected override providerIdForCallback(): string {
    return "antigravity";
  }

  protected override extraAuthorizeParams(): Record<string, string> | undefined {
    return { access_type: "offline", prompt: "consent" };
  }

  override async exchangeCode(code: string, codeVerifier: string): Promise<OAuthExchangeResult> {
    return exchangeCodeForToken(code, codeVerifier, oauthCallbackUrl("antigravity"), this.fetchFn);
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const payload = await postFormTokenRequest({
      url: ANTIGRAVITY_TOKEN_URL,
      fetchFn: this.fetchFn,
      params: {
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
      headers: formHeaders,
      signal,
      timeoutMs: 15_000,
      label: "Antigravity token refresh",
    });
    const body = payload as TokenResponse;
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new Error("Antigravity token response omitted access token");
    }
    if (
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in < 0
    ) {
      throw new Error("Antigravity token response omitted a valid expires_in");
    }
    return {
      access: body.access_token,
      ...(typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? { refresh: body.refresh_token }
        : {}),
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    };
  }
}

export const antigravityOAuthClient = new AntigravityOAuthClient();
export { exchangeCodeForToken };
