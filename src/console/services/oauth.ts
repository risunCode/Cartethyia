import type { ApplicationErrorKind } from "../../application/contracts";
import { sanitizeMessage } from "../../application/contracts";
import { OAUTH_SAFETY_SKEW_MS, TokenRefreshPool, type OAuthTokenRecord } from "../../application/auth";
import type { TokenSet } from "../../application/auth";
import type { AuthDriverRegistry } from "../../application/auth";
import { OAuthLoginSessionManager, OAuthSessionError, type OAuthLoginSessionView } from "../../application/auth";
import { registerOAuthCallback, unregisterOAuthCallback } from "../../application/auth/oauth-callback-server";
import type { AccountRepository, ConsoleErrorCode } from "../views";
import type { OAuthTokenStore } from "../../application/auth";


// ---------------------------------------------------------------------------
// OAuth lifecycle
// ---------------------------------------------------------------------------

export type OAuthStartResultView =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly providerId: string;
      readonly name: string;
      readonly authorizationUrl: string;
      readonly instructions: string;
      readonly redirectUri: string | null;
      readonly userCode: string | null;
      readonly verificationUri: string | null;
      readonly intervalSeconds: number | null;
      readonly state: string;
      readonly expiresAtMs: number;
    }
  | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string };

export type OAuthCompleteResultView =
  | { readonly ok: true; readonly accountId: string; readonly providerId: string; readonly status: "completed"; readonly credentialHint: string }
  | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string };

export type OAuthRefreshResultView =
  | { readonly ok: true; readonly expiresAt: string | null }
  | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string };

export interface OAuthAccountStatusView {
  readonly accountId: string;
  readonly providerId: string;
  /** False when the account exists but is not OAuth-linked. */
  readonly linked: boolean;
  readonly hasRefreshToken: boolean;
  readonly accessTokenExpiresAt: string | null;
  /** Access token is missing or within the safety skew of expiry. */
  readonly expired: boolean;
  readonly refreshable: boolean;
  readonly revocable: boolean;
  /** Persisted refresh worker state; reauth_required means no blind retries remain. */
  readonly refreshState: "unknown" | "healthy" | "retrying" | "reauth_required";
  readonly lastRefreshAt: string | null;
  readonly lastRefreshErrorKind: ApplicationErrorKind | null;
}

function oauthCredentialBundle(providerId: string, token: OAuthTokenRecord, details?: TokenSet): string {
  const now = Date.now();
  const metadata = details as (TokenSet & { readonly region?: string; readonly authMethod?: string; readonly startUrl?: string; readonly clientId?: string; readonly clientSecret?: string; readonly profileArn?: string }) | undefined;
  const bundle: Record<string, unknown> = { version: 1, provider: providerId, refreshToken: token.refreshToken, accessToken: token.accessToken, accessExpiresAt: token.expiresAtMs, authorizedAt: now, updatedAt: now };
  if (details?.providerAccountId) {
    bundle.providerAccountId = details.providerAccountId;
    if (providerId === "antigravity") bundle.projectId = details.providerAccountId;
  }
  if (details?.email) bundle.email = details.email;
  if (details?.orgId) bundle.orgId = details.orgId;
  if (details?.orgName) bundle.orgName = details.orgName;
  for (const key of ["region", "authMethod", "startUrl", "clientId", "clientSecret", "profileArn"] as const) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.length > 0) bundle[key] = value;
  }
  return JSON.stringify(bundle);
}

function oauthSessionErrorView(error: unknown): { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string } {
  if (error instanceof OAuthSessionError) {
    const code: ConsoleErrorCode = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status >= 500 ? "internal_error" : "invalid_request";
    return { ok: false, status: error.status, code, message: error.message };
  }
    return { ok: false, status: 500, code: "internal_error", message: `OAuth operation failed: ${error instanceof Error ? sanitizeMessage(error) : "unknown internal error"}` };
}

function oauthRefreshErrorView(kind: ApplicationErrorKind, statusCode: number | null, message: string): { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string } {
  const code: ConsoleErrorCode = kind === "authentication_failed" ? "unauthorized" : kind === "provider_rate_limited" ? "rate_limited" : kind === "provider_protocol_error" ? "invalid_request" : "internal_error";
  return { ok: false, status: statusCode ?? 502, code, message };
}

