import type { AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { OAuthDriverError, OAuthHttpClient, type OAuthDriverOptions, type OAuthFetch } from "./base";

/**
 * Kiro OAuth driver — AWS IAM Identity Center device authorization flow.
 *
 * Kiro (https://kiro.dev) authenticates through the AWS OIDC device grant:
 * a short-lived public OAuth client is registered per session, the user is
 * pointed at a verification URI with a one-time code, and the token endpoint
 * is polled until the user authorizes. Tokens refresh either through the
 * regional OIDC endpoint (when the registered client credentials are
 * available) or through the desktop refresh endpoint.
 *
 * The device session (registered client + device code) is held in bounded
 * in-memory state keyed by the `state` returned from {@link start}, so a
 * console UI can poll {@link poll} across requests without persisting the
 * client secret. Expired sessions are swept on access and the oldest sessions
 * are evicted before the hard cap, mirroring {@link OAuthStateManager}.
 */

const DEFAULT_REGION = "us-east-1";
const DEFAULT_START_URL = "https://view.awsapps.com/start";
const DEFAULT_AUTH_METHOD = "builder-id";
const KIRO_SCOPES: readonly string[] = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"];
const KIRO_ISSUER = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DESKTOP_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SESSIONS = 10_000;
const DEFAULT_EXPIRES_IN_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 5;

export interface KiroOAuthDriverOptions extends OAuthDriverOptions {
  /** OIDC region used for client registration and device authorization (default "us-east-1"). */
  readonly defaultRegion?: string;
  /** IAM Identity Center start URL presented to the device endpoint (default AWS console start). */
  readonly defaultStartUrl?: string;
  /** Default auth method recorded on completed tokens ("builder-id" | "idc" | "google" | ...). */
  readonly defaultAuthMethod?: string;
  /** Hard cap on concurrent device sessions; oldest are evicted first (default 10_000). */
  readonly maxSessions?: number;
}

/** Device authorization result: everything a console UI needs to show the user. */
export interface KiroDeviceStartResult extends OAuthStartResult {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
}

/** Token material produced when the device flow completes, including the metadata the account layer persists with it. */
export interface KiroDeviceTokenSet extends TokenSet {
  readonly region: string;
  readonly authMethod: string;
  readonly startUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type KiroDevicePollResult =
  | { readonly status: "pending"; readonly intervalSeconds: number }
  | { readonly status: "expired" }
  | { readonly status: "completed"; readonly tokenSet: KiroDeviceTokenSet };

/** Persisted Kiro credential bundle (the JSON stored as the account credential). */
export interface KiroCredentialBundle {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly authMethod?: string;
  readonly profileArn?: string;
  readonly region?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly startUrl?: string;
  readonly accountId?: string;
  readonly email?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringField(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Parses a persisted Kiro credential. Accepts the JSON bundle produced by the
 * device flow (camelCase, matching the legacy `makeKiroBundle` shape); a raw
 * token string is not a bundle and yields null so callers can fall back to
 * treating the credential itself as the access token.
 */
export function parseKiroCredential(credential: string): KiroCredentialBundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const accessToken = pick(record, ["accessToken", "access_token"]);
  if (!accessToken) return null;
  const bundle: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    authMethod?: string;
    profileArn?: string;
    region?: string;
    clientId?: string;
    clientSecret?: string;
    startUrl?: string;
    accountId?: string;
    email?: string;
  } = { accessToken };
  const refreshToken = pick(record, ["refreshToken", "refresh_token"]);
  if (refreshToken) bundle.refreshToken = refreshToken;
  const expiresAt = pick(record, ["expiresAt", "accessExpiresAt"]);
  if (expiresAt) bundle.expiresAt = expiresAt;
  const authMethod = pick(record, ["authMethod"]);
  if (authMethod) bundle.authMethod = authMethod;
  const profileArn = pick(record, ["profileArn"]);
  if (profileArn) bundle.profileArn = profileArn;
  const region = pick(record, ["region"]);
  if (region) bundle.region = region;
  const clientId = pick(record, ["clientId"]);
  if (clientId) bundle.clientId = clientId;
  const clientSecret = pick(record, ["clientSecret"]);
  if (clientSecret) bundle.clientSecret = clientSecret;
  const startUrl = pick(record, ["startUrl"]);
  if (startUrl) bundle.startUrl = startUrl;
  const accountId = pick(record, ["accountId"]);
  if (accountId) bundle.accountId = accountId;
  const email = pick(record, ["email"]);
  if (email) bundle.email = email;
  return bundle;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalJson(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface KiroDeviceSession {
  readonly id: string;
  readonly region: string;
  readonly authMethod: string;
  readonly startUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  readonly expiresAtMs: number;
}

interface KiroClientRegistration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly region: string;
}

/** Kiro OAuth driver: device authorization start/poll and token refresh. */
export class KiroOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;

  private readonly http: OAuthHttpClient;
  private readonly fetchFn: OAuthFetch;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private readonly defaultRegion: string;
  private readonly defaultStartUrl: string;
  private readonly defaultAuthMethod: string;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, KiroDeviceSession>();

  constructor(options: KiroOAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.fetchFn = options.fetch ?? fetch;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultRegion = (options.defaultRegion?.trim() || DEFAULT_REGION).toLowerCase();
    this.defaultStartUrl = options.defaultStartUrl?.trim() || DEFAULT_START_URL;
    this.defaultAuthMethod = options.defaultAuthMethod?.trim() || DEFAULT_AUTH_METHOD;
    this.maxSessions = Math.max(1, Math.floor(options.maxSessions ?? DEFAULT_MAX_SESSIONS));
  }

  /**
   * Starts the device flow: registers a per-session public OAuth client,
   * requests a device authorization, and stores the session under the
   * returned `state`. The console shows `userCode` + `verificationUri` and
   * polls {@link poll} until completion or expiry.
   */
  async start(input: OAuthStartInput): Promise<KiroDeviceStartResult> {
    if (input.providerId !== "kiro") {
      throw new OAuthDriverError("validation", `Kiro driver cannot start provider "${input.providerId}".`, 400, false);
    }
    const client = await this.registerClient(this.defaultRegion);
    const device = await this.startDeviceAuthorization(client, this.defaultStartUrl);
    const expiresAtMs = this.nowMs() + Math.max(60, device.expiresInSeconds) * 1000;
    const id = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    this.putSession({
      id,
      region: client.region,
      authMethod: this.defaultAuthMethod,
      startUrl: this.defaultStartUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSeconds: device.intervalSeconds,
      expiresAtMs,
    });
    return {
      authorizationUrl: device.verificationUri,
      state: id,
      expiresAtMs,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSeconds: device.intervalSeconds,
    };
  }

  /** Polls the device token endpoint for the session returned by {@link start}. */
  async poll(sessionId: string): Promise<KiroDevicePollResult> {
    const session = this.session(sessionId);
    if (session === null) return { status: "expired" };
    const result = await this.postDeviceToken(session);
    if (result === null) return { status: "pending", intervalSeconds: session.intervalSeconds };
    const refreshToken = stringField(result, "refreshToken") ?? stringField(result, "refresh_token");
    const accessToken = stringField(result, "accessToken") ?? stringField(result, "access_token");
    if (!refreshToken || !accessToken) return { status: "pending", intervalSeconds: session.intervalSeconds };
    this.sessions.delete(session.id);
    return { status: "completed", tokenSet: this.toDeviceTokenSet(session, accessToken, refreshToken, result) };
  }

  /**
   * Contract-shaped completion of the device flow: resolves the session by
   * `input.state` (the id returned from {@link start}) and returns the token
   * material once the user has authorized. Sessions are single-use.
   */
  async exchange(input: OAuthExchangeInput): Promise<KiroDeviceTokenSet> {
    if (input.providerId !== "kiro") {
      throw new OAuthDriverError("validation", `Kiro driver cannot exchange provider "${input.providerId}".`, 400, false);
    }
    const session = this.session(input.state ?? "");
    if (session === null) {
      throw new OAuthDriverError("expired", "Kiro device session is missing or expired; restart the device flow.", 410, false);
    }
    const result = await this.postDeviceToken(session);
    if (result === null) {
      throw new OAuthDriverError("authorization_pending", "Kiro device authorization is still pending; poll again.", 400, false);
    }
    const refreshToken = stringField(result, "refreshToken") ?? stringField(result, "refresh_token");
    const accessToken = stringField(result, "accessToken") ?? stringField(result, "access_token");
    if (!refreshToken || !accessToken) {
      throw new OAuthDriverError("validation", "Kiro device token response is missing token fields.", 502, true);
    }
    this.sessions.delete(session.id);
    return this.toDeviceTokenSet(session, accessToken, refreshToken, result);
  }

  /** Refreshes through the desktop refresh endpoint (works without client credentials). */
  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    if (input.providerId !== "kiro") {
      throw new OAuthDriverError("validation", `Kiro driver cannot refresh provider "${input.providerId}".`, 400, false);
    }
    const result = await this.http.postJson(DESKTOP_REFRESH_URL, { refreshToken: input.refreshToken }, "kiro", "token refresh");
    const accessToken = stringField(result, "accessToken") ?? stringField(result, "access_token");
    if (!accessToken) throw new OAuthDriverError("validation", "Kiro refresh did not return an access token.", 401, false);
    return {
      accessToken,
      refreshToken: input.refreshToken,
      expiresAt: new Date(this.nowMs() + Math.max(60, numberField(result, "expiresIn") ?? numberField(result, "expires_in") ?? 3600) * 1000).toISOString(),
      ...(stringField(result, "scope") ? { scope: stringField(result, "scope") as string } : {}),
    };
  }

  /**
   * Refreshes a persisted Kiro credential bundle, preferring the regional
   * OIDC token endpoint when the registered client credentials are present
   * (matching the legacy token keeper) and falling back to the desktop
   * endpoint otherwise.
   */
  async refreshBundle(bundle: KiroCredentialBundle): Promise<KiroCredentialBundle> {
    if (!bundle.refreshToken) {
      throw new OAuthDriverError("validation", "Kiro credential bundle has no refresh token.", 400, false);
    }
    const result =
      bundle.clientId && bundle.clientSecret
        ? await this.http.postJson(
            `https://oidc.${bundle.region ?? this.defaultRegion}.amazonaws.com/token`,
            { clientId: bundle.clientId, clientSecret: bundle.clientSecret, refreshToken: bundle.refreshToken, grantType: "refresh_token" },
            "kiro",
            "token refresh",
          )
        : await this.http.postJson(DESKTOP_REFRESH_URL, { refreshToken: bundle.refreshToken }, "kiro", "token refresh");
    const accessToken = stringField(result, "accessToken") ?? stringField(result, "access_token");
    if (!accessToken) throw new OAuthDriverError("validation", "Kiro refresh did not return an access token.", 401, false);
    return {
      ...bundle,
      accessToken,
      expiresAt: new Date(this.nowMs() + Math.max(60, numberField(result, "expiresIn") ?? numberField(result, "expires_in") ?? 3600) * 1000).toISOString(),
    };
  }

  /** Number of live device sessions (after sweeping expired ones) — diagnostics/tests. */
  sessionCount(nowMs: number = this.nowMs()): number {
    this.sweep(nowMs);
    return this.sessions.size;
  }

  private async registerClient(region: string): Promise<KiroClientRegistration> {
    const result = await this.http.postJson(
      `https://oidc.${region}.amazonaws.com/client/register`,
      { clientName: "kiro-oauth-client", clientType: "public", scopes: KIRO_SCOPES, grantTypes: ["device_code", "refresh_token"], issuerUrl: KIRO_ISSUER },
      "kiro",
      "client registration",
    );
    const clientId = stringField(result, "clientId") ?? stringField(result, "client_id");
    const clientSecret = stringField(result, "clientSecret") ?? stringField(result, "client_secret");
    if (!clientId || !clientSecret) {
      throw new OAuthDriverError("validation", "Kiro did not return an OAuth client.", 502, true);
    }
    return { clientId, clientSecret, region };
  }

  private async startDeviceAuthorization(
    client: KiroClientRegistration,
    startUrl: string,
  ): Promise<{ deviceCode: string; userCode: string; verificationUri: string; intervalSeconds: number; expiresInSeconds: number }> {
    const result = await this.http.postJson(
      `https://oidc.${client.region}.amazonaws.com/device_authorization`,
      { clientId: client.clientId, clientSecret: client.clientSecret, startUrl },
      "kiro",
      "device authorization",
    );
    const deviceCode = stringField(result, "deviceCode") ?? stringField(result, "device_code");
    const userCode = stringField(result, "userCode") ?? stringField(result, "user_code");
    const verificationUri =
      stringField(result, "verificationUriComplete") ??
      stringField(result, "verification_uri_complete") ??
      stringField(result, "verificationUri") ??
      stringField(result, "verification_uri") ??
      startUrl;
    if (!deviceCode || !userCode) {
      throw new OAuthDriverError("validation", "Kiro did not return a device code.", 502, true);
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      intervalSeconds: numberField(result, "interval") ?? DEFAULT_INTERVAL_SECONDS,
      expiresInSeconds: numberField(result, "expiresIn") ?? numberField(result, "expires_in") ?? DEFAULT_EXPIRES_IN_SECONDS,
    };
  }

  /**
   * POSTs the device grant to the regional token endpoint. Returns null while
   * the authorization is still pending (HTTP 400 with
   * authorization_pending / slow_down or a missing error field, mirroring the
   * legacy token keeper) and throws on any other upstream failure.
   */
  private async postDeviceToken(session: KiroDeviceSession): Promise<Record<string, unknown> | null> {
    const response = await this.withTimeout(
      this.fetchFn(`https://oidc.${session.region}.amazonaws.com/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: session.clientId, clientSecret: session.clientSecret, deviceCode: session.deviceCode, grantType: DEVICE_GRANT_TYPE }),
      }),
    );
    const result = parseOptionalJson(await response.text());
    if (!response.ok) {
      const error = stringField(result, "error");
      if (response.status === 400 && (error === "authorization_pending" || error === "slow_down" || error === undefined)) return null;
      throw new OAuthDriverError("device-auth", `Kiro device authorization failed (${response.status}).`, response.status, false);
    }
    return result;
  }

  private toDeviceTokenSet(session: KiroDeviceSession, accessToken: string, refreshToken: string, data: Record<string, unknown>): KiroDeviceTokenSet {
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(this.nowMs() + Math.max(60, numberField(data, "expiresIn") ?? numberField(data, "expires_in") ?? 3600) * 1000).toISOString(),
      ...(stringField(data, "scope") ? { scope: stringField(data, "scope") as string } : {}),
      region: session.region,
      authMethod: session.authMethod,
      startUrl: session.startUrl,
      clientId: session.clientId,
      clientSecret: session.clientSecret,
    };
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OAuthDriverError("timeout", "Kiro OAuth request timed out.", 502, true)), this.timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private putSession(session: KiroDeviceSession): void {
    const now = this.nowMs();
    this.sweep(now);
    while (this.sessions.size >= this.maxSessions) this.evictOldest();
    this.sessions.set(session.id, session);
  }

  private session(id: string): KiroDeviceSession | null {
    const now = this.nowMs();
    this.sweep(now);
    const session = this.sessions.get(id);
    if (session === undefined || session.expiresAtMs <= now) {
      if (session !== undefined) this.sessions.delete(id);
      return null;
    }
    return session;
  }

  private sweep(nowMs: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAtMs <= nowMs) this.sessions.delete(id);
    }
  }

  private evictOldest(): void {
    let oldest: KiroDeviceSession | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const session of this.sessions.values()) {
      if (session.expiresAtMs < oldestAt) {
        oldest = session;
        oldestAt = session.expiresAtMs;
      }
    }
    if (oldest !== null) this.sessions.delete(oldest.id);
  }
}
