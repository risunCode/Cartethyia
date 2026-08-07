import type { CredentialKind, Adapter } from "../domain/contracts";
import type { AccountCandidate, AffinityKey, ModelLockRecord, RouteCandidate, RouteSwitch } from "../domain/contracts";
import type { ProxyRequest } from "../domain/contracts";
import { AccountHealthManager, AnthropicOAuthDriver, AntigravityOAuthDriver, ClineOAuthDriver, ClinePassOAuthDriver, createAuthDriverRegistry, GrokBuildOAuthDriver, KimchiOAuthDriver, KiroOAuthDriver } from "../auth";
import { QuotaCoordinator } from "../auth";
import { CredentialSelector } from "../auth";
import { OAuthCoordinator } from "../auth";
import { createDriverAwareOAuthRefresher, createEnvOAuthRefresher } from "../auth";
import { OAuthKeepalive } from "../auth/oauth-keepalive";
import { AccountRecoverySweep } from "../open-sse/shaping/recovery-sweep";
import type { AccountConfig, CredentialConfigStore, OAuthTokenRecord } from "../auth";
import type { ApplicationErrorKind } from "../domain/contracts";
import type { ProxyHealthRecord, ProxyHealthStore } from "../traffic";
import { createConfigPersistence, createRuntimePersistence, type ConfigPersistence, type RuntimePersistence } from "../storage";
import { ProxyHealthManager } from "../traffic";
import { NetworkSelector, type NetworkRoutingPolicy } from "../traffic";
import { ProxyPool } from "../traffic";
import { createDefaultRegistry, ProviderRegistry } from "../providers/registry";
import { syncCustomAdapters } from "../providers/custom";
import { resolveWireSurface } from "../open-sse/translate";
import { resolveModelChain } from "../domain/routing";
import { resolveModelMetadata, type ModelMetadataLookup, type ModelMetadataResolver, type ResolvedModelMetadata } from "../domain/model-metadata";
import { createRouteSnapshotCache, type RouteSnapshotCache } from "./routing-snapshot";
import type { AccountRepository, AliasRepository, ComboRepository, CustomProviderRecord, CustomProviderRepository, ProxyRepository } from "../storage";
import { createConsoleApi } from "../console/api";
import { createConsoleLogStreamHub } from "../console/streams";
import { ConsoleDiagnostics } from "../console/diagnostics";
import { createConsoleServices } from "../console/services";
import { createConsoleRepositories } from "../console/wiring";
import { runtimeSettings } from "../console/runtime-settings";
import { probeProviderModel } from "../console/probe";
import { ApiKeyAdmission } from "../traffic/admission";
import { scheduleGlobalGc, cancelScheduledGc } from "../traffic/memory";
import { getInFlightCount } from "../traffic/in-flight";
import { activePerIpFlights } from "../traffic/per-ip";
import { runtimeMemoryLimits } from "../traffic/limits";
import { Elysia } from "elysia";
import { runProxyRequest, type ProxyRequestDependencies, type ProxyRequestLogEvent, type ProxyRoutePlan } from "./request";

export interface CartethyiaRuntime {
  readonly config: ConfigPersistence;
  readonly runtime: RuntimePersistence;
  readonly registry: ProviderRegistry;
  readonly proxy: ProxyRequestDependencies;
  readonly consoleApp: { readonly handle: (request: Request) => Response | Promise<Response> };
  /** Canonical model metadata: sync per-model lookup + async name resolution. */
  readonly models: ModelMetadataResolver;
  readonly close: () => void;
}

function applicationKind(value: string | null): ApplicationErrorKind | null {
  const kinds: readonly ApplicationErrorKind[] = ["invalid_request", "authentication_failed", "authorization_denied", "quota_exceeded", "concurrency_exceeded", "model_not_found", "capability_unsupported", "credential_unavailable", "network_unavailable", "provider_rate_limited", "provider_unavailable", "provider_protocol_error", "stream_timeout", "stream_truncated", "client_aborted", "internal_error"];
  return value === null ? null : kinds.find((kind) => kind === value) ?? null;
}