/**
 * Console OAuth lifecycle: interactive login sessions (start/exchange/cancel),
 * explicit token refresh, provider-side revoke, and bounded account status.
 * Persists exchanged tokens through the durable OAuthTokenStore port; driver
 * lookup is provider-aware through the injected AuthDriverRegistry.
 */
export class OAuthService {
  private readonly sessions: OAuthLoginSessionManager;
  private readonly tokenRefresh: TokenRefreshPool;
  private readonly drivers: AuthDriverRegistry;
  private readonly accounts: AccountRepository;
  private readonly tokens: OAuthTokenStore;

  constructor(options: {
    readonly sessions: OAuthLoginSessionManager;
    readonly tokenRefresh: TokenRefreshPool;
    readonly drivers: AuthDriverRegistry;
    readonly accounts: AccountRepository;
    readonly tokens: OAuthTokenStore;
  }) {
    this.sessions = options.sessions;
    this.tokenRefresh = options.tokenRefresh;
    this.drivers = options.drivers;
    this.accounts = options.accounts;
    this.tokens = options.tokens;
  }

  async start(input: unknown): Promise<OAuthStartResultView> {
    const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const providerId = typeof value.providerId === "string" ? value.providerId : "";
    if (providerId.length === 0) return { ok: false, status: 400, code: "invalid_request", message: "provider is required" };
    const name = typeof value.name === "string" ? value.name : "";
    if (name.trim().length === 0) return { ok: false, status: 400, code: "invalid_request", message: "account name is required" };
    try {
      const result = await this.sessions.start({
        providerId,
        name,
        redirectUri: typeof value.redirectUri === "string" && value.redirectUri.length > 0 ? value.redirectUri : undefined,
        scopes: Array.isArray(value.scopes) ? value.scopes.flatMap((item) => (typeof item === "string" ? [item] : [])) : undefined,
      });
      // Start the local callback server for providers that use one
      // (Codex, Anthropic, Antigravity, Kimchi). Device-flow providers
      // (Kiro, Cline) don't need a local listener.
      registerOAuthCallback(providerId, result.sessionId, result.state, this.sessions, async (sessionId, input) => {
        await this.complete(sessionId, { code: input.code, state: input.state, error: input.error, value: input.value });
      });
      return {
        ok: true,
        sessionId: result.sessionId,
        providerId: result.providerId,
        name: result.name,
        authorizationUrl: result.authorizationUrl,
        instructions: result.userCode ? "Open the verification URL, enter the device code, then check authorization here." : "Complete authorization in the provider window, then return here to finish the connection.",
        redirectUri: result.redirectUri,
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        intervalSeconds: result.intervalSeconds,
        state: result.state,
        expiresAtMs: result.expiresAtMs,
      };
    } catch (error) {
      return oauthSessionErrorView(error);
    }
  }

  /** Live session status; null when the session is unknown or expired. */
  async session(sessionId: string): Promise<ReturnType<OAuthLoginSessionManager["get"]>> {
    const before = this.sessions.get(sessionId);
    if (before === null) return null;
    const polled = await this.sessions.poll(sessionId);
    if (polled.status === "completed" && polled.accountId === null) {
      await this.complete(sessionId, {});
    }
    return this.sessions.get(sessionId);
  }

  async complete(sessionId: string, body: unknown): Promise<OAuthCompleteResultView> {
    const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    let completed: { readonly view: OAuthLoginSessionView; readonly tokenSet: TokenSet };
    try {
      const outcome = await this.sessions.complete(sessionId, {
        code: typeof value.code === "string" ? value.code : undefined,
        state: typeof value.state === "string" ? value.state : undefined,
        error: typeof value.error === "string" ? value.error : undefined,
        codeVerifier: typeof value.codeVerifier === "string" ? value.codeVerifier : undefined,
        redirectUri: typeof value.redirectUri === "string" ? value.redirectUri : undefined,
        value: typeof value.value === "string" ? value.value : undefined,
      });
      completed = outcome;
    } catch (error) {
      return oauthSessionErrorView(error);
    }
    const token: OAuthTokenRecord = {
      accessToken: completed.tokenSet.accessToken,
      expiresAtMs: typeof completed.tokenSet.expiresAt === "string" ? Number(new Date(completed.tokenSet.expiresAt)) : null,
      refreshToken: completed.tokenSet.refreshToken ?? null,
      kind: "oauth",
    };
    const created = await this.accounts.create({
      providerId: completed.view.providerId,
      name: completed.view.name,
      credentialKind: "oauth",
      credential: oauthCredentialBundle(completed.view.providerId, token, completed.tokenSet),
      priority: undefined,
      active: true,
    });
    await this.tokens.set(created.id, token);
    this.sessions.attachAccountId(sessionId, created.id);
    unregisterOAuthCallback(completed.view.providerId, sessionId);
    return { ok: true, accountId: created.id, providerId: completed.view.providerId, status: "completed", credentialHint: created.credentialHint };
  }

