// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly active: boolean;
  readonly rateLimitRpm: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly oneTimeTokenLimit: number | null;
  readonly oneTimeTokensUsed: number;
  readonly quoteBigText: string | null;
  readonly quoteSubText: string | null;
  readonly quoteBody: string | null;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: readonly string[] | null;
  readonly modelAllowlist: readonly string[] | null;
  readonly modelDenylist: readonly string[] | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly totalUsage: number;
  readonly totalRequests: number;
}

export interface ApiKeyCreateInput {
  readonly name: string;
  /** Optional exact secret; validated before persistence. */
  readonly key?: string;
  readonly prefix?: string;
  readonly rateLimitRpm?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly oneTimeTokenLimit?: number;
  readonly maxConcurrentRequests?: number;
  readonly providerAllowlist?: readonly string[];
  readonly modelAllowlist?: readonly string[];
  readonly modelDenylist?: readonly string[];
}

export interface ApiKeyUpdateInput {
  /** Optional exact replacement secret. */
  readonly key?: string;
  readonly rateLimitRpm?: number | null;
  readonly dailyTokenLimit?: number | null;
  readonly monthlyTokenLimit?: number | null;
  readonly oneTimeTokenLimit?: number | null;
  readonly maxConcurrentRequests?: number | null;
  readonly providerAllowlist?: readonly string[] | null;
  readonly modelAllowlist?: readonly string[] | null;
  readonly modelDenylist?: readonly string[] | null;
  readonly quoteBigText?: string | null;
  readonly quoteSubText?: string | null;
  readonly quoteBody?: string | null;
  readonly active?: boolean;
}

/** The full credential is returned exactly once (creation/regeneration). */
export interface ApiKeySecretResult {
  readonly key: string;
  readonly record: ApiKeyView;
}

export interface ApiKeyRepository {
  list(): Promise<readonly ApiKeyView[]>;
  get(id: string): Promise<ApiKeyView | null>;
  create(input: ApiKeyCreateInput): Promise<ApiKeySecretResult | { readonly error: "duplicate" }>;
  update(id: string, patch: ApiKeyUpdateInput): Promise<ApiKeyView | null>;
  regenerate(id: string): Promise<ApiKeySecretResult | null>;
  revoke(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Explicit credential endpoint contract — the only path that returns the secret. */
  credential(id: string): Promise<{ readonly key: string } | null>;
}
