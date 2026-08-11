import { AccountHealthManager, QuotaCoordinator } from "../application/auth";
import type { RouteSwitch, WebSearchPreference } from "../application/contracts";
import type { ModelMetadataResolver } from "../application/model-metadata";
import { createRouteSnapshotCache } from "../application/routing-snapshot";
import { compressWithHeadroom } from "../open-sse/rtk";
import { createDefaultRegistry, ProviderRegistry } from "../providers/registry";
import { createApplicationLogger, type ApplicationLogger } from "../console/logger";
import { runtimeSettings } from "../console/runtime-settings";
import { createConfigPersistence, createRuntimePersistence, type ConfigPersistence, type RuntimePersistence } from "../storage";
import { ApiKeyAdmission } from "../traffic/admission";
import { ProxyHealthManager, ProxyPool, type NetworkRoutingPolicy, NetworkSelector, type ProxyHealthRecord, type ProxyHealthStore } from "../traffic";
import { runProxyRequest, type ProxyRequestDependencies } from "../application/request";
import { accountCandidates, applicationKind, formatRequestLog, requestLogLevel, routeResolver, withRoutingRevisionTracking } from "./routing";
import { createModelMetadataResolver } from "./registry";
import { createAccountRecoverySweep, createOAuthRuntime, createQuotaAccountLabel, createQuotaRefreshWorker } from "./workers";
import { createRuntimeLifecycle } from "./lifecycle";
import { createConsoleAssembly } from "./console";
const REQUEST_LOGGING_ENABLED = Bun.env.CARTETHYIA_REQUEST_LOGS !== "0";

export interface CartethyiaRuntime {
  readonly config: ConfigPersistence;
  readonly runtime: RuntimePersistence;
  readonly logger: ApplicationLogger;
  readonly registry: ProviderRegistry;
  readonly proxy: ProxyRequestDependencies;
  /** Monotonic routing/config revision used by all runtime caches. */
  readonly routingRevision: () => number;
  readonly consoleApp: { readonly handle: (request: Request) => Response | Promise<Response> };
  /** Canonical model metadata: sync per-model lookup + async name resolution. */
  readonly models: ModelMetadataResolver;
  readonly close: () => void;
}


