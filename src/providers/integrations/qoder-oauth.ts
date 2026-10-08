/**
 * Qoder device-code OAuth client.
 *
 * Qoder's login is a custom device flow, not RFC 8628: the PKCE pair, nonce,
 * and machine id are generated locally, the user opens
 * `qoder.com/device/selectAccounts` in a browser, and the gateway polls the
 * region's deviceToken endpoint until a `dt-...` token appears. Ported from
 * the 9router reference (`src/lib/oauth/services/qoder.js`), which speaks the
 * same endpoints.
 *
 * The issued token is used directly at dispatch (like 9router: `dt-...`
 * tokens skip the PAT→jobToken exchange). There is no working refresh grant —
 * the upstream refresh endpoint answers 403 for this flow — so no refresher
 * is registered and the token is used exactly as issued until the operator
 * re-runs login. The account's Qoder user id and machine id travel in
 * `auth_state`, because the token itself carries neither and every dispatch
 * needs both for COSY signing.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  nonEmptyTrimmedString,
  record,
} from "../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../authentication/oauth-device-flow";

export const QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts" as const;
export const QODER_DEVICE_TOKEN_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll" as const;
export const QODER_USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo" as const;

/** Device authorizations live 5 minutes in the dashboard before expiring. */
const DEVICE_EXPIRY_SECONDS = 300;
/** Dashboard poll cadence for the device authorization. */
const DEVICE_INTERVAL_SECONDS = 5;
/** Individual poll request timeout; a stalled socket is a failed attempt, retried next tick. */
const POLL_TIMEOUT_MS = 15_000;
/** Token lifetime assumed when the upstream omits every expiry hint. */
const EXPIRY_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Non-secret per-account Qoder identity persisted in `auth_state`. */
export interface QoderOAuthState {
  readonly userId: string;
  readonly machineId: string;
}

/** Reads the persisted Qoder identity; `undefined` when the account predates it. */
export function parseQoderOAuthState(value: unknown): QoderOAuthState | undefined {
  const root = record(value);
  if (root === undefined) return undefined;
  const userId = nonEmptyTrimmedString(root.userId);
  const machineId = nonEmptyTrimmedString(root.machineId);
  if (userId === undefined || machineId === undefined) return undefined;
  return { userId, machineId };
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Converts the upstream's expiry hint into a Unix-millisecond timestamp.
 *
 * Accepts a numeric ms-epoch (number or numeric string), an RFC3339 string,
 * or seconds-from-now. Falls back to now + 30 days when both are missing.
 * Numeric strings are checked before `Date.parse` because it accepts short
 * numerics like "2026" as years and would otherwise return a misleading date.
 */
export function parseQoderExpiry(expiresAt: unknown, expiresInSeconds: unknown): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }
  const trimmed = typeof expiresAt === "string" ? expiresAt.trim() : "";
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const ms = Number.parseInt(trimmed, 10);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (
    typeof expiresInSeconds === "number" &&
    Number.isFinite(expiresInSeconds) &&
    expiresInSeconds >= 0
  ) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return Date.now() + EXPIRY_FALLBACK_MS;
}

interface QoderDeviceState {
  readonly verifier: string;
  readonly machineId: string;
}

function parseDeviceState(value: string | undefined): QoderDeviceState | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  const root = record(parsed);
  const verifier = root === undefined ? undefined : nonEmptyTrimmedString(root.verifier);
  const machineId = root === undefined ? undefined : nonEmptyTrimmedString(root.machineId);
  if (verifier === undefined || machineId === undefined) return undefined;
  return { verifier, machineId };
}

