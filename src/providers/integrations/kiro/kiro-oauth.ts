/**
 * Kiro (AWS CodeWhisperer) authentication.
 *
 * Kiro has no single sign-in: the same subscription is reached through AWS
 * Builder ID, an Identity Center organization, Google/GitHub social sign-in, an
 * imported refresh token, an enterprise Microsoft identity provider, or a plain
 * API key. They differ in where the token comes from, how it is refreshed, and —
 * critically — which upstream host will accept it.
 *
 * What they share is the account-side configuration every later request needs
 * (the profile the account is bound to, the region it was minted in, and how it
 * authenticates). That travels in `auth_state` beside the tokens, because the
 * dispatched request and the refresh both need it and the credential string
 * cannot express it.
 *
 * Two rules are load-bearing and easy to get wrong:
 *
 *  * An account-bound credential (API key, Identity Center, enterprise) must
 *    never be sent the shared placeholder profile ARN. The placeholder belongs
 *    to the vendor's own account, and the upstream answers it with a 403.
 *  * AWS SSO OIDC answers camelCase JSON, not the snake_case form-urlencoded
 *    every other provider in this gateway speaks, so its responses are parsed
 *    separately rather than through the shared token parser.
 */
import {
  decodeJwtPayload,
  devicePollBackoff,
  nonEmptyString,
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthAuthorizeRequest,
  OAuthCodeExchangeContext,
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginField,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthRefreshContext,
  OAuthTokenRefreshResult,
} from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import {
  buildKiroAmzUserAgent,
  buildKiroSsoAmzUserAgent,
  buildKiroSsoUserAgent,
  buildKiroUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { deriveApiKeyMachineId, deriveOAuthMachineId, normalizeMachineId } from "./kiro-machine-id";

/** Auth methods this integration supports, as stored on the account. */
export type KiroAuthMethod =
  | "builder-id"
  | "idc"
  | "google"
  | "github"
  | "imported"
  | "external_idp"
  | "api_key";

/** AWS region shape, checked before a region is interpolated into a URL. */
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/** Default region when an account carries none. */
const DEFAULT_REGION = "us-east-1";

/** The vendor's own sign-in and refresh service for the social families. */
export const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev" as const;

/**
 * Redirect URI the vendor's identity provider allowlists. It is a custom
 * scheme, not a loopback address: the authorization code is shown to the
 * operator rather than delivered to a local listener.
 */
export const KIRO_SOCIAL_REDIRECT_URI = "kiro://kiro.kiroAgent/authenticate-success" as const;

/** Scopes the OIDC client registration requests. */
const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
] as const;

/** Grant types the OIDC client registration declares. */
const KIRO_GRANT_TYPES = [
  "urn:ietf:params:oauth:grant-type:device_code",
  "refresh_token",
] as const;

/**
 * Client name the OIDC registration presents.
 *
 * The registration is the first request a new account makes, so it identifies as
 * the vendor's own IDE rather than as this gateway.
 */
const KIRO_OIDC_CLIENT_NAME = "Kiro IDE" as const;

/** Organization entry point the device flow starts from by default. */
export const KIRO_DEFAULT_START_URL = "https://view.awsapps.com/start" as const;

export const KIRO_BUILDER_ID_ISSUER = "https://view.awsapps.com/start" as const;

const KIRO_BROWSER_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

/** Microsoft login hosts an enterprise token endpoint may point at. */
const MICROSOFT_TOKEN_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.windows.net",
]);

/**
 * The account-side configuration carried in `auth_state`.
 *
 * `machineId` is part of it because it is derived once from the credential and
 * must not move afterwards: a refresh rotates the refresh token, and a device id
 * derived per request from the rotating material would make one account appear
 * to be a different machine on every refresh.
 */
export interface KiroAuthState {
  readonly authMethod: KiroAuthMethod;
  readonly region: string;
  readonly profileArn?: string;
  /** Identity Center organization URL, when the account came from one. */
  readonly startUrl?: string;
  /** OIDC client id from the device-flow registration. */
  readonly clientId?: string;
  /** Enterprise identity-provider token endpoint. */
  readonly tokenEndpoint?: string;
  /** Enterprise identity-provider scopes. */
  readonly scope?: string;
  /** Frozen device identity presented in the User-Agent. */
  readonly machineId?: string;
}

/** Rejects a region that is not an AWS region before it reaches a URL. */
export function assertAwsRegion(region: string): string {
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error("Kiro region must be a valid AWS region");
  }
  return region;
}

/** Normalizes a stored region, falling back to the default. */
export function normalizeRegion(value: unknown): string {
  const region = typeof value === "string" ? value.trim() : "";
  return AWS_REGION_PATTERN.test(region) ? region : DEFAULT_REGION;
}

/** Reads the account's `auth_state` back into a typed value. */
export function parseKiroAuthState(value: unknown): KiroAuthState | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const authMethod = nonEmptyString(raw["authMethod"]);
  if (authMethod === undefined || !isKiroAuthMethod(authMethod)) return undefined;
  const profileArn = nonEmptyTrimmedString(raw["profileArn"]);
  const startUrl = nonEmptyTrimmedString(raw["startUrl"]);
  const clientId = nonEmptyTrimmedString(raw["clientId"]);
  const tokenEndpoint = nonEmptyTrimmedString(raw["tokenEndpoint"]);
  const scope = nonEmptyTrimmedString(raw["scope"]);
  const machineId = normalizeMachineId(raw["machineId"]);
  return {
    authMethod,
    region: normalizeRegion(raw["region"]),
    ...(profileArn === undefined ? {} : { profileArn }),
    ...(startUrl === undefined ? {} : { startUrl }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
    ...(scope === undefined ? {} : { scope }),
    ...(machineId === undefined ? {} : { machineId }),
  };
}

