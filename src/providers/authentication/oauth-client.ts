/**
 * Generic OAuth 2.0 base class for provider-specific OAuth clients.
 *
 * Encapsulates common PKCE, device-code, token-exchange and refresh logic
 * while exposing protected hooks for provider-specific customizations.
 */
import {
  buildPkceAuthorizeUrl as buildPkceAuthorizeUrlShared,
  nonEmptyString,
  postFormTokenRequest,
  record,
} from "./oauth-flow-store";
import type {
  OAuthAuthorizeRequest,
  OAuthExchangeResult,
  OAuthLoginClient,
} from "./oauth-flow-store";
import type { OAuthTokenRefreshResult, OAuthTokenRefresher } from "./oauth-refresh-service";

/** Minimal fetch surface accepted by the generic OAuth client. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Normalized token shape returned by provider token endpoints. */
interface NormalizedTokenResponse {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: Date;
  readonly accountLabel?: string | undefined;
}

/** Options for building a PKCE authorize URL. */
interface PkceAuthorizeOptions {
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly extra?: Record<string, string> | undefined;
}

/** Options for a form-encoded token exchange or refresh. */
interface FormTokenOptions {
  readonly url: string;
  readonly params: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly label: string;
}


/** Base class for provider OAuth clients. */
export abstract class OAuthClient implements OAuthLoginClient, OAuthTokenRefresher {
  /** Provider display label used in error messages. */
  protected abstract readonly providerLabel: string;
  /** OAuth client id. */
  protected abstract readonly clientId: string;
  /** Token endpoint URL. */
  protected abstract readonly tokenUrl: string;
  /** Authorization endpoint URL (omit for device-only providers). */
  protected readonly authorizeUrl?: string;
  /** Space-separated OAuth scopes. */
  protected abstract readonly scopes: string;

  /** Whether the provider supports the device-code flow. */
  abstract readonly supportsDeviceCode: boolean;
  /** Whether the provider supports browser PKCE authorization. */
  abstract readonly supportsBrowserCode: boolean;

  protected readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  // ---------------------------------------------------------------------------
  // Public OAuthLoginClient surface
  // ---------------------------------------------------------------------------

  buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    if (!this.authorizeUrl) {
      throw new Error(`${this.providerLabel} does not support browser authorization`);
    }
    return this.buildPkceAuthorizeUrl({
      clientId: this.clientId,
      authorizeUrl: this.authorizeUrl,
      redirectUri: request.redirectUri,
      scope: this.scopes,
      state: request.state,
      codeChallenge: request.codeChallenge,
      extra: this.extraAuthorizeParams(),
    });
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthExchangeResult> {
    if (!this.supportsBrowserCode) {
      throw new Error(`${this.providerLabel} does not support browser code exchange`);
    }
    return this.exchangeCodeVia(code, codeVerifier, redirectUri);
  }

  refresh(_refreshToken: string, _signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    throw new Error(`${this.providerLabel} does not support token refresh`);
  }

  // ---------------------------------------------------------------------------
  // Protected hooks
  // ---------------------------------------------------------------------------

  /** Provider id used to build the OAuth callback URL. Defaults to the provider label lower-cased. */
  protected providerIdForCallback(): string {
    return this.providerLabel.toLowerCase();
  }

  /** Extra query parameters appended to the PKCE authorize URL. */
  protected extraAuthorizeParams(): Record<string, string> | undefined {
    return undefined;
  }

  /** Extracts an account label from a token exchange/refresh response. */
  protected extractAccountLabel(_data: unknown): string | undefined {
    return undefined;
  }

  /** Calculates an expiry Date from an `expires_in` value. */
  protected calculateExpiry(expiresIn: unknown, fallbackSeconds = 3600): Date {
    const seconds =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn >= 0
        ? expiresIn
        : fallbackSeconds;
    return new Date(Date.now() + Math.max(0, seconds) * 1000);
  }

  /** Parses a standard token response object into a normalized result. */
  protected parseTokenResponse(data: unknown, fallbackRefresh?: string): NormalizedTokenResponse {
    const body = record(data) ?? {};
    const access = nonEmptyString(body.access_token) ?? "";
    const refresh = nonEmptyString(body.refresh_token) ?? fallbackRefresh ?? "";
    const expiresAt = this.calculateExpiry(body.expires_in);
    const accountLabel = this.extractAccountLabel(data);
    return { access, refresh, expiresAt, ...(accountLabel ? { accountLabel } : {}) };
  }

  /** Builds a PKCE authorization URL using the shared helper. */
  protected buildPkceAuthorizeUrl(options: PkceAuthorizeOptions): string {
    return buildPkceAuthorizeUrlShared({
      clientId: options.clientId,
      authorizeUrl: options.authorizeUrl,
      redirectUri: options.redirectUri,
      scope: options.scope,
      state: options.state,
      codeChallenge: options.codeChallenge,
      ...(options.extra === undefined ? {} : { extra: options.extra }),
    });
  }

  // ---------------------------------------------------------------------------
  // Shared token request helpers
  // ---------------------------------------------------------------------------

  protected async postFormToken(options: FormTokenOptions): Promise<unknown> {
    return postFormTokenRequest({
      url: options.url,
      fetchFn: this.fetchFn,
      params: options.params,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      label: options.label,
    });
  }

  /** Exchanges a browser authorization code using an explicit callback redirect. */
  protected async exchangeCodeVia(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    extraParams: Record<string, string> = {},
  ): Promise<OAuthExchangeResult> {
    const response = await this.postFormToken({
      url: this.tokenUrl,
      params: {
        client_id: this.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        ...extraParams,
      },
      label: `${this.providerLabel} token exchange`,
    });
    return this.toExchangeResult(this.parseTokenResponse(response));
  }


  // ---------------------------------------------------------------------------
  // Converters
  // ---------------------------------------------------------------------------

  protected toExchangeResult(normalized: NormalizedTokenResponse): OAuthExchangeResult {
    const { access, refresh, expiresAt, accountLabel } = normalized;
    return {
      access,
      refresh,
      expiresAt,
      ...(accountLabel ? { accountLabel } : {}),
    };
  }

  protected toRefreshResult(normalized: NormalizedTokenResponse): OAuthTokenRefreshResult {
    const { access, refresh, expiresAt, accountLabel } = normalized;
    return {
      access,
      ...(refresh ? { refresh } : {}),
      expiresAt,
      ...(accountLabel ? { accountLabel } : {}),
    };
  }
}
