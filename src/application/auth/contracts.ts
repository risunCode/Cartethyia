import type { CredentialKind } from "../contracts";

/** Provider-neutral token material returned by OAuth exchange and refresh drivers. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scope?: string;
  readonly providerAccountId?: string;
  /** Account email surfaced by providers that inline it (Anthropic, Google). */
  readonly email?: string;
  /** Subscription workspace the token draws limits from; captured at login only. */
  readonly orgId?: string;
  readonly orgName?: string;
}

export interface OAuthStartInput {
  readonly providerId: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly state?: string;
  readonly codeChallenge?: string;
  readonly flow?: "browser" | "device";
}

export interface OAuthStartResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAtMs: number;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly intervalSeconds?: number;
  readonly flow?: "browser" | "device";
}


export interface OAuthExchangeInput {
  readonly providerId: string;
  readonly code: string;
  readonly state?: string;
  readonly redirectUri?: string;
  readonly codeVerifier?: string;
}

export interface RefreshTokenInput {
  readonly providerId: string;
  readonly accountId: string;
  readonly refreshToken: string;
  /** Persisted provider credential bundle, when a driver needs client metadata. */
  readonly credential?: string | null;
}

export interface RevokeTokenInput {
  readonly providerId: string;
  readonly accountId: string;
  readonly token: string;
}
/** Explicit OAuth lifecycle and entry-flow capabilities. */
export interface AuthDriverCapabilities {
  readonly supportsStart: boolean;
  readonly supportsPoll: boolean;
  readonly supportsExchange: boolean;
  readonly supportsRefresh: boolean;
  readonly supportsRevoke: boolean;
  readonly accessOnly: boolean;
  /** Authorization-code/redirect login can be started by the console. */
  readonly supportsBrowser: boolean;
  /** Device-code login can be started and polled by the console. */
  readonly supportsDevice: boolean;
}

/** Shared provider auth contract; provider-specific wire details stay in providers. */
export interface AuthDriver {
  readonly kind: CredentialKind;
  readonly capabilities?: AuthDriverCapabilities;
  start?(input: OAuthStartInput): Promise<OAuthStartResult>;
  poll?(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }>;
  exchange?(input: OAuthExchangeInput): Promise<TokenSet>;
  refresh?(input: RefreshTokenInput): Promise<TokenSet>;
  revoke?(input: RevokeTokenInput): Promise<void>;
}
