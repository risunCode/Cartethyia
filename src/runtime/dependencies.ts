
import { assertPoolFitsServerCapacity, bootDatabase, ensureMigrated, poolMaxFromEnv } from "../persistence/postgres";
import type { CartethyiaDatabase } from "../persistence/postgres";
import { resolveRedisBackend, resolveRedisClient } from "../persistence/redis";
import type { RedisClient } from "../persistence/redis";
import {
  bundledModelCatalog,
  liveProviderUpstreamHosts,
  registerByokProviders,
  retireUnbundledProviders,
  seedBundledProviders,
} from "../providers/operations/provider-catalog-service";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import { createDefaultProviderRegistry } from "../providers/default-registry";
import { OAuthRefreshService, loadDueOAuthAccounts, reconcileStaticTokenAccounts } from "../providers/authentication/oauth-refresh-service";
import type { OAuthTokenRefresher } from "../providers/authentication/oauth-refresh-service";
import { oauthRefreshSweep } from "../workers/oauth-refresh-worker";
import { pushStructuredConsoleLog } from "../observability/log-ring";
import { seedBundledModels } from "../providers/operations/provider-catalog-seeder";
import { createDatabaseSnapshotBuilder } from "../transport/routing/route-catalog";
import { DrizzleProviderCatalogStore } from "../console/providers/catalog/store";
import { InMemoryRouteSnapshotService } from "../transport/routing/route-model";
import { RedisAdmissionController, RoutingEngine } from "../transport/routing/router";
import { ApiKeyAdmissionService } from "../security/admission/service";
import { InMemoryAdmissionCounterStore } from "../security/admission/in-memory-store";
import { RedisAdmissionCounterStore } from "../security/admission/redis-store";
import { sweepLeases } from "../security/admission/lease-sweep";
import { DrizzleApiKeyStore } from "../persistence/api-key-store";
import { InMemoryIpAbuseStore, IpAbuseProtectionService, RedisIpAbuseStore } from "../security/abuse";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
  RedisModelAbuseStore,
} from "../security/model-abuse";
import { checkReadiness } from "../persistence/readiness";
import { ProxyRequestPreparer } from "../transport/request/preparer";
import { DrizzleNetworkPoolLoader } from "../network/pool/loader";
import {
  PoolAgentResolver,
  ValidatedNetworkBindingFactory,
} from "../network/pool/resolver";
import { NetworkPoolSelector } from "../network/pool/selector";
import { ScheduledTaskRegistry } from "../workers/tasks";
import { quotaRefreshSweep } from "../workers/quota-refresh-worker";
import { checkinEgressForPass } from "../workers/checkin-egress";
import { createAccountSecretResolver } from "../providers/operations/provider-credential-service";
import { quotaCacheSize } from "../console/quota/cache";
import { preferencesReaderFor } from "../transport/dispatch/attempt-finalize";
import { sweepExpiredCooldowns } from "../providers/operations/account-health-service";
import { DrizzleTelemetryStore } from "../persistence/telemetry-store";
import { TelemetryPayloadCapture } from "../observability/payload-capture";
import { sweepExpiredPoolCooldowns } from "../network/pool-health-machine";
import { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import { RuntimeMetricsSampler } from "../observability/runtime-metrics";
import {
  resolveIpRateLimit,
  resolveModelBanTtlMs,
  resolveModelStrikeThreshold,
  resolveModelStrikeWindowMs,
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
import { refreshProviderClientVersions } from "../providers/operations/client-versions";


export interface ProductionDeps {
  db: CartethyiaDatabase;
  redis: RedisClient | undefined;
  snapshotService: InMemoryRouteSnapshotService;
  /** Live routing admission snapshot scoped to one provider/tenant for console reads. */
  readRoutingAccountInflight: (
    providerId: string,
    tenantId: string | null,
  ) => Promise<readonly { accountId: string; inflight: number }[]>;
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
  /** Graduated strikes for repeated invalid-model requests. */
  modelStrikes: ModelStrikeService;
}

/**
 * Pause between accounts in the OAuth refresh sweep. The token endpoints
 * rate-limit a burst of refreshes even at low concurrency.
 */
const OAUTH_REFRESH_INTER_ITEM_DELAY_MS = 1_500;

/**
 * Client identities are refreshed out of band so provider dispatch never waits
 * on npm/provider version endpoints. Resolver TTLs deduplicate the sources.
 */
const CLIENT_VERSION_MONITOR_INTERVAL_MS = 15 * 60_000;

export async function buildProductionDeps(): Promise<ProductionDeps> {
  const handle = await bootDatabase();
  const db = handle.db;
  // One rule, no mode flag: REDIS_URL set → shared client, unset → memory.
  const redis = resolveRedisClient();
  const ssrfPolicy = resolveSsrfPolicy();
  await ensureMigrated();
  // Pool sizing is an external-server concern; the embedded backend has no
  // connection budget to fit into.
  if (handle.kind === "pg") await assertPoolFitsServerCapacity(poolMaxFromEnv());
  await seedBundledProviders(db);
  // Boot-only: retire global rows for providers the bundle has dropped, so a
  // retired provider cannot linger as a card the console can no longer delete.
  // Kept off the test harness path, which shares one database across suites and
  // installs its own global fixtures.
  await retireUnbundledProviders(db);
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
  const readRoutingAccountInflight = async (
    providerId: string,
    tenantId: string | null,
  ): Promise<readonly { accountId: string; inflight: number }[]> => {
    if (providerId === "" || tenantId === null) return [];
    const snapshot = await routingEngine.accountInflightSnapshot();
    const accounts = await new DrizzleProviderCatalogStore(db, {
      telemetryBuffer,
      bundledModelCatalog: bundledCatalog,
      providerRegistry: registry,
      outboundFetchFor: async () => ({ fetch: networkBindingFactory.fetch(undefined, tenantId) }),
      snapshotInvalidator: snapshotService,
    }).listAccounts(tenantId, providerId);
    const owned = new Set(accounts.map((account) => account.id));
    const totals = new Map<string, number>();
    for (const [bucket, count] of snapshot) {
      const prefix = `${providerId}:`;
      if (!bucket.startsWith(prefix)) continue;
      const accountId = bucket.slice(bucket.lastIndexOf(":") + 1);
      if (!owned.has(accountId)) continue;
      totals.set(accountId, (totals.get(accountId) ?? 0) + count);
    }
    return [...totals].map(([accountId, inflight]) => ({ accountId, inflight }));
  };
  const admissionStore = redis
    ? new RedisAdmissionCounterStore(redis)
    : new InMemoryAdmissionCounterStore();
  const admissionService = new ApiKeyAdmissionService(
    admissionStore,
    undefined,
    // The per-tenant concurrency cap is a `console_settings` preference, read
    // on every admitted request. Reading it directly cost one Postgres round
    // trip per request (multiplied by each failover candidate); the shared
    // revision-keyed reader answers from memory and converges the moment an
    // operator saves, because `DrizzleRuntimeSettingsStore.update` bumps the
    // revision every cached key embeds.
    (tenantId) =>
      preferencesReaderFor(db)
        .readPreferences(tenantId)
        .then((prefs) => prefs?.tenantConcurrencyLimit ?? null),
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
    // Fresh lifetime reader — invoked by the store only when it is about to
    // seed a missing `admission:lifetime:<id>` counter, so the ≤3s-stale auth
    // snapshot value cannot freeze a low baseline in place. Family total: the
    // row plus every child (share recipients admit under the parent id).
    async (apiKeyId) => {
      const store = new DrizzleApiKeyStore(db);
      const row = await store.findActiveById(apiKeyId);
      if (!row) return undefined;
      const children = await store.sumChildrenConsumed(apiKeyId);
      return (row.lifetimeTokensConsumed ?? 0) + children;
    },
  );
  const ipStore = redis
    ? new RedisIpAbuseStore(redis)
    : new InMemoryIpAbuseStore();
  const ipAbuseProtection = new IpAbuseProtectionService(ipStore, undefined, {
    maxRequestsPerWindow: resolveIpRateLimit(),
  });
  // Graduated model-abuse strikes: a client that keeps requesting models
  // outside its access is warned, then banned. Redis-backed when available so
  // the ban survives a restart and is shared across instances; in-memory
  // otherwise, where a restart clears it.
  const modelAbuseStore = redis ? new RedisModelAbuseStore(redis) : new InMemoryModelAbuseStore();
  const modelStrikes = new ModelStrikeService(modelAbuseStore, {
    threshold: resolveModelStrikeThreshold(),
    windowMs: resolveModelStrikeWindowMs(),
    banTtlMs: resolveModelBanTtlMs(),
  });
  const readiness = () => checkReadiness(db, redis, resolveRedisBackend(redis));
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
  // Converge accounts an earlier build parked on a dead refresh grant: an
  // account whose stored access token is still usable becomes a static token
  // (and returns to rotation) instead of staying disabled for re-auth.
  await reconcileStaticTokenAccounts(db);
  scheduledTasks.register({
    name: "oauth-refresh-sweep",
    intervalMs: 60_000,
    run: () =>
      oauthRefreshSweep({
        loadDueAccounts: () => loadDueOAuthAccounts(db),
        refreshService: oauthRefreshService,
        resolveRefresher: (providerId) => registry.resolveRefresher(providerId),
        // Sequential with a pause between accounts: the OAuth token endpoints
        // rate-limit a burst of refreshes, and a pass over a handful of
        // accounts must not look like one. Per-account outcomes are already
        // pushed to the Console Log ring by `OAuthRefreshService`; this only
        // covers an error that escaped before reaching it.
        interItemDelayMs: OAUTH_REFRESH_INTER_ITEM_DELAY_MS,
        onAccountError: (accountId, providerId, error) => {
          log.error(
            `[oauth-refresh] account=${accountId} provider=${providerId} failed:`,
            error as Error,
          );
          pushStructuredConsoleLog("error", "OAuth refresh sweep: account failed", {
            event: "token_refresh",
            accountId,
            providerId,
            errorCode: "refresh_sweep_failed",
          });
        },
      }),
  });

  // Client versions are monitor-only metadata. The first refresh is best-effort
  // at startup; the scheduled task keeps the same resolver cache warm later.
  scheduledTasks.register({
    name: "client-version-monitor",
    intervalMs: CLIENT_VERSION_MONITOR_INTERVAL_MS,
    run: refreshProviderClientVersions,
  });
  void refreshProviderClientVersions();

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
          // The sweep stamps the last fetched remaining credit onto the account
          // row (`stampRemainingCredit`) and invalidates the route snapshot when
          // it changes, so the next plan sees the fresh figure and the request
          // path can enforce per-account floors from the last cached balance.
          snapshotInvalidator: snapshotService,
          // The check-in ride-along rotates egress per account: each account
          // gets the next active pool in its tenant's rotation so check-ins
          // spread across IPs instead of sharing one direct egress. No pool
          // (or an unreadable pool table) falls back to direct egress, and a
          // tenant never borrows another tenant's pool.
          checkinFetcherFor: checkinEgressForPass({ db, networkBindingFactory }),
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
  return {
    db,
    redis,
    snapshotService,
    readRoutingAccountInflight,
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
    modelStrikes,
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
