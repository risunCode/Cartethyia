import {
  expiryFromSeconds,
  isDevicePollPending,
  nonEmptyTrimmedString,
  parseDeviceAuthStart,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type { OAuthDeviceFlowContext, OAuthDevicePollResult, OAuthDeviceStartResult, OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const WORKOS_DEVICE_AUTHORIZATION_URL = `${WORKOS_API_BASE_URL}/user_management/authorize/device`;
const WORKOS_AUTHENTICATE_URL = `${WORKOS_API_BASE_URL}/user_management/authenticate`;
const CLINE_REGISTER_URL = "https://api.cline.bot/api/v1/auth/register";
const CLINE_REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";
const WORKOS_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const DEVICE_EXPIRY_SECONDS = 300;
const DEVICE_INTERVAL_SECONDS = 5;

interface DeviceSession {
  readonly expiresAtMs: number;
}

function tokenPayload(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  return record(root.data) ?? root;
}

function tokenExpiry(payload: Record<string, unknown>): Date {
  const absolute = nonEmptyTrimmedString(payload.expiresAt) ?? nonEmptyTrimmedString(payload.expires_at);
  if (absolute !== undefined) {
    const parsed = new Date(absolute);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return expiryFromSeconds(payload.expires_in ?? payload.expiresIn, 3600);
}

function tokenResult(value: unknown, fallbackRefresh?: string): OAuthExchangeResult {
  const payload = tokenPayload(value);
  const access = nonEmptyTrimmedString(payload.access_token) ?? nonEmptyTrimmedString(payload.accessToken) ?? nonEmptyTrimmedString(payload.token);
  const refresh =
    nonEmptyTrimmedString(payload.refresh_token) ?? nonEmptyTrimmedString(payload.refreshToken) ?? fallbackRefresh;
  if (!access || !refresh) throw new Error("Cline OAuth response omitted access or refresh token");
  const accountLabel =
    nonEmptyTrimmedString(payload.email) ??
    nonEmptyTrimmedString(record(payload.userInfo)?.email) ??
    nonEmptyTrimmedString(record(payload.user)?.email);
  return {
    access,
    refresh,
    expiresAt: tokenExpiry(payload),
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}

async function parseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  return (await readJsonResponse(response, label).then(tokenPayload)) as Record<string, unknown>;
}

async function parseJsonAllowingError(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as unknown;
    return tokenPayload(parsed);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function sessionFromProviderState(value: string | undefined): DeviceSession | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    const state = record(parsed);
    const expiresAtMs = state === undefined ? undefined : Number(state.expiresAtMs);
    return expiresAtMs !== undefined && Number.isFinite(expiresAtMs) && expiresAtMs > 0
      ? { expiresAtMs }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Cline WorkOS device-code OAuth client under the canonical `cline` provider. */
export class ClineOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Cline";
  protected override readonly clientId = CLINE_WORKOS_CLIENT_ID;
  protected override readonly tokenUrl = WORKOS_AUTHENTICATE_URL;
  protected override readonly scopes = "";

  readonly #sessions = new Map<string, DeviceSession>();

  static readonly #MAX_SESSIONS = 1024;

  #boundSessions(): void {
    while (this.#sessions.size > ClineOAuthClient.#MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) break;
      this.#sessions.delete(oldest);
    }
  }

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const response = await this.fetchFn(WORKOS_DEVICE_AUTHORIZATION_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }),
    });
    const payload = await parseJson(response, "Cline WorkOS device authorization");
    const start = parseDeviceAuthStart(payload, {
      intervalSeconds: DEVICE_INTERVAL_SECONDS,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
    });
    if (!start) {
      throw new Error("Cline WorkOS device authorization returned missing device credentials");
    }
    const expiresAtMs = Date.now() + start.expiresInSeconds * 1000;
    this.#sessions.set(start.deviceCode, { expiresAtMs });
    this.#boundSessions();
    // WorkOS returns `verification_uri_complete`, which already carries the
    // user code in its query string. Preferring it is what makes the flow
    // one click: the operator opens the page and the code is entered for them.
    // Publishing only `verification_uri` forced them to read the code here and
    // type it into the form by hand.
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
      providerState: JSON.stringify({ expiresAtMs }),
    };
  }

  override async pollDeviceAuth(deviceAuthId: string, context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    const session = this.#sessions.get(deviceAuthId) ?? sessionFromProviderState(context?.providerState);
    if (!session || session.expiresAtMs <= Date.now()) {
      this.#sessions.delete(deviceAuthId);
      return { status: "failed", reason: "Cline device authorization expired" };
    }
    const response = await this.fetchFn(WORKOS_AUTHENTICATE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: WORKOS_DEVICE_GRANT,
        device_code: deviceAuthId,
        client_id: CLINE_WORKOS_CLIENT_ID,
      }),
    });
    const payload = await parseJsonAllowingError(response, "Cline WorkOS device polling");
    const error = nonEmptyTrimmedString(payload.error);
    if (!response.ok && isDevicePollPending(error)) {
      return { status: "pending" };
    }
    if (!response.ok) {
      this.#sessions.delete(deviceAuthId);
      return {
        status: "failed",
        reason: nonEmptyTrimmedString(payload.error_description) ?? `Cline device polling failed (${response.status})`,
      };
    }
    const accessToken = nonEmptyTrimmedString(payload.access_token);
    const refreshToken = nonEmptyTrimmedString(payload.refresh_token);
    if (!accessToken || !refreshToken) {
      this.#sessions.delete(deviceAuthId);
      return { status: "failed", reason: "Cline WorkOS token response omitted access or refresh token" };
    }
    const registerResponse = await this.fetchFn(CLINE_REGISTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ accessToken, refreshToken }),
    });
    const registered = await parseJson(registerResponse, "Cline token registration");
    this.#sessions.delete(deviceAuthId);
    return { status: "complete", result: tokenResult(registered, refreshToken) };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(CLINE_REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
      ...(signal === undefined ? {} : { signal }),
    });
    return tokenResult(await parseJson(response, "Cline OAuth refresh"), refreshToken);
  }
}

export const clineOAuthClient = new ClineOAuthClient();
