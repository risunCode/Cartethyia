/**
 * GitHub Copilot device-code OAuth client.
 *
 * Two tokens, and the difference matters: GitHub issues an **access token**
 * through the device flow, and that token is then exchanged for a short-lived
 * **Copilot token** at `/copilot_internal/v2/token`. Only the Copilot token is
 * accepted by the inference API, and it carries the `proxy-ep` claim that names
 * the per-account API host — an Individual account and an enterprise account
 * are served from different hosts, so the base URL is derived from the token
 * rather than fixed.
 *
 * The GitHub token is stored as the refresh value because it is what re-mints
 * the Copilot token; the Copilot token expires on the order of half an hour and
 * would otherwise force a fresh device authorization every time.
 */
import {
  devicePollBackoff,
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
import { resolveGithubEnterpriseDomain } from "../../../config";

/** Public GitHub OAuth app id the Copilot clients use; not a secret. */
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98" as const;
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token" as const;
/** Default API host when a token carries no `proxy-ep` claim. */
export const GITHUB_DEFAULT_API_HOST = "api.individual.githubcopilot.com" as const;

/**
 * Headers every Copilot inference and policy request must carry.
 *
 * The API rejects a request that does not identify a Copilot client, so these
 * are a protocol requirement rather than cosmetic fingerprinting — unlike the
 * Codex/Claude CLI identities elsewhere in this repository, which exist to look
 * like a first-party client. The version pair is the Copilot Chat extension's,
 * which is what the upstream expects for this client id.
 */
export const GITHUB_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
  "x-github-api-version": "2026-06-01",
});

const DEVICE_INTERVAL_SECONDS = 5;
const DEVICE_EXPIRY_SECONDS = 900;
/** Copilot tokens are short-lived; a missing `expires_at` falls back to 25 minutes. */
const COPILOT_TOKEN_FALLBACK_MS = 25 * 60 * 1000;

/** The GitHub host that serves the device flow. */
export function copilotGitHubDomain(): string {
  return resolveGithubEnterpriseDomain() || "github.com";
}

/** Persisted credential shape: the Copilot token plus the host it was minted for. */
export function encodeGithubCredential(access: string, apiHost: string, githubToken?: string): string {
  return JSON.stringify({
    access,
    apiHost,
    // The GitHub token is carried in the envelope as well as the refresh
    // column: the quota collector is handed only the access value, and the
    // usage endpoint takes the GitHub token, not the minted one. It is optional
    // so a credential written before this field existed still parses.
    ...(githubToken === undefined || githubToken.length === 0 ? {} : { github: githubToken }),
  });
}

export interface GithubCredential {
  readonly access: string;
  readonly apiHost: string;
  /** The long-lived GitHub token, when the envelope carries it. */
  readonly github?: string;
}

/**
 * Parses a stored Copilot credential.
 *
 * Fails closed: only this module writes the secret, so a value that is not the
 * JSON envelope means the row was corrupted or written by another tool, and
 * dispatching with a guessed token and host would send an unusable request.
 */
export function parseGithubCredential(value: string): GithubCredential {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("GitHub Copilot credential is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("GitHub Copilot credential is not a JSON envelope");
  }
  const root = record(parsed);
  const access = root === undefined ? undefined : nonEmptyTrimmedString(root.access);
  if (root === undefined || access === undefined) {
    throw new Error("GitHub Copilot credential is missing access");
  }
  const apiHost = nonEmptyTrimmedString(root.apiHost) ?? GITHUB_DEFAULT_API_HOST;
  const github = nonEmptyTrimmedString(root.github);
  return {
    access,
    apiHost,
    ...(github === undefined ? {} : { github }),
  };
}

/**
 * Reads the API host out of a Copilot token.
 *
 * The token is a `key=value;` list; `proxy-ep` names the proxy host and the API
 * host is the same name with `proxy.` swapped for `api.`. A token without the
 * claim falls back to the Individual host rather than failing — the request
 * then fails closed upstream with a typed error instead of at credential parse.
 */
export function apiHostFromGithubToken(token: string): string {
  const match = token.match(/proxy-ep=([^;]+)/);
  const proxyHost = match?.[1]?.trim();
  if (!proxyHost) return GITHUB_DEFAULT_API_HOST;
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return apiHost.length > 0 ? apiHost : GITHUB_DEFAULT_API_HOST;
}

interface CopilotTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

/** Mints a Copilot token from a GitHub access token. */
export async function mintGithubToken(
  githubAccessToken: string,
  domain: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<{ access: string; apiHost: string; expiresAt: Date }> {
  const response = await fetchFn(`https://api.${domain}/copilot_internal/v2/token`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubAccessToken}`,
      ...GITHUB_REQUEST_HEADERS,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  const body = (await readJsonResponse(response, "GitHub Copilot token mint")) as CopilotTokenResponse;
  const access = nonEmptyTrimmedString(body.token);
  if (access === undefined) {
    throw new Error("GitHub Copilot token mint returned no token");
  }
  const expiresAtSeconds =
    typeof body.expires_at === "number" && Number.isFinite(body.expires_at) ? body.expires_at : undefined;
  return {
    access,
    apiHost: apiHostFromGithubToken(access),
    expiresAt:
      expiresAtSeconds === undefined
        ? new Date(Date.now() + COPILOT_TOKEN_FALLBACK_MS)
        : new Date(expiresAtSeconds * 1000),
  };
}

/** Reads the GitHub login for the account label, so a re-login replaces one row. */
async function fetchGitHubLogin(
  githubAccessToken: string,
  domain: string,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(`https://api.${domain}/user`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${githubAccessToken}`,
        ...GITHUB_REQUEST_HEADERS,
      },
      signal,
    });
    if (!response.ok) return undefined;
    return nonEmptyTrimmedString(record(await response.json())?.login);
  } catch {
    // The label is an enrichment. Losing it costs the friendly name and falls
    // back to the refresh-token fingerprint for identity, not the login.
    return undefined;
  }
}

