/**
 * Kilo Code device-code OAuth client.
 *
 * Kilo Code mints a long-lived device token through one JSON endpoint pair on
 * `api.kilo.ai`: a `POST` returns a code pair, and a `GET` reports
 * `pending` / `approved` / `expired`. The poll key is the *user code*, not the
 * `device_code` the same start response also carries — polling with the
 * `device_code` is rejected as `expired`, so the user code is what this client
 * carries forward in `providerState` (the value the console persists
 * server-side and never returns to the browser).
 *
 * There is no refresh grant: the start response advertises no token lifetime
 * and the approved payload carries no refresh token, so this client
 * deliberately declares no `refresher` capability — the same shape as Devin's.
 * The organization id the gateway scopes requests by is folded into the stored
 * credential secret, because the console stores one opaque string per account.
 */
import {
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";

export const KILO_API_BASE_URL = "https://api.kilo.ai" as const;
export const KILO_DEVICE_CODES_URL = `${KILO_API_BASE_URL}/api/device-auth/codes` as const;
export const KILO_PROFILE_URL = `${KILO_API_BASE_URL}/api/profile` as const;

/** Upstream-reported window for a device code, used only when the start omits one. */
const DEVICE_EXPIRY_SECONDS = 600;
const DEVICE_INTERVAL_SECONDS = 3;

/**
 * Fallback expiry for a token whose issuer advertises no lifetime.
 *
 * The value is not a claim about the token: it exists because a stored
 * credential needs an `expires_at`, and it is deliberately far out so the
 * freshness check never schedules a refresh this provider cannot perform.
 * Nothing registers a refresher for Kilo Code, so a nearer value would only
 * make `loadAccountWithFreshness` mark a working token as due.
 */
const NO_EXPIRY_FALLBACK_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Encodes the access secret. Decoding lives in `lib/credential-codec.ts`
 * (`decodeKiloCredential`) so the adapter and the discovery flow share one
 * envelope implementation.
 */
export function encodeKiloCredential(accessToken: string, orgId: string | undefined): string {
  return JSON.stringify({ accessToken, ...(orgId === undefined ? {} : { orgId }) });
}

/** The account label shown for a login, when the approved payload names the user. */
function accountLabelFrom(value: unknown): string | undefined {
  const root = record(value);
  if (root === undefined) return undefined;
  return (
    nonEmptyTrimmedString(root.userEmail) ??
    nonEmptyTrimmedString(record(root.user)?.email) ??
    nonEmptyTrimmedString(root.email)
  );
}

/** Reads the organization id the gateway's requests are scoped by. */
async function fetchOrganizationId(
  fetchFn: FetchLike,
  accessToken: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(KILO_PROFILE_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!response.ok) return undefined;
    const profile = record(await response.json());
    const organizations = profile?.organizations;
    if (!Array.isArray(organizations)) return undefined;
    const first = record(organizations[0]);
    return first === undefined ? undefined : nonEmptyTrimmedString(first.id);
  } catch {
    // A profile lookup is an enrichment, not the authorization. Losing it
    // costs the organization-scoping header, not the login: the token is
    // already approved and the account is still usable without it.
    return undefined;
  }
}

export class KiloOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Kilo Code";
  // The device endpoints take no client id; the abstract field stays empty
  // rather than inventing one, and every request below omits it.
  protected override readonly clientId = "";
  protected override readonly tokenUrl = KILO_DEVICE_CODES_URL;
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const response = await this.fetchFn(KILO_DEVICE_CODES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    if (response.status === 429) {
      throw new Error("Kilo Code has too many pending authorization requests; try again later");
    }
    const payload = record(await readJsonResponse(response, "Kilo Code device authorization"));
    const userCode = payload === undefined ? undefined : nonEmptyTrimmedString(payload.code);
    const verificationUri =
      payload === undefined ? undefined : nonEmptyTrimmedString(payload.verificationUrl);
    if (userCode === undefined || verificationUri === undefined) {
      throw new Error("Kilo Code device authorization returned an invalid response");
    }
    // The start response carries both `code` (the user code) and `device_code`.
    // Only the user code authorizes a poll, so it is the one carried forward.
    return {
      verificationUri,
      userCode,
      deviceAuthId: userCode,
      intervalSeconds: DEVICE_INTERVAL_SECONDS,
      expiresInSeconds: Number(payload?.expiresIn) > 0 ? Number(payload?.expiresIn) : DEVICE_EXPIRY_SECONDS,
      providerState: userCode,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const pollKey = context?.providerState ?? deviceAuthId;
    const response = await this.fetchFn(`${KILO_DEVICE_CODES_URL}/${encodeURIComponent(pollKey)}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 202) return { status: "pending" };
    if (response.status === 403) {
      return { status: "failed", reason: "Kilo Code authorization denied by the user" };
    }
    if (response.status === 410) {
      return { status: "failed", reason: "Kilo Code device authorization expired" };
    }
    if (!response.ok) {
      return { status: "failed", reason: `Kilo Code device polling failed (${response.status})` };
    }
    const payload = record(await readJsonResponse(response, "Kilo Code device polling"));
    if (payload === undefined) {
      return { status: "failed", reason: "Kilo Code device polling returned an invalid response" };
    }
    const accessToken = nonEmptyTrimmedString(payload.token);
    // A 2xx body without an approved token is an incomplete authorization, not
    // an error: the provider reports approval through `status` + `token`
    // together, and the caller owns the poll cadence.
    if (nonEmptyTrimmedString(payload.status) !== "approved" || accessToken === undefined) {
      return { status: "pending" };
    }
    const orgId = await fetchOrganizationId(this.fetchFn, accessToken, AbortSignal.timeout(10_000));
    const label = accountLabelFrom(payload);
    const result: OAuthExchangeResult = {
      access: encodeKiloCredential(accessToken, orgId),
      // No refresh grant exists, so the access secret is mirrored here for the
      // identity fingerprint that keys a repeated login to the same account.
      // `refreshCiphertext` is NOT NULL and this value is never sent to a
      // token endpoint — no refresher is registered for this provider.
      refresh: accessToken,
      expiresAt: new Date(Date.now() + NO_EXPIRY_FALLBACK_MS),
      ...(label === undefined ? {} : { accountLabel: label }),
    };
    return { status: "complete", result };
  }

  override async refresh(_refreshToken: string, _signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    throw new Error("Kilo Code does not support token refresh");
  }
}

export const kiloOAuthClient = new KiloOAuthClient();