function requestLogLevel(event: ProxyRequestLogEvent): "info" | "warn" | "error" {
  if (event.event === "failed") return "error";
  if (event.event === "incoming") return "info";
  if (event.status !== null && event.status >= 500) return "error";
  if (event.status !== null && event.status >= 400) return "warn";
  return "info";
}

function requestPrivacyMode(config: ConfigPersistence): "masked" | "full" {
  return runtimeSettings(config).privacyMode;
}

function maskIp(value: string | null): string {
  if (value === null || value.length === 0) return "unknown";
  if (value.includes(":")) {
    const segments = value.split(":").filter((segment) => segment.length > 0);
    return segments.length > 1 ? `${segments.slice(0, 3).join(":")}::*` : "masked";
  }
  const segments = value.split(".");
  return segments.length === 4 ? `${segments.slice(0, 3).join(".")}.xxx` : "masked";
}

function formatRequestLog(event: ProxyRequestLogEvent, privacyMode: "masked" | "full"): string {
  const ip = privacyMode === "full" ? event.clientIp ?? "unknown" : maskIp(event.clientIp);
  const parts = [
    `${event.event} request`,
    `endpoint=${event.endpoint}`,
    ...(event.providerId === null ? [] : [`provider=${event.providerId}`]),
    ...(event.model === null ? [] : [`model=${event.model}`]),
    `client=${event.clientName}/${event.clientSource}`,
    `request_id=${event.requestId}`,
    `ip=${ip}`,
    `messages=${event.messageCount}`,
    `tools=${event.toolCount}`,
  ];
  if (event.status !== null) parts.push(`status=${event.status}`);
  if (event.event !== "incoming") {
    parts.push(`${Math.round(event.durationMs)}ms`);
    if (event.inputTokens !== null) parts.push(`in=${event.inputTokens}`);
    if (event.outputTokens !== null) parts.push(`out=${event.outputTokens}`);
    if (event.cachedTokens !== null && event.cachedTokens > 0) parts.push(`cached=${event.cachedTokens}`);
    if (event.cacheWriteTokens !== null && event.cacheWriteTokens > 0) parts.push(`cache_write=${event.cacheWriteTokens}`);
  }
  return parts.join(" ");
}

async function accountCandidates(cache: RouteSnapshotCache, health: AccountHealthManager, quota: QuotaCoordinator, providerId: string): Promise<readonly AccountCandidate[]> {
  const snapshot = await cache.get();
  const stored: Array<{ readonly id: string; readonly providerId: string; readonly credentialKind: CredentialKind; readonly active: boolean }> = (snapshot.accountsByProvider.get(providerId) ?? []).map((row) => ({ id: row.id, providerId: row.providerId, credentialKind: row.credentialKind, active: row.active }));
  const envVariables: readonly string[] = providerId === "openai"
    ? ["OPENAI_API_KEY"]
    : providerId === "anthropic"
      ? ["ANTHROPIC_API_KEY"]
      : providerId === "gemini"
        ? ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
        : [];
  for (const variable of envVariables) {
    if (process.env[variable]) stored.push({ id: `env-${providerId}-${variable.toLowerCase()}`, providerId, credentialKind: "api_key", active: true });
  }
  if (stored.length === 0) return [];
  // Batch: 3 queries total regardless of account count (was 3×N individual queries).
  const accountIds = stored.map((row) => row.id);
  const [healthMap, lockMap, quotaMap] = await Promise.all([
    health.getHealthBatch(accountIds),
    health.listModelLocksForAccounts(accountIds),
    quota.getQuotaAvailableBatch(accountIds),
  ]);
  return stored.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    credentialKind: row.credentialKind,
    health: healthMap.get(row.id) ?? null,
    enabled: row.active,
    quotaAvailable: quotaMap.get(row.id) ?? true,
    modelLocks: lockMap.get(row.id) ? new Map((lockMap.get(row.id) as readonly ModelLockRecord[]).map((lock) => [lock.modelId, lock])) : null,
  }));
}

