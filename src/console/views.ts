/**
 * Console view, input, and repository-contract interfaces.
 *
 * These are the dashboard-facing DTOs and the repository ports the console
 * services talk to. They carry no secrets — list/detail payloads only surface
 * bounded credential hints and sanitized messages. Secrets are returned solely
 * by the explicit credential endpoints on each repository.
 *
 * Extracted from `services.ts` so each concern owns its own file.
 */

import type { CredentialKind, ModelMetadata, ProviderModel, Surface, RoutingPreset, UsageDimension, UsagePeriod } from "../application/contracts";
import type { RouteHealth, RouteScope, RouteSwitch } from "../application/contracts";
import type { ModelMetadataResolver, ResolvedModelMetadata } from "../application/model-metadata";
import type { ChartBucket, ModelTokenTotalsRow, UsageByRow, UsageCacheSummary } from "../storage";
import type { BackupPayload, RestoreResult, RestoreValidation } from "../storage";
import type { OAuthTokenStore, QuotaSnapshotState, QuotaStateStore } from "../auth/credentials";

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export type ConsoleErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "request_too_large"
  | "internal_error";

export interface ConsoleErrorBody {
  readonly error: {
    readonly type: "error";
    readonly code: ConsoleErrorCode;
    readonly message: string;
    readonly request_id: string;
  };
}

