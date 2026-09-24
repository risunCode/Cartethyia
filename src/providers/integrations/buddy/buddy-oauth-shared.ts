/**
 * The buddy-family device-login mechanism (`cb`, `cbcn`, `workbuddy`).
 *
 * All three complete device login against the same plugin auth endpoints: a
 * state POST, a token poll that answers the pending code `11217` until the user
 * finishes in the browser, and a refresh POST. They answer one
 * `{ data: { accessToken, refreshToken, tokenType, expiresIn } }` envelope and
 * carry one identity header set, so the envelope accessors, the token
 * projection, the account label, and the flow itself live here. Each provider's
 * `*-oauth.ts` supplies one `BuddyOAuthVariant` — endpoints, domain, platform,
 * user agent, and response-code reading — and nothing else.
 */
import {
  decodeJwtPayload,
  expiryFromSeconds,
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

/** Token fields the buddy plugin auth endpoints return inside `data`. */
export interface BuddyTokenData {
  readonly accessToken?: unknown;
  readonly refreshToken?: unknown;
  readonly tokenType?: unknown;
  readonly expiresIn?: unknown;
}

/** The `data` object of a buddy auth response, or `undefined` when absent. */
export function buddyResponseData(payload: unknown): Record<string, unknown> | undefined {
  return record(record(payload)?.data);
}

/** Projects one buddy auth response onto the token fields the flow consumes. */
export function parseBuddyTokenData(payload: unknown): BuddyTokenData {
  const data = buddyResponseData(payload) ?? {};
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    tokenType: data.tokenType,
    expiresIn: data.expiresIn,
  };
}

/**
 * Reads the envelope `code` strictly: a finite number, or a string that parses
 * as one. Anything else — a JSON `null` included — is `undefined`, so a
 * malformed response cannot read as success.
 */
export function strictResponseCode(payload: unknown): number | undefined {
  const root = record(payload);
  if (typeof root?.code === "number" && Number.isFinite(root.code)) return root.code;
  if (typeof root?.code === "string" && Number.isFinite(Number(root.code))) return Number(root.code);
  return undefined;
}

/**
 * Reads the envelope `code` through `Number()`, which is how the WorkBuddy
 * gateway is read. Looser than `strictResponseCode` on a malformed payload: a
 * `null` code coerces to `0`, i.e. success, and `true` to `1`. Kept verbatim
 * rather than tightened because nothing here shows what that gateway sends for
 * an absent code, and rejecting a response it accepts would break a login that
 * works today.
 */
export function coercingResponseCode(payload: unknown): number | undefined {
  const n = Number(record(payload)?.code);
  return Number.isFinite(n) ? n : undefined;
}

/** One provider's configuration of the buddy device-login flow. */
export interface BuddyOAuthVariant {
  readonly providerId: string;
  /** Display name for error messages (`OAuthClient.providerLabel`). */
  readonly providerLabel: string;
  /** Stamped into the `x-domain` header of every auth request. */
  readonly domain: string;
  /** `platform` query parameter of the device-start request. */
  readonly platform: string;
  /** Resolves version metadata, then builds the `User-Agent` of one auth request. */
  readonly userAgent: () => Promise<string>;
  readonly deviceStartUrl: string;
  readonly devicePollUrl: string;
  readonly refreshUrl: string;
  /** Reads the envelope `code`; see `strictResponseCode` / `coercingResponseCode`. */
  readonly responseCode: (payload: unknown) => number | undefined;
}

const DEVICE_EXPIRY_SECONDS = 900;
/** Envelope code the token poll answers while the browser step is unfinished. */
const BUDDY_PENDING_CODE = 11217;

/**
 * Resolves the account uid from a buddy OAuth access token for endpoints that
 * score by uid (the growth `/v2/report` event's `userId`, the `X-User-Id`
 * billing header). The JWT `sub` claim is the uid; `uid` is accepted as a
 * forward-compatible alias. Returns `undefined` for opaque API keys, which
 * carry no identity — those callers must fail closed, never report as another
 * account.
 */
export function buddyAccountUid(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return undefined;
  return nonEmptyTrimmedString(claims.sub) ?? nonEmptyTrimmedString(claims.uid);
}

/**
 * A buddy OAuth access token is a Keycloak JWT that inlines the account
 * identity (`name`, `preferred_username`, `email`, `given_name`/`family_name`).
 * Resolve a human display label from it so the account shows "Borneo usar
 * <borneousar@gmail.com>" instead of the generic `${providerId} account`.
 * Falls back to `undefined` when the token carries no usable identity, letting
 * the console keep the operator-supplied label.
 */