function envCredentialStore(config: ConfigPersistence): CredentialConfigStore {
  const env = process.env;
  const direct = new Map<string, AccountConfig>();
  const add = (providerId: string, variable: string, suffix = variable.toLowerCase()): void => {
    const secret = env[variable];
    if (!secret) return;
    const id = `env-${providerId}-${suffix}`;
    direct.set(id, { id, providerId, kind: "api_key", secret, enabled: true, priority: -100 });
  };
  add("openai", "OPENAI_API_KEY");
  add("anthropic", "ANTHROPIC_API_KEY");
  add("gemini", "GEMINI_API_KEY");
  add("gemini", "GOOGLE_API_KEY");
  // Custom provider API keys use the same provider account repository as
  // built-in providers. The legacy provider-level credential remains a
  // backwards-compatible fallback until an operator adds account rows.
  const customAccount = (record: CustomProviderRecord): AccountConfig => {
    const id = `custom:${record.slug}`;
    return { id, providerId: record.slug, kind: "api_key", secret: record.credential, enabled: true, priority: 0 };
  };
  return {
    async getAccount(id: string): Promise<AccountConfig | undefined> {
      const value = direct.get(id);
      if (value) return value;
      if (id.startsWith("custom:")) {
        const record = config.customProviders.getBySlug(id.slice("custom:".length));
        return record === null ? undefined : customAccount(record);
      }
      return config.stores.credentialConfig.getAccount(id);
    },
    async listAccounts(): Promise<readonly AccountConfig[]> {
      const stored = await config.stores.credentialConfig.listAccounts();
      const customProviders = config.customProviders.list();
      const customSlugs = new Set(customProviders.map((provider) => provider.slug));
      const customAccounts = stored.filter((account) => customSlugs.has(account.providerId));
      const configuredCustomProviders = new Set(customAccounts.map((account) => account.providerId));
      const fallbacks = customProviders.filter((provider) => !configuredCustomProviders.has(provider.slug)).map(customAccount);
      return [...stored, ...direct.values(), ...fallbacks];
    },
  };
}

function routeResolver(registry: ProviderRegistry, cache: RouteSnapshotCache, health: AccountHealthManager, quota: QuotaCoordinator): (request: ProxyRequest, affinity: AffinityKey) => Promise<ProxyRoutePlan> {
  return async (request, affinity) => {
    const snapshot = await cache.get();
    const chain = resolveModelChain(request.model, { prefixes: snapshot.prefixes, aliases: snapshot.aliases, combos: snapshot.combos }, affinity);
    const resolved = chain.kind === "qualified" ? [chain.model] : chain.kind === "combo" ? chain.candidates : [];
    const candidates: RouteCandidate[] = [];
    for (const target of resolved) {
      const adapter = registry.get(target.providerId);
      if (adapter === null) continue;
      // Curated catalogs gate model ids; catalog-less adapters (routers,
      // local servers, and custom providers) intentionally accept arbitrary
      // upstream ids, matching their adapter-level resolveTarget contract.
      // DB-stored fetched/custom models supplement the adapter catalog so
      // they pass the gate without a server restart.
      const dbKnown = snapshot.knownModelIds.get(target.providerId);
      const known = adapter.models.list.length === 0 || adapter.models.get(target.modelId) !== null || (dbKnown !== undefined && dbKnown.has(target.modelId));
      if (!known || resolveWireSurface(adapter.metadata, adapter.capabilities, request.sourceSurface) === null) continue;
      candidates.push({
        id: `${target.providerId}/${target.modelId}`,
        providerId: target.providerId,
        modelId: target.modelId,
        surface: request.sourceSurface,
        health: null,
        enabled: true,
        authorized: true,
        compatible: true,
      });
    }
    // Bare model ID fallback: when the chain couldn't resolve the model
    // (no prefix, no alias, no combo), search every adapter's catalog and
    // DB-known models for an exact match.  This lets clients send just the
    // model id (e.g. "blackbox-pro") without a provider prefix.
    if (candidates.length === 0 && chain.kind === "unresolved") {
      for (const adapter of registry.list()) {
        if (resolveWireSurface(adapter.metadata, adapter.capabilities, request.sourceSurface) === null) continue;
        const dbKnown = snapshot.knownModelIds.get(adapter.metadata.id);
        const known = adapter.models.get(request.model) !== null || (dbKnown !== undefined && dbKnown.has(request.model));
        if (!known) continue;
        candidates.push({
          id: `${adapter.metadata.id}/${request.model}`,
          providerId: adapter.metadata.id,
          modelId: request.model,
          surface: request.sourceSurface,
          health: null,
          enabled: true,
          authorized: true,
          compatible: true,
        });
      }
    }
    return { affinity, candidates, requestedModel: request.model };
  };
}