function isKiroAuthMethod(value: string): value is KiroAuthMethod {
  return (
    value === "builder-id" ||
    value === "idc" ||
    value === "google" ||
    value === "github" ||
    value === "imported" ||
    value === "external_idp" ||
    value === "api_key"
  );
}

/** The `auth_state` object to persist for one flow. */
function authStateOf(state: KiroAuthState): Readonly<Record<string, unknown>> {
  return { ...state };
}

/**
 * Headers every AWS SSO OIDC request carries.
 *
 * The login flow and the token refresh hit the same `oidc.{region}.amazonaws.com`
 * host, so they must look identical: registering bare and then refreshing with a
 * full SDK User-Agent describes two different clients holding one client id,
 * which is a stronger signal than either shape alone.
 */
function ssoOidcHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    connection: "close",
    "amz-sdk-request": "attempt=1; max=4",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "user-agent": buildKiroSsoUserAgent(),
    "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
  };
}

/**
 * Headers for the vendor's own sign-in and refresh service.
 *
 * A different host from the AWS SSO OIDC endpoints, with its own observed
 * client: that service is reached over plain HTTPS with no AWS SDK involved, so
 * the client identifies itself with the device marker alone and no
 * `aws-sdk-js/` segment. The device marker is included only when the credential
 * it belongs to is already known: the code exchange runs before an account
 * exists, and inventing an identity for that request would be worse than
 * sending none.
 */
function socialServiceHeaders(machineId?: string): Record<string, string> {
  const device = machineId === undefined ? "KiroIDE" : `KiroIDE-${getKiroVersion()}-${machineId}`;
  return {
    "content-type": "application/json",
    accept: "application/json",
    connection: "close",
    "user-agent": device,
    "x-amz-user-agent": device,
  };
}

/**
 * Validates an enterprise identity-provider token endpoint.
 *
 * The endpoint comes from imported JSON and receives the account's refresh
 * token, so it is restricted to the Microsoft login hosts rather than trusted
 * as given.
 */
