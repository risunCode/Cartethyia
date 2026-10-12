/**
 * Factory Droid device-code login (WorkOS).
 *
 * A real OAuth device authorization grant: `POST …/authorize/device`, the
 * operator approves at `auth.factory.ai`, and `POST …/authenticate` replays
 * until it issues an access token.
 *
 * Two things make this more than a copy of the generic RFC-8628 helper:
 *
 * 1. **The token is a JWT whose claims carry the request identity.** Factory
 *    scopes every upstream call to the approving user's organization, so the
 *    `external_org_id` claim must become the `X-Factory-Org-Id` header. The
 *    envelope therefore stores the org id beside the token, and `auth_state`
 *    records the email and user id so the console can label the account.
 * 2. **The credential expires with the JWT.** An `expires_at` far in the
 *    future would make the freshness check treat a dead token as live, so the
 *    expiry is read from the token itself.
 *
 * This client registers a refresher: WorkOS re-authenticates against the same
 * endpoint the device flow uses, and a revoked grant is rejected there with the
 * message the refresh service classifies as definitive.
 */
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import {
  devicePollBackoff,
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { encodeFactoryDroidCredential, type FactoryDroidEnvelope } from "../../../security/credential-codec";

/** WorkOS public client. Public by design: it authorizes a user, not a secret. */
export const FACTORY_DROID_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
export const FACTORY_DROID_DEVICE_AUTH_URL =
  "https://api.workos.com/user_management/authorize/device" as const;
export const FACTORY_DROID_TOKEN_URL =
  "https://api.workos.com/user_management/authenticate" as const;

const WORKOS_HEADERS = { accept: "application/json" };

/**
 * Far-future fallback for a token that carries no `exp`.
 *
 * Not a claim about the token: a stored credential needs an `expires_at`, and
 * this value exists so the freshness check never schedules a refresh the
 * endpoint cannot perform for a token that has not expired.
 */
const NO_EXPIRY_FALLBACK_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The stored secret: the access token plus the org id its claims carry.
 *
 * Re-exported from the codec so the OAuth client and the adapter agree on one
 * envelope shape — the writer and the reader of a secret must not each declare
 * their own.
 */
export type { FactoryDroidEnvelope } from "../../../security/credential-codec";

/**
 * Decodes a JWT payload without verifying it.
 *
 * Signature verification belongs to `jwtVerification` in provider metadata and
 * runs once at persistence, when the console rejects an unverifiable token.
 * Repeating it on every refresh would add a JWKS fetch to the dispatch path for
 * no additional guarantee: the signature cannot change without the payload
 * changing, and the payload is what this reads.
 */
function jwtClaims(token: string): Record<string, unknown> | undefined {
  const segments = token.split(".");
  const payload = segments[1];
  if (segments.length < 2 || payload === undefined || payload.length === 0) return undefined;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const parsed: unknown = JSON.parse(atob(padded));
    return record(parsed);
  } catch {
    return undefined;
  }
}

/** Expiry from the token's own `exp` claim, or the fallback when absent. */
function expiryFromClaims(claims: Record<string, unknown> | undefined): Date {
  const exp = claims?.["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
    return new Date(Date.now() + NO_EXPIRY_FALLBACK_MS);
  }
  return new Date(exp * 1000);
}

