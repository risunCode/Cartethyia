import { Elysia } from "elysia";
import { resolveDashboardDist, resolveElysiaPrecompile } from "./config";
import { createConsoleRouter, type ConsoleApiCompositionDeps } from "./console/console-router";
import { createStaticHandler } from "./console/dashboard-assets";
import { createShareRouter } from "./console/share/share-router";
import { DrizzleShareLinkStore } from "./persistence/share-store";
import { chatAdapter } from "./transport/surface/chat/adapter";
import { responsesAdapter } from "./transport/surface/responses/adapter";
import { messagesAdapter } from "./transport/surface/messages/adapter";
import { completionAdapter } from "./transport/surface/completion";
import { SurfaceAdapterRegistry } from "./transport/surface/adapters";
import { GatewayError } from "./transport/gateway-error";
import type { CanonicalAdapter } from "./transport/middleware/ingress";
import type { ApiKeyAuthorizationSnapshot } from "./security/api-key-auth";
import { getPool } from "./persistence/postgres";
import { getRedisOrUndefined } from "./persistence/redis";
import type { CartethyiaDatabase } from "./persistence/postgres";
import type { ProviderAdapter } from "./providers/provider-registry";
import type { OAuthTokenRefresher, OAuthRefreshService } from "./providers/authentication/oauth-refresh-service";
import { withTimeout } from "./runtime/timeout";
import type { ByokUpstreamHost } from "./providers/operations/provider-catalog-service";
import type { NetworkPoolSelector } from "./network/pool/selector";
import type { ProxyRequestPreparer } from "./transport/request/preparer";
import { ProxyRequestStateStore } from "./transport/request/state";
import { fastPathname } from "./transport/request/pathname";
import {
  handleProviderProxyRequest,
  type ProviderProxyHandlerDeps,
} from "./transport/dispatch/proxy-request";
import { createResponsesCompactHandler } from "./transport/dispatch/responses-compact";

import { createTransportPipeline } from "./transport/middleware/pipeline";
import { PublicModelCatalogStore, type AllowedModelEntry } from "./console/providers/catalog/public-model-store";
import type { IpAbuseProtectionService } from "./security/abuse";
import type { ReadinessCheckResult } from "./persistence/readiness";
import type { RouteSnapshotService } from "./transport/routing/route-model";
import type { TrustedProxyBoundary } from "./config";
import type { ValidatedNetworkBindingFactory } from "./network/pool/resolver";
import { metrics } from "./observability/metrics";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "./security/outbound-headers";


import type { TelemetryBatchBuffer } from "./observability/telemetry-buffer";
/**
 * Drain-state surface the composition root and the transport pipeline consume.
 * `ShutdownCoordinator` in `runtime/lifecycle.ts` is the production implementation;
 * the pipeline only reads `isDraining`, the request/state store uses the rest.
 */
export interface ShutdownCoordinatorLike {
  track(id: string): void;
  untrack(id: string): void;
  isDraining(): boolean;
  setAbortInflight?: (handler: (() => void) | undefined) => void;
}

/**
 * Route-only shell dependencies: the dashboard, `/health`, and `/metrics`
 * without the transport pipeline. Used when no database is available (AOT
 * manifest capture during `bun run build:aot`) and by tests that exercise
 * routing and static serving in isolation.
 *
 * Only the knobs route-only mode actually reads appear here. Transport and
 * console options (`db`, `resolvePeerAddress`, `trustedProxyBoundary`,
 * `maxBodyBytes`, `requestDeadlineMs`, `verifiedHttps`) are deliberately
 * absent: they are read inside the `mode === "production"` branches, where the
 * discriminant narrows `deps` to `ProductionAppDeps`. Listing them here would
 * let a caller pass a value the shell silently ignores.
 */
export interface GatewayShellDeps {
  readonly mode: "route-only";
  readonly dashboardDist?: string;
  readonly checkDb?: () => Promise<void>;
  readonly checkRedis?: () => Promise<void>;
  readonly readiness?: () => Promise<ReadinessCheckResult>;
  readonly shutdownCoordinator?: ShutdownCoordinatorLike;
}

/**
 * Full production dependencies. Every transport, pool, snapshot, telemetry,
 * and console field is required — the composition root in
 * `runtime/dependencies.ts` either supplies it or the app does not boot, so
 * there is no runtime shape check to fall through.
 */
