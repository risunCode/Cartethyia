/**
 * Configuration domain records and repository contracts.
 *
 * Extracted from `config.ts` so the storage contract types own their own
 * file. The SQL schema lives in `schema.ts`; the repository builders,
 * durable ports, and lifecycle singletons remain in `config.ts`.
 */

import type { CredentialKind, RouteHealth, RoutingPreset } from "../../application/contracts";
import type { PersistenceEnv } from "./env";

// ────────────────────────────── Domain records ──────────────────────────────

export interface SettingsRecord {
  readonly passwordHash: string | null;
  readonly passwordVersion: number;
  readonly jwtSecret: string | null;
  readonly settingsJson: Record<string, unknown>;
  readonly initializedAt: string;
  readonly updatedAt: string;
}

export interface RuntimeSettings {
  readonly logRetentionDays: number;
  readonly assetRetentionDays: number;
}

export interface ApiKeyPublic {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly active: boolean;
  readonly rateLimitRpm: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly oneTimeTokenLimit: number | null;
  readonly oneTimeTokensUsed: number;
  readonly quoteBigText?: string | null;
  readonly quoteSubText?: string | null;
  readonly quoteBody?: string | null;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: string | null;
  readonly modelAllowlist: string | null;
  readonly modelDenylist: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface ApiKeyCreateInput {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly keyPrefix: string;
  readonly rateLimitRpm?: number | null;
  readonly dailyTokenLimit?: number | null;
  readonly monthlyTokenLimit?: number | null;
  readonly oneTimeTokenLimit?: number | null;
  readonly maxConcurrentRequests?: number | null;
  readonly providerAllowlist?: string | null;
  readonly modelAllowlist?: string | null;
  readonly modelDenylist?: string | null;
}

export interface ApiKeyUpdateInput {
  readonly name?: string;
  readonly key?: string;
  readonly rateLimitRpm?: number | null;
  readonly dailyTokenLimit?: number | null;
  readonly monthlyTokenLimit?: number | null;
  readonly oneTimeTokenLimit?: number | null;
  readonly quoteBigText?: string | null;
  readonly quoteSubText?: string | null;
  readonly quoteBody?: string | null;
  readonly maxConcurrentRequests?: number | null;
  readonly providerAllowlist?: string | null;
  readonly modelAllowlist?: string | null;
  readonly modelDenylist?: string | null;
  readonly active?: boolean;
}

export interface ProviderAccountRecord {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly credentialKind: CredentialKind;
  readonly credentialHint: string;
  readonly priority: number;
  readonly active: boolean;
  readonly cooldownUntil: string | null;
  readonly cooldownLevel: number;
  readonly consecutiveUseCount: number;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountCreateInput {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly credentialKind: CredentialKind;
  readonly credential: string;
  readonly credentialHint: string;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface AccountPatchInput {
  readonly name?: string;
  readonly credentialKind?: CredentialKind;
  readonly credential?: string;
  readonly credentialHint?: string;
  readonly priority?: number;
  readonly active?: boolean;
  readonly cooldownUntil?: string | null;
  readonly cooldownLevel?: number;
  readonly consecutiveUseCount?: number;
  readonly lastUsedAt?: string | null;
}

/**
 * Keyset pagination options for account listing. The cursor is the last
 * account id of the previous page; results resume with `WHERE id > cursor`
 * ordered by id, bounded by `limit`. Both fields optional — when absent the
 * full provider set is returned (routing/summary callers).
 */
export interface AccountListPagination {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Paged account list result for the console accounts endpoint. */
export interface AccountListPage {
  readonly items: readonly ProviderAccountRecord[];
  readonly nextCursor: string | null;
}

export interface ProxyRecord {
  readonly id: string;
  readonly name: string;
  readonly protocol: "http" | "https" | "socks5";
  readonly isRelay: boolean;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  readonly maxConcurrency: number;
  readonly priority: number;
  readonly weight: number;
  readonly active: boolean;
  readonly cooldownUntil: string | null;
  readonly cooldownLevel: number;
  readonly consecutiveUseCount: number;
  readonly lastUsedAt: string | null;
  readonly lastTestAt: string | null;
  readonly lastTestSuccessAt: string | null;
  readonly lastTestSuccessLatencyMs: number | null;
  readonly lastTestErrorAt: string | null;
  readonly lastTestError: string | null;
  readonly lastTestStatusCode: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProxyCreateInput {
  readonly id: string;
  readonly name: string;
  readonly protocol: "http" | "https" | "socks5";
  readonly host: string;
  readonly port: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly isRelay?: boolean;
  readonly maxConcurrency?: number;
  readonly priority?: number;
  readonly weight?: number;
  readonly active?: boolean;
}

export interface ProxyTestRecordInput {
  readonly testedAt: string;
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  readonly error: string | null;
}

export interface ProxyPatchInput {
  readonly name?: string;
  readonly protocol?: "http" | "https" | "socks5";
  readonly host?: string;
  readonly port?: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly isRelay?: boolean;
  readonly maxConcurrency?: number;
  readonly priority?: number;
  readonly weight?: number;
  readonly active?: boolean;
  readonly cooldownUntil?: string | null;
  readonly cooldownLevel?: number;
  readonly consecutiveUseCount?: number;
  readonly lastUsedAt?: string | null;
}

export interface ProxySettingsRecord {
  readonly enabled: boolean;
  readonly excludedProviders: readonly string[];
  readonly smartDynamicRouting: boolean;
  readonly smartDynamicProxyCount: number;
  readonly routingPreset: RoutingPreset;
  /** Per-proxy in-flight cap override; 0 means use each proxy's configured cap. */
  readonly targetConcurrent: number;
  readonly updatedAt: string;
}

export interface ProviderModelRecord {
  readonly provider: string;
  readonly modelId: string;
  readonly enabled: boolean;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AliasRecord {
  readonly alias: string;
  readonly model: string;
  readonly createdAt: string;
}

export interface CliModelMappingRecord {
  readonly toolId: string;
  readonly slotKey: string;
  readonly sourceModel: string;
  readonly targetModel: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CliMappingSettingsRecord {
  readonly toolId: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}


export interface ComboRecord {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
  readonly strategy: string;
  readonly stickyLimit: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomProviderRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly type: "openai-compatible" | "anthropic-compatible";
  readonly baseUrl: string;
  readonly credential: string;
  readonly timeoutSeconds: number;
  readonly models: readonly unknown[];
  readonly customHeaders: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccessRuleRecord {
  readonly scope: string;
  readonly mode: string;
  readonly entries: readonly unknown[];
  readonly updatedAt: string;
}

// ─────────────────────────────── Repositories ───────────────────────────────

export interface SettingsRepository {
  ensure(): SettingsRecord;
  get(): SettingsRecord | null;
  getSettingsJson(): Record<string, unknown>;
  patchSettingsJson(patch: Readonly<Record<string, unknown>>): Record<string, unknown>;
  getRuntimeSettings(env: PersistenceEnv): RuntimeSettings;
  patchRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings;
  setPasswordHash(hash: string): void;
  bumpPasswordVersion(): void;
  rotateJwtSecret(secret: string): void;
}

export interface ApiKeyRepository {
  list(): ApiKeyPublic[];
  getById(id: string): ApiKeyPublic | null;
  /** Full secret lookup — hot auth path, bounded TTL cache. */
  getBySecret(key: string): ApiKeyPublic | null;
  credential(id: string): string | null;
  create(input: ApiKeyCreateInput): ApiKeyPublic;
  update(id: string, patch: ApiKeyUpdateInput): ApiKeyPublic | null;
  revoke(id: string): boolean;
  delete(id: string): boolean;
  /** Coalesced `last_used_at` write (bounded flush). */
  touch(id: string): void;
  flushTouches(): void;
  sumOneTimeTokensUsed(id: string): number;
  consumeOneTimeTokens(id: string, tokens: number): void;
}

export interface AccountRepository {
  list(provider?: string): ProviderAccountRecord[];
  /** Keyset-paged listing for the console accounts endpoint. */
  listPaged(provider: string, pagination: AccountListPagination): AccountListPage;
  get(id: string): ProviderAccountRecord | null;
  create(input: AccountCreateInput): ProviderAccountRecord;
  patch(id: string, patch: AccountPatchInput): ProviderAccountRecord | null;
  delete(id: string): boolean;
  /** Batch delete by IDs — returns count of deleted rows. */
  deleteBatch(ids: readonly string[]): number;
  /** Batch set active flag — returns count of updated rows. */
  setActiveBatch(ids: readonly string[], active: boolean): number;
  /** Active credentials in routing order (secret-bearing; caller must not log). */
  listActiveCredentials(provider: string): string[];
}

export interface HealthRepository {
  get(routeId: string): Promise<RouteHealth | null>;
  list(): Promise<RouteHealth[]>;
  listWithIds?(routeIds?: readonly string[]): Promise<readonly { readonly id: string; readonly health: RouteHealth }[]>;
  upsert(routeId: string, health: RouteHealth): Promise<void>;
  clear(routeId: string): Promise<void>;
}

export interface ProxyRepository {
  list(): ProxyRecord[];
  get(id: string): ProxyRecord | null;
  create(input: ProxyCreateInput): ProxyRecord;
  patch(id: string, patch: ProxyPatchInput): ProxyRecord | null;
  recordTest(id: string, result: ProxyTestRecordInput): ProxyRecord | null;
  delete(id: string): boolean;
  getSettings(): ProxySettingsRecord | null;
  patchSettings(patch: Partial<Omit<ProxySettingsRecord, "updatedAt">>): ProxySettingsRecord;
}

export interface ProviderModelRepository {
  list(provider: string): ProviderModelRecord[];
  get(provider: string, modelId: string): ProviderModelRecord | null;
  upsert(provider: string, modelId: string, input: { enabled?: boolean; source?: string }): ProviderModelRecord;
  delete(provider: string, modelId: string): boolean;
}

export interface AliasRepository {
  list(): AliasRecord[];
  get(alias: string): AliasRecord | null;
  upsert(alias: string, model: string): AliasRecord;
  delete(alias: string): boolean;
}

export interface CliModelMappingRepository {
  list(toolId: string): CliModelMappingRecord[];
  upsert(input: {
    readonly toolId: string;
    readonly slotKey: string;
    readonly sourceModel: string;
    readonly targetModel: string;
    readonly enabled: boolean;
  }): CliModelMappingRecord;
  delete(toolId: string, slotKey: string): boolean;
  getSettings(toolId: string): CliMappingSettingsRecord | null;
  setEnabled(toolId: string, enabled: boolean): CliMappingSettingsRecord;
  reset(toolId: string): void;
}

export interface ComboRepository {
  list(): ComboRecord[];
  get(id: string): ComboRecord | null;
  upsert(input: { id: string; name: string; models: readonly string[]; strategy?: string; stickyLimit?: number }): ComboRecord;
  delete(id: string): boolean;
}

export interface CustomProviderRepository {
  list(): CustomProviderRecord[];
  get(id: string): CustomProviderRecord | null;
  getBySlug(slug: string): CustomProviderRecord | null;
  upsert(input: {
    id: string;
    slug: string;
    name: string;
    type: "openai-compatible" | "anthropic-compatible";
    baseUrl: string;
    credential: string;
    timeoutSeconds?: number;
    models?: readonly unknown[];
    customHeaders?: Readonly<Record<string, string>>;
  }): CustomProviderRecord;
  delete(id: string): boolean;
  updateModels(id: string, models: readonly unknown[]): CustomProviderRecord | null;
}

export interface AccessRuleRepository {
  get(scope: string): AccessRuleRecord | null;
  upsert(scope: string, input: { mode: string; entries: readonly unknown[] }): AccessRuleRecord;
}

export interface ShareLinkRecord {
  readonly id: string;
  readonly apiKeyId: string;
  readonly tokenHash: string;
  readonly kind: "monitor" | "setup";
  readonly active: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly usedAt: string | null;
  readonly lastViewedAt: string | null;
}

export interface ShareLinkRepository {
  getByTokenHash(tokenHash: string): ShareLinkRecord | null;
  listByApiKey(apiKeyId: string): ShareLinkRecord[];
  create(input: { id: string; apiKeyId: string; tokenHash: string; kind?: "monitor" | "setup"; expiresAt?: string | null; active?: boolean }): ShareLinkRecord;
  patchActive(id: string, active: boolean): ShareLinkRecord | null;
  consumeSetup(id: string, now: string): ShareLinkRecord | null;
  touch(id: string): void;
  delete(id: string): boolean;
}
