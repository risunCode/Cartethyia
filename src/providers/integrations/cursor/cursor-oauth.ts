/**
 * Cursor sign-in.
 *
 * Cursor's own CLI deep-link flow: a PKCE verifier and a UUID, a URL the
 * operator opens in any browser, and a poll against `api2.cursor.sh/auth/poll`
 * until the approval lands. It maps onto the gateway's device-code flow, which
 * the console already drives, so there is no new dashboard surface. The
 * verifier never reaches the browser — it stays in `providerState`, which the
 * console persists server-side.
 *
 * Refresh exchanges the refresh token at `/auth/exchange_user_api_key` and
 * gets a fresh pair back. Access tokens last about two months.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { OAuthDeviceFlowContext, OAuthDevicePollResult, OAuthDeviceStartResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { CURSOR_BASE_URL } from "./cursor-transport";

const LOGIN_URL = "https://www.cursor.com/loginDeepControl";
const POLL_URL = `${CURSOR_BASE_URL}/auth/poll`;
const REFRESH_URL = `${CURSOR_BASE_URL}/auth/exchange_user_api_key`;
const FLOW_TIMEOUT_SECONDS = 5 * 60;
const POLL_INTERVAL_SECONDS = 2;

interface PendingLogin {
  readonly uuid: string;
  readonly verifier: string;
}

export class CursorOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Cursor";
  protected override readonly clientId = "cursor";
  protected override readonly tokenUrl = REFRESH_URL;
  protected override readonly scopes = "";

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const uuid = randomUUID();
    const pending: PendingLogin = { uuid, verifier };
    return {
      verificationUri: `${LOGIN_URL}?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli`,
      // Cursor's flow has no short code to type; approval happens on the page
      // the URL opens. The console shows the URL, which is the whole step.
      userCode: uuid.slice(0, 8),
      deviceAuthId: uuid,
      intervalSeconds: POLL_INTERVAL_SECONDS,
      expiresInSeconds: FLOW_TIMEOUT_SECONDS,
      providerState: JSON.stringify(pending),
    };
  }

  override async pollDeviceAuth(deviceAuthId: string, context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    const pending = readPending(context?.providerState);
    if (!pending || pending.uuid !== deviceAuthId) {
      return { status: "failed", reason: "Cursor login state is missing or mismatched" };
    }
    const url = `${POLL_URL}?uuid=${encodeURIComponent(pending.uuid)}&verifier=${encodeURIComponent(pending.verifier)}`;
    const response = await this.fetchFn(url, { method: "GET", headers: { accept: "application/json" } });
    if (response.status === 404) return { status: "pending" };
    if (!response.ok) return { status: "failed", reason: `Cursor login poll failed: HTTP ${response.status}` };
    const body = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
    if (typeof body.accessToken !== "string" || body.accessToken.length === 0) return { status: "pending" };
    return {
      status: "complete",
      result: {
        access: body.accessToken,
        refresh: typeof body.refreshToken === "string" ? body.refreshToken : "",
        expiresAt: expiryFromJwt(body.accessToken),
      },
    };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(REFRESH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${refreshToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Cursor token refresh failed: HTTP ${response.status}`);
    const body = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
    if (typeof body.accessToken !== "string" || body.accessToken.length === 0) {
      throw new Error("Cursor token refresh returned no access token");
    }
    return {
      access: body.accessToken,
      ...(typeof body.refreshToken === "string" ? { refresh: body.refreshToken } : {}),
      expiresAt: expiryFromJwt(body.accessToken),
    };
  }
}

function readPending(state: string | undefined): PendingLogin | undefined {
  if (!state) return undefined;
  try {
    const parsed = JSON.parse(state) as { uuid?: unknown; verifier?: unknown };
    if (typeof parsed.uuid !== "string" || typeof parsed.verifier !== "string") return undefined;
    return { uuid: parsed.uuid, verifier: parsed.verifier };
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Access tokens are JWTs. Fall back to two months when the claim is absent. */
export function expiryFromJwt(token: string): Date {
  const part = token.split(".")[1];
  if (part) {
    try {
      const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof claims.exp === "number") return new Date(claims.exp * 1000);
    } catch {
      // not a JWT; use the fallback below
    }
  }
  return new Date(Date.now() + 55 * 24 * 60 * 60 * 1000);
}

export const cursorOAuthClient = new CursorOAuthClient();
