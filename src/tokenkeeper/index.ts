import { pushConsoleLog } from "../console/logs/ring";
import type { AccountQuota } from "../console/quota";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  listOAuthAccountRows,
  markAccountQuotaError,
  markAccountUnavailable,
  patchAccount,
  updateAccountHealth,
  updateAccountQuota,
  type AccountHealthStatus,
  type ProviderAccountRow,
} from "../console/db/repos/accounts";
import {
  callbackUriFor,
  createLoginAuthorization,
  createPkce,
  exchangeOAuthCode,
  makeBundle,
  pollGrokDeviceAuthorization,
  requestGrokDeviceAuthorization,
  oauthErrorDetails,
  refreshOAuthCredential,
} from "./oauth";
import { fetchOAuthQuota, fetchQoderQuota } from "./quota";
import { refreshKiroToken } from "./kiro";
import {
  TokenKeeperError,
  type OAuthCredentialBundle,
  type OAuthCredentialHealth,
  type OAuthLoginSession,
  type OAuthLoginStart,
  type OAuthLoginStatusView,
  type OAuthProviderId,
  type TokenKeeperEvent,
  type TokenKeeperEventListener,
  type TokenKeeperService,
  type TokenLease,
} from "./types";

const LOGIN_SESSION_TTL_MS = 15 * 60_000;
const REFRESH_SWEEP_MS = 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;
const ACCESS_SAFETY_MS = 15_000;
const TRANSIENT_RETRY_MS = 30 * 60_000;
// Quota is display telemetry, not an auth liveness probe. Keep it well below
// the token refresh cadence so quota polling cannot churn OAuth sessions.
const QUOTA_SWEEP_MS = 30 * 60_000;
const QUOTA_COOLDOWN_MS = 30 * 60_000;

interface StoppableServer {
  stop(): void;
}

interface CachedCredential {
  accountId: string;
  bundle: OAuthCredentialBundle;
  health: OAuthCredentialHealth;
}

function isOAuthProvider(value: string): value is OAuthProviderId {
  return value === "openai-codex" || value === "anthropic-oauth" || value === "cline" || value === "grok-cli" || value === "google-antigravity" || value === "kiro";
}

