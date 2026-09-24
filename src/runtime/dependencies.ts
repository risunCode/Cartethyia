
import { assertPoolFitsServerCapacity, ensureMigrated, getDb, poolMaxFromEnv } from "../persistence/postgres";
import type { CartethyiaDatabase } from "../persistence/postgres";
import { getRedis } from "../persistence/redis";
import type { RedisClient } from "../persistence/redis";
import { seedBundledProviders, registerByokProviders, liveProviderUpstreamHosts, bundledModelCatalog } from "../providers/operations/provider-catalog-service";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import { createDefaultProviderRegistry } from "../providers/default-registry";
import { OAuthRefreshService, loadDueOAuthAccounts } from "../providers/authentication/oauth-refresh-service";
import type { OAuthTokenRefresher } from "../providers/authentication/oauth-refresh-service";
import { oauthRefreshSweep } from "../workers/oauth-refresh-worker";
import { seedBundledModels } from "../providers/operations/provider-catalog-seeder";
import { createDatabaseSnapshotBuilder } from "../transport/routing/route-catalog";
import { InMemoryRouteSnapshotService } from "../transport/routing/route-model";
import { RedisAdmissionController, RoutingEngine } from "../transport/routing/router";
import { ApiKeyAdmissionService, InMemoryAdmissionCounterStore, RedisAdmissionCounterStore, sweepLeases } from "../security/admission";
import { InMemoryIpAbuseStore, IpAbuseProtectionService, RedisIpAbuseStore } from "../security/abuse";
import { checkReadiness, resolveRedisMode } from "../persistence/readiness";
import { ProxyRequestPreparer } from "../transport/request/preparer";
import { DrizzleNetworkPoolLoader } from "../network/pool/loader";
import {
  PoolAgentResolver,
  ValidatedNetworkBindingFactory,
} from "../network/pool/resolver";
import { NetworkPoolSelector } from "../network/pool/selector";
import { ScheduledTaskRegistry } from "../workers/tasks";
import { quotaRefreshSweep } from "../workers/quota-refresh-worker";
import { createAccountSecretResolver } from "../providers/operations/provider-credential-service";
import { quotaCacheSize } from "../console/quota/quota-cache";
import { DrizzleRuntimeSettingsStore } from "../console/settings/store";
import { sweepExpiredCooldowns } from "../providers/operations/account-health-service";
import { DrizzleTelemetryStore } from "../persistence/telemetry-store";
import { TelemetryPayloadCapture } from "../observability/payload-capture";
import { sweepExpiredPoolCooldowns } from "../network/pool-health-machine";
import { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import { RuntimeMetricsSampler } from "../observability/runtime-metrics";
import {
  resolveIpRateLimit,
  resolveSsrfPolicy,
  resolveTelemetryRetentionDays,
  resolveTrustedProxyBoundary,
} from "../config";
import type { TrustedProxyBoundary } from "../config";
import type { ProviderAdapter, ProviderRegistry } from "../providers/provider-registry";
import type { ByokUpstreamHost } from "../providers/operations/provider-catalog-service";
import type { ReadinessCheckResult } from "../persistence/readiness";
import { eq, sql } from "drizzle-orm";
import { apiKeys } from "../persistence/schema";
import { log } from "../observability/logger";
import { refreshClineClientVersion } from "../providers/operations/client-versions";


export interface ProductionDeps {
  db: CartethyiaDatabase;
  redis: RedisClient | undefined;
  snapshotService: InMemoryRouteSnapshotService;
  /** On-demand adapter resolution keeps heavy providers out of the boot path. */
  resolveProviderAdapter: (providerId: string) => Promise<ProviderAdapter | undefined>;
  bundledModelCatalog: BundledProviderCatalog;
  /** Live lookup of a provider's SSRF-validated upstream host. */
  byokUpstreamHosts: { readonly get: (providerId: string) => ByokUpstreamHost | undefined };
  proxyPreparer: ProxyRequestPreparer;
  networkBindingFactory: ValidatedNetworkBindingFactory;
  ipAbuseProtection: IpAbuseProtectionService;
  readiness: () => Promise<ReadinessCheckResult>;
  scheduledTasks: ScheduledTaskRegistry;
  poolAgentResolver: PoolAgentResolver;
  poolSelector: NetworkPoolSelector;
  telemetryBuffer: TelemetryBatchBuffer;
  trustedProxyBoundary: TrustedProxyBoundary;
  providerRegistry: ProviderRegistry;
  resolveOAuthRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  oauthRefreshService: OAuthRefreshService;
  admissionService: ApiKeyAdmissionService;
}

export async function buildProductionDeps(): Promise<ProductionDeps> {
  const db = getDb();
  const redisMode = resolveRedisMode();
  const redis = redisMode === "single_instance_local" ? undefined : getRedis();
  const ssrfPolicy = resolveSsrfPolicy();
  await ensureMigrated();
  await assertPoolFitsServerCapacity(poolMaxFromEnv());
  await seedBundledProviders(db);
  const registry = createDefaultProviderRegistry();
  // Live view, not a snapshot: custom providers registered after boot (or
  // edited from the console) must resolve their SSRF binding immediately.
  const byokUpstreamHosts = liveProviderUpstreamHosts(registry);
  await registerByokProviders(registry, db, ssrfPolicy);
  const bundledCatalog = await bundledModelCatalog(registry);
  await seedBundledModels(db, bundledCatalog.modelsByProvider);
  const snapshotService = new InMemoryRouteSnapshotService(
    createDatabaseSnapshotBuilder(db),
  );
  const routingEngine = new RoutingEngine(
    redis ? new RedisAdmissionController(redis) : undefined,
  );
  const runtimeSettingsStore = new DrizzleRuntimeSettingsStore(db);
  const admissionStore = redis
    ? new RedisAdmissionCounterStore(redis)
    : new InMemoryAdmissionCounterStore();
  const admissionService = new ApiKeyAdmissionService(
    admissionStore,
    undefined,
    (tenantId) => runtimeSettingsStore.getTenantConcurrencyLimit(tenantId),
    async ({ apiKeyId, delta }) => {
      // Persist reconciled lifetime token consumption so budgets survive a
      // Redis flush. Uses an incremental UPDATE (COALESCE) so concurrent
      // reconciliations compose additively.
      if (!Number.isFinite(delta) || delta <= 0) return;
      await db
        .update(apiKeys)
        .set({
          lifetimeTokensConsumed: sql`COALESCE(${apiKeys.lifetimeTokensConsumed}, 0) + ${delta}`,
        })
        .where(eq(apiKeys.id, apiKeyId));
    },
  );
  const ipStore = redis
    ? new RedisIpAbuseStore(redis)
    : new InMemoryIpAbuseStore();
  const ipAbuseProtection = new IpAbuseProtectionService(ipStore, undefined, {
    maxRequestsPerWindow: resolveIpRateLimit(),
  });
  const readiness = () => checkReadiness(db, redis, redisMode);
  const scheduledTasks = new ScheduledTaskRegistry();
  if (redis) {
    scheduledTasks.register({
      name: "lease-sweep",
      intervalMs: 30_000,
      run: () => sweepLeases(redis),
    });
  }
  scheduledTasks.register({
    name: "account-health-sweep",
    intervalMs: 30_000,
    run: async () => {
      const recovered = await sweepExpiredCooldowns(db);
      const poolRecovered = await sweepExpiredPoolCooldowns(db);
      if (recovered > 0 || poolRecovered > 0) await snapshotService.invalidate();
    },
  });
  const payloadCapture = new TelemetryPayloadCapture(db);
  const telemetryStore = new DrizzleTelemetryStore(db);
  scheduledTasks.register({
    name: "telemetry-payload-cleanup",
    intervalMs: 15 * 60_000,
    run: () => payloadCapture.cleanupExpired(),
  });
  scheduledTasks.register({
    name: "telemetry-retention",
    intervalMs: 6 * 60 * 60_000,
    run: () =>
      telemetryStore.pruneTelemetry(
        new Date(Date.now() - resolveTelemetryRetentionDays() * 24 * 60 * 60_000),
      ),
  });
  const telemetryBuffer = new TelemetryBatchBuffer(db);
  const poolSelector = new NetworkPoolSelector(redis);
  const poolAgentResolver = new PoolAgentResolver(
    new DrizzleNetworkPoolLoader(db),
    { ssrfPolicy, db },
  );
  const networkBindingFactory = new ValidatedNetworkBindingFactory(
    ssrfPolicy,
    undefined,
    poolAgentResolver,
  );
  // Runtime gauges (memory + bounded-collection sizes) sampled on the shared
  // maintenance cadence. The sampler reads live sizes through closures so the
  // observability layer never holds direct references to routing/pool state.
  const runtimeMetricsSampler = new RuntimeMetricsSampler({
    routingRoundRobinEntries: () => routingEngine.roundRobinEntries(),
    poolAgentEntries: () => poolAgentResolver.agentCount(),
    ipAbuseKeys: () => (ipStore instanceof InMemoryIpAbuseStore ? ipStore.keyCount() : 0),
    quotaCacheEntries: () => quotaCacheSize(),
  });
  scheduledTasks.register({
    name: "runtime-metrics",
    intervalMs: 10_000,
    run: () => runtimeMetricsSampler.sample(),
  });
  const oauthRefreshService = new OAuthRefreshService(db);
  scheduledTasks.register({
    name: "oauth-refresh-sweep",
    intervalMs: 60_000,
    run: () =>
      oauthRefreshSweep({
        loadDueAccounts: () => loadDueOAuthAccounts(db),
        refreshService: oauthRefreshService,
        resolveRefresher: (providerId) => registry.resolveRefresher(providerId),
        onAccountError: (accountId, providerId, error) => {
          log.error(
            `[oauth-refresh] account=${accountId} provider=${providerId} failed:`,
            error as Error,
          );
        },
      }),
  });

  // Keeps every account's cached quota warm so opening the Quota page is a
  // cache read. Without this the only refreshes are user-triggered, so the
  // first open after an expiry always blocks on the provider. The quota cache
  // is Redis-backed, and the console itself requires Redis, so the sweep only
  // registers where the console can run at all.
  if (redis) {
    const quotaResolveCredential = createAccountSecretResolver({
      db,
      resolveRefresher: (providerId) => registry.resolveRefresher(providerId),
      refreshService: oauthRefreshService,
    });
    // Keeps every account's cached quota warm so opening the Quota page is a
    // cache read. Without this the only refreshes are user-triggered, so the
    // first open after an expiry always blocks on the provider. The quota cache
    // is Redis-backed, and the console itself requires Redis, so the sweep only
    // registers where the console can run at all.
    //
    // It also carries the daily check-in ride-along: each account refreshed
    // here gets its once-per-day WorkBuddy/CodeBuddy credit grant claimed in
    // the same pass (one attempt per account per day, guarded by a Redis day
    // marker), so no second timer duplicates the credential resolution.
    scheduledTasks.register({
      name: "quota-refresh-sweep",
      intervalMs: 60_000,
      run: () =>
        quotaRefreshSweep({
          db,
          redis,
          providerRegistry: registry,
          resolveCredential: quotaResolveCredential,
          // Per-account lines and the pass summary are emitted by the sweep
          // itself at `info` level, so they survive the production LOG_LEVEL.
          // `onTick` is left for tests.
        }),
    });
  }
  // The scheduled tasks are registered here but started by the caller once the
  // listener is actually serving (`main.ts`). Starting them inside this builder
  // would let the first tick — the lease sweep, the health sweep — run against
  // a process that has not begun accepting traffic yet.
  // Warm the Cline version cache *after* the listener can serve traffic. The
  // resolvers are TTL-cached and each dispatch path awaits its own `ensure()`,
  // so discovery here is a pure optimization: awaiting it during boot used to
  // block the listener for up to the 4s fetch timeout on a blackholed network,
  // while the pinned fallback was already serving requests correctly.
  refreshClineClientVersion();
  return {
    db,
    redis,
    snapshotService,
    resolveProviderAdapter: (providerId) => registry.resolve(providerId),
    bundledModelCatalog: bundledCatalog,
    byokUpstreamHosts,
    proxyPreparer: new ProxyRequestPreparer({
      snapshotService,
      routingEngine,
      admissionService,
    }),
    networkBindingFactory,
    ipAbuseProtection,
    readiness,
    scheduledTasks,
    poolAgentResolver,
    telemetryBuffer,
    poolSelector,
    admissionService,
    trustedProxyBoundary: resolveTrustedProxyBoundary(),
    providerRegistry: registry,
    resolveOAuthRefresher: (providerId) => registry.resolveRefresher(providerId),
    oauthRefreshService,
  };
}