export function validateMicrosoftTokenEndpoint(raw: unknown): string {
  const endpoint = typeof raw === "string" ? raw.trim() : "";
  if (endpoint.length === 0) throw new Error("token_endpoint is required");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("token_endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("token_endpoint must use https");
  if (!MICROSOFT_TOKEN_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("token_endpoint must be a Microsoft login endpoint");
  }
  return parsed.toString();
}

/** Best-effort display label for a credential. */
export function kiroAccountLabel(accessToken: string | undefined): string | undefined {
  const payload = accessToken === undefined ? undefined : decodeJwtPayload(accessToken);
  if (payload === undefined) return undefined;
  for (const key of ["email", "preferred_username", "upn", "sub"]) {
    const value = nonEmptyTrimmedString(payload[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** One AWS SSO OIDC token response, in the casing that endpoint uses. */
interface OidcTokenResponse {
  readonly accessToken?: unknown;
  readonly refreshToken?: unknown;
  readonly expiresIn?: unknown;
  readonly profileArn?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
  readonly interval?: unknown;
}

/** Credentials the device-flow registration minted and refresh must replay. */
interface DeviceFlowRegistration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly region: string;
  readonly startUrl: string;
  readonly authMethod: "builder-id" | "idc";
}

function parseRegistration(value: unknown): DeviceFlowRegistration | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const clientId = nonEmptyString(raw["clientId"]);
  const clientSecret = nonEmptyString(raw["clientSecret"]);
  const region = normalizeRegion(raw["region"]);
  const startUrl = nonEmptyTrimmedString(raw["startUrl"]) ?? KIRO_DEFAULT_START_URL;
  const authMethod = raw["authMethod"] === "idc" ? "idc" : "builder-id";
  if (clientId === undefined || clientSecret === undefined) return undefined;
  return { clientId, clientSecret, region, startUrl, authMethod };
}

/**
 * Kiro's authentication client.
 *
 * Extends the device-flow base for the AWS families and implements the social
 * code exchange, refresh-token import, enterprise import and API-key validation
 * directly, because those are not device flows and forcing them into one would
 * misdescribe what the operator is being asked to do.
 */
export class KiroOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  /**
   * The vendor's own identity provider, reached with a custom-scheme redirect.
   *
   * Declared `true` because this client genuinely implements both halves of a
   * browser code flow: it builds the authorize URL (selecting Google or GitHub)
   * and it exchanges the pasted code. Saying `false` hid a working sign-in path
   * from the console, which is the failure mode the flag exists to prevent in
   * the opposite direction — the flag suppresses a flow only when the client
   * cannot complete one.
   */
  override readonly supportsBrowserCode = true;

  protected override readonly providerLabel = "kiro";
  protected override readonly clientId = "";
  protected override readonly tokenUrl = `${KIRO_AUTH_SERVICE}/refreshToken`;
  protected override readonly scopes = "";
  /**
   * The authorize URL carries the identity provider, not a client id, so the
   * operator chooses which one to start with. The custom-scheme redirect below
   * is handed to the installed app rather than delivered to a loopback
   * listener, so the console keeps its manual-paste path for it.
   */
  readonly browserLoginFields: readonly OAuthLoginField[] = [
    {
      key: "idp",
      label: "Identity provider",
      required: true,
      defaultValue: "google",
      options: [
        { value: "google", label: "Google" },
        { value: "github", label: "GitHub" },
        { value: "builder-id", label: "AWS Builder ID" },
      ],
    },
  ];

  /**
   * Fields the device flow needs before it can start.
   *
   * The flow registers a client against one AWS SSO OIDC region and one
   * organization entry point, and neither can be inferred: the region decides
   * every URL the flow touches, and the start URL decides which portal the
   * operator approves in.
   */
  readonly deviceLoginFields: readonly OAuthLoginField[] = [
    {
      key: "authMethod",
      label: "Sign-in method",
      required: true,
      defaultValue: "builder-id",
      options: [
        { value: "builder-id", label: "AWS Builder ID (personal)" },
        { value: "idc", label: "IAM Identity Center (organization)" },
      ],
    },
    {
      key: "region",
      label: "AWS region",
      required: true,
      defaultValue: DEFAULT_REGION,
      placeholder: DEFAULT_REGION,
    },
    {
      key: "startUrl",
      label: "Organization start URL",
      defaultValue: KIRO_DEFAULT_START_URL,
      placeholder: KIRO_DEFAULT_START_URL,
    },
  ];

  /**
   * Fields the import flow needs.
   *
   * The same entry point accepts four credential families, so the operator
   * states which one the pasted material is; the region and — for Identity
   * Center — the client registration are the only other inputs the family
   * cannot carry by itself.
   */
  readonly importFields: readonly OAuthLoginField[] = [
    {
      key: "authMethod",
      label: "Credential type",
      required: true,
      defaultValue: "imported",
      options: [
        { value: "imported", label: "Refresh token (Kiro social session)" },
        { value: "idc", label: "Refresh token (IAM Identity Center)" },
        { value: "external_idp", label: "Enterprise IdP export (JSON)" },
        { value: "api_key", label: "API key" },
      ],
    },
    { key: "region", label: "AWS region", defaultValue: DEFAULT_REGION, placeholder: DEFAULT_REGION },
    { key: "clientId", label: "OIDC client id (Identity Center only)" },
    { key: "clientSecret", label: "OIDC client secret (Identity Center only)", secret: true },
    { key: "profileArn", label: "Profile ARN (optional)" },
  ];

  /**
   * Registers a client and starts device authorization.
   *
   * AWS SSO OIDC requires the registration first: the device authorization is
   * issued to a registered client, and the resulting client secret is needed
   * again at every later refresh. The registration is handed back to the console
   * as provider-private state rather than returned to the browser.
   */
  override async startDeviceAuth(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const parameters = context?.parameters ?? {};
    const region = normalizeRegion(parameters["region"]);
    const startUrl = nonEmptyTrimmedString(parameters["startUrl"]) ?? KIRO_DEFAULT_START_URL;
    const authMethod = parameters["authMethod"] === "idc" ? "idc" : "builder-id";
    assertAwsRegion(region);

    const registration = await this.#registerClient(region);
    const response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/device_authorization`, {
      method: "POST",
      headers: ssoOidcHeaders(),
      body: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        startUrl,
      }),
    });
    const payload = await readJsonResponse(response, "kiro device authorization");
    const raw = record(payload) ?? {};
    const deviceCode = nonEmptyString(raw["deviceCode"]);
    const userCode = nonEmptyString(raw["userCode"]);
    const verificationUri =
      nonEmptyString(raw["verificationUriComplete"]) ?? nonEmptyString(raw["verificationUri"]);
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw new Error("Kiro device authorization response omitted required fields");
    }
    const interval = Number(raw["interval"]);
    const expiresIn = Number(raw["expiresIn"]);
    return {
      verificationUri,
      userCode,
      deviceAuthId: deviceCode,
      intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 5,
      expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 900,
      // The console persists this and never returns it to the browser: it holds
      // the client secret the refresh will need.
      providerState: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        region,
        startUrl,
        authMethod,
      }),
    };
  }

  /** Polls the AWS SSO OIDC token endpoint for the device flow. */
  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const registration = parseRegistration(
      context?.providerState === undefined ? undefined : safeJson(context.providerState),
    );
    if (registration === undefined) {
      return { status: "failed", reason: "Kiro device flow is missing its client registration" };
    }
    const response = await this.fetchFn(`https://oidc.${registration.region}.amazonaws.com/token`, {
      method: "POST",
      headers: ssoOidcHeaders(),
      body: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        deviceCode: deviceAuthId,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    // The pending verdicts arrive as a non-2xx body, so the payload is read
    // without the helper that throws on a non-ok status — otherwise
    // `authorization_pending` would be lost and the flow reported as failed,
    // stopping the dashboard's poll while the operator is still authorizing.
    const payload = (await readJsonBody(response)) as OidcTokenResponse;
    const error = nonEmptyString(payload.error);
    // AWS reports its pending states in snake_case, matching RFC 8628.
    const verdict = devicePollBackoff(error, payload.interval);
    if (verdict !== undefined) return verdict;
    if (!response.ok) {
      return {
        status: "failed",
        reason: nonEmptyString(payload.error_description) ?? error ?? `token polling failed (${response.status})`,
      };
    }
    const access = nonEmptyString(payload.accessToken);
    if (access === undefined) {
      return {
        status: "failed",
        reason: nonEmptyString(payload.error_description) ?? "Kiro token response omitted accessToken",
      };
    }
    const refresh = nonEmptyString(payload.refreshToken) ?? "";
    // AWS SSO OIDC never reports the profile in its token response, and every
    // profile-scoped surface refuses a request without the field, so the account
    // resolves its own before the credential is persisted.
    const reported = nonEmptyString(payload.profileArn);
    const profileArn =
      reported ?? (await this.resolveProfileArn(access, registration.region, registration.authMethod));
    const authState: KiroAuthState = {
      authMethod: registration.authMethod,
      region: registration.region,
      ...(profileArn === undefined ? {} : { profileArn }),
      startUrl: registration.startUrl,
      clientId: registration.clientId,
      machineId: deriveOAuthMachineId(refresh),
    };
    const label = kiroAccountLabel(access);
    const result: OAuthExchangeResult = {
      access,
      refresh,
      expiresAt: this.#expiry(payload.expiresIn),
      ...(label === undefined ? {} : { accountLabel: label }),
      auth_state: authStateOf(authState),
      client_secret: registration.clientSecret,
    };
    return { status: "complete", result };
  }

  /**
   * Builds the social sign-in URL.
   *
   * The vendor selects the identity provider with an `idp` query parameter
   * rather than a client id, and allowlists a custom-scheme redirect, so the
   * operator completes consent in a browser and pastes the resulting URL back —
   * there is no loopback listener to register.
   */
  async prepareAuthorize(request: OAuthAuthorizeRequest): Promise<OAuthAuthorizeRequest> {
    if (readAuthorizeIdp(request) !== "builder-id") return request;
    const region = normalizeRegion((request.parameters?.["region"] as string | undefined) ?? DEFAULT_REGION);
    assertAwsRegion(region);
    const redirectUri = builderIdLoopbackRedirect(request.redirectUri);
    const registration = await this.#registerBrowserClient(region, redirectUri);
    return {
      ...request,
      redirectUri,
      parameters: {
        ...(request.parameters ?? {}),
        idp: "builder-id",
        region,
        startUrl: KIRO_BUILDER_ID_ISSUER,
        builderIdClientId: registration.clientId,
        builderIdClientSecret: registration.clientSecret,
      },
    };
  }

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    if (readAuthorizeIdp(request) === "builder-id") return this.#buildBuilderIdAuthorizeUrl(request);
    return this.#buildSocialAuthorizeUrl(request);
  }

  #buildSocialAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const idp = readAuthorizeIdp(request);
    const params = new URLSearchParams({
      idp: idp === "github" ? "Github" : "Google",
      redirect_uri: KIRO_SOCIAL_REDIRECT_URI,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      state: request.state,
      prompt: "select_account",
    });
    return `${KIRO_AUTH_SERVICE}/login?${params.toString()}`;
  }

  #buildBuilderIdAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const parameters = request.parameters ?? {};
    const clientId = nonEmptyTrimmedString(parameters["builderIdClientId"] as string | undefined);
    if (clientId === undefined) throw new Error("Kiro Builder ID authorize is missing its client registration");
    const region = assertAwsRegion(normalizeRegion(parameters["region"] as string | undefined));
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: request.redirectUri,
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
    });
    for (const scope of KIRO_SCOPES) query.append("scope", scope);
    return `https://oidc.${region}.amazonaws.com/authorize?${query.toString()}`;
  }

  /**
   * Exchanges the pasted social authorization code.
   *
   * The vendor's endpoint takes a JSON body and compares `redirect_uri` against
   * the custom scheme the authorize step advertised.
   */
  override async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    _state?: string,
    context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult> {
    if (readExchangeIdp(context) === "builder-id") return this.#exchangeBuilderIdCode(code, codeVerifier, redirectUri, context);
    return this.exchangeSocialCode(code, codeVerifier);
  }

  /** Exchanges a social authorization code for tokens. */
  async exchangeSocialCode(code: string, codeVerifier: string): Promise<OAuthExchangeResult> {
    const response = await this.fetchFn(`${KIRO_AUTH_SERVICE}/oauth/token`, {
      method: "POST",
      headers: socialServiceHeaders(),
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: KIRO_SOCIAL_REDIRECT_URI,
      }),
    });
    const payload = await readJsonResponse(response, "kiro social token exchange");
    const raw = record(payload) ?? {};
    const access = nonEmptyString(raw["accessToken"]);
    if (access === undefined) {
      const detail = nonEmptyString(raw["error_description"]) ?? nonEmptyString(raw["error"]);
      throw new Error(`Kiro token exchange omitted accessToken${detail === undefined ? "" : `: ${detail}`}`);
    }
    const refresh = nonEmptyString(raw["refreshToken"]) ?? "";
    const profileArn = nonEmptyString(raw["profileArn"]);
    const authState: KiroAuthState = {
      authMethod: "google",
      region: DEFAULT_REGION,
      ...(profileArn === undefined ? {} : { profileArn }),
      machineId: deriveOAuthMachineId(refresh),
    };
    const label = kiroAccountLabel(access);
    return {
      access,
      refresh,
      expiresAt: this.#expiry(raw["expiresIn"]),
      ...(label === undefined ? {} : { accountLabel: label }),
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Completes a login from pasted credential material.
   *
   * One entry point for the four families that cannot be reached by a redirect
   * or a device code, because the operator already holds the material:
   *
   *  * a Kiro social refresh token;
   *  * an Identity Center refresh token, which needs the client registration
   *    that issued it;
   *  * an enterprise IdP export, which carries its own endpoint and scopes;
   *  * a raw API key.
   *
   * Every family is validated against the upstream before it is returned, so an
   * import cannot persist material that never worked — a dead refresh token is
   * rejected by the refresh it triggers, and an API key by the catalog it reads.
   * The console then persists what this returns without further inspection.
   */
  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const authMethod = nonEmptyTrimmedString(input.fields["authMethod"]) ?? "imported";
    const credential = input.credential.trim();
    if (credential.length === 0) throw new Error("Kiro credential material is required");
    switch (authMethod) {
      case "api_key":
        return this.validateApiKey(credential, input.fields["region"] ?? DEFAULT_REGION);
      case "external_idp":
        return this.importExternalIdp(credential);
      case "idc":
        return this.importRefreshToken(credential, {
          clientId: nonEmptyTrimmedString(input.fields["clientId"]),
          clientSecret: nonEmptyTrimmedString(input.fields["clientSecret"]),
          region: input.fields["region"],
          profileArn: nonEmptyTrimmedString(input.fields["profileArn"]),
        });
      case "imported":
        return this.importRefreshToken(credential, {
          region: input.fields["region"],
          profileArn: nonEmptyTrimmedString(input.fields["profileArn"]),
        });
      default:
        throw new Error(`Unsupported Kiro credential type: ${authMethod}`);
    }
  }

  /**
   * Imports a refresh token pasted from an existing Kiro session.
   *
   * The token is validated by actually refreshing it, so an import cannot
   * persist a credential that was already dead. Identity Center tokens carry
   * client credentials that the refresh needs; the other families refresh
   * against the vendor service.
   */
  async importRefreshToken(
    refreshToken: string,
    options: {
      readonly clientId?: string | undefined;
      readonly clientSecret?: string | undefined;
      readonly region?: string | undefined;
      readonly profileArn?: string | undefined;
      readonly machineId?: string | undefined;
    },
  ): Promise<OAuthExchangeResult> {
    const trimmed = refreshToken.trim();
    if (trimmed.length === 0) throw new Error("refresh token is required");
    const isIdc = options.clientId !== undefined && options.clientSecret !== undefined;
    const region = normalizeRegion(options.region);
    const refreshed = isIdc
      ? await this.#refreshOidc(trimmed, {
          clientId: options.clientId ?? "",
          clientSecret: options.clientSecret ?? "",
          region,
          startUrl: KIRO_DEFAULT_START_URL,
          authMethod: "idc",
        })
      : await this.#refreshSocial(trimmed, undefined, normalizeMachineId(options.machineId));
    // An Identity Center refresh answers from the OIDC token endpoint, which does
    // not report a profile; the social service does. An operator-supplied ARN
    // wins over both, because it is the one value that was stated rather than
    // inferred.
    const reported =
      refreshed.profileArn ??
      (isIdc ? await this.resolveProfileArn(refreshed.access, region, "idc") : undefined);
    const profileArn = options.profileArn ?? reported;
    const authState: KiroAuthState = {
      authMethod: isIdc ? "idc" : "imported",
      region,
      ...(profileArn === undefined ? {} : { profileArn }),
      machineId: deriveOAuthMachineId(refreshed.refresh),
    };
    const label = kiroAccountLabel(refreshed.access);
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      ...(label === undefined ? {} : { accountLabel: label }),
      auth_state: authStateOf(authState),
      ...(isIdc ? { client_secret: options.clientSecret } : {}),
    };
  }

  /**
   * Imports an enterprise identity-provider credential from exported JSON.
   *
   * Every field is required and the token endpoint is restricted to the
   * Microsoft login hosts, because the refresh posts the account's refresh token
   * to whatever endpoint the JSON names.
   */
  importExternalIdp(rawAuth: unknown): OAuthExchangeResult {
    let input = rawAuth;
    if (typeof input === "string") {
      const parsed = safeJson(input);
      if (parsed === undefined) throw new Error("CLIProxyAPI auth JSON is invalid");
      input = parsed;
    }
    const raw = record(input);
    if (raw === undefined) throw new Error("CLIProxyAPI auth JSON is required");
    const authMethod = nonEmptyTrimmedString(raw["auth_method"] ?? raw["authMethod"]);
    if (authMethod !== undefined && authMethod !== "external_idp") {
      throw new Error("Only external_idp Kiro auth is supported by this importer");
    }
    const access = nonEmptyTrimmedString(raw["access_token"] ?? raw["accessToken"]);
    const refresh = nonEmptyTrimmedString(raw["refresh_token"] ?? raw["refreshToken"]);
    const clientId = nonEmptyTrimmedString(raw["client_id"] ?? raw["clientId"]);
    const tokenEndpoint = validateMicrosoftTokenEndpoint(raw["token_endpoint"] ?? raw["tokenEndpoint"]);
    const profileArn = nonEmptyTrimmedString(raw["profile_arn"] ?? raw["profileArn"]);
    const region = normalizeRegion(raw["region"]);
    const scope = normalizeScope(raw["scopes"] ?? raw["scope"]);
    if (access === undefined) throw new Error("access_token is required");
    if (refresh === undefined) throw new Error("refresh_token is required");
    if (clientId === undefined) throw new Error("client_id is required");
    if (scope.length === 0) throw new Error("scopes is required");
    if (profileArn === undefined) throw new Error("profile_arn is required");
    const authState: KiroAuthState = {
      authMethod: "external_idp",
      region,
      profileArn,
      clientId,
      tokenEndpoint,
      scope,
      machineId: deriveOAuthMachineId(refresh),
    };
    const expiresAt = readExpiry(raw) ?? this.#expiry(undefined);
    const label = kiroAccountLabel(access);
    return {
      access,
      refresh,
      expiresAt,
      ...(label === undefined ? {} : { accountLabel: label }),
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Validates an API key against the surface it will actually be used on.
   *
   * A bearer-only profile lookup answers 200 with an empty list for an
   * arbitrary key, so it proves nothing; the model catalog is the surface that
   * inference uses and it answers with the models the key can reach.
   */
  async validateApiKey(apiKey: string, region = DEFAULT_REGION): Promise<OAuthExchangeResult> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error("API key is required");
    const safeRegion = assertAwsRegion(normalizeRegion(region));
    const version = getKiroVersion();
    const machineId = deriveApiKeyMachineId(trimmed);
    const response = await this.fetchFn(
      `https://q.${safeRegion}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR`,
      {
        headers: {
          authorization: `Bearer ${trimmed}`,
          tokentype: "API_KEY",
          accept: "application/json",
          connection: "close",
          "amz-sdk-request": "attempt=1; max=1",
          "amz-sdk-invocation-id": crypto.randomUUID(),
          "x-amzn-kiro-agent-mode": "vibe",
          "x-amzn-codewhisperer-optout": "true",
          "user-agent": buildKiroUserAgent(version, machineId),
          "x-amz-user-agent": buildKiroAmzUserAgent(version, machineId),
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`API key validation failed (${response.status})`);
    const payload = record(await response.json().catch(() => undefined));
    const models = payload?.["models"];
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("API key returned no available models");
    }
    const authState: KiroAuthState = {
      authMethod: "api_key",
      region: safeRegion,
      machineId,
    };
    return {
      access: trimmed,
      refresh: "",
      // An API key has no expiry; a far-future value keeps the refresh path,
      // which needs a refresh token anyway, from ever selecting it.
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Resolves the profile ARN an account is bound to.
   *
   * Profile-scoped surfaces refuse a request that omits the field (`400
   * profileArn is required for this request.`), and an Identity Center account
   * whose token response carried no profile needs its own resolved before it is
   * persisted. `ListAvailableProfiles` is that lookup: an awsJson operation on
   * the CodeWhisperer service entry, reached by POST with an `x-amz-target`
   * header. The generation host carries no equivalent, and an unqualified
   * request to it is answered `UnknownOperationException`.
   *
   * A Builder ID account is skipped rather than asked: the operation refuses
   * that family outright (`403 AWS Builder ID is not supported for this
   * operation.`), and a login path is no place to spend a request that is known
   * to be refused. Such an account is served by its family's public default.
   *
   * Returns `undefined` rather than throwing. Resolution runs on the login path,
   * and an account whose profile cannot be read still has to be persisted — the
   * operator can supply the ARN by import, and a failure here must not block a
   * sign-in that otherwise succeeded.
   */
  async resolveProfileArn(
    accessToken: string,
    region = DEFAULT_REGION,
    authMethod?: KiroAuthMethod,
  ): Promise<string | undefined> {
    if (authMethod === "builder-id") return undefined;
    const safeRegion = assertAwsRegion(normalizeRegion(region));
    try {
      const response = await this.fetchFn(`https://codewhisperer.${safeRegion}.amazonaws.com/`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
          accept: "application/json",
          connection: "close",
          "amz-sdk-request": "attempt=1; max=1",
          "amz-sdk-invocation-id": crypto.randomUUID(),
        },
        body: JSON.stringify({ maxResults: 10 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return undefined;
      const payload = record(await response.json().catch(() => undefined));
      const profiles = payload?.["profiles"];
      if (!Array.isArray(profiles)) return undefined;
      // Prefer the profile minted in the region the account authenticates
      // against, and keep the first usable ARN as the fallback so an account
      // with several profiles still resolves to one of its own.
      let fallback: string | undefined;
      for (const entry of profiles) {
        const profile = record(entry);
        const arn = nonEmptyTrimmedString(profile?.["arn"] ?? profile?.["profileArn"]);
        if (arn === undefined) continue;
        if (arn.includes(`:${safeRegion}:`)) return arn;
        fallback ??= arn;
      }
      return fallback;
    } catch {
      return undefined;
    }
  }

  /**
   * Refreshes an account's access token.
   *
   * Four paths, chosen from the account's own configuration rather than the
   * refresh token's shape: an enterprise provider, an OIDC client registration,
   * the vendor's social service, and an imported social token (which refreshes
   * through the same service).
   */
  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: OAuthRefreshContext,
  ): Promise<OAuthTokenRefreshResult> {
    const authState = parseKiroAuthState(context?.auth_state);
    if (authState?.authMethod === "external_idp") {
      const tokenEndpoint = validateMicrosoftTokenEndpoint(authState.tokenEndpoint);
      const clientId = authState.clientId;
      const scope = authState.scope;
      if (clientId === undefined || scope === undefined) {
        throw new Error("Kiro enterprise refresh is missing its client configuration");
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
        scope,
      });
      const response = await this.fetchFn(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      const payload = record(await readJsonResponse(response, "kiro enterprise token refresh")) ?? {};
      const access = nonEmptyString(payload["access_token"]);
      if (access === undefined) throw new Error("Kiro enterprise refresh omitted access_token");
      return {
        access,
        ...(nonEmptyString(payload["refresh_token"]) === undefined
          ? {}
          : { refresh: String(payload["refresh_token"]) }),
        expiresAt: this.#expiry(payload["expires_in"]),
      };
    }

    if (authState?.authMethod === "idc" || authState?.authMethod === "builder-id") {
      const clientId = authState.clientId;
      const clientSecret = context?.client_secret;
      if (clientId === undefined || clientSecret === undefined) {
        throw new Error("Kiro device-flow refresh is missing its client registration");
      }
      const refreshed = await this.#refreshOidc(
        refreshToken,
        {
          clientId,
          clientSecret,
          region: authState.region,
          startUrl: authState.startUrl ?? KIRO_DEFAULT_START_URL,
          authMethod: authState.authMethod,
        },
        signal,
      );
      const profileArn = refreshed.profileArn ?? authState.profileArn;
      return {
        access: refreshed.access,
        refresh: refreshed.refresh,
        expiresAt: refreshed.expiresAt,
        // The frozen device identity is carried forward, never re-derived: a
        // refresh rotates the refresh token, so deriving here would move the
        // account to a new device on every refresh.
        auth_state: authStateOf({
          ...authState,
          ...(profileArn === undefined ? {} : { profileArn }),
        }),
      };
    }

    const refreshed = await this.#refreshSocial(refreshToken, signal, authState?.machineId);
    const profileArn = refreshed.profileArn ?? authState?.profileArn;
    const nextState: KiroAuthState | undefined =
      authState === undefined
        ? undefined
        : { ...authState, ...(profileArn === undefined ? {} : { profileArn }) };
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      ...(nextState === undefined ? {} : { auth_state: authStateOf(nextState) }),
    };
  }

  /**
   * Registers an OIDC client for the device flow.
   *
   * `clientName` and `User-Agent` identify this as the vendor's own IDE client.
   * The registration is the first request a brand-new account ever makes, so it
   * is the one most likely to be looked at: a client name no shipped build uses,
   * or a missing User-Agent, is a shape the real client never produces.
   *
   * `issuerUrl` is deliberately absent. The device flow starts from an AWS
   * Builder ID portal, which has no organization issuer; naming one — and
   * especially naming an Identity Center instance that belongs to someone else —
   * declares an organization the account is not part of.
   */
  async #registerBrowserClient(region: string, redirectUri: string): Promise<{ readonly clientId: string; readonly clientSecret: string }> {
    const response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/client/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": buildKiroSsoUserAgent(),
        "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
        "amz-sdk-request": "attempt=1; max=4",
        "amz-sdk-invocation-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        clientName: KIRO_OIDC_CLIENT_NAME,
        clientType: "public",
        scopes: [...KIRO_SCOPES],
        grantTypes: [...KIRO_BROWSER_GRANT_TYPES],
        issuerUrl: KIRO_BUILDER_ID_ISSUER,
        redirectUris: [redirectUri],
      }),
    });
    const payload = await readJsonResponse(response, "kiro browser client registration") as Record<string, unknown>;
    const clientId = nonEmptyString(payload["clientId"] as string);
    const clientSecret = nonEmptyString(payload["clientSecret"] as string);
    if (clientId === undefined || clientSecret === undefined) throw new Error("Kiro browser client registration omitted credentials");
    return { clientId, clientSecret };
  }

  async #exchangeBuilderIdCode(code: string, codeVerifier: string, redirectUri: string, context: OAuthCodeExchangeContext | undefined): Promise<OAuthExchangeResult> {
    const parameters = context?.parameters ?? {};
    const clientId = nonEmptyTrimmedString(parameters["builderIdClientId"] as string | undefined);
    const clientSecret = nonEmptyTrimmedString(parameters["builderIdClientSecret"] as string | undefined);
    if (clientId === undefined || clientSecret === undefined) throw new Error("Kiro Builder ID exchange is missing its client registration");
    const region = assertAwsRegion(normalizeRegion(parameters["region"] as string | undefined));
    const response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": buildKiroSsoUserAgent() },
      body: JSON.stringify({ clientId, clientSecret, grantType: "authorization_code", code, redirectUri, codeVerifier }),
    });
    const payload = await readJsonResponse(response, "kiro Builder ID token exchange") as Record<string, unknown>;
    const access = nonEmptyString(payload["accessToken"] as string);
    if (access === undefined) {
      const detail = nonEmptyString(payload["error_description"] as string) ?? nonEmptyString(payload["error"] as string);
      throw new Error(`Kiro Builder ID token exchange omitted accessToken${detail === undefined ? "" : `: ${detail}`}`);
    }
    const refresh = nonEmptyString(payload["refreshToken"] as string) ?? "";
    const profileArn = nonEmptyString(payload["profileArn"] as string);
    const authState: KiroAuthState = { authMethod: "builder-id", region, startUrl: KIRO_BUILDER_ID_ISSUER, clientId, ...(profileArn === undefined ? {} : { profileArn }), machineId: deriveOAuthMachineId(refresh) };
    const label = kiroAccountLabel(access);
    return { access, refresh, expiresAt: this.#expiry(payload["expiresIn"]), ...(label === undefined ? {} : { accountLabel: label }), auth_state: authStateOf(authState), client_secret: clientSecret };
  }

  async #registerClient(region: string): Promise<{ readonly clientId: string; readonly clientSecret: string }> {
    const response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/client/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": buildKiroSsoUserAgent(),
        "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
        "amz-sdk-request": "attempt=1; max=4",
        "amz-sdk-invocation-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        clientName: KIRO_OIDC_CLIENT_NAME,
        clientType: "public",
        scopes: [...KIRO_SCOPES],
        grantTypes: [...KIRO_GRANT_TYPES],
      }),
    });
    const payload = record(await readJsonResponse(response, "kiro client registration")) ?? {};
    const clientId = nonEmptyString(payload["clientId"]);
    const clientSecret = nonEmptyString(payload["clientSecret"]);
    if (clientId === undefined || clientSecret === undefined) {
      throw new Error("Kiro client registration omitted credentials");
    }
    return { clientId, clientSecret };
  }

  /** Refreshes through the regional AWS SSO OIDC token endpoint. */
  async #refreshOidc(
    refreshToken: string,
    registration: DeviceFlowRegistration,
    signal?: AbortSignal,
  ): Promise<{ readonly access: string; readonly refresh: string; readonly expiresAt: Date; readonly profileArn?: string }> {
    const region = assertAwsRegion(registration.region);
    const response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": buildKiroSsoUserAgent(),
        "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
        "amz-sdk-request": "attempt=1; max=4",
        "amz-sdk-invocation-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        refreshToken,
        grantType: "refresh_token",
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = record(await readJsonResponse(response, "kiro token refresh")) ?? {};
    const access = nonEmptyString(payload["accessToken"]);
    if (access === undefined) throw new Error("Kiro token refresh omitted accessToken");
    const profileArn = nonEmptyString(payload["profileArn"]);
    return {
      access,
      refresh: nonEmptyString(payload["refreshToken"]) ?? refreshToken,
      expiresAt: this.#expiry(payload["expiresIn"]),
      ...(profileArn === undefined ? {} : { profileArn }),
    };
  }

  /** Refreshes through the vendor's social token service. */
  async #refreshSocial(
    refreshToken: string,
    signal?: AbortSignal,
    machineId?: string,
  ): Promise<{ readonly access: string; readonly refresh: string; readonly expiresAt: Date; readonly profileArn?: string }> {
    const response = await this.fetchFn(`${KIRO_AUTH_SERVICE}/refreshToken`, {
      method: "POST",
      headers: socialServiceHeaders(machineId),
      body: JSON.stringify({ refreshToken }),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = record(await readJsonResponse(response, "kiro token refresh")) ?? {};
    const access = nonEmptyString(payload["accessToken"]);
    if (access === undefined) throw new Error("Kiro token refresh omitted accessToken");
    const profileArn = nonEmptyString(payload["profileArn"]);
    return {
      access,
      refresh: nonEmptyString(payload["refreshToken"]) ?? refreshToken,
      expiresAt: this.#expiry(payload["expiresIn"]),
      ...(profileArn === undefined ? {} : { profileArn }),
    };
  }

  #expiry(expiresIn: unknown): Date {
    return this.calculateExpiry(expiresIn);
  }
}