export class GithubOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "GitHub Copilot";
  protected override readonly clientId = GITHUB_CLIENT_ID;
  protected override readonly tokenUrl = GITHUB_ACCESS_TOKEN_URL;
  protected override readonly scopes = "read:user";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const domain = copilotGitHubDomain();
    const response = await this.fetchFn(`https://${domain}/login/device/code`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": GITHUB_REQUEST_HEADERS["user-agent"]!,
      },
      body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
    });
    const body = record(await readJsonResponse(response, "GitHub device authorization"));
    const deviceCode = nonEmptyTrimmedString(body?.device_code);
    const userCode = nonEmptyTrimmedString(body?.user_code);
    const verificationUri = nonEmptyTrimmedString(body?.verification_uri);
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw new Error("GitHub device authorization returned an invalid response");
    }
    // The verification URI comes from the provider and is handed to an operator
    // to open, so it is validated as an absolute http(s) URL before being
    // published — a `file:`/`javascript:` value must never reach the dialog.
    let parsed: URL;
    try {
      parsed = new URL(verificationUri);
    } catch {
      throw new Error("GitHub device authorization returned an untrusted verification URI");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("GitHub device authorization returned an untrusted verification URI");
    }
    const interval =
      typeof body?.interval === "number" && Number.isFinite(body.interval)
        ? Math.max(0, body.interval)
        : DEVICE_INTERVAL_SECONDS;
    const expiresIn =
      typeof body?.expires_in === "number" && Number.isFinite(body.expires_in)
        ? Math.max(0, body.expires_in)
        : DEVICE_EXPIRY_SECONDS;
    return {
      verificationUri: parsed.href,
      userCode,
      deviceAuthId: deviceCode,
      intervalSeconds: interval,
      expiresInSeconds: expiresIn,
      // The host is captured at start so the poll mints against the same GitHub
      // domain the device code was issued by.
      providerState: domain,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const domain = context?.providerState ?? copilotGitHubDomain();
    const response = await this.fetchFn(`https://${domain}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": GITHUB_REQUEST_HEADERS["user-agent"]!,
      },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceAuthId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    // GitHub answers 200 with an `error` field for the pending state, so the
    // body decides — but a non-2xx response or an unparseable body is a real
    // failure, and reading it through the throwing helper would surface the
    // raw status as an unhandled error instead of a poll verdict. The body is
    // therefore read first and classified below.
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
    } catch {
      parsed = undefined;
    }
    const body = record(parsed);
    const githubToken = nonEmptyTrimmedString(body?.access_token);
    if (githubToken === undefined) {
      const error = nonEmptyTrimmedString(body?.error) ?? "";
      // GitHub answers 200 with an `error` field for both the pending state
      // and `slow_down`; `slow_down` must widen the cadence or every later
      // poll is rejected the same way and the flow never completes.
      const verdict = devicePollBackoff(error, body?.interval);
      if (verdict !== undefined) return verdict;
      if (error === "expired_token") {
        return { status: "failed", reason: "GitHub device authorization expired" };
      }
      if (error === "access_denied") {
        return { status: "failed", reason: "GitHub authorization was denied" };
      }
      // Any other verdict — an unrecognized `error`, a non-2xx status, or an
      // unparseable body — is a failure, not a pending state. Returning
      // "pending" here made a permanent upstream rejection look like a login
      // that simply never finished: the dialog polled until its own expiry and
      // the operator saw a spinner with no reason.
      const reason =
        error.length > 0
          ? `GitHub device polling failed: ${error}`
          : `GitHub device polling failed (${response.status})`;
      return { status: "failed", reason };
    }
    let minted;
    try {
      minted = await mintGithubToken(githubToken, domain, this.fetchFn);
    } catch (error) {
      // The mint runs after approval: surface its reason as a failed verdict,
      // not an exception that escapes the dashboard's poll request.
      return { status: "failed", reason: error instanceof Error ? error.message : "GitHub Copilot token mint failed" };
    }
    const label = await fetchGitHubLogin(githubToken, domain, this.fetchFn, AbortSignal.timeout(10_000));
    const result: OAuthExchangeResult = {
      access: encodeGithubCredential(minted.access, minted.apiHost, githubToken),
      // The GitHub token is the refresh value: it is what re-mints the Copilot
      // token, which expires on its own much shorter clock.
      refresh: githubToken,
      expiresAt: minted.expiresAt,
      ...(label === undefined ? {} : { accountLabel: label }),
    };
    return { status: "complete", result };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const minted = await mintGithubToken(
      refreshToken,
      copilotGitHubDomain(),
      this.fetchFn,
      signal,
    );
    return {
      access: encodeGithubCredential(minted.access, minted.apiHost, refreshToken),
      // The GitHub token is unchanged by a re-mint, so it stays the refresh value.
      refresh: refreshToken,
      expiresAt: minted.expiresAt,
    };
  }
}

export const githubOAuthClient = new GithubOAuthClient();
