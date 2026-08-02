import type { OAuthCredentialBundle, OAuthProviderId } from "./types";
import { TokenKeeperError as KeeperError } from "./types";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CALLBACK_URL = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_ORIGINATOR = "pi";

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-594dd1962f5e";
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const ANTHROPIC_BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const ANTHROPIC_CALLBACK_URL = "http://localhost:54545/callback";
const ANTHROPIC_SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLINE_AUTHORIZE_URL = "https://api.cline.bot/api/v1/auth/authorize";
const CLINE_TOKEN_URL = "https://api.cline.bot/api/v1/auth/token";
const CLINE_REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";
const CLINE_CALLBACK_URL = "http://localhost:1456/callback";
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
const GROK_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const GROK_CALLBACK_URL = "http://127.0.0.1:56121/callback";
const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const GROK_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const GROK_CLI_USER_AGENT = "grok-shell/0.2.99 (linux; x86_64)";
const ANTIGRAVITY_CLIENT_ID = Buffer.from("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==", "base64").toString("utf8");
const ANTIGRAVITY_CLIENT_SECRET = Buffer.from("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8");

function antigravityClientCredentials(): { clientId: string; clientSecret: string } {
  return { clientId: ANTIGRAVITY_CLIENT_ID, clientSecret: ANTIGRAVITY_CLIENT_SECRET };
}
const ANTIGRAVITY_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_CALLBACK_URL = "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_CLOUD_CODE_URL = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SCOPE = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
const TOKEN_TIMEOUT_MS = 30_000;
const REFRESH_SKEW_MS = 5 * 60_000;

interface OAuthTokenResult {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  email?: string;
  planType?: string;
  projectId?: string;
  userId?: string;
}

interface CodexJwtPayload {
  [key: string]: unknown;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new KeeperError("validation", "OAuth response was not an object.", 502);
  return value as Record<string, unknown>;
}

function parseTokenExpiry(expiresIn: unknown, provider: OAuthProviderId): number {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new KeeperError("validation", `${provider} OAuth response is missing expires_in.`, 502);
  }
  return Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS;
}

function decodeJwtPayload(token: string): CodexJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as CodexJwtPayload : null;
  } catch {
    return null;
  }
}

function makeAuthorizationUrl(provider: OAuthProviderId, state: string, redirectUri: string, challenge: string): string {
  if (provider === "cline") {
    const params = new URLSearchParams({ client_type: "extension", callback_url: redirectUri, redirect_uri: redirectUri, state });
    return `${CLINE_AUTHORIZE_URL}?${params.toString()}`;
  }
  if (provider === "grok-cli") {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: GROK_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: GROK_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce: crypto.randomUUID(),
      plan: "generic",
    });
    return `${GROK_AUTHORIZE_URL}?${params.toString()}`;
  }
  if (provider === "google-antigravity") {
    const { clientId } = antigravityClientCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: ANTIGRAVITY_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`;
  }
  if (provider === "openai-codex") {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CODEX_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: CODEX_ORIGINATOR,
    });
    return `${CODEX_AUTHORIZE_URL}?${params.toString()}`;
  }

  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ANTHROPIC_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`;
}

export function callbackUriFor(provider: OAuthProviderId): string {
  if (provider === "openai-codex") return CODEX_CALLBACK_URL;
  if (provider === "anthropic-oauth") return ANTHROPIC_CALLBACK_URL;
  if (provider === "grok-cli") return GROK_CALLBACK_URL;
  if (provider === "google-antigravity") return ANTIGRAVITY_CALLBACK_URL;
  return CLINE_CALLBACK_URL;
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  const verifier = Buffer.from(bytes).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export function createLoginAuthorization(provider: OAuthProviderId, state: string, redirectUri: string, challenge: string): { url: string; instructions: string } {
  return {
    url: makeAuthorizationUrl(provider, state, redirectUri, challenge),
    instructions: "Open the authorization URL, complete OAuth in your browser, then return to Cartethyia. If the callback cannot reach this runtime, paste the final redirect URL into the completion field.",
  };
}

async function readResponseBody(response: Response, provider: OAuthProviderId, operation: string): Promise<string> {
  const body = await response.text();
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new KeeperError(`${operation}-http`, `${provider} OAuth ${operation} failed with HTTP ${response.status}.`, response.status, retryable);
  }
  return body;
}

async function postJson(url: string, body: Record<string, string>, provider: OAuthProviderId, operation: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new KeeperError("timeout", `${provider} OAuth ${operation} timed out.`, 502, true);
  }
  const text = await readResponseBody(response, provider, operation);
  try {
    return parseJsonRecord(JSON.parse(text) as unknown);
  } catch {
    throw new KeeperError("malformed-response", `${provider} OAuth ${operation} returned invalid JSON.`, 502);
  }
}

