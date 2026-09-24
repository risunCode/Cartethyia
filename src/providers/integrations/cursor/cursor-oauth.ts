/**
 * Cursor OAuth client.
 *
 * Custom (non-standard) flow ported from the upstream Cursor CLI:
 * 1. Generate PKCE verifier/challenge + uuid.
 * 2. User opens `https://cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli`.
 * 3. Poll `GET https://api2.cursor.sh/auth/poll?uuid&verifier` (404 = pending).
 * 4. Refresh via `POST https://api2.cursor.sh/auth/exchange_user_api_key`
 *    with the current token as Bearer and `{}` body.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { base64UrlEncode, decodeJwtPayload, expiryFromJwt, readJsonResponse } from "../../authentication/oauth-flow-store";
import type { OAuthDeviceFlowContext, OAuthDevicePollResult, OAuthDeviceStartResult, OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";
import { providerBaseUrl } from "../../provider-metadata";

const CURSOR_API_BASE_URL = providerBaseUrl("cursor");

export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl" as const;
export const CURSOR_POLL_URL = `${CURSOR_API_BASE_URL}/auth/poll` as const;
export const CURSOR_REFRESH_URL = `${CURSOR_API_BASE_URL}/auth/exchange_user_api_key` as const;

interface CursorAuthParams {
  readonly verifier: string;
  readonly challenge: string;
  readonly uuid: string;
  readonly loginUrl: string;
}

interface CursorOAuthCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId?: string;
  readonly expiresAt?: string;
}

async function generateCursorPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(randomBytes(96));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const { verifier, challenge } = await generateCursorPkce();
  const uuid = randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  return { verifier, challenge, uuid, loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}` };
}

export function extractCursorAccessTokenUserId(accessToken: string): string | undefined {
  try {
    const payload = decodeJwtPayload(accessToken);
    if (!payload || typeof payload.sub !== "string") return undefined;
    const parts = payload.sub.split("|");
    const userId = ((parts.length > 1 ? parts[1] : payload.sub) ?? "").trim();
    return userId || undefined;
  } catch {
    return undefined;
  }
}

export function getCursorTokenExpiry(token: string): number {
  return expiryFromJwt(token, 3_600 * 1_000, 5 * 60 * 1000);
}

export function isCursorTokenExpiringSoon(token: string, thresholdSeconds = 300): boolean {
  try {
    const decoded = decodeJwtPayload(token);
    if (!decoded || typeof decoded.exp !== "number") return true;
    return decoded.exp - Math.floor(Date.now() / 1000) < thresholdSeconds;
  } catch {
    return true;
  }
}

export function parseCursorCredential(value: string): CursorOAuthCredential {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const access =
        (typeof parsed.accessToken === "string" && parsed.accessToken) ||
        (typeof parsed.access === "string" && parsed.access) ||
        "";
      const refresh =
        (typeof parsed.refreshToken === "string" && parsed.refreshToken) ||
        (typeof parsed.refresh === "string" && parsed.refresh) ||
        "";
      if (access) {
        return {
          accessToken: access,
          refreshToken: refresh || access,
          ...(typeof parsed.userId === "string" ? { userId: parsed.userId } : {}),
          ...(typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
        };
      }
    } catch {
      // Malformed JSON safely falls back to treating input as a raw access token string.
    }
  }
  const accessToken = trimmed;
  const legacyUserId = extractCursorAccessTokenUserId(accessToken);
  return {
    accessToken,
    refreshToken: accessToken,
    ...(legacyUserId !== undefined ? { userId: legacyUserId } : {}),
  };
}

export function encodeCursorCredential(
  accessToken: string,
  refreshToken: string,
  expiresAt?: Date | number,
): string {
  const payload: Record<string, unknown> = { accessToken, refreshToken };
  if (expiresAt !== undefined) {
    const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    payload.expiresAt = date.toISOString();
  }
  const userId = extractCursorAccessTokenUserId(accessToken);
  if (userId) payload.userId = userId;
  return JSON.stringify(payload);
}

interface CursorPollSuccess {
  readonly accessToken: string;
  readonly refreshToken: string;
}

async function pollOnce(uuid: string, verifier: string, fetchFn: FetchLike): Promise<CursorPollSuccess | null> {
  const url = `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
  const response = await fetchFn(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Cursor poll failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const data = (await readJsonResponse(response, "Cursor OAuth")) as Record<string, unknown>;
  const access =
    (typeof data.accessToken === "string" && data.accessToken) ||
    (typeof data.access_token === "string" && data.access_token) ||
    "";
  const refresh =
    (typeof data.refreshToken === "string" && data.refreshToken) ||
    (typeof data.refresh_token === "string" && data.refresh_token) ||
    "";
  if (!access) throw new Error("Cursor poll response missing accessToken");
  return { accessToken: access, refreshToken: refresh || access };
}

function toExchangeResult(accessToken: string, refreshToken: string): OAuthExchangeResult {
  const userId = extractCursorAccessTokenUserId(accessToken);
  return {
    access: accessToken,
    refresh: refreshToken,
    expiresAt: new Date(getCursorTokenExpiry(accessToken)),
    ...(userId ? { accountLabel: userId } : {}),
  };
}

async function refreshWithFetch(apiKeyOrRefreshToken: string, fetchFn: FetchLike): Promise<OAuthTokenRefreshResult> {
  const response = await fetchFn(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKeyOrRefreshToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Cursor token refresh failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const data = (await readJsonResponse(response, "Cursor OAuth")) as Record<string, unknown>;
  const access =
    (typeof data.accessToken === "string" && data.accessToken) ||
    (typeof data.access_token === "string" && data.access_token) ||
    "";
  const refresh =
    (typeof data.refreshToken === "string" && data.refreshToken) ||
    (typeof data.refresh_token === "string" && data.refresh_token) ||
    apiKeyOrRefreshToken;
  if (!access) throw new Error("Cursor refresh response missing accessToken");
  return { access, refresh, expiresAt: new Date(getCursorTokenExpiry(access)) };
}

/** Cursor custom-polling OAuth client. */
export class CursorOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Cursor";
  protected override readonly clientId = "";
  protected override readonly tokenUrl = CURSOR_REFRESH_URL;
  protected override readonly scopes = "";

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const { verifier, challenge, uuid, loginUrl } = await generateCursorAuthParams();
    void challenge;
    return {
      verificationUri: loginUrl,
      userCode: uuid,
      deviceAuthId: uuid,
      intervalSeconds: 2,
      expiresInSeconds: 900,
      providerState: JSON.stringify({ verifier, uuid }),
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    if (!context?.providerState) {
      return { status: "failed", reason: "missing providerState" };
    }
    let verifier: string;
    let uuid: string;
    try {
      const parsed = JSON.parse(context.providerState) as Record<string, unknown>;
      if (typeof parsed.verifier !== "string" || !parsed.verifier) {
        return { status: "failed", reason: "invalid providerState" };
      }
      verifier = parsed.verifier;
      uuid = typeof parsed.uuid === "string" && parsed.uuid ? parsed.uuid : deviceAuthId;
    } catch {
      return { status: "failed", reason: "invalid providerState json" };
    }
    try {
      const result = await pollOnce(uuid, verifier, this.fetchFn);
      if (!result) return { status: "pending" };
      return {
        status: "complete",
        result: toExchangeResult(result.accessToken, result.refreshToken),
      };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const token = parseCursorCredential(refreshToken).refreshToken || refreshToken;
    if (!signal) return refreshWithFetch(token, this.fetchFn);
    const fetchWithSignal = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.fetchFn(input, { ...init, signal })) as typeof fetch;
    return refreshWithFetch(token, fetchWithSignal);
  }
}

export const cursorOAuthClient = new CursorOAuthClient();
