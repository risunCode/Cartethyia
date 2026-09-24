import { createGatewayApp, createGatewayShell } from "./app";
import { bootstrap } from "./runtime/lifecycle";
import type { CartethyiaBoot } from "./runtime/lifecycle";
import { resolveIdleTimeout, resolveMaxBodyBytes, resolvePort } from "./config";
import { Manifest } from "elysia";
import { log } from "./observability/logger";

const port = resolvePort();

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaBoot: CartethyiaBoot | undefined;
  // eslint-disable-next-line no-var
  var __cartethyiaSignalsRegistered: boolean | undefined;
}

const boot = Manifest.isCapturing()
  ? undefined
  : (globalThis.__cartethyiaBoot ??= await bootstrap());

const app = boot
  ? createGatewayApp({
      mode: "production",
      db: boot.deps.db,
      proxyPreparer: boot.deps.proxyPreparer,
      resolveProviderAdapter: boot.deps.resolveProviderAdapter,
      byokUpstreamHosts: boot.deps.byokUpstreamHosts,
      networkBindingFactory: boot.deps.networkBindingFactory,
      ipAbuseProtection: boot.deps.ipAbuseProtection,
      trustedProxyBoundary: boot.deps.trustedProxyBoundary,
      poolSelector: boot.deps.poolSelector,
      snapshotService: boot.deps.snapshotService,
      readiness: boot.deps.readiness,
      telemetryBuffer: boot.deps.telemetryBuffer,
      resolveOAuthRefresher: boot.deps.resolveOAuthRefresher,
      oauthRefreshService: boot.deps.oauthRefreshService,
      maxBodyBytes: resolveMaxBodyBytes(),
      shutdownCoordinator: boot.shutdownCoordinator,
      // The console is Redis-backed, so `REDIS_MODE=single_instance_local`
      // (no Redis client) boots the data plane without it rather than
      // refusing to start.
      ...(boot.deps.redis
        ? {
            consoleApi: {
              db: boot.deps.db,
              accessResolver: () => undefined,
              routeSnapshotService: boot.deps.snapshotService,
              poolSelector: boot.deps.poolSelector,
              telemetryBuffer: boot.deps.telemetryBuffer,
              providerRegistry: boot.deps.providerRegistry,
              bundledModelCatalog: boot.deps.bundledModelCatalog,
              networkBindingFactory: boot.deps.networkBindingFactory,
              redis: boot.deps.redis,
              oauthRefreshService: boot.deps.oauthRefreshService,
              admissionService: boot.deps.admissionService,
            },
          }
        : {}),
    })
  : createGatewayShell();
export { app };


function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (!boot) return;
  log.info(`[shutdown] ${signal} received, draining...`);
  const forceExit = setTimeout(() => {
    log.error("[shutdown] forced exit after 10s");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  boot.shutdownCoordinator
    .begin(signal)
    .then(() => {
      log.info("[shutdown] complete");
      process.exit(0);
    })
    .catch((error: unknown) => {
      log.error("[shutdown] failed", error as Error);
      process.exit(1);
    });
}

if (boot) {
  boot.server = app.listen(
    {
      port,
      // Cap idle sockets so a Slowloris/keep-alive-abuse client cannot
      // pin one of the server's `maxRequestBodySize`-budgeted sockets
      // indefinitely. 60 s aligns with the DB pool idle timeout so all
      // long-idle resources reap together.
      idleTimeout: resolveIdleTimeout(),
      // Enable Bun's SO_REUSEPORT load-balancing so multi-worker deploys
      // (or a second omp process) can share the same port without a
      // reverse proxy in front. Silent no-op on platforms that lack it.
      reusePort: true,
      // 8 MiB cap on request bodies keeps a rogue client from allocating
      // gigabytes of memory in the ingress path before validation rejects.
      maxRequestBodySize: resolveMaxBodyBytes(),
    },
    () => {
      log.info(`Cartethyia listening on :${port} (Bun ${Bun.version})`);
    },
  );
  // Started here rather than inside the dependency builder: the first tick of
  // the lease sweep and the health sweep should not run before the listener
  // exists to serve traffic.
  boot.deps.scheduledTasks.start();
  if (!globalThis.__cartethyiaSignalsRegistered) {
    globalThis.__cartethyiaSignalsRegistered = true;
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}