async function postForm(url: string, body: Record<string, string>, provider: OAuthProviderId, operation: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new KeeperError("timeout", `${provider} OAuth ${operation} timed out.`, 502, true);
  }
  const text = await readResponseBody(response, provider, operation);
  try {
    return parseJsonRecord(JSON.parse(text) as unknown);
  } catch {
    throw new KeeperError("malformed-response", `${provider} OAuth ${operation} returned invalid JSON.`, 502);
  }
}

function tokenFields(data: Record<string, unknown>, provider: OAuthProviderId, operation: string, requireRefresh = true): { access: string; refresh: string | undefined; expiresAt: number } {
  const access = nonEmpty(data.access_token);
  const refresh = nonEmpty(data.refresh_token);
  if (!access || (requireRefresh && !refresh)) throw new KeeperError("validation", `${provider} OAuth ${operation} response is missing token fields.`, 502);
  return { access, refresh, expiresAt: parseTokenExpiry(data.expires_in, provider) };
}

function codexIdentity(data: Record<string, unknown>, accessToken: string, idToken: string | undefined): Pick<OAuthTokenResult, "accountId" | "email" | "planType"> {
  const accessPayload = decodeJwtPayload(accessToken);
  const idPayload = idToken ? decodeJwtPayload(idToken) : null;
  const authPath = "https://api.openai.com/auth";
  const profilePath = "https://api.openai.com/profile";
  const accessAuth = accessPayload?.[authPath];
  const idAuth = idPayload?.[authPath];
  const profile = accessPayload?.[profilePath];
  const accountId = typeof accessAuth === "object" && accessAuth !== null ? nonEmpty((accessAuth as Record<string, unknown>).chatgpt_account_id) : undefined;
  const email = typeof profile === "object" && profile !== null ? nonEmpty((profile as Record<string, unknown>).email) : undefined;
  const planType = typeof accessAuth === "object" && accessAuth !== null
    ? nonEmpty((accessAuth as Record<string, unknown>).chatgpt_plan_type)
    : undefined;
  const idPlan = typeof idAuth === "object" && idAuth !== null ? nonEmpty((idAuth as Record<string, unknown>).chatgpt_plan_type) : undefined;
  const fallbackAccount = nonEmpty(data.account_id);
  return { accountId: accountId ?? fallbackAccount, email, planType: planType ?? idPlan };
}

async function exchangeCodex(code: string, verifier: string, redirectUri: string): Promise<OAuthTokenResult> {
  const data = await postForm(CODEX_TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: CODEX_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, "openai-codex", "token exchange");
  const fields = tokenFields(data, "openai-codex", "token exchange");
  if (!fields.refresh) throw new KeeperError("validation", "openai-codex OAuth token exchange response is missing refresh_token.", 502);
  const identity = codexIdentity(data, fields.access, nonEmpty(data.id_token));
  return { accessToken: fields.access, refreshToken: fields.refresh, expiresAt: fields.expiresAt, ...identity };
}

async function refreshCodex(refreshToken: string): Promise<OAuthTokenResult> {
  const data = await postForm(CODEX_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CODEX_CLIENT_ID,
    refresh_token: refreshToken,
  }, "openai-codex", "token refresh");
  const fields = tokenFields(data, "openai-codex", "token refresh", false);
  const identity = codexIdentity(data, fields.access, nonEmpty(data.id_token));
  return { accessToken: fields.access, refreshToken: fields.refresh ?? refreshToken, expiresAt: fields.expiresAt, ...identity };
}