export interface ProductionAppDeps {
  readonly mode: "production";
  readonly db: CartethyiaDatabase;
  readonly proxyPreparer: ProxyRequestPreparer;
  readonly resolveProviderAdapter: (providerId: string) => Promise<ProviderAdapter | undefined>;
  readonly providerAdapters?: ReadonlyMap<string, ProviderAdapter>;
  /** Live lookup of a provider's SSRF-validated upstream host. */
  readonly byokUpstreamHosts: { readonly get: (providerId: string) => ByokUpstreamHost | undefined };
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
  readonly ipAbuseProtection: IpAbuseProtectionService;
  readonly trustedProxyBoundary: TrustedProxyBoundary;
  readonly poolSelector: NetworkPoolSelector;
  readonly snapshotService: RouteSnapshotService;
  readonly readiness: () => Promise<ReadinessCheckResult>;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService: OAuthRefreshService;
  /**
   * The console control plane. Optional because the console needs Redis
   * (session/CSRF/oauth-flow state and the quota cache are Redis-backed),
   * while `REDIS_MODE=single_instance_local` runs without a Redis client at
   * all. A Redis-less boot serves `/v1/*`, `/health` and `/metrics` and does
   * not mount `/console/api/*`, which is exactly what that mode documents.
   */
  readonly consoleApi?: ConsoleApiCompositionDeps;
  readonly shutdownCoordinator: ShutdownCoordinatorLike;
  readonly dashboardDist?: string;
  readonly resolvePeerAddress?: (request: Request) => string | null;
  readonly maxBodyBytes?: number;
  readonly requestDeadlineMs?: number;
  readonly verifiedHttps?: boolean;
}

/** Either app mode. The discriminant decides which builder path runs. */
export type GatewayAppDeps = GatewayShellDeps | ProductionAppDeps;

function checkDatabaseConnection(): Promise<void> {
  return getPool()
    .query("SELECT 1")
    .then(() => undefined);
}

function checkRedisConnection(): Promise<void> {
  const redis = getRedisOrUndefined();
  if (!redis) return Promise.reject(new Error("REDIS_URL is required"));
  return redis.ping().then(() => undefined);
}

function runDependencyReadinessCheck(check: () => Promise<void>, label: string): Promise<void> {
  return withTimeout(Promise.resolve().then(check), 2000, `${label} timeout after 2000ms`);
}

/**
 * Builds the public HTTP composition root with route ordering guarantee.
 * The one builder behind both modes: `deps.mode` selects which planes mount,
 * and each mode's dependency interface admits no partial set.
 */