function sanitizeLabel(value: string): string {
  const trimmed = value.trim().replace(/[\r\n]+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

function parseBundle(row: ProviderAccountRow): OAuthCredentialBundle {
  try {
    const parsed: unknown = JSON.parse(row.credential);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || typeof value.provider !== "string" || !isOAuthProvider(value.provider) || typeof value.refreshToken !== "string" || value.refreshToken.length === 0) {
      throw new Error("invalid credential bundle");
    }
    return value as unknown as OAuthCredentialBundle;
  } catch {
    throw new TokenKeeperError("credential-invalid", `OAuth credential ${row.id} is invalid.`, 500, false);
  }
}

function healthFromRow(row: ProviderAccountRow): OAuthCredentialHealth {
  return {
    status: (row.health_status as AccountHealthStatus | undefined) ?? "healthy",
    errorKind: row.health_error_kind ?? null,
    statusCode: row.health_status_code ?? null,
    sanitizedMessage: row.health_sanitized_message ?? null,
    occurredAt: row.health_occurred_at ?? null,
    retryAt: row.health_retry_at ?? null,
    lastRefreshAt: row.health_last_refresh_at ?? null,
  };
}

function toStoredHealth(health: OAuthCredentialHealth): Parameters<typeof updateAccountHealth>[1] {
  return {
    status: health.status,
    errorKind: health.errorKind,
    statusCode: health.statusCode,
    sanitizedMessage: health.sanitizedMessage,
    occurredAt: health.occurredAt,
    retryAt: health.retryAt,
    lastRefreshAt: health.lastRefreshAt,
  };
}

function leaseFromBundle(accountId: string, bundle: OAuthCredentialBundle): TokenLease {
  if (!bundle.accessToken || !bundle.accessExpiresAt || bundle.accessExpiresAt <= Date.now() + ACCESS_SAFETY_MS) {
    throw new TokenKeeperError("credential-expired", "OAuth access token has expired.", 401, false);
  }
  const providerMetadata: Record<string, string> = {};
  if (bundle.accountId) providerMetadata.chatgptAccountId = bundle.accountId;
  if (bundle.planType) providerMetadata.planType = bundle.planType;
  if (bundle.projectId) providerMetadata.projectId = bundle.projectId;
  if (bundle.userId) providerMetadata.userId = bundle.userId;
  if (bundle.profileArn) providerMetadata.profileArn = bundle.profileArn;
  if (bundle.authMethod) providerMetadata.authMethod = bundle.authMethod;
  if (bundle.region) providerMetadata.region = bundle.region;
  if (bundle.clientId) providerMetadata.clientId = bundle.clientId;
  if (bundle.clientSecret) providerMetadata.clientSecret = bundle.clientSecret;
  return {
    credentialId: accountId,
    provider: bundle.provider,
    accessToken: bundle.accessToken,
    expiresAt: bundle.accessExpiresAt,
    accountId: bundle.accountId,
    orgId: bundle.orgId,
    workspaceId: bundle.orgId,
    email: bundle.email,
    providerMetadata,
  };
}

class TokenKeeper implements TokenKeeperService {
  private readonly sessions = new Map<string, OAuthLoginSession>();
  private readonly cache = new Map<string, CachedCredential>();
  private readonly refreshes = new Map<string, Promise<TokenLease>>();
  private readonly quotaRefreshes = new Map<string, Promise<void>>();
  private readonly quotaCooldowns = new Map<string, number>();
  private readonly listeners = new Set<TokenKeeperEventListener>();
  private refreshTimer: Timer | null = null;
  private quotaTimer: Timer | null = null;
  private callbackServers: StoppableServer[] = [];
  private readonly callbackPorts = new Set<number>();
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.hydrate();
    this.refreshTimer = setInterval(() => this.runRefreshSweep(), REFRESH_SWEEP_MS);
    this.quotaTimer = setInterval(() => { void this.runQuotaSweep(); }, QUOTA_SWEEP_MS);
    pushConsoleLog("info", "token_keeper.started", `event=service credentials=${this.cache.size} refresh_sweep=${REFRESH_SWEEP_MS}ms refresh_skew=${REFRESH_SKEW_MS}ms quota_sweep=${QUOTA_SWEEP_MS}ms quota_cooldown=${QUOTA_COOLDOWN_MS}ms`);
    await this.runRefreshSweep();
    void this.runQuotaSweep();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    this.refreshTimer = null;
    this.quotaTimer = null;
    this.quotaCooldowns.clear();
    for (const server of this.callbackServers) server.stop();
    this.callbackServers = [];
    this.callbackPorts.clear();
  }

  subscribe(listener: TokenKeeperEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finishLogin(session: OAuthLoginSession, bundle: OAuthCredentialBundle): void {
    const hint = bundle.email ?? bundle.accountId ?? session.provider;
    const created = createAccount({ provider: session.provider, name: session.accountName, credentialKind: "oauth", credential: JSON.stringify(bundle), credentialHint: hint });
    const health: OAuthCredentialHealth = { status: "healthy", errorKind: null, statusCode: null, sanitizedMessage: null, occurredAt: null, retryAt: null, lastRefreshAt: new Date().toISOString() };
    updateAccountHealth(created.id, toStoredHealth(health));
    this.cache.set(created.id, { accountId: created.id, bundle, health });
    session.status = "completed";
    session.accountId = created.id;
    pushConsoleLog("info", "token_keeper.success", `event=oauth_login provider=${session.provider} account=${sanitizeLabel(session.accountName)}`);
    this.emit({ type: "credential-updated", credentialId: created.id, health });
    if (this.started) void this.refreshQuota(created.id);
  }

  async startLogin(provider: OAuthProviderId, accountName: string): Promise<OAuthLoginStart> {
    const trimmedName = sanitizeLabel(accountName);
    if (!trimmedName) throw new TokenKeeperError("invalid_request", "Account name is required.", 400, false);
    this.ensureCallbackServer(provider);
    const { verifier, challenge } = await createPkce();
    const sessionId = crypto.randomUUID();
    const state = crypto.randomUUID();
    const redirectUri = callbackUriFor(provider);
    const authorization = createLoginAuthorization(provider, state, redirectUri, challenge);
    const deviceAuthorization = provider === "grok-cli" ? await requestGrokDeviceAuthorization() : undefined;
    const session: OAuthLoginSession = {
      id: sessionId,
      provider,
      accountName: trimmedName,
      state,
      verifier,
      redirectUri,
      authorizationUrl: deviceAuthorization?.verificationUri ?? authorization.url,
      ...(deviceAuthorization ? { deviceCode: deviceAuthorization.deviceCode, deviceIntervalSeconds: deviceAuthorization.intervalSeconds } : {}),
      status: "waiting-for-user",
      createdAt: Date.now(),
      expiresAt: Date.now() + LOGIN_SESSION_TTL_MS,
    };
    this.sessions.set(sessionId, session);
    pushConsoleLog("info", "token_keeper.started", `event=oauth_login provider=${provider} account=${trimmedName}`);
    return {
      sessionId,
      provider,
      status: session.status,
      authorizationUrl: session.authorizationUrl,
      redirectUri,
      instructions: deviceAuthorization
        ? `Open ${deviceAuthorization.verificationUri} and enter code ${deviceAuthorization.userCode}. Then press Complete OAuth to finish the device authorization.`
        : authorization.instructions,
      expiresAt: session.expiresAt,
    };
  }

  getLoginStatus(sessionId: string): OAuthLoginStatusView | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.expireSessionIfNeeded(session);
    return {
      sessionId: session.id,
      provider: session.provider,
      status: session.status,
      accountId: session.accountId,
      errorKind: session.errorKind,
      errorMessage: session.errorMessage,
      expiresAt: session.expiresAt,
    };
  }

  async completeLogin(sessionId: string, value: string): Promise<OAuthLoginStatusView> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new TokenKeeperError("not_found", "OAuth login session not found.", 404, false);
    this.expireSessionIfNeeded(session);
    if (session.status !== "waiting-for-user") throw new TokenKeeperError("invalid_state", `OAuth login session is ${session.status}.`, 409, false);
    if (session.provider === "grok-cli" && session.deviceCode) {
      session.status = "exchanging-code";
      try {
        const result = await pollGrokDeviceAuthorization(session.deviceCode);
        if (!result) {
          session.status = "waiting-for-user";
          return this.getLoginStatus(sessionId)!;
        }
        this.finishLogin(session, makeBundle("grok-cli", result));
        return this.getLoginStatus(sessionId)!;
      } catch (error) {
        const details = oauthErrorDetails(error);
        this.failSession(session, details.kind, details.message, false);
        throw error;
      }
    }
    const callback = this.parseCompletion(value);
    if (callback.state && callback.state !== session.state) {
      this.failSession(session, "state-mismatch", "OAuth state did not match.", false);
      throw new TokenKeeperError("state-mismatch", "OAuth state did not match.", 400, false);
    }
    if (callback.error) {
      this.failSession(session, callback.error, "OAuth authorization was denied.", false);
      throw new TokenKeeperError(callback.error, "OAuth authorization was denied.", 400, false);
    }
    if (!callback.code) throw new TokenKeeperError("invalid_request", "Authorization code or redirect URL is required.", 400, false);

    session.status = "exchanging-code";
    try {
      const bundle = await exchangeOAuthCode(session.provider, callback.code, session.verifier, session.redirectUri, callback.state ?? session.state);
      this.finishLogin(session, bundle);
    } catch (error) {
      const details = oauthErrorDetails(error);
      this.failSession(session, details.kind, details.message, false);
      pushConsoleLog("error", "token_keeper.failed", `event=oauth_login provider=${session.provider} account=${sanitizeLabel(session.accountName)} status=${details.status} kind=${details.kind}`);
      throw error;
    }
    return this.getLoginStatus(sessionId)!;
  }

  cancelLogin(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.status === "waiting-for-user" || session.status === "pending") {
      session.status = "cancelled";
      pushConsoleLog("info", "token_keeper.cancelled", `event=oauth_login provider=${session.provider} account=${sanitizeLabel(session.accountName)}`);
    }
  }

  async getTokenLease(credentialId: string): Promise<TokenLease> {
    const cached = this.cache.get(credentialId);
    if (cached) {
      try {
        return leaseFromBundle(credentialId, cached.bundle);
      } catch (error) {
        if (!(error instanceof TokenKeeperError) || error.kind !== "credential-expired") throw error;
      }
    }
    return this.refreshCredential(credentialId);
  }

  async refreshCredential(credentialId: string): Promise<TokenLease> {
    const running = this.refreshes.get(credentialId);
    if (running) return running;
    const operation = this.refreshCredentialSingleFlight(credentialId);
    this.refreshes.set(credentialId, operation);
    try {
      return await operation;
    } finally {
      this.refreshes.delete(credentialId);
    }
  }

  recordProviderFailure(credentialId: string, statusCode: number, errorKind: string, message: string): void {
    const current = getAccount(credentialId);
    if (!current || current.credential_kind !== "oauth") return;
    const previous = this.cache.get(credentialId)?.health ?? healthFromRow(current);
    const requiresReauth = statusCode === 401 || statusCode === 403;
    const retryAt = requiresReauth ? null : new Date(Date.now() + TRANSIENT_RETRY_MS).toISOString();
    const sanitizedMessage = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\s+/g, " ").slice(0, 240);
    const health: OAuthCredentialHealth = {
      status: requiresReauth ? "reauthentication-required" : "error",
      errorKind,
      statusCode,
      sanitizedMessage,
      occurredAt: new Date().toISOString(),
      retryAt,
      lastRefreshAt: previous.lastRefreshAt,
    };
    updateAccountHealth(credentialId, toStoredHealth(health));
    if (requiresReauth) patchAccount(credentialId, { active: false });
    else markAccountUnavailable(credentialId, "rate-limit");
    pushConsoleLog(statusCode >= 500 ? "error" : "warn", "token_keeper.failed", `event=provider provider=${current.provider} account=${sanitizeLabel(current.name)} status=${statusCode} kind=${errorKind} retry_at=${retryAt ?? "none"}`);
    this.emit({ type: requiresReauth ? "credential-disabled" : "credential-updated", credentialId, health });
  }

  revokeCredential(credentialId: string): void {
    const current = getAccount(credentialId);
    if (!current) throw new TokenKeeperError("not_found", "OAuth account not found.", 404, false);
    patchAccount(credentialId, { active: false });
    const health: OAuthCredentialHealth = {
      status: "disabled",
      errorKind: "revoked",
      statusCode: null,
      sanitizedMessage: "Credential disabled by operator.",
      occurredAt: new Date().toISOString(),
      retryAt: null,
      lastRefreshAt: this.cache.get(credentialId)?.health.lastRefreshAt ?? null,
    };
    updateAccountHealth(credentialId, toStoredHealth(health));
    this.cache.delete(credentialId);
    pushConsoleLog("warn", "token_keeper.failed", `event=revoked provider=${current.provider} account=${sanitizeLabel(current.name)}`);
    this.emit({ type: "credential-disabled", credentialId, health });
  }

  deleteCredential(credentialId: string): void {
    const current = getAccount(credentialId);
    if (!current) return;
    deleteAccount(credentialId);
    this.cache.delete(credentialId);
    pushConsoleLog("info", "token_keeper.success", `event=deleted provider=${current.provider} account=${sanitizeLabel(current.name)}`);
    this.emit({ type: "credential-removed", credentialId, health: { status: "disabled", errorKind: null, statusCode: null, sanitizedMessage: null, occurredAt: null, retryAt: null, lastRefreshAt: null } });
  }

  private hydrate(): void {
    for (const row of listOAuthAccountRows()) {
      try {
        const bundle = parseBundle(row);
        this.cache.set(row.id, { accountId: row.id, bundle, health: healthFromRow(row) });
      } catch (error) {
        const details = oauthErrorDetails(error);
        updateAccountHealth(row.id, { status: "error", errorKind: details.kind, statusCode: details.status, sanitizedMessage: details.message, occurredAt: new Date().toISOString(), retryAt: null, lastRefreshAt: null });
        pushConsoleLog("error", "token_keeper.failed", `event=credential_invalid provider=${row.provider} account=${sanitizeLabel(row.name)}`);
      }
    }
  }

  private async runRefreshSweep(): Promise<void> {
    const now = Date.now();
    for (const cached of this.cache.values()) {
      if (!cached.bundle.accessExpiresAt || cached.bundle.accessExpiresAt <= now + REFRESH_SKEW_MS) {
        void this.refreshCredential(cached.accountId).catch(() => undefined);
      }
    }
    for (const [id, session] of this.sessions) {
      this.expireSessionIfNeeded(session);
      if (session.status === "expired" || session.status === "cancelled") this.sessions.delete(id);
    }
  }

  private async runQuotaSweep(): Promise<void> {
    const accountIds = [
      ...listOAuthAccountRows().filter((row) => row.active && row.provider !== "cline" && row.provider !== "grok-cli").map((row) => row.id),
      ...listAccounts("qoder").filter((account) => account.active).map((account) => account.id),
    ];
    const concurrency = 6;
    for (let offset = 0; offset < accountIds.length; offset += concurrency) {
      await Promise.all(accountIds.slice(offset, offset + concurrency).map((accountId) => this.refreshQuota(accountId)));
    }
  }

  async refreshAccountQuota(credentialId: string): Promise<void> {
    return this.refreshQuota(credentialId);
  }

  private async refreshQuota(credentialId: string): Promise<void> {
    const running = this.quotaRefreshes.get(credentialId);
    if (running) return running;
    const account = getAccount(credentialId);
    if (!account || !account.active || account.provider === "grok-cli") return;
    const cooldownUntil = this.quotaCooldowns.get(credentialId) ?? 0;
    if (cooldownUntil > Date.now()) return;
    this.quotaCooldowns.set(credentialId, Date.now() + QUOTA_COOLDOWN_MS);
    const operation = this.refreshQuotaSingleFlight(credentialId);
    this.quotaRefreshes.set(credentialId, operation);
    try {
      await operation;
    } finally {
      this.quotaRefreshes.delete(credentialId);
    }
  }

  private async refreshQuotaSingleFlight(credentialId: string): Promise<void> {
    const row = getAccount(credentialId);
    if (!row || !row.active) return;
    const fetchedAt = new Date().toISOString();
    try {
      let quota: AccountQuota | null;
      if (row.provider === "qoder") quota = await fetchQoderQuota(row.credential);
      else if (row.credential_kind === "oauth") {
        const lease = await this.getTokenLease(credentialId);
        quota = await fetchOAuthQuota(lease.provider, lease);
      } else quota = null;
      if (!quota) return;
      if (!this.started) return;
      if (quota.error) {
        markAccountQuotaError(credentialId, quota.error, quota.fetchedAt);
        pushConsoleLog("warn", "token_keeper.failed", `event=quota provider=${row.provider} account=${sanitizeLabel(row.name)} error=${sanitizeLabel(quota.error ?? "unknown")}`);
      } else {
        updateAccountQuota(credentialId, quota);
        const exhausted = quota.windows.length > 0 && quota.windows.every((window) => window.remainingPercent !== null && window.remainingPercent <= 0);
        pushConsoleLog(exhausted ? "warn" : "info", exhausted ? "token_keeper.exhausted" : "token_keeper.success", `event=quota provider=${row.provider} account=${sanitizeLabel(row.name)} windows=${quota.windows.length} plan=${sanitizeLabel(quota.plan ?? "unknown")}`);
      }
    } catch (error) {
      if (!this.started) return;
      const details = oauthErrorDetails(error);
      markAccountQuotaError(credentialId, details.message, fetchedAt);
      pushConsoleLog("warn", "token_keeper.failed", `event=quota provider=${row.provider} account=${sanitizeLabel(row.name)} kind=${details.kind}`);
    }
  }

  private async refreshCredentialSingleFlight(credentialId: string): Promise<TokenLease> {
    const row = getAccount(credentialId);
    if (!row || row.credential_kind !== "oauth") throw new TokenKeeperError("not_found", "OAuth account not found.", 404, false);
    if (!row.active) throw new TokenKeeperError("credential-disabled", "OAuth account is disabled.", 401, false);
    const previous = this.cache.get(credentialId);
    const bundle = previous?.bundle ?? parseBundle(row);
    const accountLabel = sanitizeLabel(row.name);
    const refreshingHealth: OAuthCredentialHealth = { ...(previous?.health ?? healthFromRow(row)), status: "refreshing", errorKind: null, statusCode: null, sanitizedMessage: null, retryAt: null };
    updateAccountHealth(credentialId, toStoredHealth(refreshingHealth));
    pushConsoleLog("info", "token_keeper.started", `event=refresh provider=${bundle.provider} account=${accountLabel}`);
    const started = performance.now();
    try {
      const nextBundle = bundle.provider === "kiro" ? await refreshKiroToken(bundle.refreshToken, bundle) : await refreshOAuthCredential(bundle);
      patchAccount(credentialId, { credential: JSON.stringify(nextBundle) });
      const health: OAuthCredentialHealth = { status: "healthy", errorKind: null, statusCode: null, sanitizedMessage: null, occurredAt: null, retryAt: null, lastRefreshAt: new Date().toISOString() };
      updateAccountHealth(credentialId, toStoredHealth(health));
      this.cache.set(credentialId, { accountId: credentialId, bundle: nextBundle, health });
      const durationMs = Math.round(performance.now() - started);
      pushConsoleLog("info", "token_keeper.success", `event=refresh provider=${bundle.provider} account=${accountLabel} duration_ms=${durationMs} expires_at=${nextBundle.accessExpiresAt ?? 0}`);
      this.emit({ type: "credential-updated", credentialId, health });
      return leaseFromBundle(credentialId, nextBundle);
    } catch (error) {
      const details = oauthErrorDetails(error);
      const requiresReauth = details.kind.includes("invalid") || details.kind.includes("revoked") || details.status === 401;
      const retryAt = requiresReauth ? null : new Date(Date.now() + TRANSIENT_RETRY_MS).toISOString();
      const health: OAuthCredentialHealth = {
        status: requiresReauth ? "reauthentication-required" : "error",
        errorKind: details.kind,
        statusCode: details.status,
        sanitizedMessage: details.message,
        occurredAt: new Date().toISOString(),
        retryAt,
        lastRefreshAt: previous?.health.lastRefreshAt ?? null,
      };
      updateAccountHealth(credentialId, toStoredHealth(health));
      if (requiresReauth) patchAccount(credentialId, { active: false });
      else markAccountUnavailable(credentialId, "rate-limit");
      const durationMs = Math.round(performance.now() - started);
      pushConsoleLog("error", "token_keeper.failed", `event=refresh provider=${bundle.provider} account=${accountLabel} status=${details.status} kind=${details.kind} duration_ms=${durationMs} retry_at=${retryAt ?? "none"}`);
      this.emit({ type: requiresReauth ? "credential-disabled" : "credential-updated", credentialId, health });
      throw error;
    }
  }

  private expireSessionIfNeeded(session: OAuthLoginSession): void {
    if (Date.now() >= session.expiresAt && (session.status === "pending" || session.status === "waiting-for-user" || session.status === "exchanging-code")) {
      session.status = "expired";
      session.errorKind = "expired";
      session.errorMessage = "OAuth login session expired.";
    }
  }

  private failSession(session: OAuthLoginSession, kind: string, message: string, _retryable: boolean): void {
    session.status = "failed";
    session.errorKind = kind;
    session.errorMessage = message;
  }

  private parseCompletion(value: string): { code?: string; state?: string; error?: string } {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code") ?? undefined;
      const state = url.searchParams.get("state") ?? undefined;
      const error = url.searchParams.get("error") ?? undefined;
      return { code, state, error };
    } catch {
      return { code: trimmed };
    }
  }

  private emit(event: TokenKeeperEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Health subscribers must never break the proxy hot path.
      }
    }
  }

  private ensureCallbackServer(provider: OAuthProviderId): void {
    if (provider === "openai-codex") this.startCallbackServer(1455, "/auth/callback", provider);
    else if (provider === "anthropic-oauth") this.startCallbackServer(54545, "/callback", provider);
    else if (provider === "grok-cli") this.startCallbackServer(56121, "/callback", provider);
    else if (provider === "google-antigravity") this.startCallbackServer(51121, "/oauth-callback", provider);
    else this.startCallbackServer(1456, "/callback", provider);
  }

  private startCallbackServer(port: number, path: string, provider: OAuthProviderId): void {
    if (this.callbackPorts.has(port)) return;
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname !== path) return new Response("Not found", { status: 404 });
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const session = [...this.sessions.values()].find((item) => item.provider === provider && item.state === state)
            ?? (provider === "cline" && !state ? [...this.sessions.values()].find((item) => item.provider === provider && item.status === "waiting-for-user") : undefined);
          if (!session) return new Response("OAuth session not found or expired.", { status: 400 });
          try {
            await this.completeLogin(session.id, error ? `?error=${encodeURIComponent(error)}&state=${encodeURIComponent(state ?? "")}` : `${url.toString()}`);
            return new Response("OAuth login completed. You can close this tab.", { headers: { "content-type": "text/plain; charset=utf-8" } });
          } catch (failure) {
            const details = oauthErrorDetails(failure);
            return new Response(`OAuth login failed: ${details.kind}`, { status: details.status, headers: { "content-type": "text/plain; charset=utf-8" } });
          }
        },
      });
      this.callbackServers.push(server);
      this.callbackPorts.add(port);
      pushConsoleLog("info", "token_keeper.callback_ready", `event=oauth_callback provider=${provider} port=${port}`);
    } catch {
      pushConsoleLog("warn", "token_keeper.failed", `event=oauth_callback provider=${provider} port=${port} reason=unavailable`);
    }
  }
}

export const tokenKeeper: TokenKeeperService = new TokenKeeper();