/** Stable console error envelope (dashboard `ApiErrorShape`-compatible). */
export function consoleError(code: ConsoleErrorCode, message: string, requestId?: string): ConsoleErrorBody {
  return { error: { type: "error", code, message, request_id: requestId ?? crypto.randomUUID() } };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ConsoleRuntimeSettings {
  readonly proxyAuthMode: "open" | "api_key";
  readonly privacyMode: "masked" | "full";
  readonly trackPayloads: "none" | "bounded";
  readonly trackAssets: "none" | "meta" | "store";
  readonly logRetentionDays: number;
  readonly assetRetentionDays: number;
  readonly maxFlightsPerIp: number;
  readonly trustProxy: boolean;
  readonly cacheMarkersEnabled: boolean;
  readonly sessionTtlHours: number;
  readonly sidebarIconDataUrl: string | null;
  readonly tokenSaverEnabled: boolean;
  readonly tokenSaverQuality: "lite" | "balanced" | "extreme";
  readonly headroomEnabled: boolean;
  readonly headroomUrl: string | null;
  readonly headroomTimeoutMs: number;
  readonly ponytailEnabled: boolean;
  readonly filterRulesEnabled: boolean;
}

/** Full settings snapshot — contains secrets; never returned by HTTP views. */
export interface SettingsSnapshot {
  readonly passwordHash: string | null;
  readonly passwordVersion: number;
  readonly jwtSecret: string;
  readonly runtime: ConsoleRuntimeSettings;
  readonly initializedAt: string;
  readonly updatedAt: string;
}

/** Safe settings view exposed to the dashboard. */
export interface SettingsView {
  readonly hasPassword: boolean;
  readonly passwordVersion: number;
  readonly runtime: ConsoleRuntimeSettings;
  readonly updatedAt: string;
}

export interface SettingsRepository {
  get(): Promise<SettingsSnapshot>;
  patchRuntime(patch: Partial<ConsoleRuntimeSettings>): Promise<ConsoleRuntimeSettings>;
  setPasswordHash(hash: string): Promise<void>;
  bumpPasswordVersion(): Promise<void>;
}

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

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Enabled/config state for a registered provider. */
export interface ProviderConfigView {
  readonly id: string;
  readonly enabled: boolean;
}

export interface ProviderRoutingSettings {
  readonly strategy: "priority" | "round-robin";
  readonly stickyLimit: number;
  readonly useStickyLimit: boolean;
}

export interface ProviderConfigRepository {
  list(): Promise<readonly ProviderConfigView[]>;
  get(id: string): Promise<ProviderConfigView | null>;
  setEnabled(id: string, enabled: boolean): Promise<ProviderConfigView | null>;
  getRouting(id: string): Promise<ProviderRoutingSettings>;
  setRouting(id: string, patch: Partial<ProviderRoutingSettings>): Promise<ProviderRoutingSettings>;
}

export type CustomProviderKind = "openai" | "anthropic" | "openai-compatible";

/** Custom provider row — never carries the credential in views. */
export interface CustomProviderView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: CustomProviderKind;
  readonly baseUrl: string;
  readonly credentialHint: string;
  readonly timeoutSeconds: number;
  readonly autoFetchModels: boolean;
  readonly customHeaders: Readonly<Record<string, string>>;
  readonly models: readonly unknown[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomProviderCreateInput {
  readonly name: string;
  readonly kind: CustomProviderKind;
  readonly slug: string;
  readonly baseUrl: string;
  readonly credential?: string;
  readonly timeoutSeconds?: number;
  readonly autoFetchModels?: boolean;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface CustomProviderUpdateInput {
  readonly name?: string;
  readonly kind?: CustomProviderKind;
  readonly slug?: string;
  readonly baseUrl?: string;
  readonly credential?: string;
  readonly timeoutSeconds?: number;
  readonly autoFetchModels?: boolean;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
}

export interface CustomProviderRepository {
  list(): Promise<readonly CustomProviderView[]>;
  get(id: string): Promise<CustomProviderView | null>;
  create(input: CustomProviderCreateInput): Promise<CustomProviderView | { readonly error: "duplicate" }>;
  update(id: string, patch: CustomProviderUpdateInput): Promise<CustomProviderView | null>;
  remove(id: string): Promise<boolean>;
  updateModels(id: string, models: readonly unknown[]): Promise<CustomProviderView | null>;
  /** Explicit credential endpoint contract. */
  credential(id: string): Promise<{ readonly credential: string } | null>;
}

/** Built-in provider with its config state, as shown in console lists. */
export interface ProviderSummaryView {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly credentialKind: CredentialKind;
  readonly credentialKinds: readonly CredentialKind[];
  readonly credentialUrl: string | null;
  readonly surfaces: readonly Surface[];
  readonly enabled: boolean;
  readonly custom: boolean;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A provider model with its persisted enabled state. */
export type ModelSource = "built-in" | "manual" | "imported";

export interface ModelView {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly source: ModelSource;
  readonly images?: boolean;
  /** Normalized metadata from the canonical catalog source; absent when unknown. */
  readonly metadata?: ModelMetadata;
}

export interface ModelRepository {
  list(providerId: string): Promise<readonly ModelView[]>;
  get(providerId: string, modelId: string): Promise<ModelView | null>;
  setEnabled(providerId: string, modelId: string, enabled: boolean): Promise<ModelView | null>;
  setAllEnabled(providerId: string, enabled: boolean): Promise<void>;
  saveCatalog(providerId: string, models: readonly ProviderModel[]): Promise<void>;
  delete(providerId: string, modelId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface AccountQuotaWindowView {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
}

export interface AccountQuotaView {
  readonly source: string;
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly plan: string | null;
  readonly windows: readonly AccountQuotaWindowView[];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
}

export function quotaViewFromState(state: QuotaSnapshotState | null | undefined, nowAttemptAt: string | null = null): AccountQuotaView | null {
  if (state === null || state === undefined) return null;
  return { ...state, lastAttemptAt: state.lastAttemptAt ?? nowAttemptAt };
}

/** Account row with its bounded health snapshot and quota view (repo join). */
export interface AccountRowView {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly credentialKind: CredentialKind;
  readonly credentialHint: string;
  readonly priority: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly health: RouteHealth | null;
  readonly quota: AccountQuotaView | null;
}

export interface AccountCreateInput {
  readonly providerId: string;
  readonly name: string;
  readonly credentialKind: CredentialKind;
  readonly credential: string;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface AccountUpdateInput {
  readonly name?: string;
  readonly credentialKind?: CredentialKind;
  readonly credential?: string;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface ActiveAccountCredential {
  readonly credential: string;
  readonly credentialKind: CredentialKind;
}

/**
 * Keyset pagination for the console accounts endpoint. `cursor` is the last
 * account id of the previous page; results resume with `WHERE id > cursor`.
 * When omitted, `list` returns the full provider set (routing/summary callers).
 */
export interface AccountListOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Paged account list result for the console accounts endpoint. */
export interface AccountListResult {
  readonly items: readonly AccountRowView[];
  readonly nextCursor: string | null;
}

export interface AccountRepository {
  list(providerId?: string): Promise<readonly AccountRowView[]>;
  /** Keyset-paged listing for the console accounts endpoint. */
  listPaged(providerId: string, options: AccountListOptions): Promise<AccountListResult>;
  get(id: string): Promise<AccountRowView | null>;
  create(input: AccountCreateInput): Promise<{ readonly id: string; readonly credentialHint: string }>;
  update(id: string, patch: AccountUpdateInput): Promise<AccountRowView | null>;
  remove(id: string): Promise<boolean>;
  /** Batch delete by IDs — returns count of deleted rows. */
  removeBatch(ids: readonly string[]): Promise<number>;
  /** Batch set active flag — returns count of updated rows. */
  setActiveBatch(ids: readonly string[], active: boolean): Promise<number>;
  /** Explicit credential endpoint contract. */
  credential(id: string): Promise<{ readonly credential: string } | null>;
  /** Active credentials with their kind, for server-side model discovery. */
  listActiveCredentials(providerId: string): Promise<readonly ActiveAccountCredential[]>;
  health(accountId: string): Promise<RouteHealth | null>;
  quota(accountId: string): Promise<AccountQuotaView | null>;
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

export type ProxyProtocol = "http" | "https" | "socks5";

/** Proxy row with its bounded health snapshot (repo join). */
export interface ProxyRowView {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly isRelay: boolean;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly passwordHint: string | null;
  readonly maxConcurrency: number;
  readonly priority: number;
  readonly weight: number;
  readonly active: boolean;
  readonly lastTestAt: string | null;
  readonly lastTestSuccessAt: string | null;
  readonly lastTestSuccessLatencyMs: number | null;
  readonly lastTestErrorAt: string | null;
  readonly lastTestError: string | null;
  readonly lastTestStatusCode: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly health: RouteHealth | null;
}

export interface ProxyCreateInput {
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly isRelay?: boolean;
  readonly host: string;
  readonly port: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly maxConcurrency?: number;
  readonly priority?: number;
  readonly weight?: number;
  readonly active?: boolean;
}

export interface ProxyUpdateInput {
  readonly name?: string;
  readonly protocol?: ProxyProtocol;
  readonly isRelay?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly maxConcurrency?: number;
  readonly priority?: number;
  readonly weight?: number;
  readonly active?: boolean;
}

export interface ProxyRepository {
  list(): Promise<readonly ProxyRowView[]>;
  get(id: string): Promise<ProxyRowView | null>;
  create(input: ProxyCreateInput): Promise<{ readonly id: string; readonly passwordHint: string | null }>;
  update(id: string, patch: ProxyUpdateInput): Promise<ProxyRowView | null>;
  remove(id: string): Promise<boolean>;
  /** Explicit credential endpoint contract. */
  credential(id: string): Promise<{ readonly password: string | null } | null>;
  health(proxyId: string): Promise<RouteHealth | null>;
  setHealth(proxyId: string, health: RouteHealth): Promise<void>;
  recordTest(proxyId: string, result: { readonly testedAt: string; readonly ok: boolean; readonly latencyMs: number | null; readonly statusCode: number | null; readonly error: string | null }): Promise<void>;
}

export interface ProxyTestInput {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly isRelay?: boolean;
}

export interface ProxyTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly statusCode?: number;
  readonly error?: string;
}

export interface ProxySettingsView {
  readonly enabled: boolean;
  readonly excludedProviders: readonly string[];
  readonly smartDynamicRouting: boolean;
  readonly stickyProxyCount: number;
  readonly routingPreset: RoutingPreset;
  readonly targetConcurrent: number;
}

export interface ProxySettingsRepository {
  get(): Promise<ProxySettingsView>;
  patch(patch: Partial<ProxySettingsView>): Promise<ProxySettingsView>;
}

// ---------------------------------------------------------------------------
// Aliases and combos
// ---------------------------------------------------------------------------

export interface AliasView {
  readonly alias: string;
  readonly model: string;
  readonly createdAt: string;
  /** Resolved metadata of the alias target; absent when unresolvable. */
  readonly metadata?: ResolvedModelMetadata;
}

export interface ComboView {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
  readonly strategy: "fallback" | "round-robin";
  readonly stickyLimit: number;
  /** Aggregated metadata of combo members; absent when unresolvable. */
  readonly metadata?: ResolvedModelMetadata;
}

export interface ComboInput {
  readonly name: string;
  readonly models: readonly string[];
  readonly strategy: "fallback" | "round-robin";
  readonly stickyLimit: number;
}

export interface RoutingConfigRepository {
  listAliases(): Promise<readonly AliasView[]>;
  putAlias(alias: string, model: string): Promise<AliasView>;
  deleteAlias(alias: string): Promise<boolean>;
  listCombos(): Promise<readonly ComboView[]>;
  getCombo(id: string): Promise<ComboView | null>;
  putCombo(input: ComboInput): Promise<ComboView>;
  deleteCombo(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Filter rules — pre-request content sanitizer patterns
// ---------------------------------------------------------------------------

export interface FilterRuleView {
  readonly id: number;
  readonly ruleId: string;
  readonly pattern: string;
  readonly replacement: string;
  readonly isActive: boolean;
  readonly isRegex: boolean;
  readonly sortOrder: number;
}

export interface FilterRuleInput {
  readonly ruleId?: string;
  readonly pattern: string;
  readonly replacement?: string;
  readonly isRegex?: boolean;
  readonly isActive?: boolean;
}

export interface FilterRulePatch {
  readonly pattern?: string;
  readonly replacement?: string;
  readonly isRegex?: boolean;
  readonly isActive?: boolean;
  readonly sortOrder?: number;
}

export interface FilterRuleRepository {
  list(): Promise<readonly FilterRuleView[]>;
  listSync(): readonly FilterRuleView[];
  create(input: FilterRuleInput): Promise<FilterRuleView>;
  update(id: number, patch: FilterRulePatch): Promise<FilterRuleView | null>;
  remove(id: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// IP bans
// ---------------------------------------------------------------------------

export interface IpBanView {
  readonly ip: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface IpBanRepository {
  list(): Promise<readonly IpBanView[]>;
  add(ip: string, reason?: string): Promise<IpBanView>;
  remove(ip: string): Promise<boolean>;
  isBanned(ip: string): Promise<boolean>;
  bannedSet(): Promise<ReadonlySet<string>>;
}

// ---------------------------------------------------------------------------
// Runtime metadata (read-only)
// ---------------------------------------------------------------------------

export interface RequestHistoryFilters {
  readonly period?: UsagePeriod;
  readonly providerId?: string;
  readonly model?: string;
  readonly apiKeyId?: string;
  readonly status?: "ok" | "error";
  readonly limit?: number;
  readonly cursor?: string;
  readonly clientIp?: string;
}

export interface RequestHistoryRow {
  readonly requestId: string;
  readonly endpoint: string;
  readonly surface: string;
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly clientIp?: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly statusCode: number;
  readonly errorKind: string | null;
  readonly mode: "non_stream" | "stream";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly usageSource: string;
  readonly clientName: string;
  readonly clientSource: string;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
  readonly tfftMs: number | null;
  readonly payloads?: {
    readonly clientRequest: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
    readonly providerRequest: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
    readonly providerResponse: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
    readonly clientResponse: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
  } | null;
}

export interface UsageSummaryView {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
  readonly errors: number;
  readonly avgDurationMs: number;
  readonly estimatedCostUsd: number;
  readonly partial: boolean;
}

export interface ProviderTodayView {
  readonly providerId: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly errors: number;
}

export interface IpSummaryView {
  readonly ip: string;
  readonly requests: number;
  readonly errors: number;
  readonly lastRequestAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ConsoleLogLine {
  readonly id: number;
  readonly ts: string;
  readonly level: string;
  readonly scope: string;
  readonly msg: string;
}

/** Compact model-probe metadata — never prompt, thinking, body, tool, or image content. */
export interface ModelProbeMetadata {
  readonly providerId: string;
  readonly model: string;
  readonly credentialMode: "auto" | "account" | "manual";
  readonly ok: boolean;
  readonly mode: "stream" | "non_stream" | null;
  readonly latencyMs: number;
  readonly errorKind: string | null;
  readonly occurredAt: string;
}

export interface RuntimeMetadataRepository {
  queryRequests(filters: RequestHistoryFilters): Promise<{ readonly items: readonly RequestHistoryRow[]; readonly nextCursor: string | null }>;
  getRequest(requestId: string): Promise<RequestHistoryRow | null>;
  queryUsageSummary(period: UsagePeriod): Promise<UsageSummaryView>;
  queryUsageCache(period: UsagePeriod): Promise<UsageCacheSummary>;
  queryUsageChart(period: UsagePeriod): Promise<readonly ChartBucket[]>;
  queryUsageBy(dimension: UsageDimension, period: UsagePeriod): Promise<readonly UsageByRow[]>;
  queryModelTokenTotals(period: UsagePeriod): Promise<readonly ModelTokenTotalsRow[]>;
  queryProviderToday(): Promise<readonly ProviderTodayView[]>;
  queryLastProviderError(providerId: string): Promise<string | null>;
  queryIpSummary(limit: number): Promise<readonly IpSummaryView[]>;
  sumKeyTokens(keyId: string): Promise<{ readonly dailyUsed: number; readonly allTimeUsed: number }>;
  queryLogs(limit: number): Promise<readonly ConsoleLogLine[]>;
  clearLogs(): Promise<void>;
  recordModelProbe(meta: ModelProbeMetadata): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

export interface BackupRepository {
  exportBackup(): BackupPayload;
  restore(validation: Extract<RestoreValidation, { ok: true }>): RestoreResult;
}

export interface BackupActionResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code: ConsoleErrorCode | null;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Route switch metadata
// ---------------------------------------------------------------------------

/**
 * Bounded log of account/proxy switch events so console diagnostics can show
 * the failed route and the replacement route as separate values. The data
 * plane records switches here through the same interface; the log is capped
 * to a fixed ring so it can never grow without bound.
 */
export interface RouteTransitionStore {
  record(scope: RouteScope, routeId: string, event: RouteSwitch): Promise<void>;
  latest(scope: RouteScope, routeId: string): Promise<RouteSwitch | null>;
}

/**
 * Failed/replacement route view for one route. `failedRoute` keeps the
 * failed route's identity and last bounded error; `replacementRoute` names
 * the separate current selection. Never overwrites the failure with a
 * generic healthy state.
 */
export interface RouteTransitionView {
  readonly failedRoute: { readonly id: string; readonly scope: RouteScope; readonly health: RouteHealth | null } | null;
  readonly replacementRoute: { readonly id: string; readonly scope: RouteScope } | null;
  readonly switchEvent: RouteSwitch | null;
}

export async function loadRouteTransition(
  scope: RouteScope,
  routeId: string,
  _health: RouteHealth | null,
  store: RouteTransitionStore,
): Promise<RouteTransitionView> {
  const event = await store.latest(scope, routeId);
  if (event === null) return { failedRoute: null, replacementRoute: null, switchEvent: null };
  return {
    failedRoute:
      event.previousRouteId !== null && event.previousRouteId !== routeId
        ? { id: event.previousRouteId, scope, health: null }
        : null,
    replacementRoute:
      event.replacementRouteId !== null && event.replacementRouteId !== routeId
        ? { id: event.replacementRouteId, scope }
        : null,
    switchEvent: event,
  };
}

// ---------------------------------------------------------------------------
// Repository bundle
// ---------------------------------------------------------------------------

export interface ConsoleRepositories {
  readonly settings: SettingsRepository;
  readonly keys: ApiKeyRepository;
  readonly providerConfig: ProviderConfigRepository;
  readonly customProviders: CustomProviderRepository;
  readonly models: ModelRepository;
  readonly accounts: AccountRepository;
  /** Durable OAuth token persistence (current main storage, `provider_accounts.credential`). */
  readonly oauthTokens: OAuthTokenStore;
  /** Durable normalized quota snapshots and refresh timestamps. */
  readonly quotaState: QuotaStateStore;
  readonly proxies: ProxyRepository;
  readonly proxySettings: ProxySettingsRepository;
  readonly routing: RoutingConfigRepository;
  readonly filterRules: FilterRuleRepository;
  readonly backup: BackupRepository;
  readonly runtimeMetadata: RuntimeMetadataRepository;
  readonly transitions: RouteTransitionStore;
}

// Re-export model metadata resolver for callers that previously reached it via services.
export type { ModelMetadataResolver, ResolvedModelMetadata };
