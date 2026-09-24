import { nonEmptyString as nonEmpty, readJsonResponse } from "../../authentication/oauth-flow-store";
import { postJsonTokenRequest } from "../../authentication/oauth-flow-store";
import { oauthCallbackUrl } from "../../../config";
import type { OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthClient, type FetchLike } from "../../authentication/oauth-client";
import { resolveClaudeCliVersion, resolveClaudeSdkVersion } from "../../operations/client-versions";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const BOOTSTRAP_MODEL = "claude-opus-4-8";
const SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: { email_address?: unknown };
  organization?: { name?: unknown };
}

interface BootstrapResponse {
  oauth_account?: { account_email?: unknown; organization_name?: unknown };
}


async function bootstrapLabel(access: string, fetchFn: FetchLike): Promise<string | undefined> {
  const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(BOOTSTRAP_MODEL)}`;
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
      "User-Agent": `claude-code/${await resolveClaudeCliVersion()}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await readJsonResponse(response, "Claude OAuth")) as BootstrapResponse;
  return (
    nonEmpty(data.oauth_account?.account_email) ?? nonEmpty(data.oauth_account?.organization_name)
  );
}

function labelFromToken(data: TokenResponse): string | undefined {
  return nonEmpty(data.account?.email_address) ?? nonEmpty(data.organization?.name);
}

function tokenResult(data: TokenResponse, accountLabel?: string): OAuthExchangeResult {
  const access = nonEmpty(data.access_token);
  const refresh = nonEmpty(data.refresh_token);
  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : undefined;
  if (!access || !refresh || expiresIn === undefined)
    throw new Error("Claude OAuth token response is missing required fields");
  return {
    access,
    refresh,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    ...(accountLabel ? { accountLabel } : {}),
  };
}

function refreshResult(data: TokenResponse): OAuthTokenRefreshResult {
  const access = nonEmpty(data.access_token);
  const refresh = nonEmpty(data.refresh_token);
  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : undefined;
  if (!access || expiresIn === undefined)
    throw new Error("Claude OAuth token response is missing required fields");
  return {
    access,
    ...(refresh ? { refresh } : {}),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

/** Claude Pro/Max OAuth login and token-refresh client using Claude Code's public OAuth application. */
export class ClaudeOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;

  protected override readonly providerLabel = "Claude";
  protected override readonly clientId = CLIENT_ID;
  protected override readonly tokenUrl = TOKEN_URL;
  protected override readonly authorizeUrl = AUTHORIZE_URL;
  protected override readonly scopes = SCOPE;

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  protected override providerIdForCallback(): string {
    return "claude";
  }

  protected override extraAuthorizeParams(): Record<string, string> | undefined {
    return { code: "true" };
  }

  override async exchangeCode(code: string, codeVerifier: string): Promise<OAuthExchangeResult> {
    const response = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: oauthCallbackUrl("claude"),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await readJsonResponse(response, "Claude OAuth")) as TokenResponse;
    const label = labelFromToken(data);
    if (label) return tokenResult(data, label);
    const access = nonEmpty(data.access_token);
    const fallback = access ? await bootstrapLabel(access, this.fetchFn).catch(() => undefined) : undefined;
    return tokenResult(data, fallback);
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const payload = await postJsonTokenRequest({
      url: TOKEN_URL,
      fetchFn: this.fetchFn,
      body: {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      },
      headers: {
        "User-Agent": `anthropic-sdk-typescript/${await resolveClaudeSdkVersion()} userOAuthProvider`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal,
      label: "Claude OAuth",
    });
    return refreshResult(payload as TokenResponse);
  }
}

export const claudeOAuthClient = new ClaudeOAuthClient();

/**
 * Claude model discovery: attempts a live `GET /v1/models` call with the
 * account's stored bearer token — Anthropic documents a real public models
 * endpoint, but whether a Claude-Code-OAuth scoped token is authorized to
 * call it is not established by any evidence gathered during research, so a
 * failed/unauthorized live call falls back to a small curated static list
 * rather than reporting zero models.
 */

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

/** Curated fallback used when live discovery is unavailable/unauthorized for this credential. */
export const CURATED_CLAUDE_MODELS: readonly string[] = [
  "claude-opus-5-5",
  "claude-mythos-5-1",
  "claude-mythos-5",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
];

interface ClaudeModelDiscoveryResult {
  readonly modelIds: readonly string[];
  readonly source: "live" | "curated";
}

interface AnthropicModelListResponse {
  readonly data?: readonly { readonly id?: string }[];
}

/** Discovers Claude models: live if the bearer token is authorized, curated fallback otherwise. */
export async function discoverClaudeModels(
  bearerToken: string,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<ClaudeModelDiscoveryResult> {
  try {
    const response = await fetchFn(ANTHROPIC_MODELS_URL, {
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "anthropic-version": ANTHROPIC_VERSION,
      },
    });
    if (!response.ok) return { modelIds: CURATED_CLAUDE_MODELS, source: "curated" };
    const body = (await response.json()) as AnthropicModelListResponse;
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return { modelIds: CURATED_CLAUDE_MODELS, source: "curated" };
    return { modelIds: ids, source: "live" };
  } catch {
    return { modelIds: CURATED_CLAUDE_MODELS, source: "curated" };
  }
}