async function anthropicBootstrap(accessToken: string): Promise<Pick<OAuthTokenResult, "accountId" | "email" | "orgId" | "orgName">> {
  let response: Response;
  try {
    response = await fetch(`${ANTHROPIC_BOOTSTRAP_URL}?entrypoint=cli&model=claude-opus-4-8`, {
      headers: {
        accept: "application/json, text/plain, */*",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": "claude-code/1.0.0",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return {};
  }
  if (!response.ok) return {};
  try {
    const body = parseJsonRecord(JSON.parse(await response.text()) as unknown);
    const account = typeof body.oauth_account === "object" && body.oauth_account !== null ? body.oauth_account as Record<string, unknown> : {};
    return {
      accountId: nonEmpty(account.account_uuid),
      email: nonEmpty(account.account_email),
      orgId: nonEmpty(account.organization_uuid),
      orgName: nonEmpty(account.organization_name),
    };
  } catch {
    return {};
  }
}

function anthropicIdentity(data: Record<string, unknown>): Pick<OAuthTokenResult, "accountId" | "email" | "orgId" | "orgName"> {
  const account = typeof data.account === "object" && data.account !== null ? data.account as Record<string, unknown> : {};
  const organization = typeof data.organization === "object" && data.organization !== null ? data.organization as Record<string, unknown> : {};
  return {
    accountId: nonEmpty(account.uuid),
    email: nonEmpty(account.email_address),
    orgId: nonEmpty(organization.uuid),
    orgName: nonEmpty(organization.name),
  };
}

async function exchangeAnthropic(code: string, verifier: string, redirectUri: string, state: string): Promise<OAuthTokenResult> {
  const data = await postJson(ANTHROPIC_TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: ANTHROPIC_CLIENT_ID,
    code,
    state,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }, "anthropic-oauth", "token exchange");
  const fields = tokenFields(data, "anthropic-oauth", "token exchange");
  if (!fields.refresh) throw new KeeperError("validation", "anthropic-oauth OAuth token exchange response is missing refresh_token.", 502);
  const direct = anthropicIdentity(data);
  const bootstrap = await anthropicBootstrap(fields.access);
  return { accessToken: fields.access, refreshToken: fields.refresh, expiresAt: fields.expiresAt, ...bootstrap, ...direct };
}

async function refreshAnthropic(refreshToken: string): Promise<OAuthTokenResult> {
  const data = await postJson(ANTHROPIC_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: ANTHROPIC_CLIENT_ID,
    refresh_token: refreshToken,
  }, "anthropic-oauth", "token refresh", {
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
  });
  const fields = tokenFields(data, "anthropic-oauth", "token refresh", false);
  const identity = anthropicIdentity(data);
  return { accessToken: fields.access, refreshToken: fields.refresh || refreshToken, expiresAt: fields.expiresAt, ...identity };
}

function clineTokenResult(data: Record<string, unknown>, operation: string): OAuthTokenResult {
  const nested = typeof data.data === "object" && data.data !== null ? data.data as Record<string, unknown> : data;
  const accessToken = nonEmpty(nested.accessToken) ?? nonEmpty(nested.access_token);
  const refreshToken = nonEmpty(nested.refreshToken) ?? nonEmpty(nested.refresh_token);
  const rawExpiry = nested.expiresAt ?? nested.expires_at;
  const expiresAt = typeof rawExpiry === "number" ? rawExpiry : typeof rawExpiry === "string" ? Date.parse(rawExpiry) : NaN;
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) {
    throw new KeeperError("validation", `cline OAuth ${operation} response is missing token fields.`, 502);
  }
  const userInfo = typeof nested.userInfo === "object" && nested.userInfo !== null ? nested.userInfo as Record<string, unknown> : {};
  return { accessToken, refreshToken, expiresAt: expiresAt - REFRESH_SKEW_MS, email: nonEmpty(userInfo.email) ?? nonEmpty(nested.email) };
}