/** Parses JSON without throwing. */
function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads a JSON body regardless of status.
 *
 * The device-token endpoint reports "still waiting" and "slow down" as non-2xx
 * bodies, so a helper that throws on a non-ok status would discard the verdict
 * the poll needs. An unparseable body yields `{}` rather than throwing, because
 * the caller decides what a missing field means.
 */
async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) return {};
  const parsed = safeJson(text);
  return record(parsed) ?? {};
}

/** Normalizes a scope list or space-delimited string. */
function normalizeScope(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .join(" ");
  }
  return typeof value === "string" ? value.trim() : "";
}

/** Reads an absolute or relative expiry out of imported JSON. */
function readExpiry(raw: Record<string, unknown>): Date | undefined {
  const explicit = raw["expired"] ?? raw["expires_at"] ?? raw["expiresAt"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    const ms = new Date(explicit).getTime();
    if (Number.isFinite(ms)) return new Date(ms);
  }
  const expiresIn = Number(raw["expires_in"] ?? raw["expiresIn"] ?? 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return new Date(Date.now() + expiresIn * 1000);
  return undefined;
}

/**
 * Chooses the identity provider a social sign-in starts with.
 *
 * The vendor selects the provider by name rather than by client id, and the
 * console passes the operator's choice through the start parameters.
 */
function readAuthorizeIdp(request: OAuthAuthorizeRequest): "google" | "github" | "builder-id" {
  const idp = request.parameters?.["idp"] ?? request.parameters?.["provider"];
  if (idp === "builder-id") return "builder-id";
  return idp === "github" ? "github" : "google";
}

function readExchangeIdp(context: OAuthCodeExchangeContext | undefined): "builder-id" | "social" {
  return context?.parameters?.["idp"] === "builder-id" ? "builder-id" : "social";
}

function builderIdLoopbackRedirect(redirectUri: string): string {
  const url = new URL(redirectUri);
  const port = url.port.length > 0 ? url.port : "80";
  return `http://127.0.0.1:${port}`;
}

export const kiroOAuthClient = new KiroOAuthClient();