export function buddyAccountLabel(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return undefined;
  const email = nonEmptyTrimmedString(claims.email) ?? nonEmptyTrimmedString(claims.preferred_username);
  const given = nonEmptyTrimmedString(claims.given_name);
  const family = nonEmptyTrimmedString(claims.family_name);
  const full =
    given && family ? `${given} ${family}` : nonEmptyTrimmedString(claims.name) ?? undefined;
  if (email && full) return `${full} <${email}>`;
  return email ?? full ?? nonEmptyTrimmedString(claims.sub);
}

function tokenResult(
  variant: BuddyOAuthVariant,
  payload: unknown,
  fallbackRefresh?: string,
): OAuthExchangeResult {
  const data = parseBuddyTokenData(payload);
  const access = nonEmptyTrimmedString(data.accessToken);
  if (!access) throw new Error(`${variant.providerId} token response omitted accessToken`);
  const refresh = nonEmptyTrimmedString(data.refreshToken) ?? fallbackRefresh ?? "";
  const accountLabel = buddyAccountLabel(access);
  return {
    access,
    refresh,
    expiresAt: expiryFromSeconds(data.expiresIn, 86_400),
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}

/** Client identity headers shared by every auth request of one variant. */
async function authIdentityHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    accept: "application/json",
    "user-agent": await variant.userAgent(),
    "x-requested-with": "XMLHttpRequest",
    "x-domain": variant.domain,
    "x-product": "SaaS",
  };
}

async function deviceStartHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    ...(await authIdentityHeaders(variant)),
    "x-no-authorization": "true",
    "x-no-user-id": "true",
  };
}

async function devicePollHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    ...(await authIdentityHeaders(variant)),
    "x-no-authorization": "true",
    "x-no-user-id": "true",
    "x-no-enterprise-id": "true",
    "x-no-department-info": "true",
  };
}

async function refreshHeaders(
  variant: BuddyOAuthVariant,
  refreshToken: string,
): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    ...(await authIdentityHeaders(variant)),
    "x-refresh-token": refreshToken,
    "x-auth-refresh-source": "plugin",
  };
}

/** Buddy state-polling OAuth client for one provider variant. */
export class BuddyOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel: string;
  protected override readonly clientId = "";
  protected override readonly tokenUrl = "";
  protected override readonly scopes = "";

  readonly #variant: BuddyOAuthVariant;

  constructor(variant: BuddyOAuthVariant, fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
    this.#variant = variant;
    this.providerLabel = variant.providerLabel;
  }

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const url = `${this.#variant.deviceStartUrl}?platform=${encodeURIComponent(this.#variant.platform)}`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: await deviceStartHeaders(this.#variant),
      body: "{}",
    });
    const payload = await readJsonResponse(response, `${this.#variant.providerId} device authorization`);
    if (this.#variant.responseCode(payload) !== 0) {
      throw new Error(
        `${this.#variant.providerId} state error: ${nonEmptyTrimmedString(record(payload)?.msg) ?? "missing state/authUrl"}`,
      );
    }
    const data = buddyResponseData(payload);
    const deviceAuthId = nonEmptyTrimmedString(data?.state);
    const verificationUri = nonEmptyTrimmedString(data?.authUrl);
    if (!deviceAuthId || !verificationUri) {
      throw new Error(`${this.#variant.providerId} device authorization returned an invalid response`);
    }
    return {
      verificationUri,
      userCode: "",
      deviceAuthId,
      intervalSeconds: 5,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const url = `${this.#variant.devicePollUrl}?state=${encodeURIComponent(deviceAuthId)}`;
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: await devicePollHeaders(this.#variant),
    });
    const textBody = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(textBody) as unknown;
    } catch {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token endpoint returned invalid JSON`,
      };
    }
    if (!response.ok) {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token polling failed (${response.status})`,
      };
    }
    const code = this.#variant.responseCode(payload);
    if (code === BUDDY_PENDING_CODE) return { status: "pending" };
    if (code !== 0) {
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(record(payload)?.msg) ?? `${this.#variant.providerId} token polling failed`,
      };
    }
    const data = buddyResponseData(payload);
    const access = nonEmptyTrimmedString(data?.accessToken);
    if (!access) {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token response omitted accessToken`,
      };
    }
    return { status: "complete", result: tokenResult(this.#variant, payload) };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(this.#variant.refreshUrl, {
      method: "POST",
      headers: await refreshHeaders(this.#variant, refreshToken),
      body: "{}",
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = await readJsonResponse(response, `${this.#variant.providerId} token refresh`);
    if (this.#variant.responseCode(payload) !== 0) {
      const detail = nonEmptyTrimmedString(record(payload)?.msg);
      throw new Error(`${this.#variant.providerId} token refresh failed${detail ? `: ${detail}` : ""}`);
    }
    const result = tokenResult(this.#variant, payload, refreshToken);
    return {
      access: result.access,
      ...(result.refresh ? { refresh: result.refresh } : {}),
      expiresAt: result.expiresAt,
    };
  }
}