export async function createCartethyiaRuntime(): Promise<CartethyiaRuntime> {
  const baseConfig = createConfigPersistence();
  const registry = await createDefaultRegistry();
  const pool = new ProxyPool(baseConfig.stores.proxyPool);
  const revision = { value: 0 };
  const config = withRoutingRevisionTracking(baseConfig, registry, pool, revision);
  // Register configured custom providers (their adapters are keyed by slug);
  // later console mutations go through the tracked repository wrapper above.
  const runtime = createRuntimePersistence(config.env);
  const logger = createApplicationLogger(runtime.consoleLogs);
  const accountHealth = new AccountHealthManager(config.stores.accountHealth, {}, config.stores.modelLocks);
  const quota = new QuotaCoordinator(config.stores.quotaState);
  const routeSnapshots = createRouteSnapshotCache({ config, registry, readRevision: () => revision.value });
  const modelMetadata = createModelMetadataResolver({ config, registry, routeSnapshots });
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
  let webSearchPreferenceRevision = -1;
  let webSearchPreference: WebSearchPreference = "auto";
  const readNetworkPolicy = () => {
    if (policyRevision !== revision.value) {
      const settings = config.proxies.getSettings();
      policy = {
        preset: settings?.routingPreset ?? "auto",
        targetConcurrent: settings?.targetConcurrent ?? 0,
      };
      webSearchPreference = settings?.webSearchPreference ?? "auto";
      policyRevision = revision.value;
      webSearchPreferenceRevision = revision.value;
    }
    return policy;
  };
  const readWebSearchPreference = (): WebSearchPreference => {
    if (webSearchPreferenceRevision !== revision.value) {
      const settings = config.proxies.getSettings();
      webSearchPreference = settings?.webSearchPreference ?? "auto";
      webSearchPreferenceRevision = revision.value;
    }
    return webSearchPreference;
  };
  const network = new NetworkSelector(pool, proxyHealth, readNetworkPolicy);
  const { accounts, authDrivers, credentialStore, oauth } = createOAuthRuntime({ config, logger, routingRevision: () => revision.value });
  const admission = new ApiKeyAdmission(config.apiKeys);
  let recordRouteSwitch: ((event: RouteSwitch) => Promise<void>) | undefined;
  let cachedSettingsJson: Record<string, unknown> | undefined;
  let cachedRuntimeSettings: ReturnType<typeof runtimeSettings> | undefined;
  const readRuntimeSettings = (): ReturnType<typeof runtimeSettings> => {
    const settings = config.settings.getSettingsJson();
    if (cachedRuntimeSettings === undefined || cachedSettingsJson !== settings) {
      cachedSettingsJson = settings;
      cachedRuntimeSettings = runtimeSettings(config);
    }
    return cachedRuntimeSettings;
  };
  const proxy: ProxyRequestDependencies = {
    providers: { get: (providerId: string) => registry.get(providerId) ?? undefined },
    accounts,
    network,
    telemetry: runtime.telemetry,
    onRequestLog: REQUEST_LOGGING_ENABLED
      ? (event) => {
          if (event.event === "incoming") return;
          const privacyMode = readRuntimeSettings().privacyMode;
          logger.request(requestLogLevel(event), formatRequestLog(event, privacyMode));
        }
      : undefined,
    createPayloadCapture: (requestId) => {
      if (readRuntimeSettings().trackPayloads === "none") return null;
      return {
        save: (id, kind, artifact) => runtime.payloads.save(id, kind, artifact),
      };
    },
    resolveRoutes: routeResolver(registry, routeSnapshots, accountHealth, quota, readWebSearchPreference),
    accountCandidates: (providerId) => accountCandidates(routeSnapshots, accountHealth, quota, providerId),
    admission,
    tokenSaver: () => {
      const { tokenSaverEnabled, tokenSaverQuality } = readRuntimeSettings();
      return { enabled: tokenSaverEnabled, quality: tokenSaverQuality };
    },
    headroom: (request) => {
      const settings = readRuntimeSettings();
      return compressWithHeadroom(request, {
        enabled: settings.headroomEnabled,
        url: settings.headroomUrl,
        timeoutMs: settings.headroomTimeoutMs,
        compressUserMessages: true,
      });
    },
    filterRules: (() => {
      let cached: { enabled: boolean; rules: readonly { pattern: string; replacement: string; isRegex: boolean }[] } | undefined;
      let cachedRevision = -1;
      return () => {
        if (cached === undefined || cachedRevision !== revision.value) {
          const { filterRulesEnabled } = readRuntimeSettings();
          const rows = config.filterRules.listSync();
          cached = { enabled: filterRulesEnabled, rules: rows.filter((rule) => rule.isActive).map((rule) => ({ pattern: rule.pattern, replacement: rule.replacement, isRegex: rule.isRegex })) };
          cachedRevision = revision.value;
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
  const { consoleApp, logStream, recordRouteSwitch: recordConsoleRouteSwitch, refreshQuota, warpService } = createConsoleAssembly({
    config,
    baseConfig,
    runtime,
    registry,
    authDrivers,
    modelMetadata,
    oauth,
    proxy,
    credentialStore,
    accounts,
    accountHealth,
    network,
  });
  recordRouteSwitch = recordConsoleRouteSwitch;
  const quotaRefreshWorker = createQuotaRefreshWorker({
    credentialStore,
    quotaState: config.stores.quotaState,
    refreshQuota,
    labelAccount: createQuotaAccountLabel(config, registry),
    logger,
  });

  const recoverySweep = createAccountRecoverySweep(accountHealth, config);
  const { close } = createRuntimeLifecycle({
    retention,
    logStream,
    warpService,
    oauth,
    quotaRefreshWorker,
    recoverySweep,
    runtime,
    config,
  });
  return {
    config,
    runtime,
    logger,
    registry,
    proxy,
    routingRevision: () => revision.value,
    consoleApp,
    models: modelMetadata,
    close,
  };
}

export { runProxyRequest };

