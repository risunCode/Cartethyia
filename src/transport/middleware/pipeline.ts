import { Elysia } from "elysia";
import {
  createApiKeyAuthenticationMiddleware,
  createCanonicalRequestMiddleware,
  createClientIdentityMiddleware,
  createDependencyReadinessMiddleware,
  createErrorNormalizationMiddleware,
  createIngressPolicyMiddleware,
  createIpAbuseProtectionMiddleware,
  createProxyRoutePreparationMiddleware,
  createRequestContextMiddleware,
  registerRequestCleanup,
  registerTelemetryLifecycle,
  type AfterResponseApp,
  type CanonicalAdapter,
} from "./ingress";
import type { ReadinessCheckResult } from "../../persistence/readiness";
import type { IpAbuseProtectionService } from "../../security/abuse";
import type { ProxyRequestPreparer } from "../request/preparer";
import { ProxyRequestStateStore } from "../request/state";
import type { SurfaceAdapterRegistry } from "../surface/adapters";
import type { TrustedProxyBoundary } from "../../config";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";

/** Shared state/context carried by every ordered transport stage. */
export interface TransportPipelineContext {
  readonly db: CartethyiaDatabase;
  readonly stateStore: ProxyRequestStateStore;
  readonly surfaceRegistry: SurfaceAdapterRegistry;
  readonly adapters: ReadonlyMap<string, CanonicalAdapter>;
  readonly preparer: ProxyRequestPreparer;
  readonly readiness: () => Promise<ReadinessCheckResult>;
  readonly trustedProxyBoundary: TrustedProxyBoundary;
  readonly resolvePeerAddress?: (request: Request) => string | null;
  readonly ipAbuseProtection?: IpAbuseProtectionService;
  readonly maxBodyBytes?: number;
  readonly requestDeadlineMs?: number;
  readonly verifiedHttps?: boolean;
  readonly shutdownCoordinator?: {
    isDraining(): boolean;
  };
  readonly telemetry?: TelemetryBatchBuffer;
}

/**
 * The single ingress owner. `mountRoot` applies the process-wide request
 * context and error-normalization lifecycle; `createGateway` composes the
 * ordered fail-closed `/v1/*` stage chain plus the telemetry/cleanup
 * lifecycle around caller-registered gateway routes. Composition code
 * (`app.ts`) mounts — it never assembles middleware policy itself.
 */
export interface TransportPipeline {
  /** Applies root-scoped request context and error normalization. */
  mountRoot(app: Elysia<any, any, any, any, any, any, any, any>): void;
  /** Builds the complete `/v1/*` gateway plugin around registered routes. */
  createGateway(registerRoutes: (routes: Elysia<any, any, any, any, any, any, any, any>) => void): Elysia;
}

/**
 * Builds the one ordered middleware pipeline. Request context and error
 * normalization are mounted at the root; the remaining stages are mounted
 * before every `/v1/*` route, preserving fail-closed ordering.
 */
export function createTransportPipeline(context: TransportPipelineContext): TransportPipeline {
  const stages: Elysia[] = [
    createDependencyReadinessMiddleware({
      readiness: context.readiness,
      ...(context.shutdownCoordinator ? { shutdownCoordinator: context.shutdownCoordinator } : {}),
    }),
    createIngressPolicyMiddleware({
      stateStore: context.stateStore,
      ...(context.maxBodyBytes === undefined ? {} : { maxBodyBytes: context.maxBodyBytes }),
    }),
    createClientIdentityMiddleware({
      stateStore: context.stateStore,
      trustedProxyBoundary: context.trustedProxyBoundary,
      ...(context.resolvePeerAddress ? { resolvePeerAddress: context.resolvePeerAddress } : {}),
    }),
    createApiKeyAuthenticationMiddleware({ db: context.db, stateStore: context.stateStore }),
    createCanonicalRequestMiddleware({
      stateStore: context.stateStore,
      surfaceRegistry: context.surfaceRegistry,
      adapters: context.adapters,
    }),
    createProxyRoutePreparationMiddleware({
      stateStore: context.stateStore,
      preparer: context.preparer,
    }),
  ];
  const mountRoot = (app: Elysia<any, any, any, any, any, any, any, any>): void => {
    app.use(
      createRequestContextMiddleware({
        stateStore: context.stateStore,
        ...(context.requestDeadlineMs === undefined
          ? {}
          : { requestDeadlineMs: context.requestDeadlineMs }),
      }),
    );
    // Root-mounted, not a gateway stage: its `request` hook must run for every
    // `/v1/*` request, including paths that match no route, or a caller can
    // hammer the gateway without ever being counted. See the middleware's own
    // doc for the measured bypass this closes.
    if (context.ipAbuseProtection) {
      app.use(
        createIpAbuseProtectionMiddleware({
          stateStore: context.stateStore,
          ipAbuseProtection: context.ipAbuseProtection,
          trustedProxyBoundary: context.trustedProxyBoundary,
          ...(context.resolvePeerAddress ? { resolvePeerAddress: context.resolvePeerAddress } : {}),
        }),
      );
    }
    app.use(
      createErrorNormalizationMiddleware({
        stateStore: context.stateStore,
        hsts: context.verifiedHttps === true,
      }),
    );
    // Finalize + cleanup live at the ROOT, not on the gateway plugin.
    //
    // A plugin-scoped `afterResponse` only fires for a request that matched a
    // registered route, so an unregistered `/v1/*` path — the cheapest thing a
    // scanner can send — was admitted by the root `request` hook (which does
    // run for every inbound request, that is why the in-flight count and the
    // IP-abuse counter are there) but never cleaned up. Measured: one
    // unmatched `/v1/*` request left `proxy_in_flight` permanently higher and
    // `activeCount()` permanently one larger, so the gauge only ever climbed
    // for the life of the process. The root hook runs for the unmatched path
    // too, which is what makes the increment and the decrement symmetric.
    //
    // Ordering is safe because a root `afterResponse` still runs *after* the
    // matched handler returns (measured: request -> handler -> root.afterResponse
    // -> plugin.afterResponse), so a dispatch route is finalized exactly as
    // before. Registering it only here — never also on the gateway — is what
    // keeps a matched route from finalizing twice.
    // `mountRoot` receives a fully-widened `Elysia<any, ...>`, whose overloaded
    // `afterResponse` signature is not structurally assignable to the minimal
    // `AfterResponseApp` hook interface even though the runtime shape matches
    // (Elysia passes `{ request }`). The cast is confined to this one call.
    const rootApp = app as unknown as AfterResponseApp;
    if (context.telemetry) {
      registerTelemetryLifecycle(rootApp, {
        stateStore: context.stateStore,
        telemetryBuffer: context.telemetry,
      });
    } else {
      registerRequestCleanup(rootApp, { stateStore: context.stateStore });
    }
  };
  const createGateway = (
    registerRoutes: (routes: Elysia<any, any, any, any, any, any, any, any>) => void,
  ): Elysia<any, any, any, any, any, any, any, any> => {
    const gateway = new Elysia({ prefix: "/v1" });
    for (const plugin of stages) gateway.use(plugin);
    // No telemetry/cleanup registration here: the lifecycle is owned by
    // `mountRoot`. Registering a second copy on this plugin would finalize a
    // matched request twice, and relying on this copy alone would leak every
    // unmatched `/v1/*` request (see `mountRoot`).
    registerRoutes(gateway);
    return gateway;
  };
  return { mountRoot, createGateway };
}