  /** Cancels a pending session; false when the session does not exist. */
  async cancel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const result = this.sessions.cancel(sessionId);
    if (result && session !== null) {
      unregisterOAuthCallback(session.providerId, sessionId);
    }
    return result;
  }

  /** Explicit refresh routed through the central account-level single-flight pool. */
  async refreshAccount(accountId: string): Promise<OAuthRefreshResultView> {
    if (accountId.length === 0) return { ok: false, status: 400, code: "invalid_request", message: "accountId is required" };
    const account = await this.accounts.get(accountId);
    if (account === null) return { ok: false, status: 404, code: "not_found", message: "account not found" };
    if (account.credentialKind !== "oauth") return { ok: false, status: 400, code: "invalid_request", message: "account is not OAuth-linked" };
    const token = await this.tokens.get(accountId);
    if (token?.refreshToken === null && token.accessToken.length > 0) {
      return { ok: true, expiresAt: token.expiresAtMs === null ? null : new Date(token.expiresAtMs).toISOString() };
    }
    if (token?.refreshToken === null || token === undefined) return { ok: false, status: 400, code: "invalid_request", message: "account has no access token" };
    try {
      const refreshed = await this.tokenRefresh.forceRefresh(accountId);
      return { ok: true, expiresAt: refreshed.expiresAtMs === null ? null : new Date(refreshed.expiresAtMs).toISOString() };
    } catch (error) {
      if (typeof error === "object" && error !== null && "kind" in error && "sanitizedMessage" in error) {
        const providerError = error as { readonly kind: ApplicationErrorKind; readonly statusCode: number | null; readonly sanitizedMessage: string };
        return oauthRefreshErrorView(providerError.kind, providerError.statusCode, providerError.sanitizedMessage);
      }
      return { ok: false, status: 502, code: "internal_error", message: "OAuth refresh failed" };
    }
  }

  /**
   * Revokes an OAuth account: best-effort provider-side revoke through the
   * registered driver, then disables the account and clears the stored token.
   * False when the account does not exist.
   */
  async revoke(providerId: string, accountId: string): Promise<boolean> {
    const account = await this.accounts.get(accountId);
    if (account === null) return false;
    const resolvedProvider = providerId.length > 0 ? providerId : account.providerId;
    const driver = this.drivers.get(resolvedProvider);
    const token = await this.tokens.get(accountId);
    if (driver?.revoke !== undefined && token !== undefined) {
      try {
        await driver.revoke({ providerId: resolvedProvider, accountId, token: token.accessToken });
      } catch {
        // Best-effort: local disable + token clear still apply.
      }
    }
    await this.accounts.update(accountId, { active: false });
    await this.tokens.delete(accountId);
    return true;
  }

  /** Bounded OAuth account status; null when the account does not exist. */
  async accountStatus(accountId: string): Promise<OAuthAccountStatusView | null> {
    const account = await this.accounts.get(accountId);
    if (account === null) return null;
    const token = await this.tokens.get(accountId);
    const hasRefreshToken = token?.refreshToken !== null && token?.refreshToken !== undefined && token.refreshToken.length > 0;
    const expiresAtMs = token?.expiresAtMs ?? null;
    const expired = token === undefined || (expiresAtMs !== null && expiresAtMs - Date.now() <= OAUTH_SAFETY_SKEW_MS);
    const driver = this.drivers.get(account.providerId);
    return {
      accountId,
      providerId: account.providerId,
      linked: account.credentialKind === "oauth",
      hasRefreshToken,
      accessTokenExpiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      expired,
      refreshable: driver?.refresh !== undefined && hasRefreshToken,
      revocable: driver?.revoke !== undefined || hasRefreshToken,
      refreshState: token?.refreshState ?? "unknown",
      lastRefreshAt: token?.lastRefreshAtMs == null ? null : new Date(token.lastRefreshAtMs).toISOString(),
      lastRefreshErrorKind: token?.lastRefreshErrorKind ?? null,
    };
  }

}