export function createGatewayApp(deps: GatewayAppDeps) {
  const dbCheck =
    deps.mode === "route-only"
      ? (deps.checkDb ?? checkDatabaseConnection)
      : checkDatabaseConnection;
  const redisCheck =
    deps.mode === "route-only"
      ? (deps.checkRedis ?? checkRedisConnection)
      : checkRedisConnection;
  const registry = new SurfaceAdapterRegistry([
    chatAdapter,
    responsesAdapter,
    messagesAdapter,
    completionAdapter,
  ]);
  const dashboardDist = deps.dashboardDist ?? resolveDashboardDist();
  const staticHandler = createStaticHandler({ buildDir: dashboardDist });
  const peerAddresses = new WeakMap<Request, string>();
  const serveDashboard = async ({ request }: { request: Request }): Promise<Response> => {
    const pathname = fastPathname(request.url);
    const result = await staticHandler(pathname);
    return new Response(result.body ? (result.body as unknown as BodyInit) : null, {
      status: result.status,
      headers: result.headers,
    });
  };
  /**
   * Root catch-all. Non-document namespaces (`/v1`, `/health`, `/metrics`) keep
   * their JSON 404 so an unknown API path can never be answered with the SPA
   * document; everything else resolves through the static handler.
   */
  const API_NAMESPACES = ["/v1", "/health", "/metrics"] as const;
  const serveRootFallback = async ({ request }: { request: Request }): Promise<Response> => {
    const pathname = fastPathname(request.url);
    const reserved = API_NAMESPACES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (reserved) {
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: "Route not found" } }),
        {
          status: 404,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": API_CONTENT_SECURITY_POLICY,
            "x-frame-options": X_FRAME_OPTIONS,
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
    return serveDashboard({ request });
  };

  // Build the Elysia app with strict route ordering.
  const requestStateStore = new ProxyRequestStateStore(deps.shutdownCoordinator);
  // Shutdown ordering: abort in-flight proxy controllers first so the
  // bounded drain observes cancellation and finalizers run before
  // telemetry flush and pool close.
  deps.shutdownCoordinator?.setAbortInflight?.(() => requestStateStore.abortAll());
  const app = new Elysia({ precompile: resolveElysiaPrecompile() })
    .beforeHandle(
      ({
        request,
        server,
      }: {
        request: Request;
        server?: { requestIP(request: Request): { address: string } | null } | null;
      }) => {
        const address = server?.requestIP(request)?.address;
        if (address) peerAddresses.set(request, address);
      },
    )
    .get("/health", () => ({ status: "ok" as const }))
    .get("/health/ready", async () => {
      const readiness = deps.readiness ? await deps.readiness() : undefined;
      const results = readiness
        ? [
            { status: readiness.db === "connected" ? "fulfilled" : "rejected" },
            { status: readiness.redis !== "disconnected" ? "fulfilled" : "rejected" },
          ]
        : await Promise.allSettled([
            runDependencyReadinessCheck(dbCheck, "db"),
            runDependencyReadinessCheck(redisCheck, "redis"),
          ]);
      const dbOk = results[0]?.status === "fulfilled";
      const redisOk = results[1]?.status === "fulfilled";
      const migrationsOk = readiness ? readiness.migrations === "applied" : true;

      if (dbOk && redisOk && migrationsOk) {
        return {
          status: "ready" as const,
          db: "connected" as const,
        };
      }

      return new Response(
        JSON.stringify({
          status: "not_ready" as const,
          db: dbOk ? ("connected" as const) : ("disconnected" as const),
          redis: redisOk ? ("connected" as const) : ("disconnected" as const),
          ...(readiness ? { migrations: readiness.migrations } : {}),
          reason: !migrationsOk
            ? "database migrations pending"
            : "dependency not ready",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    })
    .get("/metrics", () => {
      const pool = getPool();
      metrics.cartethyia_pg_pool_total.set(pool.totalCount);
      metrics.cartethyia_pg_pool_idle.set(pool.idleCount);
      metrics.cartethyia_pg_pool_waiting.set(pool.waitingCount);
      // `getRedisOrUndefined` is used (not `getRedis`) so a single_instance_local
      // deployment without REDIS_URL reports redis down instead of throwing and
      // crashing the Prometheus scrape.
      metrics.cartethyia_redis_up.set(
        getRedisOrUndefined()?.status === "ready" ? 1 : 0,
      );
      return new Response(metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    });

  if (deps.mode === "production") {
    const transportPipeline = createTransportPipeline({
      db: deps.db,
      stateStore: requestStateStore,
      surfaceRegistry: registry,
      adapters: new Map<string, CanonicalAdapter>([
        ["chat", chatAdapter],
        ["responses", responsesAdapter],
        ["messages", messagesAdapter],
        ["completion", completionAdapter],
      ]),
      preparer: deps.proxyPreparer,
      readiness: deps.readiness,
      trustedProxyBoundary: deps.trustedProxyBoundary,
      ...(deps.resolvePeerAddress ? { resolvePeerAddress: deps.resolvePeerAddress } : {}),
      ipAbuseProtection: deps.ipAbuseProtection,
      ...(deps.maxBodyBytes === undefined ? {} : { maxBodyBytes: deps.maxBodyBytes }),
      ...(deps.requestDeadlineMs === undefined ? {} : { requestDeadlineMs: deps.requestDeadlineMs }),
      ...(deps.verifiedHttps ? { verifiedHttps: true } : {}),
      shutdownCoordinator: deps.shutdownCoordinator,
      telemetry: deps.telemetryBuffer,
    });
    transportPipeline.mountRoot(app);
    const proxyDeps: ProviderProxyHandlerDeps = {
      db: deps.db,
      providerAdapters: deps.providerAdapters ?? new Map(),
      resolveProviderAdapter: deps.resolveProviderAdapter,
      stateStore: requestStateStore,
      snapshotService: deps.snapshotService,
      networkBindingFactory: deps.networkBindingFactory,
      byokUpstreamHosts: deps.byokUpstreamHosts,
      poolSelector: deps.poolSelector,
      telemetryBuffer: deps.telemetryBuffer,
      resolveOAuthRefresher: deps.resolveOAuthRefresher,
      oauthRefreshService: deps.oauthRefreshService,
    };
    const proxyHandler = ({ request }: { request: Request }) =>
      handleProviderProxyRequest(request, proxyDeps);

    const publicModelStore = new PublicModelCatalogStore(deps.db);
    const queryAllowedModels = (auth: {
      snapshot: ApiKeyAuthorizationSnapshot;
      tenantId: string | null;
      modelPrefix?: string;
    }): Promise<AllowedModelEntry[]> =>
      publicModelStore.listPublicModels(auth.tenantId, auth.snapshot, auth.modelPrefix);

    const handleModelsList = async ({ request }: { request: Request }): Promise<Response> => {
      const state = requestStateStore.require(request);
      const auth = state.authorization;
      if (!auth) throw new GatewayError("invalid_request", 401, "invalid or revoked API key");
      const data = await queryAllowedModels(auth);
      return new Response(JSON.stringify({ object: "list", data }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-request-id": state.requestId,
          "access-control-allow-origin": "*",
        },
      });
    };

    const handleModelsDetail = async ({
      request,
      params,
    }: {
      request: Request;
      // Elysia omits `params` entirely for the literal `/models/info` route
      // (it declares no path parameters), so this must stay optional.
      params?: Record<string, string> | undefined;
    }): Promise<Response> => {
      const state = requestStateStore.require(request);
      const auth = state.authorization;
      if (!auth) throw new GatewayError("invalid_request", 401, "invalid or revoked API key");
      const raw = params?.["*"] ?? params?.id ?? "";
      const targetId = new URL(request.url).searchParams.get("id") ?? raw;
      const found = await publicModelStore.getPublicModelDetail(
        targetId,
        auth.tenantId,
        auth.snapshot,
        auth.modelPrefix,
      );
      if (!found)
        throw new GatewayError(
          "model_not_found",
          404,
          `The model '${targetId}' does not exist or you do not have access to it.`,
        );
      return new Response(JSON.stringify(found), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-request-id": state.requestId,
          "access-control-allow-origin": "*",
        },
      });
    };

    const handleResponsesCompact = createResponsesCompactHandler({
      db: deps.db,
      providerAdapters: deps.providerAdapters ?? new Map(),
      resolveProviderAdapter: deps.resolveProviderAdapter,
      proxyPreparer: deps.proxyPreparer,
      stateStore: requestStateStore,
      poolSelector: deps.poolSelector,
      networkBindingFactory: deps.networkBindingFactory,
      snapshotService: deps.snapshotService,
      resolveOAuthRefresher: deps.resolveOAuthRefresher,
      oauthRefreshService: deps.oauthRefreshService,
      // The compact handler completes its attempt through `completeAttempt`,
      // which marks the request completed and finalizes telemetry itself —
      // so the afterResponse lifecycle skips it. Without the buffer here the
      // route would emit no telemetry row at all.
      telemetryBuffer: deps.telemetryBuffer,
    });

    // Gateway mounting: the pipeline owner composes stages, telemetry, and
    // cleanup; app only registers the public route table.
    app.use(
      transportPipeline.createGateway((routes) => {
        routes.post("/chat/completions", proxyHandler);
        routes.post("/responses", proxyHandler);
        routes.post("/responses/compact", handleResponsesCompact);
        routes.post("/messages", proxyHandler);
        routes.post("/completions", proxyHandler);
        routes.get("/models", handleModelsList);
        routes.get("/models/info", handleModelsDetail);
        routes.get("/models/*", handleModelsDetail);
      }),
    );
  }

  if (deps.mode === "production") {
    // `peerAddresses` is populated by the root `beforeHandle` above from
    // `server.requestIP`. The console login route needs it to key its lockout
    // bucket, and the trusted-proxy boundary decides whether an
    // `X-Forwarded-For` hop may override it — the same pair the transport
    // pipeline receives, so console and proxy agree on client identity.
    if (deps.consoleApi) {
      app.use(
        createConsoleRouter({
          ...deps.consoleApi,
          resolvePeerAddress: (request) => peerAddresses.get(request) ?? null,
          trustedProxyBoundary: deps.trustedProxyBoundary,
        }),
      );
    }

    // Public share API is registered before the static catch-alls so
    // `/share/:token/data` never falls through to the share document. The
    // public origin for `baseUrl` resolves from CARTETHYIA_PUBLIC_ORIGIN inside
    // the router, falling back to the request origin.
    app.use(createShareRouter({ db: deps.db, shareStore: new DrizzleShareLinkStore(deps.db) }));
  }

  app.all("/", serveDashboard);
  app.all("/share", serveDashboard);
  app.all("/share/*", serveDashboard);
  app.all("/console", serveDashboard);
  app.all("/console/*", serveDashboard);
  // Root-level build output (hashed bundles, chapter art, provider icons,
  // favicons). Registered last so every real API route above wins.
  app.all("/*", serveRootFallback);
  return app;
}

/**
 * Route-only convenience wrapper. It earns its place (unlike a bare forwarder)
 * by defaulting `options` and injecting the discriminant, so callers never
 * write `mode` for the shell path.
 */
export function createGatewayShell(options: Omit<GatewayShellDeps, "mode"> = {}) {
  return createGatewayApp({ mode: "route-only", ...options });
}

/**
 * Elysia route-tree type for Eden Treaty dashboard consumption.
 *

 * inferred return type.
 */
export type App = ReturnType<typeof createGatewayApp>;