function decodeClineCode(code: string): Record<string, unknown> | null {
  try {
    let base64 = code;
    const padding = 4 - (base64.length % 4);
    if (padding !== 4) base64 += "=".repeat(padding);
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const lastBrace = decoded.lastIndexOf("}");
    if (lastBrace < 0) return null;
    const parsed: unknown = JSON.parse(decoded.slice(0, lastBrace + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function exchangeCline(code: string, redirectUri: string): Promise<OAuthTokenResult> {
  const decoded = decodeClineCode(code);
  if (decoded) return clineTokenResult(decoded, "token exchange");
  const data = await postJson(CLINE_TOKEN_URL, { grant_type: "authorization_code", code, client_type: "extension", redirect_uri: redirectUri }, "cline", "token exchange", { accept: "application/json" });
  return clineTokenResult(data, "token exchange");
}

async function refreshCline(refreshToken: string): Promise<OAuthTokenResult> {
  const data = await postJson(CLINE_REFRESH_URL, { refreshToken, grantType: "refresh_token", clientType: "extension" }, "cline", "token refresh", { accept: "application/json" });
  return clineTokenResult(data, "token refresh");
}

function tokenProfileEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = decodeJwtPayload(idToken);
  return nonEmpty(payload?.email);
}

export interface GrokDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
}

export async function requestGrokDeviceAuthorization(): Promise<GrokDeviceAuthorization> {
  const response = await fetch(GROK_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": GROK_CLI_USER_AGENT },
    body: new URLSearchParams({ client_id: GROK_CLIENT_ID, scope: GROK_SCOPE, referrer: "grok-build" }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await readResponseBody(response, "grok-cli", "device authorization");
  const payload = parseJsonRecord(JSON.parse(text) as unknown);
  const deviceCode = nonEmpty(payload.device_code);
  const userCode = nonEmpty(payload.user_code);
  const verificationUri = nonEmpty(payload.verification_uri_complete) ?? nonEmpty(payload.verification_uri) ?? nonEmpty(payload.verification_url);
  if (!deviceCode || !userCode || !verificationUri) throw new KeeperError("validation", "grok-cli device authorization response is incomplete.", 502);
  return { deviceCode, userCode, verificationUri, intervalSeconds: typeof payload.interval === "number" ? payload.interval : 5 };
}

export async function pollGrokDeviceAuthorization(deviceCode: string): Promise<OAuthTokenResult | null> {
  const response = await fetch(GROK_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": GROK_CLI_USER_AGENT },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: GROK_CLIENT_ID }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await response.text();
  const payload = parseJsonRecord(JSON.parse(text) as unknown);
  const pending = payload.error === "authorization_pending" || payload.error === "slow_down";
  if (pending) return null;
  if (!response.ok) throw new KeeperError("token_exchange", `grok-cli device authorization failed (${response.status}).`, response.status, response.status >= 500);
  const fields = tokenFields(payload, "grok-cli", "device authorization");
  if (!fields.refresh) throw new KeeperError("validation", "grok-cli device authorization response is missing refresh_token.", 502);
  return { accessToken: fields.access, refreshToken: fields.refresh, expiresAt: fields.expiresAt, email: tokenProfileEmail(nonEmpty(payload.id_token)), userId: nonEmpty(payload.user_id) ?? nonEmpty(payload.sub) };
}

async function exchangeGrok(code: string, verifier: string, redirectUri: string): Promise<OAuthTokenResult> {
  const data = await postForm(GROK_TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: GROK_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, "grok-cli", "token exchange");
  const fields = tokenFields(data, "grok-cli", "token exchange");
  if (!fields.refresh) throw new KeeperError("validation", "grok-cli OAuth token exchange response is missing refresh_token.", 502);
  return {
    accessToken: fields.access,
    refreshToken: fields.refresh,
    expiresAt: fields.expiresAt,
    email: tokenProfileEmail(nonEmpty(data.id_token)),
    userId: nonEmpty(data.user_id) ?? nonEmpty(data.sub),
  };
}

async function refreshGrok(refreshToken: string): Promise<OAuthTokenResult> {
  const data = await postForm(GROK_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: GROK_CLIENT_ID,
    refresh_token: refreshToken,
  }, "grok-cli", "token refresh");
  const fields = tokenFields(data, "grok-cli", "token refresh", false);
  return {
    accessToken: fields.access,
    refreshToken: fields.refresh ?? refreshToken,
    expiresAt: fields.expiresAt,
    email: tokenProfileEmail(nonEmpty(data.id_token)),
    userId: nonEmpty(data.user_id) ?? nonEmpty(data.sub),
  };
}

const ANTIGRAVITY_METADATA = { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };

async function discoverAntigravityProject(accessToken: string): Promise<string> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": "antigravity",
  };
  let response: Response;
  try {
    response = await fetch(`${ANTIGRAVITY_CLOUD_CODE_URL}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: ANTIGRAVITY_METADATA }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new KeeperError("timeout", "google-antigravity project discovery timed out.", 502, true);
  }
  const text = await readResponseBody(response, "google-antigravity", "project discovery");
  const payload = parseJsonRecord(JSON.parse(text) as unknown);
  const project = payload.cloudaicompanionProject;
  if (typeof project === "string" && project) return project;
  if (typeof project === "object" && project !== null && !Array.isArray(project)) {
    const projectId = (project as Record<string, unknown>).id;
    if (typeof projectId === "string" && projectId) return projectId;
  }
  const tiers = Array.isArray(payload.allowedTiers) ? payload.allowedTiers : [];
  const defaultTier = tiers.find((tier) => typeof tier === "object" && tier !== null && (tier as Record<string, unknown>).isDefault === true && typeof (tier as Record<string, unknown>).id === "string");
  const tierValue = defaultTier ? (defaultTier as Record<string, unknown>).id : undefined;
  const tierId = typeof tierValue === "string" && tierValue ? tierValue : "legacy-tier";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const onboard = await fetch(`${ANTIGRAVITY_CLOUD_CODE_URL}/v1internal:onboardUser`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tierId, metadata: ANTIGRAVITY_METADATA }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const onboardText = await readResponseBody(onboard, "google-antigravity", "project onboarding");
    const operation = parseJsonRecord(JSON.parse(onboardText) as unknown);
    const result = typeof operation.response === "object" && operation.response !== null ? operation.response as Record<string, unknown> : undefined;
    const provisioned = result?.cloudaicompanionProject;
    if (typeof provisioned === "string" && provisioned) return provisioned;
    if (typeof provisioned === "object" && provisioned !== null && !Array.isArray(provisioned)) {
      const projectId = (provisioned as Record<string, unknown>).id;
      if (typeof projectId === "string" && projectId) return projectId;
    }
    if (attempt < 4) await Bun.sleep(2_000);
  }
  throw new KeeperError("provisioning", "google-antigravity project onboarding did not return a project id.", 502, true);
}

async function exchangeAntigravity(code: string, verifier: string, redirectUri: string): Promise<OAuthTokenResult> {
  const { clientId, clientSecret } = antigravityClientCredentials();
  const data = await postForm(ANTIGRAVITY_TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, "google-antigravity", "token exchange");
  const fields = tokenFields(data, "google-antigravity", "token exchange");
  if (!fields.refresh) throw new KeeperError("validation", "google-antigravity OAuth token exchange response is missing refresh_token.", 502);
  return {
    accessToken: fields.access,
    refreshToken: fields.refresh,
    expiresAt: fields.expiresAt,
    email: tokenProfileEmail(nonEmpty(data.id_token)),
    projectId: await discoverAntigravityProject(fields.access),
  };
}

async function refreshAntigravity(refreshToken: string, previous?: OAuthCredentialBundle): Promise<OAuthTokenResult> {
  const { clientId, clientSecret } = antigravityClientCredentials();
  const data = await postForm(ANTIGRAVITY_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }, "google-antigravity", "token refresh");
  const fields = tokenFields(data, "google-antigravity", "token refresh", false);
  return {
    accessToken: fields.access,
    refreshToken: fields.refresh ?? refreshToken,
    expiresAt: fields.expiresAt,
    email: tokenProfileEmail(nonEmpty(data.id_token)),
    projectId: previous?.projectId,
  };
}

export function makeBundle(provider: OAuthProviderId, result: OAuthTokenResult, previous?: OAuthCredentialBundle): OAuthCredentialBundle {
  return {
    version: 1,
    provider,
    refreshToken: result.refreshToken,
    accessToken: result.accessToken,
    accessExpiresAt: result.expiresAt,
    accountId: result.accountId ?? previous?.accountId,
    orgId: result.orgId ?? previous?.orgId,
    orgName: result.orgName ?? previous?.orgName,
    email: result.email ?? previous?.email,
    planType: result.planType ?? previous?.planType,
    projectId: result.projectId ?? previous?.projectId,
    userId: result.userId ?? previous?.userId,
    authorizedAt: previous?.authorizedAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export async function exchangeOAuthCode(provider: OAuthProviderId, code: string, verifier: string, redirectUri: string, state: string): Promise<OAuthCredentialBundle> {
  const result = provider === "openai-codex"
    ? await exchangeCodex(code, verifier, redirectUri)
    : provider === "anthropic-oauth"
      ? await exchangeAnthropic(code, verifier, redirectUri, state)
      : provider === "grok-cli"
        ? await exchangeGrok(code, verifier, redirectUri)
        : provider === "google-antigravity"
          ? await exchangeAntigravity(code, verifier, redirectUri)
          : await exchangeCline(code, redirectUri);
  return makeBundle(provider, result);
}

export async function refreshOAuthCredential(bundle: OAuthCredentialBundle): Promise<OAuthCredentialBundle> {
  const result = bundle.provider === "openai-codex"
    ? await refreshCodex(bundle.refreshToken)
    : bundle.provider === "anthropic-oauth"
      ? await refreshAnthropic(bundle.refreshToken)
      : bundle.provider === "grok-cli"
        ? await refreshGrok(bundle.refreshToken)
        : bundle.provider === "google-antigravity"
          ? await refreshAntigravity(bundle.refreshToken, bundle)
          : await refreshCline(bundle.refreshToken);
  return makeBundle(bundle.provider, result, bundle);
}

export function oauthErrorDetails(error: unknown): { kind: string; status: number; retryable: boolean; message: string } {
  if (error instanceof KeeperError) return { kind: error.kind, status: error.status, retryable: error.retryable, message: error.message };
  if (error instanceof Error) return { kind: "unexpected", status: 502, retryable: true, message: error.message };
  return { kind: "unexpected", status: 502, retryable: true, message: "OAuth operation failed." };
}
