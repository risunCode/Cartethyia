import { TokenKeeperError, type OAuthCredentialBundle } from "./types";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_START_URL = "https://view.awsapps.com/start";
const SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"];
const ISSUER = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6";

type JsonObject = Record<string, unknown>;
async function jsonRequest(url: string, body: JsonObject): Promise<JsonObject> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!response.ok) throw new TokenKeeperError("oauth_upstream", `Kiro OAuth returned ${response.status}.`, response.status, response.status >= 500);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TokenKeeperError("oauth_upstream", "Kiro OAuth returned invalid JSON.", 502, true);
  return parsed as JsonObject;
}

export interface KiroDeviceRegistration { clientId: string; clientSecret: string; region: string; }
export async function registerKiroClient(region = DEFAULT_REGION): Promise<KiroDeviceRegistration> {
  const normalized = region.trim().toLowerCase() || DEFAULT_REGION;
  const result = await jsonRequest(`https://oidc.${normalized}.amazonaws.com/client/register`, {
    clientName: "kiro-oauth-client", clientType: "public", scopes: SCOPES,
    grantTypes: ["device_code", "refresh_token"], issuerUrl: ISSUER,
  });
  const clientId = typeof result.clientId === "string" ? result.clientId : typeof result.client_id === "string" ? result.client_id : "";
  const clientSecret = typeof result.clientSecret === "string" ? result.clientSecret : typeof result.client_secret === "string" ? result.client_secret : "";
  if (!clientId || !clientSecret) throw new TokenKeeperError("oauth_upstream", "Kiro did not return an OAuth client.", 502, true);
  return { clientId, clientSecret, region: normalized };
}

export interface KiroDeviceAuthorization { deviceCode: string; userCode: string; verificationUri: string; intervalSeconds: number; expiresIn: number; }
export async function startKiroDeviceAuthorization(client: KiroDeviceRegistration, startUrl = DEFAULT_START_URL): Promise<KiroDeviceAuthorization> {
  const result = await jsonRequest(`https://oidc.${client.region}.amazonaws.com/device_authorization`, { clientId: client.clientId, clientSecret: client.clientSecret, startUrl });
  const deviceCode = typeof result.deviceCode === "string" ? result.deviceCode : typeof result.device_code === "string" ? result.device_code : "";
  const userCode = typeof result.userCode === "string" ? result.userCode : typeof result.user_code === "string" ? result.user_code : "";
  const verificationUri = typeof result.verificationUriComplete === "string" ? result.verificationUriComplete : typeof result.verification_uri_complete === "string" ? result.verification_uri_complete : typeof result.verificationUri === "string" ? result.verificationUri : startUrl;
  if (!deviceCode || !userCode) throw new TokenKeeperError("oauth_upstream", "Kiro did not return a device code.", 502, true);
  return { deviceCode, userCode, verificationUri, intervalSeconds: Number(result.interval ?? 5), expiresIn: Number(result.expiresIn ?? result.expires_in ?? 600) };
}

export type KiroDevicePollResult = { status: "pending" } | { status: "completed"; bundle: OAuthCredentialBundle };
export async function pollKiroDeviceToken(client: KiroDeviceRegistration, deviceCode: string): Promise<KiroDevicePollResult> {
  const response = await fetch(`https://oidc.${client.region}.amazonaws.com/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, deviceCode, grantType: "urn:ietf:params:oauth:grant-type:device_code" }) });
  const text = await response.text();
  let value: unknown; try { value = text ? JSON.parse(text) : {}; } catch { value = {}; }
  const result = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
  if (!response.ok) {
    const error = typeof result.error === "string" ? result.error : "";
    if (response.status === 400 && (error === "authorization_pending" || error === "slow_down" || !error)) return { status: "pending" };
    throw new TokenKeeperError("oauth_upstream", `Kiro device authorization failed (${response.status}).`, response.status, false);
  }
  const refreshToken = typeof result.refreshToken === "string" ? result.refreshToken : typeof result.refresh_token === "string" ? result.refresh_token : "";
  const accessToken = typeof result.accessToken === "string" ? result.accessToken : typeof result.access_token === "string" ? result.access_token : "";
  if (!refreshToken || !accessToken) return { status: "pending" };
  const expiresIn = Number(result.expiresIn ?? result.expires_in ?? 3600);
  return { status: "completed", bundle: makeKiroBundle(refreshToken, accessToken, expiresIn, client) };
}

export async function refreshKiroToken(refreshToken: string, metadata: Pick<OAuthCredentialBundle, "clientId" | "clientSecret" | "region"> = {}): Promise<OAuthCredentialBundle> {
  let result: JsonObject;
  if (metadata.clientId && metadata.clientSecret) {
    result = await jsonRequest(`https://oidc.${metadata.region ?? DEFAULT_REGION}.amazonaws.com/token`, { clientId: metadata.clientId, clientSecret: metadata.clientSecret, refreshToken, grantType: "refresh_token" });
  } else {
    result = await jsonRequest("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", { refreshToken });
  }
  const accessToken = typeof result.accessToken === "string" ? result.accessToken : typeof result.access_token === "string" ? result.access_token : "";
  if (!accessToken) throw new TokenKeeperError("oauth_upstream", "Kiro refresh did not return an access token.", 401, false);
  const expiresIn = Number(result.expiresIn ?? result.expires_in ?? 3600);
  return makeKiroBundle(refreshToken, accessToken, expiresIn, metadata);
}

export type KiroBundle = OAuthCredentialBundle;

export function makeKiroBundle(refreshToken: string, accessToken: string, expiresIn: number, metadata: Partial<OAuthCredentialBundle> = {}): KiroBundle {
  return { version: 1, provider: "kiro", refreshToken, accessToken, accessExpiresAt: Date.now() + Math.max(60, expiresIn) * 1000, accountId: metadata.accountId, email: metadata.email, profileArn: metadata.profileArn, authMethod: metadata.authMethod, region: metadata.region, clientId: metadata.clientId, clientSecret: metadata.clientSecret, authorizedAt: Date.now(), updatedAt: Date.now() };
}