export class QoderOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Qoder";
  // The device endpoints take no client id; the abstract field stays empty
  // rather than inventing one, and every request below omits it.
  protected override readonly clientId = "";
  protected override readonly tokenUrl = QODER_DEVICE_TOKEN_URL;
  protected override readonly scopes = "";

  override async startDeviceAuth(
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDeviceStartResult> {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const nonce = randomUUID();
    const machineId = randomUUID();
    const params = new URLSearchParams({
      challenge,
      challenge_method: "S256",
      machine_id: machineId,
      nonce,
    });
    return {
      verificationUri: `${QODER_LOGIN_URL}?${params.toString()}`,
      // This flow shows no user code: approval happens against the
      // nonce-bound browser session, so there is nothing to type back.
      userCode: "",
      deviceAuthId: nonce,
      intervalSeconds: DEVICE_INTERVAL_SECONDS,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
      providerState: JSON.stringify({ verifier, machineId }),
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const state = parseDeviceState(context?.providerState);
    if (state === undefined) return { status: "failed", reason: "unknown device authorization" };
    const url =
      `${QODER_DEVICE_TOKEN_URL}?nonce=${encodeURIComponent(deviceAuthId)}` +
      `&verifier=${encodeURIComponent(state.verifier)}&challenge_method=S256`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "Go-http-client/2.0" },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : "Qoder device polling failed",
      };
    }
    // 202/404 are the endpoint's "not approved yet" answers, not failures.
    if (response.status === 202 || response.status === 404) return { status: "pending" };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: "failed", reason: "Qoder device polling returned invalid JSON" };
    }
    if (!response.ok) {
      const message = record(payload);
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(message?.message) ??
          `Qoder device polling failed (${response.status})`,
      };
    }
    const body = record(payload);
    const accessToken = body === undefined ? undefined : nonEmptyTrimmedString(body.token);
    // A 200 without a token means the upstream changed shape — fail loudly
    // rather than storing an empty credential that 401s every dispatch.
    if (accessToken === undefined) {
      return { status: "failed", reason: "Qoder device polling returned no token" };
    }
    const refreshToken = nonEmptyTrimmedString(body?.refresh_token);
    const expireTime = parseQoderExpiry(body?.expires_at, body?.expires_in);
    const info = await this.fetchUserInfo(accessToken);
    const label = info.name || info.email || undefined;
    // The token response does not always name the user id; the profile
    // endpoint does, so it is the fallback before giving up on the identity
    // dispatch needs for COSY signing.
    const resolvedUserId = nonEmptyTrimmedString(body?.user_id) ?? info.id;
    const result: OAuthExchangeResult = {
      access: accessToken,
      // No refresh grant exists, so the upstream refresh token (when present)
      // is mirrored here for the identity fingerprint that keys a repeated
      // login to the same account. It is never sent to a token endpoint —
      // no refresher is registered for this provider.
      refresh: refreshToken ?? accessToken,
      expiresAt: new Date(expireTime),
      ...(label === undefined ? {} : { accountLabel: label }),
      // The token carries neither the user id nor the machine id, and every
      // dispatch needs both for COSY signing — persist them beside the tokens.
      auth_state: { userId: resolvedUserId, machineId: state.machineId },
    };
    return { status: "complete", result };
  }

  /** Best-effort profile lookup for the account label; never blocks login. */
  async fetchUserInfo(accessToken: string): Promise<{ name: string; email: string; id: string }> {
    try {
      const response = await this.fetchFn(QODER_USERINFO_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "user-agent": "Go-http-client/2.0",
        },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      if (!response.ok) return { name: "", email: "", id: "" };
      const body = record(await response.json());
      if (body === undefined) return { name: "", email: "", id: "" };
      return {
        name: (nonEmptyTrimmedString(body.name) ?? nonEmptyTrimmedString(body.username) ?? "").trim(),
        email: (nonEmptyTrimmedString(body.email) ?? "").trim(),
        id:
          nonEmptyTrimmedString(body.id) ??
          nonEmptyTrimmedString(body.userId) ??
          nonEmptyTrimmedString(body.user_id) ??
          "",
      };
    } catch {
      return { name: "", email: "", id: "" };
    }
  }

  override async refresh(
    _refreshToken: string,
    _signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    throw new Error("Qoder does not support token refresh; sign in again");
  }
}

export const qoderOAuthClient = new QoderOAuthClient();
