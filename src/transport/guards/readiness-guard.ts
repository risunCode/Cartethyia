// Dependency readiness guard: refuses `/v1/*` and `/console/api/*` traffic
// while dependencies are unhealthy or the process is draining.
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { fastPathname } from "../../lib/pathname";
import { shutdownNotice } from "../shutdown-notice";
import type { ReadinessMiddlewareDeps } from "../contracts";

export function createDependencyReadinessMiddleware(deps: ReadinessMiddlewareDeps): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        path === "/health" ||
        path === "/health/ready" ||
        (!path.startsWith("/v1/") && !path.startsWith("/console/api/"))
      )
        return;
      if (deps.shutdownCoordinator?.isDraining()) {
        const notice = shutdownNotice(deps.shutdownCoordinator.shutdownReason?.());
        throw new GatewayError(notice.code, 503, notice.message);
      }
      const readiness = await deps.readiness();
      if (readiness.status !== "ready")
        throw new GatewayError("platform_unavailable", 503, "The gateway's dependencies are not ready, so no request can be served. Retry shortly; if it persists, check the database and coordination backend.");
    })
    .as("plugin");
}
