import { Elysia } from "elysia";
import { ConsoleDomainError } from "./shared/errors";
import { createCliToolsRoutes } from "./cli-tools/routes";
import { createAccountQuotaRoutes } from "./quota/account-quota";
import { createApiKeyRoutes } from "./domains/api-keys/routes";
import { createProviderCatalogRoutes } from "./providers/catalog/routes";
import {
  createProviderDetailRoutes,
} from "./providers/detail/routes";
import {
  createOAuthLoginRoutes,
  DrizzleOAuthAccountStore,
} from "./providers/oauth/routes";
import {
  DrizzleProviderCatalogStore,
} from "./providers/catalog/store";
import { DrizzleProviderDetailStore } from "./providers/detail/store";
import { createModelRoutingRoutes } from "./routing/model/contracts";
import { createNetworkPoolRoutes } from "./routing/pools/contracts";
import { DrizzleModelRoutingStore } from "./routing/model/store";
import { DrizzleNetworkPoolStore } from "./routing/pools/store";
import { createRuntimeSettingsRoutes } from "./settings/contracts";
import { DrizzleRuntimeSettingsStore } from "./settings/store";
import { createObservabilityRoutes } from "./domains/stats/contracts";
import { DrizzleObservabilityStore } from "./domains/stats/store";
import { createLiveRoutes } from "./domains/live";
import { createLogRoutes } from "./domains/logs";
import { createAuditRoutes } from "./domains/audit/contracts";
import { DrizzleAuditReadStore } from "./domains/audit/store";
import { createStudioRoutes } from "./domains/studio/routes";
import { DrizzleStudioSessionStore } from "./domains/studio/store";
import { createPerformanceRoutes } from "./domains/performance/routes";
import { createBackupRoutes } from "./backup/routes";
import { BackupService } from "./backup/service";
import type { ConsoleCredentialService } from "./auth/service";

