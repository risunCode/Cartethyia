import type { ConsoleApiCompositionDeps } from "../../src/console/console-router";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";

/**
 * Minimal console composition for tests that exercise the transport surface.
 *
 * `ProductionAppDeps` requires `consoleApi` because the deployed app always
 * mounts the console; these tests build a production app without caring about
 * console behavior, so they need a stand-in that constructs without a real
 * Redis client or bundled catalog. Nothing here is invoked unless a test
 * actually calls a `/console/api/*` route.
 */
export function createConsoleApiStub(db: CartethyiaDatabase): ConsoleApiCompositionDeps {
  return {
    db,
    accessResolver: () => undefined,
    routeSnapshotService: {
      invalidate: async () => 0,
      getSnapshot: async () => undefined as never,
    },
    poolSelector: {} as never,
    telemetryBuffer: {} as never,
    providerRegistry: createDefaultProviderRegistry(),
    bundledModelCatalog: {
      modelsByProvider: new Map(),
    },
    networkBindingFactory: {} as never,
    admissionService: { purgeKey: async () => {} } as never,
    redis: {} as never,
    oauthRefreshService: {} as never,
  };
}
