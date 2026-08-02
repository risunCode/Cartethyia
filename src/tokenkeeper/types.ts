import type { AccountHealthStatus } from "../console/db/repos/accounts";

export type OAuthProviderId = "openai-codex" | "anthropic-oauth" | "cline" | "grok-cli" | "google-antigravity" | "kiro";

export interface OAuthCredentialBundle {
  version: 1;
  provider: OAuthProviderId;
  refreshToken: string;
  accessToken?: string;
  accessExpiresAt?: number;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  email?: string;
  planType?: string;
  projectId?: string;
  userId?: string;
  profileArn?: string;
  authMethod?: string;
  region?: string;
  clientId?: string;
  clientSecret?: string;
  authorizedAt: number;
  updatedAt: number;
}

export type OAuthLoginStatus =
  | "pending"
  | "waiting-for-user"
  | "exchanging-code"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface OAuthLoginSession {
  id: string;
  provider: OAuthProviderId;
  accountName: string;
  state: string;
  verifier: string;
  redirectUri: string;
  authorizationUrl: string;
  deviceCode?: string;
  deviceIntervalSeconds?: number;
  status: OAuthLoginStatus;
  createdAt: number;
  expiresAt: number;
  errorKind?: string;
  errorMessage?: string;
  accountId?: string;
}

export interface OAuthLoginStart {
  sessionId: string;
  provider: OAuthProviderId;
  status: OAuthLoginStatus;
  authorizationUrl: string;
  redirectUri: string;
  instructions: string;
  expiresAt: number;
}

export interface OAuthLoginStatusView {
  sessionId: string;
  provider: OAuthProviderId;
  status: OAuthLoginStatus;
  accountId?: string;
  errorKind?: string;
  errorMessage?: string;
  expiresAt: number;
}

export interface TokenLease {
  credentialId: string;
  provider: OAuthProviderId;
  accessToken: string;
  expiresAt: number;
  accountId?: string;
  orgId?: string;
  workspaceId?: string;
  email?: string;
  providerMetadata: Record<string, string>;
}

export interface OAuthCredentialHealth {
  status: AccountHealthStatus;
  errorKind: string | null;
  statusCode: number | null;
  sanitizedMessage: string | null;
  occurredAt: string | null;
  retryAt: string | null;
  lastRefreshAt: string | null;
}

export interface TokenKeeperEvent {
  type: "credential-updated" | "credential-disabled" | "credential-removed";
  credentialId: string;
  health: OAuthCredentialHealth;
}

export type TokenKeeperEventListener = (event: TokenKeeperEvent) => void;

export interface TokenKeeperService {
  startLogin(provider: OAuthProviderId, accountName: string, callbackOrigin?: string): Promise<OAuthLoginStart>;
  getLoginStatus(sessionId: string): OAuthLoginStatusView | null;
  completeLogin(sessionId: string, value: string): Promise<OAuthLoginStatusView>;
  cancelLogin(sessionId: string): void;
  getTokenLease(credentialId: string): Promise<TokenLease>;
  refreshCredential(credentialId: string): Promise<TokenLease>;
  refreshAccountQuota(accountId: string): Promise<void>;
  recordProviderFailure(credentialId: string, statusCode: number, errorKind: string, message: string): void;
  revokeCredential(credentialId: string): void;
  deleteCredential(credentialId: string): void;
  start(): Promise<void>;
  stop(): void;
}

export class TokenKeeperError extends Error {
  readonly kind: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(kind: string, message: string, status = 502, retryable = false) {
    super(message);
    this.name = "TokenKeeperError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}