import { OAuthFlowStore } from "../providers/authentication/oauth-flow-store";
import { createAccountSecretResolver } from "../providers/operations/provider-credential-service";
import { syncByokProvider } from "../providers/operations/provider-catalog-service";
import { DrizzleApiKeyStore } from "../persistence/api-key-store";
import { DrizzleShareLinkStore } from "../persistence/share-store";
import { createShareUsagePort } from "./share/share-usage";
import { resolveSsrfPolicy } from "../config";
import type { AuditRecorder } from "./auth/service";
import type { CliToolService } from "./cli-tools/service";
import type { NetworkPoolSelector } from "../network/pool/selector";
import type { RouteSnapshotService } from "../transport/routing/route-model";
import type { ApiKeyAdmissionService } from "../security/admission";
import type { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import type { OAuthRefreshService } from "../providers/authentication/oauth-refresh-service";
import type { RedisClient } from "../persistence/redis";
import type { ProviderRegistry } from "../providers/provider-registry";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import type { ValidatedNetworkBindingFactory } from "../network/pool/resolver";
import type { CartethyiaDatabase } from "../persistence/postgres";
import type { ConsoleAccessResolver } from "./auth/access";

export interface ConsoleDomainContext {
  readonly db: CartethyiaDatabase;
  readonly accessResolver: ConsoleAccessResolver;
  readonly providerRegistry: ProviderRegistry;
  readonly bundledModelCatalog: BundledProviderCatalog;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
  readonly oauthRefreshService: OAuthRefreshService;
  readonly auditRecorder: AuditRecorder;
  readonly cliToolService: CliToolService;
  readonly redis: RedisClient;
  readonly routeSnapshotService: RouteSnapshotService;
  readonly poolSelector: NetworkPoolSelector;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey">;
  /**
   * Loads the signed-in console user, for surfaces that re-authenticate the
   * operator rather than trusting the session alone (backup export/restore).
   */
  readonly loadConsoleUser: (request: Request) => Promise<{ readonly passwordHash: string } | null>;
  /** Password verification against the console user's stored hash. */
  readonly credentialService: Pick<ConsoleCredentialService, "verifyPassword">;
}
import { and, eq, isNull, or } from "drizzle-orm";
import { networkPools, providerRoutingSettings } from "../persistence/schema";
import { resolveTenantOverride } from "../persistence/tenant-scope";
import { DEFAULT_PROXY_BYPASS_PROVIDER_IDS } from "../providers/provider-registry";
import type { ProbeOutboundBinding } from "../providers/discovery/probing-service";


export function registerConsoleDomains(
  console: Elysia<any, any, any, any, any, any, any, any>,
  ctx: ConsoleDomainContext,
): void {
  const observabilityStore = new DrizzleObservabilityStore(ctx.db, ctx.redis);
  const auditReadStore = new DrizzleAuditReadStore(ctx.db);
  /** Refresh-aware credential resolution shared by the catalog export and quota routes. */
  const resolveCredential = createAccountSecretResolver({
    db: ctx.db,
    resolveRefresher: (id) => ctx.providerRegistry.resolveRefresher(id),
    refreshService: ctx.oauthRefreshService,
  });
  const providerCatalogStore = new DrizzleProviderCatalogStore(ctx.db, {
    telemetryBuffer: ctx.telemetryBuffer,
    bundledModelCatalog: ctx.bundledModelCatalog,
    providerRegistry: ctx.providerRegistry,
    outboundFetchFor: async (tenantId: string, providerId?: string): Promise<ProbeOutboundBinding> => {
      let bypass = false;
      if (providerId) {
        const rows = await ctx.db
          .select({
            tenantId: providerRoutingSettings.tenantId,
            bypassProxy: providerRoutingSettings.bypassProxy,
          })
          .from(providerRoutingSettings)
          .where(
            and(
              eq(providerRoutingSettings.providerId, providerId),
              or(
                eq(providerRoutingSettings.tenantId, tenantId),
                isNull(providerRoutingSettings.tenantId),
              ),
            ),
          );
        const tenantSetting = rows.find((row) => row.tenantId === tenantId)?.bypassProxy;
        const globalSetting = rows.find((row) => row.tenantId === null)?.bypassProxy;
        bypass = resolveTenantOverride(
          tenantSetting,
          globalSetting,
          DEFAULT_PROXY_BYPASS_PROVIDER_IDS.has(providerId),
        );
      }

      if (!bypass) {
        const activePools = await ctx.db
          .select({
            id: networkPools.id,
            maxInflight: networkPools.maxInflight,
            weight: networkPools.weight,
          })
          .from(networkPools)
          .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.status, "active")));

        if (activePools.length > 0) {
          const limits: Record<string, number> = {};
          const weights: Record<string, number> = {};
          for (const p of activePools) {
            limits[p.id] = p.maxInflight ?? 10;
            weights[p.id] = p.weight ?? 100;
          }
          const slot = await ctx.poolSelector.tryAcquireAvailablePool(
            activePools.map((p) => p.id),
            providerId ?? "default",
            limits,
            weights,
          );
          if (slot) {
            return {
              fetch: ctx.networkBindingFactory.fetch(slot.poolId, tenantId),
              networkPoolId: slot.poolId,
              release: slot.release,
            };
          }
          // Every pool is saturated or cooling down: fail closed with an
          // explicit 503 rather than pinning the first pool and bypassing its
          // capacity accounting and cooldown.
          throw new ConsoleDomainError(
            "pool_unavailable",
            503,
            `All network pools are saturated for provider ${providerId ?? "default"}`,
          );
        }
      }

      return { fetch: ctx.networkBindingFactory.fetch(undefined, tenantId) };
    },
    snapshotInvalidator: ctx.routeSnapshotService,
  });
  const providerDetailStore = new DrizzleProviderDetailStore(ctx.db);
  const networkPoolStore = new DrizzleNetworkPoolStore(ctx.db, resolveSsrfPolicy());
  const runtimeSettingsStore = new DrizzleRuntimeSettingsStore(ctx.db);
  const modelRoutingStore = new DrizzleModelRoutingStore(ctx.db);
  const apiKeyStore = new DrizzleApiKeyStore(ctx.db);
  const shareStore = new DrizzleShareLinkStore(ctx.db);
  const shareActivity = createShareUsagePort(ctx.db);


  console.use(createObservabilityRoutes({ store: observabilityStore, accessResolver: ctx.accessResolver }));
  console.use(createLiveRoutes({
    accessResolver: ctx.accessResolver,
    poolSelector: ctx.poolSelector,
    db: ctx.db,
  }));
  console.use(createStudioRoutes({
    sessionStore: new DrizzleStudioSessionStore(ctx.db),
    keyStore: apiKeyStore,
    accessResolver: ctx.accessResolver,
    webFetch: (tenantId) => ctx.networkBindingFactory.fetch(undefined, tenantId),
    auditSink: ctx.auditRecorder,
  }));
  console.use(createLogRoutes({ accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder }));
  console.use(createPerformanceRoutes({ accessResolver: ctx.accessResolver }));
  console.use(createAuditRoutes({ store: auditReadStore, accessResolver: ctx.accessResolver }));
  console.use(createProviderCatalogRoutes({
    store: providerCatalogStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    providerRegistry: ctx.providerRegistry,
    snapshotInvalidator: ctx.routeSnapshotService,
    resolveCredential,
    // Without this, a custom provider only becomes dispatchable after a
    // restart: boot registers BYOK rows once, and the catalog routes are the
    syncByokProvider: (providerId) =>
      syncByokProvider(ctx.providerRegistry, ctx.db, providerId, resolveSsrfPolicy()),
    listRoutingTargets: async (tenantId) => ({
      aliases: await modelRoutingStore.listAliases(tenantId),
      combos: await modelRoutingStore.listCombos(tenantId),
    }),
  }));
  console.use(createProviderDetailRoutes({
    store: providerDetailStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    snapshotInvalidator: ctx.routeSnapshotService,
  }));
  console.use(createNetworkPoolRoutes({
    store: networkPoolStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    poolSelector: ctx.poolSelector,
    snapshotInvalidator: ctx.routeSnapshotService,
  }));
  console.use(createRuntimeSettingsRoutes({ store: runtimeSettingsStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder }));
  console.use(
    createBackupRoutes({
      accessResolver: ctx.accessResolver,
      // The service is built per request: re-authenticating the operator needs
      // the request's session, and holding a request-bound closure in a
      // long-lived object would leak one request's identity into the next.
      backupFor: (request: Request) =>
        new BackupService({
          db: ctx.db,
          verifyPassword: async (password: string) => {
            const user = await ctx.loadConsoleUser(request);
            if (user === null) return false;
            return ctx.credentialService.verifyPassword(password, user.passwordHash);
          },
        }),
      snapshotInvalidator: ctx.routeSnapshotService,
    }),
  );
  console.use(createModelRoutingRoutes({ store: modelRoutingStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, snapshotInvalidator: ctx.routeSnapshotService }));
  console.use(createApiKeyRoutes({ store: apiKeyStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, shareStore, shareActivity, admissionService: ctx.admissionService }));
  console.use(createCliToolsRoutes({ service: ctx.cliToolService, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, snapshotInvalidator: ctx.routeSnapshotService }));
  console.use(createAccountQuotaRoutes({
    db: ctx.db,
    accessResolver: ctx.accessResolver,
    auditRecorder: ctx.auditRecorder,
    redis: ctx.redis,
    snapshotInvalidator: ctx.routeSnapshotService,
    providerRegistry: ctx.providerRegistry,
    resolveCredential,
  }));
  console.use(createOAuthLoginRoutes({ providerRegistry: ctx.providerRegistry, oauthFlowStore: new OAuthFlowStore(ctx.redis), accountStore: new DrizzleOAuthAccountStore(ctx.db), accessResolver: ctx.accessResolver, snapshotInvalidator: ctx.routeSnapshotService }));
}