/**
 * Monotonic revision of routing-relevant configuration. Every console
 * mutation that flows through the wrapped repositories below increments it;
 * the route snapshot cache rebuilds only when this counter moves, so the
 * data plane never re-reads routing config per request.
 */
const routingRevision = { value: 0 };

function withRoutingRevisionTracking(config: ConfigPersistence, registry: ProviderRegistry, proxyPool?: ProxyPool): ConfigPersistence {
  const bump = (): void => {
    routingRevision.value += 1;
  };
  const invalidateProxyCache = (): void => proxyPool?.invalidate();
  const aliases: AliasRepository = {
    ...config.aliases,
    upsert: (alias, model) => {
      const record = config.aliases.upsert(alias, model);
      bump();
      return record;
    },
    delete: (alias) => {
      const deleted = config.aliases.delete(alias);
      bump();
      return deleted;
    },
  };
  const combos: ComboRepository = {
    ...config.combos,
    upsert: (input) => {
      const record = config.combos.upsert(input);
      bump();
      return record;
    },
    delete: (id) => {
      const deleted = config.combos.delete(id);
      bump();
      return deleted;
    },
  };
  const proxies: ProxyRepository = {
    ...config.proxies,
    create: (input) => {
      const record = config.proxies.create(input);
      bump();
      invalidateProxyCache();
      return record;
    },
    patch: (id, patch) => {
      const record = config.proxies.patch(id, patch);
      bump();
      invalidateProxyCache();
      return record;
    },
    delete: (id) => {
      const deleted = config.proxies.delete(id);
      bump();
      invalidateProxyCache();
      return deleted;
    },
    patchSettings: (patch) => {
      const record = config.proxies.patchSettings(patch);
      bump();
      invalidateProxyCache();
      return record;
    },
  };
  const accounts: AccountRepository = {
    ...config.accounts,
    create: (input) => {
      const record = config.accounts.create(input);
      bump();
      return record;
    },
    patch: (id, patch) => {
      const record = config.accounts.patch(id, patch);
      bump();
      return record;
    },
    delete: (id) => {
      const deleted = config.accounts.delete(id);
      bump();
      return deleted;
    },
  };
  const customProviders: CustomProviderRepository = {
    ...config.customProviders,
    upsert: (input) => {
      const record = config.customProviders.upsert(input);
      bump();
      syncCustomAdapters(registry, config.customProviders);
      return record;
    },
    delete: (id) => {
      const deleted = config.customProviders.delete(id);
      if (deleted) {
        bump();
        syncCustomAdapters(registry, config.customProviders);
      }
      return deleted;
    },
    updateModels: (id, models) => {
      const record = config.customProviders.updateModels(id, models);
      if (record !== null) {
        bump();
        syncCustomAdapters(registry, config.customProviders);
      }
      return record;
    },
  };
  const providerModels = {
    list: (provider: string) => config.providerModels.list(provider),
    get: (provider: string, modelId: string) => config.providerModels.get(provider, modelId),
    upsert: (provider: string, modelId: string, input: { enabled?: boolean; source?: string }) => {
      const record = config.providerModels.upsert(provider, modelId, input);
      bump();
      return record;
    },
    delete: (provider: string, modelId: string) => {
      const deleted = config.providerModels.delete(provider, modelId);
      bump();
      return deleted;
    },
  };
  return { ...config, aliases, combos, proxies, accounts, customProviders, providerModels };
}

