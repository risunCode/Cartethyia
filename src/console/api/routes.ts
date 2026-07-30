/**
 * Console API assembly — public login route + guarded group. Later milestones
 * register their routers inside the guarded group here.
 */

import { Elysia } from "elysia";
import { ensureConsoleBootstrap } from "../bootstrap";
import { consoleAclGuard, consoleBeforeHandle } from "../auth/guard";
import { authPublicRoutes, authProtectedRoutes } from "./auth";
import { keysRoutes } from "./keys";
import { overviewRoutes, ipRoute } from "./overview";
import { usageRoutes } from "./usage";
import { providersRoutes } from "./providers";
import { settingsRoutes } from "./settings";
import { logsRoutes } from "./logs";
import { combosRoutes } from "./combos";
import { proxyPoolsRoutes } from "./proxy-pools";
import { accessRoutes } from "./access";
import { filterSanitizeRoutes } from "./sanitizer-rules";
import { customProvidersRoutes } from "./custom-providers";
import { healthRoutes } from "./health";
import { liveRoutes } from "./live";

export const consoleApiRoutes = new Elysia()
  .onStart(async () => {
    await ensureConsoleBootstrap();
  })
  .use(ipRoute)
  .guard({ beforeHandle: consoleAclGuard }, (aclGroup) =>
    aclGroup
      .use(authPublicRoutes)
      .guard({ beforeHandle: consoleBeforeHandle }, (group) =>
        group
          .use(authProtectedRoutes)
          .use(keysRoutes)
          .use(overviewRoutes)
          .use(usageRoutes)
          .use(providersRoutes)
          .use(settingsRoutes)
          .use(logsRoutes)
          .use(combosRoutes)
          .use(proxyPoolsRoutes)
          .use(accessRoutes)
          .use(filterSanitizeRoutes)
          .use(customProvidersRoutes)
          .use(healthRoutes)
          .use(liveRoutes)
      )
  );
