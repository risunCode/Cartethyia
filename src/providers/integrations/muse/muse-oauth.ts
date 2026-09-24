/**
 * Muse Code (Meta) device-code + api-key mint flow.
 *
 * Flow:
 *   1. `startDeviceAuth` — POST `auth.meta.com/oidc/device/authorization/`,
 *      returns `{user_code, device_code, verification_uri,
 *      verification_uri_complete, interval, expires_in}`.
 *   2. User visits `verification_uri_complete` and confirms in-browser.
 *   3. `pollDeviceAuth` — POST `auth.meta.com/oidc/device/token/`, replays
 *      until `access_token` is issued (200) or expiry (400 `expired_token`).
 *   4. After exchange: `requestMuseCodeKey` mints the subscription api_key
 *      via `POST api.meta.ai/muse-code/key { onboard: true }`. The api_key +
 *      OAuth access token are then bundled into a single JSON-encoded
 *      credential secret (matches `parseMuseCodeCredential` in `./muse.ts`).
 *
 * Meta's device response omits `expires_in` on token exchange (Muse tokens
 * do not expire and there is no refresh grant) and 429s aggressively on
 * `/muse-code/key`, so a repeat mint on refresh reuses the existing key.
 */
import { composeAbortSignal, truncateUpstreamText } from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";
import { encodeMuseCodeCredential } from "./muse";

export const MUSE_CODE_CLIENT_ID = "1031625952748946";
export const MUSE_CODE_DEVICE_AUTHORIZE_URL =
  "https://auth.meta.com/oidc/device/authorization/";
export const MUSE_CODE_DEVICE_TOKEN_URL =
  "https://auth.meta.com/oidc/device/token/";
export const MUSE_CODE_KEY_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_CODE_API_VERSION = "1.0.0";
export const MUSE_CODE_KEY_TIMEOUT_MS = 20_000;

const metaHeaders = {
  accept: "application/json",
  "content-type": "application/x-www-form-urlencoded",
  "x-api-version": MUSE_CODE_API_VERSION,
};

const keyHeaders = {
  accept: "application/json",
  "content-type": "application/json",
  "x-api-version": MUSE_CODE_API_VERSION,
};

interface MuseKeyResponse {
  api_key?: unknown;
  user_email?: unknown;
  user_id?: unknown;
  is_subs_active?: unknown;
  require_payment?: unknown;
  action_url?: unknown;
  require_payment_action_url?: unknown;
}

async function requestMuseCodeKey(
  accessToken: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<MuseKeyResponse> {
  const composed = composeAbortSignal(signal, MUSE_CODE_KEY_TIMEOUT_MS);
  const response = await fetchFn(MUSE_CODE_KEY_URL, {
    method: "POST",
    headers: {
      ...keyHeaders,
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ onboard: true }),
    redirect: "error",
    signal: composed,
  });
  const text = await response.text();
  if (!response.ok) {
    const excerpt = text.trim() ? ` ${truncateUpstreamText(text, 500).trim()}` : "";
    throw new Error(`Muse Code key exchange failed (${response.status}):${excerpt}`);
  }
  try {
    return JSON.parse(text) as MuseKeyResponse;
  } catch {
    throw new Error("Muse Code key exchange returned invalid JSON");
  }
}

function extractApiKey(payload: MuseKeyResponse): {
  apiKey: string;
  accountId: string | undefined;
} {
  if (payload.is_subs_active === false) {
    throw new Error("Muse Code subscription is inactive");
  }
  const apiKey =
    typeof payload.api_key === "string" ? payload.api_key.trim() : "";
  if (!apiKey) {
    const actionUrl =
      (typeof payload.action_url === "string" ? payload.action_url.trim() : "") ||
      (typeof payload.require_payment_action_url === "string"
        ? payload.require_payment_action_url.trim()
        : "");
    if (payload.require_payment === true || actionUrl) {
      throw new Error(
        actionUrl
          ? `Muse Code subscription is required: ${actionUrl}`
          : "Muse Code subscription is required",
      );
    }
    throw new Error("Muse Code key response is missing api_key");
  }
  const email =
    typeof payload.user_email === "string"
      ? payload.user_email.trim().toLowerCase()
      : "";
  const userId =
    typeof payload.user_id === "string" ? payload.user_id.trim() : "";
  const accountId = userId || email || undefined;
  return { apiKey, accountId };
}

/** Device-code OAuth client for Muse Code subscriptions. */
export class MuseCodeOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Muse Code";
  protected override readonly clientId = MUSE_CODE_CLIENT_ID;
  protected override readonly tokenUrl = MUSE_CODE_DEVICE_TOKEN_URL;
  protected override readonly scopes = "";

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    return this.startGenericDeviceAuth({
      tokenUrl: MUSE_CODE_DEVICE_TOKEN_URL,
      deviceAuthUrl: MUSE_CODE_DEVICE_AUTHORIZE_URL,
      clientId: MUSE_CODE_CLIENT_ID,
      formHeaders: metaHeaders,
    });
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const result = await this.pollGenericDeviceAuth(deviceAuthId, {
      tokenUrl: MUSE_CODE_DEVICE_TOKEN_URL,
      deviceAuthUrl: MUSE_CODE_DEVICE_AUTHORIZE_URL,
      clientId: MUSE_CODE_CLIENT_ID,
      formHeaders: metaHeaders,
    });
    if (result.status !== "complete") return result;
    const accessToken = result.result.access;
    const keyPayload = await requestMuseCodeKey(accessToken, this.fetchFn);
    const { apiKey, accountId } = extractApiKey(keyPayload);
    return {
      status: "complete",
      result: {
        // Meta subscription tokens do not expire; use a far-future date so
        // the refresh worker never treats the credential as stale.
        access: encodeMuseCodeCredential(accessToken, apiKey),
        // Meta rejects refresh_token grants; retain the OAuth access as the
        // "refresh" slot so `OAuthTokenRefresher.refresh` can re-mint the
        // api_key if the row is ever refreshed.
        refresh: accessToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        ...(accountId ? { accountLabel: accountId } : {}),
      },
    };
  }

  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    const keyPayload = await requestMuseCodeKey(refreshToken, this.fetchFn, signal);
    const { apiKey } = extractApiKey(keyPayload);
    return {
      access: encodeMuseCodeCredential(refreshToken, apiKey),
      refresh: refreshToken,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
  }
}

export const museCodeOAuthClient = new MuseCodeOAuthClient();
export { requestMuseCodeKey };