function buildEnvelope(
  payload: Record<string, unknown>,
  accountLabel: string | undefined,
): { readonly result: OAuthExchangeResult; readonly authState: Record<string, unknown> } {
  const accessToken = nonEmptyTrimmedString(payload["access_token"]);
  if (accessToken === undefined) throw new Error("Factory Droid returned no access token");
  const claims = jwtClaims(accessToken);
  const orgId = nonEmptyTrimmedString(claims?.["external_org_id"]);
  if (orgId === undefined) {
    // Factory scopes every call to the approving user's organization, so a
    // token without that claim cannot be dispatched. Failing here names the
    // cause; failing upstream would surface as an opaque 401.
    throw new Error("Factory Droid token carries no organization claim; sign in again");
  }
  const email = nonEmptyTrimmedString(claims?.["email"]);
  const subject = nonEmptyTrimmedString(claims?.["sub"]);
  const label = accountLabel ?? email ?? subject;
  const envelope: FactoryDroidEnvelope = { accessToken, orgId };
  const result: OAuthExchangeResult = {
    access: encodeFactoryDroidCredential(envelope),
    // WorkOS re-authenticates with the same token endpoint, so a real refresh
    // grant exists and this client registers a refresher. The grant is the
    // issued `refresh_token` when one comes back; mirroring the access token
    // otherwise is what `refresh_ciphertext` NOT NULL requires.
    refresh: nonEmptyTrimmedString(payload["refresh_token"]) ?? accessToken,
    expiresAt: expiryFromClaims(claims),
    ...(label === undefined ? {} : { accountLabel: label }),
  };
  return {
    result,
    authState: {
      orgId,
      ...(email === undefined ? {} : { email }),
      ...(subject === undefined ? {} : { userId: subject }),
    },
  };
}

/** Device-code OAuth client for the Factory Droid subscription gateway. */
export class FactoryDroidOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Factory Droid";
  protected override readonly clientId = FACTORY_DROID_CLIENT_ID;
  protected override readonly tokenUrl = FACTORY_DROID_TOKEN_URL;
  protected override readonly scopes = "";

  override async startDeviceAuth(
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDeviceStartResult> {
    return this.startGenericDeviceAuth({
      tokenUrl: FACTORY_DROID_TOKEN_URL,
      deviceAuthUrl: FACTORY_DROID_DEVICE_AUTH_URL,
      clientId: FACTORY_DROID_CLIENT_ID,
      formHeaders: WORKOS_HEADERS,
      startParams: { user_agent: "cartethyia" },
    });
  }

  /**
   * The device grant's token request, issued here rather than through
   * `pollGenericDeviceAuth`.
   *
   * The shared helper collapses the response to an `OAuthExchangeResult`, which
   * drops `refresh_token` on the floor: it keeps the access token and any
   * `fallbackRefresh`. WorkOS issues a real refresh grant, and a credential
   * stored with the access token in that slot would hand the refresh endpoint
   * an expired bearer and strand the account on first expiry.
   */
  override async pollDeviceAuth(
    deviceAuthId: string,
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const response = await this.fetchFn(FACTORY_DROID_TOKEN_URL, {
      method: "POST",
      headers: { ...WORKOS_HEADERS, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: FACTORY_DROID_CLIENT_ID,
        device_code: deviceAuthId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
    const payload = record(parsed) ?? {};
    if (response.status === 400 || response.status === 428) {
      const error = typeof payload["error"] === "string" ? payload["error"] : "";
      // The shared backoff table owns RFC 8628 §3.5, including `slow_down`.
      const verdict = devicePollBackoff(error, payload["interval"]);
      if (verdict !== undefined) return verdict;
      return { status: "failed", reason: error || `device polling failed (${response.status})` };
    }
    if (!response.ok || parsed === undefined) {
      return { status: "failed", reason: `device polling failed (${response.status})` };
    }
    try {
      const { result, authState } = buildEnvelope(payload, undefined);
      return { status: "complete", result: { ...result, auth_state: authState } };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : "Factory Droid authentication failed",
      };
    }
  }

  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    // WorkOS re-authenticates against the same endpoint the device flow used,
    // with the refresh grant instead of a device code.
    const response = await this.fetchFn(FACTORY_DROID_TOKEN_URL, {
      method: "POST",
      headers: { ...WORKOS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        client_id: FACTORY_DROID_CLIENT_ID,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = record(await readJsonResponse(response, "Factory Droid refresh"));
    if (payload === undefined) throw new Error("Factory Droid refresh returned an invalid response");
    const { result, authState } = buildEnvelope(payload, undefined);
    return {
      access: result.access,
      refresh: refreshToken,
      expiresAt: result.expiresAt,
      auth_state: authState,
    };
  }
}

export const factoryDroidOAuthClient = new FactoryDroidOAuthClient();