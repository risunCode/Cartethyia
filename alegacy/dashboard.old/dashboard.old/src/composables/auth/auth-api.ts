import { daemonGet, daemonPost, DaemonContractError } from "../../lib/daemon-api";

const MAX_TEXT_LENGTH = 256;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_OAUTH_URL_LENGTH = 2048;

export interface AuthSession {
  readonly user: string;
  readonly scopes: readonly string[];
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly remember: boolean;
}

export interface OAuthStartInput {
  readonly providerId: string;
  readonly scopes?: readonly string[];
  readonly accountId?: string;
}

export interface OAuthCompleteInput {
  readonly code: string;
  readonly state?: string;
}

export interface OAuthRefreshInput {
  readonly accountId: string;
  readonly force: boolean;
}

export type OAuthStatus = "pending" | "completed" | "cancelled" | "expired" | "failed" | "unknown";

export interface OAuthState {
  readonly accountId: string | null;
  readonly status: OAuthStatus;
  readonly authorizationUrl: string | null;
  readonly expiresAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

function optionalDate(value: unknown): string | null {
  const text = boundedText(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DaemonContractError("invalid_contract", message, 502);
  return value;
}

/** Parses the safe subset of a daemon session; IDs, CSRF tokens, and metadata are discarded. */
export function normalizeAuthSession(value: unknown): AuthSession {
  const source = requiredRecord(value, "authentication session is invalid");
  const user = boundedText(source.user);
  if (!user) throw new DaemonContractError("invalid_contract", "authentication session is invalid", 502);
  const scopes = Array.isArray(source.scopes)
    ? source.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length <= MAX_TEXT_LENGTH).map((scope) => scope.trim()).filter(Boolean)
    : [];
  return {
    user,
    scopes,
    createdAt: optionalDate(source.createdAt),
    expiresAt: optionalDate(source.expiresAt),
  };
}

/** Parses the login result without retaining cookie, session ID, or CSRF material. */
export function normalizeLoginResult(value: unknown): AuthSession {
  const source = requiredRecord(value, "login response is invalid");
  return normalizeAuthSession(source.session ?? source);
}

/** Parses an OAuth state response while retaining only bounded display-safe fields. */
export function normalizeOAuthState(value: unknown): OAuthState {
  const source = requiredRecord(value, "OAuth state is invalid");
  const rawStatus = boundedText(source.status);
  const status: OAuthStatus = rawStatus === "pending" || rawStatus === "completed" || rawStatus === "cancelled" || rawStatus === "expired" || rawStatus === "failed"
    ? rawStatus
    : "unknown";
  return {
    accountId: boundedText(source.accountId),
    status,
    authorizationUrl: boundedText(source.url, MAX_OAUTH_URL_LENGTH),
    expiresAt: optionalDate(source.expiresAt),
  };
}

/** Restricts a login return destination to a bounded same-origin path. */
export function boundedReturnPath(value: string | null | undefined): string {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/overview";
  return value;
}

export async function getAuthSession(): Promise<AuthSession> {
  return normalizeAuthSession(await daemonGet<unknown>("/auth/session"));
}

export async function loginAuth(input: LoginInput): Promise<AuthSession> {
  return normalizeLoginResult(await daemonPost<unknown>("/auth/login", input));
}

export async function refreshAuthSession(): Promise<AuthSession> {
  return normalizeAuthSession(await daemonPost<unknown>("/auth/refresh"));
}

export async function logoutAuth(): Promise<void> {
  await daemonPost<unknown>("/auth/logout");
}

export async function startOAuth(input: OAuthStartInput): Promise<OAuthState> {
  const providerId = input.providerId.trim().slice(0, MAX_PROVIDER_ID_LENGTH);
  if (!providerId) throw new DaemonContractError("invalid_request", "provider ID is required", 400);
  return normalizeOAuthState(await daemonPost<unknown>(`/auth/oauth/start?providerId=${encodeURIComponent(providerId)}`, {
    scopes: input.scopes?.slice(0, 16).map((scope) => scope.slice(0, MAX_TEXT_LENGTH)),
    accountId: input.accountId?.slice(0, MAX_TEXT_LENGTH),
  }));
}

export async function getOAuthState(sessionId: string): Promise<OAuthState> {
  return normalizeOAuthState(await daemonGet<unknown>(`/auth/oauth/sessions/${encodeURIComponent(sessionId.slice(0, MAX_TEXT_LENGTH))}`));
}

export async function completeOAuth(sessionId: string, input: OAuthCompleteInput): Promise<OAuthState> {
  return normalizeOAuthState(await daemonPost<unknown>(`/auth/oauth/sessions/${encodeURIComponent(sessionId.slice(0, MAX_TEXT_LENGTH))}/complete`, {
    code: input.code,
    state: input.state,
  }));
}

export async function cancelOAuth(sessionId: string): Promise<void> {
  await daemonPost<unknown>(`/auth/oauth/sessions/${encodeURIComponent(sessionId.slice(0, MAX_TEXT_LENGTH))}/cancel`);
}

export async function refreshOAuth(input: OAuthRefreshInput): Promise<OAuthState> {
  return normalizeOAuthState(await daemonPost<unknown>("/auth/oauth/refresh", {
    accountId: input.accountId.slice(0, MAX_TEXT_LENGTH),
    force: input.force,
  }));
}
