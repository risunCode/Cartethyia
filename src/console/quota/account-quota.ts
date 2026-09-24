import { Elysia } from "elysia";
import { consoleErrorHandler } from "../shared/errors";
import { registerAccountQuotaGlobalRoutes } from "./account-quota-global";
import { registerAccountQuotaTenantRoutes } from "./account-quota-tenant";
import { createQuotaRefreshDeps, type AccountQuotaRoutesDeps } from "./account-quota-shared";
import { resetBackgroundQuotaRefreshesForTests } from "./account-quota-view";

export { resetBackgroundQuotaRefreshesForTests };
export type { AccountQuotaRoutesDeps };

/**
 * Mounts the account/quota console routes: the tenant-scoped group (the
 * caller's own accounts) and the platform-admin group (shared accounts). Each
 * group lives in its own module and authorises every route with its own
 * access check.
 */
export function createAccountQuotaRoutes(deps: AccountQuotaRoutesDeps): Elysia {
  const refreshDeps = createQuotaRefreshDeps(deps);
  const app = new Elysia();
  // The error hook is registered before any route so every handler's snapshot
  // carries it, exactly as the previous single chain did.
  app.error(consoleErrorHandler("Quota operation failed"));
  registerAccountQuotaTenantRoutes(app, deps, refreshDeps);
  registerAccountQuotaGlobalRoutes(app, deps, refreshDeps);
  return app;
}