export async function createCartethyiaRuntime(): Promise<CartethyiaRuntime> {
  const baseConfig = createConfigPersistence();
  const registry = await createDefaultRegistry();
  const pool = new ProxyPool(baseConfig.stores.proxyPool);
  const config = withRoutingRevisionTracking(baseConfig, registry, pool);
  // Register configured custom providers (their adapters are keyed by slug);
  // later console mutations go through the tracked repository wrapper above.
  syncCustomAdapters(registry, config.customProviders);
  const runtime = createRuntimePersistence(config.env);
  const accountHealth = new AccountHealthManager(config.stores.accountHealth, {}, config.stores.modelLocks);
  const quota = new QuotaCoordinator(config.stores.quotaState);
  const routeSnapshots = createRouteSnapshotCache({ config, registry, readRevision: () => routingRevision.value });
  // Canonical normalized model metadata: catalog models carry their static
  // context/categories/pricing; custom-provider models are tagged "custom"
  // with the provider record's updatedAt. Unknown models resolve to null and
  // are treated permissively — limits/prices are never fabricated.
  const modelMetadataLookup: ModelMetadataLookup = (providerId, modelId) => {
    const adapter = registry.get(providerId);
    if (adapter === null) return null;
    const model = adapter.models.get(modelId);
    const custom = config.customProviders.getBySlug(providerId);
  const ctx = model?.context ?? { inputTokens: null, outputTokens: null };
  const price = model?.pricing ?? { inputPerMillion: null, outputPerMillion: null };
  return {
    context: {
      inputTokens: ctx.inputTokens ?? null,
      outputTokens: ctx.outputTokens ?? null,
    },
    categories: model?.categories ?? [],
    pricing: {
      inputPerMillion: price.inputPerMillion ?? null,
      outputPerMillion: price.outputPerMillion ?? null,
    },
    source: custom !== null ? "custom" : "catalog",
    updatedAt: custom !== null ? custom.updatedAt : null,
  };
};
  const modelMetadata: ModelMetadataResolver = {
    lookup: modelMetadataLookup,
    resolve: async (rawModel: string): Promise<ResolvedModelMetadata | null> => {
      const snapshot = await routeSnapshots.get();
      return resolveModelMetadata(rawModel, { prefixes: snapshot.prefixes, aliases: snapshot.aliases, combos: snapshot.combos }, modelMetadataLookup);
    },
  };
  const proxyHealthStore: ProxyHealthStore = {
    async get(proxyId) {
      const health = await config.stores.routeHealth.readHealth("proxy", proxyId);
      if (health === null) return undefined;
      return { proxyId, status: health.status, statusCode: health.statusCode, failureKind: applicationKind(health.failureKind), sanitizedMessage: health.sanitizedMessage, occurredAt: health.occurredAt, retryAt: health.retryAt, disabledUntilMs: health.retryAt === null ? null : Date.parse(health.retryAt), failureCount: 1, generation: 1 };
    },
    async set(record) {
      await config.stores.routeHealth.writeHealth("proxy", record.proxyId, { scope: "proxy", status: record.status, statusCode: record.statusCode, failureKind: record.failureKind, sanitizedMessage: record.sanitizedMessage, occurredAt: record.occurredAt, retryAt: record.retryAt });
    },
    async list() {
      const records: ProxyHealthRecord[] = [];
      for (const proxy of await config.stores.proxyPool.listProxies()) {
        const record = await this.get(proxy.id);
        if (record) records.push(record);
      }
      return records;
    },
  };
  const proxyHealth = new ProxyHealthManager(proxyHealthStore);
  let policyRevision = -1;
  let policy: NetworkRoutingPolicy = { preset: "auto", targetConcurrent: 0 };
  const readNetworkPolicy = () => {
    if (policyRevision !== routingRevision.value) {
      const settings = config.proxies.getSettings();
      policy = {
        preset: settings?.routingPreset ?? "auto",
        targetConcurrent: settings?.targetConcurrent ?? 0,
      };
      policyRevision = routingRevision.value;
    }
    return policy;
  };
  const network = new NetworkSelector(pool, proxyHealth, readNetworkPolicy);
  const authDrivers = createAuthDriverRegistry([
    { providerId: "kiro", driver: new KiroOAuthDriver() },
    { providerId: "antigravity", driver: new AntigravityOAuthDriver() },
    { providerId: "claude", driver: new AnthropicOAuthDriver() },
    { providerId: "cline", driver: new ClineOAuthDriver() },
    { providerId: "clinepass", driver: new ClinePassOAuthDriver() },
    { providerId: "kimchi", driver: new KimchiOAuthDriver() },
    { providerId: "grok-build", driver: new GrokBuildOAuthDriver() },
  ]);
  const resolveProvider = async (accountId: string): Promise<string | null> => config.accounts.get(accountId)?.provider ?? null;
  const oauthRefresher = createDriverAwareOAuthRefresher({
    drivers: authDrivers,
    resolveProvider,
    fallback: createEnvOAuthRefresher({ resolveProvider }),
  });
  const oauth = new OAuthCoordinator(config.stores.oauthToken, oauthRefresher);
  const credentialStore = envCredentialStore(config);
  const accounts = new CredentialSelector(credentialStore, oauth);
  const admission = new ApiKeyAdmission(config.apiKeys);
  let recordRouteSwitch: ((event: RouteSwitch) => Promise<void>) | undefined;
  let cachedPrivacyMode: "masked" | "full" | undefined;
  const proxy: ProxyRequestDependencies = {
    providers: { get: (providerId: string) => registry.get(providerId) ?? undefined },
    accounts,
    network,
    telemetry: runtime.telemetry,
    onRequestLog: (event) => {
      const privacyMode = cachedPrivacyMode ??= requestPrivacyMode(config);
      runtime.consoleLogs.push(requestLogLevel(event), "request", formatRequestLog(event, privacyMode));
    },
    resolveRoutes: routeResolver(registry, routeSnapshots, accountHealth, quota),
    accountCandidates: (providerId) => accountCandidates(routeSnapshots, accountHealth, quota, providerId),
    admission,
    tokenSaver: () => {
      const { tokenSaverEnabled, tokenSaverQuality } = runtimeSettings(config);
      return { enabled: tokenSaverEnabled, quality: tokenSaverQuality };
    },
    filterRules: (() => {
      let cached: { enabled: boolean; rules: readonly { pattern: string; replacement: string; isRegex: boolean }[] } | undefined;
      return () => {
        if (cached === undefined) {
          const { filterRulesEnabled } = runtimeSettings(config);
          const rows = config.filterRules.listSync();
          cached = { enabled: filterRulesEnabled, rules: rows.filter((rule) => rule.isActive).map((rule) => ({ pattern: rule.pattern, replacement: rule.replacement, isRegex: rule.isRegex })) };
        }
        return cached;
      };
    })(),
    getProviderRouting: (providerId) => {
      const settings = config.settings.getSettingsJson();
      const all = typeof settings.providerRouting === "object" && settings.providerRouting !== null && !Array.isArray(settings.providerRouting) ? settings.providerRouting as Record<string, unknown> : {};
      const stored = typeof all[providerId] === "object" && all[providerId] !== null && !Array.isArray(all[providerId]) ? all[providerId] as Record<string, unknown> : {};
      return {
        strategy: stored.strategy === "round-robin" ? "round-robin" : "priority",
        stickyLimit: typeof stored.stickyLimit === "number" ? Math.max(1, Math.min(100, Math.round(stored.stickyLimit))) : 1,
        useStickyLimit: stored.useStickyLimit === true,
      };
    },
    onRouteFailure: async (candidate, error, selected) => {
      const accountId = selected?.accountId ?? null;
      if (error.routeScope === "account" && accountId) await accountHealth.recordFailure(accountId, candidate.providerId, error);
      // Per-model lock: an error on model A does NOT block model B on the
      // same account. recordModelLock internally skips T2 transient errors
      // (delayMs === 0) and non-retryable errors, so this is safe to call
      // unconditionally for account-scoped failures.
      if (error.routeScope === "account" && accountId && candidate.modelId) await accountHealth.recordModelLock(accountId, candidate.modelId, error);
      const proxyId = selected?.proxyId ?? null;
      if (error.routeScope === "proxy" && proxyId) await proxyHealth.recordFailure(proxyId, error);
    },
    onRouteSuccess: async (candidate, selected) => {
      const accountId = selected?.accountId ?? null;
      if (accountId) {
        await accountHealth.recordSuccess(accountId, candidate.providerId);
        if (candidate.modelId) await accountHealth.clearModelLock(accountId, candidate.modelId);
      }
    },
    onRouteSwitch: async (event) => { await recordRouteSwitch?.(event); },
  };
  const retention = runtime.startRetentionMaintenance();
  const consoleRepositories = createConsoleRepositories(config, runtime, registry);
  recordRouteSwitch = (event) => consoleRepositories.transitions.record(event.scope, event.previousRouteId ?? event.replacementRouteId ?? "unknown", event);
  const consoleServices = createConsoleServices({ repositories: consoleRepositories, registry, authDrivers, modelMetadata, oauthCoordinator: oauth });
  const prefixes = new Map(registry.list().map((adapter) => [adapter.metadata.id, adapter.metadata.id]));
  const diagnostics = new ConsoleDiagnostics({ services: consoleServices, repositories: consoleRepositories, registry, prefixes, runtimeCounters: { inFlight: () => getInFlightCount() } });
  const logStream = createConsoleLogStreamHub({
    latest: (limit) => runtime.consoleLogs.list({ limit }).items,
    after: (afterId, limit) => runtime.consoleLogs.after(afterId, limit),
    onPush: (listener) => runtime.consoleLogs.onPush(listener),
  });
  const consoleApi = createConsoleApi({ services: consoleServices, diagnostics, config: baseConfig, runtime, logStream, probe: probeProviderModel, probePorts: { registry, accounts: credentialStore, credentials: accounts, accountHealth, network }, liveTraffic: { byIp: () => activePerIpFlights.snapshot(), maxFlightsPerIp: () => runtimeSettings(config).maxFlightsPerIp }, proxy, resetConfig: baseConfig.resetAll, resetRuntime: runtime.resetAll });
  const consoleApp = new Elysia()
    .use(consoleApi.app);
  const gcIntervalMs = runtimeMemoryLimits.gcIntervalMs > 0
    ? runtimeMemoryLimits.gcIntervalMs
    : 10 * 60_000; // fallback when adaptive (0) — GC itself defers to idle points anyway
  const gcInterval = setInterval(scheduleGlobalGc, gcIntervalMs);
  gcInterval.unref?.();

  // OAuth keepalive: proactively pre-refresh tokens before expiry so
  // request-time lease() never hits a stale token. Memory-safe: unref'd
  // interval, single-flight per account via OAuthCoordinator, failures
  // are logged but never stop the sweep.
  const oauthKeepalive = new OAuthKeepalive(credentialStore, oauth);
  oauthKeepalive.start();

  // Recovery sweep: transitions expired cooldowns → healthy and clears
  // expired per-model locks that would otherwise linger until a request
  // happens to select the account. unref'd interval — zero per-request
  // overhead, never keeps the process alive.
  const recoverySweep = new AccountRecoverySweep(accountHealth, config.stores.modelLocks);
  recoverySweep.start();

  return { config, runtime, registry, proxy, consoleApp, models: modelMetadata, close: () => { clearInterval(gcInterval); cancelScheduledGc(); retention.stop(); logStream.close(); oauthKeepalive.stop(); recoverySweep.stop(); runtime.close(); config.close(); } };
}

export { runProxyRequest };

// Exposed for direct unit testing of app-composition contracts.
export {
  applicationKind,
  requestLogLevel,
  requestPrivacyMode,
  maskIp,
  formatRequestLog,
  envCredentialStore,
  routeResolver,
  withRoutingRevisionTracking,
};
